const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const {
  VIDEO_ID_RE,
  buildSearchArgs,
  buildStreamArgs,
} = require('./resolver-utils');

const HOST = process.env.RESOLVER_HOST || '127.0.0.1';
const PORT = Number(process.env.RESOLVER_PORT || 4417);
const YT_DLP = process.env.YT_DLP_PATH || '/opt/yt-dlp/bin/yt-dlp';
const DENO = process.env.DENO_PATH || '/usr/local/bin/deno';
const POT_PROVIDER_URL = process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416';
const COOKIE_PATH = process.env.YT_COOKIES_PATH || '/run/secrets/youtube-cookies.txt';
const MAX_SEARCHES = Number(process.env.RESOLVER_MAX_SEARCHES || 4);
const MAX_STREAMS = Number(process.env.RESOLVER_MAX_STREAMS || 7);
const SEARCH_TIMEOUT_MS = 30_000;
const STREAM_START_TIMEOUT_MS = 45_000;
const MAX_JSON_BYTES = 3 * 1024 * 1024;

let activeSearches = 0;
let activeStreams = 0;
const children = new Set();

function ytDlpOptions() {
  const options = { denoPath: DENO, potProviderUrl: POT_PROVIDER_URL };
  try {
    if (fs.statSync(COOKIE_PATH).isFile()) options.cookiesPath = COOKIE_PATH;
  } catch {
    // Cookies are optional; the local bgutil PO-token provider is still used.
  }
  return options;
}

function sendJson(res, status, payload) {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function runJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      children.delete(child);
      fn(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('YouTube search timed out'));
    }, SEARCH_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) > MAX_JSON_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error('YouTube search response exceeded size limit'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        return finish(reject, new Error(`yt-dlp exited ${code}: ${stderr.trim().slice(-600)}`));
      }
      try {
        finish(resolve, JSON.parse(stdout));
      } catch {
        finish(reject, new Error('yt-dlp returned invalid search data'));
      }
    });
  });
}

function firstEntry(result) {
  if (Array.isArray(result?.entries)) return result.entries.find((entry) => entry?.id) || null;
  return result?.id ? result : null;
}

function trackInfo(entry) {
  if (!entry || !VIDEO_ID_RE.test(String(entry.id || ''))) return null;
  const duration = Number(entry.duration);
  const thumbnails = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  return {
    videoId: entry.id,
    title: String(entry.title || 'YouTube audio').slice(0, 240),
    author: String(entry.channel || entry.uploader || 'Unknown artist').slice(0, 120),
    duration: Number.isFinite(duration) && duration >= 0 ? Math.floor(duration * 1000) : null,
    isLive: !!entry.is_live || entry.live_status === 'is_live',
    thumbnail: thumbnails.length ? thumbnails[thumbnails.length - 1].url || null : null,
    url: `https://www.youtube.com/watch?v=${entry.id}`,
  };
}

async function handleSearch(url, res) {
  const query = url.searchParams.get('q') || '';
  let request;
  try {
    request = buildSearchArgs(query, ytDlpOptions());
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  if (activeSearches >= MAX_SEARCHES) {
    return sendJson(res, 503, { error: 'Music search is busy. Try again shortly.' });
  }

  activeSearches++;
  try {
    const raw = await runJson(request.args);
    const info = trackInfo(firstEntry(raw));
    if (!info) return sendJson(res, 404, { error: 'No playable YouTube result was found.' });
    return sendJson(res, 200, info);
  } catch (error) {
    console.error(`[resolver] Search failed: ${error.message}`);
    return sendJson(res, 502, { error: 'YouTube search failed. Check yt-dlp, Deno, cookies, and the PO-token provider logs.' });
  } finally {
    activeSearches--;
  }
}

function handleStream(req, res, videoId) {
  if (!VIDEO_ID_RE.test(videoId)) return sendJson(res, 400, { error: 'Invalid YouTube video ID.' });
  if (activeStreams >= MAX_STREAMS) return sendJson(res, 503, { error: 'All audio streams are busy.' });
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': 'audio/webm', 'cache-control': 'no-store' });
    return res.end();
  }

  activeStreams++;
  const child = spawn(YT_DLP, buildStreamArgs(videoId, ytDlpOptions()), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  let sentAudio = false;
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    clearTimeout(startTimeout);
    children.delete(child);
    activeStreams = Math.max(0, activeStreams - 1);
  };
  const startTimeout = setTimeout(() => {
    if (!sentAudio) {
      child.kill('SIGKILL');
      sendJson(res, 504, { error: 'YouTube audio stream did not start in time.' });
    }
  }, STREAM_START_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => {
    if (!sentAudio) {
      sentAudio = true;
      res.writeHead(200, {
        'content-type': 'audio/webm',
        'cache-control': 'no-store',
        'accept-ranges': 'none',
        'x-content-type-options': 'nosniff',
      });
      clearTimeout(startTimeout);
    }
    res.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1200);
  });
  child.on('error', (error) => {
    release();
    console.error(`[resolver] yt-dlp spawn failed for ${videoId}: ${error.message}`);
    if (!res.headersSent) sendJson(res, 502, { error: 'Audio resolver could not start yt-dlp.' });
    else res.destroy();
  });
  child.on('close', (code) => {
    release();
    if (code !== 0) {
      console.error(`[resolver] Stream failed for ${videoId} (exit ${code}): ${stderr.trim().slice(-500)}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'YouTube could not provide this audio stream.' });
      else if (!res.writableEnded) res.destroy();
      return;
    }
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => {
    if (!child.killed && !child.exitCode && !res.writableFinished) child.kill('SIGTERM');
    release();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  if (url.pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, activeSearches, activeStreams });
  }
  if (url.pathname === '/search' && req.method === 'GET') return void handleSearch(url, res);
  const match = url.pathname.match(/^\/yt\/([A-Za-z0-9_-]{11})$/);
  if (match && ['GET', 'HEAD'].includes(req.method || '')) return handleStream(req, res, match[1]);
  return sendJson(res, 404, { error: 'Route not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`[resolver] Listening on http://${HOST}:${PORT}`);
  console.log(`[resolver] yt-dlp=${YT_DLP}; Deno=${DENO}; cookies=${fs.existsSync(COOKIE_PATH) ? 'present' : 'not configured'}`);
});

function shutdown() {
  server.close();
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
