'use strict';

// Consistent backup of the EVENTOUCH PostgreSQL database and file storage.
//
//   node scripts/backup.cjs                      # compose project "eventouch"
//   node scripts/backup.cjs --project staging    # another compose project
//   node scripts/backup.cjs --verify             # rehearse a restore afterwards
//   node scripts/backup.cjs --database-url 'postgres://...' --storage-dir ./data/storage
//
// Default output: backups/eventouch-<UTC timestamp>/ with database.dump,
// storage.tar.gz and manifest.json (checksums, migrations, row counts).
// The directory contains personal data; keep it off the repository and give
// it the same access controls as the database itself. This script is
// read-only against the source database and storage volume.
//
// --verify creates a temporary database inside the same compose db service,
// restores the dump into it, compares every recorded row count and migration
// version, extracts the storage archive to a temporary directory and compares
// every file hash, then drops the temporary database. It never writes to the
// source database or the source storage volume.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const lib = require('./backup-lib.cjs');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');

const HELP = `
사용법:
  node scripts/backup.cjs [옵션]

옵션:
  --project <이름>          docker compose 프로젝트 (기본: eventouch)
  --out <경로>              백업 디렉터리 (기본: backups/eventouch-<UTC시각>)
  --storage-volume <이름>   파일 볼륨 (기본: <project>_etko-storage)
  --skip-storage            DB만 백업
  --verify                  임시 DB·임시 디렉터리로 복원 리허설
  --force                   기존 출력 디렉터리를 덮어씀
  --database-url <주소>     compose 없이 호스트 pg_dump 사용 (--verify 불가)
  --storage-dir <경로>      compose 없이 호스트 디렉터리 사용
  --help
`;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function hostTool(name) {
  try {
    const { stdout } = await execFileAsync(name, ['--version']);
    return String(stdout).trim().split('\n')[0];
  } catch {
    lib.fail(`${name}을(를) 찾을 수 없습니다. PostgreSQL 클라이언트를 설치하거나 compose 모드를 사용하세요`);
  }
}

async function prepareOutDirectory(directory, force) {
  const absolute = path.resolve(directory);
  if (fs.existsSync(absolute)) {
    const entries = await fsp.readdir(absolute);
    if (entries.length && !force) {
      lib.fail(`출력 디렉터리가 비어 있지 않습니다: ${absolute} (--force로 덮어쓰기)`);
    }
  }
  await fsp.mkdir(absolute, { recursive: true, mode: 0o700 });
  await fsp.chmod(absolute, 0o700);
  return absolute;
}

async function hostStorageHashes(directory) {
  return lib.hashTree(directory);
}

async function hostArchiveStorage(directory, outDirectory) {
  await execFileAsync('tar', ['-C', directory, '-czf', path.join(outDirectory, lib.BACKUP_STORAGE), '.']);
  return path.join(outDirectory, lib.BACKUP_STORAGE);
}

async function readHostCounts(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString });
  try {
    const counts = {};
    for (const table of lib.COUNT_TABLES) {
      const result = await pool.query(`SELECT count(*)::text AS value FROM ${table}`);
      counts[table] = Number(result.rows[0].value);
    }
    const migrations = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const version = await pool.query('SHOW server_version');
    return {
      counts,
      migrations: migrations.rows.map((row) => row.version),
      serverVersion: String(version.rows[0].server_version || '').trim(),
    };
  } finally {
    await pool.end();
  }
}

