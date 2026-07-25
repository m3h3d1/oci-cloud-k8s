// MCP-to-Tavily reverse proxy for the llama-server WebUI.
// Replaces llama.cpp's --webui-mcp-proxy, an open relay (ggml-org/llama.cpp#20372).
//
// - Fixed upstream; no client-supplied URL, so it can't reach internal services.
// - Tavily key stays in this pod (OCI Vault via ExternalSecret), never in the browser.
// - Bridge access gated by BRIDGE_TOKEN.
// - Forces safe Tavily defaults server-side to prevent context overflow.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const PORT = process.env.PORT || 8080;

if (!TAVILY_API_KEY) {
  console.error('FATAL: TAVILY_API_KEY not set');
  process.exit(1);
}
if (!BRIDGE_TOKEN) {
  console.error('FATAL: BRIDGE_TOKEN not set');
  process.exit(1);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

// Constant-time compare.
function tokenMatches(presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(BRIDGE_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (reqUrl.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (reqUrl.pathname !== '/mcp') {
    res.writeHead(404, CORS_HEADERS);
    res.end('not found');
    return;
  }

  // Query-param form is deprecated: Envoy logs full request paths, so it leaks
  // the token. Kept only for back-compat with existing browser configs.
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = reqUrl.searchParams.get('token');

  if (!tokenMatches(bearer) && !tokenMatches(queryToken)) {
    res.writeHead(401, CORS_HEADERS);
    res.end('unauthorized');
    return;
  }
  if (!bearer && queryToken) {
    console.warn('deprecated: token supplied via query param (leaks into Envoy access logs) — use Authorization: Bearer');
  }

  const upstreamUrl = new URL('https://mcp.tavily.com/mcp');
  upstreamUrl.searchParams.set('tavilyApiKey', TAVILY_API_KEY);

  const upstreamHeaders = {};
  for (const h of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version']) {
    if (req.headers[h]) upstreamHeaders[h] = req.headers[h];
  }
  // Forced defaults — set server-side via Tavily's documented header
  // mechanism, so they can't be overridden by client-supplied tool-call
  // arguments. Safe to set here since this is a server-to-server request
  // (no browser CORS/preflight involved).
  upstreamHeaders['DEFAULT_PARAMETERS'] = JSON.stringify({
    max_results: 3,
    search_depth: 'basic',
    include_raw_content: false,
    include_images: false,
  });

  const proxyReq = https.request(
    upstreamUrl,
    { method: req.method, headers: upstreamHeaders },
    (proxyRes) => {
      const outHeaders = { ...CORS_HEADERS };
      for (const h of ['content-type', 'mcp-session-id']) {
        if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h];
      }
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('upstream error:', err.message);
    if (!res.headersSent) res.writeHead(502, CORS_HEADERS);
    res.end('upstream error');
  });

  req.pipe(proxyReq);
});

server.listen(PORT, () => console.log(`mcp-bridge listening on :${PORT}`));
