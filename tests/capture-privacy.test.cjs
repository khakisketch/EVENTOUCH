'use strict';

// Capture privacy regression contract for standalone audit entrypoints.
//
// What this pins (without DB, browsers, or servers):
// - scripts/capture-dir.cjs prepare/ensure semantics: fresh-only roots,
//   idempotent in-run reuse, no overwrite, symlink refusal, owned-private
//   base, no chmod of existing entries, per-process private umask, and one
//   stderr announce line per fresh root.
// - file modes under an ambient umask of 000 (child processes, so the test
//   runner's own umask is never touched): Playwright-style writes (no mode
//   argument, i.e. 0666 & ~umask) and explicit JSON writes all land 0600;
//   leaf dirs land 0700; a hardlinked-out 0600 file stays group/other-closed
//   while a 0666 control does not.
// - a real multi-capture / multi-namespace flow mirroring the boundary audit
//   (several screenshots into one dir) and the console composition (run root
//   + sweep/attendee-style sub-namespaces).
// - static source contracts over every wired standalone entrypoint: helper
//   use, no recursive mkdir, fresh-per-run stamped defaults, an env override
//   for hardcoded paths, preserved namespace literals, and no exact-duplicate
//   screenshot/PDF target within a single script.
// - scripts/verify-system.cjs is owned elsewhere: this file asserts it stays
//   free of the standalone helper (read-only check, never modified here).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts', 'capture-dir.cjs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function withUmask(mask, fn) {
  const prev = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(prev);
  }
}

// Self-spawn: argv[2] selects the child role so temp-dir/child-code quoting
// stays out of shell strings. Children requiring the helper set their own
// umask first (ambient 000 in the privacy roles) and exit non-zero on any
// assertion failure; stdout carries a JSON summary the parent re-verifies.
function runChild(role, workdir, { umask, env = {} } = {}) {
  const args = umask === undefined
    ? [__filename, role]
    : ['-e', 'process.umask(Number(process.argv[1])); require(process.argv[2]);', String(umask), __filename];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env, CAPTURE_PRIVACY_CHILD: role, CAPTURE_PRIVACY_WORKDIR: workdir },
    encoding: 'utf8',
    timeout: 60000,
  });
  return result;
}

