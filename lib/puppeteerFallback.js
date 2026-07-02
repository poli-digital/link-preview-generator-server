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
//   3. SELF-HEALING: if Chrome isn't installed (wrong cache dir, fresh volume,
//      build-time download skipped), we kick off a background download of the
//      exact build this Puppeteer pins — WITHOUT ever blocking a request. The
//      current request just falls back gracefully; once the download finishes,
//      later requests get the browser. The service is never interrupted.

const path = require("path");
const { execFile } = require("child_process");

const TIMEOUT_MS = Number(process.env.PREVIEW_TIMEOUT_MS || 8000);
const MAX_CONCURRENCY = Math.max(
	1,
	Number(process.env.PUPPETEER_MAX_CONCURRENCY || 3)
);
// Auto-install missing Chrome at runtime. On by default; disable with
// PUPPETEER_AUTO_INSTALL=false (e.g. read-only FS where install can't work).
const AUTO_INSTALL = process.env.PUPPETEER_AUTO_INSTALL !== "false";

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
			// Chrome missing? Trigger a background install so future requests recover.
			// Fire-and-forget — we do NOT await it, so this request is not blocked.
			if (AUTO_INSTALL && isChromeMissing(err)) {
				ensureChromeInstalled();
			}
			throw err;
		});

	return browserPromise;
}

// --- self-healing Chrome install ----------------------------------------------

let installPromise = null;

// Matches the "Could not find Chrome" / failed-to-launch (ENOENT) family of
// errors that mean the browser binary isn't where Puppeteer expects it.
function isChromeMissing(err) {
	const msg = (err && err.message) || "";
	return (
		/could not find (?:expected )?(?:chrome|browser)/i.test(msg) ||
		/failed to launch the browser process/i.test(msg) ||
		/spawn .* enoent/i.test(msg) ||
		/no such file or directory/i.test(msg)
	);
}

/**
 * Install the Chrome build this Puppeteer pins, in the background, at most once
 * at a time. Runs the local Puppeteer CLI (`puppeteer browsers install chrome`)
 * so the version always matches the installed package. Never throws to callers
 * and never blocks the request path.
 * @returns {Promise<boolean>} resolves true on success, false on failure
 */
function ensureChromeInstalled() {
	if (installPromise) return installPromise;

	const bin = path.resolve(
		__dirname,
		"..",
		"node_modules",
		".bin",
		process.platform === "win32" ? "puppeteer.cmd" : "puppeteer"
	);

	console.info("Chrome not found — starting background install (non-blocking)...");
	installPromise = new Promise((resolve) => {
		execFile(
			bin,
			["browsers", "install", "chrome"],
			{ env: process.env, timeout: 5 * 60 * 1000 },
			(err, stdout, stderr) => {
				installPromise = null; // allow a later retry if this attempt failed
				if (err) {
					console.error(
						`Background Chrome install failed: ${err.message}${
							stderr ? ` — ${stderr.trim()}` : ""
						}`
					);
					return resolve(false);
				}
				// New binary available: drop any cached (failed) browser promise so the
				// next getBrowser() relaunches and picks it up.
				browserPromise = null;
				console.info(`Chrome installed: ${(stdout || "").trim()}`);
				resolve(true);
			}
		);
	});

	return installPromise;
}

/**
 * Proactively ensure Chrome is present at startup so the first fallback request
 * doesn't have to wait for a download. Fire-and-forget; safe to ignore.
 */
function warmup() {
	if (!AUTO_INSTALL) return;
	if (process.env.PUPPETEER_EXECUTABLE_PATH) return; // caller manages the binary
	try {
		const puppeteer = require("puppeteer");
		const fs = require("fs");
		const execPath = puppeteer.executablePath();
		if (execPath && fs.existsSync(execPath)) return; // already there
	} catch {
		/* fall through to install */
	}
	ensureChromeInstalled();
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

module.exports = { renderHtml, closeBrowser, warmup, ensureChromeInstalled };
