'use strict';

// An ended sign-in must move the operator to the login screen. Elements keep
// their own recovery text, so the shell listens for one signal instead of every
// screen re-implementing a redirect (and quietly not doing it).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

test('a console 401 raises one shell-level signal', () => {
  const api = read('lib/console-api.ts');
  assert.match(api, /export const SESSION_EXPIRED_EVENT = "eventouch:session-expired"/, 'the event has one exported name');
  assert.match(api, /response\.status !== 401[\s\S]{0,80}return response/, 'only 401 answers raise it');
  assert.match(api, /\/\^\\\/api\\\/auth\\\/\(login\|logout\|me\|setup\|organizations\)\//, 'auth endpoints answer 401 as a normal reply and must not redirect');
  assert.match(api, /window\.dispatchEvent\(new Event\(SESSION_EXPIRED_EVENT\)\)/, 'the signal is raised from the shared fetch');
  assert.match(api, /export async function consoleFetch\(input: string, init\?: RequestInit\): Promise<Response> {\s*return reportEndedSession/, 'every console read and write goes through it');
});

test('the shell redirects to login and keeps the current address as the way back', () => {
  const shell = read('app/console/ConsoleShell.tsx');
  assert.match(shell, /SESSION_EXPIRED_EVENT/, 'the shell listens for the signal');
  assert.match(shell, /addEventListener\(SESSION_EXPIRED_EVENT, goToLogin\)/, 'one listener, one redirect');
  assert.match(shell, /loginHrefForLocation\(window\.location\.pathname, window\.location\.search\)/, 'the return path survives');
  assert.match(shell, /removeEventListener\(SESSION_EXPIRED_EVENT, goToLogin\)/, 'the listener is removed with the shell');
});
