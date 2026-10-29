'use strict';

// Solapi (솔라피) outbound messaging adapter.
//
// Written against the published API rather than against a live account, so the
// send path, payload shape and authentication are verifiable now and the only
// thing left for a real account is the credentials. See docs/INTEGRATIONS.md
// for the verification checklist that still requires a live key.
//
// Three properties of the Solapi API shape the design here:
//
//  1. Authentication is HMAC-SHA256 over date+salt with the API secret, not a
//     bearer token. A fresh salt is required per request and the clock must be
//     within 15 minutes of theirs.
//  2. POST /messages/v4/send-many/detail answers with what it *accepted*. A 2xx
//     does not mean a message reached a handset, so acceptance and delivery are
//     tracked as separate states and delivery is confirmed by polling.
//  3. Recipient numbers must be digits only. Product data stores them with
//     hyphens, so normalisation is mandatory or every send fails.

const crypto = require('node:crypto');

const API_HOST = 'https://api.solapi.com';
const SEND_PATH = '/messages/v4/send-many/detail';
const LIST_PATH = '/messages/v4/list';
const REQUEST_TIMEOUT_MS = 15000;

// One group read pulls at most this many pages; with the default 500-entry
// page that bounds a single campaign's id recovery to 10,000 entries.
const MAX_GROUP_PAGES = 20;

// Solapi's published limits: 90 bytes for SMS, 2000 for LMS. Korean characters
// count as two bytes, which is why the SMS limit is often quoted as 45 chars.
const SMS_MAX_BYTES = 90;
const LMS_MAX_BYTES = 2000;
const SUBJECT_MAX_BYTES = 40;

// Reasons a message can be rejected before it is ever registered.
const MESSAGE_TYPES = new Set(['SMS', 'LMS', 'MMS', 'ALIMTALK']);

// MMS carries a photo: Solapi documents JPG up to 200KB with text up to
// 2000 bytes. PNG/WebP uploads are rejected here rather than charged and
// failed provider-side, where the error would be harder to act on.
const MMS_IMAGE_MAX_BYTES = 200 * 1024;
const MMS_IMAGE_TYPES = new Set(['image/jpeg']);

function providerConfig(env = process.env) {
  const apiKey = String(env.SOLAPI_API_KEY || '').trim();
  const apiSecret = String(env.SOLAPI_API_SECRET || '').trim();
  const sender = String(env.SOLAPI_SENDER || '').trim();
  const kakaoPfId = String(env.SOLAPI_KAKAO_PFID || '').trim();
  const host = String(env.SOLAPI_API_HOST || API_HOST).trim().replace(/\/+$/, '');
  return {
    apiKey,
    apiSecret,
    sender,
    kakaoPfId,
    host,
    // Both halves are needed to sign a request; a key without its secret
    // cannot authenticate, and treating that as "connected" would mark
    // campaigns as sent while nothing could leave the server.
    configured: Boolean(apiKey && apiSecret && sender),
    // Alimtalk additionally needs a channel; without it those sends fall back
    // to plain text rather than failing.
    kakaoReady: Boolean(apiKey && apiSecret && sender && kakaoPfId),
  };
}

function messagingState(env = process.env) {
  const config = providerConfig(env);
  return {
    connected: config.configured,
    sender: config.configured ? config.sender : null,
    alimtalkReady: config.kakaoReady,
    provider: config.configured ? 'solapi' : null,
  };
}

// Product data stores numbers as "010-1234-5678" or with spaces; Solapi
// requires digits only.
function normalizePhone(value) {
  return String(value == null ? '' : value).replace(/[^0-9]/g, '');
}

// Korean text is two bytes per character in the encoding Solapi counts, so
// counting characters would badly under-estimate and turn a long notice into a
// failed SMS.
function messageBytes(text) {
  let bytes = 0;
  for (const char of String(text == null ? '' : text)) {
    bytes += char.codePointAt(0) > 0x7f ? 2 : 1;
  }
  return bytes;
}

// Which type Solapi will pick for plain text. Mirrors its documented
// autoTypeDetect so the operator can be told honestly what will be sent and
// charged for.
function resolveTextType(text) {
  const bytes = messageBytes(text);
  if (bytes > LMS_MAX_BYTES) return { type: null, reason: 'TOO_LONG', bytes };
  // A long notice would silently become a pricier LMS; that is the correct
  // outcome, but the caller should know it happened.
  return { type: bytes > SMS_MAX_BYTES ? 'LMS' : 'SMS', reason: null, bytes };
}

