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
const layoutPath = path.join(__dirname, 'layout.hbs');

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
	const local = {
		highlightJs,
		css: new Handlebars.SafeString(getAllStyles(options))
	};

    // Read the layout and compile it
	return readFile(layoutPath, 'utf8').then(layout => {
		template = Handlebars.compile(layout);

		if (options.header) {
			return readFile(options.header, 'utf8');
		}
		Promise.resolve();
	}).then(headerContent => {
		if (headerContent) {
			const preparedHeader = qualifyImgSources(headerContent, options);
			local.header = new Handlebars.SafeString(preparedHeader);
		}

		if (options.footer) {
			return readFile(options.footer, 'utf8');
		}
		Promise.resolve();
	}).then(footerContent => {
		if (footerContent) {
			const preparedFooter = qualifyImgSources(footerContent, options);
			local.footer = new Handlebars.SafeString(preparedFooter);
		}

		return readFile(options.source, 'utf8');
	}).then(md => {
		let content = parseMarkdownToHtml(md, !options.noEmoji);

		content = qualifyImgSources(content, options);

        // Append final html to the template body
		local.body = new Handlebars.SafeString(content);

        // Generate html from layout and templates
		const html = loophole.allowUnsafeNewFunction(() => template(local));

		if (options.debug) {
            // Write debug html
			fs.writeFileSync(options.debug, html);
		}

		return createPdf(html, options);
	});
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
			}
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
