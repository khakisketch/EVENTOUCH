'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');

// An isolated same-origin browser entry to the real Next build and a real
// PostgreSQL-backed API harness. This is a reverse proxy, not an API mock.
// It avoids rebuilding Next's baked rewrites for every random test API port.
async function startWebApiGateway({ apiBase, webBase, loseFirstResponseFor = null }) {
  const commands = [];
  const faults = new Set(Array.isArray(loseFirstResponseFor) ? loseFirstResponseFor : [loseFirstResponseFor]);
  const lostCommands = new Set();
  const completedLosses = new Set();
  const lossEvents = new EventEmitter();
  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url || !request.url.startsWith('/') || request.url.startsWith('//')) {
        response.writeHead(400);
        response.end('Only local application paths are allowed');
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      let command = null;
      // Organization REST writes carry no `command` field; name the one
      // fault-injection target by path so a committed loss can be aimed at
      // it. REST faults stay out of the `commands` write log that other
      // audits count — only the loss machinery below reads them.
      let restFault = null;
      if (request.url.startsWith('/api/') && request.method === 'POST') {
        const requestURL = new URL(request.url, 'http://gateway.invalid');
        if (/^\/api\/events\/[^/]+\/files$/.test(requestURL.pathname)) {
          command = { command: 'file.upload', commandId: requestURL.searchParams.get('commandId'), status: null, responseLost: false };
          commands.push(command);
        } else {
          try {
            const parsed = JSON.parse(body.toString('utf8'));
            if (typeof parsed.command === 'string') {
              command = { command: parsed.command, commandId: parsed.commandId, status: null, responseLost: false };
              commands.push(command);
            } else if (requestURL.pathname === '/api/clients') {
              restFault = { command: 'client.save', commandId: typeof parsed.commandId === 'string' ? parsed.commandId : null, status: null, responseLost: false };
            }
          } catch { /* Non-command requests are forwarded unchanged. */ }
        }
      }
      const base = new URL(request.url.startsWith('/api/') ? apiBase : webBase);
      const destination = new URL(request.url, base);
      if (destination.origin !== base.origin) {
        response.writeHead(400);
        response.end('Only configured upstream origins are allowed');
        return;
      }
      const upstream = http.request(destination, {
        method: request.method,
        // Preserve the public Host/Origin pair, just like a deployment proxy.
        headers: { ...request.headers, connection: 'close' },
      }, (reply) => {
        if (command) command.status = reply.statusCode;
        if (restFault) restFault.status = reply.statusCode;
        const faultTarget = command || restFault;
        if (faultTarget && faults.has(faultTarget.command) && !lostCommands.has(faultTarget.command) && reply.statusCode >= 200 && reply.statusCode < 300) {
          // The API already committed. Consume its real reply, then lose only
          // the transport response so the UI must retry the stored receipt.
          lostCommands.add(faultTarget.command);
          faultTarget.responseLost = true;
          reply.resume();
          reply.on('end', () => {
            completedLosses.add(faultTarget.command);
            response.destroy();
            lossEvents.emit('loss', faultTarget.command);
          });
          return;
        }
        response.writeHead(reply.statusCode, reply.headers);
        reply.on('error', () => response.destroy());
        reply.pipe(response);
      });
      upstream.on('error', (error) => {
        if (command) command.transportError = error.code || error.message;
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(`Test gateway upstream failed: ${error.message}`);
      });
      upstream.end(body);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`Test gateway failed: ${error.message}`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    commands,
    waitForResponseLoss(command, timeout = 10000) {
      if (completedLosses.has(command)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const clear = () => { clearTimeout(timer); lossEvents.off('loss', listener); };
        const listener = (name) => { if (name === command) { clear(); resolve(); } };
        const timer = setTimeout(() => { clear(); reject(new Error(`Expected committed response loss was not observed: ${command}`)); }, timeout);
        lossEvents.on('loss', listener);
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

module.exports = { startWebApiGateway };
