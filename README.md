# Link Preview Generator Server

Server that returns OpenGraph/preview metadata for a URL.

As of v2 the **primary path is a lightweight fetch + HTML parse** (`cheerio`)
instead of launching a headless Chromium per request. A headless-browser
fallback still exists for pages the fast path can't handle, but it's a **single
shared, concurrency-limited browser** — not one per request. This cuts memory
from ~2GB/pod to a few hundred MB and removes the per-request browser
cold-start, while keeping the same response shape and coverage.

## API

- Method: POST
- Endpoint: `/parse/link`
- Request Body: JSON

### Request

```json
{ "url": "https://www.facebook.com" }
```

### Response

```json
{
	"title": "Facebook – log in or sign up",
	"description": "Log in to Facebook to start sharing and connecting...",
	"domain": "facebook.com",
	"img": "https://www.facebook.com/images/fb_logo/app-facebook-circle-bp.png",
	"favicon": "https://www.facebook.com/favicon.ico"
}
```

Errors return `{ "error": "<message>" }` with an appropriate status:
`400` (bad/missing url), `415` (non-HTML content-type), `502`/`504` (upstream
error/timeout).

### Health

`GET /health` → `{ uptime, message: "OK", timestamp }`

## How it works

1. `fetch` the URL with a hard timeout and a bounded body size (OG tags live in
   `<head>`, so we never buffer a whole page into memory).
2. Parse the HTML with `cheerio` and extract title/description/image/favicon
   following OpenGraph → Twitter → generic precedence.

No browser is launched on the fast path.

### Puppeteer fallback (JS-rendered pages) — ON by default

Some pages render their metadata client-side, or block non-browser clients. When
the fast path fails or comes back empty, the request falls back to rendering the
page with Puppeteer. To keep memory bounded (this is what caused the old OOMs),
the fallback:

- uses **one long-lived shared browser**, not one per request;
- opens/closes a page per request in `try/finally`, so nothing leaks;
- caps concurrent pages via a semaphore (`PUPPETEER_MAX_CONCURRENCY`, default 3),
  so a burst of fallback requests can't spike memory.

Disable it entirely (slimmest footprint, fast path only) with:

```bash
PUPPETEER_FALLBACK=false npm start
```

The Docker image ships with Chromium's runtime libs so the fallback works out of
the box. To use a system-installed Chromium instead of Puppeteer's bundled one,
set `PUPPETEER_EXECUTABLE_PATH`.

## Configuration

| Env var                | Default            | Description                              |
| ---------------------- | ------------------ | ---------------------------------------- |
| `PORT`                 | `3000`             | HTTP port                                |
| `PREVIEW_TIMEOUT_MS`   | `8000`             | Per-request fetch/navigation timeout     |
| `PREVIEW_MAX_BYTES`    | `524288` (512 KB)  | Max HTML bytes read per page             |
| `PREVIEW_USER_AGENT`        | Chrome desktop UA | Override the request User-Agent               |
| `PUPPETEER_FALLBACK`        | `true`            | Set `false` to disable the browser fallback   |
| `PUPPETEER_MAX_CONCURRENCY` | `3`               | Max simultaneous fallback pages               |
| `PUPPETEER_EXECUTABLE_PATH` | (bundled)         | Path to a system Chromium for the fallback    |

## Development

```bash
npm ci
npm test     # offline, deterministic tests
npm start
```
