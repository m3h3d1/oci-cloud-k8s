// Minimal MCP-to-Tavily reverse proxy.
// Purpose: give the llama-server WebUI a same-origin-friendly, CORS-clean
// MCP endpoint WITHOUT using llama.cpp's own --webui-mcp-proxy (a confirmed
// open-relay / SSRF vector — see ggml-org/llama.cpp#20372).
//
// Security properties:
//  - Fixed destination only: https://mcp.tavily.com/mcp — no client-supplied
//    "url" parameter exists, so this cannot be redirected to internal
//    cluster services or cloud metadata endpoints.
//  - Tavily API key lives only in this pod's env (from OCI Vault via
//    ExternalSecret) — never sent to or stored in the browser.
//  - Access to this bridge itself is gated by a shared token passed as a
//    URL query param (?token=...), not a header — avoids the CORS
//    preflight + OIDC-reverse-proxy conflict documented upstream
//    (ggml-org/llama.cpp#10854, #21012).
//  - Forces safe Tavily defaults (max_results, search_depth,
//    include_raw_content) server-side, regardless of what the model
//    requests, to prevent the context-overflow failures seen with
//    uncontrolled raw_content responses.

const http = require('http');
const https = require('https');

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
  'Access-Control-Allow-Headers': 'content-type, accept, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

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

  if (reqUrl.searchParams.get('token') !== BRIDGE_TOKEN) {
    res.writeHead(401, CORS_HEADERS);
    res.end('unauthorized');
    return;
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
