"use strict";

const cheerio = require("cheerio");

/**
 * Extracts link-preview metadata from a raw HTML string.
 *
 * Mirrors the field precedence of the previous `link-preview-generator`
 * (og -> twitter -> generic) so the API response shape stays compatible:
 * { title, description, domain, img, favicon }.
 *
 * Pure & synchronous: no network calls, no browser. Given the same HTML it
 * always returns the same result, which makes it trivial to unit-test.
 *
 * @param {string} html   Raw HTML of the page.
 * @param {string} uri    The (final, post-redirect) URL the HTML came from.
 * @returns {{title: string|null, description: string|null, domain: string, img: string|null, favicon: string|null}}
 */
function extractMetadata(html, uri) {
	const $ = cheerio.load(html);
	const origin = new URL(uri).origin;

	// Resolve a possibly-relative URL against the page origin. Returns null on
	// garbage input instead of throwing so a single bad attribute can't fail
	// the whole request.
	const absolute = (maybeUrl) => {
		if (!maybeUrl) return null;
		try {
			return new URL(maybeUrl, uri).href;
		} catch {
			return null;
		}
	};

	const metaContent = (selector) => {
		const value = $(selector).attr("content");
		return value && value.trim().length > 0 ? value.trim() : null;
	};

	const title =
		metaContent('meta[property="og:title"]') ||
		metaContent('meta[name="twitter:title"]') ||
		(($("title").first().text() || "").trim() || null) ||
		(($("h1").first().text() || "").trim() || null) ||
		(($("h2").first().text() || "").trim() || null);

	const description =
		metaContent('meta[property="og:description"]') ||
		metaContent('meta[name="twitter:description"]') ||
		metaContent('meta[name="description"]') ||
		firstParagraph($);

	const img = absolute(
		metaContent('meta[property="og:image"]') ||
			$('link[rel="image_src"]').attr("href") ||
			metaContent('meta[name="twitter:image"]') ||
			firstContentImage($, uri)
	);

	return {
		title: title || null,
		description: description || null,
		domain: resolveDomain($, uri),
		img,
		favicon: resolveFavicon($, origin, absolute),
	};
}

function firstParagraph($) {
	let text = null;
	$("p").each((_, el) => {
		const t = $(el).text().trim();
		if (t.length > 0) {
			text = t;
			return false; // break
		}
	});
	return text;
}

// Best-effort first "content-ish" image. Without a rendered DOM we can't know
// natural dimensions, so we just skip obvious sprites/icons/tracking pixels and
// take the first remaining <img>.
function firstContentImage($, uri) {
	let found = null;
	$("img").each((_, el) => {
		const src = $(el).attr("src");
		if (!src) return;
		if (/(sprite|icon|logo|pixel|blank|spacer|1x1)/i.test(src)) return;
		if (src.startsWith("data:")) return;
		found = src;
		return false;
	});
	return found;
}

function resolveDomain($, uri) {
	const canonical = $("link[rel=canonical]").attr("href");
	const ogUrl = $('meta[property="og:url"]').attr("content");
	const candidate = canonical || ogUrl || uri;
	try {
		return new URL(candidate, uri).hostname.replace(/^www\./, "");
	} catch {
		return new URL(uri).hostname.replace(/^www\./, "");
	}
}

function resolveFavicon($, origin, absolute) {
	const declared =
		$('link[rel="icon"][sizes="16x16"]').attr("href") ||
		$('link[rel="shortcut icon"]').attr("href") ||
		$('link[rel="icon"]').first().attr("href") ||
		$('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')
			.first()
			.attr("href");

	// Fall back to the conventional /favicon.ico. We don't verify reachability
	// with an extra network round-trip (the old lib did, which was slow); the
	// consumer can HEAD it lazily if it needs a guarantee.
	return absolute(declared) || `${origin}/favicon.ico`;
}

module.exports = { extractMetadata };
