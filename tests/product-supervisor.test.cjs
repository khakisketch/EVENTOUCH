const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { supervise, checkPortFree } = require('../scripts/supervise.cjs');

// Focused runtime contract for the product supervisor (scripts/supervise.cjs
// + dev/start launchers). Pure Node on isolated loopback ports: no database,
// no Next build, no live services. Ports 18931+ are outside every other
// suite's range (API 8776, web 8777, header probe 18791).

const API_PORT = 18931;
const WEB_PORT = 18932;
const SIG_API_PORT = 18933;
const SIG_WEB_PORT = 18934;

function stubServerCode(port) {
  return `require('node:http').createServer((q,s)=>{s.end('ok')}).listen(${port},'127.0.0.1')`;
}

function health(url) {
  return fetch(url, { signal: AbortSignal.timeout(2000) }).then(async (res) => {
    await res.arrayBuffer();
    return res.status;
  });
}

async function assertPortClosed(port) {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }),
    /fetch failed|aborted/i,
    `port ${port} must have no listener left`
  );
}

test('an-occupied-port-fails-fast-without-spawning-anything', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(WEB_PORT, '127.0.0.1', resolve));
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'etko-sup-')), 'spawned');
  try {
    const code = await supervise({
      apiPort: API_PORT,
      webPort: WEB_PORT,
      apiHealth: `http://127.0.0.1:${API_PORT}/`,
      webHealth: `http://127.0.0.1:${WEB_PORT}/`,
      readyTimeoutMs: 5000,
      api: {
        label: 'api',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`],
        cwd: os.tmpdir(),
        env: process.env,
      },
      web: {
        label: 'web',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`],
        cwd: os.tmpdir(),
        env: process.env,
      },
    });
    assert.equal(code, 1);
    assert.equal(fs.existsSync(marker), false, 'no owned child may spawn when a port is taken');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('an-unexpected-child-exit-terminates-its-sibling-and-exits-nonzero', async () => {
  const code = await supervise({
    apiPort: API_PORT,
    webPort: WEB_PORT,
    apiHealth: `http://127.0.0.1:${API_PORT}/`,
    webHealth: `http://127.0.0.1:${WEB_PORT}/`,
    readyTimeoutMs: 15000,
    api: {
      label: 'api',
      command: process.execPath,
      args: ['-e', stubServerCode(API_PORT)],
      cwd: os.tmpdir(),
      env: process.env,
    },
    web: {
      label: 'web',
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>process.exit(3),500)'],
      cwd: os.tmpdir(),
      env: process.env,
    },
  });
  assert.equal(code, 3, 'the failing child exit code propagates');
  await assertPortClosed(API_PORT);
});

test('sigterm-forwards-to-owned-children-and-exits-zero', async () => {
  const driver = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'etko-supdrv-')), 'driver.cjs');
  fs.writeFileSync(
    driver,
    `const { supervise } = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'supervise.cjs'))});\n` +
      `(async () => {\n` +
      `  const code = await supervise({\n` +
      `    apiPort: ${SIG_API_PORT}, webPort: ${SIG_WEB_PORT},\n` +
      `    apiHealth: 'http://127.0.0.1:${SIG_API_PORT}/',\n` +
      `    webHealth: 'http://127.0.0.1:${SIG_WEB_PORT}/',\n` +
      `    readyTimeoutMs: 15000,\n` +
      `    api: { label: 'api', command: process.execPath,\n` +
      `      args: ['-e', ${JSON.stringify(stubServerCode(SIG_API_PORT))}],\n` +
      `      cwd: ${JSON.stringify(os.tmpdir())}, env: process.env },\n` +
      `    web: { label: 'web', command: process.execPath,\n` +
      `      args: ['-e', ${JSON.stringify(stubServerCode(SIG_WEB_PORT))}],\n` +
      `      cwd: ${JSON.stringify(os.tmpdir())}, env: process.env },\n` +
      `  });\n` +
      `  process.exitCode = code;\n` +
      `})().catch((e) => { process.stderr.write(String(e && e.message)); process.exitCode = 1; });\n`
  );
  const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  const deadline = Date.now() + 20000;
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (ready || Date.now() > deadline) {
          clearInterval(timer);
          if (ready) resolve();
          else reject(new Error(`supervisor never reported ready: ${output}`));
        }
      }, 100);
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('ready:')) ready = true;
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      child.once('error', (error) => {
        clearInterval(timer);
        reject(error);
      });
    });
    assert.equal(await health(`http://127.0.0.1:${SIG_API_PORT}/`), 200);
    assert.equal(await health(`http://127.0.0.1:${SIG_WEB_PORT}/`), 200);

    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    // 'exit' resolves with the code itself, not a pair.
    const code = await exited;
    assert.equal(code, 0, 'a user-initiated stop is not a failure');
    await assertPortClosed(SIG_API_PORT);
    await assertPortClosed(SIG_WEB_PORT);
  } finally {
    // Never orphan the driver on failure: a live child would wedge the file.
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(path.dirname(driver), { recursive: true, force: true });
  }
});

test('checkPortFree-resolves-on-a-free-port', async () => {
  await checkPortFree(18935);
});
