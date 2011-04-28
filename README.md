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

## Getting Started

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
        
    myPdfcrowd.convertHtml('<html>...</html>');
    
You can convert also a web page:
    
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

### Construction

     new Pdfcrowd(username, apikey);

Creates a Pdfcrowd instance.
    
### Methods

The following methods generate PDF. The optional *options* argument
lets you customize the created PDF. You can find the list of all
options
[here](http://pdfcrowd.com/html-to-pdf-api/#api-ref-conversion-common-par).

     Pdfcrowd.convertHtml(html [,options]);

Convert raw HTML code to PDF.

     Pdfcrowd.convertURI(url [,options]);

Convert a web page to PDF. The *url* argument must start with http:// or https://.

     Pdfcrowd.convertFile(fname [,options]);

Convert a local HTML file to PDF.
    
### Callbacks

      Pdfcrowd.on('pdf', function(readableStream){});

Called when the PDF [stream](http://nodejs.org/docs/latest/api/streams.html#readable_Stream) becomes available.


      Pdfcrowd.on('error', function(errorMsg, statusCode){});

Called when an error occurs. *errorMsg* is an string containing the
error message and *statusCode* is a HTTP status code.
 

# License (MIT License)

Copyright (c) 2011 pdfcrowd.com <info@pdfcrowd.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
    

