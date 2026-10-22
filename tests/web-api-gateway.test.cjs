'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startWebApiGateway } = require('./helpers/web-api-gateway.cjs');

async function upstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test('browser test gateway forwards real HTTP and loses only the selected response once', async () => {
  let writes = 0;
  const api = await upstream(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    writes += 1;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ body: JSON.parse(Buffer.concat(chunks)), host: request.headers.host, origin: request.headers.origin }));
  });
  const web = await upstream((_request, response) => response.end('actual web upstream'));
  const gateway = await startWebApiGateway({ apiBase: api.baseUrl, webBase: web.baseUrl, loseFirstResponseFor: ['fixture.commit', 'fixture.collect'] });
  try {
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gateway.baseUrl },
      body: JSON.stringify({ commandId: 'same-fixture-receipt', command: 'fixture.commit', payload: { count: 8 } }),
    };
    await assert.rejects(fetch(`${gateway.baseUrl}/api/events/fixture/commands`, options));
    await gateway.waitForResponseLoss('fixture.commit');
    assert.equal(writes, 1, 'response loss must occur after the real upstream handled the write');
    const response = await fetch(`${gateway.baseUrl}/api/events/fixture/commands`, options);
    assert.equal(response.status, 201);
    const actual = await response.json();
    assert.equal(actual.body.commandId, 'same-fixture-receipt');
    assert.equal(actual.host, new URL(gateway.baseUrl).host);
    assert.equal(actual.origin, gateway.baseUrl);
    assert.equal(writes, 2, 'the gateway never fabricates an idempotent API result');
    assert.deepEqual(gateway.commands.map((entry) => entry.responseLost), [true, false]);
    const collect = { ...options, body: JSON.stringify({ commandId: 'same-collect-receipt', command: 'fixture.collect', payload: {} }) };
    await assert.rejects(fetch(`${gateway.baseUrl}/api/events/fixture/commands`, collect));
    const collected = await fetch(`${gateway.baseUrl}/api/events/fixture/commands`, collect);
    assert.equal(collected.status, 201);
    await collected.json();
    assert.equal(writes, 4);
    assert.deepEqual(gateway.commands.map((entry) => entry.responseLost), [true, false, true, false]);
    assert.equal(await (await fetch(`${gateway.baseUrl}/page`)).text(), 'actual web upstream');
  } finally {
    await gateway.close();
    await api.close();
    await web.close();
  }
});

test('browser test gateway refuses paths escaping its fixed upstream origins', async () => {
  let calls = 0;
  const api = await upstream((_request, response) => { calls += 1; response.end('api'); });
  const web = await upstream((_request, response) => { calls += 1; response.end('web'); });
  const gateway = await startWebApiGateway({ apiBase: api.baseUrl, webBase: web.baseUrl });
  try {
    for (const requestPath of ['//outside.invalid/api', '/\\outside.invalid/api']) {
      const status = await new Promise((resolve, reject) => {
        const request = http.request(gateway.baseUrl, { path: requestPath }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 400);
    }
    assert.equal(calls, 0);
  } finally {
    await gateway.close();
    await api.close();
    await web.close();
  }
});

test('browser test gateway forwards binary uploads unchanged and loses only the acknowledged response', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 128, 12]);
  let uploads = 0;
  const api = await upstream(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(request.headers['content-type'], 'image/png');
    uploads += 1;
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ file: { fileId: 'upstream-confirmed-file' } }));
  });
  const web = await upstream((_request, response) => response.end('web'));
  const gateway = await startWebApiGateway({ apiBase: api.baseUrl, webBase: web.baseUrl, loseFirstResponseFor: 'file.upload' });
  try {
    const url = `${gateway.baseUrl}/api/events/fixture/files?name=banner.png&commandId=upload-receipt`;
    const options = { method: 'POST', headers: { 'content-type': 'image/png' }, body: bytes };
    await assert.rejects(fetch(url, options));
    await gateway.waitForResponseLoss('file.upload');
    assert.equal(uploads, 1);
    const response = await fetch(url, options);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).file.fileId, 'upstream-confirmed-file');
    assert.equal(uploads, 2, 'the gateway forwards retries rather than fabricating file receipts');
    assert.deepEqual(gateway.commands.map((entry) => [entry.command, entry.commandId, entry.responseLost]), [
      ['file.upload', 'upload-receipt', true], ['file.upload', 'upload-receipt', false],
    ]);
  } finally {
    await gateway.close(); await api.close(); await web.close();
  }
});
