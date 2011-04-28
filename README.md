# node-pdfcrowd

A wrapper for the Pdfcrowd API which lets you convert web pages and raw HTML code to PDF.

You must have an account on
[http://pdfcrowd.com](http://pdfcrowd.com). This will give you a
username and an API key. Here is the
[API overview](http://pdfcrowd.com/html-to-pdf-api/).

## Installation

    $ git clone git@github.com:pdfcrowd/node-pdfcrowd.git
    
Dependencies

* http *native module*
* querystring *native module*
* fs *native module*

## Example

The following code converts raw HTML code to PDF and sends it as a response:

    var Pdfcrowd = require('./lib/pdfcrowd');

    var myPdfcrowd = new Pdfcrowd('your-username', 'your-api-key');
        
    myPdfcrowd.on('pdf', function(rstream) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("accept-ranges", "none");
        res.setHeader("content-disposition", "attachment; filename=\"generated.pdf\"");
        rstream.pipe(res);
    });
        
    myPdfcrowd.on('error', function(statusCode, err) {
        res.setHeader("Content-Type", "text/plain");
        res.end('ERROR: ' + err);
    });

    myPdfcrowd.convertHtml('<html>...</html>');
    
You can convert also a webpage:
    
    myPdfcrowd.convertURI('http://example.com');

Or a local html file:
    
    myPdfcrowd.convertFile('/local/file.html');
    

    