async function composeBackup(options) {
  const project = options.project;
  await lib.assertComposeDb(project);
  const { user, database } = await lib.composeDatabaseCredentials(project);
  const storageVolume = options.storageVolume || `${project}_etko-storage`;
  if (!options.skipStorage) await lib.assertVolume(storageVolume);

  lib.log(`compose 프로젝트 '${project}' · DB '${database}'`);
  const countsBefore = await lib.readCounts(project, user, database);
  const migrations = await lib.readMigrations(project, user, database);
  const serverVersion = await lib.databaseVersion(project, user, database);

  const outDirectory = await prepareOutDirectory(
    options.out || path.join(ROOT, 'backups', `${project}-${timestamp()}`),
    options.force,
  );

  const databaseFile = path.join(outDirectory, lib.BACKUP_DB);
  await lib.dumpDatabase(project, user, database, databaseFile);
  lib.log(`DB 덤프 완료 (${await lib.statSize(databaseFile)} bytes)`);
  // pg_dump is transactional, but counting before the dump and verifying
  // later breaks when writes land between the two reads. Re-read after the
  // dump; a stable pair is a meaningful rehearsal check, an unstable pair is
  // reported instead of producing a false failure.
  const counts = await lib.readCounts(project, user, database);
  const countsStable = lib.sameCounts(countsBefore, counts).length === 0;
  if (!countsStable) lib.log('백업 중 데이터 변경 감지: 행 수는 백업 종료 시점 참고값으로 기록합니다');

  let storage = { file: null, bytes: 0, sha256: null, files: [] };
  if (!options.skipStorage) {
    const files = await lib.storageHashes(storageVolume);
    const storageFile = await lib.archiveStorage(storageVolume, outDirectory);
    storage = {
      file: path.basename(storageFile),
      bytes: await lib.statSize(storageFile),
      sha256: await lib.sha256File(storageFile),
      files,
    };
    lib.log(`파일 보관소 완료 (${files.length} files, ${storage.bytes} bytes)`);
  }

  const manifest = {
    format: lib.FORMAT,
    createdAt: new Date().toISOString(),
    source: {
      project,
      database,
      postgres: serverVersion,
      migrations,
    },
    counts,
    countsStable,
    database: {
      file: lib.BACKUP_DB,
      bytes: await lib.statSize(databaseFile),
      sha256: await lib.sha256File(databaseFile),
    },
    storage,
  };
  const manifestPath = path.join(outDirectory, lib.MANIFEST);
  await fsp.writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(`${manifestPath}.tmp`, manifestPath);
  lib.log(`매니페스트: ${manifestPath}`);

  if (options.verify) await verifyComposeBackup(project, user, database, outDirectory, manifest);

  lib.log(`백업 완료: ${outDirectory}`);
  return { outDirectory, manifest };
}

async function verifyComposeBackup(project, user, database, outDirectory, manifest) {
  const scratch = lib.identifier(
    `restore_check_${database}_${Date.now().toString(36)}`.slice(0, 60),
    '임시 DB 이름',
  );
  lib.log(`복원 리허설 시작: 임시 DB ${scratch}`);
  await lib.compose(project, ['exec', '-T', 'db', 'createdb', '-U', user, scratch]);
  try {
    await lib.restoreDatabase(project, user, scratch, path.join(outDirectory, manifest.database.file));
    const restoredCounts = await lib.readCounts(project, user, scratch);
    const restoredMigrations = await lib.readMigrations(project, user, scratch);
    if (manifest.countsStable === false) {
      lib.log('백업 중 쓰기가 있어 행 수 비교를 건너뜁니다 (복원·마이그레이션·파일 검사는 계속)');
    } else {
      const countDifferences = lib.sameCounts(manifest.counts, restoredCounts);
      if (countDifferences.length) {
        lib.fail(`복원 후 행 수가 다릅니다:\n${countDifferences.join('\n')}`);
      }
    }
    if (restoredMigrations.join('\n') !== manifest.source.migrations.join('\n')) {
      lib.fail('복원 후 마이그레이션 버전이 다릅니다');
    }
    lib.log(`DB 복원 일치: ${Object.keys(restoredCounts).length} tables, ${restoredMigrations.length} migrations`);

    if (manifest.storage.file) {
      const temporary = await lib.tempDirectory('eventouch-restore-storage-');
      try {
        await lib.extractStorage(path.join(outDirectory, manifest.storage.file), temporary);
        const restoredFiles = await lib.hashTree(temporary);
        const fileDifferences = lib.sameHashes(manifest.storage.files, restoredFiles);
        if (fileDifferences.length) {
          lib.fail(`복원 후 파일이 다릅니다:\n${fileDifferences.join('\n')}`);
        }
        lib.log(`파일 복원 일치: ${restoredFiles.length} files`);
      } finally {
        await fsp.rm(temporary, { recursive: true, force: true });
      }
    }
    lib.log('복원 리허설 통과');
  } finally {
    await lib.compose(project, ['exec', '-T', 'db', 'dropdb', '-U', user, '--if-exists', scratch])
      .catch((error) => lib.log(`임시 DB 정리 실패: ${error.message}`));
  }
}

