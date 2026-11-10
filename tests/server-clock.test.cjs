'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));
function load(file, context) {
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/lib', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports = {}; vm.runInNewContext(js, { exports, ...context }); return exports;
}

test('server clock bounds transit and invalidates after clock jumps or sleep mismatch', () => {
  let mono = 2100, wall = 1800000002000;
  const { captureServerClock, readServerClock } = load('server-clock.ts', { Date: { now: () => wall }, performance: { now: () => mono }, Number, Math });
  const clock = captureServerClock(1800000000000, 1000, 2000, 1800000001900);
  const first = readServerClock(clock);
  assert.equal(first.now, 1800000000601);
  assert.ok(first.uncertaintyMs >= 501 && first.uncertaintyMs < 502);
  mono += 2000; wall += 2000;
  assert.equal(readServerClock(clock).now, first.now + 2000);
  wall += 2000;
  assert.ok(readServerClock(clock).uncertaintyMs >= 2500, 'small wall/monotonic divergence increases uncertainty');
  wall += 6000;
  assert.equal(readServerClock(clock), null, 'wall clock adjustment or suspended monotonic time requires another sample');
  assert.equal(captureServerClock(undefined, 1000, 2000, wall), null);
  assert.equal(captureServerClock('1800000000000', 1000, 2000, wall), null);
  assert.equal(captureServerClock(1800000000000, 2001, 2000, wall), null);
  assert.equal(captureServerClock(1800000000000, 0, 8001, wall), null);
});

test('booth status distinguishes invalid schedules from an uncertain server time', () => {
  const { boothOperatingStatus, boothCanAttempt } = load('booth-availability.ts', { Date, Number, Math, Intl });
  const now = Date.parse('2026-11-06T12:00:00Z');
  const booth = { status: 'OPEN', startsAt: '2026-11-06T12:00:00Z', endsAt: '2026-11-06T13:00:00Z' };
  assert.equal(boothOperatingStatus(booth, now - 5000, 1000), '운영 예정');
  assert.equal(boothOperatingStatus(booth, now - 500, 1000), '인증 시 시간 확인');
  assert.equal(boothOperatingStatus(booth, now + 5000, 1000), '운영 중');
  assert.equal(boothOperatingStatus(booth, now + 3600500, 1000), '인증 시 시간 확인');
  assert.equal(boothOperatingStatus(booth, now + 3605000, 1000), '운영 종료');
  assert.equal(boothOperatingStatus(booth, null), '인증 시 시간 확인');
  assert.equal(boothCanAttempt(boothOperatingStatus(booth, null)), true);
  assert.equal(boothCanAttempt(boothOperatingStatus({ ...booth, startsAt: 'bad' }, null)), false);
  assert.equal(boothCanAttempt(boothOperatingStatus({ ...booth, status: 'CLOSED' }, null)), false);
  assert.equal(boothOperatingStatus({ ...booth, capacity: 1, used: 1 }, null), '수량 소진');
});
