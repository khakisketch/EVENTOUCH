'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');
const { explicitScheduleInstant } = require('../server/commands/content-results');

// Exercise the actual UI helpers and compare them with the authoritative
// server guard, including dates JS Date.parse otherwise normalizes.
const source = fs.readFileSync('apps/web/app/console/events/[id]/messages/MessagingWorkspace.tsx', 'utf8');
function loadHelper(name, content = source) {
  const start = content.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = content.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name} is complete`);
  const js = ts.transpileModule(`${content.slice(start, end + 2)}\nthis.result = ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const scope = {};
  vm.runInNewContext(js, scope);
  return scope.result;
}

const validInUi = loadHelper('hasValidScheduledInstant', fs.readFileSync('apps/web/lib/message-attention.ts', 'utf8'));
const instant = loadHelper('scheduledInstant');

test('message schedule UI and server agree on calendar dates and offsets', () => {
  for (const year of [2024, 2026, 2030, 2100]) {
    for (let month = 1; month <= 12; month++) {
      for (let day = 0; day <= 32; day++) {
        for (const offset of ['Z', '+09:00', '-0400', '+14:00', '+14:01', '-15:00', '']) {
          const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T09:30:00${offset}`;
          assert.equal(validInUi(value), Number.isFinite(explicitScheduleInstant(value)), value);
        }
      }
    }
  }
  for (const value of ['2030-11-12T25:00Z', '2030-11-12T09:60Z', '2030-11-12T09:00:60Z', '2030-11-12T09:00.123Z', '2030-11-12T09:00+0900']) {
    assert.equal(validInUi(value), Number.isFinite(explicitScheduleInstant(value)), value);
  }
});

test('message input maps Korean wall time to an explicit UTC instant', () => {
  assert.equal(instant('2030-11-12T09:00'), '2030-11-12T00:00:00.000Z');
  assert.equal(instant('2028-02-29T00:00'), '2028-02-28T15:00:00.000Z');
  for (const value of ['2030-02-30T09:00', '2029-02-29T09:00', '2030-11-12T25:00', '2030-11-12T09:60', '']) assert.equal(instant(value), null, value);
});
