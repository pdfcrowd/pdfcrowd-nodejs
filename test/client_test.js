var pdf = require('../lib/pdfcrowd');

credentials = require('./config').Credentials;

myPdfcrowd = new pdf.Pdfcrowd(credentials.username,
                              credentials.apikey);

var apiOptions =     {
    width: "11in",
    height: "8.5in",
    vmargin: ".4in",
    footer_html: '<div style=text-align:center;font-size:smaller;color:maroon;">\
                              Page %p out of %n\
                          </div>'
}

myPdfcrowd.convertFile("sample.html.zip", pdf.saveToFile("zfile.pdf"), apiOptions);
myPdfcrowd.convertHtml("raw code", pdf.saveToFile("html.pdf"));
myPdfcrowd.convertURI("http://example.com", pdf.saveToFile("url.pdf"));
myPdfcrowd.convertFile("sample.html", pdf.saveToFile("file.pdf"));
myPdfcrowd.convertHtml('footer example', pdf.saveToFile("footer.pdf"), apiOptions);


