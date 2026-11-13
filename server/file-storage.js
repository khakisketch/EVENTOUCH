'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const KEY = /^[A-Za-z0-9_-]{1,160}$/;
const MARKER = '.eventouch-storage-id';

function unavailable() {
  return Object.assign(new Error('파일 저장소를 사용할 수 없습니다'), {status:503,code:'STORAGE_UNAVAILABLE'});
}
function missing() { return Object.assign(new Error('파일을 찾을 수 없습니다'), {status:404}); }

// Immutable opaque objects. Authorization and metadata transactions stay in files.js.
function createFileStorage({ storageDir, env = process.env } = {}) {
  const mode = env.EVENTOUCH_STORAGE_MODE || 'local';
  const directory = storageDir || env.STORAGE_DIR;
  const identity = env.EVENTOUCH_STORAGE_ID || '';
  if (!['local','mounted'].includes(mode)) throw new Error('EVENTOUCH_STORAGE_MODE를 확인하세요');
  if (mode === 'mounted' && (!directory || !KEY.test(identity))) throw new Error('mounted STORAGE_DIR와 EVENTOUCH_STORAGE_ID를 설정하세요');
  const root = path.resolve(directory || path.join(__dirname,'../data/storage'));
  function objectPath(key) {
    if (typeof key !== 'string' || !KEY.test(key)) throw missing();
    return path.join(root,key);
  }
  async function ready() {
    try {
      if (mode === 'local') await fs.mkdir(root,{recursive:true,mode:0o700});
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
      if (mode === 'mounted') {
        const marker = await fs.open(path.join(root,MARKER),constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await marker.stat();
          if (!info.isFile() || info.size > 256 || (await marker.readFile('utf8')).trim() !== identity) throw unavailable();
        } finally { await marker.close(); }
      }
    } catch { throw unavailable(); }
  }
  async function open(key,size) {
    const absolute = objectPath(key);
    if (!Number.isSafeInteger(Number(size)) || Number(size) < 1) throw missing();
    await ready();
    let handle;
    try {
      handle = await fs.open(absolute,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== Number(size)) throw missing();
      return handle;
    } catch {
      await handle?.close().catch(()=>{});
      throw missing();
    }
  }
  async function inspect(key,size) { const handle = await open(key,size); await handle.close(); }
  async function readBytes(key,size) {
    const handle = await open(key,size);
    try {
      const bytes = Buffer.alloc(Number(size)+1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes,offset,bytes.length-offset,null);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset !== Number(size)) throw missing();
      return bytes.subarray(0,offset);
    } finally { await handle.close(); }
  }
  async function openReadStream(key,size) {
    const handle = await open(key,size);
    try { return handle.createReadStream({autoClose:true,start:0,end:Number(size)-1}); }
    catch (error) { await handle.close(); throw error; }
  }
  async function put(key,bytes) {
    const absolute = objectPath(key);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new TypeError('storage bytes are required');
    await ready();
    // Ownership starts only after exclusive open succeeds, never on EEXIST.
    const handle = await fs.open(absolute,'wx',0o600);
    const created = await handle.stat();
    async function rollback() {
      await ready();
      try {
        const current = await fs.lstat(absolute);
        if (current.isFile() && current.ino === created.ino && current.dev === created.dev) await fs.unlink(absolute);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(()=>{});
      await rollback().catch(()=>{});
      throw error;
    }
    await handle.close();
    return {rollback};
  }
  return {ready,put,inspect,readBytes,openReadStream};
}
module.exports = {createFileStorage};
