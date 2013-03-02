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

init:
	test -d ../test_files/out || mkdir -p ../test_files/out
	test -e test_files || ln -s ../test_files/ test_files

clean:
	rm -rf ./test_files/out/node_*.pdf