if (process.env.CAPTURE_PRIVACY_CHILD) {
  const role = process.env.CAPTURE_PRIVACY_CHILD;
  const work = process.env.CAPTURE_PRIVACY_WORKDIR;
  const helper = require(HELPER);
  const out = {};
  try {
    if (role === 'fresh-umask000') {
      process.umask(0);
      const leaf = helper.prepareCaptureDir(path.join(work, 'run'));
      out.leaf = leaf;
      // Playwright-style write: no mode argument (0666 & ~umask on disk).
      fs.writeFileSync(path.join(leaf, 'shot.png'), Buffer.from([137, 80, 78, 71]));
      fs.writeFileSync(path.join(leaf, 'verification.json'), '{}', { mode: 0o600 });
      // Mirror saveShot: the same dir is ensured once per screenshot.
      for (let i = 0; i < 4; i += 1) helper.ensureCaptureDir(leaf);
      const sub = helper.ensureCaptureDir(path.join(leaf, 'attendee'));
      fs.writeFileSync(path.join(sub, 'qr.png'), Buffer.from([1, 2, 3]));
      for (let i = 0; i < 2; i += 1) helper.ensureCaptureDir(sub);
      out.ok = true;
    } else if (role === 'existing-and-links') {
      // Legacy-shaped entries first: the helper pins the process umask to
      // 077 on first use. Set the exact synthetic mode regardless of the
      // inherited umask, including verify:system's restrictive umask.
      const legacy = path.join(work, 'legacy');
      fs.mkdirSync(legacy, { mode: 0o755 });
      fs.chmodSync(legacy, 0o755);
      const fileLeaf = path.join(work, 'fileleaf');
      fs.writeFileSync(fileLeaf, 'x');
      const taken = path.join(work, 'taken');
      helper.prepareCaptureDir(taken);
      fs.writeFileSync(path.join(taken, 'keep.json'), '{"keep":true}', { mode: 0o600 });
      assert.throws(() => helper.prepareCaptureDir(taken), /덮어쓰지 않습니다/);
      assert.equal(fs.readFileSync(path.join(taken, 'keep.json'), 'utf8'), '{"keep":true}');
      const linkLeaf = path.join(work, 'linkleaf');
      fs.symlinkSync(taken, linkLeaf);
      assert.throws(() => helper.prepareCaptureDir(linkLeaf), /심볼릭 링크|안전하지/);
      assert.throws(() => helper.ensureCaptureDir(linkLeaf), /심볼릭 링크|안전하지/);
      const real = path.join(work, 'realparent');
      helper.prepareCaptureDir(real);
      const linkParent = path.join(work, 'linkparent');
      fs.symlinkSync(real, linkParent);
      assert.throws(() => helper.ensureCaptureDir(path.join(linkParent, 'sub')), /안전하지/);
      // Swap race: verified dir replaced by a symlink must fail the next use.
      const swap = helper.ensureCaptureDir(path.join(work, 'swapme'));
      fs.rmSync(swap, { recursive: true, force: true });
      fs.symlinkSync(taken, swap);
      assert.throws(() => helper.ensureCaptureDir(swap), /심볼릭 링크|안전하지/);
      // Legacy shared-permission dir is refused, never silently chmodded.
      assert.equal(fs.statSync(legacy).mode & 0o777, 0o755);
      assert.throws(() => helper.ensureCaptureDir(legacy), /안전하지/);
      assert.equal(fs.statSync(legacy).mode & 0o777, 0o755);
      // A plain file at the leaf path is refused too.
      assert.throws(() => helper.ensureCaptureDir(fileLeaf), /안전하지/);
      out.ok = true;
    } else if (role === 'hardlink-exposure') {
      process.umask(0);
      const leaf = helper.prepareCaptureDir(path.join(work, 'run'));
      const outside = path.join(work, 'outside');
      fs.mkdirSync(outside);
      // Control: a Playwright-default write with NO helper umask would be 0666.
      const control = path.join(outside, 'control.bin');
      const prev = process.umask(0);
      fs.writeFileSync(control, Buffer.from([9, 9, 9]));
      process.umask(prev);
      // Real: the helper pins the process umask to 077, so the same
      // Playwright-style write lands 0600 even under ambient umask 000.
      const shot = path.join(leaf, 'shot.png');
      fs.writeFileSync(shot, Buffer.from([137, 80, 78, 71]));
      const linked = path.join(outside, 'linked-shot.png');
      fs.linkSync(shot, linked);
      out.controlMode = (fs.statSync(control).mode & 0o777).toString(8);
      out.shotMode = (fs.statSync(shot).mode & 0o777).toString(8);
      out.linkedMode = (fs.statSync(linked).mode & 0o777).toString(8);
      out.ok = true;
    } else if (role === 'tmpdir-default') {
      // No explicit TMPDIR (or a shared-tree one): run-private tmp wins.
      delete process.env.TMPDIR;
      const { ensureRunTmpDir } = helper;
      const root = helper.prepareCaptureDir(path.join(work, 'run'));
      const before = process.umask(0);
      const tmp = ensureRunTmpDir(root);
      out.tmpdirEnv = process.env.TMPDIR;
      out.osTmpdir = require('node:os').tmpdir();
      out.tmp = tmp;
      out.tmpMode = (fs.statSync(tmp).mode & 0o777).toString(8);
      // Harness-style store creation, exactly like postgres-api-server.cjs.
      const store = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'eventouch-api-test-'));
      out.storeMode = (fs.statSync(store).mode & 0o777).toString(8);
      out.storeInside = store.startsWith(`${tmp}${path.sep}`);
      // Shared-tree inheritance is refused in favor of the private tmp.
      process.env.TMPDIR = path.join('/tmp', 'opencode');
      const tmp2 = ensureRunTmpDir(root);
      out.sharedOverridden = tmp2 === tmp && process.env.TMPDIR === tmp;
      process.umask(before);
      out.ok = true;
    } else if (role === 'tmpdir-explicit') {
      const { ensureRunTmpDir } = helper;
      // Lax fixture first: the helper pins the process umask to 077 on first
      // use, so ambient-0775 shapes must predate it.
      process.umask(0);
      const lax = path.join(work, 'lax-tmp');
      fs.mkdirSync(lax, { mode: 0o775 });
      const safe = path.join(work, 'operator-tmp');
      fs.mkdirSync(safe, { mode: 0o700 });
      const sharedParent = path.join(work, 'shared-parent');
      fs.mkdirSync(sharedParent, { mode: 0o775 });
      const nestedSafe = path.join(sharedParent, 'nested-safe');
      fs.mkdirSync(nestedSafe, { mode: 0o700 });
      const linkedParent = path.join(work, 'linked-parent');
      fs.symlinkSync(work, linkedParent);
      const link = path.join(work, 'tmplink');
      fs.symlinkSync(safe, link);
      const root = helper.prepareCaptureDir(path.join(work, 'run'));
      // Explicit safe dir: honored as-is, run root untouched otherwise.
      process.env.TMPDIR = safe;
      const kept = ensureRunTmpDir(root);
      out.keptExplicit = kept === safe && process.env.TMPDIR === safe;
      out.noTmpUnderRoot = !fs.existsSync(path.join(root, 'tmp'));
      // Explicit unsafe (group-writable), symlink, and missing dirs throw.
      process.env.TMPDIR = lax;
      assert.throws(() => ensureRunTmpDir(root), /안전하지 않은 TMPDIR/);
      process.env.TMPDIR = link;
      assert.throws(() => ensureRunTmpDir(root), /심볼릭 링크/);
      process.env.TMPDIR = path.join(work, 'does-not-exist');
      assert.throws(() => ensureRunTmpDir(root), /존재하지 않습니다/);
      process.env.TMPDIR = nestedSafe;
      assert.throws(() => ensureRunTmpDir(root), /안전하지 않은 캡처 상위 경로/);
      process.env.TMPDIR = path.join(linkedParent, 'operator-tmp');
      assert.throws(() => ensureRunTmpDir(root), /안전하지 않은 캡처 상위 경로/);
      process.env.TMPDIR = ROOT;
      assert.throws(() => ensureRunTmpDir(root), /저장소 밖/);
      out.ok = true;
    } else if (role === 'real-browser') {
      process.umask(0);
      const leaf = helper.prepareCaptureDir(path.join(work, 'run'));
      const { launchBrowser } = require(path.join(ROOT, 'scripts', 'audit-browser.cjs'));
      (async () => {
        let browser;
        try { browser = await launchBrowser(); }
        catch (error) {
          process.stderr.write(`[capture-privacy] browser unavailable: ${error.message}\n`);
          process.exit(42);
        }
        try {
          const page = await browser.newPage();
          await page.setContent('<main><h1>privacy probe</h1></main>');
          const shot = path.join(leaf, 'real.png');
          await page.screenshot({ path: shot });
          await page.pdf({ path: path.join(leaf, 'real.pdf'), format: 'A4' });
          process.stdout.write(JSON.stringify({ ok: true, leaf }));
        } finally {
          await browser.close().catch(() => {});
        }
      })().catch((error) => {
        process.stderr.write(`[capture-privacy] capture failed: ${error.message}\n`);
        process.exit(1);
      });
      return;
    } else {
      throw new Error(`unknown child role: ${role}`);
    }
    process.stdout.write(JSON.stringify(out));
  } catch (error) {
    process.stderr.write(`[capture-privacy:${role}] ${error && error.message}\n`);
    process.exitCode = 1;
  }
  return;
}

