// Copyright (C) 2011,2012 pdfcrowd.com
// 
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
// 
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

var http = require('http')
var querystring = require('querystring');
var fs = require('fs');


var Pdfcrowd = function(username, apikey, host) {
    if (!username)
        throw new Error('Missing username.');

    if (!apikey)
        throw new Error('Missing apikey.');

    this.username = username;
    this.apikey = apikey;
    this.host = host || "pdfcrowd.com";
};


//
// Converts raw HTML code
//
Pdfcrowd.prototype.convertHtml = function(html, callbacks, options) {
    if (!html) throw 'convertHtml: zero size HTML document.';
    requestQueue.addRequest([this, {
        src: html,
        endpoint: '/api/pdf/convert/html/',
        callbacks: prepareCallbacks(callbacks),
        apiOptions: options
    }]);
}


//
// Converts a web page
//
Pdfcrowd.prototype.convertURI = function(uri, callbacks, options) {
    if (!uri) throw 'convertURI: invalid URL.';
    requestQueue.addRequest([this, {
        src: uri,
        endpoint: '/api/pdf/convert/uri/',
        callbacks: prepareCallbacks(callbacks),
        apiOptions: options
    }]);
}


//
// Converts a local HTML file
//
Pdfcrowd.prototype.convertFile = function(fname, callbacks, options) {
    var that = this;
    fs.readFile(fname, function(err, data) {
        if (err) throw err;
        if (!data) throw "convertFile: " + fname + " has zero size"
        requestQueue.addRequest([that, {
            fname: fname,
            data: data.toString('binary'),
            endpoint: '/api/pdf/convert/html/',
            callbacks: prepareCallbacks(callbacks),
            apiOptions: options
        }]);
    });
}


//
// Returns a callback object that saves the generated PDF to a file
//
var saveToFile = function(fname) {
    return {
        pdf: function(rstream) { 
            var wstream = fs.createWriteStream(fname);
            rstream.pipe(wstream);
        },
        error: function(errMessage, statusCode) { console.log("ERROR: " + errMessage); },
        end: function() {},
    };
}


//
// Returns a callback object that sends the generated PDF in an HTTP response
//
var sendHttpResponse = function(response, disposition, fname) {
    disposition = disposition || "attachment";
    fname = fname || "generated.pdf";
    return {
        pdf: function(rstream) {
            response.setHeader("Content-Type", "application/pdf");
            response.setHeader("Cache-Control", "max-age=0");
            response.setHeader("Accept-Ranges", "none");
            response.setHeader("Content-Disposition", disposition + "; filename=\"" + fname + "\"");
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


var guess_mimetype = function(fname)
{
    if ((/.*\.html?$/i).test(fname))
        return 'text/html';

    return 'application/octet-stream';
}

var boundary = '----------ThIs_Is_tHe_bOUnDary_$';

//
// Multipart encodes POST data
//
var encodeMultipartPostData = function(postData, fname, data)
{
    var body = new Array();
    for(var field in postData) {
        if (postData[field]) {
            body.push('--' + boundary);
            body.push('Content-Disposition: form-data; name="' + field + '"');
            body.push('');
            body.push(postData[field].toString());
        }
    }

    // file
    body.push('--' + boundary);
    body.push('Content-Disposition: form-data; name="src"; filename="' + fname + '"');
    body.push('Content-Type: ' + guess_mimetype(fname));
    body.push('');
    body.push(data);

    // finalize
    body.push('--' + boundary + '--');
    body.push('');
    return body.join('\r\n');
}

//
// Calls the API
//
var convertInternal = function(that, opts) {

    // form POST data
    var postData = clone_object(opts.apiOptions);
    postData['username'] = that.username;
    postData['key'] = that.apikey;

    var contentType;
    if (opts.src) {
        contentType = "application/x-www-form-urlencoded";
        postData['src'] = opts.src;
        postData = querystring.stringify(postData);
    } else {
        contentType = "multipart/form-data; boundary=" + boundary;
        postData = encodeMultipartPostData(postData, opts.fname, opts.data);
    }

    // http options
    var httpOptions = {
        host: that.host,
        port: 80,
        method: 'POST',
        path: opts.endpoint,
        headers: { 'content-length': postData.length,
                   'content-type': contentType,
                   'user-agent': 'node-pdfcrowd client'},
    };

    var callbacks = opts.callbacks;
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

    req.write(postData, 'binary');
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
