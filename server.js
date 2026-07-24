const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const FETCH_TIMEOUT_MS = 10000;      // 10s to connect/receive headers+start of body
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB cap so huge pages can't hang/blow memory
const USER_AGENT = 'URL-Auditor/1.0 (+https://github.com/) audit-bot';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Validate that the string is a well-formed, publicly-fetchable http(s) URL.
 * Returns { ok: true, url } or { ok: false, message }.
 */
function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, message: 'URL is required.' };
  }

  const trimmed = raw.trim();
  // Detect any URI scheme prefix, with or without "//" (covers http://, ftp://, mailto:, etc.).
  // Only prepend https:// when the input has no scheme at all (e.g. "example.com").
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, message: 'That does not look like a valid URL.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, message: 'Only http:// and https:// URLs are supported.' };
  }

  if (!parsed.hostname) {
    return { ok: false, message: 'URL is missing a valid hostname.' };
  }

  // Block obviously internal/loopback targets to avoid SSRF against the server itself.
  const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  const hostname = parsed.hostname.toLowerCase();
  if (
    blockedHosts.includes(hostname) ||
    hostname.startsWith('169.254.') ||   // link-local / cloud metadata
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) {
    return { ok: false, message: 'Requests to private or internal addresses are not allowed.' };
  }

  if (!hostname.includes('.')) {
    return { ok: false, message: 'URL is missing a valid hostname.' };
  }

  return { ok: true, url: parsed.toString() };
}

/**
 * Fetch a URL with a hard timeout and a byte cap on the body.
 * Throws a typed error with a `code` field so the caller can map it to a clean message.
 */
async function fetchWithLimits(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('The request timed out.');
      e.code = 'TIMEOUT';
      throw e;
    }
    const e = new Error('Could not reach that host.');
    e.code = 'UNREACHABLE';
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/html')) {
    const e = new Error(`Response is not HTML (content-type: ${contentType || 'unknown'}).`);
    e.code = 'NOT_HTML';
    e.status = response.status;
    e.contentType = contentType;
    throw e;
  }

  // Read the body ourselves so we can cap its size instead of trusting content-length.
  const reader = response.body.getReader();
  let received = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_BODY_BYTES) {
        controller.abort();
        const e = new Error('Page was too large to audit.');
        e.code = 'TOO_LARGE';
        throw e;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err.code === 'TOO_LARGE') throw err;
    const e = new Error('Connection was interrupted while downloading the page.');
    e.code = 'UNREACHABLE';
    throw e;
  }

  const html = Buffer.concat(chunks).toString('utf-8');
  return { response, html };
}

/**
 * Parse HTML and build the audit report fields.
 */
function analyzeHtml(html) {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || null;

  const metaDescription =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null;

  const h1Count = $('h1').length;

  const images = $('img');
  let missingAltCount = 0;
  images.each((_, el) => {
    const alt = $(el).attr('alt');
    // Missing = attribute absent or empty/whitespace-only string.
    if (alt === undefined || alt.trim() === '') missingAltCount += 1;
  });

  // Approximate word count: strip script/style/noscript, take visible text, split on whitespace.
  const bodyClone = $('body').clone();
  bodyClone.find('script, style, noscript, template').remove();
  const text = bodyClone.text().replace(/\s+/g, ' ').trim();
  const wordCount = text === '' ? 0 : text.split(' ').length;

  return {
    title,
    metaDescription,
    h1Count,
    imageCount: images.length,
    imagesMissingAlt: missingAltCount,
    wordCount,
  };
}

app.post('/api/audit', async (req, res) => {
  const startedAt = Date.now();
  const { url: rawUrl } = req.body || {};

  const validation = validateUrl(rawUrl);
  if (!validation.ok) {
    return res.status(400).json({ error: { type: 'INVALID_URL', message: validation.message } });
  }

  try {
    const { response, html } = await fetchWithLimits(validation.url);
    const responseTimeMs = Date.now() - startedAt;

    const analysis = analyzeHtml(html);

    return res.status(200).json({
      requestedUrl: validation.url,
      finalUrl: response.url,
      httpStatus: response.status,
      responseTimeMs,
      ...analysis,
    });
  } catch (err) {
    const responseTimeMs = Date.now() - startedAt;

    const errorMap = {
      TIMEOUT: { status: 504, type: 'TIMEOUT', message: `The site did not respond within ${FETCH_TIMEOUT_MS / 1000}s.` },
      UNREACHABLE: { status: 502, type: 'UNREACHABLE', message: 'Could not connect to that host. Check the URL and try again.' },
      NOT_HTML: { status: 415, type: 'NOT_HTML', message: err.message },
      TOO_LARGE: { status: 413, type: 'TOO_LARGE', message: 'The page was too large to audit (over 5MB).' },
    };

    const mapped = errorMap[err.code] || { status: 500, type: 'INTERNAL_ERROR', message: 'Something went wrong while auditing that URL.' };

    return res.status(mapped.status).json({
      error: { type: mapped.type, message: mapped.message },
      responseTimeMs,
    });
  }
});

// Catch-all JSON 404 for unknown API routes (keeps API responses consistent).
app.use('/api', (req, res) => {
  res.status(404).json({ error: { type: 'NOT_FOUND', message: 'Unknown API route.' } });
});

// Global error handler safety net so a bug never crashes the process.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { type: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
});

app.listen(PORT, () => {
  console.log(`URL Auditor listening on http://localhost:${PORT}`);
});

process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
