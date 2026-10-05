'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fileFor(dataDir, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('저장소 이름을 확인하세요');
  return path.join(dataDir, safe + '.json');
}

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    read(name) {
      const file = fileFor(dataDir, name);
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        return {};
      }
    },
    write(name, value) {
      const file = fileFor(dataDir, name);
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, file);
    },
    update(name, fn) {
      const store = this;
      const next = fn(store.read(name));
      store.write(name, next);
      return next;
    },
  };
}

module.exports = { openStore };
