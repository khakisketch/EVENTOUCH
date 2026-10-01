const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KO_PATH = path.join(__dirname, '..', 'i18n', 'ko.json');
const REQUIRED_KEYS = ['overview', 'participants', 'checkin', 'booth', 'home', 'stage'];

function collectEmptyStrings(value, trail, out) {
  if (typeof value === 'string') {
    if (value.trim() === '') out.push(trail);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectEmptyStrings(item, `${trail}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectEmptyStrings(v, trail ? `${trail}.${k}` : k, out);
    }
  }
}

test('ko.json exists with required nav keys and no empty values', () => {
  let raw;
  try {
    raw = fs.readFileSync(KO_PATH, 'utf8');
  } catch (err) {
    assert.fail('ko.json not found');
  }
  const ko = JSON.parse(raw);
  for (const key of REQUIRED_KEYS) {
    assert.ok(
      typeof ko[key] === 'string' && ko[key].trim() !== '',
      `ko.json missing or empty key: ${key}`
    );
  }
  const empties = [];
  collectEmptyStrings(ko, '', empties);
  assert.deepEqual(empties, [], `ko.json has empty values at: ${empties.join(', ')}`);
});
