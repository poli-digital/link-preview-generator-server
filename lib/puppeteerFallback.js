"use strict";

// Headless-browser fallback for JS-rendered / bot-protected pages. Enabled by
// default; opt out with PUPPETEER_FALLBACK=false.
//
// Key differences from the old design (a fresh browser per request, never closed
// on error) that keep memory bounded and stable:
//   1. ONE long-lived shared browser; only a page is opened/closed per request,
//      always in try/finally, so nothing leaks.
//   2. A concurrency limiter caps simultaneous pages so a burst of fallback
//      requests can't spike memory and OOM the pod.

const TIMEOUT_MS = Number(process.env.PREVIEW_TIMEOUT_MS || 8000);
const MAX_CONCURRENCY = Math.max(
	1,
	Number(process.env.PUPPETEER_MAX_CONCURRENCY || 3)
);

let browserPromise = null;

async function getBrowser() {
	if (browserPromise) return browserPromise;

	const puppeteer = require("puppeteer");
	const launchOptions = {
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage", // don't rely on the tiny /dev/shm in containers
			"--disable-gpu",
		],
	};
	// Allow pointing at a system Chromium (e.g. an apt-installed one) instead of
	// the bundled download.
	if (process.env.PUPPETEER_EXECUTABLE_PATH) {
		launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
	}

	browserPromise = puppeteer
		.launch(launchOptions)
		.then((browser) => {
			// If the browser dies, drop the cached promise so the next call relaunches.
			browser.on("disconnected", () => {
				browserPromise = null;
			});
			return browser;
		})
		.catch((err) => {
			browserPromise = null;
			throw err;
		});

	return browserPromise;
}

// --- tiny concurrency semaphore ------------------------------------------------
let active = 0;
const waiters = [];

function acquire() {
	if (active < MAX_CONCURRENCY) {
		active++;
		return Promise.resolve();
	}
	return new Promise((resolve) => waiters.push(resolve));
}

function release() {
	const next = waiters.shift();
	if (next) {
		next(); // hand the slot straight to the next waiter
	} else {
		active--;
	}
}
// ------------------------------------------------------------------------------

/**
 * Render a URL in the shared headless browser and return its final HTML.
 * @returns {Promise<{html: string, finalUrl: string}>}
 */
async function renderHtml(url) {
	await acquire();
	let page;
	try {
		const browser = await getBrowser();
		page = await browser.newPage();
		page.setDefaultNavigationTimeout(TIMEOUT_MS);
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
		return { html: await page.content(), finalUrl: page.url() };
	} finally {
		if (page) await page.close().catch(() => {});
		release();
	}
}

async function closeBrowser() {
	if (!browserPromise) return;
	const p = browserPromise;
	browserPromise = null;
	try {
		const browser = await p;
		await browser.close();
	} catch {
		/* already gone */
	}
}

module.exports = { renderHtml, closeBrowser };