function typedFor(channel, text) {
  const requested = String(channel || '').toUpperCase();
  if (!MESSAGE_TYPES.has(requested)) return { type: null, reason: 'UNSUPPORTED_CHANNEL' };
  if (requested === 'ALIMTALK') return { type: 'ATA', reason: null, bytes: messageBytes(text) };
  if (requested === 'MMS') {
    const bytes = messageBytes(text);
    return bytes > LMS_MAX_BYTES
      ? { type: null, reason: 'TOO_LONG', bytes }
      : { type: 'MMS', reason: null, bytes };
  }
  if (requested === 'LMS') {
    const bytes = messageBytes(text);
    return bytes > LMS_MAX_BYTES
      ? { type: null, reason: 'TOO_LONG', bytes }
      : { type: 'LMS', reason: null, bytes };
  }
  return resolveTextType(text);
}

function signRequest({ apiKey, apiSecret, date, salt }) {
  return crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
}

function authorizationHeader(config, { now = new Date(), salt = crypto.randomBytes(16).toString('hex') } = {}) {
  const date = now.toISOString();
  const signature = signRequest({ apiKey: config.apiKey, apiSecret: config.apiSecret, date, salt });
  return `HMAC-SHA256 apiKey=${config.apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

// Solapi template placeholders are "#{이름}" while this product writes
// "{{이름}}". Keeping the mapping in one place means the product's own copy
// stays readable and the translation is testable.
function templateVariables(text, values) {
  const variables = {};
  for (const [name, value] of Object.entries(values || {})) {
    if (String(text || '').includes(`{{${name}}}`)) variables[`#{${name}}`] = String(value == null ? '' : value);
  }
  return variables;
}

function renderText(text, values) {
  return String(text || '').replace(/\{\{([^{}]*)\}\}/g, (whole, name) => {
    const value = (values || {})[name];
    return value == null ? whole : String(value);
  });
}

