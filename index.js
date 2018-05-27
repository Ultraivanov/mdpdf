'use strict';
const fs = require('fs');
const path = require('path');
const url = require('url');
const fileUrl = require('file-url');
const Promise = require('bluebird');
const showdown = require('showdown');
const showdownEmoji = require('showdown-emoji');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const Handlebars = require('handlebars');
const loophole = require('loophole');

const readFile = Promise.promisify(fs.readFile);
const writeFile = Promise.promisify(fs.writeFile);

// Main layout template
const layoutPath = path.join(__dirname, '/layouts/doc-body.hbs');
const headerLayoutPath = path.join(__dirname, '/layouts/header.hbs');
const footerLayoutPath = path.join(__dirname, '/layouts/footer.hbs');

// Syntax highlighting
const highlightJs = 'file://' + path.join(__dirname, '/assets/highlight/highlight.pack.js');

function getCssAsHtml(stylesheets) {
    // Read in all stylesheets and format them into HTML to
    // be placed in the header. We do this because the normal
    // <link...> doesn't work for the headers and footers.
	let styleHtml = '';
	for (const i in stylesheets) {
		if (Object.prototype.hasOwnProperty.call(stylesheets, i)) {
			const style = fs.readFileSync(stylesheets[i], 'utf8');
			styleHtml += '<style>' + style + '</style>';
		}
	}

	return styleHtml;
}

function getAllStyles(options) {
	const cssStyleSheets = [];

    // GitHub Markdown Style
	if (options.ghStyle) {
		cssStyleSheets.push(path.join(__dirname, '/assets/github-markdown-css.css'));
	}
    // Highlight CSS
	cssStyleSheets.push(path.join(__dirname, '/assets/highlight/styles/github.css'));

    // Some additional defaults such as margins
	if (options.defaultStyle) {
		cssStyleSheets.push(path.join(__dirname, '/assets/default.css'));
	}

    // Optional user given CSS
	if (options.styles) {
		cssStyleSheets.push(options.styles);
	}

	return getCssAsHtml(cssStyleSheets);
}

function parseMarkdownToHtml(markdown, convertEmojis) {
	showdown.setFlavor('github');
	const options = {
		prefixHeaderId: false,
		ghCompatibleHeaderId: true
	};

	// Sometimes emojis can mess with time representations
	// such as "00:00:00"
	if (convertEmojis) {
		options.extensions = [showdownEmoji];
	}

	const converter = new showdown.Converter(options);

	return converter.makeHtml(markdown);
}

function hasAcceptableProtocol(src) {
	const acceptableProtocols = ['http:', 'https:'].join('|');

	const theUrl = url.parse(src);

	if (!theUrl.protocol) {
		return false;
	}
	return new RegExp(acceptableProtocols).test(src);
}

function processSrc(src, options) {
	if (hasAcceptableProtocol(src)) {
        // The protocol is great and okay!
		return src;
	}

	// We need to convert it
	const resolvedSrc = path.resolve(options.assetDir, src);
	return fileUrl(resolvedSrc);
}

function qualifyImgSources(html, options) {
	const $ = cheerio.load(html);

	$('img').each((i, img) => {
		img.attribs.src = processSrc(img.attribs.src, options);
	});

	return $.html();
}

function convert(options) {
	options = options || {};
	if (!options.source) {
		throw new Error('Source path must be provided');
	}

	if (!options.destination) {
		throw new Error('Destination path must be provided');
	}

	options.assetDir = path.dirname(path.resolve(options.source));

	let template = {};
	let css = new Handlebars.SafeString(getAllStyles(options))
	const local = {
		highlightJs,
		css: css
	};

	// Pull in the header
	return prepareHeader(options).then(header => {
		options.header = header;

		// Pull in the footer
		return prepareFooter(options);
	}).then(footer => {
		options.footer = footer;

		// Pull in the handlebars layout so we can build the document body
		return readFile(layoutPath, 'utf8')
	}).then(layout => {
		template = Handlebars.compile(layout);

		// Pull in the document source markdown
		return readFile(options.source, 'utf8');
	}).then(mdDoc => {
		// Compile the main document
		let content = parseMarkdownToHtml(mdDoc, !options.noEmoji);

		content = qualifyImgSources(content, options);

		local.body = new Handlebars.SafeString(content);
		// Use loophole for this body template to avoid issues with editor extensions
		const html = loophole.allowUnsafeNewFunction(() => template(local));

		return createPdf(html, options);
	});
}

function prepareHeader(options) {
	if (options.header) {
		let headerTemplate;

		// Get the hbs layout
		return readFile(headerLayoutPath, 'utf8').then(headerLayout => {
			headerTemplate = Handlebars.compile(headerLayout);

			// Get the header html
			return readFile(options.header, 'utf8');
		}).then(headerContent => {
			const preparedHeader = qualifyImgSources(headerContent, options);
			
			// Compile the header template
			const headerHtml = headerTemplate({
				content: new Handlebars.SafeString(preparedHeader)
			});

			return headerHtml;
		});
	} else {
		return Promise.resolve();
	}
}

function prepareFooter(options) {
	if (options.footer) {
		return readFile(options.footer, 'utf8').then(footerContent => {
			const preparedFooter = qualifyImgSources(footerContent, options);

			return preparedFooter;
		});
	} else {
		return Promise.resolve();
	}
}

function createPdf(html, options) {
	// Write html to a temp file
	let browser;
	let page;

	const tempHtmlPath = path.join(path.dirname(options.destination), '_temp.html');
	
	return writeFile(tempHtmlPath, html).then(() => {
		return puppeteer.launch({ headless: true });
	}).then(newBrowser => {
		browser = newBrowser
		return browser.newPage();
	}).then(p => {
		page = p;

		return page.goto('file:' + tempHtmlPath, { waitUntil: 'networkidle2' });
	}).then(() => {
		const puppetOptions = {
			path: options.destination,
			displayHeaderFooter: false,
			printBackground: true,
			format: options.pdf.format,
			margin: {
				top: options.pdf.border.top,
				right: options.pdf.border.right,
				bottom: options.pdf.border.bottom,
				left: options.pdf.border.left
			},
			displayHeaderFooter: !!options.header || !!options.footer,
			headerTemplate: options.header || null,
			footerTemplate: options.footer || null
		};

		return page.pdf(puppetOptions);
	}).then(() => {
		return browser.close();
	}).then(() => {
		fs.unlinkSync(tempHtmlPath);

		return options.destination;
	});
}

module.exports = {
	convert
};
