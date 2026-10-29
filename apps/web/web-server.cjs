'use strict';

// Production entry for the product UI.
//
// The API trusts this container as a reverse proxy and reads the browser
// address from X-Forwarded-For. `next start` preserves a client-supplied
// X-Forwarded-For, so a caller could rotate fake addresses and evade the
// login address throttle. This wrapper replaces the header with the actual
// socket peer before Next handles the request; Next then forwards the
// sanitized value to the API. Everything else stays with Next's own server
// implementation (routing, rewrites, caching).

const { createServer } = require('node:http');
const next = require('next');

const port = Number(process.env.PORT || 8777);
// Docker sets HOSTNAME to the container id, not a bind address.
const hostname = process.env.EVENTOUCH_WEB_BIND || '0.0.0.0';

const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = createServer(async (req, res) => {
      req.headers['x-forwarded-for'] = req.socket.remoteAddress || '';
      try {
        await handle(req, res);
      } catch {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Unable to serve this request.');
        } else {
          res.destroy();
        }
      }
    });
    server.on('error', (error) => {
      process.stderr.write(`[eventouch-web] listener failed: ${error.code || 'unknown'}\n`);
      process.exit(1);
    });
    server.listen(port, hostname, () => {
      process.stdout.write(`[eventouch-web] ready on ${hostname}:${port}\n`);
    });
    const shutdown = (signal) => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10_000).unref();
      process.stdout.write(`[eventouch-web] ${signal} received, closing\n`);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((error) => {
    process.stderr.write(`[eventouch-web] failed to start: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
