# PDFCrowd Node.js SDK

Convert HTML, PDF, and images in Node.js applications using the PDFCrowd API.

## Installation

Requires Node.js 18 or newer. Use a maintained Node.js LTS release for new applications.

```sh
npm install pdfcrowd
```

The SDK has no third-party runtime dependencies.
See [installation and setup](https://pdfcrowd.com/api/client-library/nodejs/)
for more information.

## TypeScript

TypeScript declarations are included. TypeScript projects must provide `@types/node`
16 or newer, using a version compatible with their compiler. Add it as a development
dependency if it is not already installed; the SDK does not install it automatically.

## Error codes

Starting with version 7.0.1, status and reason codes parsed from API errors
are numbers. Compare `error.getStatusCode() === 400`, rather than `=== "400"`;
use numeric comparisons for `error.getReasonCode()` too. An error without a
status retains `undefined`, and an error without a parsed reason retains `-1`.

Starting with version 7.0.2, the error constructor converts an explicit numeric
string status for an unformatted message to a number. `getStatusCode()` returns
`number | undefined`, and `getReasonCode()` returns `number`.
Wrapping an existing SDK error preserves its codes, message, documentation
link, string output, and original error as `cause`.

## Documentation

- [Authentication](https://pdfcrowd.com/api/authentication/): account credentials and API keys.
- [HTML-to-PDF guide](https://pdfcrowd.com/api/html-to-pdf-nodejs/): conversion basics and result handling.
- [Examples](https://pdfcrowd.com/api/html-to-pdf-nodejs/examples/): common conversion tasks.
- [API reference](https://pdfcrowd.com/api/html-to-pdf-nodejs/ref/): methods and options.
