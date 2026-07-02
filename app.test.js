const http = require("http");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");

const app = require("./app");
const { extractMetadata } = require("./lib/extractMetadata");

const SAMPLE_HTML = `
<!doctype html>
<html>
	<head>
		<title>Fallback Title</title>
		<meta property="og:title" content="OG Title" />
		<meta property="og:description" content="OG Description" />
		<meta property="og:image" content="/images/cover.png" />
		<meta property="og:url" content="https://example.com/article" />
		<link rel="icon" href="/custom-favicon.png" />
	</head>
	<body>
		<h1>Heading</h1>
		<p>First visible paragraph.</p>
	</body>
</html>`;

describe("extractMetadata (pure, offline)", () => {
	it("prefers OpenGraph fields and resolves relative URLs", () => {
		const meta = extractMetadata(SAMPLE_HTML, "https://www.example.com/page");
		assert.equal(meta.title, "OG Title");
		assert.equal(meta.description, "OG Description");
		assert.equal(meta.img, "https://www.example.com/images/cover.png");
		assert.equal(meta.favicon, "https://www.example.com/custom-favicon.png");
		assert.equal(meta.domain, "example.com"); // from og:url, www stripped
	});

	it("falls back to <title> and guessed favicon when no OG tags", () => {
		const meta = extractMetadata(
			"<html><head><title>Plain</title></head><body><p>Hi</p></body></html>",
			"https://foo.bar/x"
		);
		assert.equal(meta.title, "Plain");
		assert.equal(meta.description, "Hi");
		assert.equal(meta.favicon, "https://foo.bar/favicon.ico");
		assert.equal(meta.domain, "foo.bar");
	});
});

describe("LPDG server endpoints", () => {
	let server;
	let origin;
	let originServer;
	let originBase;

	before(async () => {
		// A local "origin" server that serves the sample HTML — no real network.
		await new Promise((resolve) => {
			originServer = http.createServer((req, res) => {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(SAMPLE_HTML);
			});
			originServer.listen(0, resolve);
		});
		originBase = `http://127.0.0.1:${originServer.address().port}/`;

		await new Promise((resolve) => {
			server = http.createServer(app);
			server.listen(0, resolve);
		});
		origin = `http://127.0.0.1:${server.address().port}`;
	});

	it("GET /health returns OK", async () => {
		const res = await fetch(`${origin}/health`);
		const data = await res.json();
		assert.equal(data.message, "OK");
	});

	it("POST /parse/link parses a fetched page", async () => {
		const res = await fetch(`${origin}/parse/link`, {
			method: "POST",
			body: JSON.stringify({ url: originBase }),
			headers: { "Content-Type": "application/json" },
		});
		const data = await res.json();
		assert.equal(res.status, 200);
		assert.equal(data.title, "OG Title");
		assert.ok("img" in data);
	});

	it("POST /parse/link rejects a missing url with 400", async () => {
		const res = await fetch(`${origin}/parse/link`, {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	it("POST /parse/link rejects a non-http url with 400", async () => {
		const res = await fetch(`${origin}/parse/link`, {
			method: "POST",
			body: JSON.stringify({ url: "ftp://example.com" }),
			headers: { "Content-Type": "application/json" },
		});
		assert.equal(res.status, 400);
	});

	after(() => {
		server.close();
		originServer.close();
	});
});