async function hostBackup(options) {
  if (!options.databaseUrl) lib.fail('--database-url 또는 --project가 필요합니다');
  if (options.verify) lib.fail('--verify는 compose 모드에서만 지원합니다');
  const pgDump = await hostTool('pg_dump');
  const before = await readHostCounts(options.databaseUrl);
  const outDirectory = await prepareOutDirectory(
    options.out || path.join(ROOT, 'backups', `eventouch-${timestamp()}`),
    options.force,
  );

  const databaseFile = path.join(outDirectory, lib.BACKUP_DB);
  await execFileAsync('pg_dump', [
    '--dbname', options.databaseUrl, '--format=custom', '--no-owner', '--no-privileges',
    '--file', databaseFile,
  ], { maxBuffer: 1024 * 1024 });
  await fsp.chmod(databaseFile, 0o600);
  lib.log(`DB 덤프 완료 (${await lib.statSize(databaseFile)} bytes)`);

  const after = await readHostCounts(options.databaseUrl);
  const countsStable = lib.sameCounts(before.counts, after.counts).length === 0;
  if (!countsStable) lib.log('백업 중 데이터 변경 감지: 행 수는 백업 종료 시점 참고값으로 기록합니다');
  const { counts, migrations, serverVersion } = after;

  let storage = { file: null, bytes: 0, sha256: null, files: [] };
  if (!options.skipStorage) {
    if (!options.storageDir) lib.fail('--storage-dir가 필요합니다 (또는 --skip-storage)');
    const files = await hostStorageHashes(options.storageDir);
    const storageFile = await hostArchiveStorage(options.storageDir, outDirectory);
    storage = {
      file: path.basename(storageFile),
      bytes: await lib.statSize(storageFile),
      sha256: await lib.sha256File(storageFile),
      files,
    };
    lib.log(`파일 보관소 완료 (${files.length} files, ${storage.bytes} bytes)`);
  }

  const manifest = {
    format: lib.FORMAT,
    createdAt: new Date().toISOString(),
    source: { project: null, database: '(database-url)', postgres: serverVersion, migrations },
    counts,
    countsStable,
    database: {
      file: lib.BACKUP_DB,
      bytes: await lib.statSize(databaseFile),
      sha256: await lib.sha256File(databaseFile),
    },
    storage,
    tools: { pgDump },
  };
  const manifestPath = path.join(outDirectory, lib.MANIFEST);
  await fsp.writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(`${manifestPath}.tmp`, manifestPath);
  lib.log(`백업 완료: ${outDirectory}`);
  return { outDirectory, manifest };
}

async function main() {
  const options = lib.parseArgs(process.argv.slice(2), {
    project: process.env.COMPOSE_PROJECT_NAME || 'eventouch',
    out: '',
    storageVolume: '',
    databaseUrl: '',
    storageDir: '',
    verify: false,
    force: false,
    skipStorage: false,
    help: false,
  });
  if (options.help) {
    process.stdout.write(HELP.trimStart());
    return;
  }
  if (options.databaseUrl) await hostBackup(options);
  else await composeBackup(options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[backup] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
