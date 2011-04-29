all: help

help:
	@echo "targets:"
	@echo " tarball ... creates a tarball"

tarball:
	rm -f node-pdfcrowd.tgz
	tar -czf node-pdfcrowd.tgz \
		--exclude=.git \
		'--exclude=*~' \
		--exclude=test/config.js \
	    '--exclude=*.pdf' \
	    -C .. node-pdfcrowd