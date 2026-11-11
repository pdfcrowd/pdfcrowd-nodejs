Change Log
==========

7.0.2
-----

- CHANGE: getStatusCode and httpCode now return numbers for explicit numeric string status arguments such as "503"; a missing status remains undefined

7.0.1
-----

- FIX: preserve status, reason, parsed message, documentation link, and cause when wrapping an existing Pdfcrowd.Error, including errors without a structured service message
- CHANGE: parsed error status and reason codes are now numbers; compare getStatusCode() and getReasonCode() with numbers such as 400 and 123 instead of strings; explicit string status arguments remain supported and missing status remains undefined

7.0.0
-----

- NEW: resolve content Promises to a complete Buffer and file-output Promises to the supplied filename after the destination is closed
- NEW: add Promise-based output-stream methods returning a Node.js Readable
- NEW: include TypeScript declarations and support CommonJS and native ES module imports
- FIX: allow content callback objects to omit the end handler or set it to undefined
- FIX: avoid the Buffer constructor deprecation warning when encoding credentials in bundled applications
- CHANGE: remove deprecated setters setUserAgent, setUseMobileUserAgent, setViewportWidth, setViewportHeight, setViewport, setRenderingMode, and setSmartScalingMode, and the error method getCode; use their supported replacements
- CHANGE: Pdfcrowd.Error now extends the native Error class
- CHANGE: return a Promise when the callback is omitted or undefined; retain existing callback behavior when a valid callback is supplied
- CHANGE: require Node.js 18 or newer for the complete supported SDK contract

6.7.1
-----

- FIX: preserve non-ASCII filenames when uploading input files and attachments
- FIX: clear inherited conversion inputs from each request while preserving conversion settings, auxiliary files, and in-flight requests
- FIX: preserve binary input stream bytes, including encoded streams without readableEncoding, and report read failures and premature closure before sending a conversion request
- FIX: report native I/O failures with consistent string messages and retain their causes in file-helper errors
- FIX: invoke file-helper callbacks once, after destination closure, and report response, write, and close failures without a later success callback
- FIX: allow sequential reuse of saveToFile callback objects and notify custom error handlers of destination failures after cleanup
- FIX: isolate each conversion's inputs, request settings, retries, and completion state so client reuse and later configuration changes do not alter an in-flight conversion

6.7.0
-----

- NEW: setConformance method for the HtmlToPdf API client - produce the output PDF at a specified PDF/A conformance level
- NEW: addAttachment method for the HtmlToPdf, PdfToPdf and ImageToPdf API clients - embed files as attachments in the output PDF
- NEW: setTaggedPdf method for the HtmlToPdf API client - create a tagged PDF for accessibility and content reflow

6.6.0
-----

- NEW: setDataVariableMarkers

6.5.4
-----

- DOCS: use online API reference instead of docstrings

6.5.3
-----

- DOCS: minor documentation updates

6.5.2
-----

- NEW: Renamed Pdfcrowd to PDFCrowd and other minor documentation changes.

6.5.0
-----

- NEW: The error handling system has been updated. This includes revised status codes and messages, as well as the addition of new methods to the error class: getStatusCode, getReasonCode, and getDocumentationLink. The getCode method is deprecated and should be replaced with getStatusCode.

6.4.0
-----

- NEW: setConverterUserAgent method for HtmlToPdf and HtmlToImage API client

6.3.0
-----

- NEW: setHtmlNamespace method for PdfToHtml API client
- NEW: setConverterVersion method for PdfToHtml API client
- fix a crash in PdfToHtml API client when PDF file contains a specific type3 font

6.2.1
-----

- fix setContentViewportWidth and setContentViewportHeight accepts a numeric value followed by the "px" unit to specify pixels

6.2.0
-----

- NEW: setType3Mode and setCustomCss methods for PdfToHtml API client
- NEW: the conversion config JSON supports `odd`, `even`, and `last` for page definition
- NEW: setPrintPageRange supports `odd`, `even`, and `last` for page selection

6.1.0
-----

- NEW: setConversionConfig and setConversionConfigFile methods for configuring HtmlToPdf API client

6.0.1
-----

- minor reorder of methods

6.0.0
-----

