var http = require('http');
var querystring = require('querystring');

var Pdfcrowd = function(username, apikey) {
    this.username = username;
    this.apikey = apikey;

    this.httpOptions = {
        host: 'pdfcrowd.com',
        port: 80,
        // path: '/api/pdf/convert/html/',
        method: 'POST',
        // headers: { 'content-length': postData.length,
        //            'content-type': 'application/x-www-form-urlencoded' }
    };
};

var clone_object = function(obj) {
    var prop, cloned = {};
    for (prop in obj) {
        if (typeof obj !== 'function') {
            cloned[prop] = obj[prop];
        }
    }
    return cloned;
};


Pdfcrowd.prototype.convertHtml = function(server_res, html, options) {

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
        console.log('STATUS: ' + res.statusCode);
        console.log('HEADERS: ' + JSON.stringify(res.headers));

        res.on('end', function () {
            server_res.end();
        });

        if (res.statusCode < 299) {
            server_res.setHeader("Content-Type", "application/pdf");
            server_res.setHeader("cache-control", "no-cache");
            server_res.setHeader("accept-ranges", "none");
            server_res.setHeader("content-disposition", "attachment; filename=\"generated.pdf\"");
            res.on('data', function (chunk) {
                server_res.write(chunk);
            });
        }
        else {
            server_res.write("some error");
            server_res.end();
        }
        
    });

    req.on('error', function(res) {
        console.log('STATUS: ' + res.statusCode);
        console.log('** ' + res);
        server_res.end('FATALek!\n');
    });

    req.write(postData);
    req.end();
}

module.exports = Pdfcrowd;