function createSolapiProvider(config, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, host = config.host } = {}) {
  const enabled = Boolean(config && config.configured);

  async function call(path, { method = 'GET', body, query } = {}) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, reason: 'NO_TRANSPORT', error: '서버에서 외부 요청을 보낼 수 없습니다' };
    }
    const url = new URL(host + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: authorizationHeader(config),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (err) {
        payload = null;
      }
      if (!response.ok) {
        // Absence is an explicit, checkable signal: only a 404 means the
        // supplier has no record under this id. Anything else (429, 5xx,
        // auth failures) says nothing about absence, so it keeps its own
        // reason and the caller must treat it as unknown rather than absent.
        const absent = response.status === 404;
        return {
          ok: false,
          reason: absent ? 'NOT_FOUND' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_REJECTED',
          status: response.status,
          retryAfterSeconds: Number(response.headers && response.headers.get && response.headers.get('x-retry-after')) || null,
          error: (payload && (payload.message || payload.errorCode)) || `공급사가 요청을 거부했습니다 (${response.status})`,
          payload,
        };
      }
      return { ok: true, payload };
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      return {
        ok: false,
        reason: aborted ? 'TIMEOUT' : 'TRANSPORT',
        error: aborted ? '공급사 응답이 지연되어 접수 여부를 확인하지 못했습니다' : '공급사에 연결하지 못했습니다',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Builds the body Solapi expects for one recipient: digits-only number,
  // explicit type, and kakaoOptions for alimtalk. Returns a rejection instead
  // of sending something that would be charged and then fail.
  function buildMessage({ channel, to, text, subject, variables, sender, pfId, templateId, imageId }) {
    const number = normalizePhone(to);
    if (!number) return { error: 'NO_RECIPIENT' };

    const planned = typedFor(channel, text);
    if (planned.reason === 'TOO_LONG') return { error: 'TOO_LONG', bytes: planned.bytes };
    if (planned.reason) return { error: planned.reason };

    const message = { to: number, from: normalizePhone(sender || config.sender), type: planned.type };

    if (planned.type === 'MMS') {
      // The photo is uploaded once per campaign (uploadImage) and referenced
      // here; sending an MMS without an image would be charged as a photo
      // message with nothing to show.
      if (!imageId) return { error: 'MMS_IMAGE_REQUIRED' };
      message.imageId = imageId;
      message.text = renderText(text, variables);
      const trimmed = String(subject || '').trim();
      if (trimmed) message.subject = trimmed.slice(0, 40);
      return { message, plannedType: planned.type, bytes: planned.bytes };
    }

    if (planned.type === 'ATA') {
      if (!(pfId || config.kakaoPfId) || !templateId) {
        // Without a channel and template there is nothing to send; falling
        // back to text is the caller's decision, not a silent substitution.
        return { error: 'ALIMTALK_NOT_CONFIGURED' };
      }
      message.kakaoOptions = {
        pfId: pfId || config.kakaoPfId,
        templateId,
        // Keep the operator's choice available so a failed alimtalk still
        // reaches the attendee by text.
        disableSms: false,
      };
      const rendered = renderText(text, variables);
      message.text = rendered;
      const mapped = templateVariables(text, variables);
      if (Object.keys(mapped).length) message.kakaoOptions.variables = mapped;
    } else {
      message.text = renderText(text, variables);
      if (planned.type === 'LMS') {
        const trimmed = String(subject || '').trim();
        if (trimmed) message.subject = trimmed.slice(0, 40);
      }
    }
    return { message, plannedType: planned.type, bytes: planned.bytes };
  }

  async function sendBatch(batch) {
    if (!enabled) return { accepted: false, reason: 'NOT_CONFIGURED' };
    const messages = [];
    const rejected = [];

    for (const item of batch) {
      const built = buildMessage(item);
      if (built.error) rejected.push({ participantId: item.participantId, reason: built.error, bytes: built.bytes });
      else messages.push({ ...built, participantId: item.participantId });
    }

    if (!messages.length) return { accepted: false, reason: 'ALL_REJECTED', rejected };

    const result = await call(SEND_PATH, {
      method: 'POST',
      body: { messages: messages.map((entry) => entry.message), showMessageList: true },
    });
    if (!result.ok) return { accepted: false, ...result, rejected };

    const failed = Array.isArray(result.payload.failedMessageList) ? result.payload.failedMessageList : [];
    const failedByNumber = new Map();
    for (const entry of failed) failedByNumber.set(normalizePhone(entry.to), entry);

    const registered = [];
    for (const entry of messages) {
      const number = entry.message.to;
      const failure = failedByNumber.get(number);
      if (failure) {
        registered.push({
          participantId: entry.participantId,
          accepted: false,
          reason: 'PROVIDER_REJECTED',
          error: failure.statusMessage || '공급사가 접수를 거부했습니다',
          statusCode: failure.statusCode || null,
        });
        continue;
      }
      registered.push({
        participantId: entry.participantId,
        accepted: true,
        type: entry.plannedType,
        bytes: entry.bytes,
      });
    }

    return {
      accepted: true,
      rejected,
      registered,
      groupId: (result.payload.groupInfo && result.payload.groupInfo.groupId) || null,
      // Acceptance is not delivery: the caller must poll before claiming SENT.
      deliveryUnconfirmed: true,
    };
  }

  // Message ids are needed to poll, and Solapi returns them through the list
  // endpoint keyed by group rather than in the send response, so they are read
  // back from the group.
  //
  // Pagination follows the documented contract: the response's nextKey is sent
  // back as the next request's startKey until it is absent. A cursor that does
  // not advance (same or repeated key) stops the loop instead of re-reading
  // the same page forever; at most MAX_GROUP_PAGES pages are read so one
  // campaign cannot pull an unbounded list into memory. Any stop with a next
  // page still pending is reported as truncated:true, so a caller can never
  // mistake a partial collection for a complete one.
  async function groupMessages(groupId, { limit = 500 } = {}) {
    const collected = {};
    const seenCursors = new Set(['']);
    let startKey = '';
    for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
      const result = await call(LIST_PATH, {
        query: { groupId, limit, ...(startKey ? { startKey } : {}) },
      });
      if (!result.ok) return { ok: false, ...result };
      const list = (result.payload && result.payload.messageList) || {};
      for (const [id, value] of Object.entries(list)) collected[id] = value;
      const next = result.payload && result.payload.nextKey;
      if (!next) return { ok: true, messages: collected };
      if (seenCursors.has(next)) return { ok: true, messages: collected, truncated: true, pages: page + 1 };
      seenCursors.add(next);
      startKey = next;
    }
    // The page cap stopped the walk with a cursor still pending: pages were
    // left unread, so this collection must not read as complete.
    return { ok: true, messages: collected, truncated: true, pages: MAX_GROUP_PAGES };
  }

  async function pollResults(messageIds, { limit = 500 } = {}) {
    if (!enabled) return { ok: false, reason: 'NOT_CONFIGURED' };
    const ids = [...new Set((messageIds || []).filter(Boolean))];
    if (!ids.length) return { ok: true, results: {} };

    // The list endpoint caps a response at 500 entries, so ids are polled in
    // batches rather than one call per message.
    const results = {};
    for (let offset = 0; offset < ids.length; offset += limit) {
      const slice = ids.slice(offset, offset + limit);
      const result = await call(LIST_PATH, { query: { messageIds: JSON.stringify(slice), limit } });
      if (!result.ok) return { ok: false, ...result };
      const list = (result.payload && result.payload.messageList) || {};
      for (const value of Object.values(list)) {
        results[value.messageId] = interpretStatus(value);
      }
    }
    return { ok: true, results };
  }

  // Uploads one campaign photo to Solapi storage and returns its image id
  // for MMS sends (POST /storage/v1/files, base64 per the vendor SDKs).
  // One upload serves the whole campaign; the id is referenced, never the
  // bytes, so recipient payloads stay small. JPEG magic bytes are checked
  // because the documented MMS contract is JPG — a PNG would be accepted
  // here and then fail provider-side with a worse error.
  async function uploadImage({ bytes, name }) {
    if (!enabled) return { ok: false, reason: 'NOT_CONFIGURED', error: '메시지 공급사가 연결되지 않았습니다' };
    const buffer = Buffer.isBuffer(bytes) ? bytes : null;
    if (!buffer || !buffer.length) return { ok: false, reason: 'NO_IMAGE', error: 'MMS 이미지를 확인하세요' };
    if (buffer.length > MMS_IMAGE_MAX_BYTES) {
      return { ok: false, reason: 'IMAGE_TOO_LARGE', error: 'MMS 이미지는 JPG 200KB 이하만 가능합니다', bytes: buffer.length };
    }
    if (!(buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)) {
      return { ok: false, reason: 'IMAGE_TYPE', error: 'MMS 이미지는 JPG 형식을 사용하세요' };
    }
    const result = await call('/storage/v1/files', {
      method: 'POST',
      body: {
        type: 'MMS',
        file: buffer.toString('base64'),
        ...(String(name || '').trim() ? { name: String(name).trim().slice(0, 200) } : {}),
      },
    });
    if (!result.ok) return { ok: false, ...result };
    const payload = result.payload || {};
    const nested = payload.file && typeof payload.file === 'object' ? payload.file : {};
    const imageId = payload.fileId || payload.imageId || payload.id || nested.fileId || nested.imageId || null;
    if (!imageId) {
      return { ok: false, reason: 'UPLOAD_UNEXPECTED', error: '공급사가 이미지 접수 결과를 확인하지 못했습니다', payload };
    }
    return { ok: true, imageId };
  }

  return { sendBatch, pollResults, groupMessages, uploadImage, state: messagingState(), buildMessage, call };
}

