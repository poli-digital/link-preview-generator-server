"use strict";

// SSRF guard. This service fetches arbitrary URLs that originate from end-user
// messages, so without a guard a crafted link (http://169.254.169.254/,
// http://10.0.0.5/, http://localhost:6379/) could reach cloud metadata, internal
// services, or databases. We resolve the host and reject any URL that points at
// a private / loopback / link-local / reserved address.
//
// Residual risk: DNS rebinding — the name could resolve to a public IP here and
// a private IP when fetch() re-resolves. Fully closing that needs pinning the
// connection to the vetted IP; this guard raises the bar substantially and
// blocks the common cases. Set PREVIEW_ALLOW_PRIVATE_HOSTS=true to bypass (tests
// / trusted internal use only).

const dns = require("dns").promises;
const net = require("net");
const { PreviewError } = require("./previewError");

// Read at call time (not module load) so tests / config can toggle it without
// worrying about require ordering.
function allowPrivate() {
	return process.env.PREVIEW_ALLOW_PRIVATE_HOSTS === "true";
}

function ipToLong(ip) {
	return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inRange(ip, cidr) {
	const [range, bitsRaw] = cidr.split("/");
	const bits = Number(bitsRaw);
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

// Private, loopback, link-local, CGNAT, and other non-public IPv4 ranges.
const BLOCKED_V4 = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10", // CGNAT
	"127.0.0.0/8", // loopback
	"169.254.0.0/16", // link-local (incl. cloud metadata 169.254.169.254)
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4", // multicast
	"240.0.0.0/4", // reserved
];

function isPrivateIp(ip) {
	if (net.isIPv4(ip)) {
		return BLOCKED_V4.some((cidr) => inRange(ip, cidr));
	}
	if (net.isIPv6(ip)) {
		const lower = ip.toLowerCase();
		// IPv4-mapped (::ffff:10.0.0.1) — check the embedded v4.
		const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		if (mapped) {
			return isPrivateIp(mapped[1]);
		}
		if (lower === "::1" || lower === "::") return true; // loopback / unspecified
		if (lower.startsWith("fe80")) return true; // link-local
		if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
		return false;
	}
	return true; // not a recognizable IP — reject to be safe
}

/**
 * Assert that a parsed URL points at a public host. Throws PreviewError(403)
 * otherwise. No-op when PREVIEW_ALLOW_PRIVATE_HOSTS=true.
 * @param {URL} parsedUrl
 */
async function assertPublicUrl(parsedUrl) {
	if (allowPrivate()) return;

	const host = parsedUrl.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

	// Obvious local names — reject before touching DNS.
	const lowerHost = host.toLowerCase();
	if (
		lowerHost === "localhost" ||
		lowerHost.endsWith(".localhost") ||
		lowerHost.endsWith(".local") ||
		lowerHost.endsWith(".internal")
	) {
		throw new PreviewError(`Blocked non-public host: ${host}`, 403);
	}

	// Literal IP in the URL — check directly, no DNS needed.
	if (net.isIP(host)) {
		if (isPrivateIp(host)) {
			throw new PreviewError(`Blocked non-public address: ${host}`, 403);
		}
		return;
	}

	// Hostname — resolve and reject if ANY record is private.
	let records;
	try {
		records = await dns.lookup(host, { all: true });
	} catch {
		throw new PreviewError(`Could not resolve host: ${host}`, 400);
	}
	if (!records.length) {
		throw new PreviewError(`Could not resolve host: ${host}`, 400);
	}
	for (const { address } of records) {
		if (isPrivateIp(address)) {
			throw new PreviewError(
				`Blocked host resolving to a non-public address: ${host}`,
				403
			);
		}
	}
}

module.exports = { assertPublicUrl, isPrivateIp };
