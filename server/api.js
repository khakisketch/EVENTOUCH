'use strict';

// Domain APIs mirroring the ETKO feature semantics (Korean errors,
// forward-only status, scan classification, one-vote/answer rules).
// All mutations require an authenticated session + write grant.

const fs = require('node:fs');
const { sendJson, readJsonBody, failureMessage } = require('./http');
const { attendeeCookie } = require('./attendees');
const { EVIDENCE_SECTIONS } = require('./commands/event-evidence');
const {
  handleLegacyEvents,
  handleLegacyUpload,
  ensureLegacySeed,
  readEvents,
  agencySummary,
} = require('./legacy-events');

// Upload cap shared with the new files service path below; server/legacy-events.js
// carries the same value for the JSON fallback path.
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function text(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function err(res, status, message, field) {
  const body = { error: message };
  if (field) body.field = field;
  sendJson(res, status, body);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

// ---- auth gates (mirror requireWrite) ----

async function requireUser(auth, req) {
  const account = auth && await auth.sessionFromCookie(req.headers.cookie);
  if (!account) throw Object.assign(new Error('로그인이 필요합니다'), { status: 401 });
  return account;
}

function decodedSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    return null;
  }
}

function bearerToken(header) {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  return match ? match[1] : '';
}

function readRawBytes(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        rejected = true; chunks.length = 0;
        reject(Object.assign(new Error('파일이 너무 큽니다'),{status:413}));
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('업로드가 중단되었습니다'),{status:400})));
  });
}

// ---- operator-only photo archives (bulk export stays in the admin console) ----

// Archive entries never carry participant identities: names are generated
// server-side, flattened (no paths) and deterministically prefixed so two
// refs can never collide and no traversal is possible.
const ARCHIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ARCHIVE_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
// Defensible bounds for on-demand response work: large legitimate events may
// reach these limits, so the UI retains per-photo downloads as a fallback.
// Archives stream from disk with backpressure; these bounds cap file count,
// disk reads and response size rather than buffering the whole ZIP in memory.
const MAX_ARCHIVE_FILES = 1000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function archiveEntryName(prefix, index, type) {
  return `${prefix}-${String(index + 1).padStart(4, '0')}.${ARCHIVE_EXTENSION[type]}`;
}

// Streams a ZIP with fflate pass-through entries: each stored file is read
// from disk and pushed through compression straight into the response, so
// only one file (<=8MB) is ever buffered — never the whole archive.
// Downstream backpressure pauses the active file stream; a client disconnect
// stops the loop instead of compressing into the void.
async function streamPhotoArchive(req, res, security, { account, eventId, refs, prefix, filename }) {
  const { files } = security;
  // Resolve every ref before headers go out: same event (readOperator
  // scopes by event), image type only, totals for the 413 bounds. A missing
  // original fails the whole export before streaming so the operator never
  // mistakes a partial archive for a complete evidence bundle.
  const resolved = [];
  let totalBytes = 0;
  for (const ref of refs) {
    let file;
    try {
      file = await files.readOperator({ account, eventId, fileId: ref.fileId });
    } catch (error) {
      if (error && error.status === 404) {
        throw Object.assign(
          new Error('사진 원본 일부를 찾을 수 없어 ZIP을 만들지 못했습니다. 목록을 새로고침하거나 원본 상태를 확인하세요.'),
          { status: 409 }
        );
      }
      throw error;
    }
    if (!ARCHIVE_IMAGE_TYPES.has(file.type)) continue;
    totalBytes += Number(file.size) || 0;
    resolved.push({ name: archiveEntryName(prefix, resolved.length, file.type), absolutePath: file.absolutePath });
  }
  if (resolved.length > MAX_ARCHIVE_FILES || totalBytes > MAX_ARCHIVE_BYTES) {
    return err(res, 413, '사진 묶음이 1000장 또는 512MB 한도를 초과했습니다. 사진을 나누거나 개별 원본을 내려받으세요');
  }
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (!resolved.length) {
    res.end(Buffer.from(require('fflate').zipSync({})));
    return;
  }
  const { Zip, ZipPassThrough } = require('fflate');
  let aborted = false;
  let currentStream = null;
  res.on('close', () => {
    aborted = true;
    if (currentStream) currentStream.destroy();
  });
  const zip = new Zip((zipError, chunk, final) => {
    if (aborted) return;
    if (zipError) {
      res.destroy();
      return;
    }
    if (chunk && chunk.length) {
      if (!res.write(Buffer.from(chunk)) && currentStream) currentStream.pause();
    }
    if (final && !res.writableEnded) res.end();
  });
  res.on('drain', () => {
    if (currentStream && !aborted) currentStream.resume();
  });
  try {
    for (const entry of resolved) {
      if (aborted || res.destroyed) break;
      const pass = new ZipPassThrough(entry.name);
      zip.add(pass);
      await new Promise((passResolve, passReject) => {
        currentStream = fs.createReadStream(entry.absolutePath);
        currentStream.on('data', (data) => pass.push(data));
        currentStream.on('end', () => {
          pass.push(new Uint8Array(0), true);
          currentStream = null;
          passResolve();
        });
        currentStream.on('error', (streamError) => {
          currentStream = null;
          passReject(streamError);
        });
      });
    }
    if (!aborted) zip.end();
  } catch (error) {
    if (!aborted) res.destroy();
  } finally {
    currentStream = null;
  }
}

