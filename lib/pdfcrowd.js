"use strict";

// Copyright (C) 2009-2016 pdfcrowd.com
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

var Pdfcrowd = function(username, apikey, host, https) {
    if (!username)
        throw new Error('Missing username.');

    if (!apikey)
        throw new Error('Missing apikey.');

    this.username = username;
    this.apikey = apikey;
    this.host = host || "pdfcrowd.com";
    this.https = https || true;
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
// Queries for the number of available credits
//
Pdfcrowd.prototype.userStatus = function(callback) {
    requestQueue.addRequest([this, {
        endpoint: '/api/user/' + this.username + '/tokens/',
        callbacks: callback
    }]);
}


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


//
// Returns a callback object that saves the generated PDF to a file
//
var saveToFile = function(fname, callback) {
    return {
        pdf: function(rstream) {
            var wstream = fs.createWriteStream(fname);
            rstream.pipe(wstream);
        },
        error: function(errMessage, statusCode) {
            if(callback) return callback(errMessage);
            console.log("ERROR: " + errMessage);
        },
        end: function() {
            if(callback) return callback(null, fname); 
        }
    };
};


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
        end: function() {}
    };
};

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

    var agent;
    if (that.https) {
        agent = https;
    } else {
        agent = http;
    }

    // http options
    var httpOptions = {
        host: that.host,
        port: that.https ? 443 : 80,
        method: 'POST',
        path: opts.endpoint,
        headers: { 'content-length': postData.length,
                   'content-type': contentType,
                   'user-agent': 'node-pdfcrowd client'}
    };

    var callbacks = opts.callbacks;
    var req = agent.request(httpOptions, function(res) {
        if (res.statusCode < 300 && callbacks.pdf) {
            res.on('end', function() {
                callbacks.end();
                requestQueue.requestDone();
            });
            res.on('error', function(exc) {
                callbacks.error(exc.toString());
                requestQueue.requestDone();
            });
            callbacks.pdf(res);
        } else if (res.statusCode < 300 && !callbacks.pdf) {
            var chunks = [];
            res.on('data', function(chunk) {
                chunks.push(chunk.toString());
            });
            res.on('end', function() {
                requestQueue.requestDone();
                callbacks(chunks.join(''));
            });
        } else {
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
var CLIENT_VERSION = '4.0.0';
var MULTIPART_BOUNDARY = '----------ThIs_Is_tHe_bOUnDary_$';
var CLIENT_ERROR = -1;

function encodeCredentials(userName, password) {
    return 'Basic ' + new Buffer(userName + ':' + password).toString('base64');
}

function createInvalidValueMessage(value, field, converter, hint, id) {
    var message = "Invalid value '" + value + "' for a field '" + field + "'.";
    if(hint) {
        message += " " + hint;
    }
    return message + " " + "Details: https://www.pdfcrowd.com/doc/api/" + converter + "/nodejs/#" + id + "";
}

function ConnectionHelper(userName, apiKey) {
    this.userName = userName;
    this.apiKey = apiKey;

    this.resetResponseData();
    this.setProxy(null, null, null, null);
    this.setUseHttp(false);
    this.setUserAgent('pdfcrowd_nodejs_client/4.0.0 (http://pdfcrowd.com)');
}

ConnectionHelper.prototype.post = function(fields, files, rawData, callbacks) {
    return Object.keys(files).length == 0 && Object.keys(rawData).length == 0 ?
        this.postUrlEncoded(fields, callbacks) :
        this.postMultipart(fields, files, rawData, callbacks);
};

ConnectionHelper.prototype.postUrlEncoded = function(fields, callbacks) {
    var body = querystring.stringify(fields);
    var contentType = 'application/x-www-form-urlencoded';
    return this.doPost(body, contentType, callbacks);
};

ConnectionHelper.prototype.resetResponseData = function() {
    this.debugLogUrl = null;
    this.credits = 999999;
    this.consumedCredits = 0;
    this.jobId = '';
    this.pageCount = 0;
    this.outputSize = 0;
};

function addFileField(name, fileName, data, body) {
    body.push('--' + MULTIPART_BOUNDARY);
    body.push('Content-Disposition: form-data; name="' + name + '"; filename="' + fileName + '"');
    body.push('Content-Type: application/octet-stream');
    body.push('');
    body.push(data);
}

ConnectionHelper.prototype.postMultipart = function(fields, files, rawData, callbacks) {
    var that = this;

    var body = new Array();
    for(var field in fields) {
        if(fields[field]) {
            body.push('--' + MULTIPART_BOUNDARY);
            body.push('Content-Disposition: form-data; name="' + field + '"');
            body.push('');
            body.push(fields[field].toString());
        }
    }

    var contentType = 'multipart/form-data; boundary=' + MULTIPART_BOUNDARY;
    var count = 0;
    var filesCount = Object.keys(files).length;
    var createHandler = function(key) {
        return function(err, data) {
            count++;
            if(err) return callbacks.error(err, CLIENT_ERROR);

            addFileField(key, files[key], data.toString('binary'), body);

            if(count != filesCount) return;

            // finalize body
            body.push('--' + MULTIPART_BOUNDARY + '--');
            body.push('');

            return that.doPost(body.join('\r\n'), contentType, callbacks);
        };
    };

    for(var name in rawData) {
        addFileField(name, name, rawData[name].toString('binary'), body);
    }

    if(Object.keys(files).length == 0) {
        // finalize body
        body.push('--' + MULTIPART_BOUNDARY + '--');
        body.push('');

        return this.doPost(body.join('\r\n'), contentType, callbacks);
    } else {
        for(var key in files) {
            fs.readFile(files[key], createHandler(key));
        }
    }
};

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

    if(this.proxyHost) {
        httpOptions.host = this.proxyHost;
        httpOptions.path = 'http://' + HOST + ':' + this.port + '/convert/';
        httpOptions.port = this.proxyPort;
        httpOptions.headers['Proxy-Authorization'] = encodeCredentials(this.proxyUserName, this.proxyPassword);
    } else {
        httpOptions.host = HOST;
        httpOptions.path = '/convert/';
        httpOptions.port = this.port;
    }
    var that = this;
    var req = this.scheme.request(httpOptions, function(res) {
        that.debugLogUrl = res.headers['x-pdfcrowd-debug-log'] || '';
        that.credits = parseInt(res.headers['x-pdfcrowd-remaining-credits'] || 999999);
        that.consumedCredits = parseInt(res.headers['x-pdfcrowd-consumed-credits'] || 0);
        that.jobId = res.headers['x-pdfcrowd-job-id'] || '';
        that.pageCount = parseInt(res.headers['x-pdfcrowd-pages'] || 0);
        that.outputSize = parseInt(res.headers['x-pdfcrowd-output-size'] || 0);

        if (res.statusCode < 300) {
            res.on('end', function() {
                callbacks.end();
            });

            res.on('error', function(exc) {
                callbacks.error(exc.toString());
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
            });
        }
    });

    req.on('error', function(res) {
        callbacks.error(res.toString(), res.statusCode);
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

ConnectionHelper.prototype.getOutputSize = function() {
    return this.outputSize;
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
* @return Byte array containing the conversion output.
*/
HtmlToPdfClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "url", "html-to-pdf", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a web page and write the result to a local file.
* 
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
*/
HtmlToPdfClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "html-to-pdf", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @return Byte array containing the conversion output.
*/
HtmlToPdfClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "file", "html-to-pdf", "The file must exist and not be empty.", "convert_file"), 470);
    
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "file", "html-to-pdf", "The file name must have a valid extension.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @param filePath The output file path. The string must not be empty.
*/
HtmlToPdfClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "html-to-pdf", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert a string.
* 
* @param text The string content to convert. The string must not be empty.
* @return Byte array containing the conversion output.
*/
HtmlToPdfClient.prototype.convertString = function(text, callbacks) {
    if (!(text))
        return callbacks.error(createInvalidValueMessage(text, "text", "html-to-pdf", "The string must not be empty.", "convert_string"), 470);
    
    this.fields['text'] = text;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a string and write the output to a file.
* 
* @param text The string content to convert. The string must not be empty.
* @param filePath The output file path. The string must not be empty.
*/
HtmlToPdfClient.prototype.convertStringToFile = function(text, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "html-to-pdf", "The string must not be empty.", "convert_string_to_file"), 470);
    
    this.convertString(text, saveToFile(filePath, callback));
};

/**
* Set the output page size.
* 
* @param pageSize Allowed values are A2, A3, A4, A5, A6, Letter.
*/
HtmlToPdfClient.prototype.setPageSize = function(pageSize) {
    if (!pageSize.match(/^(A2|A3|A4|A5|A6|Letter)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pageSize, "page_size", "html-to-pdf", "Allowed values are A2, A3, A4, A5, A6, Letter.", "set_page_size"), 470);
    
    this.fields['page_size'] = pageSize;
};

/**
* Set the output page width.
* 
* @param pageWidth Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setPageWidth = function(pageWidth) {
    if (!pageWidth.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pageWidth, "page_width", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_page_width"), 470);
    
    this.fields['page_width'] = pageWidth;
};

/**
* Set the output page height.
* 
* @param pageHeight Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setPageHeight = function(pageHeight) {
    if (!pageHeight.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pageHeight, "page_height", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_page_height"), 470);
    
    this.fields['page_height'] = pageHeight;
};

/**
* Set the output page dimensions.
* 
* @param width Set the output page width. Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
* @param height Set the output page height. Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setPageDimensions = function(width, height) {
    this.setPageWidth(width);
    this.setPageHeight(height);
};

/**
* Set the output page orientation.
* 
* @param orientation Allowed values are landscape, portrait.
*/
HtmlToPdfClient.prototype.setOrientation = function(orientation) {
    if (!orientation.match(/^(landscape|portrait)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(orientation, "orientation", "html-to-pdf", "Allowed values are landscape, portrait.", "set_orientation"), 470);
    
    this.fields['orientation'] = orientation;
};

/**
* Set the output page top margin.
* 
* @param marginTop Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setMarginTop = function(marginTop) {
    if (!marginTop.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(marginTop, "margin_top", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_margin_top"), 470);
    
    this.fields['margin_top'] = marginTop;
};

/**
* Set the output page right margin.
* 
* @param marginRight Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setMarginRight = function(marginRight) {
    if (!marginRight.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(marginRight, "margin_right", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_margin_right"), 470);
    
    this.fields['margin_right'] = marginRight;
};

/**
* Set the output page bottom margin.
* 
* @param marginBottom Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setMarginBottom = function(marginBottom) {
    if (!marginBottom.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(marginBottom, "margin_bottom", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_margin_bottom"), 470);
    
    this.fields['margin_bottom'] = marginBottom;
};

/**
* Set the output page left margin.
* 
* @param marginLeft Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setMarginLeft = function(marginLeft) {
    if (!marginLeft.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(marginLeft, "margin_left", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_margin_left"), 470);
    
    this.fields['margin_left'] = marginLeft;
};

/**
* Disable margins.
* 
* @param noMargins Set to <span class='field-value'>true</span> to disable margins.
*/
HtmlToPdfClient.prototype.setNoMargins = function(noMargins) {
    this.fields['no_margins'] = noMargins;
};

/**
* Set the output page margins.
* 
* @param top Set the output page top margin. Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
* @param right Set the output page right margin. Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
* @param bottom Set the output page bottom margin. Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
* @param left Set the output page left margin. Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setPageMargins = function(top, right, bottom, left) {
    this.setMarginTop(top);
    this.setMarginRight(right);
    this.setMarginBottom(bottom);
    this.setMarginLeft(left);
};

/**
* Load an HTML code from the specified URL and use it as the page header. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of a converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals <ul> <li>Arabic numerals are used by default.</li> <li>Roman numerals can be generated by the <span class='field-value'>roman</span> and <span class='field-value'>roman-lowercase</span> values</li> <li>Example: &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt;</li> </ul> </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL, allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul>
</li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
* 
* @param headerUrl The supported protocols are http:// and https://.
*/
HtmlToPdfClient.prototype.setHeaderUrl = function(headerUrl) {
    if (!headerUrl.match(/^https?:\/\/.*$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(headerUrl, "header_url", "html-to-pdf", "The supported protocols are http:// and https://.", "set_header_url"), 470);
    
    this.fields['header_url'] = headerUrl;
};

/**
* Use the specified HTML code as the page header. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of a converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals <ul> <li>Arabic numerals are used by default.</li> <li>Roman numerals can be generated by the <span class='field-value'>roman</span> and <span class='field-value'>roman-lowercase</span> values</li> <li>Example: &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt;</li> </ul> </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL, allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul>
</li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
* 
* @param headerHtml The string must not be empty.
*/
HtmlToPdfClient.prototype.setHeaderHtml = function(headerHtml) {
    if (!(headerHtml))
        throw new Pdfcrowd.Error(createInvalidValueMessage(headerHtml, "header_html", "html-to-pdf", "The string must not be empty.", "set_header_html"), 470);
    
    this.fields['header_html'] = headerHtml;
};

/**
* Set the header height.
* 
* @param headerHeight Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setHeaderHeight = function(headerHeight) {
    if (!headerHeight.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(headerHeight, "header_height", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_header_height"), 470);
    
    this.fields['header_height'] = headerHeight;
};

/**
* Load an HTML code from the specified URL and use it as the page footer. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of a converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals <ul> <li>Arabic numerals are used by default.</li> <li>Roman numerals can be generated by the <span class='field-value'>roman</span> and <span class='field-value'>roman-lowercase</span> values</li> <li>Example: &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt;</li> </ul> </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL, allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul>
</li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
* 
* @param footerUrl The supported protocols are http:// and https://.
*/
HtmlToPdfClient.prototype.setFooterUrl = function(footerUrl) {
    if (!footerUrl.match(/^https?:\/\/.*$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(footerUrl, "footer_url", "html-to-pdf", "The supported protocols are http:// and https://.", "set_footer_url"), 470);
    
    this.fields['footer_url'] = footerUrl;
};

/**
* Use the specified HTML as the page footer. The following classes can be used in the HTML. The content of the respective elements will be expanded as follows: <ul> <li><span class='field-value'>pdfcrowd-page-count</span> - the total page count of printed pages</li> <li><span class='field-value'>pdfcrowd-page-number</span> - the current page number</li> <li><span class='field-value'>pdfcrowd-source-url</span> - the source URL of a converted document</li> </ul> The following attributes can be used: <ul> <li><span class='field-value'>data-pdfcrowd-number-format</span> - specifies the type of the used numerals <ul> <li>Arabic numerals are used by default.</li> <li>Roman numerals can be generated by the <span class='field-value'>roman</span> and <span class='field-value'>roman-lowercase</span> values</li> <li>Example: &lt;span class='pdfcrowd-page-number' data-pdfcrowd-number-format='roman'&gt;&lt;/span&gt;</li> </ul> </li> <li><span class='field-value'>data-pdfcrowd-placement</span> - specifies where to place the source URL, allowed values: <ul> <li>The URL is inserted to the content <ul> <li> Example: &lt;span class='pdfcrowd-source-url'&gt;&lt;/span&gt;<br> will produce &lt;span&gt;http://example.com&lt;/span&gt; </li> </ul>
</li> <li><span class='field-value'>href</span> - the URL is set to the href attribute <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href'&gt;Link to source&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;Link to source&lt;/a&gt; </li> </ul> </li> <li><span class='field-value'>href-and-content</span> - the URL is set to the href attribute and to the content <ul> <li> Example: &lt;a class='pdfcrowd-source-url' data-pdfcrowd-placement='href-and-content'&gt;&lt;/a&gt;<br> will produce &lt;a href='http://example.com'&gt;http://example.com&lt;/a&gt; </li> </ul> </li> </ul> </li> </ul>
* 
* @param footerHtml The string must not be empty.
*/
HtmlToPdfClient.prototype.setFooterHtml = function(footerHtml) {
    if (!(footerHtml))
        throw new Pdfcrowd.Error(createInvalidValueMessage(footerHtml, "footer_html", "html-to-pdf", "The string must not be empty.", "set_footer_html"), 470);
    
    this.fields['footer_html'] = footerHtml;
};

/**
* Set the footer height.
* 
* @param footerHeight Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).
*/
HtmlToPdfClient.prototype.setFooterHeight = function(footerHeight) {
    if (!footerHeight.match(/^[0-9]*(\.[0-9]+)?(pt|px|mm|cm|in)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(footerHeight, "footer_height", "html-to-pdf", "Can be specified in inches (in), millimeters (mm), centimeters (cm), or points (pt).", "set_footer_height"), 470);
    
    this.fields['footer_height'] = footerHeight;
};

/**
* Set the page range to print.
* 
* @param pages A comma seperated list of page numbers or ranges.
*/
HtmlToPdfClient.prototype.setPrintPageRange = function(pages) {
    if (!pages.match(/^(?:\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*,\s*)*\s*(?:\d+|(?:\d*\s*\-\s*\d+)|(?:\d+\s*\-\s*\d*))\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "pages", "html-to-pdf", "A comma seperated list of page numbers or ranges.", "set_print_page_range"), 470);
    
    this.fields['print_page_range'] = pages;
};

/**
* Apply the first page of the watermark PDF to every page of the output PDF.
* 
* @param pageWatermark The file path to a local watermark PDF file. The file must exist and not be empty.
*/
HtmlToPdfClient.prototype.setPageWatermark = function(pageWatermark) {
    if (!(fs.existsSync(pageWatermark) && fs.statSync(pageWatermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pageWatermark, "page_watermark", "html-to-pdf", "The file must exist and not be empty.", "set_page_watermark"), 470);
    
    this.files['page_watermark'] = pageWatermark;
};

/**
* Apply each page of the specified watermark PDF to the corresponding page of the output PDF.
* 
* @param multipageWatermark The file path to a local watermark PDF file. The file must exist and not be empty.
*/
HtmlToPdfClient.prototype.setMultipageWatermark = function(multipageWatermark) {
    if (!(fs.existsSync(multipageWatermark) && fs.statSync(multipageWatermark)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(multipageWatermark, "multipage_watermark", "html-to-pdf", "The file must exist and not be empty.", "set_multipage_watermark"), 470);
    
    this.files['multipage_watermark'] = multipageWatermark;
};

/**
* Apply the first page of the specified PDF to the background of every page of the output PDF.
* 
* @param pageBackground The file path to a local background PDF file. The file must exist and not be empty.
*/
HtmlToPdfClient.prototype.setPageBackground = function(pageBackground) {
    if (!(fs.existsSync(pageBackground) && fs.statSync(pageBackground)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pageBackground, "page_background", "html-to-pdf", "The file must exist and not be empty.", "set_page_background"), 470);
    
    this.files['page_background'] = pageBackground;
};

/**
* Apply each page of the specified PDF to the background of the corresponding page of the output PDF.
* 
* @param multipageBackground The file path to a local background PDF file. The file must exist and not be empty.
*/
HtmlToPdfClient.prototype.setMultipageBackground = function(multipageBackground) {
    if (!(fs.existsSync(multipageBackground) && fs.statSync(multipageBackground)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(multipageBackground, "multipage_background", "html-to-pdf", "The file must exist and not be empty.", "set_multipage_background"), 470);
    
    this.files['multipage_background'] = multipageBackground;
};

/**
* The page header is not printed on the specified pages.
* 
* @param pages List of physical page numbers. Negative numbers count backwards from the last page: -1 is the last page, -2 is the last but one page, and so on. A comma seperated list of page numbers.
*/
HtmlToPdfClient.prototype.setExcludeHeaderOnPages = function(pages) {
    if (!pages.match(/^(?:\s*\-?\d+\s*,)*\s*\-?\d+\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "pages", "html-to-pdf", "A comma seperated list of page numbers.", "set_exclude_header_on_pages"), 470);
    
    this.fields['exclude_header_on_pages'] = pages;
};

/**
* The page footer is not printed on the specified pages.
* 
* @param pages List of physical page numbers. Negative numbers count backwards from the last page: -1 is the last page, -2 is the last but one page, and so on. A comma seperated list of page numbers.
*/
HtmlToPdfClient.prototype.setExcludeFooterOnPages = function(pages) {
    if (!pages.match(/^(?:\s*\-?\d+\s*,)*\s*\-?\d+\s*$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(pages, "pages", "html-to-pdf", "A comma seperated list of page numbers.", "set_exclude_footer_on_pages"), 470);
    
    this.fields['exclude_footer_on_pages'] = pages;
};

/**
* Set an offset between physical and logical page numbers.
* 
* @param offset Integer specifying page offset.
*/
HtmlToPdfClient.prototype.setPageNumberingOffset = function(offset) {
    this.fields['page_numbering_offset'] = offset.toString();
};

/**
* Do not print the background graphics.
* 
* @param noBackground Set to <span class='field-value'>true</span> to disable the background graphics.
*/
HtmlToPdfClient.prototype.setNoBackground = function(noBackground) {
    this.fields['no_background'] = noBackground;
};

/**
* Do not execute JavaScript.
* 
* @param disableJavascript Set to <span class='field-value'>true</span> to disable JavaScript in web pages.
*/
HtmlToPdfClient.prototype.setDisableJavascript = function(disableJavascript) {
    this.fields['disable_javascript'] = disableJavascript;
};

/**
* Do not load images.
* 
* @param disableImageLoading Set to <span class='field-value'>true</span> to disable loading of images.
*/
HtmlToPdfClient.prototype.setDisableImageLoading = function(disableImageLoading) {
    this.fields['disable_image_loading'] = disableImageLoading;
};

/**
* Disable loading fonts from remote sources.
* 
* @param disableRemoteFonts Set to <span class='field-value'>true</span> disable loading remote fonts.
*/
HtmlToPdfClient.prototype.setDisableRemoteFonts = function(disableRemoteFonts) {
    this.fields['disable_remote_fonts'] = disableRemoteFonts;
};

/**
* Set the default HTML content text encoding.
* 
* @param defaultEncoding The text encoding of the HTML content.
*/
HtmlToPdfClient.prototype.setDefaultEncoding = function(defaultEncoding) {
    this.fields['default_encoding'] = defaultEncoding;
};

/**
* Set the HTTP authentication user name.
* 
* @param userName The user name.
*/
HtmlToPdfClient.prototype.setHttpAuthUserName = function(userName) {
    this.fields['http_auth_user_name'] = userName;
};

/**
* Set the HTTP authentication password.
* 
* @param password The password.
*/
HtmlToPdfClient.prototype.setHttpAuthPassword = function(password) {
    this.fields['http_auth_password'] = password;
};

/**
* Set the HTTP authentication.
* 
* @param userName Set the HTTP authentication user name.
* @param password Set the HTTP authentication password.
*/
HtmlToPdfClient.prototype.setHttpAuth = function(userName, password) {
    this.setHttpAuthUserName(userName);
    this.setHttpAuthPassword(password);
};

/**
* Use the print version of the page if available (@media print).
* 
* @param usePrintMedia Set to <span class='field-value'>true</span> to use the print version of the page.
*/
HtmlToPdfClient.prototype.setUsePrintMedia = function(usePrintMedia) {
    this.fields['use_print_media'] = usePrintMedia;
};

/**
* Do not send the X-Pdfcrowd HTTP header in Pdfcrowd HTTP requests.
* 
* @param noXpdfcrowdHeader Set to <span class='field-value'>true</span> to disable sending X-Pdfcrowd HTTP header.
*/
HtmlToPdfClient.prototype.setNoXpdfcrowdHeader = function(noXpdfcrowdHeader) {
    this.fields['no_xpdfcrowd_header'] = noXpdfcrowdHeader;
};

/**
* Set cookies that are sent in Pdfcrowd HTTP requests.
* 
* @param cookies The cookie string.
*/
HtmlToPdfClient.prototype.setCookies = function(cookies) {
    this.fields['cookies'] = cookies;
};

/**
* Do not allow insecure HTTPS connections.
* 
* @param verifySslCertificates Set to <span class='field-value'>true</span> to enable SSL certificate verification.
*/
HtmlToPdfClient.prototype.setVerifySslCertificates = function(verifySslCertificates) {
    this.fields['verify_ssl_certificates'] = verifySslCertificates;
};

/**
* Abort the conversion if the main URL HTTP status code is greater than or equal to 400.
* 
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
*/
HtmlToPdfClient.prototype.setFailOnMainUrlError = function(failOnError) {
    this.fields['fail_on_main_url_error'] = failOnError;
};

/**
* Abort the conversion if any of the sub-request HTTP status code is greater than or equal to 400.
* 
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
*/
HtmlToPdfClient.prototype.setFailOnAnyUrlError = function(failOnError) {
    this.fields['fail_on_any_url_error'] = failOnError;
};

/**
* Run a custom JavaScript after the document is loaded. The script is intended for post-load DOM manipulation (add/remove elements, update CSS, ...).
* 
* @param customJavascript String containing a JavaScript code. The string must not be empty.
*/
HtmlToPdfClient.prototype.setCustomJavascript = function(customJavascript) {
    if (!(customJavascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(customJavascript, "custom_javascript", "html-to-pdf", "The string must not be empty.", "set_custom_javascript"), 470);
    
    this.fields['custom_javascript'] = customJavascript;
};

/**
* Set a custom HTTP header that is sent in Pdfcrowd HTTP requests.
* 
* @param customHttpHeader A string containing the header name and value separated by a colon.
*/
HtmlToPdfClient.prototype.setCustomHttpHeader = function(customHttpHeader) {
    if (!customHttpHeader.match(/^.+:.+$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(customHttpHeader, "custom_http_header", "html-to-pdf", "A string containing the header name and value separated by a colon.", "set_custom_http_header"), 470);
    
    this.fields['custom_http_header'] = customHttpHeader;
};

/**
* Wait the specified number of milliseconds to finish all JavaScript after the document is loaded. The maximum value is determined by your API license.
* 
* @param javascriptDelay The number of milliseconds to wait. Must be a positive integer number or 0.
*/
HtmlToPdfClient.prototype.setJavascriptDelay = function(javascriptDelay) {
    if (!(parseInt(javascriptDelay) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascriptDelay, "javascript_delay", "html-to-pdf", "Must be a positive integer number or 0.", "set_javascript_delay"), 470);
    
    this.fields['javascript_delay'] = javascriptDelay.toString();
};

/**
* Convert only the specified element and its children. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. If the element is not found, the conversion fails. If multiple elements are found, the first one is used.
* 
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
*/
HtmlToPdfClient.prototype.setElementToConvert = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "selectors", "html-to-pdf", "The string must not be empty.", "set_element_to_convert"), 470);
    
    this.fields['element_to_convert'] = selectors;
};

/**
* Specify the DOM handling when only a part of the document is converted.
* 
* @param mode Allowed values are cut-out, remove-siblings, hide-siblings.
*/
HtmlToPdfClient.prototype.setElementToConvertMode = function(mode) {
    if (!mode.match(/^(cut-out|remove-siblings|hide-siblings)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "mode", "html-to-pdf", "Allowed values are cut-out, remove-siblings, hide-siblings.", "set_element_to_convert_mode"), 470);
    
    this.fields['element_to_convert_mode'] = mode;
};

/**
* Wait for the specified element in a source document. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. If the element is not found, the conversion fails.
* 
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
*/
HtmlToPdfClient.prototype.setWaitForElement = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "selectors", "html-to-pdf", "The string must not be empty.", "set_wait_for_element"), 470);
    
    this.fields['wait_for_element'] = selectors;
};

/**
* Set the viewport width in pixels. The viewport is the user's visible area of the page.
* 
* @param viewportWidth The value must be in a range 96-7680.
*/
HtmlToPdfClient.prototype.setViewportWidth = function(viewportWidth) {
    if (!(parseInt(viewportWidth) >= 96 && parseInt(viewportWidth) <= 7680))
        throw new Pdfcrowd.Error(createInvalidValueMessage(viewportWidth, "viewport_width", "html-to-pdf", "The value must be in a range 96-7680.", "set_viewport_width"), 470);
    
    this.fields['viewport_width'] = viewportWidth.toString();
};

/**
* Set the viewport height in pixels. The viewport is the user's visible area of the page.
* 
* @param viewportHeight Must be a positive integer number.
*/
HtmlToPdfClient.prototype.setViewportHeight = function(viewportHeight) {
    if (!(parseInt(viewportHeight) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(viewportHeight, "viewport_height", "html-to-pdf", "Must be a positive integer number.", "set_viewport_height"), 470);
    
    this.fields['viewport_height'] = viewportHeight.toString();
};

/**
* Set the viewport size. The viewport is the user's visible area of the page.
* 
* @param width Set the viewport width in pixels. The viewport is the user's visible area of the page. The value must be in a range 96-7680.
* @param height Set the viewport height in pixels. The viewport is the user's visible area of the page. Must be a positive integer number.
*/
HtmlToPdfClient.prototype.setViewport = function(width, height) {
    this.setViewportWidth(width);
    this.setViewportHeight(height);
};

/**
* Sets the rendering mode.
* 
* @param renderingMode The rendering mode. Allowed values are default, viewport.
*/
HtmlToPdfClient.prototype.setRenderingMode = function(renderingMode) {
    if (!renderingMode.match(/^(default|viewport)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(renderingMode, "rendering_mode", "html-to-pdf", "Allowed values are default, viewport.", "set_rendering_mode"), 470);
    
    this.fields['rendering_mode'] = renderingMode;
};

/**
* Set the scaling factor (zoom) for the main page area.
* 
* @param scaleFactor The scale factor. The value must be in a range 10-500.
*/
HtmlToPdfClient.prototype.setScaleFactor = function(scaleFactor) {
    if (!(parseInt(scaleFactor) >= 10 && parseInt(scaleFactor) <= 500))
        throw new Pdfcrowd.Error(createInvalidValueMessage(scaleFactor, "scale_factor", "html-to-pdf", "The value must be in a range 10-500.", "set_scale_factor"), 470);
    
    this.fields['scale_factor'] = scaleFactor.toString();
};

/**
* Set the scaling factor (zoom) for the header and footer.
* 
* @param headerFooterScaleFactor The scale factor. The value must be in a range 10-500.
*/
HtmlToPdfClient.prototype.setHeaderFooterScaleFactor = function(headerFooterScaleFactor) {
    if (!(parseInt(headerFooterScaleFactor) >= 10 && parseInt(headerFooterScaleFactor) <= 500))
        throw new Pdfcrowd.Error(createInvalidValueMessage(headerFooterScaleFactor, "header_footer_scale_factor", "html-to-pdf", "The value must be in a range 10-500.", "set_header_footer_scale_factor"), 470);
    
    this.fields['header_footer_scale_factor'] = headerFooterScaleFactor.toString();
};

/**
* Create linearized PDF. This is also known as Fast Web View.
* 
* @param linearize Set to <span class='field-value'>true</span> to create linearized PDF.
*/
HtmlToPdfClient.prototype.setLinearize = function(linearize) {
    this.fields['linearize'] = linearize;
};

/**
* Encrypt the PDF. This prevents search engines from indexing the contents.
* 
* @param encrypt Set to <span class='field-value'>true</span> to enable PDF encryption.
*/
HtmlToPdfClient.prototype.setEncrypt = function(encrypt) {
    this.fields['encrypt'] = encrypt;
};

/**
* Protect the PDF with a user password. When a PDF has a user password, it must be supplied in order to view the document and to perform operations allowed by the access permissions.
* 
* @param userPassword The user password.
*/
HtmlToPdfClient.prototype.setUserPassword = function(userPassword) {
    this.fields['user_password'] = userPassword;
};

/**
* Protect the PDF with an owner password.  Supplying an owner password grants unlimited access to the PDF including changing the passwords and access permissions.
* 
* @param ownerPassword The owner password.
*/
HtmlToPdfClient.prototype.setOwnerPassword = function(ownerPassword) {
    this.fields['owner_password'] = ownerPassword;
};

/**
* Disallow printing of the output PDF.
* 
* @param noPrint Set to <span class='field-value'>true</span> to set the no-print flag in the output PDF.
*/
HtmlToPdfClient.prototype.setNoPrint = function(noPrint) {
    this.fields['no_print'] = noPrint;
};

/**
* Disallow modification of the ouput PDF.
* 
* @param noModify Set to <span class='field-value'>true</span> to set the read-only only flag in the output PDF.
*/
HtmlToPdfClient.prototype.setNoModify = function(noModify) {
    this.fields['no_modify'] = noModify;
};

/**
* Disallow text and graphics extraction from the output PDF.
* 
* @param noCopy Set to <span class='field-value'>true</span> to set the no-copy flag in the output PDF.
*/
HtmlToPdfClient.prototype.setNoCopy = function(noCopy) {
    this.fields['no_copy'] = noCopy;
};

/**
* Turn on the debug logging.
* 
* @param debugLog Set to <span class='field-value'>true</span> to enable the debug logging.
*/
HtmlToPdfClient.prototype.setDebugLog = function(debugLog) {
    this.fields['debug_log'] = debugLog;
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
* Get the total number of pages in the output document.
* @return The page count.
*/
HtmlToPdfClient.prototype.getPageCount = function() {
    return this.helper.getPageCount();
};

/**
* Get the size of the output in bytes.
* @return The count of bytes.
*/
HtmlToPdfClient.prototype.getOutputSize = function() {
    return this.helper.getOutputSize();
};

/**
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* 
* @param useHttp Set to <span class='field-value'>true</span> to use HTTP.
*/
HtmlToPdfClient.prototype.setUseHttp = function(useHttp) {
    this.helper.setUseHttp(useHttp);
};

/**
* Set a custom user agent HTTP header. It can be usefull if you are behind some proxy or firewall.
* 
* @param userAgent The user agent string.
*/
HtmlToPdfClient.prototype.setUserAgent = function(userAgent) {
    this.helper.setUserAgent(userAgent);
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
* 
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
*/
HtmlToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
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
*/
HtmlToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "output_format", "html-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
};

/**
* Convert a web page.
* 
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @return Byte array containing the conversion output.
*/
HtmlToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "url", "html-to-image", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a web page and write the result to a local file.
* 
* @param url The address of the web page to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
*/
HtmlToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "html-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @return Byte array containing the conversion output.
*/
HtmlToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "file", "html-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "file", "html-to-image", "The file name must have a valid extension.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip).<br> If the HTML document refers to local external assets (images, style sheets, javascript), zip the document together with the assets. The file must exist and not be empty. The file name must have a valid extension.
* @param filePath The output file path. The string must not be empty.
*/
HtmlToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "html-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert a string.
* 
* @param text The string content to convert. The string must not be empty.
* @return Byte array containing the conversion output.
*/
HtmlToImageClient.prototype.convertString = function(text, callbacks) {
    if (!(text))
        return callbacks.error(createInvalidValueMessage(text, "text", "html-to-image", "The string must not be empty.", "convert_string"), 470);
    
    this.fields['text'] = text;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a string and write the output to a file.
* 
* @param text The string content to convert. The string must not be empty.
* @param filePath The output file path. The string must not be empty.
*/
HtmlToImageClient.prototype.convertStringToFile = function(text, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "html-to-image", "The string must not be empty.", "convert_string_to_file"), 470);
    
    this.convertString(text, saveToFile(filePath, callback));
};

/**
* Do not print the background graphics.
* 
* @param noBackground Set to <span class='field-value'>true</span> to disable the background graphics.
*/
HtmlToImageClient.prototype.setNoBackground = function(noBackground) {
    this.fields['no_background'] = noBackground;
};

/**
* Do not execute JavaScript.
* 
* @param disableJavascript Set to <span class='field-value'>true</span> to disable JavaScript in web pages.
*/
HtmlToImageClient.prototype.setDisableJavascript = function(disableJavascript) {
    this.fields['disable_javascript'] = disableJavascript;
};

/**
* Do not load images.
* 
* @param disableImageLoading Set to <span class='field-value'>true</span> to disable loading of images.
*/
HtmlToImageClient.prototype.setDisableImageLoading = function(disableImageLoading) {
    this.fields['disable_image_loading'] = disableImageLoading;
};

/**
* Disable loading fonts from remote sources.
* 
* @param disableRemoteFonts Set to <span class='field-value'>true</span> disable loading remote fonts.
*/
HtmlToImageClient.prototype.setDisableRemoteFonts = function(disableRemoteFonts) {
    this.fields['disable_remote_fonts'] = disableRemoteFonts;
};

/**
* Set the default HTML content text encoding.
* 
* @param defaultEncoding The text encoding of the HTML content.
*/
HtmlToImageClient.prototype.setDefaultEncoding = function(defaultEncoding) {
    this.fields['default_encoding'] = defaultEncoding;
};

/**
* Set the HTTP authentication user name.
* 
* @param userName The user name.
*/
HtmlToImageClient.prototype.setHttpAuthUserName = function(userName) {
    this.fields['http_auth_user_name'] = userName;
};

/**
* Set the HTTP authentication password.
* 
* @param password The password.
*/
HtmlToImageClient.prototype.setHttpAuthPassword = function(password) {
    this.fields['http_auth_password'] = password;
};

/**
* Set the HTTP authentication.
* 
* @param userName Set the HTTP authentication user name.
* @param password Set the HTTP authentication password.
*/
HtmlToImageClient.prototype.setHttpAuth = function(userName, password) {
    this.setHttpAuthUserName(userName);
    this.setHttpAuthPassword(password);
};

/**
* Use the print version of the page if available (@media print).
* 
* @param usePrintMedia Set to <span class='field-value'>true</span> to use the print version of the page.
*/
HtmlToImageClient.prototype.setUsePrintMedia = function(usePrintMedia) {
    this.fields['use_print_media'] = usePrintMedia;
};

/**
* Do not send the X-Pdfcrowd HTTP header in Pdfcrowd HTTP requests.
* 
* @param noXpdfcrowdHeader Set to <span class='field-value'>true</span> to disable sending X-Pdfcrowd HTTP header.
*/
HtmlToImageClient.prototype.setNoXpdfcrowdHeader = function(noXpdfcrowdHeader) {
    this.fields['no_xpdfcrowd_header'] = noXpdfcrowdHeader;
};

/**
* Set cookies that are sent in Pdfcrowd HTTP requests.
* 
* @param cookies The cookie string.
*/
HtmlToImageClient.prototype.setCookies = function(cookies) {
    this.fields['cookies'] = cookies;
};

/**
* Do not allow insecure HTTPS connections.
* 
* @param verifySslCertificates Set to <span class='field-value'>true</span> to enable SSL certificate verification.
*/
HtmlToImageClient.prototype.setVerifySslCertificates = function(verifySslCertificates) {
    this.fields['verify_ssl_certificates'] = verifySslCertificates;
};

/**
* Abort the conversion if the main URL HTTP status code is greater than or equal to 400.
* 
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
*/
HtmlToImageClient.prototype.setFailOnMainUrlError = function(failOnError) {
    this.fields['fail_on_main_url_error'] = failOnError;
};

/**
* Abort the conversion if any of the sub-request HTTP status code is greater than or equal to 400.
* 
* @param failOnError Set to <span class='field-value'>true</span> to abort the conversion.
*/
HtmlToImageClient.prototype.setFailOnAnyUrlError = function(failOnError) {
    this.fields['fail_on_any_url_error'] = failOnError;
};

/**
* Run a custom JavaScript after the document is loaded. The script is intended for post-load DOM manipulation (add/remove elements, update CSS, ...).
* 
* @param customJavascript String containing a JavaScript code. The string must not be empty.
*/
HtmlToImageClient.prototype.setCustomJavascript = function(customJavascript) {
    if (!(customJavascript))
        throw new Pdfcrowd.Error(createInvalidValueMessage(customJavascript, "custom_javascript", "html-to-image", "The string must not be empty.", "set_custom_javascript"), 470);
    
    this.fields['custom_javascript'] = customJavascript;
};

/**
* Set a custom HTTP header that is sent in Pdfcrowd HTTP requests.
* 
* @param customHttpHeader A string containing the header name and value separated by a colon.
*/
HtmlToImageClient.prototype.setCustomHttpHeader = function(customHttpHeader) {
    if (!customHttpHeader.match(/^.+:.+$/))
        throw new Pdfcrowd.Error(createInvalidValueMessage(customHttpHeader, "custom_http_header", "html-to-image", "A string containing the header name and value separated by a colon.", "set_custom_http_header"), 470);
    
    this.fields['custom_http_header'] = customHttpHeader;
};

/**
* Wait the specified number of milliseconds to finish all JavaScript after the document is loaded. The maximum value is determined by your API license.
* 
* @param javascriptDelay The number of milliseconds to wait. Must be a positive integer number or 0.
*/
HtmlToImageClient.prototype.setJavascriptDelay = function(javascriptDelay) {
    if (!(parseInt(javascriptDelay) >= 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(javascriptDelay, "javascript_delay", "html-to-image", "Must be a positive integer number or 0.", "set_javascript_delay"), 470);
    
    this.fields['javascript_delay'] = javascriptDelay.toString();
};

/**
* Convert only the specified element and its children. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. If the element is not found, the conversion fails. If multiple elements are found, the first one is used.
* 
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
*/
HtmlToImageClient.prototype.setElementToConvert = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "selectors", "html-to-image", "The string must not be empty.", "set_element_to_convert"), 470);
    
    this.fields['element_to_convert'] = selectors;
};

/**
* Specify the DOM handling when only a part of the document is converted.
* 
* @param mode Allowed values are cut-out, remove-siblings, hide-siblings.
*/
HtmlToImageClient.prototype.setElementToConvertMode = function(mode) {
    if (!mode.match(/^(cut-out|remove-siblings|hide-siblings)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(mode, "mode", "html-to-image", "Allowed values are cut-out, remove-siblings, hide-siblings.", "set_element_to_convert_mode"), 470);
    
    this.fields['element_to_convert_mode'] = mode;
};

/**
* Wait for the specified element in a source document. The element is specified by one or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a>. If the element is not found, the conversion fails.
* 
* @param selectors One or more <a href='https://developer.mozilla.org/en-US/docs/Learn/CSS/Introduction_to_CSS/Selectors'>CSS selectors</a> separated by commas. The string must not be empty.
*/
HtmlToImageClient.prototype.setWaitForElement = function(selectors) {
    if (!(selectors))
        throw new Pdfcrowd.Error(createInvalidValueMessage(selectors, "selectors", "html-to-image", "The string must not be empty.", "set_wait_for_element"), 470);
    
    this.fields['wait_for_element'] = selectors;
};

/**
* Set the output image width in pixels.
* 
* @param screenshotWidth The value must be in a range 96-7680.
*/
HtmlToImageClient.prototype.setScreenshotWidth = function(screenshotWidth) {
    if (!(parseInt(screenshotWidth) >= 96 && parseInt(screenshotWidth) <= 7680))
        throw new Pdfcrowd.Error(createInvalidValueMessage(screenshotWidth, "screenshot_width", "html-to-image", "The value must be in a range 96-7680.", "set_screenshot_width"), 470);
    
    this.fields['screenshot_width'] = screenshotWidth.toString();
};

/**
* Set the output image height in pixels. If it's not specified, actual document height is used.
* 
* @param screenshotHeight Must be a positive integer number.
*/
HtmlToImageClient.prototype.setScreenshotHeight = function(screenshotHeight) {
    if (!(parseInt(screenshotHeight) > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(screenshotHeight, "screenshot_height", "html-to-image", "Must be a positive integer number.", "set_screenshot_height"), 470);
    
    this.fields['screenshot_height'] = screenshotHeight.toString();
};

/**
* Turn on the debug logging.
* 
* @param debugLog Set to <span class='field-value'>true</span> to enable the debug logging.
*/
HtmlToImageClient.prototype.setDebugLog = function(debugLog) {
    this.fields['debug_log'] = debugLog;
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
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* 
* @param useHttp Set to <span class='field-value'>true</span> to use HTTP.
*/
HtmlToImageClient.prototype.setUseHttp = function(useHttp) {
    this.helper.setUseHttp(useHttp);
};

/**
* Set a custom user agent HTTP header. It can be usefull if you are behind some proxy or firewall.
* 
* @param userAgent The user agent string.
*/
HtmlToImageClient.prototype.setUserAgent = function(userAgent) {
    this.helper.setUserAgent(userAgent);
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
* 
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
*/
HtmlToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
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
* @return Byte array containing the conversion output.
*/
ImageToImageClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "url", "image-to-image", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert an image and write the result to a local file.
* 
* @param url The address of the image to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
*/
ImageToImageClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "image-to-image", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip). The file must exist and not be empty.
* @return Byte array containing the conversion output.
*/
ImageToImageClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "file", "image-to-image", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip). The file must exist and not be empty.
* @param filePath The output file path. The string must not be empty.
*/
ImageToImageClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "image-to-image", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert raw data.
* 
* @param data The raw content to be converted.
* @return Byte array with the output.
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
*/
ImageToImageClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "image-to-image", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
* The format of the output file.
* 
* @param outputFormat Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.
*/
ImageToImageClient.prototype.setOutputFormat = function(outputFormat) {
    if (!outputFormat.match(/^(png|jpg|gif|tiff|bmp|ico|ppm|pgm|pbm|pnm|psb|pct|ras|tga|sgi|sun|webp)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(outputFormat, "output_format", "image-to-image", "Allowed values are png, jpg, gif, tiff, bmp, ico, ppm, pgm, pbm, pnm, psb, pct, ras, tga, sgi, sun, webp.", "set_output_format"), 470);
    
    this.fields['output_format'] = outputFormat;
};

/**
* Resize the image.
* 
* @param resize The resize percentage or new image dimensions.
*/
ImageToImageClient.prototype.setResize = function(resize) {
    this.fields['resize'] = resize;
};

/**
* Rotate the image.
* 
* @param rotate The rotation specified in degrees.
*/
ImageToImageClient.prototype.setRotate = function(rotate) {
    this.fields['rotate'] = rotate;
};

/**
* Turn on the debug logging.
* 
* @param debugLog Set to <span class='field-value'>true</span> to enable the debug logging.
*/
ImageToImageClient.prototype.setDebugLog = function(debugLog) {
    this.fields['debug_log'] = debugLog;
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
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* 
* @param useHttp Set to <span class='field-value'>true</span> to use HTTP.
*/
ImageToImageClient.prototype.setUseHttp = function(useHttp) {
    this.helper.setUseHttp(useHttp);
};

/**
* Set a custom user agent HTTP header. It can be usefull if you are behind some proxy or firewall.
* 
* @param userAgent The user agent string.
*/
ImageToImageClient.prototype.setUserAgent = function(userAgent) {
    this.helper.setUserAgent(userAgent);
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
* 
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
*/
ImageToImageClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
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
* @param action Allowed values are join, shuffle.
*/
PdfToPdfClient.prototype.setAction = function(action) {
    if (!action.match(/^(join|shuffle)$/i))
        throw new Pdfcrowd.Error(createInvalidValueMessage(action, "action", "pdf-to-pdf", "Allowed values are join, shuffle.", "set_action"), 470);
    
    this.fields['action'] = action;
};

/**
* Perform an action on the input files.
* @return Byte array containing the output PDF.
*/
PdfToPdfClient.prototype.convertFiles = function(callbacks) {
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Perform an action on the input files and write the output PDF to a file.
* 
* @param filePath The output file path. The string must not be empty.
*/
PdfToPdfClient.prototype.convertFilesToFile = function(filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "pdf-to-pdf", "The string must not be empty.", "convert_files_to_file"), 470);
    
    this.convertFiles(saveToFile(filePath, callback));
};

/**
* Add a PDF file to the list of the input PDFs.
* 
* @param filePath The file path to a local PDF file. The file must exist and not be empty.
*/
PdfToPdfClient.prototype.addPdfFile = function(filePath) {
    if (!(fs.existsSync(filePath) && fs.statSync(filePath)['size'] > 0))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "pdf-to-pdf", "The file must exist and not be empty.", "add_pdf_file"), 470);
    
    this.files['f_' + this.fileId] = filePath;
    this.fileId++;
};

/**
* Add in-memory raw PDF data to the list of the input PDFs.
* 
* @param pdfRawData The raw PDF data. The input data must be PDF content.
*/
PdfToPdfClient.prototype.addPdfRawData = function(pdfRawData) {
    if (!(pdfRawData && pdfRawData.length > 300 && pdfRawData.slice(0, 4) == '%PDF'))
        throw new Pdfcrowd.Error(createInvalidValueMessage("raw PDF data", "pdf_raw_data", "pdf-to-pdf", "The input data must be PDF content.", "add_pdf_raw_data"), 470);
    
    this.rawData['f_' + this.fileId] = pdfRawData;
    this.fileId++;
};

/**
* Turn on the debug logging.
* 
* @param debugLog Set to <span class='field-value'>true</span> to enable the debug logging.
*/
PdfToPdfClient.prototype.setDebugLog = function(debugLog) {
    this.fields['debug_log'] = debugLog;
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
* Get the total number of pages in the output document.
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
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* 
* @param useHttp Set to <span class='field-value'>true</span> to use HTTP.
*/
PdfToPdfClient.prototype.setUseHttp = function(useHttp) {
    this.helper.setUseHttp(useHttp);
};

/**
* Set a custom user agent HTTP header. It can be usefull if you are behind some proxy or firewall.
* 
* @param userAgent The user agent string.
*/
PdfToPdfClient.prototype.setUserAgent = function(userAgent) {
    this.helper.setUserAgent(userAgent);
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
* 
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
*/
PdfToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
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
* @return Byte array containing the conversion output.
*/
ImageToPdfClient.prototype.convertUrl = function(url, callbacks) {
    if (!url.match(/^https?:\/\/.*$/i))
        return callbacks.error(createInvalidValueMessage(url, "url", "image-to-pdf", "The supported protocols are http:// and https://.", "convert_url"), 470);
    
    this.fields['url'] = url;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert an image and write the result to a local file.
* 
* @param url The address of the image to convert. The supported protocols are http:// and https://.
* @param filePath The output file path. The string must not be empty.
*/
ImageToPdfClient.prototype.convertUrlToFile = function(url, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "image-to-pdf", "The string must not be empty.", "convert_url_to_file"), 470);
    
    this.convertUrl(url, saveToFile(filePath, callback));
};

/**
* Convert a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip). The file must exist and not be empty.
* @return Byte array containing the conversion output.
*/
ImageToPdfClient.prototype.convertFile = function(file, callbacks) {
    if (!(fs.existsSync(file) && fs.statSync(file)['size'] > 0))
        return callbacks.error(createInvalidValueMessage(file, "file", "image-to-pdf", "The file must exist and not be empty.", "convert_file"), 470);
    
    this.files['file'] = file;
    return this.helper.post(this.fields, this.files, this.rawData, callbacks);
};

/**
* Convert a local file and write the result to a local file.
* 
* @param file The path to a local file to convert.<br> The file can be either a single file or an archive (.tar.gz, .tar.bz2, or .zip). The file must exist and not be empty.
* @param filePath The output file path. The string must not be empty.
*/
ImageToPdfClient.prototype.convertFileToFile = function(file, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "image-to-pdf", "The string must not be empty.", "convert_file_to_file"), 470);
    
    this.convertFile(file, saveToFile(filePath, callback));
};

/**
* Convert raw data.
* 
* @param data The raw content to be converted.
* @return Byte array with the output.
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
*/
ImageToPdfClient.prototype.convertRawDataToFile = function(data, filePath, callback) {
    if (!(filePath))
        throw new Pdfcrowd.Error(createInvalidValueMessage(filePath, "file_path", "image-to-pdf", "The string must not be empty.", "convert_raw_data_to_file"), 470);
    
    this.convertRawData(data, saveToFile(filePath, callback));
};

/**
* Resize the image.
* 
* @param resize The resize percentage or new image dimensions.
*/
ImageToPdfClient.prototype.setResize = function(resize) {
    this.fields['resize'] = resize;
};

/**
* Rotate the image.
* 
* @param rotate The rotation specified in degrees.
*/
ImageToPdfClient.prototype.setRotate = function(rotate) {
    this.fields['rotate'] = rotate;
};

/**
* Turn on the debug logging.
* 
* @param debugLog Set to <span class='field-value'>true</span> to enable the debug logging.
*/
ImageToPdfClient.prototype.setDebugLog = function(debugLog) {
    this.fields['debug_log'] = debugLog;
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
* Specifies if the client communicates over HTTP or HTTPS with Pdfcrowd API.
* 
* @param useHttp Set to <span class='field-value'>true</span> to use HTTP.
*/
ImageToPdfClient.prototype.setUseHttp = function(useHttp) {
    this.helper.setUseHttp(useHttp);
};

/**
* Set a custom user agent HTTP header. It can be usefull if you are behind some proxy or firewall.
* 
* @param userAgent The user agent string.
*/
ImageToPdfClient.prototype.setUserAgent = function(userAgent) {
    this.helper.setUserAgent(userAgent);
};

/**
* Specifies an HTTP proxy that the API client library will use to connect to the internet.
* 
* @param host The proxy hostname.
* @param port The proxy port.
* @param userName The username.
* @param password The password.
*/
ImageToPdfClient.prototype.setProxy = function(host, port, userName, password) {
    this.helper.setProxy(host, port, userName, password);
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
    Pdfcrowd: Pdfcrowd,
    saveToFile: saveToFile,
    sendHttpResponse: sendHttpResponse
};