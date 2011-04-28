var Pdfcrowd = require('../lib/pdfcrowd');
var fs = require('fs');

credentials = require('./config').Credentials;

function saveToFile(fname) {
    return {
        pdf: function(rstream) { 
            wstream = fs.createWriteStream(fname);
            rstream.pipe(wstream);
        },
        end: function() { console.log("end"); },
        error: function(errMessage, statusCode) { console.log("ERROR: " + errMessage); },
    };
}

myPdfcrowd = new Pdfcrowd(credentials.username,
                          credentials.apikey);

//myPdfcrowd.convertHtml("raw code", saveToFile("html.pdf"))
//myPdfcrowd.convertURI("http://example.com", saveToFile("url.pdf"))
myPdfcrowd.convertFile("sample.html", saveToFile("file.pdf"))