async function handleApi(req, res, store, urlPath, security = {}) {
  const { auth, access, state, publicEvents, participantCommands, operationsCommands, domainCommands, files, attendeeAccess, database } = security;
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] !== 'api') return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });

  // Attendee phone verification (slice 7a). Same-origin public endpoints;
  // the session cookie set here authorizes reads only, and codes never
  // leave the server except through the SMS transport.
  if (parts[1] === 'public' && parts[2] === 'events' && parts[4] === 'verification' &&
      parts.length === 6 && req.method === 'POST' && publicEvents && attendeeAccess) {
    const slug = decodedSegment(parts[3]);
    const action = decodedSegment(parts[5]);
    if (!slug || (action !== 'request' && action !== 'confirm')) {
      return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
    }
    res.setHeader('cache-control', 'no-store');
    let challengeBody = {};
    try {
      challengeBody = await readJsonBody(req);
    } catch (error) {
      return err(res, 400, error.message);
    }
    try {
      if (action === 'request') {
        const issued = await attendeeAccess.requestChallenge({
          eventRef: slug,
          phone: challengeBody.phone,
          purpose: challengeBody.purpose,
        });
        return sendJson(res, 200, { ok: true, challengeId: issued.challengeId, expiresAt: issued.expiresAt });
      }
      const confirmed = await attendeeAccess.confirmChallenge({
        eventRef: slug,
        phone: challengeBody.phone,
        code: challengeBody.code,
      });
      if (confirmed.kind === 'grant') {
        return sendJson(res, 200, { ok: true, grant: confirmed.grant, grantExpiresAt: confirmed.grantExpiresAt });
      }
      const maxAge = Math.max(60, Math.floor((Date.parse(confirmed.session.expiresAt) - Date.now()) / 1000));
      res.setHeader('set-cookie', attendeeCookie(confirmed.session.token, maxAge));
      return sendJson(res, 200, { ok: true, expiresAt: confirmed.session.expiresAt });
    } catch (error) {
      if (error && error.code === 'NEEDS_CONNECTION') return err(res, 503, error.message);
      return err(res, error.status || 500, failureMessage(error, '요청을 처리하지 못했습니다'), error.field);
    }
  }

  if (parts[1] === 'bootstrap') {
    res.setHeader('cache-control', 'no-store');
    if (parts.length !== 2 || req.method !== 'GET') return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
    if (!state) return err(res, 503, '데이터베이스를 사용할 수 없습니다');
    try {
      const account = await requireUser(auth, req);
      const projection = await state.loadBootstrap(account);
      return sendJson(res, 200, { state: projection });
    } catch (error) {
      return err(res, error.status || 500, failureMessage(error, '요청을 처리하지 못했습니다'));
    }
  }

  if (parts[1] === 'public') {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET' && parts[2] === 'events' && parts[4] === 'files' && parts.length === 6 && files) {
      try {
        const file = await files.readPublic({slug:decodedSegment(parts[3]),fileId:decodedSegment(parts[5])});
        res.writeHead(200, {'content-type':file.type,'content-length':file.size,'x-content-type-options':'nosniff'});
        fs.createReadStream(file.absolutePath).on('error', () => res.destroy()).pipe(res);
        return;
      } catch (error) { return err(res,error.status || 500,error.status ? error.message : '파일을 읽지 못했습니다'); }
    }
    if (req.method === 'POST' && parts[2] === 'events' && parts[4] === 'files' && parts.length === 5 && files) {
      res.setHeader('cache-control', 'no-store');
      try {
        const slug = decodedSegment(parts[3]);
        if (!slug) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
        const params = new URL(req.url, 'http://localhost').searchParams;
        const result = await files.uploadGuest({
          slug,
          token: bearerToken(req.headers.authorization),
          commandId: params.get('commandId'),
          name: params.get('name'),
          contentType: String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
          bytes: await readRawBytes(req),
        });
        return sendJson(res, result.replayed ? 200 : 201, { file: result.file });
      } catch (error) {
        return err(res, error.status || 500, failureMessage(error, '사진을 저장하지 못했습니다'));
      }
    }
    if (req.method !== 'GET' || !publicEvents) {
      return err(res, publicEvents ? 404 : 503, publicEvents ? '요청한 API를 찾을 수 없습니다' : '데이터베이스를 사용할 수 없습니다');
    }
    if (parts[2] !== 'events' || ![4, 5].includes(parts.length) || (parts.length === 5 && parts[4] !== 'ticket')) {
      return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
    }
    const slug = decodedSegment(parts[3]);
    if (!slug) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
    try {
      if (parts.length === 4) {
        const result = await publicEvents.loadPublicEvent(slug);
        if (!result) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
        return sendJson(res, 200, result);
      }
      const result = await publicEvents.loadTicket(slug, bearerToken(req.headers.authorization));
      if (!result && attendeeAccess) {
        // Same-browser return: a verified session restores the ticket
        // without the bearer. A photographed QR alone mints nothing.
        try {
          const session = await attendeeAccess.resolveSession(req.headers.cookie);
          if (session) {
            const granted = await publicEvents.loadSessionTicket(slug, session.grants);
            if (granted) return sendJson(res, 200, granted);
          }
        } catch (error) {
          // Fall through to the generic ticket failure below.
        }
      }
      if (!result) return err(res, 404, '티켓 링크를 확인할 수 없습니다');
      return sendJson(res, 200, result);
    } catch (error) {
      return err(res, error.status || 500, failureMessage(error, '요청을 처리하지 못했습니다'));
    }
  }

  // Raw octet uploads bypass the JSON body reader.
  if (parts[1] === 'events' && parts[3] === 'files' && files &&
      ((req.method === 'POST' && parts.length === 4) || (req.method === 'GET' && parts.length === 5))) {
    res.setHeader('cache-control','no-store');
    try {
      const account = await requireUser(auth,req);
      const eventId = decodedSegment(parts[2]);
      await access.authorize({account,eventId,command:req.method === 'POST' ? 'file.upload' : 'file.read'});
      if (req.method === 'GET') {
        const file = await files.readOperator({account,eventId,fileId:decodedSegment(parts[4])});
        res.writeHead(200,{'content-type':file.type,'content-length':file.size,'x-content-type-options':'nosniff'});
        fs.createReadStream(file.absolutePath).on('error', () => res.destroy()).pipe(res);
        return;
      }
      const params = new URL(req.url,'http://localhost').searchParams;
      const bytes = await readRawBytes(req);
      const result = await files.upload({account,eventId,commandId:params.get('commandId'),name:params.get('name'),
        contentType:String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),bytes});
      return sendJson(res,result.replayed ? 200 : 201,{file:result.file});
    } catch (error) { return err(res,error.status || 500,error.status ? error.message : '파일을 저장하지 못했습니다'); }
  }
  // Operator-only bulk photo export. No public archive exists: both routes
  // require the same grant as operator file read (AGENCY or event-member
  // MANAGER), so STAFF / unauthenticated / non-member requests stop here.
  if (req.method === 'GET' && parts[1] === 'events' && parts.length === 4 && files &&
      (parts[3] === 'attendee-photos.zip' || parts[3] === 'evidence-photos.zip')) {
    res.setHeader('cache-control', 'no-store');
    try {
      const account = await requireUser(auth, req);
      const eventId = decodedSegment(parts[2]);
      if (!eventId) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
      await access.authorize({ account, eventId, command: 'file.read' });
      const eventRow = await database.query('SELECT 1 FROM events WHERE id = $1 LIMIT 1', [eventId]);
      if (!eventRow.rowCount) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
      const workspaceRow = await database.query(
        'SELECT payload FROM event_workspaces WHERE event_id = $1 LIMIT 1', [eventId]
      );
      const workspace = (workspaceRow.rows[0] && workspaceRow.rows[0].payload) || {};
      if (parts[3] === 'attendee-photos.zip') {
        // APPROVED wall posts only: PENDING/HIDDEN, evidence photos and
        // attendee names/participant IDs are never included.
        const refs = (Array.isArray(workspace.photos) ? workspace.photos : [])
          .filter((photo) => photo && photo.status === 'APPROVED' &&
            photo.image && typeof photo.image.fileId === 'string')
          .map((photo) => ({ fileId: photo.image.fileId }));
        return await streamPhotoArchive(req, res, security, {
          account, eventId, refs, prefix: 'attendee-photo', filename: 'attendee-photos.zip',
        });
      }
      const section = new URL(req.url, 'http://localhost').searchParams.get('section') || '';
      if (!Object.hasOwn(EVIDENCE_SECTIONS, section)) {
        return err(res, 400, '증빙 사진 분류를 확인하세요', 'section');
      }
      const refs = (Array.isArray(workspace.evidencePhotos) ? workspace.evidencePhotos : [])
        .filter((photo) => photo && photo.section === section &&
          photo.image && typeof photo.image.fileId === 'string')
        .map((photo) => ({ fileId: photo.image.fileId }));
      const slug = section.toLowerCase().replace(/_/g, '-');
      return await streamPhotoArchive(req, res, security, {
        account, eventId, refs,
        prefix: `evidence-${slug}`,
        filename: `evidence-photos-${slug}.zip`,
      });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      return err(res, error.status || 500, error.status ? error.message : '사진 묶음을 만들지 못했습니다');
    }
  }
  // Organization-level client files (logos, registration documents). No
  // event scope, so only AGENCY passes; the file service enforces it.
  if (parts[1] === 'clients' && parts[3] === 'files' && files &&
      ((req.method === 'POST' && parts.length === 4) || (req.method === 'GET' && parts.length === 5))) {
    res.setHeader('cache-control','no-store');
    try {
      const account = await requireUser(auth,req);
      const clientId = decodedSegment(parts[2]);
      if (req.method === 'GET') {
        const file = await files.readClientFile({account,clientId,fileId:decodedSegment(parts[4])});
        res.writeHead(200,{'content-type':file.type,'content-length':file.size,'x-content-type-options':'nosniff'});
        fs.createReadStream(file.absolutePath).on('error', () => res.destroy()).pipe(res);
        return;
      }
      const params = new URL(req.url,'http://localhost').searchParams;
      const bytes = await readRawBytes(req);
      const result = await files.uploadClientFile({account,clientId,commandId:params.get('commandId'),name:params.get('name'),
        contentType:String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),bytes});
      return sendJson(res,result.replayed ? 200 : 201,{file:result.file});
    } catch (error) { return err(res,error.status || 500,error.status ? error.message : '파일을 저장하지 못했습니다'); }
  }
  if (req.method === 'POST' && parts[1] === 'events' && parts[3] === 'files' && parts.length === 4) {
    try {
      ensureLegacySeed(store);
      return await handleLegacyUpload(req, res, store, parts[2], req.url || urlPath, auth, access);
    } catch (e) {
      return err(res, e.status || 500, failureMessage(e, '요청을 처리하지 못했습니다'), e.field);
    }
  }

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return err(res, 400, e.message);
    }
  }

  try {
    if (parts[1] === 'events' && parts.length === 2 && req.method === 'GET' && state) {
      const account = await requireUser(auth, req);
      const projection = await state.loadBootstrap(account);
      res.setHeader('cache-control', 'no-store');
      return sendJson(res, 200, {
        events: projection.events,
        activeEventId: projection.activeEventId,
      });
    }

    if (parts[1] === 'events' && parts.length === 2 && req.method === 'POST' && state) {
      const account = await requireUser(auth, req);
      res.setHeader('cache-control', 'no-store');
      const result = await state.createEvent(account, body);
      return sendJson(res, result.replayed ? 200 : 201, { event: result.event });
    }

    if (parts[1] === 'clients' && parts.length === 2 && req.method === 'POST' && state) {
      const account = await requireUser(auth, req);
      res.setHeader('cache-control', 'no-store');
      try {
        const result = await state.saveClient(account, body);
        return sendJson(res, result.replayed ? 200 : 201, { client: result.client });
      } catch (error) {
        return err(res, error.status || 500, failureMessage(error, '고객사 정보를 저장하지 못했습니다'), error.field);
      }
    }

    if (parts[1] === 'accounts' && parts[3] === 'org-permissions' && parts.length === 4 && req.method === 'POST' && state) {
      const account = await requireUser(auth, req);
      res.setHeader('cache-control', 'no-store');
      try {
        const result = await state.saveOrgPermissions(account, decodedSegment(parts[2]), body);
        return sendJson(res, result.replayed ? 200 : 201, { account: result.account });
      } catch (error) {
        return err(res, error.status || 500, failureMessage(error, '조직 권한을 저장하지 못했습니다'), error.field);
      }
    }

    if (parts[1] === 'events' && parts.length === 4 && parts[3] === 'signup') {
      if (req.method !== 'POST') return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
      const slug = decodedSegment(parts[2]);
      if (!slug) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
      res.setHeader('cache-control', 'no-store');
      if (!participantCommands) {
        ensureLegacySeed(store);
        return await handleLegacyEvents(req, res, store, [slug, 'signup'], body, auth, access);
      }
      try {
        const result = await participantCommands.signup({
          slug,
          commandId: body.commandId,
          input: body,
          cookieHeader: req.headers.cookie,
        });
        if (result.session) {
          const maxAge = Math.max(60, Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000));
          res.setHeader('set-cookie', attendeeCookie(result.session.token, maxAge));
        }
        return sendJson(res, result.status, result.body);
      } catch (error) {
        return err(res, error.status || 500, failureMessage(error, '요청을 처리하지 못했습니다'), error.field);
      }
    }

    if (parts[1] === 'events' && parts.length === 4 && parts[3] === 'members' && req.method === 'POST' && state) {
      const account = await requireUser(auth, req);
      res.setHeader('cache-control', 'no-store');
      const eventId = decodedSegment(parts[2]);
      if (!eventId) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
      try {
        const result = await state.assignMember(account, eventId, body);
        return sendJson(res, result.replayed ? 200 : 201, { membership: result.membership });
      } catch (error) {
        return err(res, error.status || 500, failureMessage(error, '행사 권한을 저장하지 못했습니다'), error.field);
      }
    }

    if (parts[1] === 'events' && parts.length === 4 && parts[3] === 'commands') {
      if (req.method !== 'POST') return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
      res.setHeader('cache-control', 'no-store');
      if (!participantCommands) return err(res, 503, '데이터베이스를 사용할 수 없습니다');
      const eventId = decodedSegment(parts[2]);
      if (!eventId) return err(res, 404, '요청한 행사를 찾을 수 없습니다');
      const command = text(body.command || body.name);
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {};
      const commandId = body.commandId || payload.commandId;
      const assignmentId = body.assignmentId || payload.assignmentId;
      if (command === 'participant.self-update' || command === 'participant.cancel') {
        const result = await participantCommands.execute({
          eventId,
          commandId,
          command,
          payload,
          ticketToken: bearerToken(req.headers.authorization),
        });
        return sendJson(res, result.status, result.body);
      }

      const guestTicketToken = bearerToken(req.headers.authorization);
      if (command === 'booth.visit' && guestTicketToken) {
        if (!operationsCommands) return err(res, 503, '데이터베이스를 사용할 수 없습니다');
        const result = await operationsCommands.execute({
          eventId,
          commandId,
          command,
          payload,
          account: null,
          ticketToken: guestTicketToken,
        });
        return sendJson(res, result.status, result.body);
      }

      if (operationsCommands && operationsCommands.supports(command)) {
        const account = await requireUser(auth, req);
        const targetId = command === 'check.scan'
          ? payload.deskId || payload.targetId
          : command === 'booth.visit'
            ? payload.boothId || payload.targetId
            : payload.targetId;
        await access.authorize({ account, eventId, command, assignmentId, targetId });
        const result = await operationsCommands.execute({
          eventId,
          commandId,
          command,
          payload,
          account,
          assignmentId,
        });
        return sendJson(res, result.status, result.body);
      }

      if (domainCommands && domainCommands.supports(command)) {
        if (domainCommands.isGuestCommand(command)) {
          const result = await domainCommands.execute({
            eventId,
            commandId,
            command,
            payload,
            account: null,
            ticketToken: guestTicketToken,
          });
          return sendJson(res, result.status, result.body);
        }
        const account = await requireUser(auth, req);
        await access.authorize({ account, eventId, command: 'participants.write' });
        const result = await domainCommands.execute({
          eventId,
          commandId,
          command,
          payload,
          account,
        });
        return sendJson(res, result.status, result.body);
      }

      const account = await requireUser(auth, req);
      if (String(account.role).toUpperCase() === 'STAFF') {
        if (command !== 'participant.create') throw Object.assign(new Error('권한을 확인하세요'), { status: 403 });
        await access.authorize({
          account,
          eventId,
          command: 'participants.read',
          assignmentId,
        });
      } else {
        await access.authorize({ account, eventId, command: 'participants.write' });
      }
      const result = await participantCommands.execute({
        eventId,
        commandId,
        command,
        payload,
        account,
        assignmentId,
      });
      return sendJson(res, result.status, result.body);
    }

    if (!state) ensureLegacySeed(store);
    if (parts[1] === 'users' && parts.length === 2 && req.method === 'POST') {
      const me = await requireUser(auth, req);
      if (String(me.role).toUpperCase() !== 'AGENCY') {
        throw Object.assign(new Error('권한을 확인하세요'), { status: 403 });
      }
      return err(res, 410, '계정은 초대 수락 절차로 생성해야 합니다');
    }
    if (parts[1] === 'summary' && parts.length === 2 && req.method === 'GET') {
      const account = await requireUser(auth, req);
      if (state) return err(res, 410, '이전 저장 API는 종료되었습니다. 서버 행사 명령 API를 사용하세요');
      await access.authorize({ account, command: 'organization.summary' });
      return sendJson(res, 200, { summary: agencySummary(readEvents(store)) });
    }
    if (parts[1] === 'events') {
      if (state && !(req.method === 'GET' && parts.length === 5 && parts[3] === 'files')) {
        await requireUser(auth, req);
        return err(res, 410, '이전 저장 API는 종료되었습니다. 서버 행사 명령 API를 사용하세요');
      }
      return await handleLegacyEvents(req, res, store, parts.slice(2), body, auth, access);
    }
    return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });
  } catch (e) {
    return err(res, e.status || 500, failureMessage(e, '요청을 처리하지 못했습니다'), e.field);
  }
}

module.exports = { handleApi };
