/**
 * SRE Copilot — zero-dependency proxy server
 * Run: node server.js
 * Routes all /api/* calls to upstream services (bypasses CORS).
 */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3000;

// Route table: path prefix → upstream base URL
const ROUTES = [
  { prefix: '/api/linear',      upstream: 'https://api.linear.app/graphql',       strip: '/api/linear' },
  { prefix: '/api/anthropic',   upstream: 'https://api.anthropic.com/v1/messages', strip: '/api/anthropic' },
  { prefix: '/api/slack/',      upstream: 'https://slack.com/api/',                strip: '/api/slack/' },
  { prefix: '/api/payabli',     upstream: 'https://api.payabli.com',               strip: '/api/payabli' },
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function proxyRequest(req, res, upstreamUrl) {
  const parsed = new url.URL(upstreamUrl);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  // Forward all request headers except browser-specific ones that trigger CORS rejections
  const headers = Object.assign({}, req.headers);
  delete headers['host'];
  delete headers['origin'];
  delete headers['referer'];

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     parsed.pathname + (parsed.search || ''),
    method:   req.method,
    headers,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const responseHeaders = Object.assign({}, proxyRes.headers, CORS_HEADERS);
    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502, CORS_HEADERS);
    res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathname  = parsedUrl.pathname;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Check proxy routes
  for (const route of ROUTES) {
    if (pathname.startsWith(route.prefix)) {
      const rest = pathname.slice(route.strip.length);
      const upstreamUrl = route.upstream + rest + (parsedUrl.search || '');
      console.log(`→ ${req.method} ${pathname} → ${upstreamUrl}`);
      proxyRequest(req, res, upstreamUrl);
      return;
    }
  }

  // Serve index.html for everything else
  const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall back to index.html
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SRE Copilot running at http://localhost:${PORT}`);
});
