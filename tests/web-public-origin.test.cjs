'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const web = path.resolve(__dirname, '../apps/web');
const ts = createRequire(path.join(web, 'package.json'))('typescript');
const originalTsLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  module._compile(output.outputText, filename);
};
const { configuredPublicBase } = require('../apps/web/lib/public-origin.ts');
if (originalTsLoader) require.extensions['.ts'] = originalTsLoader;
else delete require.extensions['.ts'];

const { publicOrigin } = require('../server/public-origin.js');

test('the console reads the configured public address by the server rule', () => {
  const cases = [
    '', '   ', 'not a url', 'ftp://example.com', 'javascript:alert(1)',
    'https://user:pw@events.example.com', 'https://events.example.com/?a=1', 'https://events.example.com/#x',
    'https://events.example.com', 'https://events.example.com/', 'https://events.example.com/app/', 'http://192.168.0.10:8777',
  ];
  for (const raw of cases) {
    const env = { EVENTOUCH_PUBLIC_URL: raw };
    assert.equal(configuredPublicBase(env), publicOrigin(env), `same result as the server for "${raw}"`);
  }
  assert.equal(configuredPublicBase({}), null);
  assert.equal(configuredPublicBase({ EVENTOUCH_PUBLIC_URL: 'https://events.example.com/app/' }), 'https://events.example.com/app');
});

test('the guide QR uses the configured public address before the console address', () => {
  const qr = fs.readFileSync(path.join(web, 'app/console/events/[id]/page/AttendeeGuideQr.tsx'), 'utf8');
  assert.match(qr, /setOrigin\(publicBase \?\? window\.location\.origin\)/u);
  assert.match(qr, /new URL\(`\$\{origin\}\/event\/\$\{encodeURIComponent\(slug\)\}`\)/u, 'a path in the public address is kept');
  const page = fs.readFileSync(path.join(web, 'app/console/events/[id]/page/page.tsx'), 'utf8');
  assert.match(page, /publicBase=\{configuredPublicBase\(\)\}/u);
});
