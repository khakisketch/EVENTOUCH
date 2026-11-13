'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createFileStorage} = require('../server/file-storage');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'eventouch-storage-port-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,storage:createFileStorage({storageDir:root,env:{}})};
}
test('opaque objects can be read as bytes or a stream without leaking physical paths',async t=>{
  const {storage}=await fixture(t); await storage.put('file-one',Buffer.from('bytes'));
  await storage.inspect('file-one',5);
  assert.equal((await storage.readBytes('file-one',5)).toString(),'bytes');
  const chunks=[]; for await(const chunk of await storage.openReadStream('file-one',5)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(),'bytes');
});
test('exclusive collision does not erase pre-existing bytes',async t=>{
  const {storage}=await fixture(t); const owned=await storage.put('file-one',Buffer.from('bytes'));
  await assert.rejects(storage.put('file-one',Buffer.from('other')));
  assert.equal((await storage.readBytes('file-one',5)).toString(),'bytes');
  await owned.rollback(); await assert.rejects(storage.inspect('file-one',5));
});
test('compensation cannot remove a replacement that it did not create',async t=>{
  const {root,storage}=await fixture(t); const owned=await storage.put('file-one',Buffer.from('bytes'));
  await fs.rename(path.join(root,'file-one'),path.join(root,'old'));
  await fs.writeFile(path.join(root,'file-one'),'new'); await owned.rollback();
  assert.equal(await fs.readFile(path.join(root,'file-one'),'utf8'),'new');
});
test('traversal, symlinks, directories and changed metadata are unreadable',async t=>{
  const {root,storage}=await fixture(t); await storage.put('file-one',Buffer.from('bytes'));
  await fs.symlink(path.join(root,'file-one'),path.join(root,'file-link'));
  await fs.mkdir(path.join(root,'file-dir'));
  for(const key of ['../file-one','/file-one','file-link','file-dir','']) await assert.rejects(storage.readBytes(key,5));
  await assert.rejects(storage.readBytes('file-one',4));
});
test('mounted storage never creates a missing mount directory',async t=>{
  const {root}=await fixture(t); const missing=path.join(root,'absent');
  const storage=createFileStorage({storageDir:missing,env:{EVENTOUCH_STORAGE_MODE:'mounted',EVENTOUCH_STORAGE_ID:'test-nas'}});
  await assert.rejects(storage.put('file-one',Buffer.from('bytes')),error=>error.status===503);
  await assert.rejects(fs.stat(missing),{code:'ENOENT'});
});
test('mount identity is rechecked for reads and writes after startup',async t=>{
  const {root}=await fixture(t); const marker=path.join(root,'.eventouch-storage-id');
  await fs.writeFile(marker,'test-nas\n');
  const storage=createFileStorage({storageDir:root,env:{EVENTOUCH_STORAGE_MODE:'mounted',EVENTOUCH_STORAGE_ID:'test-nas'}});
  await storage.ready(); await storage.put('file-one',Buffer.from('bytes'));
  await fs.unlink(marker);
  await assert.rejects(storage.readBytes('file-one',5),error=>error.status===503);
  await assert.rejects(storage.put('file-two',Buffer.from('bytes')),error=>error.status===503);
  assert.equal((await fs.readdir(root)).includes('file-two'),false);
});
test('mounted mode requires an explicit root and identity',()=>{
  assert.throws(()=>createFileStorage({env:{EVENTOUCH_STORAGE_MODE:'mounted'}}),/STORAGE/);
  assert.throws(()=>createFileStorage({storageDir:'/unused',env:{EVENTOUCH_STORAGE_MODE:'mounted'}}),/STORAGE/);
});
