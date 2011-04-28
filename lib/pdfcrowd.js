var http = require('http')
var querystring = require('querystring');
var fs = require('fs');


var Pdfcrowd = function(username, apikey) {

    // TBD: check username & apikey not null
    this.username = username;
    this.apikey = apikey;

    this.httpOptions = {
        host: 'pdfcrowd.com',
        port: 80,
        method: 'POST',
    };

    this.callbacks = {
        error: function(status, err) {
            console.warn("WARNING: [Pdfcrowd] Unhandled error: %d - %s", status, err);
        },
        pdf: function(rstream) {
            rstream.destroy();
            console.log("WARNING: [Pdfcrowd] Unhandled PDF generation.");
        }
    };
};



Pdfcrowd.prototype.on = function(event, callback) {
    // TBD: verify event
    this.callbacks[event] = callback;
};

Pdfcrowd.prototype.convertHtml = function(html, options) {
    convertInternal(this, html, options, '/api/pdf/convert/html/');
}

Pdfcrowd.prototype.convertURI = function(uri, options) {
    convertInternal(this, uri, options, '/api/pdf/convert/uri/');
}

Pdfcrowd.prototype.convertFile = function(fname, options) {
    var that = this;
    fs.readFile(fname, function(err, data) {
        if (err) throw err;
        convertInternal(that, data.toString(), options, '/api/pdf/convert/html/');
    });
}




module.exports = Pdfcrowd;


// ---------------------------------------------------------------------------
//                          private


var convertInternal = function(that, src, options, endpoint) {

    // form POST data
    var postData = clone_object(options);
    postData['src'] = src;
    postData['username'] = that.username;
    postData['key'] = that.apikey;
    postData = querystring.stringify(postData);
    //console.log("%d - %s", postData.length, postData);

    // http options
    var httpOptions = clone_object(that.httpOptions);
    httpOptions['path'] = endpoint;
    httpOptions['headers'] = { 'content-length': postData.length,
                               'content-type': 'application/x-www-form-urlencoded' };

    var req = http.request(httpOptions, function(res) {
        if (res.statusCode < 300) {
            that.callbacks['pdf'](res);
        }
        else {
            var err = [];
            res.on('data', function(chunk) {
                err.push(chunk.toString());
            });
            res.on('end', function() {
                that.callbacks['error'](res.statusCode, err.join(''));
            });
        }
    });

    req.on('error', function(res) {
        that.callbacks['error'](res.statusCode, res.toString());
    });

    req.write(postData);
    req.end();
}



var clone_object = function(obj) {
    var prop, cloned = {};
    for (prop in obj) {
        if (typeof obj !== 'function') {
            cloned[prop] = obj[prop];
        }
    }
    return cloned;
};
