'use strict';
// Unexpected 5xx responses must not echo raw internal error details; expected
// domain failures (4xx with an explicit status) keep their user-facing message.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { handleApi } = require('../server/api');
const { createDatabaseAuth } = require('../server/auth');

function mockResponse() {
  const captured = { status: null, headers: null, body: null };
  return {
    captured,
    setHeader(name, value) {
      captured.headers = Object.assign(captured.headers || {}, { [name]: value });
    },
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = Object.assign(captured.headers || {}, headers || {});
      return this;
    },
    end(body) {
      captured.body = body ? JSON.parse(body) : null;
    },
    destroy() {},
  };
}

test('unexpected internal failures return a generic message without raw details', async () => {
  const res = mockResponse();
  await handleApi(
    { method: 'GET', headers: {} },
    res,
    {},
    '/api/bootstrap',
    {
      auth: { sessionFromCookie: async () => ({ id: 'acct-1', role: 'AGENCY' }) },
      state: { loadBootstrap: async () => { throw new Error('INTERNAL_SENTINEL_DETAILS'); } },
    }
  );
  assert.equal(res.captured.status, 500);
  assert.equal(res.captured.body.error, '요청을 처리하지 못했습니다');
  assert.doesNotMatch(JSON.stringify(res.captured.body), /INTERNAL_SENTINEL_DETAILS/);
});

test('expected domain failures keep their explicit status and message', async () => {
  const res = mockResponse();
  await handleApi(
    { method: 'GET', headers: {} },
    res,
    {},
    '/api/bootstrap',
    {
      auth: { sessionFromCookie: async () => ({ id: 'acct-1', role: 'AGENCY' }) },
      state: {
        loadBootstrap: async () => {
          throw Object.assign(new Error('보관된 행사는 변경할 수 없습니다'), { status: 409 });
        },
      },
    }
  );
  assert.equal(res.captured.status, 409);
  assert.equal(res.captured.body.error, '보관된 행사는 변경할 수 없습니다');
});

test('unexpected invitation failures return a generic message without raw details', async () => {
  const database = {
    query: async (sql) => {
      if (/FROM sessions/.test(sql)) {
        return { rows: [{
          id: 'acct-1', email: 'agency@example.test', name: '운영자',
          global_role: 'AGENCY', active: true, session_org: 'org-legacy', session_version: 0,
        }] };
      }
      if (/organization_memberships/.test(sql)) {
        return { rows: [{
          org_id: 'org-legacy', role: 'AGENCY', active: true,
          permissions: [], org_name: '기존 조직', context_version: 0,
        }] };
      }
      return { rows: [{ role: 'AGENCY', active: true }] };
    },
    transaction: async () => { throw new Error('AUTH_INTERNAL_SENTINEL'); },
  };
  const auth = createDatabaseAuth(database);
  const res = mockResponse();
  const req = Readable.from([Buffer.from(JSON.stringify({
    commandId: 'cmd-12345678',
    name: '초대 대상',
    email: 'invitee@example.test',
    role: 'MANAGER',
  }))]);
  req.method = 'POST';
  req.headers = { cookie: 'etko_session=stub-token' };
  await auth.handleAuth(req, res, '/api/auth/invitations');
  assert.equal(res.captured.status, 500);
  assert.equal(res.captured.body.error, '초대를 만들지 못했습니다');
  assert.doesNotMatch(JSON.stringify(res.captured.body), /AUTH_INTERNAL_SENTINEL/);
});
