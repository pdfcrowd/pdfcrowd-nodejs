var http = require('http')
var querystring = require('querystring');
var fs = require('fs');


var Pdfcrowd = function(username, apikey) {
    if (!username)
        throw new Error('Missing username.');

    if (!apikey)
        throw new Error('Missing apikey.');

    this.username = username;
    this.apikey = apikey;
};


//
// Converts raw HTML code
//
Pdfcrowd.prototype.convertHtml = function(html, callbacks, options) {
    callbacks = prepareCallbacks(callbacks);
    requestQueue.addRequest([this, html, '/api/pdf/convert/html/', callbacks, options]);
}


//
// Converts a web page
//
Pdfcrowd.prototype.convertURI = function(uri, callbacks, options) {
    requestQueue.addRequest([this, uri, '/api/pdf/convert/uri/', callbacks, options]);
}


//
// Converts a local HTML file
//
Pdfcrowd.prototype.convertFile = function(fname, callbacks, options) {
    var that = this;
    fs.readFile(fname, function(err, data) {
        if (err) throw err;
        requestQueue.addRequest([that, data.toString(), '/api/pdf/convert/html/', callbacks, options]);
    });
}


//
// Returns a callback object that saves the generated PDF to a file
//
var saveToFile = function(fname) {
    return {
        pdf: function(rstream) { 
            wstream = fs.createWriteStream(fname);
            rstream.pipe(wstream);
        },
        error: function(errMessage, statusCode) { console.log("ERROR: " + errMessage); },
        end: function() {},
    };
}


//
// Returns a callback object that sends the generated PDF in an HTTP response
//
var sendHttpResponse = function(response, disposition) {
    disposition = disposition || "attachment";
    return {
        pdf: function(rstream) {
            response.setHeader("Content-Type", "application/pdf");
            response.setHeader("Cache-Control", "no-cache");
            response.setHeader("Accept-Ranges", "none");
            response.setHeader("Content-Disposition", disposition + "; filename=\"generated.pdf\"");
            rstream.pipe(response);
        },
        error: function(errMessage, statusCode) { 
            response.setHeader("Content-Type", "text/plain");
            response.end('ERROR: ' + errMessage);
        },
        end: function() {},
    };
}



//
// Exports
//
module.exports = {
    Pdfcrowd: Pdfcrowd,
    saveToFile: saveToFile,
    sendHttpResponse: sendHttpResponse,
}





// ---------------------------------------------------------------------------
//                                PRIVATE


//
// Adds the default implementation if a callback is missing
//
var prepareCallbacks = function(callbacks) {
    callbacks = callbacks || {};
    if (typeof callbacks.pdf !== "function") {
        callbacks.pdf = function(rstream) {
            rstream.destroy();
            console.warn('WARNING: [Pdfcrowd] Unhandled PDF generation.');
        };
    }

    if (typeof callbacks.error !== "function") {
        callbacks.error = function(errMessage, statusCode) {
            console.warn("WARNING: [Pdfcrowd] Unhandled error: %d - %s", statusCode, errMessage);
        };
    }

    if (typeof callbacks.end !== "function") {
        callbacks.end = function() {};
    }

    return callbacks;
}


//
// Calls the API
//
var convertInternal = function(that, src, endpoint, callbacks, options) {

    // form POST data
    var postData = clone_object(options);
    postData['src'] = src;
    postData['username'] = that.username;
    postData['key'] = that.apikey;
    postData = querystring.stringify(postData);

    // http options
    httpOptions = {
        host: 'pdfcrowd.com',
        port: 80,
        method: 'POST',
        path: endpoint,
        headers: { 'content-length': postData.length,
                   'content-type': 'application/x-www-form-urlencoded' },
    };

    var req = http.request(httpOptions, function(res) {
        if (res.statusCode < 300) {
            res.on('end', function() {
                callbacks.end();
                requestQueue.requestDone();
            });

            res.on('error', function(exc) {
                callbacks.error(exc.toString());
                requestQueue.requestDone();
            });

            callbacks.pdf(res);
        }
        else {
            var err = [];
            res.on('data', function(chunk) {
                err.push(chunk.toString());
            });
            res.on('end', function() {
                callbacks.error(err.join(''), res.statusCode);
                requestQueue.requestDone();
            });
        }
    });

    req.on('error', function(res) {
        callbacks.error(res.toString(), res.statusCode);
        requestQueue.requestDone();
    });

    req.write(postData);
    req.end();
}


//
// A global request queue which serializes API calls.
//
var requestQueue = {
    init: function() {
        this.queue = [];
        this.working = 0;
    },

    addRequest: function(req) {
        this.queue.push(req);
        this.processRequest();
    },

    requestDone: function() {
        this.working = 0;
        this.processRequest();
    },

    processRequest: function() {
        if (this.queue.length > 0 && !this.working) {
            this.working = 1;
            var args = this.queue.shift();
            convertInternal.apply(null, args);
        }
    }
};
requestQueue.init();


//
// Clones an object.
//
var clone_object = function(obj) {
    var prop, cloned = {};
    for (prop in obj) {
        if (typeof obj !== 'function') {
            cloned[prop] = obj[prop];
        }
    }
    return cloned;
};
