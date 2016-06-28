var Promise = require("bluebird");
var rp = require('request-promise');
var fs = require("fs");

// config encapsulates opensensors-api-key
// valid keys for config are: api-key (required)
module.exports = function(config) {
    var API_POST_OPTIONS = {
        headers: {
            Accept: "application/json",
            Authorization: "api-key " + config["api-key"]
        }
    };

    var requests_filename = "./current_requests.json";
    var MAX_CONCURRENT_REQUESTS_IN_FLIGHT = 5;

    // on launch delete ther requests file
    if(fs.existsSync(requests_filename)) {
        fs.unlinkSync(requests_filename);
        console.log("Removed existing requests file: " + requests_filename);
    }

    // create it blank
    fs.writeFileSync(requests_filename, JSON.stringify([]));

    var API_BASE_URL = "https://api.opensensors.io";

    var httpGet = function(url, options){
        var options = Object.assign(
          {},
          {
            uri: url,
            resolveWithFullResponse: true,
            json: true
          },
          options);

        return rp(options);
    };

    // helper (actually workhorse) method that does a GET to a URL
    // it appends the augmented payloads in the response to the second argument that gets passed to it
    // if the response body JSON contains a next element it recursively calls itself
    var getUntilNot400 = function(url){
        var theUrl = url;
        var requestsInFlight = 0;
        var current_requests = [];
        try{
            var file_contents = fs.readFileSync(requests_filename, 'utf8');
            if(file_contents.trim() == ""){
                file_contents = "[]";
            }
            current_requests = JSON.parse(file_contents);
            requestsInFlight = current_requests.length;
        }
        catch(e){
            console.log(requests_filename + ' is corrupt - JSON parse failed -- deleting it');
            fs.unlinkSync(requests_filename);
            file_contents = "[]";
            current_requests = JSON.parse(file_contents);
            requestsInFlight = current_requests.length;
        }

        if(requestsInFlight < MAX_CONCURRENT_REQUESTS_IN_FLIGHT) {
            // if the server is not saturated, go ahead and make a request and increase the saturation level

            // add this request to the list of in flight requests
            // if it's not already in the list
            var exceptionFlag = false;
            if(current_requests.indexOf(theUrl) == -1){
              current_requests.push(theUrl);
              try {
                  fs.writeFileSync(requests_filename, JSON.stringify(current_requests));
              }
              catch(e){
                  console.log("Failed to write to " + requests_filename);
                  // this is very bad... we really shouldn't proceed at this point with this request
                  // it should in fact be as though we were saturated
                  // just as though we had gotten a 400 response, just try again sooner
                  exceptionFlag = true;
                  console.log("Deferring request " + theUrl + " for 5 seconds");
                  return Promise.delay(5000).then(function () {
                      return getUntilNot400(theUrl);
                  });
              }
            }

            if(!exceptionFlag) {
                return Promise.try(function () {
                    return httpGet(theUrl, API_POST_OPTIONS);
                }).then(function (response) {
                    if (response.statusCode == 400) {
                        console.log(theUrl);
                        console.log(response.body);
                        console.log("Got 400, waiting 30 seconds before trying " + theUrl + " again");
                        return Promise.delay(30000).then(function () {
                            return getUntilNot400(theUrl);
                        });
                    }
                    else {
                        // finally! we can retire this request from the list and pass the results on
                        try {
                            var file_contents = fs.readFileSync(requests_filename, 'utf8');
                            if (file_contents.trim() == "") {
                                file_contents = "[]";
                            }
                            current_requests = JSON.parse(file_contents);

                            // remove url from the list
                            var i = current_requests.indexOf(theUrl);
                            if (i != -1) {
                                current_requests.splice(i, 1);
                            }
                            fs.writeFileSync(requests_filename, JSON.stringify(current_requests));
                        }
                        catch (e) {
                            console.log(requests_filename + ' is corrupt - JSON parse failed');
                            // this is also a really bad situation, but I don't know what can be done about it
                        }

                        return response;
                    }
                }).catch(function(error){
                    console.log("+++++++++++++++++++++++");
                    console.log("Error: " + error.message);
                    console.log("+++++++++++++++++++++++");
                });
            }
        }
        else{
            // otherwise delay for a little while and try again recursively
            // just as though we had gotten a 400 response, just try agian sooner
            console.log("Saturated - Deferring request " + theUrl + " for 5 seconds");
            return Promise.delay(5000).then(function () {
                return getUntilNot400(theUrl);
            });
        }
    };

    var recursiveGET = function(url, results, status, followNext){
        var theUrl = url;
        var theResults = results;
        var theStatus = Object.assign({}, {}, status);
        var theFollowNext = followNext;

        console.log(theStatus.serialNumber + " Current Num Results: " + theResults.length + " -> URL: " + theUrl);

        return Promise.try(function(){
            return getUntilNot400(theUrl);
        }).then(function(response){
            var theResponse = response;
            var augmentedPayloads = [];
            if(theResponse.body.messages){
                augmentedPayloads = theResponse.body.messages.map(function(msg){
                    // as it turns out nan is not valid JSON
                    var body;
                    try {
                        body = msg.payload.text.replace(/':nan/g, '":null');
                        body = body.replace(/nan/g, 'null');

                        // workaround for malformation of uknown origin resulting in ' where " should be
                        body = body.replace(/'/g, '"');

                        var datum = JSON.parse(body);
                        datum.timestamp = msg.date;
                        datum.topic = msg.topic;
                        return datum;
                    }
                    catch(exception){
                        console.log(exception);
                        console.log(body);
                        return {
                            timestamp: msg.date,
                            topic: msg.topic
                        };
                    }
                });
            }

            return Promise.try(function(){
                return theResults.concat(augmentedPayloads);
            }).then(function(results){
                var theseResults = results;
                // if there's a non-null status object provided
                // lets reach into the status.filename
                // and modify the entry for status.serialnumber
                if(theStatus && theStatus.filename) {
                    var content = fs.readFileSync(theStatus.filename, 'utf8');
                    if(content == ""){
                        content = "{}";
                    }

                    var json = null;

                    try {
                        json = JSON.parse(content);
                        if (!json[theStatus.serialNumber]) {
                            json[theStatus.serialNumber] = {};
                        }

                        if (theResponse.body.messages) {
                            json[theStatus.serialNumber].numResults = theseResults.length + theResponse.body.messages.length;
                        }
                        else {
                            json[theStatus.serialNumber].complete = true;
                            json[theStatus.serialNumber].error = true;
                            json[theStatus.serialNumber].errorMessage = "No messages found.";
                        }

                        if (theseResults.length > 0) {
                            json[theStatus.serialNumber].timestamp = theseResults[theseResults.length - 1].timestamp;
                        }

                        if (!theResponse.body.next) {
                            json[theStatus.serialNumber].complete = true;
                        }
                        else {
                            json[theStatus.serialNumber].complete = false;
                        }
                    }
                    catch(err){
                        console.log(err);
                        return null;
                    }

                    if(json) {
                        try {
                            fs.writeFileSync(theStatus.filename, JSON.stringify(json));
                        }
                        catch(error){
                            console.log(error.message);
                        }
                    }
                    console.log(theStatus.serialNumber + " Wrote "+ JSON.stringify(json) + " to " + theStatus.filename);
                    return theseResults;
                }
                else {
                    return theseResults; // pass it through
                }
            }).delay(1000).then(function(newResults){
                if(theFollowNext && theResponse.body.next){
                    console.log("Next Found on url " + theUrl);
                    console.log("Last timestamp: " + theResponse.body.messages[theResponse.body.messages.length - 1].date);
                    return recursiveGET(API_BASE_URL + theResponse.body.next, newResults, theStatus, theFollowNext);
                }
                else{
                    console.log(theStatus.serialNumber + " Next Not Found on url " + theUrl);
                    // console.log(response.body);
                    if(theResponse.body.messages && theResponse.body.messages.length > 0) {
                        console.log("Response contained messages field with " + theResponse.body.messages.length
                          + " messages, Last timestamp: " + theResponse.body.messages[theResponse.body.messages.length - 1].date);
                    }
                    else if(!theResponse.body.messages){
                       console.log("Response did not contain any messages field");
                    }
                    else if(theResponse.body.messages.length === 0){
                       console.log("Response contained messages field with zero messages");
                    }
                    else{
                       console.log("Unexpected response content: ");
                       console.log(theResponse.body);
                    }
                    console.log("Total Results: " + newResults.length);
                    return newResults;
                }
            });
        }).catch(function(error){
            console.log("***********************");
            console.log("Error: " + error.message);
            console.log("***********************");
            return [];
        });
    };

    // this function returns a string to append to a url path
    // to add the [flat] params object as a querystring
    function urlParams(params){
        var ret = "";
        if(Object.keys(params).length > 0){ // if there are any optional params
            ret += '?';

            var encodeParams = Object.keys(params).map(function(key){
                if(key != "status") { // special case, not an OpenSensors parameter
                    return key + '=' + encodeURIComponent(params[key]);
                }
            });

            ret += encodeParams.join('&');
        }
        return ret;
    }

    // this function returns a string to append to a url path
    // to add the [flat] params object as a querystring
    function collectMessagesBy(x, val, params){
        var API_MESSAGES_BY_PATH = "/v1/messages/" + x;
        var url = API_BASE_URL + API_MESSAGES_BY_PATH;
        if(!val){
            console.error(x + "is required");
            return Promise.resolve({});
        }

        url += "/" + val+ urlParams(params);

        var status = params ? Object.assign({}, {}, params.status) : null;

        return recursiveGET(url, [], status, true); // follow_next = true
    }

    // returns an array of message payloads from the API, augmented with timestamp
    // valid optional param keys are "start-date", "end-date", and "dur"
    function collectMessagesByDevice(device, params){
        return collectMessagesBy("device", device, params);
    }

    // returns an array of message payloads from the API, augmented with timestamp
    // valid optional param keys are "start-date", "end-date", and "dur"
    function collectMessagesByTopic(topic, params){
        return collectMessagesBy("topic", topic, params);
    }

    // returns an array of message payloads from the API, augmented with timestamp
    // valid optional param keys are "start-date", "end-date", and "dur"
    function collectMessagesByUser(user, params){
        return collectMessagesBy("user", user, params);
    }

    // this is what require(opensensors)(config) actually will return
    return {
        messages: {
            byDevice: collectMessagesByDevice,
            byTopic: collectMessagesByTopic,
            byUser: collectMessagesByUser
        }
    };
};