test('fresh roots are private and announced; reuse never overwrites', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-privacy-test-'));
  try {
    const work = path.join(parent, 'w1');
    fs.mkdirSync(work, { mode: 0o700 });
    const result = runChild('fresh-umask000', work);
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.match(result.stderr, /\[capture\] output: /, 'one announce line per fresh root');
    const leaf = summary.leaf;
    assert.equal(fs.statSync(leaf).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(leaf, 'attendee')).mode & 0o777, 0o700);
    // Ambient umask was 000 in the child: Playwright-style files must be 0600.
    assert.equal(fs.statSync(path.join(leaf, 'shot.png')).mode & 0o600, 0o600);
    assert.equal(fs.statSync(path.join(leaf, 'shot.png')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(leaf, 'verification.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(leaf, 'attendee', 'qr.png')).mode & 0o777, 0o600);
    // Second run against the same leaf refuses and preserves evidence.
    const again = spawnSync(process.execPath, ['-e', `
      const h = require(${JSON.stringify(HELPER)});
      h.prepareCaptureDir(${JSON.stringify(leaf)});
    `], { encoding: 'utf8' });
    assert.notEqual(again.status, 0, 're-preparing an existing leaf must fail');
    assert.match(again.stderr, /덮어쓰지 않습니다/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('existing paths, links and legacy permissions are refused, never repaired', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-privacy-test-'));
  try {
    const work = path.join(parent, 'w2');
    fs.mkdirSync(work, { mode: 0o700 });
    const result = runChild('existing-and-links', work);
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    const restrictiveWork = path.join(parent, 'w2-restrictive');
    fs.mkdirSync(restrictiveWork, { mode: 0o700 });
    const restrictive = runChild('existing-and-links', restrictiveWork, { umask: 0o077, env: { TMPDIR: parent } });
    assert.equal(restrictive.status, 0, `child with private TMPDIR and umask 077 failed: ${restrictive.stderr}`);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('a restrictive caller umask is not loosened and missing POSIX identity fails closed', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-privacy-mask-'));
  try {
    const code = `const h=require(process.argv[1]); process.umask(0o277); const leaf=h.prepareCaptureDir(process.argv[2]); if(process.umask()!==0o277 || (require('node:fs').statSync(leaf).mode&0o777)!==0o500) process.exit(2); process.getuid=undefined; try { h.prepareCaptureDir(process.argv[2]+'-second'); process.exit(3); } catch(e) { if(!/소유자/.test(e.message)) process.exit(4); }`;
    const result = spawnSync(process.execPath, ['-e', code, HELPER, path.join(parent, 'run')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('event-card historical source never replaces a previous baseline pointer', () => {
  const source = read('scripts/web-event-card-a2-audit.cjs');
  assert.match(source, /before', 'source\.json'[\s\S]*?flag: 'wx'/);
  assert.match(source, /defaultCaptureDir\(`event-card-a2-\$\{runStamp\(\)\}`\), 'after'/, 'each standalone baseline must live under the same unique run parent as its after evidence');
});

test('web audit refuses unsafe evidence before starting its isolated fixture', () => {
  const source = read('scripts/web-audit.cjs');
  const main = source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('prepareCaptureDir(captureDir)') >= 0);
  assert.ok(main.indexOf('prepareCaptureDir(captureDir)') < main.indexOf('startAuditFixture()'));
});

test('private base must be owner-private and is never repaired', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-base-test-'));
  const { assertPrivateBase } = require(HELPER);
  try {
    const base = path.join(parent, 'base');
    fs.mkdirSync(base, { mode: 0o700 });
    assert.doesNotThrow(() => assertPrivateBase(base));
    // The inherited TMPDIR may itself be private and owned by this user.
    // Simulate a different effective UID against our exact owned fixture so
    // the ownership check is exercised independently of TMPDIR and modes.
    const getuid = process.getuid;
    try {
      const owner = fs.statSync(base).uid;
      process.getuid = () => owner + 1;
      assert.throws(() => assertPrivateBase(base), /안전하지 않은 캡처 기본 경로/);
      assert.equal(fs.statSync(base).mode & 0o777, 0o700);
    } finally {
      process.getuid = getuid;
    }
    fs.chmodSync(base, 0o755); // Exact synthetic fixture only, not an existing evidence path.
    assert.throws(() => assertPrivateBase(base), /안전하지 않은 캡처 기본 경로/);
    assert.equal(fs.statSync(base).mode & 0o777, 0o755);
    const link = path.join(parent, 'link');
    fs.symlinkSync(base, link);
    assert.throws(() => assertPrivateBase(link), /안전하지 않은 캡처 기본 경로/);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('hardlinked-out capture files stay closed', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-privacy-test-'));
  try {
    const work = path.join(parent, 'w3');
    fs.mkdirSync(work, { mode: 0o700 });
    const result = runChild('hardlink-exposure', work);
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.controlMode, '666', 'control proves the ambient-000 hazard is real');
    assert.equal(summary.shotMode, '600', 'helper umask keeps Playwright-style writes 0600 under umask 000');
    assert.equal(summary.linkedMode, '600', 'a hardlink out of the leaf stays group/other-closed');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('real browser screenshots land 0600 under umask 000 when a browser exists', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-privacy-test-'));
  try {
    const work = path.join(parent, 'w4');
    fs.mkdirSync(work, { mode: 0o700 });
    const result = runChild('real-browser', work);
    if (result.status === 42) {
      t.skip('no usable browser in this environment; fake-capture tests above cover the mode contract');
      return;
    }
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    const summary = JSON.parse(result.stdout);
    assert.equal(fs.statSync(path.join(summary.leaf, 'real.png')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(summary.leaf, 'real.pdf')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('wired entrypoints: helper use, fresh stamped defaults, env overrides, namespaces', () => {
  const helperSource = read('scripts/capture-dir.cjs');
  assert.doesNotMatch(helperSource, /chmodSync/, 'no chmod after mkdir via an untrusted path');
  assert.match(helperSource, /process\.umask\(current \| 0o077\)/, 'process umask tightened without loosening caller restrictions');
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.cjs'));
  const wired = files.filter((f) => {
    if (f === 'capture-dir.cjs' || f === 'verify-system.cjs') return false;
    const t = read(`scripts/${f}`);
    return /eventouch-captures|EVENTOUCH_CAPTURE_ROOT|CAPTURE_DIR/.test(t);
  });
  assert.ok(wired.length >= 30, `expected 30+ capture entrypoints, got ${wired.length}`);
  const needsOverride = new Set([
    'web-design-review-audit.cjs',
    'web-task-first-final-states.cjs',
    'web-task-flow-audit.cjs',
    'web-task-flow-journey-audit.cjs',
  ]);
  for (const f of wired) {
    const t = read(`scripts/${f}`);
    assert.ok(t.includes("require('./capture-dir.cjs')"), `${f} must use the capture helper`);
    assert.ok(!/mkdirSync\([^)]*recursive/.test(t), `${f} must not use recursive mkdir`);
    assert.ok(!/TMPDIR = '\/tmp\/opencode'/.test(t), `${f} must not redirect temp into the shared tree`);
    // Fresh per run: a run stamp, a per-run uuid, or a per-run id in every default.
    for (const line of t.split('\n')) {
      if (line.includes('defaultCaptureDir(') && !line.includes('require')) {
        assert.ok(/runStamp\(\)|randomUUID\(\)|runId/.test(line), `${f} default must be fresh per run: ${line.trim()}`);
      }
    }
    if (needsOverride.has(f)) {
      assert.ok(/process\.env\.CAPTURE_DIR/.test(t), `${f} hardcoded default must offer a CAPTURE_DIR override`);
    }
  }
  // Explicit root namespacing preserved for contracts and operators.
  const namespaces = {
    'scripts/web-console-audit.cjs': 'console-unification',
    'scripts/web-event-close-journey-audit.cjs': 'round-close/linear',
    'scripts/web-task-first-final-states.cjs': 'task-first-final/after',
    'scripts/web-round-next-handoff-audit.cjs': 'round-next/after',
    'scripts/web-round-next-media-audit.cjs': 'round-next/before',
    'scripts/web-workbench-audit.cjs': 'workbench',
    'scripts/web-white-product-audit.cjs': 'white-product',
    'scripts/web-customer-ux-audit.cjs': 'customer-ux',
    'scripts/web-account-recovery-audit.cjs': 'account-recovery',
    'scripts/web-preparation-journey-audit.cjs': 'round-preparation',
    'scripts/web-event-card-a2-audit.cjs': 'event-card-a2',
    'scripts/web-hanwool-audit.cjs': 'hanwool-real',
    'scripts/web-import-audit.cjs': 'import-real',
    'scripts/web-retirement-audit.cjs': 'retirement-real',
    'scripts/web-theme-audit.cjs': 'theme-real',
    'scripts/web-audit.cjs': 'web-audit',
  };
  for (const [rel, ns] of Object.entries(namespaces)) {
    assert.ok(read(rel).includes(ns), `${rel} must keep the ${ns} namespace`);
  }
});

test('per-run private TMPDIR resolves before any fixture starts', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-privacy-test-'));
  try {
    const summaries = {};
    for (const [role, work] of [['tmpdir-default', 'w5'], ['tmpdir-explicit', 'w6']]) {
      const dir = path.join(parent, work);
      fs.mkdirSync(dir, { mode: 0o700 });
      const result = runChild(role, dir);
      assert.equal(result.status, 0, `${role} child failed: ${result.stderr}`);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.ok, true, `${role} child reported failure`);
      summaries[role] = summary;
    }
    assert.equal(summaries['tmpdir-default'].tmpdirEnv, summaries['tmpdir-default'].tmp, 'default TMPDIR is the run-private tmp dir');
    assert.equal(summaries['tmpdir-default'].osTmpdir, summaries['tmpdir-default'].tmpdirEnv, 'os.tmpdir follows the assigned TMPDIR');
    assert.equal(summaries['tmpdir-explicit'].keptExplicit, true, 'explicit safe TMPDIR is honored untouched');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('TMPDIR coordination is ordered and evidence listings exclude the tmp dir', () => {
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.cjs'));
  const coordinated = files.filter((f) => {
    if (f === 'capture-dir.cjs' || f === 'verify-system.cjs' || f === 'web-console-boundaries.cjs') return false;
    return read(`scripts/${f}`).includes('ensureRunTmpDir(');
  });
  // web-console-boundaries creates no temp of its own: it only screenshots
  // into the parent-provided dir, so it is the one deliberate exclusion.
  assert.ok(coordinated.length >= 35, `expected 35+ TMPDIR-coordinated entrypoints, got ${coordinated.length}`);
  const FX = /startApiHarness\(|startAuditFixture\(|startOwnedNext\(|startWebApiGateway\(|launchBrowser\(|chromium\.launch\(/;
  for (const f of coordinated) {
    const lines = read(`scripts/${f}`).split('\n');
    const isCode = (l) => {
      const s = l.trim();
      return s && !s.startsWith('//') && !s.startsWith('*') && !l.includes('require(');
    };
    // Units are col-0 blocks (functions, IIFEs, main). Fixture starts at
    // col 0 would run at require time and are banned outright.
    const unitOf = (idx) => {
      for (let i = idx; i >= 0; i -= 1) {
        const m = lines[i].match(/^(?:async function (\w+)|function (\w+)|const (\w+) =|\(async)/);
        if (m) return { def: m[1] || m[2] || m[3] || '(iife)', start: i };
      }
      return { def: '(top)', start: -1 };
    };
    for (let i = 0; i < lines.length; i += 1) {
      if (!isCode(lines[i]) || !FX.test(lines[i]) || /function /.test(lines[i])) continue;
      assert.ok(!/^\S/.test(lines[i]), `${f} must not start fixtures at require time: ${lines[i].trim().slice(0, 60)}`);
      const unit = unitOf(i);
      const tmpBefore = lines.slice(unit.start + 1, i).some((l) => isCode(l) && l.includes('ensureRunTmpDir('));
      if (tmpBefore) continue;
      // Delegated worker (e.g. runScenario): every call site must sit after
      // a TMPDIR line in its own unit.
      assert.ok(unit.def !== '(top)' && unit.def !== '(iife)', `${f} starts fixtures before any TMPDIR in ${unit.def}`);
      const callers = [];
      lines.forEach((l, j) => {
        if (isCode(l) && new RegExp(`\\b${unit.def}\\s*\\(`).test(l) && j !== unit.start) callers.push(j);
      });
      assert.ok(callers.length > 0, `${f}: ${unit.def} starts fixtures but is never called after TMPDIR`);
      for (const c of callers) {
        const cu = unitOf(c);
        const cTmp = lines.slice(cu.start + 1, c).some((l) => isCode(l) && l.includes('ensureRunTmpDir('));
        assert.ok(cTmp, `${f} calls ${unit.def} (line ${c + 1}) without a prior TMPDIR in ${cu.def}`);
      }
    }
  }
  const card = read('scripts/web-event-card-a2-audit.cjs');
  assert.match(card, /readdirSync\(OUT\)\.filter\(\(name\) => name !== 'tmp'\)/, 'event-card evidence listing must not claim the tmp dir as capture');
});

test('no script writes the same screenshot/PDF target twice in one run', () => {
  const findMatch = (text, open) => {
    let depth = 0, i = open, sq = false, dq = false, tpl = false, esc = false;
    const n = text.length;
    const skipTplExpr = (k) => {
      let bc = 1, j = k + 2, a = false, b = false, c = false, se = false;
      while (j < n && bc > 0) {
        const d = text[j];
        if (a) { if (se) se = false; else if (d === '\\') se = true; else if (d === "'") a = false; }
        else if (b) { if (se) se = false; else if (d === '\\') se = true; else if (d === '"') b = false; }
        else if (c) { if (se) se = false; else if (d === '\\') se = true; else if (d === '`') c = false; }
        else if (d === "'") a = true;
        else if (d === '"') b = true;
        else if (d === '`') c = true;
        else if (d === '{') bc += 1;
        else if (d === '}') bc -= 1;
        j += 1;
      }
      return j - 1;
    };
    while (i < n) {
      const c = text[i];
      if (sq) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === "'") sq = false; }
      else if (dq) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') dq = false; }
      else if (tpl) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '`') tpl = false;
        else if (c === '$' && text[i + 1] === '{') i = skipTplExpr(i);
      } else if (c === "'") sq = true;
      else if (c === '"') dq = true;
      else if (c === '`') tpl = true;
      else if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) return i; }
      i += 1;
    }
    throw new Error('unbalanced');
  };
  const firstArg = (text, callAt) => {
    const m = text.indexOf('path', callAt);
    const colon = text.indexOf(':', m);
    let i = colon + 1;
    while (i < text.length && ' \t\n'.includes(text[i])) i += 1;
    let depth = 0, sq = false, dq = false, tpl = false, esc = false, j = i;
    const n = text.length;
    const skipTplExpr = (k) => {
      let bc = 1, jj = k + 2, a = false, b = false, c = false, se = false;
      while (jj < n && bc > 0) {
        const d = text[jj];
        if (a) { if (se) se = false; else if (d === '\\') se = true; else if (d === "'") a = false; }
        else if (b) { if (se) se = false; else if (d === '\\') se = true; else if (d === '"') b = false; }
        else if (c) { if (se) se = false; else if (d === '\\') se = true; else if (d === '`') c = false; }
        else if (d === "'") a = true;
        else if (d === '"') b = true;
        else if (d === '`') c = true;
        else if (d === '{') bc += 1;
        else if (d === '}') bc -= 1;
        jj += 1;
      }
      return jj - 1;
    };
    while (j < n) {
      const c = text[j];
      if (sq) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === "'") sq = false; }
      else if (dq) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') dq = false; }
      else if (tpl) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '`') tpl = false;
        else if (c === '$' && text[j + 1] === '{') j = skipTplExpr(j);
      } else if (c === "'") sq = true;
      else if (c === '"') dq = true;
      else if (c === '`') tpl = true;
      else if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) { if (depth === 0) break; depth -= 1; }
      else if (c === ',' && depth === 0) break;
      j += 1;
    }
    return text.slice(i, j).trim();
  };
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.cjs'));
  for (const f of files) {
    if (f === 'capture-dir.cjs' || f === 'verify-system.cjs') continue;
    const t = read(`scripts/${f}`);
    const seen = new Map();
    for (const m of t.matchAll(/\b(?:screenshot|pdf)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      let close;
      try { close = findMatch(t, open); } catch { continue; }
      const call = t.slice(open + 1, close);
      if (!/\bpath\s*:/.test(call)) continue; // buffer-only capture, no file target
      const expr = firstArg(t, m.index);
      seen.set(expr, (seen.get(expr) || 0) + 1);
    }
    for (const [expr, count] of seen) {
      assert.equal(count, 1, `${f} writes the same capture target ${count}x in one run: ${expr.slice(0, 100)}`);
    }
  }
});

test('verify-system stays owned elsewhere (read-only guard)', () => {
  const vs = read('scripts/verify-system.cjs');
  assert.ok(!vs.includes('capture-dir'), 'verify-system must stay untouched by the standalone work');
  assert.ok(vs.includes('eventouch-private-'), 'verify-system private base intact');
});
