'use strict';

// Secure private fresh output for standalone audit entrypoints.
//
// Standalone audits (npm run web:*:audit / audit:usability) write screenshots,
// PDFs and verification JSON outside the repo. The retired pattern
//   fs.mkdirSync(OUT, { recursive: true })
// reuses a fixed directory under the shared /tmp/opencode tree, inherits the
// process umask, and follows symlinks: a prior run's evidence is silently
// overwritten and a pre-planted symlink redirects captures outside the
// intended tree. Playwright screenshots additionally ignore any mode argument
// (0666 & ~umask: 0644 normally, 0666 under umask 000), so leaf privacy alone
// leaves file modes permissive and hardlink-out exfiltration readable.
//
// Two-entry model (call each at most in its own role):
// - prepareCaptureDir(dir): run roots ONLY. Fails when the leaf already exists
//   (file, dir, or symlink): existing evidence is never overwritten. Announces
//   the fresh path on stderr so the operator can inspect it afterwards.
// - ensureCaptureDir(dir): repeated in-run use ONLY (per-screenshot helpers,
//   in-loop captures, sub-namespaces of the same run). Opens or creates the
//   leaf without ever overwriting or re-permissioning existing entries: an
//   existing leaf must already be a private owned directory, else it throws.
//   Never use it to (re)open a previous run's directory as a fresh root.
//
// Both coordinate with scripts/verify-system.cjs (owned separately):
// - same private per-user base: /tmp/eventouch-private-<uid> (the
//   verify-system defaultBase). Standalone defaults use
//   defaultCaptureDir(`<namespace>-${runStamp()}`) under that base, never
//   /tmp/opencode: every standalone invocation gets a fresh unique leaf, so
//   back-to-back reruns never collide.
// - same parent trust rule: every ancestor must be an owned-or-root directory
//   without group/other write bits, except the sticky root-owned /tmp itself.
//   Existing directories are never chmodded; a non-conforming ancestor throws.
// - the private base itself must be owned and 0700 (not 0755). Explicit roots
//   elsewhere (e.g. CI's EVENTOUCH_CAPTURE_ROOT) keep the generic write-bit
//   rule.
// - refuses repo-inside paths and the base dirs themselves (callers name a
//   leaf run dir), refuses any symlink component (lstat, best-effort TOCTOU).
// - leaf creation is a single mkdir(0700) with no follow-up chmod: 0700 masked
//   by ANY umask stays group/other-free, while chmod-after-mkdir would follow
//   a swapped-in symlink. The leaf is verified afterwards (not a symlink, a
//   directory, no group/other bits).
// - both entries pin the process umask to 077 first (contained: umask is
//   per-process, the parent is unaffected). Screenshots and PDFs written by
//   Playwright therefore land 0600 even under an ambient umask of 000, and so
//   does every JSON the audit writes. Callers must not rely on a permissive
//   umask for anything else in the same process.
// - callers under verify-system already receive a fresh private
//   EVENTOUCH_CAPTURE_ROOT; namespacing (path.join(root, '<audit>')) plus
//   these helpers keeps each audit fresh without touching the shared root.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function defaultPrivateBase() {
  // Mirrors the verify-system defaultBase so standalone runs land in the same
  // private per-user tree without relying on the shared /tmp/opencode tree.
  return path.join('/tmp', `eventouch-private-${process.getuid?.() ?? 'user'}`);
}

let cachedStamp = null;
function runStamp() {
  // One stamp per process: every default leaf of this invocation shares it,
  // the next invocation mints a new one. Timestamp (sortable) + pid (unique
  // across concurrent runs in the same second).
  if (!cachedStamp) {
    const iso = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    cachedStamp = `${iso}-${process.pid}`;
  }
  return cachedStamp;
}

function defaultCaptureDir(...segments) {
  return path.join(defaultPrivateBase(), 'eventouch-captures', ...segments);
}