- NEW: the converter version 24.04 is used by default for the HtmlToPdf and HtmlToImage API client
- NEW: setContentViewportWidth method for the HtmlToPdf API client
- NEW: setContentViewportHeight method for the HtmlToPdf API client
- NEW: setContentFitMode method for the HtmlToPdf API client
- NEW: option `all` for the HtmlToPdf API client `setRemoveBlankPages` method

5.20.0
------

- NEW: PdftoImage API client for the converion from PDF to image

5.19.0
------

- NEW: `setConverterVersion` can now be switched to the beta version of converter 24.04

5.18.0
------

- NEW: setSplitLigatures method for the PdfToHtml API client

5.17.0
------

- NEW: setImageFormat method for the PdfToHtml API client
- NEW: mode value 'none' for setImageMode method for the PdfToHtml API client

5.16.0
------

- NEW: setDpi method for the PdfToHtml API client

5.15.0
------

- NEW: setMaxLoadingTime method for the HtmlToPdf and HtmlToImage API clients

5.14.0
------

- NEW: setCustomCss method for the HtmlToPdf and HtmlToImage API clients

5.13.0
------

- NEW: setRemoveBlankPages method for the HtmlToPdf API client

5.12.1
------

- FIX: retry conversion on error 503

5.12.0
------

- NEW: setCropAreaX, setCropAreaY, setCropAreaWidth, setCropAreaHeight and setRemoveBorders methods for ImageToImage and ImageToPdf API client

5.11.0
------

- NEW: canvas setup options for ImageToImage API client
- NEW: page setup, watermark/background and output options for ImageToPdf API client
- FIX: rotation for ImageToPdf API client

5.10.0
------

- NEW: PdftoText API client for the converion from PDF to plain text
- NEW: ImageToPdf API client supports watermarks, backgrounds and PDF format options
- NEW: single-page-fit-ex mode for setSmartScalingMode API method

5.9.0
-----

- NEW: getTotalPageCount to get the total page count of the source document
- NEW: readability-v4 mode for setReadabilityEnhancements API method

5.8.0
-----

- images can be used as a watermark and a background in HTML to PDF and PDF to PDF converter

5.7.0
-----

- NEW: readability-v2 and readability-v3 modes for setReadabilityEnhancements API method

5.6.2
-----

- minor update of documentation links

5.6.1
-----

- minor update of the text of the error message

5.6.0
-----

- NEW: setEnablePdfForms to convert HTML forms to fillable PDF forms
- minor update of the text of the error message

5.5.0
-----

- NEW: setAutodetectElementToConvert to detect the main HTML element for conversion
- NEW: setReadabilityEnhancements to enhance the input HTML to improve the readability
- NEW: pdfcrowd-source-title CSS class available for header and footer HTML

5.4.0
-----

- NEW: PDF to HTML converter
- NEW: setInputPdfPassword for PDF to PDF converter

5.3.0
-----

- NEW: setUseMobileUserAgent for HTML to PDF and HTML to Image

5.2.2
-----

- FIX: the hyperlinks to the PDFCrowd API documentation have been updated

5.2.0
-----

- NEW: setZipMainFilename
- NEW: setZipHeaderFilename
- NEW: setZipFooterFilename
- NEW: setExtractMetaTags
- NEW: setTitle for PDF to PDF
- NEW: setSubject for PDF to PDF
- NEW: setAuthor for PDF to PDF
- NEW: setKeywords for PDF to PDF

5.1.1
-----

- minor documentation updates

5.1.0
-----

- NEW: convertStream
- NEW: convertStreamToStream
- NEW: convertStreamToFile
- FIX: The main window scrollbar is not rendered in HTML to Image outputs.

5.0.0
-----

- NEW: converter version 20.10 supported
- NEW: setConverterVersion
- NEW: setLoadIframes
- NEW: setLocale
- NEW: setNoHeaderFooterHorizontalMargins
- NEW: setCssPageRuleMode
- NEW: setLayoutDpi
- NEW: setContentsMatrix
- NEW: setHeaderMatrix
- NEW: setFooterMatrix
- NEW: setDisablePageHeightOptimization
- NEW: setHeaderFooterCssAnnotation
- NEW: setMainDocumentCssAnnotation
- NEW: setBackgroundColor for the HtmlToImage API client

Older versions
--------------

- Details on the [PDFCrowd blog](https://pdfcrowd.com/blog/).

