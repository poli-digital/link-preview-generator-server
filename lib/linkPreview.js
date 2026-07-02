"use strict";

const { extractMetadata } = require("./extractMetadata");

// A modern browser UA is the most broadly accepted: many sites (e.g. Wikipedia)
// 403 obvious crawler UAs but serve everyone else, and OG tags live in the HTML
// either way. Override via PREVIEW_USER_AGENT (e.g. facebookexternalhit) if a
// specific target serves richer markup to social crawlers.
const USER_AGENT =
	process.env.PREVIEW_USER_AGENT ||
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = Number(process.env.PREVIEW_TIMEOUT_MS || 8000);
// Cap the body we read so a giant/streaming page can't blow up memory. OG tags
// live in <head>, so a couple hundred KB is plenty.
const MAX_HTML_BYTES = Number(process.env.PREVIEW_MAX_BYTES || 512 * 1024);

// Fallback is ON by default so coverage matches the old all-Chromium behavior
// (JS-rendered pages, bot-protected sites). Opt OUT with PUPPETEER_FALLBACK=false.
const FALLBACK_ENABLED = process.env.PUPPETEER_FALLBACK !== "false";

class PreviewError extends Error {
	constructor(message, status = 502) {
		super(message);
		this.name = "PreviewError";
		this.status = status;
	}
}

function assertValidHttpUrl(raw) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new PreviewError(`Invalid url: ${raw}`, 400);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new PreviewError(`Unsupported protocol: ${parsed.protocol}`, 400);
	}
	return parsed;
}

/**
 * Fetch the HTML of a page with a hard timeout and a bounded body size.
 * @returns {Promise<{html: string, finalUrl: string}>}
 */
async function fetchHtml(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let response;
	try {
		response = await fetch(url, {
			signal: controller.signal,
			redirect: "follow",
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "text/html,application/xhtml+xml",
			},
		});
	} catch (err) {
		if (err.name === "AbortError") {
			throw new PreviewError(`Timed out fetching ${url}`, 504);
		}
		throw new PreviewError(`Failed to fetch ${url}: ${err.message}`, 502);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new PreviewError(
			`Upstream responded ${response.status} for ${url}`,
			502
		);
	}

	const contentType = response.headers.get("content-type") || "";
	if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
		throw new PreviewError(
			`Unsupported content-type "${contentType}" for ${url}`,
			415
		);
	}

	const html = await readBounded(response, MAX_HTML_BYTES);
	return { html, finalUrl: response.url || url };
}

// Read the response body up to `maxBytes`, then stop. Avoids buffering an
// unbounded response into memory.
async function readBounded(response, maxBytes) {
	if (!response.body || typeof response.body.getReader !== "function") {
		// No stream available (e.g. mocked fetch) — fall back to .text().
		return (await response.text()).slice(0, maxBytes);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let html = "";
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.length;
		html += decoder.decode(value, { stream: true });
		if (received >= maxBytes) {
			await reader.cancel();
			break;
		}
	}
	return html;
}

function looksEmpty(preview) {
	return !preview.title && !preview.description && !preview.img;
}

/**
 * Generate link-preview metadata for a URL.
 *
 * Fast path: plain HTTP fetch + HTML parse (~20MB RAM, no browser).
 * Optional fallback: if PUPPETEER_FALLBACK=true and the fast path yields
 * nothing (likely a JS-rendered page), render with a shared headless browser.
 *
 * @param {string} rawUrl
 * @returns {Promise<{title, description, domain, img, favicon}>}
 */
async function generateLinkPreview(rawUrl) {
	assertValidHttpUrl(rawUrl);

	// Fast path: plain fetch + parse. Keep its result/error around so we can
	// decide whether the fallback is worth trying.
	let preview = null;
	let fastError = null;
	try {
		const { html, finalUrl } = await fetchHtml(rawUrl);
		preview = extractMetadata(html, finalUrl);
		if (!looksEmpty(preview)) return preview;
	} catch (err) {
		fastError = err;
	}

	// Fallback triggers when the fast path either failed (e.g. 403 bot wall,
	// timeout) or returned nothing useful (likely a JS-rendered page).
	if (FALLBACK_ENABLED) {
		try {
			const { renderHtml } = require("./puppeteerFallback");
			const { html, finalUrl } = await renderHtml(rawUrl);
			const rendered = extractMetadata(html, finalUrl);
			if (!looksEmpty(rendered)) return rendered;
			preview = preview || rendered;
		} catch (err) {
			console.warn(`Puppeteer fallback failed for ${rawUrl}: ${err.message}`);
		}
	}

	if (preview) return preview; // empty-ish but valid — better than an error
	throw fastError; // fast path failed and the fallback couldn't recover
}

module.exports = { generateLinkPreview, PreviewError, assertValidHttpUrl };
