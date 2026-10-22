'use strict';

// Product start entry: API (source) + built Next, supervised.
//
//   npm run build && npm start        # API 8776 + web 8777
//   API_PORT=8796 WEB_PORT=8797 npm start
//
// The Next rewrites are BAKED at build time, so the build and this start must
// agree on the API base: build with the same EVENTOUCH_API_URL (and the same
// API port) that start will serve. The default on both sides is
// http://127.0.0.1:<API_PORT>; an explicit EVENTOUCH_API_URL here covers
// runtime readers but cannot re-point a build baked for another API. Ports
// are explicit configuration: an occupied port exits nonzero.
const path = require('node:path');
const { supervise } = require('./supervise.cjs');
const { assertBuiltApiTarget } = require('./built-api-target.cjs');

const ROOT = path.join(__dirname, '..');

async function main() {
  const apiPort = Number(process.env.API_PORT || 8776);
  const webPort = Number(process.env.WEB_PORT || 8777);
  const apiBase = process.env.EVENTOUCH_API_URL || `http://127.0.0.1:${apiPort}`;
  const nextBin = path.join(ROOT, 'apps/web/node_modules/next/dist/bin/next');
  // Rewrites are build artifacts. Never report a healthy product while its
  // web process silently sends requests to a different running API/database.
  assertBuiltApiTarget(path.join(ROOT, 'apps/web'), apiBase);

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
      args: [nextBin, 'start', '-H', '127.0.0.1', '-p', String(webPort)],
      cwd: path.join(ROOT, 'apps/web'),
      env: { ...process.env, PORT: String(webPort), EVENTOUCH_API_URL: apiBase },
    },
  });
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(`[supervisor] start failed: ${error && error.message}\n`);
  process.exitCode = 1;
});
