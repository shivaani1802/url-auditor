# URL Auditor

A small tool that audits any URL: HTTP status, response time, page title, meta
description, H1 count, images missing `alt` text, and approximate word count.

## Stack

- **Backend:** Node.js + Express, HTML parsed with [cheerio](https://cheerio.js.org/)
- **Frontend:** Static HTML/CSS/vanilla JS served from `/public`, calling the backend over `fetch`
- No database, no build step — one process serves both the API and the page.

Built for Digital Heroes Training Task.
