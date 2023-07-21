"use strict";

// Copyright (C) 2009-2018 pdfcrowd.com
//
// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use,
// copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following
// conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
// OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
// WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.

var http = require('http');
var https = require('https');
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

Pdfcrowd.Error = function(message, http_code) {
    this.message = message;
    this.http_code = http_code;
    this.stack = (new Error()).stack;
    this.getCode = function() {
        return this.http_code;
    };
    this.getMessage = function() {
        return this.message;
    };
    this.toString = function() {
        if (!this.http_code) return this.message;
        return this.http_code.toString() + ' - ' + this.message;
    };
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
};


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
};


//
// Converts a local HTML file
//
Pdfcrowd.prototype.convertFile = function(fname, callbacks, options) {
    var that = this;
    fs.readFile(fname, function(err, data) {
        if (err) throw err;
        if (!data) throw "convertFile: " + fname + " has zero size";
        requestQueue.addRequest([that, {
            fname: fname,
            data: data.toString('binary'),
            endpoint: '/api/pdf/convert/html/',
            callbacks: prepareCallbacks(callbacks),
            apiOptions: options
        }]);
    });
};

var errorToString = function(errMessage, statusCode) {
    if (statusCode) {
        return "Error: " + statusCode + " - " + errMessage;
    }
    return "Error: " + errMessage;
};

//
// Returns a callback object that saves the generated PDF to a file
//
var saveToFile = function(fname, callback) {
    return {
        data: function(rstream) {
            var wstream = fs.createWriteStream(fname);
            rstream.pipe(wstream);
        },
        error: function(errMessage, statusCode) {
            if(callback) return callback(new Pdfcrowd.Error(errMessage, statusCode));
            console.error(errorToString(errMessage, statusCode));
        },
        end: function() {
            if(callback) return callback(null, fname);
        }
    };
};

//
// Returns a callback object that sends an HTTP response
//
var sendGenericHttpResponse = function(response, contentType, fname, disposition) {
    disposition = disposition || "attachment";
    return {
        data: function(rstream) {
            response.setHeader("Content-Type", contentType);
            response.setHeader("Cache-Control", "max-age=0");
            response.setHeader("Accept-Ranges", "none");
            response.setHeader("Content-Disposition", disposition + "; filename*=UTF-8''" + encodeURIComponent(fname));
            rstream.pipe(response);
        },
        error: function(errMessage, statusCode) {
            response.setHeader("Content-Type", "text/plain");
            response.end(errorToString(errMessage, statusCode));
        },
        end: function() {}
    };
};

//
// Returns a callback object that sends the generated PDF in an HTTP response, it's used for the backward compatibility
//
var sendHttpResponse = function(response, disposition, fname) {
    return sendGenericHttpResponse(response, "application/pdf", fname || "generated.pdf", disposition);
};

//
// Returns a callback object that sends the generated PDF in an HTTP response
//
var sendPdfInHttpResponse = function(response, fileName, disposition) {
    return sendHttpResponse(response, disposition, fileName);
};

//
// Returns a callback object that sends the generated Image in an HTTP response
//
var sendImageInHttpResponse = function(response, contentType, fileName, disposition) {
    return sendGenericHttpResponse(response, contentType, fileName, disposition);
};

// ---------------------------------------------------------------------------
//                                PRIVATE


