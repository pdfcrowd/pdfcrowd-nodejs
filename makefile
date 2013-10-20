all: help

help:
	@echo "targets:"
	@echo " dist ... creates a tarball"

.PHONY: test
test:
	make -C ./test test

.PHONY: dist
dist:
	mkdir -p dist
	rm -f dist/node-pdfcrowd.tgz
	tar -czf dist/node-pdfcrowd.tgz \
		'--exclude=.git*' \
		'--exclude=*~' \
		'--exclude=test/config.js' \
	    '--exclude=*.pdf' \
	    '--exclude=*/dist' \
	    '--exclude=*/test_files' \
	    -C .. node-pdfcrowd


init:
	test -d ../test_files/out || mkdir -p ../test_files/out
	test -e test_files || ln -s ../test_files/ test_files

clean:
	rm -rf ./test_files/out/node_*.pdf dist/*