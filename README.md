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
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Accept-Ranges", "none");
        res.setHeader("Content-Disposition", "attachment; filename=\"generated.pdf\"");
        rstream.pipe(res);
    });
        
    myPdfcrowd.on('error', function(statusCode, err) {
        res.setHeader("Content-Type", "text/plain");
        res.end('ERROR: ' + err);
    });

    myPdfcrowd.convertHtml('<html>...</html>');
    
You can convert also a webpage:
    
    myPdfcrowd.convertURI('http://example.com');

Or a local HTML file:
    
    myPdfcrowd.convertFile('/local/file.html');
    
The generated PDF can be customized:

    myPdfcrowd.convertURI(
        'http://example.com', 
        {
            width: "11in",
            height: "8.5in",
            vmargin: ".4in",
            footer_html: '<div style=text-align:center;font-size:smaller;color:maroon;">\
                              Page %p out of %n\
                          </div>'
        });

## Reference    
    

    

