'use strict';

// Runs the product suite and fails when any test was skipped.
//
// The suite skips its PostgreSQL integration tests whenever
// EVENTOUCH_TEST_DATABASE_URL is absent. That is correct for a developer on
// a laptop with no database, but it is exactly how a broken or unconfigured
// CI job can report success while more than half the backend never ran —
// silent coverage loss that looks like a green build.
//
// So the rule is: if you supply the database, no test may be skipped. Run
// this through `npm test` to get that guarantee instead of a bare
// `node --test` invocation.

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATABASE_ENV = 'EVENTOUCH_TEST_DATABASE_URL';

function runTests({ databaseUrl }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'tests/*.test.cjs'], {
      cwd: ROOT,
      env: { ...process.env, ...(databaseUrl ? { [DATABASE_ENV]: databaseUrl } : {}) },
      // shell:true lets the shell expand the glob so Node receives the list.
      shell: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

function readCounts(output) {
  const value = (label) => {
    const match = new RegExp(`^#\\s*${label}\\s+(\\d+)\\s*$`, 'm').exec(output);
    return match ? Number(match[1]) : null;
  };
  return {
    tests: value('tests'),
    pass: value('pass'),
    fail: value('fail'),
    skipped: value('skipped'),
  };
}

async function main() {
  const databaseUrl = String(process.env[DATABASE_ENV] || '').trim();
  const { code, output } = await runTests({ databaseUrl });
  const counts = readCounts(output);

  if (code !== 0) {
    process.stderr.write('[eventouch] the test suite failed\n');
    process.exitCode = code || 1;
    return;
  }

  const summary = counts.tests == null
    ? 'unknown totals'
    : `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped`;

  if (counts.skipped > 0) {
    process.stderr.write(
      `[eventouch] ${summary}\n` +
        `[eventouch] FAILED: ${counts.skipped} test(s) were skipped.\n` +
        `[eventouch] ${databaseUrl ? DATABASE_ENV + ' is set but tests still skipped — a suite is gating itself unexpectedly.' : DATABASE_ENV + ' is not set, so the PostgreSQL integration tests did not run.'}\n` +
        '[eventouch] Run against a real database so the backend suite is actually exercised.\n'
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`[eventouch] ${summary}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[eventouch] test runner failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runTests, readCounts };