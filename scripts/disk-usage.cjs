'use strict';

// Disk usage of the filesystem holding a path, via POSIX `df -Pk` (same
// column layout on Linux and macOS). Read-only.
//
// Used by ops-readiness.cjs (--disk-path) and backup-schedule.cjs (the backup
// root) to warn at 80% used (2026-11-24 백업 결정).

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_USED_PERCENT = 80;

// Parses `df -Pk <path>` output: Filesystem 1024-blocks Used Available Capacity Mounted-on
function parseDf(stdout) {
  const line = String(stdout).trim().split('\n').slice(1).find((row) => row.trim());
  if (!line) throw new Error('df returned no rows');
  const columns = line.trim().split(/\s+/);
  // A filesystem name with spaces shifts columns left; read from the right.
  const capacity = columns[columns.length - 2];
  const availableKb = Number(columns[columns.length - 3]);
  const usedKb = Number(columns[columns.length - 4]);
  const percent = Number(String(capacity).replace('%', ''));
  if (!Number.isFinite(availableKb) || !Number.isFinite(usedKb) || !Number.isFinite(percent)) throw new Error('df output unparseable');
  return {
    freeBytes: availableKb * 1024,
    usedBytes: usedKb * 1024,
    usedPercent: percent,
    mount: columns[columns.length - 1],
  };
}

async function diskUsage(target) {
  const { stdout } = await execFileAsync('df', ['-Pk', target]);
  return parseDf(stdout);
}

module.exports = { diskUsage, parseDf, DEFAULT_MAX_USED_PERCENT };
