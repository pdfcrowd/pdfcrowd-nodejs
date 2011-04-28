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


Pdfcrowd.prototype.convertHtml = function(html, callbacks, options) {
    requestQueue.addRequest([this, html, '/api/pdf/convert/html/', callbacks, options]);
}


Pdfcrowd.prototype.convertURI = function(uri, callbacks, options) {
    requestQueue.addRequest([this, uri, '/api/pdf/convert/uri/', callbacks, options]);
}


Pdfcrowd.prototype.convertFile = function(fname, callbacks, options) {
    var that = this;
    fs.readFile(fname, function(err, data) {
        if (err) throw err;
        requestQueue.addRequest([that, data.toString(), '/api/pdf/convert/html/', callbacks, options]);
    });
}


module.exports = Pdfcrowd;


// ---------------------------------------------------------------------------
//                          private


var convertInternal = function(that, src, endpoint, callbacks, options) {

    // form POST data
    var postData = clone_object(options);
    postData['src'] = src;
    postData['username'] = that.username;
    postData['key'] = that.apikey;
    postData = querystring.stringify(postData);
    //console.log("%d - %s", postData.length, postData);

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



var clone_object = function(obj) {
    var prop, cloned = {};
    for (prop in obj) {
        if (typeof obj !== 'function') {
            cloned[prop] = obj[prop];
        }
    }
    return cloned;
};
