'use strict';

// Shared supervisor for the new-app-only runtime: one API child plus one Next
// child, owned by this process and nothing else.
//
// Contract (see scripts/dev-supervisor.cjs and scripts/start-supervisor.cjs):
//   - Preflight: both ports must be free before anything spawns. An occupied
//     port is an explicit nonzero exit, never a silent reuse of whoever is
//     already listening there.
//   - Fail-fast: a startup failure or an unexpected exit of either owned
//     child terminates the owned sibling and exits nonzero.
//   - Signals: SIGINT/SIGTERM are forwarded to the owned children only (no
//     broad kill); a user-initiated stop exits 0 once both children stop.
//   - Readiness: "ready" is printed only after the API health endpoint AND
//     the Next root both answer 200. Nothing reports success before that.
//   - Logging carries ports and URLs only — never environment values, so
//     credentials passed through the environment cannot leak into logs.
//
// This module is required by the launchers and by
// tests/product-supervisor.test.cjs. It spawns only what the caller passes.

const { spawn } = require('node:child_process');
const net = require('node:net');

function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => reject(error));
    probe.once('listening', () => {
      probe.close(() => resolve());
    });
    probe.listen(port, host);
  });
}

async function waitForOk(url, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        // Drain so keep-alive sockets do not pile up across polls.
        try {
          await res.arrayBuffer();
        } catch {
          // A 200 with an unreadable body still counts as reachable.
        }
        return;
      }
    } catch {
      // Not up yet; keep polling until the deadline.
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`did not become ready: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function supervise({ api, web, apiPort, webPort, apiHealth, webHealth, readyTimeoutMs = 120000 }) {
  for (const [label, port] of [['API', apiPort], ['web', webPort]]) {
    try {
      await checkPortFree(port);
    } catch (error) {
      const reason = error && error.code === 'EADDRINUSE' ? 'already in use' : (error && error.message) || error;
      process.stderr.write(
        `[supervisor] ${label} port ${port} is ${reason} — refusing to reuse an unknown listener.\n` +
          `[supervisor] Stop whatever owns port ${port} or set ${label === 'API' ? 'API_PORT' : 'WEB_PORT'} explicitly.\n`
      );
      return 1;
    }
  }

  let shuttingDown = false;
  let interrupted = false;
  const children = [];
  const exits = [];
  // Exit accounting rides the 'exit'/'close' events, never the polled
  // exitCode: a signal-stopped child keeps exitCode null (signalCode is set
  // instead), so polling exitCode would park the supervisor forever after a
  // SIGTERM shutdown — exactly when it must leave.
  let exitedCount = 0;
  let notifyExit = null;
  const bothExited = new Promise((resolve) => {
    notifyExit = () => {
      exitedCount += 1;
      if (children.length > 0 && exitedCount >= children.length) resolve();
    };
  });

  function launch({ label, command, args, cwd, env }) {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    } catch (error) {
      process.stderr.write(`[supervisor] failed to spawn ${label}: ${error && error.message}\n`);
      return null;
    }
    children.push({ label, child });
    let done = false;
    const markDone = () => {
      if (done) return;
      done = true;
      if (notifyExit) notifyExit();
    };
    child.once('error', (error) => {
      process.stderr.write(`[supervisor] ${label} startup failed: ${error && error.message}\n`);
      exits.push({ label, code: 1 });
      shutdown();
    });
    child.once('exit', (code, signal) => {
      markDone();
      if (shuttingDown) return;
      const how = signal ? `signal ${signal}` : `code ${code}`;
      process.stderr.write(`[supervisor] ${label} exited unexpectedly (${how}); stopping its sibling.\n`);
      exits.push({ label, code: typeof code === 'number' && code !== 0 ? code : 1 });
      shutdown();
    });
    // A spawn failure emits 'error' and may never emit 'exit'; 'close' always
    // follows, so it is the backstop that keeps the exit accounting exact.
    child.once('close', markDone);
    return child;
  }

  let stopTimer = null;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const { child } of children) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // The child already went away; the exit handler settles the rest.
        }
      }
    }
    // Owned children that ignore SIGTERM must not wedge the supervisor.
    stopTimer = setTimeout(() => {
      for (const { child } of children) {
        if (child.exitCode === null && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }, 5000);
    if (stopTimer.unref) stopTimer.unref();
  }

  const onSignal = (signal) => {
    interrupted = true;
    process.stderr.write(`[supervisor] received ${signal}; stopping owned children.\n`);
    shutdown();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const apiChild = launch(api);
  const webChild = launch(web);
  if (!apiChild || !webChild) {
    // A launch that threw synchronously never produces exit events, so it
    // counts as done here; spawned siblings still shut down below.
    if (!apiChild && notifyExit) notifyExit();
    if (!webChild && notifyExit) notifyExit();
    exits.push({ label: 'spawn', code: 1 });
    shutdown();
  }
  if (children.length === 0) return 1;

  // Readiness never blocks shutdown: a failing child still fails fast while
  // the polls are in flight, because shutdown() resolves the same wait. Each
  // poll races the exit accounting so a spawn failure cannot park the
  // supervisor inside a 120s health timeout with nothing running.
  let ready = false;
  const readiness = (async () => {
    try {
      await Promise.race([waitForOk(apiHealth, readyTimeoutMs), bothExited]);
      if (shuttingDown) return;
      await Promise.race([waitForOk(webHealth, readyTimeoutMs), bothExited]);
      if (shuttingDown) return;
      ready = true;
      process.stdout.write(`[supervisor] ready: api ${apiHealth} web ${webHealth}\n`);
    } catch (error) {
      if (shuttingDown) return;
      process.stderr.write(`[supervisor] startup failed: ${error && error.message}\n`);
      shutdown();
      exits.push({ label: 'readiness', code: 1 });
    }
  })();

  await Promise.race([bothExited, readiness.then(() => bothExited)]);
  await bothExited;
  if (stopTimer) clearTimeout(stopTimer);

  if (interrupted) return 0;
  if (!ready && exits.length === 0) exits.push({ label: 'supervisor', code: 1 });
  return exits.length > 0 ? exits[0].code : 0;
}

module.exports = { supervise, checkPortFree, waitForOk };
