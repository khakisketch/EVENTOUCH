'use strict';

// Product dev entry: API (source) + Next dev, supervised.
//
//   npm run dev                      # API 8776 + web 8777
//   API_PORT=8796 WEB_PORT=8797 npm run dev
//
// EVENTOUCH_API_URL defaults to the supervised API so the dev rewrite target
// can never mismatch the API that actually started. A build is not involved:
// `next dev` reads its rewrites at request time. Ports are explicit
// configuration, never probed-and-reused: an occupied port exits nonzero.
const path = require('node:path');
const { supervise } = require('./supervise.cjs');

const ROOT = path.join(__dirname, '..');

async function main() {
  const apiPort = Number(process.env.API_PORT || 8776);
  const webPort = Number(process.env.WEB_PORT || 8777);
  const apiBase = process.env.EVENTOUCH_API_URL || `http://127.0.0.1:${apiPort}`;
  const nextBin = path.join(ROOT, 'apps/web/node_modules/next/dist/bin/next');

  const code = await supervise({
    apiPort,
    webPort,
    apiHealth: `http://127.0.0.1:${apiPort}/api/health`,
    webHealth: `http://127.0.0.1:${webPort}/`,
    api: {
      label: 'API',
      command: process.execPath,
      args: ['server/server.js'],
      cwd: ROOT,
      env: { ...process.env, PORT: String(apiPort) },
    },
    web: {
      label: 'web',
      command: process.execPath,
      args: [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)],
      cwd: path.join(ROOT, 'apps/web'),
      env: { ...process.env, PORT: String(webPort), EVENTOUCH_API_URL: apiBase },
    },
  });
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(`[supervisor] dev failed: ${error && error.message}\n`);
  process.exitCode = 1;
});
