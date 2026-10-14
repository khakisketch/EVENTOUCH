'use strict';

// Domain APIs mirroring the ETKO feature semantics (Korean errors,
// forward-only status, scan classification, one-vote/answer rules).
// All mutations require an authenticated session + write grant.

const fs = require('node:fs');
const { sendJson, readJsonBody, failureMessage } = require('./http');
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

async function handleApi(req, res, store, urlPath, security = {}) {
  const { auth, access, state, publicEvents, participantCommands, operationsCommands, domainCommands, files } = security;
  const parts = urlPath.split('/').filter(Boolean);
  if (parts[0] !== 'api') return sendJson(res, 404, { error: '요청한 API를 찾을 수 없습니다' });

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
        const result = await participantCommands.signup({ slug, commandId: body.commandId, input: body });
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
