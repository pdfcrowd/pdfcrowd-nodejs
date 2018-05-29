VERSION = 4.3.3

.PHONY: dist
dist:
	rm -rf dist/ ; mkdir dist/
	rm -rf /tmp/pdfcrowd-$(VERSION)
	mkdir /tmp/pdfcrowd-$(VERSION)
	cp -r * /tmp/pdfcrowd-$(VERSION)
	cd /tmp && ls -la pdfcrowd-$(VERSION)
	cd /tmp && zip -r $(CURDIR)/dist/pdfcrowd-$(VERSION)-nodejs.zip \
		-x\*dist\* \
		pdfcrowd-$(VERSION)

publish:
	npm publish --access public

clean:
	rm -rf dist/* *.tgz
