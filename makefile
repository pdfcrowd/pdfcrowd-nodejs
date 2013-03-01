all: help

help:
	@echo "targets:"
	@echo " tarball ... creates a tarball"

.PHONY: test
test:
	make -C ./test test

dist:
	rm -f node-pdfcrowd.tgz
	tar -czf node-pdfcrowd.tgz \
		--exclude=.git \
		'--exclude=*~' \
		--exclude=test/config.js \
	    '--exclude=*.pdf' \
	    -C .. node-pdfcrowd