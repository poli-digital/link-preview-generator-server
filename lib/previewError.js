"use strict";

// Typed error carrying an HTTP status so routes can map failures to a real
// response code (and message) instead of a generic 500. Lives in its own module
// so both linkPreview.js and ssrfGuard.js can throw it without a circular import.
class PreviewError extends Error {
	constructor(message, status = 502) {
		super(message);
		this.name = "PreviewError";
		this.status = status;
	}
}

module.exports = { PreviewError };
