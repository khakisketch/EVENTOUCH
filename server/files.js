'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAccess } = require('./access');
const { createPublicEvents } = require('./public-events');
const { inspectImage } = require('./image-metadata');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TYPES = new Set(['image/png','image/jpeg','image/webp','application/pdf']);
const ID = /^[A-Za-z0-9_-]{1,160}$/;
function failure(status, message) { return Object.assign(new Error(message), {status}); }
function fileRef(row) {
  return {fileId:row.id, name:row.original_name, type:row.content_type, size:Number(row.size_bytes),
    ...(row.width_px && row.height_px ? {width:row.width_px,height:row.height_px} : {})};
}
function createFileService(database, { storageDir = process.env.STORAGE_DIR || path.join(__dirname,'../data/storage') } = {}) {
  const root = path.resolve(storageDir);
  async function authorize(client, account, eventId, command) {
    await createAccess(client).authorize({account,eventId,command});
    const event = await client.query('SELECT payload FROM events WHERE id=$1 FOR SHARE',[eventId]);
    if (!event.rowCount) throw failure(404,'행사를 찾을 수 없습니다');
    if (command === 'file.upload' && event.rows[0].payload.stage === 'ARCHIVED') throw failure(409,'보관된 행사는 수정할 수 없습니다');
  }
  async function upload({account,eventId,commandId,name,contentType,bytes}) {
    if (!ID.test(String(commandId || ''))) throw failure(400,'요청 ID를 확인하세요');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\/\\\x00-\x1f\x7f]/.test(name) || name.includes('..')) throw failure(400,'파일 이름을 확인하세요');
    if (!TYPES.has(contentType) || !Buffer.isBuffer(bytes) || !bytes.length) throw failure(400,'파일 형식을 확인하세요');
    if (bytes.length > MAX_FILE_BYTES) throw failure(413,'파일이 너무 큽니다');
    const dimensions = contentType.startsWith('image/') ? inspectImage(bytes,contentType) : null;
    if (contentType === 'application/pdf' && bytes.subarray(0,5).toString('ascii') !== '%PDF-') throw failure(400,'PDF 형식을 확인하세요');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([eventId,account && account.id,name,contentType])).update(bytes).digest('hex');
    let ownedPath;
    try {
      return await database.transaction(async client => {
        await authorize(client,account,eventId,'file.upload');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[commandId]);
        const receipt = await client.query('SELECT event_id,actor_id,result FROM command_receipts WHERE command_id=$1',[commandId]);
        if (receipt.rowCount) {
          const r = receipt.rows[0];
          if (r.event_id !== eventId || r.actor_id !== account.id || r.result.command !== 'file.upload' || r.result.fingerprint !== fingerprint) throw failure(409,'요청 ID가 다른 업로드에 사용되었습니다');
          return {file:r.result.file,replayed:true};
        }
        const id = `file-${crypto.randomUUID()}`;
        await fs.mkdir(root,{recursive:true});
        ownedPath = path.join(root,id);
        await fs.writeFile(ownedPath,bytes,{flag:'wx',mode:0o600});
        const row = await client.query(`INSERT INTO stored_files (id,event_id,storage_key,original_name,content_type,size_bytes,created_by,width_px,height_px)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [id,eventId,id,name,contentType,bytes.length,account.id,dimensions && dimensions.width,dimensions && dimensions.height]);
        const file = fileRef(row.rows[0]);
        await client.query('INSERT INTO command_receipts (command_id,event_id,actor_id,result) VALUES ($1,$2,$3,$4::jsonb)',
          [commandId,eventId,account.id,JSON.stringify({command:'file.upload',fingerprint,file})]);
        return {file,replayed:false};
      });
    } catch (error) {
      if (ownedPath) await fs.unlink(ownedPath).catch(() => {});
      throw error;
    }
  }
  // Ticket-authorized attendee upload (currently the photo feature). The
  // ticket bearer comes from the attendee link; the file is scoped to the
  // participant and to the photo feature limits.
  async function uploadGuest({slug,token,commandId,name,contentType,bytes}) {
    if (!ID.test(String(commandId || ''))) throw failure(400,'요청 ID를 확인하세요');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\/\\\x00-\x1f\x7f]/.test(name) || name.includes('..')) throw failure(400,'파일 이름을 확인하세요');
    if (!['image/png','image/jpeg','image/webp'].includes(contentType)) throw failure(400,'사진 형식을 확인하세요');
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw failure(400,'사진 형식을 확인하세요');
    if (bytes.length > 600000) throw failure(413,'600KB 이하 사진을 올려주세요');
    const projection = await createPublicEvents(database).loadTicket(String(slug || ''),String(token || ''));
    if (!projection) throw failure(401,'티켓 링크를 확인하세요');
    const { event, participant } = projection;
    if (!Array.isArray(event.features) || !event.features.includes('photo')) throw failure(403,'사진 기능을 사용하지 않습니다');
    if (!participant || String(participant.status).toUpperCase() !== 'APPROVED') throw failure(403,'참가 확정 후 사진을 공유할 수 있습니다');
    if (!['READY','LIVE','ENDED'].includes(String(event.stage || '').toUpperCase())) throw failure(409,'현재 사진을 공유할 수 없습니다');
    const eventId = String(event.id);
    const dimensions = inspectImage(bytes,contentType);
    const actorId = String(participant.id);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([eventId,`participant:${actorId}`,name,contentType])).update(bytes).digest('hex');
    let ownedPath;
    try {
      return await database.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[commandId]);
        const receipt = await client.query('SELECT event_id,actor_id,result FROM command_receipts WHERE command_id=$1',[commandId]);
        if (receipt.rowCount) {
          const r = receipt.rows[0];
          if (String(r.event_id) !== eventId || r.actor_id != null || r.result.command !== 'file.upload.guest' || r.result.participantId !== actorId || r.result.fingerprint !== fingerprint) throw failure(409,'요청 ID가 다른 업로드에 사용되었습니다');
          return {file:r.result.file,replayed:true};
        }
        const id = `file-${crypto.randomUUID()}`;
        await fs.mkdir(root,{recursive:true});
        ownedPath = path.join(root,id);
        await fs.writeFile(ownedPath,bytes,{flag:'wx',mode:0o600});
        const row = await client.query(`INSERT INTO stored_files (id,event_id,storage_key,original_name,content_type,size_bytes,created_by,width_px,height_px)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [id,eventId,id,name,contentType,bytes.length,null,dimensions && dimensions.width,dimensions && dimensions.height]);
        const file = fileRef(row.rows[0]);
        await client.query('INSERT INTO command_receipts (command_id,event_id,actor_id,result) VALUES ($1,$2,$3,$4::jsonb)',
          [commandId,eventId,null,JSON.stringify({command:'file.upload.guest',fingerprint,participantId:actorId,file})]);
        return {file,replayed:false};
      });
    } catch (error) {
      if (ownedPath) await fs.unlink(ownedPath).catch(() => {});
      throw error;
    }
  }
  async function stored(eventId,fileId) {
    if (!ID.test(String(fileId || ''))) throw failure(404,'파일을 찾을 수 없습니다');
    const row = (await database.query('SELECT * FROM stored_files WHERE id=$1 AND event_id=$2',[fileId,eventId])).rows[0];
    if (!row) throw failure(404,'파일을 찾을 수 없습니다');
    const absolutePath = path.resolve(root,row.storage_key);
    if (!absolutePath.startsWith(root+path.sep)) throw failure(404,'파일을 찾을 수 없습니다');
    try { const stat = await fs.stat(absolutePath); if (!stat.isFile() || stat.size !== Number(row.size_bytes)) throw new Error(); }
    catch { throw failure(404,'파일을 찾을 수 없습니다'); }
    return {...fileRef(row),absolutePath};
  }
  async function readOperator({account,eventId,fileId}) {
    await authorize(database,account,eventId,'file.read');
    return stored(eventId,fileId);
  }
  // Organization-level client files (logos, registration documents). The
  // access check carries no event, so only AGENCY passes — the same rule as
  // the client records themselves. Files are capped at 600KB like the other
  // operator-side consumers; throughput files do not need 8MB.
  const CLIENT_TYPES = new Set(['image/png','image/jpeg','image/webp','application/pdf']);
  const MAX_CLIENT_FILE_BYTES = 600000;
  async function authorizeAgency(client, account) {
    await createAccess(client).authorize({ account, command: 'file.upload' });
    if (!account || !account.id) throw failure(401, '로그인이 필요합니다');
    const current = await client.query('SELECT role, active FROM accounts WHERE id = $1 LIMIT 1', [account.id]);
    if (!current.rows[0] || current.rows[0].active !== true || current.rows[0].role !== 'AGENCY') {
      throw failure(403, '고객사 관리 권한을 확인하세요');
    }
  }
  async function uploadClientFile({account,clientId,commandId,name,contentType,bytes}) {
    if (!ID.test(String(commandId || ''))) throw failure(400,'요청 ID를 확인하세요');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\/\\\x00-\x1f\x7f]/.test(name) || name.includes('..')) throw failure(400,'파일 이름을 확인하세요');
    if (!CLIENT_TYPES.has(contentType) || !Buffer.isBuffer(bytes) || !bytes.length) throw failure(400,'파일 형식을 확인하세요');
    if (bytes.length > MAX_CLIENT_FILE_BYTES) throw failure(413,'600KB 이하 파일을 올려주세요');
    const dimensions = contentType.startsWith('image/') ? inspectImage(bytes,contentType) : null;
    if (contentType === 'application/pdf' && bytes.subarray(0,5).toString('ascii') !== '%PDF-') throw failure(400,'PDF 형식을 확인하세요');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([`client:${clientId}`,account && account.id,name,contentType])).update(bytes).digest('hex');
    let ownedPath;
    try {
      return await database.transaction(async client => {
        await authorizeAgency(client,account);
        const target = await client.query('SELECT id FROM clients WHERE id=$1 LIMIT 1 FOR SHARE',[String(clientId || '')]);
        if (!target.rowCount) throw failure(404,'고객사를 찾을 수 없습니다');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[commandId]);
        const receipt = await client.query('SELECT actor_id,result FROM command_receipts WHERE command_id=$1',[commandId]);
        if (receipt.rowCount) {
          const r = receipt.rows[0];
          if (r.actor_id !== account.id || r.result.command !== 'clientfile.upload' || r.result.fingerprint !== fingerprint) throw failure(409,'요청 ID가 다른 업로드에 사용되었습니다');
          return {file:r.result.file,replayed:true};
        }
        const id = `file-${crypto.randomUUID()}`;
        await fs.mkdir(root,{recursive:true});
        ownedPath = path.join(root,id);
        await fs.writeFile(ownedPath,bytes,{flag:'wx',mode:0o600});
        const row = await client.query(`INSERT INTO stored_files (id,event_id,client_id,storage_key,original_name,content_type,size_bytes,created_by,width_px,height_px)
          VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [id,String(clientId),id,name,contentType,bytes.length,account.id,dimensions && dimensions.width,dimensions && dimensions.height]);
        const file = fileRef(row.rows[0]);
        await client.query('INSERT INTO command_receipts (command_id,event_id,actor_id,result) VALUES ($1,NULL,$2,$3::jsonb)',
          [commandId,account.id,JSON.stringify({command:'clientfile.upload',fingerprint,file})]);
        return {file,replayed:false};
      });
    } catch (error) {
      if (ownedPath) await fs.unlink(ownedPath).catch(() => {});
      throw error;
    }
  }
  async function readClientFile({account,clientId,fileId}) {
    if (!ID.test(String(fileId || ''))) throw failure(404,'파일을 찾을 수 없습니다');
    const row = (await database.query('SELECT * FROM stored_files WHERE id=$1 AND client_id=$2',[fileId,String(clientId || '')])).rows[0];
    if (!row) throw failure(404,'파일을 찾을 수 없습니다');
    await database.transaction(async client => { await authorizeAgency(client,account); });
    const absolutePath = path.resolve(root,row.storage_key);
    if (!absolutePath.startsWith(root+path.sep)) throw failure(404,'파일을 찾을 수 없습니다');
    try { const stat = await fs.stat(absolutePath); if (!stat.isFile() || stat.size !== Number(row.size_bytes)) throw new Error(); }
    catch { throw failure(404,'파일을 찾을 수 없습니다'); }
    return {...fileRef(row),absolutePath};
  }
  async function readPublic({slug,fileId}) {
    const projection = await createPublicEvents(database).loadPublicEvent(slug);
    if (!projection) throw failure(404,'파일을 찾을 수 없습니다');
    const ws = projection.workspace;
    const refs = [ws.branding.logo,ws.branding.keyvisual,
      ...ws.program.map(p => p.attachment), ...ws.photos.map(p => p.image),
      ...(ws.boothMap && ws.boothMap.published ? [ws.boothMap.published.image] : [])];
    if (!refs.some(ref => ref && ref.fileId === fileId)) throw failure(404,'파일을 찾을 수 없습니다');
    return stored(projection.event.id,fileId);
  }
  return {upload,uploadGuest,uploadClientFile,readOperator,readPublic,readClientFile};
}
module.exports = {createFileService, MAX_FILE_BYTES};
