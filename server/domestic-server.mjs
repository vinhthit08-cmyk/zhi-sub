import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = path.join(ROOT, 'site');
const UPDATE_SCRIPT = path.join(ROOT, 'scripts', 'update-page.mjs');
const PORT = Number(process.env.PORT || 3000);
const UPDATE_INTERVAL_MS = Math.max(Number(process.env.UPDATE_INTERVAL_MS || 30_000), 10_000);
const ARK_API_URL = process.env.ARK_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/responses';
const ARK_MODEL = process.env.ARK_MODEL || 'deepseek-v4-pro-260425';
const MAX_PROMPT_LENGTH = 40_000;
let updateRunning = false;
let lastUpdate = { ok: false, at: null, message: 'not_started' };

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon']
]);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readRequestBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('request_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleAnalyze(req, res) {
  if (!process.env.ARK_API_KEY) return sendJson(res, 503, { error: 'server_secret_missing' });
  let payload;
  try { payload = JSON.parse(await readRequestBody(req)); }
  catch (error) { return sendJson(res, error.message === 'request_too_large' ? 413 : 400, { error: error.message || 'invalid_json' }); }

  const prompt = String(payload?.prompt || '').trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return sendJson(res, 400, { error: 'invalid_prompt' });
  const requestedMaxOutput = Number(payload?.maxOutputTokens || 0);
  const maxOutputTokens = Number.isFinite(requestedMaxOutput) && requestedMaxOutput > 0
    ? Math.min(Math.max(Math.trunc(requestedMaxOutput), 300), 1800)
    : 1200;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let upstream;
  try {
    upstream = await fetch(ARK_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ARK_MODEL,
        stream: true,
        max_output_tokens: maxOutputTokens,
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
      })
    });
  } catch (error) {
    clearTimeout(timeout);
    return sendJson(res, 504, { error: error?.name === 'AbortError' ? 'upstream_timeout' : 'upstream_unavailable' });
  }
  clearTimeout(timeout);

  if (!upstream.ok) return sendJson(res, 502, { error: 'upstream_rejected', status: upstream.status });
  res.writeHead(200, { 'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  if (upstream.body) for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
  res.end();
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(SITE_DIR, `.${pathname}`);
  if (!filePath.startsWith(SITE_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not_file');
    res.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
    });
    createReadStream(filePath).pipe(res);
  } catch { sendJson(res, 404, { error: 'not_found' }); }
}

function runUpdate(reason = 'timer') {
  if (updateRunning) return;
  updateRunning = true;
  const child = spawn(process.execPath, [UPDATE_SCRIPT], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
  child.on('close', code => {
    updateRunning = false;
    lastUpdate = { ok: code === 0, at: new Date().toISOString(), reason, message: (code === 0 ? output : errorOutput).trim().slice(-1200) };
    console.log(`[data-update] ${lastUpdate.ok ? 'ok' : 'failed'} ${lastUpdate.at}`);
    if (lastUpdate.message) console.log(lastUpdate.message);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, service: 'kite-domestic-server', lastUpdate });
    if (req.method === 'POST' && url.pathname === '/api/refresh') { runUpdate('manual'); return sendJson(res, 202, { ok: true, message: 'refresh_started' }); }
    if (req.method === 'POST' && url.pathname === '/api/analyze') return handleAnalyze(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (error) { console.error(error); sendJson(res, 500, { error: 'server_error' }); }
}).listen(PORT, () => {
  console.log(`kite domestic server listening on http://0.0.0.0:${PORT}`);
  runUpdate('startup');
  setInterval(() => runUpdate('timer'), UPDATE_INTERVAL_MS);
});
