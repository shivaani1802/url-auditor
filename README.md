# URL Auditor

A small tool that audits any URL: HTTP status, response time, page title, meta
description, H1 count, images missing `alt` text, and approximate word count.

## Stack

- **Backend:** Node.js + Express, HTML parsed with [cheerio](https://cheerio.js.org/)
- **Frontend:** Static HTML/CSS/vanilla JS served from `/public`, calling the backend over `fetch`
- No database, no build step — one process serves both the API and the page.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## API

### `POST /api/audit`

**Request body**

```json
{ "url": "https://example.com" }
```

The `url` may omit the protocol (`example.com` is treated as `https://example.com`).

**Success — `200 OK`**

```json
{
  "requestedUrl": "https://example.com/",
  "finalUrl": "https://example.com/",
  "httpStatus": 200,
  "responseTimeMs": 284,
  "title": "Example Domain",
  "metaDescription": null,
  "h1Count": 1,
  "imageCount": 0,
  "imagesMissingAlt": 0,
  "wordCount": 28
}
```

- `requestedUrl` — the URL that was fetched (after normalization).
- `finalUrl` — the URL after following redirects.
- `httpStatus` — the HTTP status code of the fetched page (audits still run on 404/500 pages — the report reflects what's actually there).
- `responseTimeMs` — total time from request start to fully-read body.
- `imagesMissingAlt` — images with no `alt` attribute, or an empty/whitespace-only one.
- `wordCount` — approximate: `<script>`/`<style>` stripped, visible text split on whitespace.

**Error responses**

All errors share this shape:

```json
{ "error": { "type": "TIMEOUT", "message": "The site did not respond within 10s." } }
```

| Status | `type`          | Cause                                              |
|--------|-----------------|-----------------------------------------------------|
| 400    | `INVALID_URL`   | Missing, malformed, non-http(s), or private/internal address |
| 413    | `TOO_LARGE`     | Page body exceeded 5MB                              |
| 415    | `NOT_HTML`      | `Content-Type` isn't `text/html`                     |
| 502    | `UNREACHABLE`   | DNS/connection failure                               |
| 504    | `TIMEOUT`       | No response within 10 seconds                        |
| 500    | `INTERNAL_ERROR`| Unexpected server-side failure                       |

The process never crashes on a bad input — every failure path is caught and mapped
to one of the above, and a global error handler plus `uncaughtException` /
`unhandledRejection` listeners act as a last-resort safety net.

## Design notes

- **SSRF guard:** requests to `localhost`, loopback, link-local, and private RFC1918
  ranges are rejected before any fetch happens.
- **Timeouts:** enforced with `AbortController` (10s), independent of any client-side timeout.
- **Size cap:** the response body is streamed and capped at 5MB so a huge or infinite
  page can't exhaust memory.
- **Content-type check:** happens after headers arrive but before the body is downloaded,
  so a large non-HTML response doesn't get fully pulled down for nothing.

## Deploy (Render, free tier)

1. Push this repo to GitHub (see below).
2. Go to [render.com](https://render.com) → **New** → **Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Deploy. Render gives you a `https://<your-app>.onrender.com` URL.

(Railway, Fly.io, or Cyclic work the same way — install command `npm install`, start command `npm start`, port read from `process.env.PORT`, which this app already does.)

## Push to GitHub

```bash
git init
git add .
git commit -m "URL Auditor: initial version"
git branch -M main
git remote add origin https://github.com/<your-username>/url-auditor.git
git push -u origin main
```

---

Built for Digital Heroes Training Task.
