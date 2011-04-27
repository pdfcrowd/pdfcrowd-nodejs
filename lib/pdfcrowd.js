var http = require('http');
var querystring = require('querystring');


var Pdfcrowd = function(username, apikey) {
    this.username = username;
    this.apikey = apikey;
    this.httpOptions = {
        host: 'pdfcrowd.com',
        port: 80,
        method: 'POST',
    };
    this.callbacks = {
        error: function() {
            console.log("unhandled error");
        },
        pdf: function(rstream) {
            rstream.destroy();
            console.log("unhandled pdf");
        }
    };
};



Pdfcrowd.prototype.on = function(event, callback) {
    this.callbacks[event] = callback;
};



Pdfcrowd.prototype.convertHtml = function(server_res, html, options) {
    var that = this;

    // form POST data
    var postData = clone_object(options);
    postData['src'] = html;
    postData['username'] = this.username;
    postData['key'] = this.apikey;
    postData = querystring.stringify(postData);
    console.log("%d - %s", postData.length, postData);

    // http options
    var httpOptions = clone_object(this.httpOptions);
    httpOptions['path'] = '/api/pdf/convert/html/';
    httpOptions['headers'] = { 'content-length': postData.length,
                               'content-type': 'application/x-www-form-urlencoded' };
    
    var req = http.request(httpOptions, function(res) {
        console.log('HEADERS: ' + JSON.stringify(res.headers));

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

module.exports = Pdfcrowd;


// ---------------------------------------------------------------------------
//                          private

var clone_object = function(obj) {
    var prop, cloned = {};
    for (prop in obj) {
        if (typeof obj !== 'function') {
            cloned[prop] = obj[prop];
        }
    }
    return cloned;
};
