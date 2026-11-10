'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));

const source = fs.readFileSync(path.join(__dirname, '../apps/web/lib/booth-availability.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const exportsObject = {};
vm.runInNewContext(js, { exports: exportsObject, Date, Number });
const { boothOperatingStatus, formatBoothScheduleTime } = exportsObject;

test('booth availability names ambiguous or invalid operating times without guessing a timezone', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const booth = { status: 'OPEN', capacity: 0, used: 0 };
  for (const [startsAt, endsAt] of [
    ['2026-11-06T09:00', ''],
    ['bad-time', ''],
    ['2026-02-31T09:00:00+09:00', ''],
    ['2026-11-06T25:00:00+09:00', ''],
    ['2026-11-06T09:00:00+15:00', ''],
    ['2026-11-06T09:00:00+14:30', ''],
    ['2026-11-06T09:00:00+09:99', ''],
    ['2026-11-07T00:00:00Z', '2026-11-06T00:00:00Z'],
    ['2026-11-06T00:00:00Z', '2026-11-06T09:00:00+09:00'],
  ]) assert.equal(boothOperatingStatus({ ...booth, startsAt, endsAt }, now), '운영 시간 확인 필요', startsAt);
  assert.equal(boothOperatingStatus({ ...booth, startsAt: '', endsAt: '' }, now), '운영 중');
  assert.equal(boothOperatingStatus({ ...booth, startsAt: null, endsAt: null }, now), '운영 중');
  assert.equal(boothOperatingStatus({ ...booth, startsAt: '2026-11-06T20:00:00+09:00', endsAt: '2026-11-06T22:00:00+09:00' }, now), '운영 중');
  assert.equal(boothOperatingStatus({ ...booth, startsAt: '2026-11-06T13:00:00Z' }, now), '운영 예정');
  assert.equal(boothOperatingStatus({ ...booth, endsAt: '2026-11-06T11:00:00Z' }, now), '운영 종료');
  assert.equal(boothOperatingStatus({ ...booth, status: 'CLOSED', startsAt: 'bad' }, now), '운영 종료');
  assert.equal(boothOperatingStatus({ ...booth, status: 'WAITING', startsAt: 'bad' }, now), '운영 대기');
  assert.equal(boothOperatingStatus({ ...booth, startsAt: '2026-11-06T12:00:00Z' }, now), '운영 중', 'the start boundary is inclusive');
  assert.equal(boothOperatingStatus({ ...booth, endsAt: '2026-11-06T12:00:00Z' }, now), '운영 중', 'the end boundary is inclusive');
});

test('participant schedule shows only verified instants in Korea time', () => {
  const local = formatBoothScheduleTime('2026-11-06T21:00:00+09:00');
  assert.equal(formatBoothScheduleTime('2026-11-06T12:00:00Z'), local);
  assert.match(local, /2026년.*11월.*6일.*21:00.*한국 시간/);
  for (const value of ['2026-11-06T21:00', '2026-02-31T09:00:00+09:00', '2026-11-06T09:00:00+15:00', 'invalid']) {
    assert.equal(formatBoothScheduleTime(value), '시간 확인 필요', value);
  }
});
