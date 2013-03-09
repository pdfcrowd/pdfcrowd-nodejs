var pdf = require('../lib/pdfcrowd');
var assert = require('assert');

credentials = require('./config').Credentials;

myPdfcrowd = new pdf.Pdfcrowd(credentials.username,
                              credentials.apikey,
                              credentials.host);

var apiOptions =  {
    width: "11in",
    height: "8.5in",
    vmargin: ".4in",
    footer_html: '<div style=text-align:center;font-size:smaller;color:maroon;">\
                              Page %p out of %n\
                          </div>'
};

assert.throws(function() { myPdfcrowd.convertHtml(""); });
assert.throws(function() { myPdfcrowd.convertURI(null); });

function out_stream(name) {
    return pdf.saveToFile("../test_files/out/node_client_" + name);
}

myPdfcrowd.convertFile("sample.html.zip", out_stream("zfile.pdf"), apiOptions);
myPdfcrowd.convertHtml("raw code", out_stream("html.pdf"));
myPdfcrowd.convertURI("http://example.com", out_stream("url.pdf"));
myPdfcrowd.convertFile("sample.html", out_stream("file.pdf"));
myPdfcrowd.convertHtml('footer example', out_stream("footer.pdf"), apiOptions);


