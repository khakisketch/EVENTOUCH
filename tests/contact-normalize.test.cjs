'use strict';

// Operator contact data from spreadsheets: the server and the import preview share these rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeContactPhone, phoneLeadingZeroRestored, emailLooksValid, suggestCompany } = require('../apps/web/lib/contact-normalize.cjs');

test('phones accept hyphens, +82 and a spreadsheet-dropped leading 0', () => {
  assert.equal(normalizeContactPhone('010-1234-5678'), '01012345678');
  assert.equal(normalizeContactPhone('010 1234 5678'), '01012345678');
  assert.equal(normalizeContactPhone('1012345678'), '01012345678');
  assert.equal(normalizeContactPhone('+82 10-1234-5678'), '01012345678');
  assert.equal(normalizeContactPhone('1588-1234'), '15881234', '8-digit service numbers keep their shape');
  assert.equal(phoneLeadingZeroRestored('1012345678'), true);
  assert.equal(phoneLeadingZeroRestored('010-1234-5678'), false);
});

test('email shape is checked without blocking an empty value', () => {
  assert.equal(emailLooksValid(''), true);
  assert.equal(emailLooksValid('a@b.co'), true);
  assert.equal(emailLooksValid('a@b'), false);
});

test('a rare 소속 is offered the well-used look-alike, small distinct ones are left alone', () => {
  const counts = new Map([['삼성전자', 24], ['삼상전자', 1], ['(주)한울물산', 3], ['한울물산', 1], ['SK', 2], ['KT', 2]]);
  assert.deepEqual(suggestCompany('삼상전자', counts), { company: '삼성전자', count: 24 });
  assert.deepEqual(suggestCompany('한울물산', counts), { company: '(주)한울물산', count: 3 });
  assert.equal(suggestCompany('SK', counts), null);
  assert.equal(suggestCompany('삼성전자', counts), null, 'the common spelling is never "corrected"');
});

test('the import preview and the server use the same phone rule', () => {
  const wizard = fs.readFileSync(path.join(__dirname, '..', 'apps/web/app/console/events/[id]/participants/import/ImportWizard.tsx'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server/commands/participants.js'), 'utf8');
  assert.match(wizard, /const international = \/\^82\(0\?\)\(\[1-9\]\\d\{7,9\}\)\$\/\.exec\(digits\);/u);
  assert.match(wizard, /if \(\/\^\[1-9\]\\d\{8,9\}\$\/\.test\(digits\)\) return `0\$\{digits\}`;/u);
  assert.match(server, /return normalizeContactPhone\(value\);/u);
  assert.match(server, /lenientEmail: true,/u, 'only the bulk import keeps a malformed email');
});
