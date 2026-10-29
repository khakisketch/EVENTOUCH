'use strict';

// Restore an EVENTOUCH backup into a compose deployment.
//
//   node scripts/restore.cjs backups/eventouch-2026-10-17T... \
//     --project eventouch-restore --storage-volume eventouch-restore_etko-storage
//
// Safety rules:
//   - checksums are verified before anything is written;
//   - the source deployment (same project + same database) is refused unless
//     --force is given, so a rehearsal cannot overwrite live data by accident;
//   - a non-empty target database or storage location is refused unless
//     --force is given;
//   - the target database is dropped and recreated only with --force.
//
// The target compose db service must already be running. Start only `db`
// while restoring; the API applies no migrations during this step.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('./backup-lib.cjs');

const PROTECTED_DATABASES = new Set(['postgres', 'template0', 'template1']);

function log(message) {
  process.stdout.write(`[restore] ${message}\n`);
}

const HELP = `
사용법:
  node scripts/restore.cjs <백업 디렉터리> --project <대상 compose 프로젝트> [옵션]

옵션:
  --database <이름>         복원할 DB 이름 (기본: 백업의 원본 DB 이름)
  --storage-volume <이름>   복원할 파일 볼륨 (기본: 지정하지 않으면 파일 복원 생략)
  --storage-dir <경로>      파일을 호스트 디렉터리로 복원
  --force                   비어 있지 않은 대상 DB/파일을 지우고 복원
  --help
`;

