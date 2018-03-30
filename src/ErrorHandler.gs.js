/****************************************************************
 * ErrorHandler library
 * https://github.com/RomainVialard/ErrorHandler
 *
 * Performs exponential backoff when needed
 * And makes sure that catched errors are correctly logged in Stackdriver
 * 
 * expBackoff()
 * logError()
 *
 * _convertErrorStack()
 *****************************************************************/

/**
 * Invokes a function, performing up to 5 retries with exponential backoff.
 * Retries with delays of approximately 1, 2, 4, 8 then 16 seconds for a total of 
 * about 32 seconds before it gives up and rethrows the last error. 
 * See: https://developers.google.com/google-apps/documents-list/#implementing_exponential_backoff 
 * Original author: peter.herrmann@gmail.com (Peter Herrmann)
 *
 * @example
 * // Calls an anonymous function that concatenates a greeting with the current Apps user's email
 * ErrorHandler.expBackoff(function(){return "Hello, " + Session.getActiveUser().getEmail();});
 *
 * @example
 * // Calls an existing function
 * ErrorHandler.expBackoff(myFunction);
 * 
 * @param {Function} func The anonymous or named function to call.
 * @return {*} The value returned by the called function.
 */
function expBackoff(func) {
  for (var n=0; n<6; n++) {
    try {
      return func();
    } 
    catch(e) {
      if (e.message) {
        // Check for errors thrown by Google APIs on which there's no need to retry
        // eg: "Access denied by a security policy established by the administrator of your organization. 
        //      Please contact your administrator for further assistance."
        if (e.message.indexOf('Invalid requests') != -1 
            || e.message.indexOf('Access denied') != -1
            || e.message.indexOf('Mail service not enabled') != -1) {
          throw e;
        }
        else if (e.message.indexOf('response too large') != -1) {
          // Thrown after calling Gmail.Users.Threads.get()
          // maybe because a specific thread contains too many messages
          // best to skip the thread
          return null;
        }
      }
      if (n == 5) {
        // 'User-rate limit exceeded' is always followed by 'Retry after' + timestamp
        // Maybe we should parse the timestamp to check how long we need to wait 
        // and if we should abort or not
        if (e.message && e.message.indexOf('User-rate limit exceeded') != -1) {
          ErrorHandler.logError(e, {
            shouldInvestigate: true,
            failedAfter5Retries: true,
            context: "Exponential Backoff"
          });
          return null;
        }
        // Investigate on errors that are still happening after 5 retries
        // Especially error "Not Found" - does it make sense to retry on it?
        ErrorHandler.logError(e, {
          failedAfter5Retries: true,
          context: "Exponential Backoff"
        });
        throw e;
      } 
      Utilities.sleep((Math.pow(2,n)*1000) + (Math.round(Math.random() * 1000)));
    }    
  }
}

function logError(e, additionalParams) {
  // if we simply log the error object, only the error message will be submitted to Stackdriver Logging
  // Best to re-write the error as a new object to get lineNumber & stack trace
  e = (typeof e === 'string') ? new Error(e) : e;
  var log = {
    context: {}
  };
  if (e.name) {
    // examples of error name: Error, ReferenceError, Exception, GoogleJsonResponseException
    // would be nice to categorize
    log.context.errorName = e.name;
    e.message = e.name + ": " + e.message;
  }
  log.message = e.message;
  
  if (e.lineNumber && e.fileName && e.stack) {
    log.context.reportLocation = {};
    log.context.reportLocation.lineNumber = e.lineNumber;
    log.context.reportLocation.filePath = e.fileName;
    
    if (additionalParams && additionalParams.addonName) {
      var addonName = additionalParams.addonName;
    }
    var [stack, functionName] = ErrorHandler_._convertErrorStack(e.stack, addonName);
    log.context.reportLocation.functionName = functionName;
    log.message+= '\n    ' + stack;
  }
  if (e.responseCode) {
    log.context.responseCode = e.responseCode;
  }
  
  if (additionalParams) {
    log.customParams = {};
    for (var i in additionalParams) {
      log.customParams[i] = additionalParams[i];
    }
  }
  console.error(log);
}

// noinspection JSUnusedGlobalSymbols, ThisExpressionReferencesGlobalObjectJS
this['ErrorHandler'] = {
  // Add local alias to run the library as normal code
  expBackoff: expBackoff,
  logError: logError
};

var ErrorHandler_ = {};

/**
* Format stack:
* "at File Name:lineNumber (myFunction)" => "at myFunction(File Name:lineNumber)"
* 
* @param {string} stack - Stack given by GAS with console.stack
* @param {string} [addonName] - Optional Add-on name added by GAS to the stacks: will remove it from output stack
* 
* @return {string[]} - an array containing formatted stack and functionName
*/
ErrorHandler_._convertErrorStack = function (stack, addonName) {
  // allow to use a global variable instead of passing the addonName in each call
  if (SCRIPT_PROJECT_TITLE) addonName = SCRIPT_PROJECT_TITLE;
  var formatedStack = [];
  var functionNameFound = false;
  var lastFunctionName;
  var res;
  var regex = new RegExp('at\\s([^:]+?)'+ (addonName ? '(?:\\s\\('+ addonName +'\\))?' : '') +':(\\d+)(?:\\s\\(([^)]+)\\))?', 'gm');
  
  while (res = regex.exec(stack)) {
    var [/* total match */, fileName, lineNumber, functionName] = res;
    if (!functionNameFound && functionName) {
      functionNameFound = true;
      lastFunctionName = functionName;
    }
    formatedStack.push('at '+ (functionName || '[unknown function]') +'('+ fileName +':'+ lineNumber +')');
  }  
  return [formatedStack.join('\n    '), lastFunctionName];
}