'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');

// Serve the actual product through a loopback proxy. For the selected read,
// send HTTP headers and a partial JSON body without closing the stream.
async function startStalledResponseProxy(baseUrl, apiPath) {
  const upstreamOrigin = new URL(baseUrl);
  const stalledResponses = [];
  let stall = false;
  const server = http.createServer((request, response) => {
    const stallThisRead = request.method === 'GET' && request.url === apiPath && stall;
    const upstream = http.request(baseUrl + request.url, {
      method: request.method, headers: { ...request.headers, host: upstreamOrigin.host },
    }, result => {
      if (!stallThisRead || result.statusCode !== 200) {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
        return;
      }
      // Preserve the API's organization proof while replacing only the body.
      const headers = { ...result.headers };
      delete headers['content-length'];
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      stalledResponses.push(new Promise(resolve => response.once('close', resolve)));
      response.writeHead(result.statusCode, headers);
      response.write('{"event":');
      result.resume();
    });
    response.on('close', () => upstream.destroy());
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    setStalled(value) { stall = value; },
    async waitForClosed(index) {
      assert.ok(stalledResponses[index], 'the stalled HTTP response was opened');
      const controller = new AbortController();
      try {
        await Promise.race([
          stalledResponses[index],
          delay(2000, null, { signal: controller.signal }).then(() => {
            throw new Error('the browser left the stalled HTTP response open');
          }),
        ]);
      } finally {
        controller.abort();
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { startStalledResponseProxy };