// Solapi reports an accepted message as PENDING/SENDING and only settles to
// COMPLETE later. Treating a submission as delivered is exactly the failure
// this product must not have, so anything unresolved stays pending.
function interpretStatus(entry) {
  const status = String((entry && entry.status) || '').toUpperCase();
  const statusCode = String((entry && entry.statusCode) || '');
  const numeric = Number(statusCode) || 0;
  const base = {
    messageId: entry && entry.messageId,
    type: entry && entry.type,
    replacement: Boolean(entry && entry.replacement),
    reason: (entry && entry.reason) || null,
    statusCode: statusCode || null,
    receivedAt: (entry && entry.dateReceived) || null,
  };
  if (status === 'PENDING' || status === 'SENDING') return { ...base, state: 'PENDING' };
  if (status !== 'COMPLETE') return { ...base, state: 'PENDING' };
  // 2xxx means accepted, 4xxx means the carrier reported the result. Anything
  // below the 4xxx band that has settled is a failure.
  if (numeric >= 4000) return { ...base, state: 'DELIVERED' };
  return { ...base, state: 'FAILED' };
}

module.exports = {
  createSolapiProvider,
  providerConfig,
  messagingState,
  normalizePhone,
  messageBytes,
  resolveTextType,
  typedFor,
  authorizationHeader,
  templateVariables,
  renderText,
  interpretStatus,
  SMS_MAX_BYTES,
  LMS_MAX_BYTES,
  SUBJECT_MAX_BYTES,
  MMS_IMAGE_MAX_BYTES,
};