//
// Adds the default implementation if a callback is missing
//
var prepareCallbacks = function(callbacks) {
    callbacks = callbacks || {};
    if (typeof callbacks.pdf !== "function" && typeof callbacks.data !== "function") {
        callbacks.data = function(rstream) {
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
};


var guess_mimetype = function(fname)
{
    if ((/.*\.html?$/i).test(fname))
        return 'text/html';

    return 'application/octet-stream';
};

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
        contentType = "multipart/form-data; boundary=" + MULTIPART_BOUNDARY;
        postData = encodeMultipartPostDataLegacy(postData, opts.fname, opts.data);
    }

    // http options
    var httpOptions = {
        host: that.host,
        port: 80,
        method: 'POST',
        path: opts.endpoint,
        headers: { 'content-length': postData.length,
                   'content-type': contentType,
                   'user-agent': 'node-pdfcrowd client'}
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

            if (typeof callbacks.pdf === "function") {
                // for backward compatibility use pdf callback
                callbacks.pdf(res);
            } else {
                callbacks.data(res);
            }
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
};


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

//
// Multipart encodes POST data
//
function encodeMultipartPostDataLegacy(postData, fname, data) {
    var body = new Array();
    for(var field in postData) {
        if (postData[field]) {
            body.push('--' + MULTIPART_BOUNDARY);
            body.push('Content-Disposition: form-data; name="' + field + '"');
            body.push('');
            body.push(postData[field].toString());
        }
    }

    // file
    body.push('--' + MULTIPART_BOUNDARY);
    body.push('Content-Disposition: form-data; name="src"; filename="' + fname + '"');
    body.push('Content-Type: ' + guess_mimetype(fname));
    body.push('');
    body.push(data);

    // finalize
    body.push('--' + MULTIPART_BOUNDARY + '--');
    body.push('');
    return body.join('\r\n');
}


// =====================================
// === PDFCrowd cloud version client ===
// =====================================

var HOST = process.env.PDFCROWD_HOST || 'api.pdfcrowd.com';
var CLIENT_VERSION = '5.14.0';
var MULTIPART_BOUNDARY = '----------ThIs_Is_tHe_bOUnDary_$';
var CLIENT_ERROR = -1;

function encodeCredentials(userName, password) {
    return 'Basic ' + new Buffer(userName + ':' + password).toString('base64');
}

function createInvalidValueMessage(value, field, converter, hint, id) {
    var message = "Invalid value '" + value + "' for " + field + ".";
    if(hint) {
        message += " " + hint;
    }
    return message + " " + "Details: https://www.pdfcrowd.com/api/" + converter + "-nodejs/ref/#" + id + "";
}

function ConnectionHelper(userName, apiKey) {
    this.userName = userName;
    this.apiKey = apiKey;

    this.resetResponseData();
    this.setProxy(null, null, null, null);
    this.setUseHttp(false);
    this.setUserAgent('pdfcrowd_nodejs_client/5.14.0 (https://pdfcrowd.com)');

    this.retryCount = 1;
    this.converterVersion = '20.10';
}

function toUTF8String(str) {
    return unescape(encodeURIComponent(str));
}

function isOutputTypeValid(file_path, client) {
    var re = /(?:\.([^./\\]+))?$/;
    var extension = re.exec(file_path);
    return (extension[1] === "zip") == client.isZippedOutput();
}

ConnectionHelper.prototype.post = function(fields, files, rawData, callbacks) {
    var that = this;

    var body = new Array();
    for(var field in fields) {
        if(fields[field]) {
            body.push('--' + MULTIPART_BOUNDARY);
            body.push('Content-Disposition: form-data; name="' + field + '"');
            body.push('');
            body.push(toUTF8String(fields[field]));
        }
    }

    var contentType = 'multipart/form-data; boundary=' + MULTIPART_BOUNDARY;
    var count = 0;
    var filesCount = Object.keys(files).length;
    var createHandler = function(key) {
        return function(err, data) {
            count++;
            if(err) return callbacks.error(err, CLIENT_ERROR);

            addFileField(key, files[key], data, body);

            if(count != filesCount) return;

            // finalize body
            body.push('--' + MULTIPART_BOUNDARY + '--');
            body.push('');

            return that.doPost(body.join('\r\n'), contentType, callbacks);
        };
    };

    for(var name in rawData) {
        var data = rawData[name];
        if(name !== 'stream') {
            data = data.toString('binary');
        }
        addFileField(name, name, data, body);
    }

    if(Object.keys(files).length == 0) {
        // finalize body
        body.push('--' + MULTIPART_BOUNDARY + '--');
        body.push('');

        return this.doPost(body.join('\r\n'), contentType, callbacks);
    } else {
        for(var key in files) {
            fs.readFile(files[key], 'binary', createHandler(key));
        }
    }
};

ConnectionHelper.prototype.resetResponseData = function() {
    this.debugLogUrl = null;
    this.credits = 999999;
    this.consumedCredits = 0;
    this.jobId = '';
    this.pageCount = 0;
    this.totalPageCount = 0;
    this.outputSize = 0;
    this.retry = 0;
};

function addFileField(name, fileName, data, body) {
    body.push('--' + MULTIPART_BOUNDARY);
    body.push('Content-Disposition: form-data; name="' + name + '"; filename="' + fileName + '"');
    body.push('Content-Type: application/octet-stream');
    body.push('');
    body.push(data);
}

//
// Calls the API
//
ConnectionHelper.prototype.doPost = function(body, contentType, callbacks) {
    if(!this.useHttp && this.proxyHost)
        return callbacks.error('HTTPS over a proxy is not supported.');

    this.resetResponseData();

    var httpOptions = {
        method: 'POST',
        headers: {
            'Content-Length': body.length,
            'Content-Type': contentType,
            'User-Agent': this.userAgent,
            'Authorization': encodeCredentials(this.userName, this.apiKey)
        },
        ssl: !this.useHttp,
        rejectUnauthorized: HOST == 'api.pdfcrowd.com'
    };

    var conv_selector = '/convert/' + this.converterVersion + '/';
    if(this.proxyHost) {
        httpOptions.host = this.proxyHost;
        httpOptions.path = 'http://' + HOST + ':' + this.port + conv_selector;
        httpOptions.port = this.proxyPort;
        httpOptions.headers['Proxy-Authorization'] = encodeCredentials(this.proxyUserName, this.proxyPassword);
    } else {
        httpOptions.host = HOST;
        httpOptions.path = conv_selector;
        httpOptions.port = this.port;
    }

    var that = this;

    var retryCallback = {
        data: function(rstream) {
            callbacks.data(rstream);
        },
        end: function() {
            callbacks.end();
        }
    };

    retryCallback.error = function(errMessage, statusCode) {
        if((statusCode == 502 || statusCode == 503) &&
           that.retryCount > that.retry) {
            that.retry++;
            setTimeout(function() {
                that.execRequest(body, httpOptions, retryCallback);
                }, that.retry * 100);
        } else {
            callbacks.error(errMessage, statusCode);
        }
    };

    return this.execRequest(body, httpOptions, retryCallback);
}

var SSL_ERRORS = [
    // from https://github.com/nodejs/node/blob/ed3d8b13ee9a705d89f9e0397d9e96519e7e47ac/src/node_crypto.cc#L1950
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_CRL',
    'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
    'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
    'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
    'CERT_SIGNATURE_FAILURE',
    'CRL_SIGNATURE_FAILURE',
    'CERT_NOT_YET_VALID',
    'CERT_HAS_EXPIRED',
    'CRL_NOT_YET_VALID',
    'CRL_HAS_EXPIRED',
    'ERROR_IN_CERT_NOT_BEFORE_FIELD',
    'ERROR_IN_CERT_NOT_AFTER_FIELD',
    'ERROR_IN_CRL_LAST_UPDATE_FIELD',
    'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
    'OUT_OF_MEM',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_CHAIN_TOO_LONG',
    'CERT_REVOKED',
    'INVALID_CA',
    'PATH_LENGTH_EXCEEDED',
    'INVALID_PURPOSE',
    'CERT_UNTRUSTED',
    'CERT_REJECTED'
];

ConnectionHelper.prototype.execRequest = function(body, httpOptions, callbacks) {
    var that = this;
    var req = this.scheme.request(httpOptions, function(res) {
        that.debugLogUrl = res.headers['x-pdfcrowd-debug-log'] || '';
        that.credits = parseInt(res.headers['x-pdfcrowd-remaining-credits'] || 999999);
        that.consumedCredits = parseInt(res.headers['x-pdfcrowd-consumed-credits'] || 0);
        that.jobId = res.headers['x-pdfcrowd-job-id'] || '';
        that.pageCount = parseInt(res.headers['x-pdfcrowd-pages'] || 0);
        that.totalPageCount = parseInt(res.headers['x-pdfcrowd-total-pages'] || 0);
        that.outputSize = parseInt(res.headers['x-pdfcrowd-output-size'] || 0);

        if (res.statusCode < 300) {
            res.on('end', function() {
                callbacks.end();
            });

            res.on('error', function(exc) {
                callbacks.error(exc.toString());
            });

            if (typeof callbacks.pdf === "function") {
                // for backward compatibility use pdf callback
                callbacks.pdf(res);
            } else {
                callbacks.data(res);
            }
        }
        else {
            var err = [];
            res.on('data', function(chunk) {
                err.push(chunk.toString());
            });
            res.on('end', function() {
                callbacks.error(err.join(''), res.statusCode);
            });
        }
    });

    req.on('error', function(res) {
        if(SSL_ERRORS.indexOf(res.code) > -1) {
            callbacks.error("There was a problem connecting to Pdfcrowd servers over HTTPS:\n" +
                            res.toString() +
                            "\nYou can still use the API over HTTP, you just need to add the following line right after Pdfcrowd client initialization:\nclient.setUseHttp(true);",
                            481);
        }
        else {
            callbacks.error(res.toString(), res.statusCode);
        }
    });

    req.write(body, 'binary');
    req.end();
};

ConnectionHelper.prototype.setUseHttp = function(useHttp) {
    if(useHttp) {
        this.port = 80;
        this.scheme = http;
    }
    else {
        this.port = 443;
        this.scheme = https;
    }
    this.useHttp = useHttp;
};

ConnectionHelper.prototype.setProxy = function(host, port, userName, password) {
    this.proxyHost = host;
    this.proxyPort = port;
    this.proxyUserName = userName;
    this.proxyPassword = password;
};

ConnectionHelper.prototype.setUserAgent = function(userAgent) {
    this.userAgent = userAgent;
};

ConnectionHelper.prototype.setRetryCount = function(retryCount) {
    this.retryCount = retryCount;
};

ConnectionHelper.prototype.setConverterVersion = function(converterVersion) {
    this.converterVersion = converterVersion;
};

ConnectionHelper.prototype.getDebugLogUrl = function() {
    return this.debugLogUrl;
};

ConnectionHelper.prototype.getRemainingCreditCount = function() {
    return this.credits;
};

ConnectionHelper.prototype.getConsumedCreditCount = function() {
    return this.consumedCredits;
};

ConnectionHelper.prototype.getJobId = function() {
    return this.jobId;
};

ConnectionHelper.prototype.getPageCount = function() {
    return this.pageCount;
};

ConnectionHelper.prototype.getTotalPageCount = function() {
    return this.totalPageCount;
};

ConnectionHelper.prototype.getOutputSize = function() {
    return this.outputSize;
};

ConnectionHelper.prototype.getConverterVersion = function() {
    return this.converterVersion;
};

// generated code

/**
* Conversion from HTML to PDF.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function HtmlToPdfClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'html',
        'output_format': 'pdf'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* Convert a web page.
*
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToPdfClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a web page and write the result to a local file.
*
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToPdfClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
*
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToPdfClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "html-to-pdf", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
*
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToPdfClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert a string.
*
* @param text The string content to convert. The string must not be empty.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToPdfClient.prototype.convertString = function(text, callbacks) {
    if (!(text))
        return callbacks.error(createInvalidValueMessage(text, "convertString", "html-to-pdf", "The string must not be empty.", "convert_string"), 470);
    
    this.fields['text'] = text;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a string and write the output to a file.
*
* @param text The string content to convert. The string must not be empty.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToPdfClient.prototype.convertStringToFile = function(text, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStringToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_string_to_file"), 470);
    
    this.convertString(text, saveToFile(filePath, callback));
};

/**
* Convert the contents of an input stream.
*
* @param inStream The input stream with source data.<br> The stream can contain either HTML code or an archive (.zip, .tar.gz, .tar.bz2).<br>The archive can contain HTML code and its external assets (images, style sheets, javascript).
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToPdfClient.prototype.convertStream = function(inStream, callbacks) {
    var data = '';
    var that = this;
    inStream.on('error', function(err) {
        callbacks.error(err, CLIENT_ERROR);
    });
    inStream.on('data', function(chunk) {
        data += chunk;
    });
    inStream.on('end', function() {
        that.rawData['stream'] = data;
        return that.helper.post(that.fields, that.files, that.rawData, callbacks);
    });
};

/**
* Convert the contents of an input stream and write the result to a local file.
*
* @param inStream The input stream with source data.<br> The stream can contain either HTML code or an archive (.zip, .tar.gz, .tar.bz2).<br>The archive can contain HTML code and its external assets (images, style sheets, javascript).
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToPdfClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
* Set the file name of the main HTML document stored in the input archive. If not specified, the first HTML file in the archive is used for conversion. Use this method if the input archive contains multiple HTML documents.
*
* @param filename The file name.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setZipMainFilename = function(filename) {
    this.fields['zip_main_filename'] = filename;
    return this;
};

/**
* Set the output page size.
*
* @param size Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageSize = function(size) {
    if (!size.match(/^(A0|A1|A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(size, "setPageSize", "html-to-pdf", "Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.", "set_page_size"), 470);
    
    this.fields['page_size'] = size;
    return this;
};

/**
* Set the output page width. The safe maximum is <span class='field-value'>200in</span> otherwise some PDF viewers may be unable to open the PDF.
*
* @param width The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setPageWidth", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_page_width"), 470);
    
    this.fields['page_width'] = width;
    return this;
};

/**
* Set the output page height. Use <span class='field-value'>-1</span> for a single page PDF. The safe maximum is <span class='field-value'>200in</span> otherwise some PDF viewers may be unable to open the PDF.
*
* @param height The value must be -1 or specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageHeight = function(height) {
    if (!height.match(/^0$|^\-1$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setPageHeight", "html-to-pdf", "The value must be -1 or specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_page_height"), 470);
    
    this.fields['page_height'] = height;
    return this;
};

/**
* Set the output page dimensions.
*
* @param width Set the output page width. The safe maximum is <span class='field-value'>200in</span> otherwise some PDF viewers may be unable to open the PDF. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param height Set the output page height. Use <span class='field-value'>-1</span> for a single page PDF. The safe maximum is <span class='field-value'>200in</span> otherwise some PDF viewers may be unable to open the PDF. The value must be -1 or specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageDimensions = function(width, height) {
    this.setPageWidth(width);
    this.setPageHeight(height);
    return this;
};

/**
* Set the output page orientation.
*
* @param orientation Allowed values are landscape, portrait.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "setOrientation", "html-to-pdf", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
    return this;
};

/**
* Set the output page top margin.
*
* @param top The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMarginTop = function(top) {
    if (!top.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(top, "setMarginTop", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_top"), 470);
    
    this.fields['margin_top'] = top;
    return this;
};

/**
* Set the output page right margin.
*
* @param right The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMarginRight = function(right) {
    if (!right.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(right, "setMarginRight", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_right"), 470);
    
    this.fields['margin_right'] = right;
    return this;
};

/**
* Set the output page bottom margin.
*
* @param bottom The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMarginBottom = function(bottom) {
    if (!bottom.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(bottom, "setMarginBottom", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = bottom;
    return this;
};

/**
* Set the output page left margin.
*
* @param left The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMarginLeft = function(left) {
    if (!left.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(left, "setMarginLeft", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_left"), 470);
    
    this.fields['margin_left'] = left;
    return this;
};

/**
* Disable page margins.
*
* @param value Set to <span class='field-value'>true</span> to disable margins.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoMargins = function(value) {
    this.fields['no_margins'] = value;
    return this;
};

/**
* Set the output page margins.
*
* @param top Set the output page top margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param right Set the output page right margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param bottom Set the output page bottom margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param left Set the output page left margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
    return this;
};

/**
* Set the page range to print.
*
* @param pages A comma separated list of page numbers or ranges.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "html-to-pdf", "A comma separated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
* Set an offset between physical and logical page numbers.
*
* @param offset Integer specifying page offset.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageNumberingOffset = function(offset) {
    this.fields['page_numbering_offset'] = offset.toString();
    return this;
};

/**
* Set the top left X coordinate of the content area. It is relative to the top left X coordinate of the print area.
*
* @param x The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt". It may contain a negative value.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setContentAreaX = function(x) {
    if (!x.match(/^0$|^\-?[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setContentAreaX", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\". It may contain a negative value.", "set_content_area_x"), 470);
    
    this.fields['content_area_x'] = x;
    return this;
};

/**
* Set the top left Y coordinate of the content area. It is relative to the top left Y coordinate of the print area.
*
* @param y The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt". It may contain a negative value.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setContentAreaY = function(y) {
    if (!y.match(/^0$|^\-?[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setContentAreaY", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\". It may contain a negative value.", "set_content_area_y"), 470);
    
    this.fields['content_area_y'] = y;
    return this;
};

/**
* Set the width of the content area. It should be at least 1 inch.
*
* @param width The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setContentAreaWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setContentAreaWidth", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_content_area_width"), 470);
    
    this.fields['content_area_width'] = width;
    return this;
};

/**
* Set the height of the content area. It should be at least 1 inch.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setContentAreaHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setContentAreaHeight", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_content_area_height"), 470);
    
    this.fields['content_area_height'] = height;
    return this;
};

/**
* Set the content area position and size. The content area enables to specify a web page area to be converted.
*
* @param x Set the top left X coordinate of the content area. It is relative to the top left X coordinate of the print area. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt". It may contain a negative value.
* @param y Set the top left Y coordinate of the content area. It is relative to the top left Y coordinate of the print area. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt". It may contain a negative value.
* @param width Set the width of the content area. It should be at least 1 inch. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param height Set the height of the content area. It should be at least 1 inch. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setContentArea = function(x, y, width, height) {
    this.setContentAreaX(x);
    this.setContentAreaY(y);
    this.setContentAreaWidth(width);
    this.setContentAreaHeight(height);
    return this;
};

/**
* Specifies behavior in presence of CSS @page rules. It may affect the page size, margins and orientation.
*
* @param mode The page rule mode. Allowed values are default, mode1, mode2.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setCssPageRuleMode = function(mode) {
    if (!mode.match(/^(default|mode1|mode2)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setCssPageRuleMode", "html-to-pdf", "Allowed values are default, mode1, mode2.", "set_css_page_rule_mode"), 470);
    
    this.fields['css_page_rule_mode'] = mode;
    return this;
};

/**
* Specifies which blank pages to exclude from the output document.
*
* @param pages The empty page behavior. Allowed values are trailing, none.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setRemoveBlankPages = function(pages) {
    if (!pages.match(/^(trailing|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setRemoveBlankPages", "html-to-pdf", "Allowed values are trailing, none.", "set_remove_blank_pages"), 470);
    
    this.fields['remove_blank_pages'] = pages;
    return this;
};

/**
* Load an HTML code from the specified URL and use it as the page header. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of the converted document</li> <li><span class='field-value'>pdfcrowd-source-title</span> - the title of the converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals. Allowed values: <ul> <li><span class='field-value'>arabic</span> - Arabic numerals, they are used by default</li> <li><span class='field-value'>roman</span> - Roman numerals</li> <li><span class='field-value'>eastern-arabic</span> - Eastern Arabic numerals</li> <li><span class='field-value'>bengali</span> - Bengali numerals</li> <li><span class='field-value'>devanagari</span> - Devanagari numerals</li> <li><span class='field-value'>thai</span> - Thai numerals</li> <li><span class='field-value'>east-asia</span> - Chinese, Vietnamese, Japanese and Korean numerals</li> <li><span class='field-value'>chinese-formal</span> - Chinese formal numerals</li> </ul> Please contact us if you need another type of numerals.<br> Example:<br> &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt; </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL. Allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul> </li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHeaderUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setHeaderUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "set_header_url"), 470);
    
    this.fields['header_url'] = url;
    return this;
};

/**
* Use the specified HTML code as the page header. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of the converted document</li> <li><span class='field-value'>pdfcrowd-source-title</span> - the title of the converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals. Allowed values: <ul> <li><span class='field-value'>arabic</span> - Arabic numerals, they are used by default</li> <li><span class='field-value'>roman</span> - Roman numerals</li> <li><span class='field-value'>eastern-arabic</span> - Eastern Arabic numerals</li> <li><span class='field-value'>bengali</span> - Bengali numerals</li> <li><span class='field-value'>devanagari</span> - Devanagari numerals</li> <li><span class='field-value'>thai</span> - Thai numerals</li> <li><span class='field-value'>east-asia</span> - Chinese, Vietnamese, Japanese and Korean numerals</li> <li><span class='field-value'>chinese-formal</span> - Chinese formal numerals</li> </ul> Please contact us if you need another type of numerals.<br> Example:<br> &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt; </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL. Allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul> </li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
*
* @param html The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHeaderHtml = function(html) {
    if (!(html))
        throw new Pdfcrowd.Error(createInvalidValueMessage(html, "setHeaderHtml", "html-to-pdf", "The string must not be empty.", "set_header_html"), 470);
    
    this.fields['header_html'] = html;
    return this;
};

/**
* Set the header height.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHeaderHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setHeaderHeight", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_header_height"), 470);
    
    this.fields['header_height'] = height;
    return this;
};

/**
* Set the file name of the header HTML document stored in the input archive. Use this method if the input archive contains multiple HTML documents.
*
* @param filename The file name.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setZipHeaderFilename = function(filename) {
    this.fields['zip_header_filename'] = filename;
    return this;
};

/**
* Load an HTML code from the specified URL and use it as the page footer. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of the converted document</li> <li><span class='field-value'>pdfcrowd-source-title</span> - the title of the converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals. Allowed values: <ul> <li><span class='field-value'>arabic</span> - Arabic numerals, they are used by default</li> <li><span class='field-value'>roman</span> - Roman numerals</li> <li><span class='field-value'>eastern-arabic</span> - Eastern Arabic numerals</li> <li><span class='field-value'>bengali</span> - Bengali numerals</li> <li><span class='field-value'>devanagari</span> - Devanagari numerals</li> <li><span class='field-value'>thai</span> - Thai numerals</li> <li><span class='field-value'>east-asia</span> - Chinese, Vietnamese, Japanese and Korean numerals</li> <li><span class='field-value'>chinese-formal</span> - Chinese formal numerals</li> </ul> Please contact us if you need another type of numerals.<br> Example:<br> &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt; </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL. Allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul> </li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFooterUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setFooterUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "set_footer_url"), 470);
    
    this.fields['footer_url'] = url;
    return this;
};

/**
* Use the specified HTML as the page footer. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of the converted document</li> <li><span class='field-value'>pdfcrowd-source-title</span> - the title of the converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals. Allowed values: <ul> <li><span class='field-value'>arabic</span> - Arabic numerals, they are used by default</li> <li><span class='field-value'>roman</span> - Roman numerals</li> <li><span class='field-value'>eastern-arabic</span> - Eastern Arabic numerals</li> <li><span class='field-value'>bengali</span> - Bengali numerals</li> <li><span class='field-value'>devanagari</span> - Devanagari numerals</li> <li><span class='field-value'>thai</span> - Thai numerals</li> <li><span class='field-value'>east-asia</span> - Chinese, Vietnamese, Japanese and Korean numerals</li> <li><span class='field-value'>chinese-formal</span> - Chinese formal numerals</li> </ul> Please contact us if you need another type of numerals.<br> Example:<br> &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt; </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL. Allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul> </li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
*
* @param html The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFooterHtml = function(html) {
    if (!(html))
        throw new Pdfcrowd.Error(createInvalidValueMessage(html, "setFooterHtml", "html-to-pdf", "The string must not be empty.", "set_footer_html"), 470);
    
    this.fields['footer_html'] = html;
    return this;
};

/**
* Set the footer height.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFooterHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setFooterHeight", "html-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_footer_height"), 470);
    
    this.fields['footer_height'] = height;
    return this;
};

/**
* Set the file name of the footer HTML document stored in the input archive. Use this method if the input archive contains multiple HTML documents.
*
* @param filename The file name.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setZipFooterFilename = function(filename) {
    this.fields['zip_footer_filename'] = filename;
    return this;
};

/**
* Disable horizontal page margins for header and footer. The header/footer contents width will be equal to the physical page width.
*
* @param value Set to <span class='field-value'>true</span> to disable horizontal margins for header and footer.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoHeaderFooterHorizontalMargins = function(value) {
    this.fields['no_header_footer_horizontal_margins'] = value;
    return this;
};

/**
* The page header is not printed on the specified pages.
*
* @param pages List of physical page numbers. Negative numbers count backwards from the last page: -1 is the last page, -2 is the last but one page, and so on. A comma separated list of page numbers.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setExcludeHeaderOnPages = function(pages) {
    if (!pages.match(/^(?:\s*\-?\d+\s*,)*\s*\-?\d+\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setExcludeHeaderOnPages", "html-to-pdf", "A comma separated list of page numbers.", "set_exclude_header_on_pages"), 470);
    
    this.fields['exclude_header_on_pages'] = pages;
    return this;
};

/**
* The page footer is not printed on the specified pages.
*
* @param pages List of physical page numbers. Negative numbers count backwards from the last page: -1 is the last page, -2 is the last but one page, and so on. A comma separated list of page numbers.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setExcludeFooterOnPages = function(pages) {
    if (!pages.match(/^(?:\s*\-?\d+\s*,)*\s*\-?\d+\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setExcludeFooterOnPages", "html-to-pdf", "A comma separated list of page numbers.", "set_exclude_footer_on_pages"), 470);
    
    this.fields['exclude_footer_on_pages'] = pages;
    return this;
};

/**
* Set the scaling factor (zoom) for the header and footer.
*
* @param factor The percentage value. The value must be in the range 10-500.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHeaderFooterScaleFactor = function(factor) {
    if (!(parseInt(factor) >= 10 && parseInt(factor) <= 500))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setHeaderFooterScaleFactor", "html-to-pdf", "The value must be in the range 10-500.", "set_header_footer_scale_factor"), 470);
    
    this.fields['header_footer_scale_factor'] = factor.toString();
    return this;
};

/**
* Apply a watermark to each page of the output PDF file. A watermark can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the watermark.
*
* @param watermark The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setPageWatermark", "html-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = watermark;
    return this;
};

/**
* Load a file from the specified URL and apply the file as a watermark to each page of the output PDF. A watermark can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the watermark.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageWatermarkUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "set_page_watermark_url"), 470);
    
    this.fields['page_watermark_url'] = url;
    return this;
};

/**
* Apply each page of a watermark to the corresponding page of the output PDF. A watermark can be either a PDF or an image.
*
* @param watermark The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMultipageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setMultipageWatermark", "html-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = watermark;
    return this;
};

/**
* Load a file from the specified URL and apply each page of the file as a watermark to the corresponding page of the output PDF. A watermark can be either a PDF or an image.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMultipageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageWatermarkUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "set_multipage_watermark_url"), 470);
    
    this.fields['multipage_watermark_url'] = url;
    return this;
};

/**
* Apply a background to each page of the output PDF file. A background can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the background.
*
* @param background The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setPageBackground", "html-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = background;
    return this;
};

/**
* Load a file from the specified URL and apply the file as a background to each page of the output PDF. A background can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the background.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageBackgroundUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "set_page_background_url"), 470);
    
    this.fields['page_background_url'] = url;
    return this;
};

/**
* Apply each page of a background to the corresponding page of the output PDF. A background can be either a PDF or an image.
*
* @param background The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMultipageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setMultipageBackground", "html-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = background;
    return this;
};

/**
* Load a file from the specified URL and apply each page of the file as a background to the corresponding page of the output PDF. A background can be either a PDF or an image.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMultipageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageBackgroundUrl", "html-to-pdf", "The supported protocols are http:// and https://.", "set_multipage_background_url"), 470);
    
    this.fields['multipage_background_url'] = url;
    return this;
};

/**
* The page background color in RGB or RGBA hexadecimal format. The color fills the entire page regardless of the margins.
*
* @param color The value must be in RRGGBB or RRGGBBAA hexadecimal format.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setPageBackgroundColor", "html-to-pdf", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_page_background_color"), 470);
    
    this.fields['page_background_color'] = color;
    return this;
};

/**
* Use the print version of the page if available (@media print).
*
* @param value Set to <span class='field-value'>true</span> to use the print version of the page.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setUsePrintMedia = function(value) {
    this.fields['use_print_media'] = value;
    return this;
};

/**
* Do not print the background graphics.
*
* @param value Set to <span class='field-value'>true</span> to disable the background graphics.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoBackground = function(value) {
    this.fields['no_background'] = value;
    return this;
};

/**
* Do not execute JavaScript.
*
* @param value Set to <span class='field-value'>true</span> to disable JavaScript in web pages.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDisableJavascript = function(value) {
    this.fields['disable_javascript'] = value;
    return this;
};

/**
* Do not load images.
*
* @param value Set to <span class='field-value'>true</span> to disable loading of images.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDisableImageLoading = function(value) {
    this.fields['disable_image_loading'] = value;
    return this;
};

/**
* Disable loading fonts from remote sources.
*
* @param value Set to <span class='field-value'>true</span> disable loading remote fonts.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDisableRemoteFonts = function(value) {
    this.fields['disable_remote_fonts'] = value;
    return this;
};

/**
* Use a mobile user agent.
*
* @param value Set to <span class='field-value'>true</span> to use a mobile user agent.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setUseMobileUserAgent = function(value) {
    this.fields['use_mobile_user_agent'] = value;
    return this;
};

/**
* Specifies how iframes are handled.
*
* @param iframes Allowed values are all, same-origin, none.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setLoadIframes = function(iframes) {
    if (!iframes.match(/^(all|same-origin|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(iframes, "setLoadIframes", "html-to-pdf", "Allowed values are all, same-origin, none.", "set_load_iframes"), 470);
    
    this.fields['load_iframes'] = iframes;
    return this;
};

/**
* Try to block ads. Enabling this option can produce smaller output and speed up the conversion.
*
* @param value Set to <span class='field-value'>true</span> to block ads in web pages.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setBlockAds = function(value) {
    this.fields['block_ads'] = value;
    return this;
};

/**
* Set the default HTML content text encoding.
*
* @param encoding The text encoding of the HTML content.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDefaultEncoding = function(encoding) {
    this.fields['default_encoding'] = encoding;
    return this;
};

/**
* Set the locale for the conversion. This may affect the output format of dates, times and numbers.
*
* @param locale The locale code according to ISO 639.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setLocale = function(locale) {
    this.fields['locale'] = locale;
    return this;
};

/**
* Set the HTTP authentication user name.
*
* @param userName The user name.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHttpAuthUserName = function(userName) {
    this.fields['http_auth_user_name'] = userName;
    return this;
};

/**
* Set the HTTP authentication password.
*
* @param password The password.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHttpAuthPassword = function(password) {
    this.fields['http_auth_password'] = password;
    return this;
};

/**
* Set credentials to access HTTP base authentication protected websites.
*
* @param userName Set the HTTP authentication user name.
* @param password Set the HTTP authentication password.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHttpAuth = function(userName, password) {
    this.setHttpAuthUserName(userName);
    this.setHttpAuthPassword(password);
    return this;
};

/**
* Set cookies that are sent in Pdfcrowd HTTP requests.
*
* @param cookies The cookie string.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setCookies = function(cookies) {
    this.fields['cookies'] = cookies;
    return this;
};

/**
* Do not allow insecure HTTPS connections.
*
* @param value Set to <span class='field-value'>true</span> to enable SSL certificate verification.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setVerifySslCertificates = function(value) {
    this.fields['verify_ssl_certificates'] = value;
    return this;
};

/**
* Abort the conversion if the main URL HTTP status code is greater than or equal to 400.
*
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFailOnMainUrlError = function(failOnError) {
    this.fields['fail_on_main_url_error'] = failOnError;
    return this;
};

/**
* Abort the conversion if any of the sub-request HTTP status code is greater than or equal to 400 or if some sub-requests are still pending. See details in a debug log.
*
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFailOnAnyUrlError = function(failOnError) {
    this.fields['fail_on_any_url_error'] = failOnError;
    return this;
};

/**
* Do not send the X-Pdfcrowd HTTP header in Pdfcrowd HTTP requests.
*
* @param value Set to <span class='field-value'>true</span> to disable sending X-Pdfcrowd HTTP header.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoXpdfcrowdHeader = function(value) {
    this.fields['no_xpdfcrowd_header'] = value;
    return this;
};

/**
* Apply custom CSS to the input HTML document. It allows you to modify the visual appearance and layout of your HTML content dynamically. Tip: Using <span class='field-value'>!important</span> in custom CSS provides a way to prioritize and override conflicting styles.
*
* @param css A string containing valid CSS. The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setCustomCss = function(css) {
    if (!(css))
        throw new Pdfcrowd.Error(createInvalidValueMessage(css, "setCustomCss", "html-to-pdf", "The string must not be empty.", "set_custom_css"), 470);
    
    this.fields['custom_css'] = css;
    return this;
};

/**
* Run a custom JavaScript after the document is loaded and ready to print. The script is intended for post-load DOM manipulation (add/remove elements, update CSS, ...). In addition to the standard browser APIs, the custom JavaScript code can use helper functions from our <a href='/api/libpdfcrowd/'>JavaScript library</a>.
*
* @param javascript A string containing a JavaScript code. The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setCustomJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setCustomJavascript", "html-to-pdf", "The string must not be empty.", "set_custom_javascript"), 470);
    
    this.fields['custom_javascript'] = javascript;
    return this;
};

/**
* Run a custom JavaScript right after the document is loaded. The script is intended for early DOM manipulation (add/remove elements, update CSS, ...). In addition to the standard browser APIs, the custom JavaScript code can use helper functions from our <a href='/api/libpdfcrowd/'>JavaScript library</a>.
*
* @param javascript A string containing a JavaScript code. The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setOnLoadJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setOnLoadJavascript", "html-to-pdf", "The string must not be empty.", "set_on_load_javascript"), 470);
    
    this.fields['on_load_javascript'] = javascript;
    return this;
};

/**
* Set a custom HTTP header that is sent in Pdfcrowd HTTP requests.
*
* @param header A string containing the header name and value separated by a colon.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setCustomHttpHeader = function(header) {
    if (!header.match(/^.+:.+$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(header, "setCustomHttpHeader", "html-to-pdf", "A string containing the header name and value separated by a colon.", "set_custom_http_header"), 470);
    
    this.fields['custom_http_header'] = header;
    return this;
};

/**
* Wait the specified number of milliseconds to finish all JavaScript after the document is loaded. Your API license defines the maximum wait time by "Max Delay" parameter.
*
* @param delay The number of milliseconds to wait. Must be a positive integer number or 0.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setJavascriptDelay = function(delay) {
    if (!(parseInt(delay) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(delay, "setJavascriptDelay", "html-to-pdf", "Must be a positive integer number or 0.", "set_javascript_delay"), 470);
    
    this.fields['javascript_delay'] = delay.toString();
    return this;
};

/**
* Convert only the specified element from the main document and its children. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. If the element is not found, the conversion fails. If multiple elements are found, the first one is used.
*
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setElementToConvert = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setElementToConvert", "html-to-pdf", "The string must not be empty.", "set_element_to_convert"), 470);
    
    this.fields['element_to_convert'] = selectors;
    return this;
};

/**
* Specify the DOM handling when only a part of the document is converted. This can affect the CSS rules used.
*
* @param mode Allowed values are cut-out, remove-siblings, hide-siblings.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setElementToConvertMode = function(mode) {
    if (!mode.match(/^(cut-out|remove-siblings|hide-siblings)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setElementToConvertMode", "html-to-pdf", "Allowed values are cut-out, remove-siblings, hide-siblings.", "set_element_to_convert_mode"), 470);
    
    this.fields['element_to_convert_mode'] = mode;
    return this;
};

/**
* Wait for the specified element in a source document. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. The element is searched for in the main document and all iframes. If the element is not found, the conversion fails. Your API license defines the maximum wait time by "Max Delay" parameter.
*
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setWaitForElement = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setWaitForElement", "html-to-pdf", "The string must not be empty.", "set_wait_for_element"), 470);
    
    this.fields['wait_for_element'] = selectors;
    return this;
};

/**
* The main HTML element for conversion is detected automatically.
*
* @param value Set to <span class='field-value'>true</span> to detect the main element.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setAutoDetectElementToConvert = function(value) {
    this.fields['auto_detect_element_to_convert'] = value;
    return this;
};

/**
* The input HTML is automatically enhanced to improve the readability.
*
* @param enhancements Allowed values are none, readability-v1, readability-v2, readability-v3, readability-v4.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setReadabilityEnhancements = function(enhancements) {
    if (!enhancements.match(/^(none|readability-v1|readability-v2|readability-v3|readability-v4)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(enhancements, "setReadabilityEnhancements", "html-to-pdf", "Allowed values are none, readability-v1, readability-v2, readability-v3, readability-v4.", "set_readability_enhancements"), 470);
    
    this.fields['readability_enhancements'] = enhancements;
    return this;
};

/**
* Set the viewport width in pixels. The viewport is the user's visible area of the page.
*
* @param width The value must be in the range 96-65000.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setViewportWidth = function(width) {
    if (!(parseInt(width) >= 96 && parseInt(width) <= 65000))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setViewportWidth", "html-to-pdf", "The value must be in the range 96-65000.", "set_viewport_width"), 470);
    
    this.fields['viewport_width'] = width.toString();
    return this;
};

/**
* Set the viewport height in pixels. The viewport is the user's visible area of the page. If the input HTML uses lazily loaded images, try using a large value that covers the entire height of the HTML, e.g. 100000.
*
* @param height Must be a positive integer number.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setViewportHeight = function(height) {
    if (!(parseInt(height) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setViewportHeight", "html-to-pdf", "Must be a positive integer number.", "set_viewport_height"), 470);
    
    this.fields['viewport_height'] = height.toString();
    return this;
};

/**
* Set the viewport size. The viewport is the user's visible area of the page.
*
* @param width Set the viewport width in pixels. The viewport is the user's visible area of the page. The value must be in the range 96-65000.
* @param height Set the viewport height in pixels. The viewport is the user's visible area of the page. If the input HTML uses lazily loaded images, try using a large value that covers the entire height of the HTML, e.g. 100000. Must be a positive integer number.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setViewport = function(width, height) {
    this.setViewportWidth(width);
    this.setViewportHeight(height);
    return this;
};

/**
* Set the rendering mode.
*
* @param mode The rendering mode. Allowed values are default, viewport.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setRenderingMode = function(mode) {
    if (!mode.match(/^(default|viewport)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setRenderingMode", "html-to-pdf", "Allowed values are default, viewport.", "set_rendering_mode"), 470);
    
    this.fields['rendering_mode'] = mode;
    return this;
};

/**
* Specifies the scaling mode used for fitting the HTML contents to the print area.
*
* @param mode The smart scaling mode. Allowed values are default, disabled, viewport-fit, content-fit, single-page-fit, single-page-fit-ex, mode1.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setSmartScalingMode = function(mode) {
    if (!mode.match(/^(default|disabled|viewport-fit|content-fit|single-page-fit|single-page-fit-ex|mode1)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setSmartScalingMode", "html-to-pdf", "Allowed values are default, disabled, viewport-fit, content-fit, single-page-fit, single-page-fit-ex, mode1.", "set_smart_scaling_mode"), 470);
    
    this.fields['smart_scaling_mode'] = mode;
    return this;
};

/**
* Set the scaling factor (zoom) for the main page area.
*
* @param factor The percentage value. The value must be in the range 10-500.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setScaleFactor = function(factor) {
    if (!(parseInt(factor) >= 10 && parseInt(factor) <= 500))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setScaleFactor", "html-to-pdf", "The value must be in the range 10-500.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = factor.toString();
    return this;
};

/**
* Set the quality of embedded JPEG images. A lower quality results in a smaller PDF file but can lead to compression artifacts.
*
* @param quality The percentage value. The value must be in the range 1-100.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setJpegQuality = function(quality) {
    if (!(parseInt(quality) >= 1 && parseInt(quality) <= 100))
        throw new Pdfcrowd.Error(createInvalidValueMessage(quality, "setJpegQuality", "html-to-pdf", "The value must be in the range 1-100.", "set_jpeg_quality"), 470);
    
    this.fields['jpeg_quality'] = quality.toString();
    return this;
};

/**
* Specify which image types will be converted to JPEG. Converting lossless compression image formats (PNG, GIF, ...) to JPEG may result in a smaller PDF file.
*
* @param images The image category. Allowed values are none, opaque, all.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setConvertImagesToJpeg = function(images) {
    if (!images.match(/^(none|opaque|all)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(images, "setConvertImagesToJpeg", "html-to-pdf", "Allowed values are none, opaque, all.", "set_convert_images_to_jpeg"), 470);
    
    this.fields['convert_images_to_jpeg'] = images;
    return this;
};

/**
* Set the DPI of images in PDF. A lower DPI may result in a smaller PDF file.  If the specified DPI is higher than the actual image DPI, the original image DPI is retained (no upscaling is performed). Use <span class='field-value'>0</span> to leave the images unaltered.
*
* @param dpi The DPI value. Must be a positive integer number or 0.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setImageDpi = function(dpi) {
    if (!(parseInt(dpi) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dpi, "setImageDpi", "html-to-pdf", "Must be a positive integer number or 0.", "set_image_dpi"), 470);
    
    this.fields['image_dpi'] = dpi.toString();
    return this;
};

/**
* Convert HTML forms to fillable PDF forms. Details can be found in the <a href='https://pdfcrowd.com/blog/create-fillable-pdf-form/'>blog post</a>.
*
* @param value Set to <span class='field-value'>true</span> to make fillable PDF forms.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setEnablePdfForms = function(value) {
    this.fields['enable_pdf_forms'] = value;
    return this;
};

/**
* Create linearized PDF. This is also known as Fast Web View.
*
* @param value Set to <span class='field-value'>true</span> to create linearized PDF.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setLinearize = function(value) {
    this.fields['linearize'] = value;
    return this;
};

/**
* Encrypt the PDF. This prevents search engines from indexing the contents.
*
* @param value Set to <span class='field-value'>true</span> to enable PDF encryption.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setEncrypt = function(value) {
    this.fields['encrypt'] = value;
    return this;
};

/**
* Protect the PDF with a user password. When a PDF has a user password, it must be supplied in order to view the document and to perform operations allowed by the access permissions.
*
* @param password The user password.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setUserPassword = function(password) {
    this.fields['user_password'] = password;
    return this;
};

/**
* Protect the PDF with an owner password.  Supplying an owner password grants unlimited access to the PDF including changing the passwords and access permissions.
*
* @param password The owner password.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setOwnerPassword = function(password) {
    this.fields['owner_password'] = password;
    return this;
};

/**
* Disallow printing of the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the no-print flag in the output PDF.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoPrint = function(value) {
    this.fields['no_print'] = value;
    return this;
};

/**
* Disallow modification of the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the read-only only flag in the output PDF.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoModify = function(value) {
    this.fields['no_modify'] = value;
    return this;
};

/**
* Disallow text and graphics extraction from the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the no-copy flag in the output PDF.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setNoCopy = function(value) {
    this.fields['no_copy'] = value;
    return this;
};

/**
* Set the title of the PDF.
*
* @param title The title.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
* Set the subject of the PDF.
*
* @param subject The subject.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
* Set the author of the PDF.
*
* @param author The author.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
* Associate keywords with the document.
*
* @param keywords The string with the keywords.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
* Extract meta tags (author, keywords and description) from the input HTML and use them in the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to extract meta tags.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setExtractMetaTags = function(value) {
    this.fields['extract_meta_tags'] = value;
    return this;
};

/**
* Specify the page layout to be used when the document is opened.
*
* @param layout Allowed values are single-page, one-column, two-column-left, two-column-right.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageLayout = function(layout) {
    if (!layout.match(/^(single-page|one-column|two-column-left|two-column-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(layout, "setPageLayout", "html-to-pdf", "Allowed values are single-page, one-column, two-column-left, two-column-right.", "set_page_layout"), 470);
    
    this.fields['page_layout'] = layout;
    return this;
};

/**
* Specify how the document should be displayed when opened.
*
* @param mode Allowed values are full-screen, thumbnails, outlines.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setPageMode = function(mode) {
    if (!mode.match(/^(full-screen|thumbnails|outlines)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageMode", "html-to-pdf", "Allowed values are full-screen, thumbnails, outlines.", "set_page_mode"), 470);
    
    this.fields['page_mode'] = mode;
    return this;
};

/**
* Specify how the page should be displayed when opened.
*
* @param zoomType Allowed values are fit-width, fit-height, fit-page.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setInitialZoomType = function(zoomType) {
    if (!zoomType.match(/^(fit-width|fit-height|fit-page)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoomType, "setInitialZoomType", "html-to-pdf", "Allowed values are fit-width, fit-height, fit-page.", "set_initial_zoom_type"), 470);
    
    this.fields['initial_zoom_type'] = zoomType;
    return this;
};

/**
* Display the specified page when the document is opened.
*
* @param page Must be a positive integer number.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setInitialPage = function(page) {
    if (!(parseInt(page) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(page, "setInitialPage", "html-to-pdf", "Must be a positive integer number.", "set_initial_page"), 470);
    
    this.fields['initial_page'] = page.toString();
    return this;
};

/**
* Specify the initial page zoom in percents when the document is opened.
*
* @param zoom Must be a positive integer number.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setInitialZoom = function(zoom) {
    if (!(parseInt(zoom) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoom, "setInitialZoom", "html-to-pdf", "Must be a positive integer number.", "set_initial_zoom"), 470);
    
    this.fields['initial_zoom'] = zoom.toString();
    return this;
};

/**
* Specify whether to hide the viewer application's tool bars when the document is active.
*
* @param value Set to <span class='field-value'>true</span> to hide tool bars.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHideToolbar = function(value) {
    this.fields['hide_toolbar'] = value;
    return this;
};

/**
* Specify whether to hide the viewer application's menu bar when the document is active.
*
* @param value Set to <span class='field-value'>true</span> to hide the menu bar.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHideMenubar = function(value) {
    this.fields['hide_menubar'] = value;
    return this;
};

/**
* Specify whether to hide user interface elements in the document's window (such as scroll bars and navigation controls), leaving only the document's contents displayed.
*
* @param value Set to <span class='field-value'>true</span> to hide ui elements.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHideWindowUi = function(value) {
    this.fields['hide_window_ui'] = value;
    return this;
};

/**
* Specify whether to resize the document's window to fit the size of the first displayed page.
*
* @param value Set to <span class='field-value'>true</span> to resize the window.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFitWindow = function(value) {
    this.fields['fit_window'] = value;
    return this;
};

/**
* Specify whether to position the document's window in the center of the screen.
*
* @param value Set to <span class='field-value'>true</span> to center the window.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setCenterWindow = function(value) {
    this.fields['center_window'] = value;
    return this;
};

/**
* Specify whether the window's title bar should display the document title. If false , the title bar should instead display the name of the PDF file containing the document.
*
* @param value Set to <span class='field-value'>true</span> to display the title.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDisplayTitle = function(value) {
    this.fields['display_title'] = value;
    return this;
};

/**
* Set the predominant reading order for text to right-to-left. This option has no direct effect on the document's contents or page numbering but can be used to determine the relative positioning of pages when displayed side by side or printed n-up
*
* @param value Set to <span class='field-value'>true</span> to set right-to-left reading order.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setRightToLeft = function(value) {
    this.fields['right_to_left'] = value;
    return this;
};

/**
* Set the input data for template rendering. The data format can be JSON, XML, YAML or CSV.
*
* @param dataString The input data string.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataString = function(dataString) {
    this.fields['data_string'] = dataString;
    return this;
};

/**
* Load the input data for template rendering from the specified file. The data format can be JSON, XML, YAML or CSV.
*
* @param dataFile The file path to a local file containing the input data.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataFile = function(dataFile) {
    this.files['data_file'] = dataFile;
    return this;
};

/**
* Specify the input data format.
*
* @param dataFormat The data format. Allowed values are auto, json, xml, yaml, csv.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataFormat = function(dataFormat) {
    if (!dataFormat.match(/^(auto|json|xml|yaml|csv)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dataFormat, "setDataFormat", "html-to-pdf", "Allowed values are auto, json, xml, yaml, csv.", "set_data_format"), 470);
    
    this.fields['data_format'] = dataFormat;
    return this;
};

/**
* Set the encoding of the data file set by <a href='#set_data_file'>setDataFile</a>.
*
* @param encoding The data file encoding.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataEncoding = function(encoding) {
    this.fields['data_encoding'] = encoding;
    return this;
};

/**
* Ignore undefined variables in the HTML template. The default mode is strict so any undefined variable causes the conversion to fail. You can use <span class='field-value text-nowrap'>&#x007b;&#x0025; if variable is defined &#x0025;&#x007d;</span> to check if the variable is defined.
*
* @param value Set to <span class='field-value'>true</span> to ignore undefined variables.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataIgnoreUndefined = function(value) {
    this.fields['data_ignore_undefined'] = value;
    return this;
};

/**
* Auto escape HTML symbols in the input data before placing them into the output.
*
* @param value Set to <span class='field-value'>true</span> to turn auto escaping on.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataAutoEscape = function(value) {
    this.fields['data_auto_escape'] = value;
    return this;
};

/**
* Auto trim whitespace around each template command block.
*
* @param value Set to <span class='field-value'>true</span> to turn auto trimming on.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataTrimBlocks = function(value) {
    this.fields['data_trim_blocks'] = value;
    return this;
};

/**
* Set the advanced data options:<ul><li><span class='field-value'>csv_delimiter</span> - The CSV data delimiter, the default is <span class='field-value'>,</span>.</li><li><span class='field-value'>xml_remove_root</span> - Remove the root XML element from the input data.</li><li><span class='field-value'>data_root</span> - The name of the root element inserted into the input data without a root node (e.g. CSV), the default is <span class='field-value'>data</span>.</li></ul>
*
* @param options Comma separated list of options.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDataOptions = function(options) {
    this.fields['data_options'] = options;
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
HtmlToPdfClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
HtmlToPdfClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
HtmlToPdfClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
HtmlToPdfClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the number of pages in the output document.
* @return The page count.
*/
HtmlToPdfClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
* Get the total number of pages in the original output document, including the pages excluded by <a href='#set_print_page_range'>setPrintPageRange()</a>.
* @return The total page count.
*/
HtmlToPdfClient.prototype.getTotalPageCount = function() {
    return this.helper.getTotalPageCount();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
HtmlToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
HtmlToPdfClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTP scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "html-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTPS scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "html-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
* A client certificate to authenticate Pdfcrowd converter on your web server. The certificate is used for two-way SSL/TLS authentication and adds extra security.
*
* @param certificate The file must be in PKCS12 format. The file must exist and not be empty.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setClientCertificate = function(certificate) {
    if (!(fs.existsSync(certificate) && fs.statSync(certificate)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(certificate, "setClientCertificate", "html-to-pdf", "The file must exist and not be empty.", "set_client_certificate"), 470);
    
    this.files['client_certificate'] = certificate;
    return this;
};

/**
* A password for PKCS12 file with a client certificate if it is needed.
*
* @param password
* @return The converter object.
*/
HtmlToPdfClient.prototype.setClientCertificatePassword = function(password) {
    this.fields['client_certificate_password'] = password;
    return this;
};

/**
* Set the internal DPI resolution used for positioning of PDF contents. It can help in situations when there are small inaccuracies in the PDF. It is recommended to use values that are a multiple of 72, such as 288 or 360.
*
* @param dpi The DPI value. The value must be in the range of 72-600.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setLayoutDpi = function(dpi) {
    if (!(parseInt(dpi) >= 72 && parseInt(dpi) <= 600))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dpi, "setLayoutDpi", "html-to-pdf", "The value must be in the range of 72-600.", "set_layout_dpi"), 470);
    
    this.fields['layout_dpi'] = dpi.toString();
    return this;
};

/**
* A 2D transformation matrix applied to the main contents on each page. The origin [0,0] is located at the top-left corner of the contents. The resolution is 72 dpi.
*
* @param matrix A comma separated string of matrix elements: "scaleX,skewX,transX,skewY,scaleY,transY"
* @return The converter object.
*/
HtmlToPdfClient.prototype.setContentsMatrix = function(matrix) {
    this.fields['contents_matrix'] = matrix;
    return this;
};

/**
* A 2D transformation matrix applied to the page header contents. The origin [0,0] is located at the top-left corner of the header. The resolution is 72 dpi.
*
* @param matrix A comma separated string of matrix elements: "scaleX,skewX,transX,skewY,scaleY,transY"
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHeaderMatrix = function(matrix) {
    this.fields['header_matrix'] = matrix;
    return this;
};

/**
* A 2D transformation matrix applied to the page footer contents. The origin [0,0] is located at the top-left corner of the footer. The resolution is 72 dpi.
*
* @param matrix A comma separated string of matrix elements: "scaleX,skewX,transX,skewY,scaleY,transY"
* @return The converter object.
*/
HtmlToPdfClient.prototype.setFooterMatrix = function(matrix) {
    this.fields['footer_matrix'] = matrix;
    return this;
};

/**
* Disable automatic height adjustment that compensates for pixel to point rounding errors.
*
* @param value Set to <span class='field-value'>true</span> to disable automatic height scale.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setDisablePageHeightOptimization = function(value) {
    this.fields['disable_page_height_optimization'] = value;
    return this;
};

/**
* Add special CSS classes to the main document's body element. This allows applying custom styling based on these classes:
  <ul>
    <li><span class='field-value'>pdfcrowd-page-X</span> - where X is the current page number</li>
    <li><span class='field-value'>pdfcrowd-page-odd</span> - odd page</li>
    <li><span class='field-value'>pdfcrowd-page-even</span> - even page</li>
  </ul>
* Warning: If your custom styling affects the contents area size (e.g. by using different margins, padding, border width), the resulting PDF may contain duplicit contents or some contents may be missing.
*
* @param value Set to <span class='field-value'>true</span> to add the special CSS classes.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setMainDocumentCssAnnotation = function(value) {
    this.fields['main_document_css_annotation'] = value;
    return this;
};

/**
* Add special CSS classes to the header/footer's body element. This allows applying custom styling based on these classes:
  <ul>
    <li><span class='field-value'>pdfcrowd-page-X</span> - where X is the current page number</li>
    <li><span class='field-value'>pdfcrowd-page-count-X</span> - where X is the total page count</li>
    <li><span class='field-value'>pdfcrowd-page-first</span> - the first page</li>
    <li><span class='field-value'>pdfcrowd-page-last</span> - the last page</li>
    <li><span class='field-value'>pdfcrowd-page-odd</span> - odd page</li>
    <li><span class='field-value'>pdfcrowd-page-even</span> - even page</li>
  </ul>
*
* @param value Set to <span class='field-value'>true</span> to add the special CSS classes.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setHeaderFooterCssAnnotation = function(value) {
    this.fields['header_footer_css_annotation'] = value;
    return this;
};

/**
* Set the converter version. Different versions may produce different output. Choose which one provides the best output for your case.
*
* @param version The version identifier. Allowed values are latest, 20.10, 18.10.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(latest|20.10|18.10)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "html-to-pdf", "Allowed values are latest, 20.10, 18.10.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
HtmlToPdfClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
* Conversion from HTML to image.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function HtmlToImageClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'html',
        'output_format': 'png'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* The format of the output file.
*
* @param outputFormat Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.
* @return The converter object.
*/
HtmlToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "setOutputFormat", "html-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
    return this;
};

/**
* Convert a web page.
*
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "html-to-image", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a web page and write the result to a local file.
*
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "html-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
*
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "html-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
*
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "html-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert a string.
*
* @param text The string content to convert. The string must not be empty.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToImageClient.prototype.convertString = function(text, callbacks) {
    if (!(text))
        return callbacks.error(createInvalidValueMessage(text, "convertString", "html-to-image", "The string must not be empty.", "convert_string"), 470);
    
    this.fields['text'] = text;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a string and write the output to a file.
*
* @param text The string content to convert. The string must not be empty.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToImageClient.prototype.convertStringToFile = function(text, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStringToFile::file_path", "html-to-image", "The string must not be empty.", "convert_string_to_file"), 470);
    
    this.convertString(text, saveToFile(filePath, callback));
};

/**
* Convert the contents of an input stream.
*
* @param inStream The input stream with source data.<br> The stream can contain either HTML code or an archive (.zip, .tar.gz, .tar.bz2).<br>The archive can contain HTML code and its external assets (images, style sheets, javascript).
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
HtmlToImageClient.prototype.convertStream = function(inStream, callbacks) {
    var data = '';
    var that = this;
    inStream.on('error', function(err) {
        callbacks.error(err, CLIENT_ERROR);
    });
    inStream.on('data', function(chunk) {
        data += chunk;
    });
    inStream.on('end', function() {
        that.rawData['stream'] = data;
        return that.helper.post(that.fields, that.files, that.rawData, callbacks);
    });
};

/**
* Convert the contents of an input stream and write the result to a local file.
*
* @param inStream The input stream with source data.<br> The stream can contain either HTML code or an archive (.zip, .tar.gz, .tar.bz2).<br>The archive can contain HTML code and its external assets (images, style sheets, javascript).
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
HtmlToImageClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "html-to-image", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
* Set the file name of the main HTML document stored in the input archive. If not specified, the first HTML file in the archive is used for conversion. Use this method if the input archive contains multiple HTML documents.
*
* @param filename The file name.
* @return The converter object.
*/
HtmlToImageClient.prototype.setZipMainFilename = function(filename) {
    this.fields['zip_main_filename'] = filename;
    return this;
};

/**
* Use the print version of the page if available (@media print).
*
* @param value Set to <span class='field-value'>true</span> to use the print version of the page.
* @return The converter object.
*/
HtmlToImageClient.prototype.setUsePrintMedia = function(value) {
    this.fields['use_print_media'] = value;
    return this;
};

/**
* Do not print the background graphics.
*
* @param value Set to <span class='field-value'>true</span> to disable the background graphics.
* @return The converter object.
*/
HtmlToImageClient.prototype.setNoBackground = function(value) {
    this.fields['no_background'] = value;
    return this;
};

/**
* Do not execute JavaScript.
*
* @param value Set to <span class='field-value'>true</span> to disable JavaScript in web pages.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDisableJavascript = function(value) {
    this.fields['disable_javascript'] = value;
    return this;
};

/**
* Do not load images.
*
* @param value Set to <span class='field-value'>true</span> to disable loading of images.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDisableImageLoading = function(value) {
    this.fields['disable_image_loading'] = value;
    return this;
};

/**
* Disable loading fonts from remote sources.
*
* @param value Set to <span class='field-value'>true</span> disable loading remote fonts.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDisableRemoteFonts = function(value) {
    this.fields['disable_remote_fonts'] = value;
    return this;
};

/**
* Use a mobile user agent.
*
* @param value Set to <span class='field-value'>true</span> to use a mobile user agent.
* @return The converter object.
*/
HtmlToImageClient.prototype.setUseMobileUserAgent = function(value) {
    this.fields['use_mobile_user_agent'] = value;
    return this;
};

/**
* Specifies how iframes are handled.
*
* @param iframes Allowed values are all, same-origin, none.
* @return The converter object.
*/
HtmlToImageClient.prototype.setLoadIframes = function(iframes) {
    if (!iframes.match(/^(all|same-origin|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(iframes, "setLoadIframes", "html-to-image", "Allowed values are all, same-origin, none.", "set_load_iframes"), 470);
    
    this.fields['load_iframes'] = iframes;
    return this;
};

/**
* Try to block ads. Enabling this option can produce smaller output and speed up the conversion.
*
* @param value Set to <span class='field-value'>true</span> to block ads in web pages.
* @return The converter object.
*/
HtmlToImageClient.prototype.setBlockAds = function(value) {
    this.fields['block_ads'] = value;
    return this;
};

/**
* Set the default HTML content text encoding.
*
* @param encoding The text encoding of the HTML content.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDefaultEncoding = function(encoding) {
    this.fields['default_encoding'] = encoding;
    return this;
};

/**
* Set the locale for the conversion. This may affect the output format of dates, times and numbers.
*
* @param locale The locale code according to ISO 639.
* @return The converter object.
*/
HtmlToImageClient.prototype.setLocale = function(locale) {
    this.fields['locale'] = locale;
    return this;
};

/**
* Set the HTTP authentication user name.
*
* @param userName The user name.
* @return The converter object.
*/
HtmlToImageClient.prototype.setHttpAuthUserName = function(userName) {
    this.fields['http_auth_user_name'] = userName;
    return this;
};

/**
* Set the HTTP authentication password.
*
* @param password The password.
* @return The converter object.
*/
HtmlToImageClient.prototype.setHttpAuthPassword = function(password) {
    this.fields['http_auth_password'] = password;
    return this;
};

/**
* Set credentials to access HTTP base authentication protected websites.
*
* @param userName Set the HTTP authentication user name.
* @param password Set the HTTP authentication password.
* @return The converter object.
*/
HtmlToImageClient.prototype.setHttpAuth = function(userName, password) {
    this.setHttpAuthUserName(userName);
    this.setHttpAuthPassword(password);
    return this;
};

/**
* Set cookies that are sent in Pdfcrowd HTTP requests.
*
* @param cookies The cookie string.
* @return The converter object.
*/
HtmlToImageClient.prototype.setCookies = function(cookies) {
    this.fields['cookies'] = cookies;
    return this;
};

/**
* Do not allow insecure HTTPS connections.
*
* @param value Set to <span class='field-value'>true</span> to enable SSL certificate verification.
* @return The converter object.
*/
HtmlToImageClient.prototype.setVerifySslCertificates = function(value) {
    this.fields['verify_ssl_certificates'] = value;
    return this;
};

/**
* Abort the conversion if the main URL HTTP status code is greater than or equal to 400.
*
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
* @return The converter object.
*/
HtmlToImageClient.prototype.setFailOnMainUrlError = function(failOnError) {
    this.fields['fail_on_main_url_error'] = failOnError;
    return this;
};

/**
* Abort the conversion if any of the sub-request HTTP status code is greater than or equal to 400 or if some sub-requests are still pending. See details in a debug log.
*
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
* @return The converter object.
*/
HtmlToImageClient.prototype.setFailOnAnyUrlError = function(failOnError) {
    this.fields['fail_on_any_url_error'] = failOnError;
    return this;
};

/**
* Do not send the X-Pdfcrowd HTTP header in Pdfcrowd HTTP requests.
*
* @param value Set to <span class='field-value'>true</span> to disable sending X-Pdfcrowd HTTP header.
* @return The converter object.
*/
HtmlToImageClient.prototype.setNoXpdfcrowdHeader = function(value) {
    this.fields['no_xpdfcrowd_header'] = value;
    return this;
};

/**
* Apply custom CSS to the input HTML document. It allows you to modify the visual appearance and layout of your HTML content dynamically. Tip: Using <span class='field-value'>!important</span> in custom CSS provides a way to prioritize and override conflicting styles.
*
* @param css A string containing valid CSS. The string must not be empty.
* @return The converter object.
*/
HtmlToImageClient.prototype.setCustomCss = function(css) {
    if (!(css))
        throw new Pdfcrowd.Error(createInvalidValueMessage(css, "setCustomCss", "html-to-image", "The string must not be empty.", "set_custom_css"), 470);
    
    this.fields['custom_css'] = css;
    return this;
};

/**
* Run a custom JavaScript after the document is loaded and ready to print. The script is intended for post-load DOM manipulation (add/remove elements, update CSS, ...). In addition to the standard browser APIs, the custom JavaScript code can use helper functions from our <a href='/api/libpdfcrowd/'>JavaScript library</a>.
*
* @param javascript A string containing a JavaScript code. The string must not be empty.
* @return The converter object.
*/
HtmlToImageClient.prototype.setCustomJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setCustomJavascript", "html-to-image", "The string must not be empty.", "set_custom_javascript"), 470);
    
    this.fields['custom_javascript'] = javascript;
    return this;
};

/**
* Run a custom JavaScript right after the document is loaded. The script is intended for early DOM manipulation (add/remove elements, update CSS, ...). In addition to the standard browser APIs, the custom JavaScript code can use helper functions from our <a href='/api/libpdfcrowd/'>JavaScript library</a>.
*
* @param javascript A string containing a JavaScript code. The string must not be empty.
* @return The converter object.
*/
HtmlToImageClient.prototype.setOnLoadJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setOnLoadJavascript", "html-to-image", "The string must not be empty.", "set_on_load_javascript"), 470);
    
    this.fields['on_load_javascript'] = javascript;
    return this;
};

/**
* Set a custom HTTP header that is sent in Pdfcrowd HTTP requests.
*
* @param header A string containing the header name and value separated by a colon.
* @return The converter object.
*/
HtmlToImageClient.prototype.setCustomHttpHeader = function(header) {
    if (!header.match(/^.+:.+$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(header, "setCustomHttpHeader", "html-to-image", "A string containing the header name and value separated by a colon.", "set_custom_http_header"), 470);
    
    this.fields['custom_http_header'] = header;
    return this;
};

/**
* Wait the specified number of milliseconds to finish all JavaScript after the document is loaded. Your API license defines the maximum wait time by "Max Delay" parameter.
*
* @param delay The number of milliseconds to wait. Must be a positive integer number or 0.
* @return The converter object.
*/
HtmlToImageClient.prototype.setJavascriptDelay = function(delay) {
    if (!(parseInt(delay) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(delay, "setJavascriptDelay", "html-to-image", "Must be a positive integer number or 0.", "set_javascript_delay"), 470);
    
    this.fields['javascript_delay'] = delay.toString();
    return this;
};

/**
* Convert only the specified element from the main document and its children. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. If the element is not found, the conversion fails. If multiple elements are found, the first one is used.
*
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
* @return The converter object.
*/
HtmlToImageClient.prototype.setElementToConvert = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setElementToConvert", "html-to-image", "The string must not be empty.", "set_element_to_convert"), 470);
    
    this.fields['element_to_convert'] = selectors;
    return this;
};

/**
* Specify the DOM handling when only a part of the document is converted. This can affect the CSS rules used.
*
* @param mode Allowed values are cut-out, remove-siblings, hide-siblings.
* @return The converter object.
*/
HtmlToImageClient.prototype.setElementToConvertMode = function(mode) {
    if (!mode.match(/^(cut-out|remove-siblings|hide-siblings)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setElementToConvertMode", "html-to-image", "Allowed values are cut-out, remove-siblings, hide-siblings.", "set_element_to_convert_mode"), 470);
    
    this.fields['element_to_convert_mode'] = mode;
    return this;
};

/**
* Wait for the specified element in a source document. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. The element is searched for in the main document and all iframes. If the element is not found, the conversion fails. Your API license defines the maximum wait time by "Max Delay" parameter.
*
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
* @return The converter object.
*/
HtmlToImageClient.prototype.setWaitForElement = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setWaitForElement", "html-to-image", "The string must not be empty.", "set_wait_for_element"), 470);
    
    this.fields['wait_for_element'] = selectors;
    return this;
};

/**
* The main HTML element for conversion is detected automatically.
*
* @param value Set to <span class='field-value'>true</span> to detect the main element.
* @return The converter object.
*/
HtmlToImageClient.prototype.setAutoDetectElementToConvert = function(value) {
    this.fields['auto_detect_element_to_convert'] = value;
    return this;
};

/**
* The input HTML is automatically enhanced to improve the readability.
*
* @param enhancements Allowed values are none, readability-v1, readability-v2, readability-v3, readability-v4.
* @return The converter object.
*/
HtmlToImageClient.prototype.setReadabilityEnhancements = function(enhancements) {
    if (!enhancements.match(/^(none|readability-v1|readability-v2|readability-v3|readability-v4)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(enhancements, "setReadabilityEnhancements", "html-to-image", "Allowed values are none, readability-v1, readability-v2, readability-v3, readability-v4.", "set_readability_enhancements"), 470);
    
    this.fields['readability_enhancements'] = enhancements;
    return this;
};

/**
* Set the output image width in pixels.
*
* @param width The value must be in the range 96-65000.
* @return The converter object.
*/
HtmlToImageClient.prototype.setScreenshotWidth = function(width) {
    if (!(parseInt(width) >= 96 && parseInt(width) <= 65000))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setScreenshotWidth", "html-to-image", "The value must be in the range 96-65000.", "set_screenshot_width"), 470);
    
    this.fields['screenshot_width'] = width.toString();
    return this;
};

/**
* Set the output image height in pixels. If it is not specified, actual document height is used.
*
* @param height Must be a positive integer number.
* @return The converter object.
*/
HtmlToImageClient.prototype.setScreenshotHeight = function(height) {
    if (!(parseInt(height) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setScreenshotHeight", "html-to-image", "Must be a positive integer number.", "set_screenshot_height"), 470);
    
    this.fields['screenshot_height'] = height.toString();
    return this;
};

/**
* Set the scaling factor (zoom) for the output image.
*
* @param factor The percentage value. Must be a positive integer number.
* @return The converter object.
*/
HtmlToImageClient.prototype.setScaleFactor = function(factor) {
    if (!(parseInt(factor) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setScaleFactor", "html-to-image", "Must be a positive integer number.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = factor.toString();
    return this;
};

/**
* The output image background color.
*
* @param color The value must be in RRGGBB or RRGGBBAA hexadecimal format.
* @return The converter object.
*/
HtmlToImageClient.prototype.setBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setBackgroundColor", "html-to-image", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_background_color"), 470);
    
    this.fields['background_color'] = color;
    return this;
};

/**
* Set the input data for template rendering. The data format can be JSON, XML, YAML or CSV.
*
* @param dataString The input data string.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataString = function(dataString) {
    this.fields['data_string'] = dataString;
    return this;
};

/**
* Load the input data for template rendering from the specified file. The data format can be JSON, XML, YAML or CSV.
*
* @param dataFile The file path to a local file containing the input data.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataFile = function(dataFile) {
    this.files['data_file'] = dataFile;
    return this;
};

/**
* Specify the input data format.
*
* @param dataFormat The data format. Allowed values are auto, json, xml, yaml, csv.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataFormat = function(dataFormat) {
    if (!dataFormat.match(/^(auto|json|xml|yaml|csv)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dataFormat, "setDataFormat", "html-to-image", "Allowed values are auto, json, xml, yaml, csv.", "set_data_format"), 470);
    
    this.fields['data_format'] = dataFormat;
    return this;
};

/**
* Set the encoding of the data file set by <a href='#set_data_file'>setDataFile</a>.
*
* @param encoding The data file encoding.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataEncoding = function(encoding) {
    this.fields['data_encoding'] = encoding;
    return this;
};

/**
* Ignore undefined variables in the HTML template. The default mode is strict so any undefined variable causes the conversion to fail. You can use <span class='field-value text-nowrap'>&#x007b;&#x0025; if variable is defined &#x0025;&#x007d;</span> to check if the variable is defined.
*
* @param value Set to <span class='field-value'>true</span> to ignore undefined variables.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataIgnoreUndefined = function(value) {
    this.fields['data_ignore_undefined'] = value;
    return this;
};

/**
* Auto escape HTML symbols in the input data before placing them into the output.
*
* @param value Set to <span class='field-value'>true</span> to turn auto escaping on.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataAutoEscape = function(value) {
    this.fields['data_auto_escape'] = value;
    return this;
};

/**
* Auto trim whitespace around each template command block.
*
* @param value Set to <span class='field-value'>true</span> to turn auto trimming on.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataTrimBlocks = function(value) {
    this.fields['data_trim_blocks'] = value;
    return this;
};

/**
* Set the advanced data options:<ul><li><span class='field-value'>csv_delimiter</span> - The CSV data delimiter, the default is <span class='field-value'>,</span>.</li><li><span class='field-value'>xml_remove_root</span> - Remove the root XML element from the input data.</li><li><span class='field-value'>data_root</span> - The name of the root element inserted into the input data without a root node (e.g. CSV), the default is <span class='field-value'>data</span>.</li></ul>
*
* @param options Comma separated list of options.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDataOptions = function(options) {
    this.fields['data_options'] = options;
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
HtmlToImageClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
HtmlToImageClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
HtmlToImageClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
HtmlToImageClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
HtmlToImageClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
HtmlToImageClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
HtmlToImageClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
HtmlToImageClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTP scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
HtmlToImageClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "html-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTPS scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
HtmlToImageClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "html-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
* A client certificate to authenticate Pdfcrowd converter on your web server. The certificate is used for two-way SSL/TLS authentication and adds extra security.
*
* @param certificate The file must be in PKCS12 format. The file must exist and not be empty.
* @return The converter object.
*/
HtmlToImageClient.prototype.setClientCertificate = function(certificate) {
    if (!(fs.existsSync(certificate) && fs.statSync(certificate)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(certificate, "setClientCertificate", "html-to-image", "The file must exist and not be empty.", "set_client_certificate"), 470);
    
    this.files['client_certificate'] = certificate;
    return this;
};

/**
* A password for PKCS12 file with a client certificate if it is needed.
*
* @param password
* @return The converter object.
*/
HtmlToImageClient.prototype.setClientCertificatePassword = function(password) {
    this.fields['client_certificate_password'] = password;
    return this;
};

/**
* Set the converter version. Different versions may produce different output. Choose which one provides the best output for your case.
*
* @param version The version identifier. Allowed values are latest, 20.10, 18.10.
* @return The converter object.
*/
HtmlToImageClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(latest|20.10|18.10)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "html-to-image", "Allowed values are latest, 20.10, 18.10.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
HtmlToImageClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
HtmlToImageClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
HtmlToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
HtmlToImageClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
* Conversion from one image format to another image format.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function ImageToImageClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'image',
        'output_format': 'png'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* Convert an image.
*
* @param url The address of the image to convert. The supported protocols are http:// and https://.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "image-to-image", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert an image and write the result to a local file.
*
* @param url The address of the image to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "image-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "image-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "image-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert raw data.
*
* @param data The raw content to be converted.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToImageClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert raw data to a file.
*
* @param data The raw content to be converted.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToImageClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "image-to-image", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
* Convert the contents of an input stream.
*
* @param inStream The input stream with source data.<br>
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendImageInHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToImageClient.prototype.convertStream = function(inStream, callbacks) {
    var data = '';
    var that = this;
    inStream.on('error', function(err) {
        callbacks.error(err, CLIENT_ERROR);
    });
    inStream.on('data', function(chunk) {
        data += chunk;
    });
    inStream.on('end', function() {
        that.rawData['stream'] = data;
        return that.helper.post(that.fields, that.files, that.rawData, callbacks);
    });
};

/**
* Convert the contents of an input stream and write the result to a local file.
*
* @param inStream The input stream with source data.<br>
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToImageClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "image-to-image", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
* The format of the output file.
*
* @param outputFormat Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.
* @return The converter object.
*/
ImageToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "setOutputFormat", "image-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
    return this;
};

/**
* Resize the image.
*
* @param resize The resize percentage or new image dimensions.
* @return The converter object.
*/
ImageToImageClient.prototype.setResize = function(resize) {
    this.fields['resize'] = resize;
    return this;
};

/**
* Rotate the image.
*
* @param rotate The rotation specified in degrees.
* @return The converter object.
*/
ImageToImageClient.prototype.setRotate = function(rotate) {
    this.fields['rotate'] = rotate;
    return this;
};

/**
* Set the top left X coordinate of the content area. It is relative to the top left X coordinate of the print area.
*
* @param x The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCropAreaX = function(x) {
    if (!x.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x;
    return this;
};

/**
* Set the top left Y coordinate of the content area. It is relative to the top left Y coordinate of the print area.
*
* @param y The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCropAreaY = function(y) {
    if (!y.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y;
    return this;
};

/**
* Set the width of the content area. It should be at least 1 inch.
*
* @param width The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCropAreaWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width;
    return this;
};

/**
* Set the height of the content area. It should be at least 1 inch.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCropAreaHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height;
    return this;
};

/**
* Set the content area position and size. The content area enables to specify the part to be converted.
*
* @param x Set the top left X coordinate of the content area. It is relative to the top left X coordinate of the print area. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param y Set the top left Y coordinate of the content area. It is relative to the top left Y coordinate of the print area. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param width Set the width of the content area. It should be at least 1 inch. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param height Set the height of the content area. It should be at least 1 inch. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
* Remove borders of an image which does not change in color.
*
* @param value Set to <span class='field-value'>true</span> to remove borders.
* @return The converter object.
*/
ImageToImageClient.prototype.setRemoveBorders = function(value) {
    this.fields['remove_borders'] = value;
    return this;
};

/**
* Set the output canvas size.
*
* @param size Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.
* @return The converter object.
*/
ImageToImageClient.prototype.setCanvasSize = function(size) {
    if (!size.match(/^(A0|A1|A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(size, "setCanvasSize", "image-to-image", "Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.", "set_canvas_size"), 470);
    
    this.fields['canvas_size'] = size;
    return this;
};

/**
* Set the output canvas width.
*
* @param width The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCanvasWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCanvasWidth", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_canvas_width"), 470);
    
    this.fields['canvas_width'] = width;
    return this;
};

/**
* Set the output canvas height.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCanvasHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCanvasHeight", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_canvas_height"), 470);
    
    this.fields['canvas_height'] = height;
    return this;
};

/**
* Set the output canvas dimensions. If no canvas size is specified, margins are applied as a border around the image.
*
* @param width Set the output canvas width. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param height Set the output canvas height. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setCanvasDimensions = function(width, height) {
    this.setCanvasWidth(width);
    this.setCanvasHeight(height);
    return this;
};

/**
* Set the output canvas orientation.
*
* @param orientation Allowed values are landscape, portrait.
* @return The converter object.
*/
ImageToImageClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "setOrientation", "image-to-image", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
    return this;
};

/**
* Set the image position on the canvas.
*
* @param position Allowed values are center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right.
* @return The converter object.
*/
ImageToImageClient.prototype.setPosition = function(position) {
    if (!position.match(/^(center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(position, "setPosition", "image-to-image", "Allowed values are center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right.", "set_position"), 470);
    
    this.fields['position'] = position;
    return this;
};

/**
* Set the mode to print the image on the canvas.
*
* @param mode Allowed values are default, fit, stretch.
* @return The converter object.
*/
ImageToImageClient.prototype.setPrintCanvasMode = function(mode) {
    if (!mode.match(/^(default|fit|stretch)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPrintCanvasMode", "image-to-image", "Allowed values are default, fit, stretch.", "set_print_canvas_mode"), 470);
    
    this.fields['print_canvas_mode'] = mode;
    return this;
};

/**
* Set the output canvas top margin.
*
* @param top The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setMarginTop = function(top) {
    if (!top.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(top, "setMarginTop", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_top"), 470);
    
    this.fields['margin_top'] = top;
    return this;
};

/**
* Set the output canvas right margin.
*
* @param right The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setMarginRight = function(right) {
    if (!right.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(right, "setMarginRight", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_right"), 470);
    
    this.fields['margin_right'] = right;
    return this;
};

/**
* Set the output canvas bottom margin.
*
* @param bottom The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setMarginBottom = function(bottom) {
    if (!bottom.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(bottom, "setMarginBottom", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = bottom;
    return this;
};

/**
* Set the output canvas left margin.
*
* @param left The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setMarginLeft = function(left) {
    if (!left.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(left, "setMarginLeft", "image-to-image", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_left"), 470);
    
    this.fields['margin_left'] = left;
    return this;
};

/**
* Set the output canvas margins.
*
* @param top Set the output canvas top margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param right Set the output canvas right margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param bottom Set the output canvas bottom margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param left Set the output canvas left margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToImageClient.prototype.setMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
    return this;
};

/**
* The canvas background color in RGB or RGBA hexadecimal format. The color fills the entire canvas regardless of margins. If no canvas size is specified and the image format supports background (e.g. PDF, PNG), the background color is applied too.
*
* @param color The value must be in RRGGBB or RRGGBBAA hexadecimal format.
* @return The converter object.
*/
ImageToImageClient.prototype.setCanvasBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setCanvasBackgroundColor", "image-to-image", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_canvas_background_color"), 470);
    
    this.fields['canvas_background_color'] = color;
    return this;
};

/**
* Set the DPI resolution of the input image. The DPI affects margin options specified in points too (e.g. 1 point is equal to 1 pixel in 96 DPI).
*
* @param dpi The DPI value.
* @return The converter object.
*/
ImageToImageClient.prototype.setDpi = function(dpi) {
    this.fields['dpi'] = dpi.toString();
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
ImageToImageClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
ImageToImageClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
ImageToImageClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
ImageToImageClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
ImageToImageClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
ImageToImageClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
ImageToImageClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
ImageToImageClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTP scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
ImageToImageClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "image-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTPS scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
ImageToImageClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "image-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
* Set the converter version. Different versions may produce different output. Choose which one provides the best output for your case.
*
* @param version The version identifier. Allowed values are latest, 20.10, 18.10.
* @return The converter object.
*/
ImageToImageClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(latest|20.10|18.10)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "image-to-image", "Allowed values are latest, 20.10, 18.10.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
ImageToImageClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
ImageToImageClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
ImageToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
ImageToImageClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
* Conversion from PDF to PDF.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function PdfToPdfClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'pdf',
        'output_format': 'pdf'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* Specifies the action to be performed on the input PDFs.
*
* @param action Allowed values are join, shuffle, extract, delete.
* @return The converter object.
*/
PdfToPdfClient.prototype.setAction = function(action) {
    if (!action.match(/^(join|shuffle|extract|delete)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(action, "setAction", "pdf-to-pdf", "Allowed values are join, shuffle, extract, delete.", "set_action"), 470);
    
    this.fields['action'] = action;
    return this;
};

/**
* Perform an action on the input files.
*
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToPdfClient.prototype.convert = function(callbacks) {
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Perform an action on the input files and write the output PDF to a file.
*
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToPdfClient.prototype.convertToFile = function(filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertToFile", "pdf-to-pdf", "The string must not be empty.", "convert_to_file"), 470);
    
    this.convert(saveToFile(filePath, callback));
};

/**
* Add a PDF file to the list of the input PDFs.
*
* @param filePath The file path to a local PDF file. The file must exist and not be empty.
* @return The converter object.
*/
PdfToPdfClient.prototype.addPdfFile = function(filePath) {
    if (!(fs.existsSync(filePath) && fs.statSync(filePath)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "addPdfFile", "pdf-to-pdf", "The file must exist and not be empty.", "add_pdf_file"), 470);
    
    this.files['f_' + this.fileId] = filePath;
    this.fileId++;
    return this;
};

/**
* Add in-memory raw PDF data to the list of the input PDFs.<br>Typical usage is for adding PDF created by another Pdfcrowd converter.<br><br> Example in PHP:<br> <b>$clientPdf2Pdf</b>-&gt;addPdfRawData(<b>$clientHtml2Pdf</b>-&gt;convertUrl('http://www.example.com'));
*
* @param data The raw PDF data. The input data must be PDF content.
* @return The converter object.
*/
PdfToPdfClient.prototype.addPdfRawData = function(data) {
    if (!(data && data.length > 300 && data.slice(0, 4) == '%PDF'))
        throw new Pdfcrowd.Error(createInvalidValueMessage("raw PDF data", "addPdfRawData", "pdf-to-pdf", "The input data must be PDF content.", "add_pdf_raw_data"), 470);
    
    this.rawData['f_' + this.fileId] = data;
    this.fileId++;
    return this;
};

/**
* Password to open the encrypted PDF file.
*
* @param password The input PDF password.
* @return The converter object.
*/
PdfToPdfClient.prototype.setInputPdfPassword = function(password) {
    this.fields['input_pdf_password'] = password;
    return this;
};

/**
* Set the page range for <span class='field-value'>extract</span> or <span class='field-value'>delete</span> action.
*
* @param pages A comma separated list of page numbers or ranges.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPageRange", "pdf-to-pdf", "A comma separated list of page numbers or ranges.", "set_page_range"), 470);
    
    this.fields['page_range'] = pages;
    return this;
};

/**
* Apply a watermark to each page of the output PDF file. A watermark can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the watermark.
*
* @param watermark The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setPageWatermark", "pdf-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = watermark;
    return this;
};

/**
* Load a file from the specified URL and apply the file as a watermark to each page of the output PDF. A watermark can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the watermark.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageWatermarkUrl", "pdf-to-pdf", "The supported protocols are http:// and https://.", "set_page_watermark_url"), 470);
    
    this.fields['page_watermark_url'] = url;
    return this;
};

/**
* Apply each page of a watermark to the corresponding page of the output PDF. A watermark can be either a PDF or an image.
*
* @param watermark The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
PdfToPdfClient.prototype.setMultipageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setMultipageWatermark", "pdf-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = watermark;
    return this;
};

/**
* Load a file from the specified URL and apply each page of the file as a watermark to the corresponding page of the output PDF. A watermark can be either a PDF or an image.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
PdfToPdfClient.prototype.setMultipageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageWatermarkUrl", "pdf-to-pdf", "The supported protocols are http:// and https://.", "set_multipage_watermark_url"), 470);
    
    this.fields['multipage_watermark_url'] = url;
    return this;
};

/**
* Apply a background to each page of the output PDF file. A background can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the background.
*
* @param background The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setPageBackground", "pdf-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = background;
    return this;
};

/**
* Load a file from the specified URL and apply the file as a background to each page of the output PDF. A background can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the background.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageBackgroundUrl", "pdf-to-pdf", "The supported protocols are http:// and https://.", "set_page_background_url"), 470);
    
    this.fields['page_background_url'] = url;
    return this;
};

/**
* Apply each page of a background to the corresponding page of the output PDF. A background can be either a PDF or an image.
*
* @param background The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
PdfToPdfClient.prototype.setMultipageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setMultipageBackground", "pdf-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = background;
    return this;
};

/**
* Load a file from the specified URL and apply each page of the file as a background to the corresponding page of the output PDF. A background can be either a PDF or an image.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
PdfToPdfClient.prototype.setMultipageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageBackgroundUrl", "pdf-to-pdf", "The supported protocols are http:// and https://.", "set_multipage_background_url"), 470);
    
    this.fields['multipage_background_url'] = url;
    return this;
};

/**
* Create linearized PDF. This is also known as Fast Web View.
*
* @param value Set to <span class='field-value'>true</span> to create linearized PDF.
* @return The converter object.
*/
PdfToPdfClient.prototype.setLinearize = function(value) {
    this.fields['linearize'] = value;
    return this;
};

/**
* Encrypt the PDF. This prevents search engines from indexing the contents.
*
* @param value Set to <span class='field-value'>true</span> to enable PDF encryption.
* @return The converter object.
*/
PdfToPdfClient.prototype.setEncrypt = function(value) {
    this.fields['encrypt'] = value;
    return this;
};

/**
* Protect the PDF with a user password. When a PDF has a user password, it must be supplied in order to view the document and to perform operations allowed by the access permissions.
*
* @param password The user password.
* @return The converter object.
*/
PdfToPdfClient.prototype.setUserPassword = function(password) {
    this.fields['user_password'] = password;
    return this;
};

/**
* Protect the PDF with an owner password.  Supplying an owner password grants unlimited access to the PDF including changing the passwords and access permissions.
*
* @param password The owner password.
* @return The converter object.
*/
PdfToPdfClient.prototype.setOwnerPassword = function(password) {
    this.fields['owner_password'] = password;
    return this;
};

/**
* Disallow printing of the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the no-print flag in the output PDF.
* @return The converter object.
*/
PdfToPdfClient.prototype.setNoPrint = function(value) {
    this.fields['no_print'] = value;
    return this;
};

/**
* Disallow modification of the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the read-only only flag in the output PDF.
* @return The converter object.
*/
PdfToPdfClient.prototype.setNoModify = function(value) {
    this.fields['no_modify'] = value;
    return this;
};

/**
* Disallow text and graphics extraction from the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the no-copy flag in the output PDF.
* @return The converter object.
*/
PdfToPdfClient.prototype.setNoCopy = function(value) {
    this.fields['no_copy'] = value;
    return this;
};

/**
* Set the title of the PDF.
*
* @param title The title.
* @return The converter object.
*/
PdfToPdfClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
* Set the subject of the PDF.
*
* @param subject The subject.
* @return The converter object.
*/
PdfToPdfClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
* Set the author of the PDF.
*
* @param author The author.
* @return The converter object.
*/
PdfToPdfClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
* Associate keywords with the document.
*
* @param keywords The string with the keywords.
* @return The converter object.
*/
PdfToPdfClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
* Use metadata (title, subject, author and keywords) from the n-th input PDF.
*
* @param index Set the index of the input PDF file from which to use the metadata. 0 means no metadata. Must be a positive integer number or 0.
* @return The converter object.
*/
PdfToPdfClient.prototype.setUseMetadataFrom = function(index) {
    if (!(parseInt(index) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(index, "setUseMetadataFrom", "pdf-to-pdf", "Must be a positive integer number or 0.", "set_use_metadata_from"), 470);
    
    this.fields['use_metadata_from'] = index.toString();
    return this;
};

/**
* Specify the page layout to be used when the document is opened.
*
* @param layout Allowed values are single-page, one-column, two-column-left, two-column-right.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageLayout = function(layout) {
    if (!layout.match(/^(single-page|one-column|two-column-left|two-column-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(layout, "setPageLayout", "pdf-to-pdf", "Allowed values are single-page, one-column, two-column-left, two-column-right.", "set_page_layout"), 470);
    
    this.fields['page_layout'] = layout;
    return this;
};

/**
* Specify how the document should be displayed when opened.
*
* @param mode Allowed values are full-screen, thumbnails, outlines.
* @return The converter object.
*/
PdfToPdfClient.prototype.setPageMode = function(mode) {
    if (!mode.match(/^(full-screen|thumbnails|outlines)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageMode", "pdf-to-pdf", "Allowed values are full-screen, thumbnails, outlines.", "set_page_mode"), 470);
    
    this.fields['page_mode'] = mode;
    return this;
};

/**
* Specify how the page should be displayed when opened.
*
* @param zoomType Allowed values are fit-width, fit-height, fit-page.
* @return The converter object.
*/
PdfToPdfClient.prototype.setInitialZoomType = function(zoomType) {
    if (!zoomType.match(/^(fit-width|fit-height|fit-page)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoomType, "setInitialZoomType", "pdf-to-pdf", "Allowed values are fit-width, fit-height, fit-page.", "set_initial_zoom_type"), 470);
    
    this.fields['initial_zoom_type'] = zoomType;
    return this;
};

/**
* Display the specified page when the document is opened.
*
* @param page Must be a positive integer number.
* @return The converter object.
*/
PdfToPdfClient.prototype.setInitialPage = function(page) {
    if (!(parseInt(page) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(page, "setInitialPage", "pdf-to-pdf", "Must be a positive integer number.", "set_initial_page"), 470);
    
    this.fields['initial_page'] = page.toString();
    return this;
};

/**
* Specify the initial page zoom in percents when the document is opened.
*
* @param zoom Must be a positive integer number.
* @return The converter object.
*/
PdfToPdfClient.prototype.setInitialZoom = function(zoom) {
    if (!(parseInt(zoom) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoom, "setInitialZoom", "pdf-to-pdf", "Must be a positive integer number.", "set_initial_zoom"), 470);
    
    this.fields['initial_zoom'] = zoom.toString();
    return this;
};

/**
* Specify whether to hide the viewer application's tool bars when the document is active.
*
* @param value Set to <span class='field-value'>true</span> to hide tool bars.
* @return The converter object.
*/
PdfToPdfClient.prototype.setHideToolbar = function(value) {
    this.fields['hide_toolbar'] = value;
    return this;
};

/**
* Specify whether to hide the viewer application's menu bar when the document is active.
*
* @param value Set to <span class='field-value'>true</span> to hide the menu bar.
* @return The converter object.
*/
PdfToPdfClient.prototype.setHideMenubar = function(value) {
    this.fields['hide_menubar'] = value;
    return this;
};

/**
* Specify whether to hide user interface elements in the document's window (such as scroll bars and navigation controls), leaving only the document's contents displayed.
*
* @param value Set to <span class='field-value'>true</span> to hide ui elements.
* @return The converter object.
*/
PdfToPdfClient.prototype.setHideWindowUi = function(value) {
    this.fields['hide_window_ui'] = value;
    return this;
};

/**
* Specify whether to resize the document's window to fit the size of the first displayed page.
*
* @param value Set to <span class='field-value'>true</span> to resize the window.
* @return The converter object.
*/
PdfToPdfClient.prototype.setFitWindow = function(value) {
    this.fields['fit_window'] = value;
    return this;
};

/**
* Specify whether to position the document's window in the center of the screen.
*
* @param value Set to <span class='field-value'>true</span> to center the window.
* @return The converter object.
*/
PdfToPdfClient.prototype.setCenterWindow = function(value) {
    this.fields['center_window'] = value;
    return this;
};

/**
* Specify whether the window's title bar should display the document title. If false , the title bar should instead display the name of the PDF file containing the document.
*
* @param value Set to <span class='field-value'>true</span> to display the title.
* @return The converter object.
*/
PdfToPdfClient.prototype.setDisplayTitle = function(value) {
    this.fields['display_title'] = value;
    return this;
};

/**
* Set the predominant reading order for text to right-to-left. This option has no direct effect on the document's contents or page numbering but can be used to determine the relative positioning of pages when displayed side by side or printed n-up
*
* @param value Set to <span class='field-value'>true</span> to set right-to-left reading order.
* @return The converter object.
*/
PdfToPdfClient.prototype.setRightToLeft = function(value) {
    this.fields['right_to_left'] = value;
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
PdfToPdfClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
PdfToPdfClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
PdfToPdfClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
PdfToPdfClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
PdfToPdfClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the number of pages in the output document.
* @return The page count.
*/
PdfToPdfClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
PdfToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
PdfToPdfClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
PdfToPdfClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* Set the converter version. Different versions may produce different output. Choose which one provides the best output for your case.
*
* @param version The version identifier. Allowed values are latest, 20.10, 18.10.
* @return The converter object.
*/
PdfToPdfClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(latest|20.10|18.10)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "pdf-to-pdf", "Allowed values are latest, 20.10, 18.10.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
PdfToPdfClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
PdfToPdfClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
PdfToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
PdfToPdfClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
* Conversion from an image to PDF.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function ImageToPdfClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'image',
        'output_format': 'pdf'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* Convert an image.
*
* @param url The address of the image to convert. The supported protocols are http:// and https://.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToPdfClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "image-to-pdf", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert an image and write the result to a local file.
*
* @param url The address of the image to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToPdfClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToPdfClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "image-to-pdf", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToPdfClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert raw data.
*
* @param data The raw content to be converted.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToPdfClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert raw data to a file.
*
* @param data The raw content to be converted.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToPdfClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
* Convert the contents of an input stream.
*
* @param inStream The input stream with source data.<br>
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendPdfInHttpResponse(response[, fileName, disposition])</code> - sends the generated PDF in an HTTP response
<ul>
 <li> response - the response object
 <li> fileName - the desired file name 
 <li> disposition - the response content disposition, can be  "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
ImageToPdfClient.prototype.convertStream = function(inStream, callbacks) {
    var data = '';
    var that = this;
    inStream.on('error', function(err) {
        callbacks.error(err, CLIENT_ERROR);
    });
    inStream.on('data', function(chunk) {
        data += chunk;
    });
    inStream.on('end', function() {
        that.rawData['stream'] = data;
        return that.helper.post(that.fields, that.files, that.rawData, callbacks);
    });
};

/**
* Convert the contents of an input stream and write the result to a local file.
*
* @param inStream The input stream with source data.<br>
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
ImageToPdfClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
* Resize the image.
*
* @param resize The resize percentage or new image dimensions.
* @return The converter object.
*/
ImageToPdfClient.prototype.setResize = function(resize) {
    this.fields['resize'] = resize;
    return this;
};

/**
* Rotate the image.
*
* @param rotate The rotation specified in degrees.
* @return The converter object.
*/
ImageToPdfClient.prototype.setRotate = function(rotate) {
    this.fields['rotate'] = rotate;
    return this;
};

/**
* Set the top left X coordinate of the content area. It is relative to the top left X coordinate of the print area.
*
* @param x The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setCropAreaX = function(x) {
    if (!x.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x;
    return this;
};

/**
* Set the top left Y coordinate of the content area. It is relative to the top left Y coordinate of the print area.
*
* @param y The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setCropAreaY = function(y) {
    if (!y.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y;
    return this;
};

/**
* Set the width of the content area. It should be at least 1 inch.
*
* @param width The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setCropAreaWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width;
    return this;
};

/**
* Set the height of the content area. It should be at least 1 inch.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setCropAreaHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height;
    return this;
};

/**
* Set the content area position and size. The content area enables to specify the part to be converted.
*
* @param x Set the top left X coordinate of the content area. It is relative to the top left X coordinate of the print area. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param y Set the top left Y coordinate of the content area. It is relative to the top left Y coordinate of the print area. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param width Set the width of the content area. It should be at least 1 inch. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param height Set the height of the content area. It should be at least 1 inch. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
* Remove borders of an image which does not change in color.
*
* @param value Set to <span class='field-value'>true</span> to remove borders.
* @return The converter object.
*/
ImageToPdfClient.prototype.setRemoveBorders = function(value) {
    this.fields['remove_borders'] = value;
    return this;
};

/**
* Set the output page size.
*
* @param size Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageSize = function(size) {
    if (!size.match(/^(A0|A1|A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(size, "setPageSize", "image-to-pdf", "Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.", "set_page_size"), 470);
    
    this.fields['page_size'] = size;
    return this;
};

/**
* Set the output page width.
*
* @param width The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setPageWidth", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_page_width"), 470);
    
    this.fields['page_width'] = width;
    return this;
};

/**
* Set the output page height.
*
* @param height The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setPageHeight", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_page_height"), 470);
    
    this.fields['page_height'] = height;
    return this;
};

/**
* Set the output page dimensions. If no page size is specified, margins are applied as a border around the image.
*
* @param width Set the output page width. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param height Set the output page height. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageDimensions = function(width, height) {
    this.setPageWidth(width);
    this.setPageHeight(height);
    return this;
};

/**
* Set the output page orientation.
*
* @param orientation Allowed values are landscape, portrait.
* @return The converter object.
*/
ImageToPdfClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "setOrientation", "image-to-pdf", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
    return this;
};

/**
* Set the image position on the page.
*
* @param position Allowed values are center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPosition = function(position) {
    if (!position.match(/^(center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(position, "setPosition", "image-to-pdf", "Allowed values are center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right.", "set_position"), 470);
    
    this.fields['position'] = position;
    return this;
};

/**
* Set the mode to print the image on the content area of the page.
*
* @param mode Allowed values are default, fit, stretch.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPrintPageMode = function(mode) {
    if (!mode.match(/^(default|fit|stretch)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPrintPageMode", "image-to-pdf", "Allowed values are default, fit, stretch.", "set_print_page_mode"), 470);
    
    this.fields['print_page_mode'] = mode;
    return this;
};

/**
* Set the output page top margin.
*
* @param top The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setMarginTop = function(top) {
    if (!top.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(top, "setMarginTop", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_top"), 470);
    
    this.fields['margin_top'] = top;
    return this;
};

/**
* Set the output page right margin.
*
* @param right The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setMarginRight = function(right) {
    if (!right.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(right, "setMarginRight", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_right"), 470);
    
    this.fields['margin_right'] = right;
    return this;
};

/**
* Set the output page bottom margin.
*
* @param bottom The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setMarginBottom = function(bottom) {
    if (!bottom.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(bottom, "setMarginBottom", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = bottom;
    return this;
};

/**
* Set the output page left margin.
*
* @param left The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setMarginLeft = function(left) {
    if (!left.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(left, "setMarginLeft", "image-to-pdf", "The value must be specified in inches \"in\", millimeters \"mm\", centimeters \"cm\", pixels \"px\", or points \"pt\".", "set_margin_left"), 470);
    
    this.fields['margin_left'] = left;
    return this;
};

/**
* Set the output page margins.
*
* @param top Set the output page top margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param right Set the output page right margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param bottom Set the output page bottom margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @param left Set the output page left margin. The value must be specified in inches "in", millimeters "mm", centimeters "cm", pixels "px", or points "pt".
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
    return this;
};

/**
* The page background color in RGB or RGBA hexadecimal format. The color fills the entire page regardless of the margins. If not page size is specified and the image format supports background (e.g. PDF, PNG), the background color is applied too.
*
* @param color The value must be in RRGGBB or RRGGBBAA hexadecimal format.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setPageBackgroundColor", "image-to-pdf", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_page_background_color"), 470);
    
    this.fields['page_background_color'] = color;
    return this;
};

/**
* Set the DPI resolution of the input image. The DPI affects margin options specified in points too (e.g. 1 point is equal to 1 pixel in 96 DPI).
*
* @param dpi The DPI value.
* @return The converter object.
*/
ImageToPdfClient.prototype.setDpi = function(dpi) {
    this.fields['dpi'] = dpi.toString();
    return this;
};

/**
* Apply a watermark to each page of the output PDF file. A watermark can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the watermark.
*
* @param watermark The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setPageWatermark", "image-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = watermark;
    return this;
};

/**
* Load a file from the specified URL and apply the file as a watermark to each page of the output PDF. A watermark can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the watermark.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageWatermarkUrl", "image-to-pdf", "The supported protocols are http:// and https://.", "set_page_watermark_url"), 470);
    
    this.fields['page_watermark_url'] = url;
    return this;
};

/**
* Apply each page of a watermark to the corresponding page of the output PDF. A watermark can be either a PDF or an image.
*
* @param watermark The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
ImageToPdfClient.prototype.setMultipageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setMultipageWatermark", "image-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = watermark;
    return this;
};

/**
* Load a file from the specified URL and apply each page of the file as a watermark to the corresponding page of the output PDF. A watermark can be either a PDF or an image.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
ImageToPdfClient.prototype.setMultipageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageWatermarkUrl", "image-to-pdf", "The supported protocols are http:// and https://.", "set_multipage_watermark_url"), 470);
    
    this.fields['multipage_watermark_url'] = url;
    return this;
};

/**
* Apply a background to each page of the output PDF file. A background can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the background.
*
* @param background The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setPageBackground", "image-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = background;
    return this;
};

/**
* Load a file from the specified URL and apply the file as a background to each page of the output PDF. A background can be either a PDF or an image. If a multi-page file (PDF or TIFF) is used, the first page is used as the background.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageBackgroundUrl", "image-to-pdf", "The supported protocols are http:// and https://.", "set_page_background_url"), 470);
    
    this.fields['page_background_url'] = url;
    return this;
};

/**
* Apply each page of a background to the corresponding page of the output PDF. A background can be either a PDF or an image.
*
* @param background The file path to a local file. The file must exist and not be empty.
* @return The converter object.
*/
ImageToPdfClient.prototype.setMultipageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setMultipageBackground", "image-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = background;
    return this;
};

/**
* Load a file from the specified URL and apply each page of the file as a background to the corresponding page of the output PDF. A background can be either a PDF or an image.
*
* @param url The supported protocols are http:// and https://.
* @return The converter object.
*/
ImageToPdfClient.prototype.setMultipageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageBackgroundUrl", "image-to-pdf", "The supported protocols are http:// and https://.", "set_multipage_background_url"), 470);
    
    this.fields['multipage_background_url'] = url;
    return this;
};

/**
* Create linearized PDF. This is also known as Fast Web View.
*
* @param value Set to <span class='field-value'>true</span> to create linearized PDF.
* @return The converter object.
*/
ImageToPdfClient.prototype.setLinearize = function(value) {
    this.fields['linearize'] = value;
    return this;
};

/**
* Encrypt the PDF. This prevents search engines from indexing the contents.
*
* @param value Set to <span class='field-value'>true</span> to enable PDF encryption.
* @return The converter object.
*/
ImageToPdfClient.prototype.setEncrypt = function(value) {
    this.fields['encrypt'] = value;
    return this;
};

/**
* Protect the PDF with a user password. When a PDF has a user password, it must be supplied in order to view the document and to perform operations allowed by the access permissions.
*
* @param password The user password.
* @return The converter object.
*/
ImageToPdfClient.prototype.setUserPassword = function(password) {
    this.fields['user_password'] = password;
    return this;
};

/**
* Protect the PDF with an owner password.  Supplying an owner password grants unlimited access to the PDF including changing the passwords and access permissions.
*
* @param password The owner password.
* @return The converter object.
*/
ImageToPdfClient.prototype.setOwnerPassword = function(password) {
    this.fields['owner_password'] = password;
    return this;
};

/**
* Disallow printing of the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the no-print flag in the output PDF.
* @return The converter object.
*/
ImageToPdfClient.prototype.setNoPrint = function(value) {
    this.fields['no_print'] = value;
    return this;
};

/**
* Disallow modification of the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the read-only only flag in the output PDF.
* @return The converter object.
*/
ImageToPdfClient.prototype.setNoModify = function(value) {
    this.fields['no_modify'] = value;
    return this;
};

/**
* Disallow text and graphics extraction from the output PDF.
*
* @param value Set to <span class='field-value'>true</span> to set the no-copy flag in the output PDF.
* @return The converter object.
*/
ImageToPdfClient.prototype.setNoCopy = function(value) {
    this.fields['no_copy'] = value;
    return this;
};

/**
* Set the title of the PDF.
*
* @param title The title.
* @return The converter object.
*/
ImageToPdfClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
* Set the subject of the PDF.
*
* @param subject The subject.
* @return The converter object.
*/
ImageToPdfClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
* Set the author of the PDF.
*
* @param author The author.
* @return The converter object.
*/
ImageToPdfClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
* Associate keywords with the document.
*
* @param keywords The string with the keywords.
* @return The converter object.
*/
ImageToPdfClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
* Specify the page layout to be used when the document is opened.
*
* @param layout Allowed values are single-page, one-column, two-column-left, two-column-right.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageLayout = function(layout) {
    if (!layout.match(/^(single-page|one-column|two-column-left|two-column-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(layout, "setPageLayout", "image-to-pdf", "Allowed values are single-page, one-column, two-column-left, two-column-right.", "set_page_layout"), 470);
    
    this.fields['page_layout'] = layout;
    return this;
};

/**
* Specify how the document should be displayed when opened.
*
* @param mode Allowed values are full-screen, thumbnails, outlines.
* @return The converter object.
*/
ImageToPdfClient.prototype.setPageMode = function(mode) {
    if (!mode.match(/^(full-screen|thumbnails|outlines)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageMode", "image-to-pdf", "Allowed values are full-screen, thumbnails, outlines.", "set_page_mode"), 470);
    
    this.fields['page_mode'] = mode;
    return this;
};

/**
* Specify how the page should be displayed when opened.
*
* @param zoomType Allowed values are fit-width, fit-height, fit-page.
* @return The converter object.
*/
ImageToPdfClient.prototype.setInitialZoomType = function(zoomType) {
    if (!zoomType.match(/^(fit-width|fit-height|fit-page)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoomType, "setInitialZoomType", "image-to-pdf", "Allowed values are fit-width, fit-height, fit-page.", "set_initial_zoom_type"), 470);
    
    this.fields['initial_zoom_type'] = zoomType;
    return this;
};

/**
* Display the specified page when the document is opened.
*
* @param page Must be a positive integer number.
* @return The converter object.
*/
ImageToPdfClient.prototype.setInitialPage = function(page) {
    if (!(parseInt(page) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(page, "setInitialPage", "image-to-pdf", "Must be a positive integer number.", "set_initial_page"), 470);
    
    this.fields['initial_page'] = page.toString();
    return this;
};

/**
* Specify the initial page zoom in percents when the document is opened.
*
* @param zoom Must be a positive integer number.
* @return The converter object.
*/
ImageToPdfClient.prototype.setInitialZoom = function(zoom) {
    if (!(parseInt(zoom) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoom, "setInitialZoom", "image-to-pdf", "Must be a positive integer number.", "set_initial_zoom"), 470);
    
    this.fields['initial_zoom'] = zoom.toString();
    return this;
};

/**
* Specify whether to hide the viewer application's tool bars when the document is active.
*
* @param value Set to <span class='field-value'>true</span> to hide tool bars.
* @return The converter object.
*/
ImageToPdfClient.prototype.setHideToolbar = function(value) {
    this.fields['hide_toolbar'] = value;
    return this;
};

/**
* Specify whether to hide the viewer application's menu bar when the document is active.
*
* @param value Set to <span class='field-value'>true</span> to hide the menu bar.
* @return The converter object.
*/
ImageToPdfClient.prototype.setHideMenubar = function(value) {
    this.fields['hide_menubar'] = value;
    return this;
};

/**
* Specify whether to hide user interface elements in the document's window (such as scroll bars and navigation controls), leaving only the document's contents displayed.
*
* @param value Set to <span class='field-value'>true</span> to hide ui elements.
* @return The converter object.
*/
ImageToPdfClient.prototype.setHideWindowUi = function(value) {
    this.fields['hide_window_ui'] = value;
    return this;
};

/**
* Specify whether to resize the document's window to fit the size of the first displayed page.
*
* @param value Set to <span class='field-value'>true</span> to resize the window.
* @return The converter object.
*/
ImageToPdfClient.prototype.setFitWindow = function(value) {
    this.fields['fit_window'] = value;
    return this;
};

/**
* Specify whether to position the document's window in the center of the screen.
*
* @param value Set to <span class='field-value'>true</span> to center the window.
* @return The converter object.
*/
ImageToPdfClient.prototype.setCenterWindow = function(value) {
    this.fields['center_window'] = value;
    return this;
};

/**
* Specify whether the window's title bar should display the document title. If false , the title bar should instead display the name of the PDF file containing the document.
*
* @param value Set to <span class='field-value'>true</span> to display the title.
* @return The converter object.
*/
ImageToPdfClient.prototype.setDisplayTitle = function(value) {
    this.fields['display_title'] = value;
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
ImageToPdfClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
ImageToPdfClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
ImageToPdfClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
ImageToPdfClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
ImageToPdfClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
ImageToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
ImageToPdfClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
ImageToPdfClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTP scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
ImageToPdfClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "image-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTPS scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
ImageToPdfClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "image-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
* Set the converter version. Different versions may produce different output. Choose which one provides the best output for your case.
*
* @param version The version identifier. Allowed values are latest, 20.10, 18.10.
* @return The converter object.
*/
ImageToPdfClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(latest|20.10|18.10)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "image-to-pdf", "Allowed values are latest, 20.10, 18.10.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
ImageToPdfClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
ImageToPdfClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
ImageToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
ImageToPdfClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
* Conversion from PDF to HTML.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function PdfToHtmlClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'pdf',
        'output_format': 'html'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* Convert a PDF.
*
* @param url The address of the PDF to convert. The supported protocols are http:// and https://.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToHtmlClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "pdf-to-html", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a PDF and write the result to a local file.
*
* @param url The address of the PDF to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty. The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToHtmlClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_url_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToHtmlClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "pdf-to-html", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param filePath The output file path. The string must not be empty. The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToHtmlClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_file_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert raw data.
*
* @param data The raw content to be converted.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToHtmlClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert raw data to a file.
*
* @param data The raw content to be converted.
* @param filePath The output file path. The string must not be empty. The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToHtmlClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
* Convert the contents of an input stream.
*
* @param inStream The input stream with source data.<br>
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToHtmlClient.prototype.convertStream = function(inStream, callbacks) {
    var data = '';
    var that = this;
    inStream.on('error', function(err) {
        callbacks.error(err, CLIENT_ERROR);
    });
    inStream.on('data', function(chunk) {
        data += chunk;
    });
    inStream.on('end', function() {
        that.rawData['stream'] = data;
        return that.helper.post(that.fields, that.files, that.rawData, callbacks);
    });
};

/**
* Convert the contents of an input stream and write the result to a local file.
*
* @param inStream The input stream with source data.<br>
* @param filePath The output file path. The string must not be empty. The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToHtmlClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
* Password to open the encrypted PDF file.
*
* @param password The input PDF password.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setPdfPassword = function(password) {
    this.fields['pdf_password'] = password;
    return this;
};

/**
* Set the scaling factor (zoom) for the main page area.
*
* @param factor The percentage value. Must be a positive integer number.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setScaleFactor = function(factor) {
    if (!(parseInt(factor) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setScaleFactor", "pdf-to-html", "Must be a positive integer number.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = factor.toString();
    return this;
};

/**
* Set the page range to print.
*
* @param pages A comma separated list of page numbers or ranges.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "pdf-to-html", "A comma separated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
* Specifies where the images are stored.
*
* @param mode The image storage mode. Allowed values are embed, separate.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setImageMode = function(mode) {
    if (!mode.match(/^(embed|separate)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setImageMode", "pdf-to-html", "Allowed values are embed, separate.", "set_image_mode"), 470);
    
    this.fields['image_mode'] = mode;
    return this;
};

/**
* Specifies where the style sheets are stored.
*
* @param mode The style sheet storage mode. Allowed values are embed, separate.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setCssMode = function(mode) {
    if (!mode.match(/^(embed|separate)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setCssMode", "pdf-to-html", "Allowed values are embed, separate.", "set_css_mode"), 470);
    
    this.fields['css_mode'] = mode;
    return this;
};

/**
* Specifies where the fonts are stored.
*
* @param mode The font storage mode. Allowed values are embed, separate.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setFontMode = function(mode) {
    if (!mode.match(/^(embed|separate)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setFontMode", "pdf-to-html", "Allowed values are embed, separate.", "set_font_mode"), 470);
    
    this.fields['font_mode'] = mode;
    return this;
};

/**
* A helper method to determine if the output file is a zip archive. The output of the conversion may be either an HTML file or a zip file containing the HTML and its external assets.
* @return <span class='field-value'>True</span> if the conversion output is a zip file, otherwise <span class='field-value'>False</span>.
*/
PdfToHtmlClient.prototype.isZippedOutput = function() {
    return this.fields.image_mode === 'separate' || this.fields.css_mode === 'separate' || this.fields.font_mode === 'separate' || this.fields.force_zip === true;
};

/**
* Enforces the zip output format.
*
* @param value Set to <span class='field-value'>true</span> to get the output as a zip archive.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setForceZip = function(value) {
    this.fields['force_zip'] = value;
    return this;
};

/**
* Set the HTML title. The title from the input PDF is used by default.
*
* @param title The HTML title.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
* Set the HTML subject. The subject from the input PDF is used by default.
*
* @param subject The HTML subject.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
* Set the HTML author. The author from the input PDF is used by default.
*
* @param author The HTML author.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
* Associate keywords with the HTML document. Keywords from the input PDF are used by default.
*
* @param keywords The string containing the keywords.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
PdfToHtmlClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
PdfToHtmlClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
PdfToHtmlClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
PdfToHtmlClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the number of pages in the output document.
* @return The page count.
*/
PdfToHtmlClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
PdfToHtmlClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
PdfToHtmlClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTP scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "pdf-to-html", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTPS scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "pdf-to-html", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
PdfToHtmlClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
* Conversion from PDF to text.
*/
/**
* Constructor for the Pdfcrowd API client.
*
* @param userName Your username at Pdfcrowd.
* @param apiKey Your API key.
*/
function PdfToTextClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'pdf',
        'output_format': 'txt'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
* Convert a PDF.
*
* @param url The address of the PDF to convert. The supported protocols are http:// and https://.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToTextClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "pdf-to-text", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a PDF and write the result to a local file.
*
* @param url The address of the PDF to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToTextClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToTextClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "pdf-to-text", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
*
* @param file The path to a local file to convert.<br>  The file must exist and not be empty.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToTextClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert raw data.
*
* @param data The raw content to be converted.
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToTextClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert raw data to a file.
*
* @param data The raw content to be converted.
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToTextClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
* Convert the contents of an input stream.
*
* @param inStream The input stream with source data.<br>
* @param callbacks The object that defines the following functions:
<ul>
  <li>
  <code>data(readStream)</code> - called when the output data can be read from readStream
  </li>
  <li>
  <code>error(message, statusCode)</code> - called when an error occurs
  </li>
  <li>
  <code>end()</code> - called when the conversion finishes
  </li>
</ul>
The client library provides 2 helper functions that can be used here:
<ul>
  <li>
  <code>saveToFile(filePath[, callback])</code> - saves the output data to a file
    <ul>
      <li>filePath - the output file path
      <li>callback(err, filePath) - called when the conversion finishes
    </ul>
  </li>
  <li>
  
<code>sendGenericHttpResponse(response, contentType, fileName[, disposition])</code> - sends the generated image in an HTTP response
<ul>
    <li> response - the response object
    <li> contentType - the response content type
    <li> fileName - the desired file name
    <li> disposition - the response content disposition, can be "attachment" or "inline", the default is "attachment".
</ul>

  </li>
</ul>
*/
PdfToTextClient.prototype.convertStream = function(inStream, callbacks) {
    var data = '';
    var that = this;
    inStream.on('error', function(err) {
        callbacks.error(err, CLIENT_ERROR);
    });
    inStream.on('data', function(chunk) {
        data += chunk;
    });
    inStream.on('end', function() {
        that.rawData['stream'] = data;
        return that.helper.post(that.fields, that.files, that.rawData, callbacks);
    });
};

/**
* Convert the contents of an input stream and write the result to a local file.
*
* @param inStream The input stream with source data.<br>
* @param filePath The output file path. The string must not be empty.
* @param callback The <code>callback(error, filePath)</code> function is called when the conversion finishes. The error object is present if an error occurred, filePath is the output file path.
*/
PdfToTextClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
* The password to open the encrypted PDF file.
*
* @param password The input PDF password.
* @return The converter object.
*/
PdfToTextClient.prototype.setPdfPassword = function(password) {
    this.fields['pdf_password'] = password;
    return this;
};

/**
* Set the page range to print.
*
* @param pages A comma separated list of page numbers or ranges.
* @return The converter object.
*/
PdfToTextClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "pdf-to-text", "A comma separated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
* Ignore the original PDF layout.
*
* @param value Set to <span class='field-value'>true</span> to ignore the layout.
* @return The converter object.
*/
PdfToTextClient.prototype.setNoLayout = function(value) {
    this.fields['no_layout'] = value;
    return this;
};

/**
* The end-of-line convention for the text output.
*
* @param eol Allowed values are unix, dos, mac.
* @return The converter object.
*/
PdfToTextClient.prototype.setEol = function(eol) {
    if (!eol.match(/^(unix|dos|mac)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(eol, "setEol", "pdf-to-text", "Allowed values are unix, dos, mac.", "set_eol"), 470);
    
    this.fields['eol'] = eol;
    return this;
};

/**
* Specify the page break mode for the text output.
*
* @param mode Allowed values are none, default, custom.
* @return The converter object.
*/
PdfToTextClient.prototype.setPageBreakMode = function(mode) {
    if (!mode.match(/^(none|default|custom)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageBreakMode", "pdf-to-text", "Allowed values are none, default, custom.", "set_page_break_mode"), 470);
    
    this.fields['page_break_mode'] = mode;
    return this;
};

/**
* Specify the custom page break.
*
* @param pageBreak String to insert between the pages.
* @return The converter object.
*/
PdfToTextClient.prototype.setCustomPageBreak = function(pageBreak) {
    this.fields['custom_page_break'] = pageBreak;
    return this;
};

/**
* Specify the paragraph detection mode.
*
* @param mode Allowed values are none, bounding-box, characters.
* @return The converter object.
*/
PdfToTextClient.prototype.setParagraphMode = function(mode) {
    if (!mode.match(/^(none|bounding-box|characters)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setParagraphMode", "pdf-to-text", "Allowed values are none, bounding-box, characters.", "set_paragraph_mode"), 470);
    
    this.fields['paragraph_mode'] = mode;
    return this;
};

/**
* Set the maximum line spacing when the paragraph detection mode is enabled.
*
* @param threshold The value must be a positive integer percentage.
* @return The converter object.
*/
PdfToTextClient.prototype.setLineSpacingThreshold = function(threshold) {
    if (!threshold.match(/^0$|^[0-9]+%$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(threshold, "setLineSpacingThreshold", "pdf-to-text", "The value must be a positive integer percentage.", "set_line_spacing_threshold"), 470);
    
    this.fields['line_spacing_threshold'] = threshold;
    return this;
};

/**
* Remove the hyphen character from the end of lines.
*
* @param value Set to <span class='field-value'>true</span> to remove hyphens.
* @return The converter object.
*/
PdfToTextClient.prototype.setRemoveHyphenation = function(value) {
    this.fields['remove_hyphenation'] = value;
    return this;
};

/**
* Remove empty lines from the text output.
*
* @param value Set to <span class='field-value'>true</span> to remove empty lines.
* @return The converter object.
*/
PdfToTextClient.prototype.setRemoveEmptyLines = function(value) {
    this.fields['remove_empty_lines'] = value;
    return this;
};

/**
* Set the top left X coordinate of the crop area in points.
*
* @param x Must be a positive integer number or 0.
* @return The converter object.
*/
PdfToTextClient.prototype.setCropAreaX = function(x) {
    if (!(parseInt(x) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "pdf-to-text", "Must be a positive integer number or 0.", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x.toString();
    return this;
};

/**
* Set the top left Y coordinate of the crop area in points.
*
* @param y Must be a positive integer number or 0.
* @return The converter object.
*/
PdfToTextClient.prototype.setCropAreaY = function(y) {
    if (!(parseInt(y) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "pdf-to-text", "Must be a positive integer number or 0.", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y.toString();
    return this;
};

/**
* Set the width of the crop area in points.
*
* @param width Must be a positive integer number or 0.
* @return The converter object.
*/
PdfToTextClient.prototype.setCropAreaWidth = function(width) {
    if (!(parseInt(width) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "pdf-to-text", "Must be a positive integer number or 0.", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width.toString();
    return this;
};

/**
* Set the height of the crop area in points.
*
* @param height Must be a positive integer number or 0.
* @return The converter object.
*/
PdfToTextClient.prototype.setCropAreaHeight = function(height) {
    if (!(parseInt(height) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "pdf-to-text", "Must be a positive integer number or 0.", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height.toString();
    return this;
};

/**
* Set the crop area. It allows to extract just a part of a PDF page.
*
* @param x Set the top left X coordinate of the crop area in points. Must be a positive integer number or 0.
* @param y Set the top left Y coordinate of the crop area in points. Must be a positive integer number or 0.
* @param width Set the width of the crop area in points. Must be a positive integer number or 0.
* @param height Set the height of the crop area in points. Must be a positive integer number or 0.
* @return The converter object.
*/
PdfToTextClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
* Turn on the debug logging. Details about the conversion are stored in the debug log. The URL of the log can be obtained from the <a href='#get_debug_log_url'>getDebugLogUrl</a> method or available in <a href='/user/account/log/conversion/'>conversion statistics</a>.
*
* @param value Set to <span class='field-value'>true</span> to enable the debug logging.
* @return The converter object.
*/
PdfToTextClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
* Get the URL of the debug log for the last conversion.
* @return The link to the debug log.
*/
PdfToTextClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
* Get the number of conversion credits available in your <a href='/user/account/'>account</a>.
* This method can only be called after a call to one of the convertXtoY methods.
* The returned value can differ from the actual count if you run parallel conversions.
* The special value <span class='field-value'>999999</span> is returned if the information is not available.
* @return The number of credits.
*/
PdfToTextClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
* Get the number of credits consumed by the last conversion.
* @return The number of credits.
*/
PdfToTextClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
* Get the job id.
* @return The unique job identifier.
*/
PdfToTextClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
* Get the number of pages in the output document.
* @return The page count.
*/
PdfToTextClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
PdfToTextClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Get the version details.
* @return API version, converter version, and client version.
*/
PdfToTextClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
* Tag the conversion with a custom value. The tag is used in <a href='/user/account/log/conversion/'>conversion statistics</a>. A value longer than 32 characters is cut off.
*
* @param tag A string with the custom tag.
* @return The converter object.
*/
PdfToTextClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTP scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
PdfToTextClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "pdf-to-text", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
* A proxy server used by Pdfcrowd conversion process for accessing the source URLs with HTTPS scheme. It can help to circumvent regional restrictions or provide limited access to your intranet.
*
* @param proxy The value must have format DOMAIN_OR_IP_ADDRESS:PORT.
* @return The converter object.
*/
PdfToTextClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "pdf-to-text", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* Warning: Using HTTP is insecure as data sent over HTTP is not encrypted. Enable this option only if you know what you are doing.
*
* @param value Set to <span class='field-value'>true</span> to use HTTP.
* @return The converter object.
*/
PdfToTextClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
* Set a custom user agent HTTP header. It can be useful if you are behind a proxy or a firewall.
*
* @param agent The user agent string.
* @return The converter object.
*/
PdfToTextClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
*
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
* @return The converter object.
*/
PdfToTextClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
* Specifies the number of automatic retries when the 502 or 503 HTTP status code is received. The status code indicates a temporary network issue. This feature can be disabled by setting to 0.
*
* @param count Number of retries.
* @return The converter object.
*/
PdfToTextClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};


//
// Exports
//
module.exports = {
    HtmlToPdfClient: HtmlToPdfClient,
    HtmlToImageClient: HtmlToImageClient,
    ImageToImageClient: ImageToImageClient,
    PdfToPdfClient: PdfToPdfClient,
    ImageToPdfClient: ImageToPdfClient,
    PdfToHtmlClient: PdfToHtmlClient,
    PdfToTextClient: PdfToTextClient,
    Pdfcrowd: Pdfcrowd,
    saveToFile: saveToFile,
    sendHttpResponse: sendHttpResponse,
    sendPdfInHttpResponse: sendPdfInHttpResponse,
    sendImageInHttpResponse: sendImageInHttpResponse,
    sendGenericHttpResponse: sendGenericHttpResponse
};