async function databaseExists(project, user, database) {
  const output = await lib.compose(project, [
    'exec', '-T', 'db', 'psql', '-U', user, '-d', 'postgres', '-XAt',
    '-c', `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
  ]);
  return String(output).trim() === '1';
}

async function tableCount(project, user, database) {
  const output = await lib.compose(project, [
    'exec', '-T', 'db', 'psql', '-U', user, '-d', database, '-XAt',
    '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
  ]);
  return Number(String(output).trim());
}

async function ensureDatabase(project, user, database, force) {
  if (PROTECTED_DATABASES.has(database)) lib.fail(`시스템 DB '${database}'에는 복원할 수 없습니다`);
  if (await databaseExists(project, user, database)) {
    const tables = await tableCount(project, user, database);
    if (tables > 0) {
      if (!force) {
        lib.fail(`대상 DB '${database}'에 테이블이 ${tables}개 있습니다. 비우려면 --force를 명시하세요`);
      }
      log(`대상 DB '${database}'를 지우고 다시 만듭니다`);
      await lib.compose(project, [
        'exec', '-T', 'db', 'psql', '-U', user, '-d', 'postgres', '-XAt',
        '-c', `DROP DATABASE "${database}" WITH (FORCE)`,
      ]);
      await lib.compose(project, ['exec', '-T', 'db', 'createdb', '-U', user, database]);
    } else {
      log(`빈 대상 DB '${database}'를 사용합니다`);
    }
  } else {
    log(`대상 DB '${database}'를 만듭니다`);
    await lib.compose(project, ['exec', '-T', 'db', 'createdb', '-U', user, database]);
  }
}

async function clearVolume(volume) {
  await lib.docker([
    'run', '--rm', '-v', `${volume}:/data`, 'postgres:16-alpine',
    'sh', '-c', 'find /data -mindepth 1 -delete',
  ]);
}

async function extractVolume(volume, archive, directory) {
  await lib.docker([
    'run', '--rm',
    '-v', `${volume}:/data`,
    '-v', `${path.resolve(directory)}:/backup:ro`,
    'postgres:16-alpine',
    'tar', '-C', '/data', '-xzf', `/backup/${archive}`,
  ]);
}

async function clearDirectory(directory) {
  for (const entry of await fsp.readdir(directory)) {
    await fsp.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

// Everything that can be checked before the database is touched belongs here:
// a corrupt archive or an occupied storage target must fail while the target
// deployment is still untouched, not after a destructive DB restore.
async function assertArchiveReadable(file) {
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `tar exited ${code}`))));
  });
}

async function preflightStorage(options, directory, manifest) {
  if (!manifest.storage.file) {
    log('파일 백업이 없어 파일 복원을 건너뜁니다');
    return;
  }
  const archive = path.join(directory, manifest.storage.file);
  try {
    await assertArchiveReadable(archive);
  } catch (error) {
    lib.fail(`파일 백업을 읽을 수 없습니다: ${error.message}`);
  }
  if (options.storageVolume) {
    await lib.assertVolume(options.storageVolume);
    const current = await lib.storageHashes(options.storageVolume);
    if (current.length && !options.force) {
      lib.fail(`대상 볼륨 '${options.storageVolume}'에 파일이 ${current.length}개 있습니다. 비우려면 --force를 명시하세요`);
    }
    return;
  }
  if (options.storageDir) {
    const target = path.resolve(options.storageDir);
    await fsp.mkdir(target, { recursive: true, mode: 0o700 });
    const entries = await fsp.readdir(target);
    if (entries.length && !options.force) {
      lib.fail(`대상 디렉터리가 비어 있지 않습니다: ${target} (--force로 덮어쓰기)`);
    }
    return;
  }
  log('파일 복원 대상이 없어 건너뜁니다 (--storage-volume 또는 --storage-dir)');
}

async function restoreStorage(options, directory, manifest) {
  if (!manifest.storage.file) {
    log('파일 백업이 없어 파일 복원을 건너뜁니다');
    return;
  }
  if (options.storageVolume) {
    await lib.assertVolume(options.storageVolume);
    const current = await lib.storageHashes(options.storageVolume);
    if (current.length && !options.force) {
      lib.fail(`대상 볼륨 '${options.storageVolume}'에 파일이 ${current.length}개 있습니다. 비우려면 --force를 명시하세요`);
    }
    if (current.length) await clearVolume(options.storageVolume);
    await extractVolume(options.storageVolume, manifest.storage.file, directory);
    const restored = await lib.storageHashes(options.storageVolume);
    const differences = lib.sameHashes(manifest.storage.files, restored);
    if (differences.length) lib.fail(`파일 복원 후 해시가 다릅니다:\n${differences.join('\n')}`);
    log(`파일 복원 일치: ${restored.length} files`);
    return;
  }
  if (options.storageDir) {
    const target = path.resolve(options.storageDir);
    await fsp.mkdir(target, { recursive: true, mode: 0o700 });
    const entries = await fsp.readdir(target);
    if (entries.length && !options.force) {
      lib.fail(`대상 디렉터리가 비어 있지 않습니다: ${target} (--force로 덮어쓰기)`);
    }
    if (entries.length) await clearDirectory(target);
    await lib.extractStorage(path.join(directory, manifest.storage.file), target);
    const restored = await lib.hashTree(target);
    const differences = lib.sameHashes(manifest.storage.files, restored);
    if (differences.length) lib.fail(`파일 복원 후 해시가 다릅니다:\n${differences.join('\n')}`);
    log(`파일 복원 일치: ${restored.length} files`);
    return;
  }
  log('파일 복원 대상이 없어 건너뜁니다 (--storage-volume 또는 --storage-dir)');
}

async function main() {
  const options = lib.parseArgs(process.argv.slice(2), {
    project: '',
    database: '',
    storageVolume: '',
    storageDir: '',
    force: false,
    help: false,
  });
  if (options.help) {
    process.stdout.write(HELP.trimStart());
    return;
  }
  const directory = (options._ && options._[0]) || '';
  if (!directory) lib.fail('백업 디렉터리를 지정하세요 (--help 참고)');
  if (!options.project) lib.fail('복원 대상 compose 프로젝트를 --project로 지정하세요');

  const manifest = await lib.readManifest(directory);
  await lib.verifyChecksums(directory, manifest);
  log('백업 체크섬 확인 완료');
  await preflightStorage(options, directory, manifest);

  const database = lib.identifier(options.database || manifest.source.database, '대상 DB');
  const sameSource = options.project === manifest.source.project && database === manifest.source.database;
  if (sameSource && !options.force) {
    lib.fail('원본 배포본과 같은 프로젝트·DB입니다. 실제 복구가 아니라면 다른 프로젝트/DB를 쓰고, 맞다면 --force를 명시하세요');
  }

  await lib.assertComposeDb(options.project);
  const { user } = await lib.composeDatabaseCredentials(options.project);
  await ensureDatabase(options.project, user, database, options.force);
  await lib.restoreDatabase(options.project, user, database, path.join(directory, manifest.database.file));
  log('DB 복원 완료');

  const restoredCounts = await lib.readCounts(options.project, user, database, { tables: Object.keys(manifest.counts) });
  const restoredMigrations = await lib.readMigrations(options.project, user, database);
  const countDifferences = lib.sameCounts(manifest.counts, restoredCounts);
  if (countDifferences.length) lib.fail(`복원 후 행 수가 다릅니다:\n${countDifferences.join('\n')}`);
  if (restoredMigrations.join('\n') !== manifest.source.migrations.join('\n')) {
    lib.fail('복원 후 마이그레이션 버전이 다릅니다');
  }
  log(`DB 복원 일치: ${Object.keys(restoredCounts).length} tables, ${restoredMigrations.length} migrations`);

  await restoreStorage(options, directory, manifest);

  log('복원 완료. 다음 순서로 확인하세요:');
  log(`  1) docker compose -p ${options.project} up -d`);
  log('  2) /api/health 200 확인');
  log('  3) 로그인 → 행사·참가자·파일 1건 확인');
  log('  4) EVENTOUCH_PUBLIC_URL·COOKIE_SECURE가 대상 환경 값인지 확인');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[restore] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
