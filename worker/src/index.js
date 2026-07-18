const ARK_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const DEFAULT_MODEL = 'deepseek-v4-pro-260425';
const DEFAULT_ALLOWED_ORIGIN = 'https://vinhthit08-cmyk.github.io';
const MAX_PROMPT_LENGTH = 40_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

function corsHeaders(origin, env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': origin === allowedOrigin ? origin : allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
}

function jsonResponse(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin, env),
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function originAllowed(request, env) {
  const origin = request.headers.get('Origin') || '';
  return origin === (env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (!originAllowed(request, env)) return jsonResponse({ error: 'origin_not_allowed' }, 403, origin, env);
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'kite-learning-ai-proxy' }, 200, origin, env);
    }

    if (request.method !== 'POST' || url.pathname !== '/api/analyze') {
      return jsonResponse({ error: 'not_found' }, 404, origin, env);
    }
    if (!originAllowed(request, env)) return jsonResponse({ error: 'origin_not_allowed' }, 403, origin, env);
    if (!env.ARK_API_KEY) return jsonResponse({ error: 'server_secret_missing' }, 503, origin, env);

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength > 64_000) return jsonResponse({ error: 'request_too_large' }, 413, origin, env);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, origin, env);
    }

    const prompt = String(payload?.prompt || '').trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      return jsonResponse({ error: 'invalid_prompt' }, 400, origin, env);
    }
    const requestedMaxOutput = Number(payload?.maxOutputTokens || 0);
    const maxOutputTokens = Number.isFinite(requestedMaxOutput) && requestedMaxOutput > 0
      ? Math.min(Math.max(Math.trunc(requestedMaxOutput), 300), 1800)
      : Number(env.ARK_MAX_OUTPUT_TOKENS || DEFAULT_MAX_OUTPUT_TOKENS);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let upstream;
    try {
      upstream = await fetch(ARK_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${env.ARK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: env.ARK_MODEL || DEFAULT_MODEL,
          stream: true,
          max_output_tokens: maxOutputTokens,
          input: [{
            role: 'user',
            content: [{ type: 'input_text', text: prompt }]
          }]
        })
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'upstream_timeout' : 'upstream_unavailable';
      return jsonResponse({ error: reason }, 504, origin, env);
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      return jsonResponse({ error: 'upstream_rejected', status: upstream.status }, 502, origin, env);
    }

    const headers = new Headers(corsHeaders(origin, env));
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'text/event-stream; charset=utf-8');
    return new Response(upstream.body, { status: 200, headers });
  }
};
