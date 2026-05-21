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

Pdfcrowd.Error = function(error, httpCode) {
    this.error = error;
    this.stack = (new Error()).stack;

    const errorMatch = error.match(
        /^(\d+)\.(\d+)\s+-\s+(.*?)(?:\s+Documentation link:\s+(.*))?$/s
    );
    if (errorMatch) {
        this.httpCode = errorMatch[1];
        this.reasonCode = errorMatch[2];
        this.message = errorMatch[3];
        this.docLink = errorMatch[4] || '';
    } else {
        this.httpCode = httpCode;
        this.reasonCode = -1;
        this.message = error;
        if (this.httpCode) {
            this.error = `${this.httpCode} - ${this.error}`;
        }
        this.docLink = '';
    }

    this.toString = function() {
        return this.error;
    }

    this.getCode = function() {
        console.warn(
            '[DEPRECATION] `getCode` is obsolete and will be removed in ' +
            'future versions. Use `getStatusCode` instead.'
        );
        return this.httpCode;
    }

    this.getStatusCode = function() {
        return this.httpCode;
    }

    this.getReasonCode = function() {
        return this.reasonCode;
    }

    this.getMessage = function() {
        return this.message;
    }

    this.getDocumentationLink = function() {
        return this.docLink;
    }
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
var CLIENT_VERSION = '6.6.0';
var MULTIPART_BOUNDARY = '----------ThIs_Is_tHe_bOUnDary_$';
var CLIENT_ERROR = -1;

function encodeCredentials(userName, password) {
    return 'Basic ' + new Buffer(userName + ':' + password).toString('base64');
}

function createInvalidValueMessage(value, field, converter, hint, id) {
    var message = "400.311 - Invalid value '" + value + "' for the '" + field + "' option.";
    if(hint) {
        message += " " + hint;
    }
    return message + " " + "Documentation link: https://www.pdfcrowd.com/api/" + converter + "-nodejs/ref/#" + id + "";
}

function ConnectionHelper(userName, apiKey) {
    this.userName = userName;
    this.apiKey = apiKey;

    this.resetResponseData();
    this.setProxy(null, null, null, null);
    this.setUseHttp(false);
    this.setUserAgent('pdfcrowd_nodejs_client/6.6.0 (https://pdfcrowd.com)');

    this.retryCount = 1;
    this.converterVersion = '24.04';
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
            callbacks.error("400.356 - There was a problem connecting to PDFCrowd servers over HTTPS:\n" +
                            res.toString() +
                            "\nYou can still use the API over HTTP, you just need to add the following line right after PDFCrowd client initialization:\nclient.setUseHttp(true);",
                            0);
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
 *
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/">https://pdfcrowd.com/api/html-to-pdf-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#HtmlToPdfClient">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#HtmlToPdfClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_url</a>
 */
HtmlToPdfClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_url_to_file</a>
 */
HtmlToPdfClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_file</a>
 */
HtmlToPdfClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "html-to-pdf", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_file_to_file</a>
 */
HtmlToPdfClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_string">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_string</a>
 */
HtmlToPdfClient.prototype.convertString = function(text, callbacks) {
    if (!(text))
        return callbacks.error(createInvalidValueMessage(text, "convertString", "html-to-pdf", "The string must not be empty.", "convert_string"), 470);
    
    this.fields['text'] = text;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_string_to_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_string_to_file</a>
 */
HtmlToPdfClient.prototype.convertStringToFile = function(text, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStringToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_string_to_file"), 470);
    
    this.convertString(text, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_stream</a>
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
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#convert_stream_to_file</a>
 */
HtmlToPdfClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "html-to-pdf", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_zip_main_filename">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_zip_main_filename</a>
 */
HtmlToPdfClient.prototype.setZipMainFilename = function(filename) {
    this.fields['zip_main_filename'] = filename;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_size">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_size</a>
 */
HtmlToPdfClient.prototype.setPageSize = function(size) {
    if (!size.match(/^(A0|A1|A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(size, "setPageSize", "html-to-pdf", "Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.", "set_page_size"), 470);
    
    this.fields['page_size'] = size;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_width">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_width</a>
 */
HtmlToPdfClient.prototype.setPageWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setPageWidth", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_page_width"), 470);
    
    this.fields['page_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_height">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_height</a>
 */
HtmlToPdfClient.prototype.setPageHeight = function(height) {
    if (!height.match(/^0$|^\-1$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setPageHeight", "html-to-pdf", "The value must be -1 or specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_page_height"), 470);
    
    this.fields['page_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_dimensions">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_dimensions</a>
 */
HtmlToPdfClient.prototype.setPageDimensions = function(width, height) {
    this.setPageWidth(width);
    this.setPageHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_orientation">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_orientation</a>
 */
HtmlToPdfClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "setOrientation", "html-to-pdf", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_top">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_top</a>
 */
HtmlToPdfClient.prototype.setMarginTop = function(top) {
    if (!top.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(top, "setMarginTop", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_top"), 470);
    
    this.fields['margin_top'] = top;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_right">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_right</a>
 */
HtmlToPdfClient.prototype.setMarginRight = function(right) {
    if (!right.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(right, "setMarginRight", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_right"), 470);
    
    this.fields['margin_right'] = right;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_bottom">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_bottom</a>
 */
HtmlToPdfClient.prototype.setMarginBottom = function(bottom) {
    if (!bottom.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(bottom, "setMarginBottom", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = bottom;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_left">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_margin_left</a>
 */
HtmlToPdfClient.prototype.setMarginLeft = function(left) {
    if (!left.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(left, "setMarginLeft", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_left"), 470);
    
    this.fields['margin_left'] = left;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_margins">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_margins</a>
 */
HtmlToPdfClient.prototype.setNoMargins = function(value) {
    this.fields['no_margins'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_margins">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_margins</a>
 */
HtmlToPdfClient.prototype.setPageMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_print_page_range">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_print_page_range</a>
 */
HtmlToPdfClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*)|odd|even|last)\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*)|odd|even|last)\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "html-to-pdf", "A comma separated list of page numbers or ranges. Special strings may be used, such as 'odd', 'even' and 'last'.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_viewport_width">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_viewport_width</a>
 */
HtmlToPdfClient.prototype.setContentViewportWidth = function(width) {
    if (!width.match(/^(balanced|small|medium|large|extra-large|[0-9]+(px)?)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setContentViewportWidth", "html-to-pdf", "The value must be 'balanced', 'small', 'medium', 'large', 'extra-large', or a number in the range 96-65000px.", "set_content_viewport_width"), 470);
    
    this.fields['content_viewport_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_viewport_height">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_viewport_height</a>
 */
HtmlToPdfClient.prototype.setContentViewportHeight = function(height) {
    if (!height.match(/^(auto|large|[0-9]+(px)?)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setContentViewportHeight", "html-to-pdf", "The value must be 'auto', 'large', or a number.", "set_content_viewport_height"), 470);
    
    this.fields['content_viewport_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_fit_mode">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_fit_mode</a>
 */
HtmlToPdfClient.prototype.setContentFitMode = function(mode) {
    if (!mode.match(/^(auto|smart-scaling|no-scaling|viewport-width|content-width|single-page|single-page-ratio)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setContentFitMode", "html-to-pdf", "Allowed values are auto, smart-scaling, no-scaling, viewport-width, content-width, single-page, single-page-ratio.", "set_content_fit_mode"), 470);
    
    this.fields['content_fit_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_remove_blank_pages">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_remove_blank_pages</a>
 */
HtmlToPdfClient.prototype.setRemoveBlankPages = function(pages) {
    if (!pages.match(/^(trailing|all|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setRemoveBlankPages", "html-to-pdf", "Allowed values are trailing, all, none.", "set_remove_blank_pages"), 470);
    
    this.fields['remove_blank_pages'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_url</a>
 */
HtmlToPdfClient.prototype.setHeaderUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setHeaderUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "set_header_url"), 470);
    
    this.fields['header_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_html">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_html</a>
 */
HtmlToPdfClient.prototype.setHeaderHtml = function(html) {
    if (!(html))
        throw new Pdfcrowd.Error(createInvalidValueMessage(html, "setHeaderHtml", "html-to-pdf", "The string must not be empty.", "set_header_html"), 470);
    
    this.fields['header_html'] = html;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_height">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_height</a>
 */
HtmlToPdfClient.prototype.setHeaderHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setHeaderHeight", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_header_height"), 470);
    
    this.fields['header_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_zip_header_filename">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_zip_header_filename</a>
 */
HtmlToPdfClient.prototype.setZipHeaderFilename = function(filename) {
    this.fields['zip_header_filename'] = filename;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_url</a>
 */
HtmlToPdfClient.prototype.setFooterUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setFooterUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "set_footer_url"), 470);
    
    this.fields['footer_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_html">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_html</a>
 */
HtmlToPdfClient.prototype.setFooterHtml = function(html) {
    if (!(html))
        throw new Pdfcrowd.Error(createInvalidValueMessage(html, "setFooterHtml", "html-to-pdf", "The string must not be empty.", "set_footer_html"), 470);
    
    this.fields['footer_html'] = html;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_height">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_height</a>
 */
HtmlToPdfClient.prototype.setFooterHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setFooterHeight", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_footer_height"), 470);
    
    this.fields['footer_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_zip_footer_filename">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_zip_footer_filename</a>
 */
HtmlToPdfClient.prototype.setZipFooterFilename = function(filename) {
    this.fields['zip_footer_filename'] = filename;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_header_footer_horizontal_margins">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_header_footer_horizontal_margins</a>
 */
HtmlToPdfClient.prototype.setNoHeaderFooterHorizontalMargins = function(value) {
    this.fields['no_header_footer_horizontal_margins'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_exclude_header_on_pages">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_exclude_header_on_pages</a>
 */
HtmlToPdfClient.prototype.setExcludeHeaderOnPages = function(pages) {
    if (!pages.match(/^(?:\s*\-?\d+\s*,)*\s*\-?\d+\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setExcludeHeaderOnPages", "html-to-pdf", "A comma separated list of page numbers.", "set_exclude_header_on_pages"), 470);
    
    this.fields['exclude_header_on_pages'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_exclude_footer_on_pages">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_exclude_footer_on_pages</a>
 */
HtmlToPdfClient.prototype.setExcludeFooterOnPages = function(pages) {
    if (!pages.match(/^(?:\s*\-?\d+\s*,)*\s*\-?\d+\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setExcludeFooterOnPages", "html-to-pdf", "A comma separated list of page numbers.", "set_exclude_footer_on_pages"), 470);
    
    this.fields['exclude_footer_on_pages'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_footer_scale_factor">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_footer_scale_factor</a>
 */
HtmlToPdfClient.prototype.setHeaderFooterScaleFactor = function(factor) {
    if (!(parseInt(factor) >= 10 && parseInt(factor) <= 500))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setHeaderFooterScaleFactor", "html-to-pdf", "The accepted range is 10-500.", "set_header_footer_scale_factor"), 470);
    
    this.fields['header_footer_scale_factor'] = factor.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_numbering_offset">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_numbering_offset</a>
 */
HtmlToPdfClient.prototype.setPageNumberingOffset = function(offset) {
    this.fields['page_numbering_offset'] = offset.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_watermark">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_watermark</a>
 */
HtmlToPdfClient.prototype.setPageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setPageWatermark", "html-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = watermark;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_watermark_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_watermark_url</a>
 */
HtmlToPdfClient.prototype.setPageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageWatermarkUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "set_page_watermark_url"), 470);
    
    this.fields['page_watermark_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_watermark">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_watermark</a>
 */
HtmlToPdfClient.prototype.setMultipageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setMultipageWatermark", "html-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = watermark;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_watermark_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_watermark_url</a>
 */
HtmlToPdfClient.prototype.setMultipageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageWatermarkUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "set_multipage_watermark_url"), 470);
    
    this.fields['multipage_watermark_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_background">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_background</a>
 */
HtmlToPdfClient.prototype.setPageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setPageBackground", "html-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = background;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_background_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_background_url</a>
 */
HtmlToPdfClient.prototype.setPageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageBackgroundUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "set_page_background_url"), 470);
    
    this.fields['page_background_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_background">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_background</a>
 */
HtmlToPdfClient.prototype.setMultipageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setMultipageBackground", "html-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = background;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_background_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_multipage_background_url</a>
 */
HtmlToPdfClient.prototype.setMultipageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageBackgroundUrl", "html-to-pdf", "Supported protocols are http:// and https://.", "set_multipage_background_url"), 470);
    
    this.fields['multipage_background_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_background_color">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_background_color</a>
 */
HtmlToPdfClient.prototype.setPageBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setPageBackgroundColor", "html-to-pdf", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_page_background_color"), 470);
    
    this.fields['page_background_color'] = color;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_use_print_media">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_use_print_media</a>
 */
HtmlToPdfClient.prototype.setUsePrintMedia = function(value) {
    this.fields['use_print_media'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_background">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_background</a>
 */
HtmlToPdfClient.prototype.setNoBackground = function(value) {
    this.fields['no_background'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_javascript">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_javascript</a>
 */
HtmlToPdfClient.prototype.setDisableJavascript = function(value) {
    this.fields['disable_javascript'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_image_loading">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_image_loading</a>
 */
HtmlToPdfClient.prototype.setDisableImageLoading = function(value) {
    this.fields['disable_image_loading'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_remote_fonts">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_remote_fonts</a>
 */
HtmlToPdfClient.prototype.setDisableRemoteFonts = function(value) {
    this.fields['disable_remote_fonts'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_use_mobile_user_agent">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_use_mobile_user_agent</a>
 */
HtmlToPdfClient.prototype.setUseMobileUserAgent = function(value) {
    this.fields['use_mobile_user_agent'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_load_iframes">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_load_iframes</a>
 */
HtmlToPdfClient.prototype.setLoadIframes = function(iframes) {
    if (!iframes.match(/^(all|same-origin|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(iframes, "setLoadIframes", "html-to-pdf", "Allowed values are all, same-origin, none.", "set_load_iframes"), 470);
    
    this.fields['load_iframes'] = iframes;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_block_ads">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_block_ads</a>
 */
HtmlToPdfClient.prototype.setBlockAds = function(value) {
    this.fields['block_ads'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_default_encoding">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_default_encoding</a>
 */
HtmlToPdfClient.prototype.setDefaultEncoding = function(encoding) {
    this.fields['default_encoding'] = encoding;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_locale">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_locale</a>
 */
HtmlToPdfClient.prototype.setLocale = function(locale) {
    this.fields['locale'] = locale;
    return this;
};


HtmlToPdfClient.prototype.setHttpAuthUserName = function(userName) {
    this.fields['http_auth_user_name'] = userName;
    return this;
};


HtmlToPdfClient.prototype.setHttpAuthPassword = function(password) {
    this.fields['http_auth_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_http_auth">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_http_auth</a>
 */
HtmlToPdfClient.prototype.setHttpAuth = function(userName, password) {
    this.setHttpAuthUserName(userName);
    this.setHttpAuthPassword(password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_cookies">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_cookies</a>
 */
HtmlToPdfClient.prototype.setCookies = function(cookies) {
    this.fields['cookies'] = cookies;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_verify_ssl_certificates">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_verify_ssl_certificates</a>
 */
HtmlToPdfClient.prototype.setVerifySslCertificates = function(value) {
    this.fields['verify_ssl_certificates'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_fail_on_main_url_error">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_fail_on_main_url_error</a>
 */
HtmlToPdfClient.prototype.setFailOnMainUrlError = function(failOnError) {
    this.fields['fail_on_main_url_error'] = failOnError;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_fail_on_any_url_error">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_fail_on_any_url_error</a>
 */
HtmlToPdfClient.prototype.setFailOnAnyUrlError = function(failOnError) {
    this.fields['fail_on_any_url_error'] = failOnError;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_xpdfcrowd_header">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_xpdfcrowd_header</a>
 */
HtmlToPdfClient.prototype.setNoXpdfcrowdHeader = function(value) {
    this.fields['no_xpdfcrowd_header'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_css_page_rule_mode">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_css_page_rule_mode</a>
 */
HtmlToPdfClient.prototype.setCssPageRuleMode = function(mode) {
    if (!mode.match(/^(default|mode1|mode2)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setCssPageRuleMode", "html-to-pdf", "Allowed values are default, mode1, mode2.", "set_css_page_rule_mode"), 470);
    
    this.fields['css_page_rule_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_custom_css">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_custom_css</a>
 */
HtmlToPdfClient.prototype.setCustomCss = function(css) {
    if (!(css))
        throw new Pdfcrowd.Error(createInvalidValueMessage(css, "setCustomCss", "html-to-pdf", "The string must not be empty.", "set_custom_css"), 470);
    
    this.fields['custom_css'] = css;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_custom_javascript">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_custom_javascript</a>
 */
HtmlToPdfClient.prototype.setCustomJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setCustomJavascript", "html-to-pdf", "The string must not be empty.", "set_custom_javascript"), 470);
    
    this.fields['custom_javascript'] = javascript;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_on_load_javascript">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_on_load_javascript</a>
 */
HtmlToPdfClient.prototype.setOnLoadJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setOnLoadJavascript", "html-to-pdf", "The string must not be empty.", "set_on_load_javascript"), 470);
    
    this.fields['on_load_javascript'] = javascript;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_custom_http_header">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_custom_http_header</a>
 */
HtmlToPdfClient.prototype.setCustomHttpHeader = function(header) {
    if (!header.match(/^.+:.+$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(header, "setCustomHttpHeader", "html-to-pdf", "A string containing the header name and value separated by a colon.", "set_custom_http_header"), 470);
    
    this.fields['custom_http_header'] = header;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_javascript_delay">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_javascript_delay</a>
 */
HtmlToPdfClient.prototype.setJavascriptDelay = function(delay) {
    if (!(parseInt(delay) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(delay, "setJavascriptDelay", "html-to-pdf", "Must be a positive integer or 0.", "set_javascript_delay"), 470);
    
    this.fields['javascript_delay'] = delay.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_element_to_convert">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_element_to_convert</a>
 */
HtmlToPdfClient.prototype.setElementToConvert = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setElementToConvert", "html-to-pdf", "The string must not be empty.", "set_element_to_convert"), 470);
    
    this.fields['element_to_convert'] = selectors;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_element_to_convert_mode">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_element_to_convert_mode</a>
 */
HtmlToPdfClient.prototype.setElementToConvertMode = function(mode) {
    if (!mode.match(/^(cut-out|remove-siblings|hide-siblings)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setElementToConvertMode", "html-to-pdf", "Allowed values are cut-out, remove-siblings, hide-siblings.", "set_element_to_convert_mode"), 470);
    
    this.fields['element_to_convert_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_wait_for_element">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_wait_for_element</a>
 */
HtmlToPdfClient.prototype.setWaitForElement = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setWaitForElement", "html-to-pdf", "The string must not be empty.", "set_wait_for_element"), 470);
    
    this.fields['wait_for_element'] = selectors;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_auto_detect_element_to_convert">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_auto_detect_element_to_convert</a>
 */
HtmlToPdfClient.prototype.setAutoDetectElementToConvert = function(value) {
    this.fields['auto_detect_element_to_convert'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_readability_enhancements">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_readability_enhancements</a>
 */
HtmlToPdfClient.prototype.setReadabilityEnhancements = function(enhancements) {
    if (!enhancements.match(/^(none|readability-v1|readability-v2|readability-v3|readability-v4)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(enhancements, "setReadabilityEnhancements", "html-to-pdf", "Allowed values are none, readability-v1, readability-v2, readability-v3, readability-v4.", "set_readability_enhancements"), 470);
    
    this.fields['readability_enhancements'] = enhancements;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_viewport_width">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_viewport_width</a>
 */
HtmlToPdfClient.prototype.setViewportWidth = function(width) {
    if (!(parseInt(width) >= 96 && parseInt(width) <= 65000))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setViewportWidth", "html-to-pdf", "The accepted range is 96-65000.", "set_viewport_width"), 470);
    
    this.fields['viewport_width'] = width.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_viewport_height">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_viewport_height</a>
 */
HtmlToPdfClient.prototype.setViewportHeight = function(height) {
    if (!(parseInt(height) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setViewportHeight", "html-to-pdf", "Must be a positive integer.", "set_viewport_height"), 470);
    
    this.fields['viewport_height'] = height.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_viewport">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_viewport</a>
 */
HtmlToPdfClient.prototype.setViewport = function(width, height) {
    this.setViewportWidth(width);
    this.setViewportHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_rendering_mode">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_rendering_mode</a>
 */
HtmlToPdfClient.prototype.setRenderingMode = function(mode) {
    if (!mode.match(/^(default|viewport)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setRenderingMode", "html-to-pdf", "Allowed values are default, viewport.", "set_rendering_mode"), 470);
    
    this.fields['rendering_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_smart_scaling_mode">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_smart_scaling_mode</a>
 */
HtmlToPdfClient.prototype.setSmartScalingMode = function(mode) {
    if (!mode.match(/^(default|disabled|viewport-fit|content-fit|single-page-fit|single-page-fit-ex|mode1)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setSmartScalingMode", "html-to-pdf", "Allowed values are default, disabled, viewport-fit, content-fit, single-page-fit, single-page-fit-ex, mode1.", "set_smart_scaling_mode"), 470);
    
    this.fields['smart_scaling_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_scale_factor">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_scale_factor</a>
 */
HtmlToPdfClient.prototype.setScaleFactor = function(factor) {
    if (!(parseInt(factor) >= 10 && parseInt(factor) <= 500))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setScaleFactor", "html-to-pdf", "The accepted range is 10-500.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = factor.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_jpeg_quality">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_jpeg_quality</a>
 */
HtmlToPdfClient.prototype.setJpegQuality = function(quality) {
    if (!(parseInt(quality) >= 1 && parseInt(quality) <= 100))
        throw new Pdfcrowd.Error(createInvalidValueMessage(quality, "setJpegQuality", "html-to-pdf", "The accepted range is 1-100.", "set_jpeg_quality"), 470);
    
    this.fields['jpeg_quality'] = quality.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_convert_images_to_jpeg">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_convert_images_to_jpeg</a>
 */
HtmlToPdfClient.prototype.setConvertImagesToJpeg = function(images) {
    if (!images.match(/^(none|opaque|all)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(images, "setConvertImagesToJpeg", "html-to-pdf", "Allowed values are none, opaque, all.", "set_convert_images_to_jpeg"), 470);
    
    this.fields['convert_images_to_jpeg'] = images;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_image_dpi">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_image_dpi</a>
 */
HtmlToPdfClient.prototype.setImageDpi = function(dpi) {
    if (!(parseInt(dpi) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dpi, "setImageDpi", "html-to-pdf", "Must be a positive integer or 0.", "set_image_dpi"), 470);
    
    this.fields['image_dpi'] = dpi.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_enable_pdf_forms">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_enable_pdf_forms</a>
 */
HtmlToPdfClient.prototype.setEnablePdfForms = function(value) {
    this.fields['enable_pdf_forms'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_linearize">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_linearize</a>
 */
HtmlToPdfClient.prototype.setLinearize = function(value) {
    this.fields['linearize'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_encrypt">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_encrypt</a>
 */
HtmlToPdfClient.prototype.setEncrypt = function(value) {
    this.fields['encrypt'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_user_password">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_user_password</a>
 */
HtmlToPdfClient.prototype.setUserPassword = function(password) {
    this.fields['user_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_owner_password">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_owner_password</a>
 */
HtmlToPdfClient.prototype.setOwnerPassword = function(password) {
    this.fields['owner_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_print">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_print</a>
 */
HtmlToPdfClient.prototype.setNoPrint = function(value) {
    this.fields['no_print'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_modify">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_modify</a>
 */
HtmlToPdfClient.prototype.setNoModify = function(value) {
    this.fields['no_modify'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_copy">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_no_copy</a>
 */
HtmlToPdfClient.prototype.setNoCopy = function(value) {
    this.fields['no_copy'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_title">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_title</a>
 */
HtmlToPdfClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_subject">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_subject</a>
 */
HtmlToPdfClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_author">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_author</a>
 */
HtmlToPdfClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_keywords">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_keywords</a>
 */
HtmlToPdfClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_extract_meta_tags">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_extract_meta_tags</a>
 */
HtmlToPdfClient.prototype.setExtractMetaTags = function(value) {
    this.fields['extract_meta_tags'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_layout">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_layout</a>
 */
HtmlToPdfClient.prototype.setPageLayout = function(layout) {
    if (!layout.match(/^(single-page|one-column|two-column-left|two-column-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(layout, "setPageLayout", "html-to-pdf", "Allowed values are single-page, one-column, two-column-left, two-column-right.", "set_page_layout"), 470);
    
    this.fields['page_layout'] = layout;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_mode">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_page_mode</a>
 */
HtmlToPdfClient.prototype.setPageMode = function(mode) {
    if (!mode.match(/^(full-screen|thumbnails|outlines)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageMode", "html-to-pdf", "Allowed values are full-screen, thumbnails, outlines.", "set_page_mode"), 470);
    
    this.fields['page_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_initial_zoom_type">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_initial_zoom_type</a>
 */
HtmlToPdfClient.prototype.setInitialZoomType = function(zoomType) {
    if (!zoomType.match(/^(fit-width|fit-height|fit-page)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoomType, "setInitialZoomType", "html-to-pdf", "Allowed values are fit-width, fit-height, fit-page.", "set_initial_zoom_type"), 470);
    
    this.fields['initial_zoom_type'] = zoomType;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_initial_page">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_initial_page</a>
 */
HtmlToPdfClient.prototype.setInitialPage = function(page) {
    if (!(parseInt(page) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(page, "setInitialPage", "html-to-pdf", "Must be a positive integer.", "set_initial_page"), 470);
    
    this.fields['initial_page'] = page.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_initial_zoom">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_initial_zoom</a>
 */
HtmlToPdfClient.prototype.setInitialZoom = function(zoom) {
    if (!(parseInt(zoom) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoom, "setInitialZoom", "html-to-pdf", "Must be a positive integer.", "set_initial_zoom"), 470);
    
    this.fields['initial_zoom'] = zoom.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_hide_toolbar">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_hide_toolbar</a>
 */
HtmlToPdfClient.prototype.setHideToolbar = function(value) {
    this.fields['hide_toolbar'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_hide_menubar">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_hide_menubar</a>
 */
HtmlToPdfClient.prototype.setHideMenubar = function(value) {
    this.fields['hide_menubar'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_hide_window_ui">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_hide_window_ui</a>
 */
HtmlToPdfClient.prototype.setHideWindowUi = function(value) {
    this.fields['hide_window_ui'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_fit_window">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_fit_window</a>
 */
HtmlToPdfClient.prototype.setFitWindow = function(value) {
    this.fields['fit_window'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_center_window">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_center_window</a>
 */
HtmlToPdfClient.prototype.setCenterWindow = function(value) {
    this.fields['center_window'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_display_title">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_display_title</a>
 */
HtmlToPdfClient.prototype.setDisplayTitle = function(value) {
    this.fields['display_title'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_right_to_left">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_right_to_left</a>
 */
HtmlToPdfClient.prototype.setRightToLeft = function(value) {
    this.fields['right_to_left'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_string">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_string</a>
 */
HtmlToPdfClient.prototype.setDataString = function(dataString) {
    this.fields['data_string'] = dataString;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_file</a>
 */
HtmlToPdfClient.prototype.setDataFile = function(dataFile) {
    this.files['data_file'] = dataFile;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_format">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_format</a>
 */
HtmlToPdfClient.prototype.setDataFormat = function(dataFormat) {
    if (!dataFormat.match(/^(auto|json|xml|yaml|csv)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dataFormat, "setDataFormat", "html-to-pdf", "Allowed values are auto, json, xml, yaml, csv.", "set_data_format"), 470);
    
    this.fields['data_format'] = dataFormat;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_encoding">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_encoding</a>
 */
HtmlToPdfClient.prototype.setDataEncoding = function(encoding) {
    this.fields['data_encoding'] = encoding;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_ignore_undefined">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_ignore_undefined</a>
 */
HtmlToPdfClient.prototype.setDataIgnoreUndefined = function(value) {
    this.fields['data_ignore_undefined'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_auto_escape">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_auto_escape</a>
 */
HtmlToPdfClient.prototype.setDataAutoEscape = function(value) {
    this.fields['data_auto_escape'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_trim_blocks">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_trim_blocks</a>
 */
HtmlToPdfClient.prototype.setDataTrimBlocks = function(value) {
    this.fields['data_trim_blocks'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_variable_markers">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_variable_markers</a>
 */
HtmlToPdfClient.prototype.setDataVariableMarkers = function(markers) {
    if (!markers.match(/^(standard|square|angle)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(markers, "setDataVariableMarkers", "html-to-pdf", "Allowed values are standard, square, angle.", "set_data_variable_markers"), 470);
    
    this.fields['data_variable_markers'] = markers;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_options">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_data_options</a>
 */
HtmlToPdfClient.prototype.setDataOptions = function(options) {
    this.fields['data_options'] = options;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_debug_log</a>
 */
HtmlToPdfClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_debug_log_url</a>
 */
HtmlToPdfClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_remaining_credit_count</a>
 */
HtmlToPdfClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_consumed_credit_count</a>
 */
HtmlToPdfClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_job_id</a>
 */
HtmlToPdfClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_page_count">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_page_count</a>
 */
HtmlToPdfClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_total_page_count">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_total_page_count</a>
 */
HtmlToPdfClient.prototype.getTotalPageCount = function() {
    return this.helper.getTotalPageCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_output_size</a>
 */
HtmlToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_version">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#get_version</a>
 */
HtmlToPdfClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_tag">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_tag</a>
 */
HtmlToPdfClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_http_proxy</a>
 */
HtmlToPdfClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "html-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_https_proxy</a>
 */
HtmlToPdfClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "html-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_client_certificate">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_client_certificate</a>
 */
HtmlToPdfClient.prototype.setClientCertificate = function(certificate) {
    if (!(fs.existsSync(certificate) && fs.statSync(certificate)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(certificate, "setClientCertificate", "html-to-pdf", "The file must exist and not be empty.", "set_client_certificate"), 470);
    
    this.files['client_certificate'] = certificate;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_client_certificate_password">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_client_certificate_password</a>
 */
HtmlToPdfClient.prototype.setClientCertificatePassword = function(password) {
    this.fields['client_certificate_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_layout_dpi">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_layout_dpi</a>
 */
HtmlToPdfClient.prototype.setLayoutDpi = function(dpi) {
    if (!(parseInt(dpi) >= 72 && parseInt(dpi) <= 600))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dpi, "setLayoutDpi", "html-to-pdf", "The accepted range is 72-600.", "set_layout_dpi"), 470);
    
    this.fields['layout_dpi'] = dpi.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_x">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_x</a>
 */
HtmlToPdfClient.prototype.setContentAreaX = function(x) {
    if (!x.match(/^0$|^\-?[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setContentAreaX", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'. It may contain a negative value.", "set_content_area_x"), 470);
    
    this.fields['content_area_x'] = x;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_y">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_y</a>
 */
HtmlToPdfClient.prototype.setContentAreaY = function(y) {
    if (!y.match(/^0$|^\-?[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setContentAreaY", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'. It may contain a negative value.", "set_content_area_y"), 470);
    
    this.fields['content_area_y'] = y;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_width">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_width</a>
 */
HtmlToPdfClient.prototype.setContentAreaWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setContentAreaWidth", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_content_area_width"), 470);
    
    this.fields['content_area_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_height">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area_height</a>
 */
HtmlToPdfClient.prototype.setContentAreaHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setContentAreaHeight", "html-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_content_area_height"), 470);
    
    this.fields['content_area_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_content_area</a>
 */
HtmlToPdfClient.prototype.setContentArea = function(x, y, width, height) {
    this.setContentAreaX(x);
    this.setContentAreaY(y);
    this.setContentAreaWidth(width);
    this.setContentAreaHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_contents_matrix">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_contents_matrix</a>
 */
HtmlToPdfClient.prototype.setContentsMatrix = function(matrix) {
    this.fields['contents_matrix'] = matrix;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_matrix">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_matrix</a>
 */
HtmlToPdfClient.prototype.setHeaderMatrix = function(matrix) {
    this.fields['header_matrix'] = matrix;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_matrix">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_footer_matrix</a>
 */
HtmlToPdfClient.prototype.setFooterMatrix = function(matrix) {
    this.fields['footer_matrix'] = matrix;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_page_height_optimization">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_disable_page_height_optimization</a>
 */
HtmlToPdfClient.prototype.setDisablePageHeightOptimization = function(value) {
    this.fields['disable_page_height_optimization'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_main_document_css_annotation">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_main_document_css_annotation</a>
 */
HtmlToPdfClient.prototype.setMainDocumentCssAnnotation = function(value) {
    this.fields['main_document_css_annotation'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_footer_css_annotation">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_header_footer_css_annotation</a>
 */
HtmlToPdfClient.prototype.setHeaderFooterCssAnnotation = function(value) {
    this.fields['header_footer_css_annotation'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_max_loading_time">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_max_loading_time</a>
 */
HtmlToPdfClient.prototype.setMaxLoadingTime = function(maxTime) {
    if (!(parseInt(maxTime) >= 10 && parseInt(maxTime) <= 30))
        throw new Pdfcrowd.Error(createInvalidValueMessage(maxTime, "setMaxLoadingTime", "html-to-pdf", "The accepted range is 10-30.", "set_max_loading_time"), 470);
    
    this.fields['max_loading_time'] = maxTime.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_conversion_config">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_conversion_config</a>
 */
HtmlToPdfClient.prototype.setConversionConfig = function(jsonString) {
    this.fields['conversion_config'] = jsonString;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_conversion_config_file">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_conversion_config_file</a>
 */
HtmlToPdfClient.prototype.setConversionConfigFile = function(filepath) {
    if (!(fs.existsSync(filepath) && fs.statSync(filepath)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filepath, "setConversionConfigFile", "html-to-pdf", "The file must exist and not be empty.", "set_conversion_config_file"), 470);
    
    this.files['conversion_config_file'] = filepath;
    return this;
};


HtmlToPdfClient.prototype.setSubprocessReferrer = function(referrer) {
    this.fields['subprocess_referrer'] = referrer;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_converter_user_agent">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_converter_user_agent</a>
 */
HtmlToPdfClient.prototype.setConverterUserAgent = function(agent) {
    this.fields['converter_user_agent'] = agent;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_converter_version">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_converter_version</a>
 */
HtmlToPdfClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(24.04|20.10|18.10|latest)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "html-to-pdf", "Allowed values are 24.04, 20.10, 18.10, latest.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_use_http</a>
 */
HtmlToPdfClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_client_user_agent</a>
 */
HtmlToPdfClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_user_agent</a>
 */
HtmlToPdfClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_proxy</a>
 */
HtmlToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/#set_retry_count</a>
 */
HtmlToPdfClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from HTML to image.
 *
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/">https://pdfcrowd.com/api/html-to-image-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#HtmlToImageClient">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#HtmlToImageClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_output_format">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_output_format</a>
 */
HtmlToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "setOutputFormat", "html-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_url">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_url</a>
 */
HtmlToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "html-to-image", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_url_to_file</a>
 */
HtmlToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "html-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_file">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_file</a>
 */
HtmlToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "html-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_file_to_file</a>
 */
HtmlToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "html-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_string">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_string</a>
 */
HtmlToImageClient.prototype.convertString = function(text, callbacks) {
    if (!(text))
        return callbacks.error(createInvalidValueMessage(text, "convertString", "html-to-image", "The string must not be empty.", "convert_string"), 470);
    
    this.fields['text'] = text;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_string_to_file">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_string_to_file</a>
 */
HtmlToImageClient.prototype.convertStringToFile = function(text, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStringToFile::file_path", "html-to-image", "The string must not be empty.", "convert_string_to_file"), 470);
    
    this.convertString(text, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_stream</a>
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
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#convert_stream_to_file</a>
 */
HtmlToImageClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "html-to-image", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_zip_main_filename">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_zip_main_filename</a>
 */
HtmlToImageClient.prototype.setZipMainFilename = function(filename) {
    this.fields['zip_main_filename'] = filename;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_screenshot_width">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_screenshot_width</a>
 */
HtmlToImageClient.prototype.setScreenshotWidth = function(width) {
    if (!(parseInt(width) >= 96 && parseInt(width) <= 65000))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setScreenshotWidth", "html-to-image", "The accepted range is 96-65000.", "set_screenshot_width"), 470);
    
    this.fields['screenshot_width'] = width.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_screenshot_height">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_screenshot_height</a>
 */
HtmlToImageClient.prototype.setScreenshotHeight = function(height) {
    if (!(parseInt(height) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setScreenshotHeight", "html-to-image", "Must be a positive integer.", "set_screenshot_height"), 470);
    
    this.fields['screenshot_height'] = height.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_scale_factor">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_scale_factor</a>
 */
HtmlToImageClient.prototype.setScaleFactor = function(factor) {
    if (!(parseInt(factor) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setScaleFactor", "html-to-image", "Must be a positive integer.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = factor.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_background_color">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_background_color</a>
 */
HtmlToImageClient.prototype.setBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setBackgroundColor", "html-to-image", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_background_color"), 470);
    
    this.fields['background_color'] = color;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_use_print_media">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_use_print_media</a>
 */
HtmlToImageClient.prototype.setUsePrintMedia = function(value) {
    this.fields['use_print_media'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_no_background">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_no_background</a>
 */
HtmlToImageClient.prototype.setNoBackground = function(value) {
    this.fields['no_background'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_disable_javascript">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_disable_javascript</a>
 */
HtmlToImageClient.prototype.setDisableJavascript = function(value) {
    this.fields['disable_javascript'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_disable_image_loading">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_disable_image_loading</a>
 */
HtmlToImageClient.prototype.setDisableImageLoading = function(value) {
    this.fields['disable_image_loading'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_disable_remote_fonts">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_disable_remote_fonts</a>
 */
HtmlToImageClient.prototype.setDisableRemoteFonts = function(value) {
    this.fields['disable_remote_fonts'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_use_mobile_user_agent">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_use_mobile_user_agent</a>
 */
HtmlToImageClient.prototype.setUseMobileUserAgent = function(value) {
    this.fields['use_mobile_user_agent'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_load_iframes">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_load_iframes</a>
 */
HtmlToImageClient.prototype.setLoadIframes = function(iframes) {
    if (!iframes.match(/^(all|same-origin|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(iframes, "setLoadIframes", "html-to-image", "Allowed values are all, same-origin, none.", "set_load_iframes"), 470);
    
    this.fields['load_iframes'] = iframes;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_block_ads">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_block_ads</a>
 */
HtmlToImageClient.prototype.setBlockAds = function(value) {
    this.fields['block_ads'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_default_encoding">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_default_encoding</a>
 */
HtmlToImageClient.prototype.setDefaultEncoding = function(encoding) {
    this.fields['default_encoding'] = encoding;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_locale">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_locale</a>
 */
HtmlToImageClient.prototype.setLocale = function(locale) {
    this.fields['locale'] = locale;
    return this;
};


HtmlToImageClient.prototype.setHttpAuthUserName = function(userName) {
    this.fields['http_auth_user_name'] = userName;
    return this;
};


HtmlToImageClient.prototype.setHttpAuthPassword = function(password) {
    this.fields['http_auth_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_http_auth">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_http_auth</a>
 */
HtmlToImageClient.prototype.setHttpAuth = function(userName, password) {
    this.setHttpAuthUserName(userName);
    this.setHttpAuthPassword(password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_cookies">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_cookies</a>
 */
HtmlToImageClient.prototype.setCookies = function(cookies) {
    this.fields['cookies'] = cookies;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_verify_ssl_certificates">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_verify_ssl_certificates</a>
 */
HtmlToImageClient.prototype.setVerifySslCertificates = function(value) {
    this.fields['verify_ssl_certificates'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_fail_on_main_url_error">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_fail_on_main_url_error</a>
 */
HtmlToImageClient.prototype.setFailOnMainUrlError = function(failOnError) {
    this.fields['fail_on_main_url_error'] = failOnError;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_fail_on_any_url_error">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_fail_on_any_url_error</a>
 */
HtmlToImageClient.prototype.setFailOnAnyUrlError = function(failOnError) {
    this.fields['fail_on_any_url_error'] = failOnError;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_no_xpdfcrowd_header">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_no_xpdfcrowd_header</a>
 */
HtmlToImageClient.prototype.setNoXpdfcrowdHeader = function(value) {
    this.fields['no_xpdfcrowd_header'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_custom_css">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_custom_css</a>
 */
HtmlToImageClient.prototype.setCustomCss = function(css) {
    if (!(css))
        throw new Pdfcrowd.Error(createInvalidValueMessage(css, "setCustomCss", "html-to-image", "The string must not be empty.", "set_custom_css"), 470);
    
    this.fields['custom_css'] = css;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_custom_javascript">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_custom_javascript</a>
 */
HtmlToImageClient.prototype.setCustomJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setCustomJavascript", "html-to-image", "The string must not be empty.", "set_custom_javascript"), 470);
    
    this.fields['custom_javascript'] = javascript;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_on_load_javascript">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_on_load_javascript</a>
 */
HtmlToImageClient.prototype.setOnLoadJavascript = function(javascript) {
    if (!(javascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascript, "setOnLoadJavascript", "html-to-image", "The string must not be empty.", "set_on_load_javascript"), 470);
    
    this.fields['on_load_javascript'] = javascript;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_custom_http_header">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_custom_http_header</a>
 */
HtmlToImageClient.prototype.setCustomHttpHeader = function(header) {
    if (!header.match(/^.+:.+$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(header, "setCustomHttpHeader", "html-to-image", "A string containing the header name and value separated by a colon.", "set_custom_http_header"), 470);
    
    this.fields['custom_http_header'] = header;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_javascript_delay">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_javascript_delay</a>
 */
HtmlToImageClient.prototype.setJavascriptDelay = function(delay) {
    if (!(parseInt(delay) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(delay, "setJavascriptDelay", "html-to-image", "Must be a positive integer or 0.", "set_javascript_delay"), 470);
    
    this.fields['javascript_delay'] = delay.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_element_to_convert">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_element_to_convert</a>
 */
HtmlToImageClient.prototype.setElementToConvert = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setElementToConvert", "html-to-image", "The string must not be empty.", "set_element_to_convert"), 470);
    
    this.fields['element_to_convert'] = selectors;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_element_to_convert_mode">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_element_to_convert_mode</a>
 */
HtmlToImageClient.prototype.setElementToConvertMode = function(mode) {
    if (!mode.match(/^(cut-out|remove-siblings|hide-siblings)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setElementToConvertMode", "html-to-image", "Allowed values are cut-out, remove-siblings, hide-siblings.", "set_element_to_convert_mode"), 470);
    
    this.fields['element_to_convert_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_wait_for_element">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_wait_for_element</a>
 */
HtmlToImageClient.prototype.setWaitForElement = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "setWaitForElement", "html-to-image", "The string must not be empty.", "set_wait_for_element"), 470);
    
    this.fields['wait_for_element'] = selectors;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_auto_detect_element_to_convert">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_auto_detect_element_to_convert</a>
 */
HtmlToImageClient.prototype.setAutoDetectElementToConvert = function(value) {
    this.fields['auto_detect_element_to_convert'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_readability_enhancements">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_readability_enhancements</a>
 */
HtmlToImageClient.prototype.setReadabilityEnhancements = function(enhancements) {
    if (!enhancements.match(/^(none|readability-v1|readability-v2|readability-v3|readability-v4)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(enhancements, "setReadabilityEnhancements", "html-to-image", "Allowed values are none, readability-v1, readability-v2, readability-v3, readability-v4.", "set_readability_enhancements"), 470);
    
    this.fields['readability_enhancements'] = enhancements;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_string">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_string</a>
 */
HtmlToImageClient.prototype.setDataString = function(dataString) {
    this.fields['data_string'] = dataString;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_file">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_file</a>
 */
HtmlToImageClient.prototype.setDataFile = function(dataFile) {
    this.files['data_file'] = dataFile;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_format">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_format</a>
 */
HtmlToImageClient.prototype.setDataFormat = function(dataFormat) {
    if (!dataFormat.match(/^(auto|json|xml|yaml|csv)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(dataFormat, "setDataFormat", "html-to-image", "Allowed values are auto, json, xml, yaml, csv.", "set_data_format"), 470);
    
    this.fields['data_format'] = dataFormat;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_encoding">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_encoding</a>
 */
HtmlToImageClient.prototype.setDataEncoding = function(encoding) {
    this.fields['data_encoding'] = encoding;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_ignore_undefined">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_ignore_undefined</a>
 */
HtmlToImageClient.prototype.setDataIgnoreUndefined = function(value) {
    this.fields['data_ignore_undefined'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_auto_escape">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_auto_escape</a>
 */
HtmlToImageClient.prototype.setDataAutoEscape = function(value) {
    this.fields['data_auto_escape'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_trim_blocks">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_trim_blocks</a>
 */
HtmlToImageClient.prototype.setDataTrimBlocks = function(value) {
    this.fields['data_trim_blocks'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_variable_markers">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_variable_markers</a>
 */
HtmlToImageClient.prototype.setDataVariableMarkers = function(markers) {
    if (!markers.match(/^(standard|square|angle)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(markers, "setDataVariableMarkers", "html-to-image", "Allowed values are standard, square, angle.", "set_data_variable_markers"), 470);
    
    this.fields['data_variable_markers'] = markers;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_options">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_data_options</a>
 */
HtmlToImageClient.prototype.setDataOptions = function(options) {
    this.fields['data_options'] = options;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_debug_log</a>
 */
HtmlToImageClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_debug_log_url</a>
 */
HtmlToImageClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_remaining_credit_count</a>
 */
HtmlToImageClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_consumed_credit_count</a>
 */
HtmlToImageClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_job_id</a>
 */
HtmlToImageClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_output_size</a>
 */
HtmlToImageClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_version">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#get_version</a>
 */
HtmlToImageClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_tag">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_tag</a>
 */
HtmlToImageClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_http_proxy</a>
 */
HtmlToImageClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "html-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_https_proxy</a>
 */
HtmlToImageClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "html-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_client_certificate">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_client_certificate</a>
 */
HtmlToImageClient.prototype.setClientCertificate = function(certificate) {
    if (!(fs.existsSync(certificate) && fs.statSync(certificate)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(certificate, "setClientCertificate", "html-to-image", "The file must exist and not be empty.", "set_client_certificate"), 470);
    
    this.files['client_certificate'] = certificate;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_client_certificate_password">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_client_certificate_password</a>
 */
HtmlToImageClient.prototype.setClientCertificatePassword = function(password) {
    this.fields['client_certificate_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_max_loading_time">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_max_loading_time</a>
 */
HtmlToImageClient.prototype.setMaxLoadingTime = function(maxTime) {
    if (!(parseInt(maxTime) >= 10 && parseInt(maxTime) <= 30))
        throw new Pdfcrowd.Error(createInvalidValueMessage(maxTime, "setMaxLoadingTime", "html-to-image", "The accepted range is 10-30.", "set_max_loading_time"), 470);
    
    this.fields['max_loading_time'] = maxTime.toString();
    return this;
};


HtmlToImageClient.prototype.setSubprocessReferrer = function(referrer) {
    this.fields['subprocess_referrer'] = referrer;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_converter_user_agent">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_converter_user_agent</a>
 */
HtmlToImageClient.prototype.setConverterUserAgent = function(agent) {
    this.fields['converter_user_agent'] = agent;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_converter_version">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_converter_version</a>
 */
HtmlToImageClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(24.04|20.10|18.10|latest)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "html-to-image", "Allowed values are 24.04, 20.10, 18.10, latest.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_use_http</a>
 */
HtmlToImageClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_client_user_agent</a>
 */
HtmlToImageClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_user_agent</a>
 */
HtmlToImageClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_proxy</a>
 */
HtmlToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/html-to-image-nodejs/ref/#set_retry_count</a>
 */
HtmlToImageClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from one image format to another image format.
 *
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/">https://pdfcrowd.com/api/image-to-image-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#ImageToImageClient">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#ImageToImageClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_url">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_url</a>
 */
ImageToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "image-to-image", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_url_to_file</a>
 */
ImageToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "image-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_file">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_file</a>
 */
ImageToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "image-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_file_to_file</a>
 */
ImageToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "image-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_raw_data">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_raw_data</a>
 */
ImageToImageClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_raw_data_to_file">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_raw_data_to_file</a>
 */
ImageToImageClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "image-to-image", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_stream</a>
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
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#convert_stream_to_file</a>
 */
ImageToImageClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "image-to-image", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_output_format">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_output_format</a>
 */
ImageToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "setOutputFormat", "image-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_resize">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_resize</a>
 */
ImageToImageClient.prototype.setResize = function(resize) {
    this.fields['resize'] = resize;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_rotate">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_rotate</a>
 */
ImageToImageClient.prototype.setRotate = function(rotate) {
    this.fields['rotate'] = rotate;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_x">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_x</a>
 */
ImageToImageClient.prototype.setCropAreaX = function(x) {
    if (!x.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_y">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_y</a>
 */
ImageToImageClient.prototype.setCropAreaY = function(y) {
    if (!y.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_width">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_width</a>
 */
ImageToImageClient.prototype.setCropAreaWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_height">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area_height</a>
 */
ImageToImageClient.prototype.setCropAreaHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_crop_area</a>
 */
ImageToImageClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_remove_borders">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_remove_borders</a>
 */
ImageToImageClient.prototype.setRemoveBorders = function(value) {
    this.fields['remove_borders'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_size">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_size</a>
 */
ImageToImageClient.prototype.setCanvasSize = function(size) {
    if (!size.match(/^(A0|A1|A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(size, "setCanvasSize", "image-to-image", "Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.", "set_canvas_size"), 470);
    
    this.fields['canvas_size'] = size;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_width">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_width</a>
 */
ImageToImageClient.prototype.setCanvasWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCanvasWidth", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_canvas_width"), 470);
    
    this.fields['canvas_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_height">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_height</a>
 */
ImageToImageClient.prototype.setCanvasHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCanvasHeight", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_canvas_height"), 470);
    
    this.fields['canvas_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_dimensions">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_dimensions</a>
 */
ImageToImageClient.prototype.setCanvasDimensions = function(width, height) {
    this.setCanvasWidth(width);
    this.setCanvasHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_orientation">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_orientation</a>
 */
ImageToImageClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "setOrientation", "image-to-image", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_position">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_position</a>
 */
ImageToImageClient.prototype.setPosition = function(position) {
    if (!position.match(/^(center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(position, "setPosition", "image-to-image", "Allowed values are center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right.", "set_position"), 470);
    
    this.fields['position'] = position;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_print_canvas_mode">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_print_canvas_mode</a>
 */
ImageToImageClient.prototype.setPrintCanvasMode = function(mode) {
    if (!mode.match(/^(default|fit|stretch)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPrintCanvasMode", "image-to-image", "Allowed values are default, fit, stretch.", "set_print_canvas_mode"), 470);
    
    this.fields['print_canvas_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_top">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_top</a>
 */
ImageToImageClient.prototype.setMarginTop = function(top) {
    if (!top.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(top, "setMarginTop", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_top"), 470);
    
    this.fields['margin_top'] = top;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_right">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_right</a>
 */
ImageToImageClient.prototype.setMarginRight = function(right) {
    if (!right.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(right, "setMarginRight", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_right"), 470);
    
    this.fields['margin_right'] = right;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_bottom">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_bottom</a>
 */
ImageToImageClient.prototype.setMarginBottom = function(bottom) {
    if (!bottom.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(bottom, "setMarginBottom", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = bottom;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_left">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margin_left</a>
 */
ImageToImageClient.prototype.setMarginLeft = function(left) {
    if (!left.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(left, "setMarginLeft", "image-to-image", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_left"), 470);
    
    this.fields['margin_left'] = left;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margins">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_margins</a>
 */
ImageToImageClient.prototype.setMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_background_color">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_canvas_background_color</a>
 */
ImageToImageClient.prototype.setCanvasBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setCanvasBackgroundColor", "image-to-image", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_canvas_background_color"), 470);
    
    this.fields['canvas_background_color'] = color;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_dpi">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_dpi</a>
 */
ImageToImageClient.prototype.setDpi = function(dpi) {
    this.fields['dpi'] = dpi.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_debug_log</a>
 */
ImageToImageClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_debug_log_url</a>
 */
ImageToImageClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_remaining_credit_count</a>
 */
ImageToImageClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_consumed_credit_count</a>
 */
ImageToImageClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_job_id</a>
 */
ImageToImageClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_output_size</a>
 */
ImageToImageClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_version">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#get_version</a>
 */
ImageToImageClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_tag">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_tag</a>
 */
ImageToImageClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_http_proxy</a>
 */
ImageToImageClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "image-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_https_proxy</a>
 */
ImageToImageClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "image-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_converter_version">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_converter_version</a>
 */
ImageToImageClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(24.04|20.10|18.10|latest)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "image-to-image", "Allowed values are 24.04, 20.10, 18.10, latest.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_use_http</a>
 */
ImageToImageClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_client_user_agent</a>
 */
ImageToImageClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_user_agent</a>
 */
ImageToImageClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_proxy</a>
 */
ImageToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/image-to-image-nodejs/ref/#set_retry_count</a>
 */
ImageToImageClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from PDF to PDF.
 *
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#PdfToPdfClient">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#PdfToPdfClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_action">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_action</a>
 */
PdfToPdfClient.prototype.setAction = function(action) {
    if (!action.match(/^(join|shuffle|extract|delete)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(action, "setAction", "pdf-to-pdf", "Allowed values are join, shuffle, extract, delete.", "set_action"), 470);
    
    this.fields['action'] = action;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#convert">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#convert</a>
 */
PdfToPdfClient.prototype.convert = function(callbacks) {
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#convert_to_file">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#convert_to_file</a>
 */
PdfToPdfClient.prototype.convertToFile = function(filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertToFile", "pdf-to-pdf", "The string must not be empty.", "convert_to_file"), 470);
    
    this.convert(saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#add_pdf_file">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#add_pdf_file</a>
 */
PdfToPdfClient.prototype.addPdfFile = function(filePath) {
    if (!(fs.existsSync(filePath) && fs.statSync(filePath)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "addPdfFile", "pdf-to-pdf", "The file must exist and not be empty.", "add_pdf_file"), 470);
    
    this.files['f_' + this.fileId] = filePath;
    this.fileId++;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#add_pdf_raw_data">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#add_pdf_raw_data</a>
 */
PdfToPdfClient.prototype.addPdfRawData = function(data) {
    if (!(data && data.length > 300 && data.slice(0, 4) == '%PDF'))
        throw new Pdfcrowd.Error(createInvalidValueMessage("raw PDF data", "addPdfRawData", "pdf-to-pdf", "The input data must be PDF content.", "add_pdf_raw_data"), 470);
    
    this.rawData['f_' + this.fileId] = data;
    this.fileId++;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_input_pdf_password">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_input_pdf_password</a>
 */
PdfToPdfClient.prototype.setInputPdfPassword = function(password) {
    this.fields['input_pdf_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_range">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_range</a>
 */
PdfToPdfClient.prototype.setPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPageRange", "pdf-to-pdf", "A comma separated list of page numbers or ranges.", "set_page_range"), 470);
    
    this.fields['page_range'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_watermark">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_watermark</a>
 */
PdfToPdfClient.prototype.setPageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setPageWatermark", "pdf-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = watermark;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_watermark_url">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_watermark_url</a>
 */
PdfToPdfClient.prototype.setPageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageWatermarkUrl", "pdf-to-pdf", "Supported protocols are http:// and https://.", "set_page_watermark_url"), 470);
    
    this.fields['page_watermark_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_watermark">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_watermark</a>
 */
PdfToPdfClient.prototype.setMultipageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setMultipageWatermark", "pdf-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = watermark;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_watermark_url">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_watermark_url</a>
 */
PdfToPdfClient.prototype.setMultipageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageWatermarkUrl", "pdf-to-pdf", "Supported protocols are http:// and https://.", "set_multipage_watermark_url"), 470);
    
    this.fields['multipage_watermark_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_background">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_background</a>
 */
PdfToPdfClient.prototype.setPageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setPageBackground", "pdf-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = background;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_background_url">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_background_url</a>
 */
PdfToPdfClient.prototype.setPageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageBackgroundUrl", "pdf-to-pdf", "Supported protocols are http:// and https://.", "set_page_background_url"), 470);
    
    this.fields['page_background_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_background">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_background</a>
 */
PdfToPdfClient.prototype.setMultipageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setMultipageBackground", "pdf-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = background;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_background_url">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_multipage_background_url</a>
 */
PdfToPdfClient.prototype.setMultipageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageBackgroundUrl", "pdf-to-pdf", "Supported protocols are http:// and https://.", "set_multipage_background_url"), 470);
    
    this.fields['multipage_background_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_linearize">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_linearize</a>
 */
PdfToPdfClient.prototype.setLinearize = function(value) {
    this.fields['linearize'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_encrypt">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_encrypt</a>
 */
PdfToPdfClient.prototype.setEncrypt = function(value) {
    this.fields['encrypt'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_user_password">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_user_password</a>
 */
PdfToPdfClient.prototype.setUserPassword = function(password) {
    this.fields['user_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_owner_password">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_owner_password</a>
 */
PdfToPdfClient.prototype.setOwnerPassword = function(password) {
    this.fields['owner_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_no_print">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_no_print</a>
 */
PdfToPdfClient.prototype.setNoPrint = function(value) {
    this.fields['no_print'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_no_modify">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_no_modify</a>
 */
PdfToPdfClient.prototype.setNoModify = function(value) {
    this.fields['no_modify'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_no_copy">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_no_copy</a>
 */
PdfToPdfClient.prototype.setNoCopy = function(value) {
    this.fields['no_copy'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_title">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_title</a>
 */
PdfToPdfClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_subject">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_subject</a>
 */
PdfToPdfClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_author">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_author</a>
 */
PdfToPdfClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_keywords">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_keywords</a>
 */
PdfToPdfClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_use_metadata_from">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_use_metadata_from</a>
 */
PdfToPdfClient.prototype.setUseMetadataFrom = function(index) {
    if (!(parseInt(index) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(index, "setUseMetadataFrom", "pdf-to-pdf", "Must be a positive integer or 0.", "set_use_metadata_from"), 470);
    
    this.fields['use_metadata_from'] = index.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_layout">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_layout</a>
 */
PdfToPdfClient.prototype.setPageLayout = function(layout) {
    if (!layout.match(/^(single-page|one-column|two-column-left|two-column-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(layout, "setPageLayout", "pdf-to-pdf", "Allowed values are single-page, one-column, two-column-left, two-column-right.", "set_page_layout"), 470);
    
    this.fields['page_layout'] = layout;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_mode">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_page_mode</a>
 */
PdfToPdfClient.prototype.setPageMode = function(mode) {
    if (!mode.match(/^(full-screen|thumbnails|outlines)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageMode", "pdf-to-pdf", "Allowed values are full-screen, thumbnails, outlines.", "set_page_mode"), 470);
    
    this.fields['page_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_initial_zoom_type">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_initial_zoom_type</a>
 */
PdfToPdfClient.prototype.setInitialZoomType = function(zoomType) {
    if (!zoomType.match(/^(fit-width|fit-height|fit-page)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoomType, "setInitialZoomType", "pdf-to-pdf", "Allowed values are fit-width, fit-height, fit-page.", "set_initial_zoom_type"), 470);
    
    this.fields['initial_zoom_type'] = zoomType;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_initial_page">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_initial_page</a>
 */
PdfToPdfClient.prototype.setInitialPage = function(page) {
    if (!(parseInt(page) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(page, "setInitialPage", "pdf-to-pdf", "Must be a positive integer.", "set_initial_page"), 470);
    
    this.fields['initial_page'] = page.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_initial_zoom">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_initial_zoom</a>
 */
PdfToPdfClient.prototype.setInitialZoom = function(zoom) {
    if (!(parseInt(zoom) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoom, "setInitialZoom", "pdf-to-pdf", "Must be a positive integer.", "set_initial_zoom"), 470);
    
    this.fields['initial_zoom'] = zoom.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_hide_toolbar">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_hide_toolbar</a>
 */
PdfToPdfClient.prototype.setHideToolbar = function(value) {
    this.fields['hide_toolbar'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_hide_menubar">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_hide_menubar</a>
 */
PdfToPdfClient.prototype.setHideMenubar = function(value) {
    this.fields['hide_menubar'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_hide_window_ui">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_hide_window_ui</a>
 */
PdfToPdfClient.prototype.setHideWindowUi = function(value) {
    this.fields['hide_window_ui'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_fit_window">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_fit_window</a>
 */
PdfToPdfClient.prototype.setFitWindow = function(value) {
    this.fields['fit_window'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_center_window">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_center_window</a>
 */
PdfToPdfClient.prototype.setCenterWindow = function(value) {
    this.fields['center_window'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_display_title">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_display_title</a>
 */
PdfToPdfClient.prototype.setDisplayTitle = function(value) {
    this.fields['display_title'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_right_to_left">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_right_to_left</a>
 */
PdfToPdfClient.prototype.setRightToLeft = function(value) {
    this.fields['right_to_left'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_debug_log</a>
 */
PdfToPdfClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_debug_log_url</a>
 */
PdfToPdfClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_remaining_credit_count</a>
 */
PdfToPdfClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_consumed_credit_count</a>
 */
PdfToPdfClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_job_id</a>
 */
PdfToPdfClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_page_count">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_page_count</a>
 */
PdfToPdfClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_output_size</a>
 */
PdfToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_version">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#get_version</a>
 */
PdfToPdfClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_tag">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_tag</a>
 */
PdfToPdfClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_converter_version">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_converter_version</a>
 */
PdfToPdfClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(24.04|20.10|18.10|latest)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "pdf-to-pdf", "Allowed values are 24.04, 20.10, 18.10, latest.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_use_http</a>
 */
PdfToPdfClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_client_user_agent</a>
 */
PdfToPdfClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_user_agent</a>
 */
PdfToPdfClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_proxy</a>
 */
PdfToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/pdf-to-pdf-nodejs/ref/#set_retry_count</a>
 */
PdfToPdfClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from an image to PDF.
 *
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/">https://pdfcrowd.com/api/image-to-pdf-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#ImageToPdfClient">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#ImageToPdfClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_url">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_url</a>
 */
ImageToPdfClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "image-to-pdf", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_url_to_file</a>
 */
ImageToPdfClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_file">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_file</a>
 */
ImageToPdfClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "image-to-pdf", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_file_to_file</a>
 */
ImageToPdfClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_raw_data">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_raw_data</a>
 */
ImageToPdfClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_raw_data_to_file">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_raw_data_to_file</a>
 */
ImageToPdfClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_stream</a>
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
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#convert_stream_to_file</a>
 */
ImageToPdfClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "image-to-pdf", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_resize">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_resize</a>
 */
ImageToPdfClient.prototype.setResize = function(resize) {
    this.fields['resize'] = resize;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_rotate">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_rotate</a>
 */
ImageToPdfClient.prototype.setRotate = function(rotate) {
    this.fields['rotate'] = rotate;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_x">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_x</a>
 */
ImageToPdfClient.prototype.setCropAreaX = function(x) {
    if (!x.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_y">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_y</a>
 */
ImageToPdfClient.prototype.setCropAreaY = function(y) {
    if (!y.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_width">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_width</a>
 */
ImageToPdfClient.prototype.setCropAreaWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_height">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area_height</a>
 */
ImageToPdfClient.prototype.setCropAreaHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_crop_area</a>
 */
ImageToPdfClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_remove_borders">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_remove_borders</a>
 */
ImageToPdfClient.prototype.setRemoveBorders = function(value) {
    this.fields['remove_borders'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_size">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_size</a>
 */
ImageToPdfClient.prototype.setPageSize = function(size) {
    if (!size.match(/^(A0|A1|A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(size, "setPageSize", "image-to-pdf", "Allowed values are A0, A1, A2, A3, A4, A5, A6, Letter.", "set_page_size"), 470);
    
    this.fields['page_size'] = size;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_width">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_width</a>
 */
ImageToPdfClient.prototype.setPageWidth = function(width) {
    if (!width.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setPageWidth", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_page_width"), 470);
    
    this.fields['page_width'] = width;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_height">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_height</a>
 */
ImageToPdfClient.prototype.setPageHeight = function(height) {
    if (!height.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setPageHeight", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_page_height"), 470);
    
    this.fields['page_height'] = height;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_dimensions">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_dimensions</a>
 */
ImageToPdfClient.prototype.setPageDimensions = function(width, height) {
    this.setPageWidth(width);
    this.setPageHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_orientation">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_orientation</a>
 */
ImageToPdfClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "setOrientation", "image-to-pdf", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_position">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_position</a>
 */
ImageToPdfClient.prototype.setPosition = function(position) {
    if (!position.match(/^(center|top|bottom|left|right|top-left|top-right|bottom-left|bottom-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(position, "setPosition", "image-to-pdf", "Allowed values are center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right.", "set_position"), 470);
    
    this.fields['position'] = position;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_print_page_mode">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_print_page_mode</a>
 */
ImageToPdfClient.prototype.setPrintPageMode = function(mode) {
    if (!mode.match(/^(default|fit|stretch)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPrintPageMode", "image-to-pdf", "Allowed values are default, fit, stretch.", "set_print_page_mode"), 470);
    
    this.fields['print_page_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_top">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_top</a>
 */
ImageToPdfClient.prototype.setMarginTop = function(top) {
    if (!top.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(top, "setMarginTop", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_top"), 470);
    
    this.fields['margin_top'] = top;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_right">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_right</a>
 */
ImageToPdfClient.prototype.setMarginRight = function(right) {
    if (!right.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(right, "setMarginRight", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_right"), 470);
    
    this.fields['margin_right'] = right;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_bottom">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_bottom</a>
 */
ImageToPdfClient.prototype.setMarginBottom = function(bottom) {
    if (!bottom.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(bottom, "setMarginBottom", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = bottom;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_left">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_margin_left</a>
 */
ImageToPdfClient.prototype.setMarginLeft = function(left) {
    if (!left.match(/^0$|^[0-9]*\.?[0-9]+(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(left, "setMarginLeft", "image-to-pdf", "The value must be specified in inches 'in', millimeters 'mm', centimeters 'cm', pixels 'px', or points 'pt'.", "set_margin_left"), 470);
    
    this.fields['margin_left'] = left;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_margins">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_margins</a>
 */
ImageToPdfClient.prototype.setPageMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_background_color">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_background_color</a>
 */
ImageToPdfClient.prototype.setPageBackgroundColor = function(color) {
    if (!color.match(/^[0-9a-fA-F]{6,8}$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(color, "setPageBackgroundColor", "image-to-pdf", "The value must be in RRGGBB or RRGGBBAA hexadecimal format.", "set_page_background_color"), 470);
    
    this.fields['page_background_color'] = color;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_dpi">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_dpi</a>
 */
ImageToPdfClient.prototype.setDpi = function(dpi) {
    this.fields['dpi'] = dpi.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_watermark">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_watermark</a>
 */
ImageToPdfClient.prototype.setPageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setPageWatermark", "image-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = watermark;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_watermark_url">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_watermark_url</a>
 */
ImageToPdfClient.prototype.setPageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageWatermarkUrl", "image-to-pdf", "Supported protocols are http:// and https://.", "set_page_watermark_url"), 470);
    
    this.fields['page_watermark_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_watermark">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_watermark</a>
 */
ImageToPdfClient.prototype.setMultipageWatermark = function(watermark) {
    if (!(fs.existsSync(watermark) && fs.statSync(watermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(watermark, "setMultipageWatermark", "image-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = watermark;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_watermark_url">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_watermark_url</a>
 */
ImageToPdfClient.prototype.setMultipageWatermarkUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageWatermarkUrl", "image-to-pdf", "Supported protocols are http:// and https://.", "set_multipage_watermark_url"), 470);
    
    this.fields['multipage_watermark_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_background">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_background</a>
 */
ImageToPdfClient.prototype.setPageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setPageBackground", "image-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = background;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_background_url">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_background_url</a>
 */
ImageToPdfClient.prototype.setPageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setPageBackgroundUrl", "image-to-pdf", "Supported protocols are http:// and https://.", "set_page_background_url"), 470);
    
    this.fields['page_background_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_background">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_background</a>
 */
ImageToPdfClient.prototype.setMultipageBackground = function(background) {
    if (!(fs.existsSync(background) && fs.statSync(background)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(background, "setMultipageBackground", "image-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = background;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_background_url">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_multipage_background_url</a>
 */
ImageToPdfClient.prototype.setMultipageBackgroundUrl = function(url) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "setMultipageBackgroundUrl", "image-to-pdf", "Supported protocols are http:// and https://.", "set_multipage_background_url"), 470);
    
    this.fields['multipage_background_url'] = url;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_linearize">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_linearize</a>
 */
ImageToPdfClient.prototype.setLinearize = function(value) {
    this.fields['linearize'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_encrypt">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_encrypt</a>
 */
ImageToPdfClient.prototype.setEncrypt = function(value) {
    this.fields['encrypt'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_user_password">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_user_password</a>
 */
ImageToPdfClient.prototype.setUserPassword = function(password) {
    this.fields['user_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_owner_password">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_owner_password</a>
 */
ImageToPdfClient.prototype.setOwnerPassword = function(password) {
    this.fields['owner_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_no_print">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_no_print</a>
 */
ImageToPdfClient.prototype.setNoPrint = function(value) {
    this.fields['no_print'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_no_modify">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_no_modify</a>
 */
ImageToPdfClient.prototype.setNoModify = function(value) {
    this.fields['no_modify'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_no_copy">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_no_copy</a>
 */
ImageToPdfClient.prototype.setNoCopy = function(value) {
    this.fields['no_copy'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_title">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_title</a>
 */
ImageToPdfClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_subject">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_subject</a>
 */
ImageToPdfClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_author">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_author</a>
 */
ImageToPdfClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_keywords">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_keywords</a>
 */
ImageToPdfClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_layout">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_layout</a>
 */
ImageToPdfClient.prototype.setPageLayout = function(layout) {
    if (!layout.match(/^(single-page|one-column|two-column-left|two-column-right)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(layout, "setPageLayout", "image-to-pdf", "Allowed values are single-page, one-column, two-column-left, two-column-right.", "set_page_layout"), 470);
    
    this.fields['page_layout'] = layout;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_mode">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_page_mode</a>
 */
ImageToPdfClient.prototype.setPageMode = function(mode) {
    if (!mode.match(/^(full-screen|thumbnails|outlines)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageMode", "image-to-pdf", "Allowed values are full-screen, thumbnails, outlines.", "set_page_mode"), 470);
    
    this.fields['page_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_initial_zoom_type">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_initial_zoom_type</a>
 */
ImageToPdfClient.prototype.setInitialZoomType = function(zoomType) {
    if (!zoomType.match(/^(fit-width|fit-height|fit-page)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoomType, "setInitialZoomType", "image-to-pdf", "Allowed values are fit-width, fit-height, fit-page.", "set_initial_zoom_type"), 470);
    
    this.fields['initial_zoom_type'] = zoomType;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_initial_page">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_initial_page</a>
 */
ImageToPdfClient.prototype.setInitialPage = function(page) {
    if (!(parseInt(page) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(page, "setInitialPage", "image-to-pdf", "Must be a positive integer.", "set_initial_page"), 470);
    
    this.fields['initial_page'] = page.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_initial_zoom">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_initial_zoom</a>
 */
ImageToPdfClient.prototype.setInitialZoom = function(zoom) {
    if (!(parseInt(zoom) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(zoom, "setInitialZoom", "image-to-pdf", "Must be a positive integer.", "set_initial_zoom"), 470);
    
    this.fields['initial_zoom'] = zoom.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_hide_toolbar">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_hide_toolbar</a>
 */
ImageToPdfClient.prototype.setHideToolbar = function(value) {
    this.fields['hide_toolbar'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_hide_menubar">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_hide_menubar</a>
 */
ImageToPdfClient.prototype.setHideMenubar = function(value) {
    this.fields['hide_menubar'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_hide_window_ui">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_hide_window_ui</a>
 */
ImageToPdfClient.prototype.setHideWindowUi = function(value) {
    this.fields['hide_window_ui'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_fit_window">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_fit_window</a>
 */
ImageToPdfClient.prototype.setFitWindow = function(value) {
    this.fields['fit_window'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_center_window">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_center_window</a>
 */
ImageToPdfClient.prototype.setCenterWindow = function(value) {
    this.fields['center_window'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_display_title">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_display_title</a>
 */
ImageToPdfClient.prototype.setDisplayTitle = function(value) {
    this.fields['display_title'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_debug_log</a>
 */
ImageToPdfClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_debug_log_url</a>
 */
ImageToPdfClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_remaining_credit_count</a>
 */
ImageToPdfClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_consumed_credit_count</a>
 */
ImageToPdfClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_job_id</a>
 */
ImageToPdfClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_output_size</a>
 */
ImageToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_version">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#get_version</a>
 */
ImageToPdfClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_tag">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_tag</a>
 */
ImageToPdfClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_http_proxy</a>
 */
ImageToPdfClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "image-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_https_proxy</a>
 */
ImageToPdfClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "image-to-pdf", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_converter_version">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_converter_version</a>
 */
ImageToPdfClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(24.04|20.10|18.10|latest)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "image-to-pdf", "Allowed values are 24.04, 20.10, 18.10, latest.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_use_http</a>
 */
ImageToPdfClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_client_user_agent</a>
 */
ImageToPdfClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_user_agent</a>
 */
ImageToPdfClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_proxy</a>
 */
ImageToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/image-to-pdf-nodejs/ref/#set_retry_count</a>
 */
ImageToPdfClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from PDF to HTML.
 *
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/">https://pdfcrowd.com/api/pdf-to-html-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#PdfToHtmlClient">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#PdfToHtmlClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_url">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_url</a>
 */
PdfToHtmlClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "pdf-to-html", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_url_to_file</a>
 */
PdfToHtmlClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_url_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_file">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_file</a>
 */
PdfToHtmlClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "pdf-to-html", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_file_to_file</a>
 */
PdfToHtmlClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_file_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_raw_data">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_raw_data</a>
 */
PdfToHtmlClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_raw_data_to_file">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_raw_data_to_file</a>
 */
PdfToHtmlClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_stream</a>
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
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#convert_stream_to_file</a>
 */
PdfToHtmlClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-html", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    if (!(isOutputTypeValid(filePath, this)))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-html", "The converter generates an HTML or ZIP file. If ZIP file is generated, the file path must have a ZIP or zip extension.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_pdf_password">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_pdf_password</a>
 */
PdfToHtmlClient.prototype.setPdfPassword = function(password) {
    this.fields['pdf_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_scale_factor">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_scale_factor</a>
 */
PdfToHtmlClient.prototype.setScaleFactor = function(factor) {
    if (!(parseInt(factor) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(factor, "setScaleFactor", "pdf-to-html", "Must be a positive integer.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = factor.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_print_page_range">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_print_page_range</a>
 */
PdfToHtmlClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "pdf-to-html", "A comma separated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_dpi">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_dpi</a>
 */
PdfToHtmlClient.prototype.setDpi = function(dpi) {
    this.fields['dpi'] = dpi.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_image_mode">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_image_mode</a>
 */
PdfToHtmlClient.prototype.setImageMode = function(mode) {
    if (!mode.match(/^(embed|separate|none)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setImageMode", "pdf-to-html", "Allowed values are embed, separate, none.", "set_image_mode"), 470);
    
    this.fields['image_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_image_format">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_image_format</a>
 */
PdfToHtmlClient.prototype.setImageFormat = function(imageFormat) {
    if (!imageFormat.match(/^(png|jpg|svg)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(imageFormat, "setImageFormat", "pdf-to-html", "Allowed values are png, jpg, svg.", "set_image_format"), 470);
    
    this.fields['image_format'] = imageFormat;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_css_mode">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_css_mode</a>
 */
PdfToHtmlClient.prototype.setCssMode = function(mode) {
    if (!mode.match(/^(embed|separate)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setCssMode", "pdf-to-html", "Allowed values are embed, separate.", "set_css_mode"), 470);
    
    this.fields['css_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_font_mode">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_font_mode</a>
 */
PdfToHtmlClient.prototype.setFontMode = function(mode) {
    if (!mode.match(/^(embed|separate)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setFontMode", "pdf-to-html", "Allowed values are embed, separate.", "set_font_mode"), 470);
    
    this.fields['font_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_type3_mode">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_type3_mode</a>
 */
PdfToHtmlClient.prototype.setType3Mode = function(mode) {
    if (!mode.match(/^(raster|convert)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setType3Mode", "pdf-to-html", "Allowed values are raster, convert.", "set_type3_mode"), 470);
    
    this.fields['type3_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_split_ligatures">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_split_ligatures</a>
 */
PdfToHtmlClient.prototype.setSplitLigatures = function(value) {
    this.fields['split_ligatures'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_custom_css">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_custom_css</a>
 */
PdfToHtmlClient.prototype.setCustomCss = function(css) {
    if (!(css))
        throw new Pdfcrowd.Error(createInvalidValueMessage(css, "setCustomCss", "pdf-to-html", "The string must not be empty.", "set_custom_css"), 470);
    
    this.fields['custom_css'] = css;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_html_namespace">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_html_namespace</a>
 */
PdfToHtmlClient.prototype.setHtmlNamespace = function(prefix) {
    if (!prefix.match(/^[a-z_][a-z0-9_:-]*$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(prefix, "setHtmlNamespace", "pdf-to-html", "Start with a letter or underscore, and use only letters, numbers, hyphens, underscores, or colons.", "set_html_namespace"), 470);
    
    this.fields['html_namespace'] = prefix;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#is_zipped_output">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#is_zipped_output</a>
 */
PdfToHtmlClient.prototype.isZippedOutput = function() {
    return this.fields.image_mode === 'separate' || this.fields.css_mode === 'separate' || this.fields.font_mode === 'separate' || this.fields.force_zip === true;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_force_zip">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_force_zip</a>
 */
PdfToHtmlClient.prototype.setForceZip = function(value) {
    this.fields['force_zip'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_title">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_title</a>
 */
PdfToHtmlClient.prototype.setTitle = function(title) {
    this.fields['title'] = title;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_subject">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_subject</a>
 */
PdfToHtmlClient.prototype.setSubject = function(subject) {
    this.fields['subject'] = subject;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_author">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_author</a>
 */
PdfToHtmlClient.prototype.setAuthor = function(author) {
    this.fields['author'] = author;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_keywords">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_keywords</a>
 */
PdfToHtmlClient.prototype.setKeywords = function(keywords) {
    this.fields['keywords'] = keywords;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_debug_log</a>
 */
PdfToHtmlClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_debug_log_url</a>
 */
PdfToHtmlClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_remaining_credit_count</a>
 */
PdfToHtmlClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_consumed_credit_count</a>
 */
PdfToHtmlClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_job_id</a>
 */
PdfToHtmlClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_page_count">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_page_count</a>
 */
PdfToHtmlClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_output_size</a>
 */
PdfToHtmlClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_version">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#get_version</a>
 */
PdfToHtmlClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_tag">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_tag</a>
 */
PdfToHtmlClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_http_proxy</a>
 */
PdfToHtmlClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "pdf-to-html", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_https_proxy</a>
 */
PdfToHtmlClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "pdf-to-html", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_converter_version">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_converter_version</a>
 */
PdfToHtmlClient.prototype.setConverterVersion = function(version) {
    if (!version.match(/^(24.04|20.10|18.10|latest)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(version, "setConverterVersion", "pdf-to-html", "Allowed values are 24.04, 20.10, 18.10, latest.", "set_converter_version"), 470);
    
    this.helper.setConverterVersion(version);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_use_http</a>
 */
PdfToHtmlClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_client_user_agent</a>
 */
PdfToHtmlClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_user_agent</a>
 */
PdfToHtmlClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_proxy</a>
 */
PdfToHtmlClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/pdf-to-html-nodejs/ref/#set_retry_count</a>
 */
PdfToHtmlClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from PDF to text.
 *
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/">https://pdfcrowd.com/api/pdf-to-text-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#PdfToTextClient">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#PdfToTextClient</a>
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
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_url">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_url</a>
 */
PdfToTextClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "pdf-to-text", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_url_to_file</a>
 */
PdfToTextClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_file">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_file</a>
 */
PdfToTextClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "pdf-to-text", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_file_to_file</a>
 */
PdfToTextClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_raw_data">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_raw_data</a>
 */
PdfToTextClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_raw_data_to_file">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_raw_data_to_file</a>
 */
PdfToTextClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_stream</a>
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
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#convert_stream_to_file</a>
 */
PdfToTextClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-text", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_pdf_password">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_pdf_password</a>
 */
PdfToTextClient.prototype.setPdfPassword = function(password) {
    this.fields['pdf_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_print_page_range">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_print_page_range</a>
 */
PdfToTextClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "pdf-to-text", "A comma separated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_no_layout">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_no_layout</a>
 */
PdfToTextClient.prototype.setNoLayout = function(value) {
    this.fields['no_layout'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_eol">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_eol</a>
 */
PdfToTextClient.prototype.setEol = function(eol) {
    if (!eol.match(/^(unix|dos|mac)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(eol, "setEol", "pdf-to-text", "Allowed values are unix, dos, mac.", "set_eol"), 470);
    
    this.fields['eol'] = eol;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_page_break_mode">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_page_break_mode</a>
 */
PdfToTextClient.prototype.setPageBreakMode = function(mode) {
    if (!mode.match(/^(none|default|custom)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setPageBreakMode", "pdf-to-text", "Allowed values are none, default, custom.", "set_page_break_mode"), 470);
    
    this.fields['page_break_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_custom_page_break">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_custom_page_break</a>
 */
PdfToTextClient.prototype.setCustomPageBreak = function(pageBreak) {
    this.fields['custom_page_break'] = pageBreak;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_paragraph_mode">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_paragraph_mode</a>
 */
PdfToTextClient.prototype.setParagraphMode = function(mode) {
    if (!mode.match(/^(none|bounding-box|characters)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "setParagraphMode", "pdf-to-text", "Allowed values are none, bounding-box, characters.", "set_paragraph_mode"), 470);
    
    this.fields['paragraph_mode'] = mode;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_line_spacing_threshold">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_line_spacing_threshold</a>
 */
PdfToTextClient.prototype.setLineSpacingThreshold = function(threshold) {
    if (!threshold.match(/^0$|^[0-9]+%$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(threshold, "setLineSpacingThreshold", "pdf-to-text", "The value must be a positive integer percentage.", "set_line_spacing_threshold"), 470);
    
    this.fields['line_spacing_threshold'] = threshold;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_remove_hyphenation">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_remove_hyphenation</a>
 */
PdfToTextClient.prototype.setRemoveHyphenation = function(value) {
    this.fields['remove_hyphenation'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_remove_empty_lines">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_remove_empty_lines</a>
 */
PdfToTextClient.prototype.setRemoveEmptyLines = function(value) {
    this.fields['remove_empty_lines'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_x">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_x</a>
 */
PdfToTextClient.prototype.setCropAreaX = function(x) {
    if (!(parseInt(x) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "pdf-to-text", "Must be a positive integer or 0.", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_y">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_y</a>
 */
PdfToTextClient.prototype.setCropAreaY = function(y) {
    if (!(parseInt(y) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "pdf-to-text", "Must be a positive integer or 0.", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_width">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_width</a>
 */
PdfToTextClient.prototype.setCropAreaWidth = function(width) {
    if (!(parseInt(width) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "pdf-to-text", "Must be a positive integer or 0.", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_height">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area_height</a>
 */
PdfToTextClient.prototype.setCropAreaHeight = function(height) {
    if (!(parseInt(height) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "pdf-to-text", "Must be a positive integer or 0.", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_crop_area</a>
 */
PdfToTextClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_debug_log</a>
 */
PdfToTextClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_debug_log_url</a>
 */
PdfToTextClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_remaining_credit_count</a>
 */
PdfToTextClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_consumed_credit_count</a>
 */
PdfToTextClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_job_id</a>
 */
PdfToTextClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_page_count">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_page_count</a>
 */
PdfToTextClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_output_size</a>
 */
PdfToTextClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_version">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#get_version</a>
 */
PdfToTextClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_tag">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_tag</a>
 */
PdfToTextClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_http_proxy</a>
 */
PdfToTextClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "pdf-to-text", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_https_proxy</a>
 */
PdfToTextClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "pdf-to-text", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_use_http</a>
 */
PdfToTextClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_client_user_agent</a>
 */
PdfToTextClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_user_agent</a>
 */
PdfToTextClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_proxy</a>
 */
PdfToTextClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/pdf-to-text-nodejs/ref/#set_retry_count</a>
 */
PdfToTextClient.prototype.setRetryCount = function(count) {
    this.helper.setRetryCount(count);
    return this;
};

/**
 * Conversion from PDF to image.
 *
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/">https://pdfcrowd.com/api/pdf-to-image-nodejs/</a>
 */
/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#PdfToImageClient">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#PdfToImageClient</a>
 */
function PdfToImageClient(userName, apiKey) {
    this.helper = new ConnectionHelper(userName, apiKey);
    this.fields = {
        'input_format': 'pdf',
        'output_format': 'png'
    };
    this.fileId = 1;
    this.files = {};
    this.rawData = {};
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_url">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_url</a>
 */
PdfToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "convertUrl", "pdf-to-image", "Supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_url_to_file">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_url_to_file</a>
 */
PdfToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertUrlToFile::file_path", "pdf-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_file">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_file</a>
 */
PdfToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "convertFile", "pdf-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_file_to_file">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_file_to_file</a>
 */
PdfToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertFileToFile::file_path", "pdf-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_raw_data">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_raw_data</a>
 */
PdfToImageClient.prototype.convertRawData = function(data, callbacks) {
    this.rawData['file'] = data;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_raw_data_to_file">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_raw_data_to_file</a>
 */
PdfToImageClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertRawDataToFile::file_path", "pdf-to-image", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_stream">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_stream</a>
 */
PdfToImageClient.prototype.convertStream = function(inStream, callbacks) {
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
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_stream_to_file">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#convert_stream_to_file</a>
 */
PdfToImageClient.prototype.convertStreamToFile = function(inStream, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "convertStreamToFile::file_path", "pdf-to-image", "The string must not be empty.", "convert_stream_to_file"), 470);
    
    this.convertStream(inStream, saveToFile(filePath, callback));
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_output_format">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_output_format</a>
 */
PdfToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "setOutputFormat", "pdf-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_pdf_password">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_pdf_password</a>
 */
PdfToImageClient.prototype.setPdfPassword = function(password) {
    this.fields['pdf_password'] = password;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_print_page_range">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_print_page_range</a>
 */
PdfToImageClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "setPrintPageRange", "pdf-to-image", "A comma separated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_dpi">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_dpi</a>
 */
PdfToImageClient.prototype.setDpi = function(dpi) {
    this.fields['dpi'] = dpi.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#is_zipped_output">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#is_zipped_output</a>
 */
PdfToImageClient.prototype.isZippedOutput = function() {
    return this.fields.force_zip === true || this.getPageCount() > 1;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_force_zip">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_force_zip</a>
 */
PdfToImageClient.prototype.setForceZip = function(value) {
    this.fields['force_zip'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_use_cropbox">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_use_cropbox</a>
 */
PdfToImageClient.prototype.setUseCropbox = function(value) {
    this.fields['use_cropbox'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_x">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_x</a>
 */
PdfToImageClient.prototype.setCropAreaX = function(x) {
    if (!(parseInt(x) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(x, "setCropAreaX", "pdf-to-image", "Must be a positive integer or 0.", "set_crop_area_x"), 470);
    
    this.fields['crop_area_x'] = x.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_y">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_y</a>
 */
PdfToImageClient.prototype.setCropAreaY = function(y) {
    if (!(parseInt(y) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(y, "setCropAreaY", "pdf-to-image", "Must be a positive integer or 0.", "set_crop_area_y"), 470);
    
    this.fields['crop_area_y'] = y.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_width">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_width</a>
 */
PdfToImageClient.prototype.setCropAreaWidth = function(width) {
    if (!(parseInt(width) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(width, "setCropAreaWidth", "pdf-to-image", "Must be a positive integer or 0.", "set_crop_area_width"), 470);
    
    this.fields['crop_area_width'] = width.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_height">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area_height</a>
 */
PdfToImageClient.prototype.setCropAreaHeight = function(height) {
    if (!(parseInt(height) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(height, "setCropAreaHeight", "pdf-to-image", "Must be a positive integer or 0.", "set_crop_area_height"), 470);
    
    this.fields['crop_area_height'] = height.toString();
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_crop_area</a>
 */
PdfToImageClient.prototype.setCropArea = function(x, y, width, height) {
    this.setCropAreaX(x);
    this.setCropAreaY(y);
    this.setCropAreaWidth(width);
    this.setCropAreaHeight(height);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_use_grayscale">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_use_grayscale</a>
 */
PdfToImageClient.prototype.setUseGrayscale = function(value) {
    this.fields['use_grayscale'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_debug_log">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_debug_log</a>
 */
PdfToImageClient.prototype.setDebugLog = function(value) {
    this.fields['debug_log'] = value;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_debug_log_url">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_debug_log_url</a>
 */
PdfToImageClient.prototype.getDebugLogUrl = function() {
    return this.helper.getDebugLogUrl();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_remaining_credit_count">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_remaining_credit_count</a>
 */
PdfToImageClient.prototype.getRemainingCreditCount = function() {
    return this.helper.getRemainingCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_consumed_credit_count">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_consumed_credit_count</a>
 */
PdfToImageClient.prototype.getConsumedCreditCount = function() {
    return this.helper.getConsumedCreditCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_job_id">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_job_id</a>
 */
PdfToImageClient.prototype.getJobId = function() {
    return this.helper.getJobId();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_page_count">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_page_count</a>
 */
PdfToImageClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_output_size">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_output_size</a>
 */
PdfToImageClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_version">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#get_version</a>
 */
PdfToImageClient.prototype.getVersion = function() {
    return 'client ' + CLIENT_VERSION + ', API v2, converter ' + this.helper.getConverterVersion();
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_tag">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_tag</a>
 */
PdfToImageClient.prototype.setTag = function(tag) {
    this.fields['tag'] = tag;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_http_proxy">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_http_proxy</a>
 */
PdfToImageClient.prototype.setHttpProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpProxy", "pdf-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_http_proxy"), 470);
    
    this.fields['http_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_https_proxy">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_https_proxy</a>
 */
PdfToImageClient.prototype.setHttpsProxy = function(proxy) {
    if (!proxy.match(/^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z0-9]{1,}:\d+$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(proxy, "setHttpsProxy", "pdf-to-image", "The value must have format DOMAIN_OR_IP_ADDRESS:PORT.", "set_https_proxy"), 470);
    
    this.fields['https_proxy'] = proxy;
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_use_http">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_use_http</a>
 */
PdfToImageClient.prototype.setUseHttp = function(value) {
    this.helper.setUseHttp(value);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_client_user_agent">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_client_user_agent</a>
 */
PdfToImageClient.prototype.setClientUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_user_agent">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_user_agent</a>
 */
PdfToImageClient.prototype.setUserAgent = function(agent) {
    this.helper.setUserAgent(agent);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_proxy">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_proxy</a>
 */
PdfToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
    return this;
};

/**
 * @see <a href="https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_retry_count">https://pdfcrowd.com/api/pdf-to-image-nodejs/ref/#set_retry_count</a>
 */
PdfToImageClient.prototype.setRetryCount = function(count) {
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
    PdfToImageClient: PdfToImageClient,
    Pdfcrowd: Pdfcrowd,
    saveToFile: saveToFile,
    sendHttpResponse: sendHttpResponse,
    sendPdfInHttpResponse: sendPdfInHttpResponse,
    sendImageInHttpResponse: sendImageInHttpResponse,
    sendGenericHttpResponse: sendGenericHttpResponse
};