function isInsideRepo(resolved) {
  return resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`);
}

function ensurePrivateUmask() {
  // Screenshots/PDFs take no mode argument (0666 & ~umask). Pinning the
  // process umask to 077 makes every file this process (and its children)
  // creates 0600-or-tighter, whatever the ambient umask was. Per-process
  // state: the invoking shell and parent keep their own umask.
  const current = process.umask();
  process.umask(current | 0o077);
}

function ensurePrivateBase() {
  // The default base itself must be owned and 0700, not merely
  // non-group-writable. Missing entries are created private; existing entries
  // are verified, never chmodded.
  const base = defaultPrivateBase();
  const parts = base.split(path.sep).filter(Boolean);
  let current = path.parse(base).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`안전하지 않은 캡처 상위 경로: ${current}. 링크나 공유 쓰기 경로 대신 본인 소유의 비공개 상위 디렉터리 아래 새 경로를 지정하세요. 기존 증거 권한은 자동 변경하지 않습니다.`);
    }
    const uid = process.getuid?.();
    const trustedOwner = uid === undefined || stat.uid === uid || stat.uid === 0;
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !trustedOwner || ((stat.mode & 0o022) && !stickyRoot)) {
      throw new Error(`안전하지 않은 캡처 상위 경로: ${current}. 링크나 공유 쓰기 경로 대신 본인 소유의 비공개 상위 디렉터리 아래 새 경로를 지정하세요. 기존 증거 권한은 자동 변경하지 않습니다.`);
    }
  }
  assertPrivateBase(base);
  return base;
}

function assertPrivateBase(base) {
  const leaf = fs.lstatSync(base);
  const uid = process.getuid?.();
  const owned = uid !== undefined && leaf.uid === uid;
  if (leaf.isSymbolicLink() || !leaf.isDirectory() || !owned || (leaf.mode & 0o077) !== 0 || (leaf.mode & 0o300) !== 0o300) {
    throw new Error(`안전하지 않은 캡처 기본 경로: ${base}. 본인 소유의 0700 디렉터리여야 합니다. 기존 권한은 자동 변경하지 않습니다.`);
  }
}

function assertTrustedParentChain(parent, label) {
  // Generic rule for explicit roots outside the private base: walk each
  // ancestor, create missing entries private, then require owned-or-root
  // without group/other write (sticky root-owned /tmp excepted). Never
  // chmods existing entries.
  const parts = parent.split(path.sep).filter(Boolean);
  let current = path.parse(parent).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`안전하지 않은 캡처 상위 경로: ${label}. 링크나 공유 쓰기 경로 대신 본인 소유의 비공개 상위 디렉터리 아래 새 경로를 지정하세요. 기존 증거 권한은 자동 변경하지 않습니다.`);
    }
    const uid = process.getuid?.();
    const trustedOwner = uid === undefined || stat.uid === uid || stat.uid === 0;
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !trustedOwner || ((stat.mode & 0o022) && !stickyRoot)) {
      throw new Error(`안전하지 않은 캡처 상위 경로: ${current}. 링크나 공유 쓰기 경로 대신 본인 소유의 비공개 상위 디렉터리 아래 새 경로를 지정하세요. 기존 증거 권한은 자동 변경하지 않습니다.`);
    }
  }
}

function resolveAndGuard(dir) {
  if (typeof process.getuid !== 'function') throw new Error('캡처 경로 소유자를 확인할 수 없습니다. POSIX 사용자 환경에서 실행하세요.');
  const label = String(dir);
  const resolved = path.resolve(label);
  if (isInsideRepo(resolved)) {
    throw new Error(`캡처 경로는 저장소 밖이어야 합니다: ${resolved}`);
  }
  return resolved;
}

function guardLeafPreexists(resolved) {
  const leafPre = (() => {
    try {
      return fs.lstatSync(resolved);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (leafPre && leafPre.isSymbolicLink()) {
    throw new Error(`안전하지 않은 캡처 경로(심볼릭 링크): ${resolved}`);
  }
  return leafPre;
}

function guardParents(resolved) {
  // The private base gets the strict owned-0700 rule; explicit roots
  // elsewhere keep the generic trust rule (so CI's explicit root works).
  if (resolved === defaultPrivateBase() || resolved.startsWith(`${defaultPrivateBase()}${path.sep}`)) {
    ensurePrivateBase();
  }
  assertTrustedParentChain(path.dirname(resolved), resolved);
  const parentStat = fs.lstatSync(path.dirname(resolved));
  if (parentStat.isSymbolicLink()) {
    throw new Error(`안전하지 않은 캡처 상위 경로: ${resolved}. 링크나 공유 쓰기 경로 대신 본인 소유의 비공개 상위 디렉터리 아래 새 경로를 지정하세요. 기존 증거 권한은 자동 변경하지 않습니다.`);
  }
}

function verifyLeaf(resolved) {
  const leaf = fs.lstatSync(resolved);
  if (leaf.isSymbolicLink() || !leaf.isDirectory() || leaf.uid !== process.getuid() || (leaf.mode & 0o077) !== 0) {
    throw new Error(`안전하지 않은 캡처 경로: ${resolved}`);
  }
  return leaf;
}

function announceCaptureDir(resolved) {
  // One clear stderr line per fresh run root so the operator can find the
  // evidence afterwards. stderr: piped/tee'd logs keep it and machine-parsed
  // stdout payloads stay intact.
  process.stderr.write(`[capture] output: ${resolved}\n`);
}

function assertUsableExplicitTmpDir(resolved) {
  // Operator-explicit TMPDIR: verify, never create/chmod/delete. The sticky
  // root-owned /tmp itself is usable (mkdtemp 0700 inside it stays private);
  // anything else must be an owned directory without group/other write bits
  // and not a symlink.
  if (typeof process.getuid !== 'function') throw new Error('TMPDIR 소유자를 확인할 수 없습니다. POSIX 사용자 환경에서 실행하세요.');
  if (isInsideRepo(resolved)) throw new Error(`TMPDIR은 저장소 밖이어야 합니다: ${resolved}`);
  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`명시된 TMPDIR이 존재하지 않습니다: ${resolved}. 디렉터리를 먼저 만들거나 비워 두어 실행별 사설 경로를 사용하세요.`);
    }
    throw error;
  }
  assertTrustedParentChain(path.dirname(resolved), resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`안전하지 않은 TMPDIR(심볼릭 링크): ${resolved}`);
  }
  const uid = process.getuid?.();
  const trustedOwner = stat.uid === uid || stat.uid === 0;
  const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (!stat.isDirectory() || !trustedOwner || ((stat.mode & 0o077) !== 0 && !stickyRoot)) {
    throw new Error(`안전하지 않은 TMPDIR: ${resolved}. 본인 소유의 비공개 디렉터리나 sticky 루트 임시 경로를 지정하세요. 기존 권한은 자동 변경하지 않습니다.`);
  }
}

function ensureRunTmpDir(runDir) {
  // Per-run private temp for the harness file store (uploaded fixture bytes)
  // and browser profiles (session cookies): both resolve os.tmpdir(), which
  // follows inherited TMPDIR. An operator-explicit TMPDIR outside the
  // known-shared /tmp/opencode tree is honored after verification (never
  // created, chmodded, or deleted here); otherwise a 0700 `tmp` under the
  // run's own fresh root is used and exported for this process and its
  // children. Must run after the run root is prepared and before any
  // fixture, gateway, Next child, or browser starts.
  ensurePrivateUmask();
  const inherited = (process.env.TMPDIR || '').trim();
  const shared = path.join('/tmp', 'opencode');
  const resolvedInherited = inherited ? path.resolve(inherited) : '';
  const unsafeShared = resolvedInherited === shared
    || resolvedInherited.startsWith(`${shared}${path.sep}`);
  if (resolvedInherited && !unsafeShared) {
    assertUsableExplicitTmpDir(resolvedInherited);
    return resolvedInherited;
  }
  const tmp = ensureCaptureDir(path.join(path.resolve(runDir), 'tmp'));
  process.env.TMPDIR = tmp;
  return tmp;
}

function prepareCaptureDir(dir) {
  // Run roots only: the leaf must not exist. Announces the fresh path.
  ensurePrivateUmask();
  const resolved = resolveAndGuard(dir);
  const base = defaultPrivateBase();
  const broad = new Set(['/tmp', base, path.join(base, 'eventouch-captures')]);
  if (broad.has(resolved)) {
    throw new Error(`캡처 경로는 공유 디렉터리가 아닌 실행별 하위 경로여야 합니다: ${resolved}`);
  }
  guardLeafPreexists(resolved);
  guardParents(resolved);
  try {
    // No follow-up chmod: 0700 masked by ANY umask stays group/other-free,
    // and chmod-after-mkdir would follow a swapped-in symlink.
    fs.mkdirSync(resolved, { mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new Error(`기존 캡처를 덮어쓰지 않습니다. 존재하지 않는 새 경로를 지정하세요: ${resolved}`);
    }
    throw error;
  }
  verifyLeaf(resolved);
  announceCaptureDir(resolved);
  return resolved;
}

function ensureCaptureDir(dir) {
  // Repeated in-run use only (per-screenshot helpers, in-loop captures,
  // sub-namespaces of the same run). Creates the leaf when missing; when it
  // already exists, verifies it is already a private owned directory and
  // changes nothing (no chmod of existing evidence, no overwrite).
  ensurePrivateUmask();
  const resolved = resolveAndGuard(dir);
  guardLeafPreexists(resolved);
  guardParents(resolved);
  let created = false;
  try {
    fs.mkdirSync(resolved, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  verifyLeaf(resolved);
  if (created) announceCaptureDir(resolved);
  return resolved;
}

module.exports = { defaultPrivateBase, defaultCaptureDir, runStamp, prepareCaptureDir, ensureCaptureDir, ensureRunTmpDir, assertPrivateBase };
