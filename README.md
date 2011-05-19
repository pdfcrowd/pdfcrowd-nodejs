# node-pdfcrowd

A wrapper for the Pdfcrowd API which lets you convert web pages and raw HTML code to PDF.

You must have an account on
[http://pdfcrowd.com](https://pdfcrowd.com). This will give you a
username and an API key. Here is the
[API overview](https://pdfcrowd.com/html-to-pdf-api/).

## Installation

To install via npm:

    $ npm install pdfcrowd
    
Or clone from GitHub and create a symlink in `~/.node_libraries`:

    $ git clone git@github.com:pdfcrowd/node-pdfcrowd.git
    $ ln -s /path/to/node-pdfcrowd ~/.node_libraries/pdfcrowd    

    
Dependencies

* http *native module*
* querystring *native module*
* fs *native module*

## Getting Started

The following code converts raw HTML code to PDF and returns it in an
HTTP
[response](http://nodejs.org/docs/latest/api/http.html#http.ServerResponse)
(don't forget to use your `"username"` and `"apikey"`):

    var pdf = require('pdfcrowd');

    var client = new pdf.Pdfcrowd('username', 'apikey');
    client.convertHtml('<html>regular HTML code</html>', pdf.sendHttpResponse(response));
    
You can convert also a web page and save it to a file:
    
    client.convertURI('http://example.com', pdf.saveToFile("example_com.pdf"));

Or a local HTML file:
    
    client.convertFile('/local/file.html', pdf.saveToFile("file.pdf"));
    
The generated PDF can be customized:

    client.convertURI(
        'http://example.com', 
        pdf.saveToFile("example_com.pdf"),
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

     new Pdfcrowd(username, apikey)

Creates a Pdfcrowd instance.
    
### Methods

     Pdfcrowd.convertHtml(html, callbacks [,options])

Converts raw HTML code to PDF.

     Pdfcrowd.convertURI(url, callbacks [,options])

Converts a web page to PDF. The *url* argument must start with http:// or https://.

     Pdfcrowd.convertFile(fname, callbacks [,options])

Converts a local HTML file to PDF.

#### Common arguments:

* The *callbacks* argument is an object that should define the following methods:

        pdf(readableStream)
  Called when the PDF [stream](http://nodejs.org/docs/latest/api/streams.html#readable_Stream) becomes available.
  
        end()
  Called when all PDF data has been read.
        
        error(errorMessage, statusCode)
  Called when an error occurs. *errorMessage* is a string containing the error message and *statusCode* is a HTTP status code.
  
* The optional *options* argument lets you customize the created
  PDF. You can find the list of all options
  [here](https://pdfcrowd.com/html-to-pdf-api/#api-ref-conversion-common-par).

    
### Helpers

These functions return a callback object that can be passed to
the methods above.

    saveToFile(fileName)
    
Saves the generated PDF to a file.
    
    sendHttpResponse(response [,disposition])
    
Returns the generated PDF in an HTTP
[response](http://nodejs.org/docs/latest/api/http.html#http.ServerResponse). *dispostion*
can be `"attachment"` (default) or `"inline"`.



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
    

