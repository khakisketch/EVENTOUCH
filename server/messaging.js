'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Outbound messaging provider.
//
// Every message campaign in this product was previously recorded as SIMULATED
// or NEEDS_CONNECTION and nothing ever left the server, which is correct for a
// demo and useless for a customer who needs to tell attendees where to park.
//
// This module is the seam where a real provider plugs in. It is deliberately
// vendor-neutral: it POSTs one normalised JSON body to an endpoint the operator
// configures, so EVENTOUCH does not take a dependency on one vendor's SDK or
// ship a reseller's credentials. A provider is active only when the endpoint
// and token are both configured; otherwise the caller keeps the existing
// NEEDS_CONNECTION behaviour and the product stays honest about its state.
//
// The contract:
//   request   POST <endpoint>
//             authorization: Bearer <token>
//             { from, to, text, channel, reference }
//   success   2xx with { ok: true, id? }  (id is stored on the delivery)
//   failure   any other status, or ok:false, with { error? }
//
// A vendor with a different shape needs a small translation shim in front of
// this endpoint rather than a change here. docs/INTEGRATIONS.md shows one.

const REQUEST_TIMEOUT_MS = 10000;

function providerConfig(env = process.env) {
  const endpoint = String(env.EVENTOUCH_MESSAGING_ENDPOINT || '').trim();
  const token = String(env.EVENTOUCH_MESSAGING_TOKEN || '').trim();
  const sender = String(env.EVENTOUCH_MESSAGING_SENDER || '').trim();
  return {
    endpoint,
    token,
    sender,
    // A provider is only usable when it can actually authenticate.
    configured: Boolean(endpoint && token),
  };
}

function messagingState(env = process.env) {
  const config = providerConfig(env);
  return {
    connected: config.configured,
    sender: config.configured ? config.sender || null : null,
  };
}

function createMessagingProvider(config, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  async function send({ channel, to, text, reference }) {
    if (!config.configured) {
      // Not an error: an unconfigured provider is the documented default and
      // the caller records NEEDS_CONNECTION.
      return { delivered: false, reason: 'NOT_CONFIGURED' };
    }
    if (!to) return { delivered: false, reason: 'NO_RECIPIENT' };
    if (typeof fetchImpl !== 'function') {
      return { delivered: false, reason: 'NO_TRANSPORT', error: '서버에서 외부 요청을 보낼 수 없습니다' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.token}`,
        },
        body: JSON.stringify({
          from: config.sender,
          to,
          text,
          channel,
          reference,
        }),
        signal: controller.signal,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch (err) {
        payload = null;
      }

      if (!response.ok) {
        return {
          delivered: false,
          reason: 'PROVIDER_REJECTED',
          status: response.status,
          error: (payload && payload.error) || `공급사가 요청을 거부했습니다 (${response.status})`,
        };
      }
      if (payload && payload.ok === false) {
        return {
          delivered: false,
          reason: 'PROVIDER_REJECTED',
          status: response.status,
          error: payload.error || '공급사가 발송을 거부했습니다',
        };
      }
      return {
        delivered: true,
        providerId: (payload && payload.id) || null,
        status: response.status,
      };
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      return {
        delivered: false,
        reason: aborted ? 'TIMEOUT' : 'TRANSPORT',
        error: aborted ? '공급사 응답이 지연되어 발송을 확인하지 못했습니다' : '공급사에 연결하지 못했습니다',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { send, state: messagingState() };
}

// The single source of truth for "is outbound messaging live". Solapi wins
// when configured; otherwise the generic provider applies. Callers must use
// this rather than messagingState() directly, or a Solapi-only deployment
// reports itself as disconnected.
function activeMessagingState(env = process.env) {
  const solapi = require('./messaging-solapi');
  const config = solapi.providerConfig(env);
  return config.configured ? solapi.messagingState(env) : messagingState(env);
}

function activeProvider(env = process.env) {
  const solapi = require('./messaging-solapi');
  const config = solapi.providerConfig(env);
  return config.configured
    ? solapi.createSolapiProvider(config)
    : createMessagingProvider(providerConfig(env));
}

module.exports = {
  activeMessagingState,
  activeProvider,
  providerConfig,
  messagingState,
  createMessagingProvider,
};

// Sends a queued campaign and records the per-recipient outcome.
//
// Runs after the command transaction has committed, never inside it: a
// provider call can take seconds, and a message the provider accepted must
// not be lost because our own transaction rolled back afterwards. A failure
// here leaves the campaign in a state the operator can retry, it does not
// undo the command.
// Recipient numbers live in the snapshot, not on the stored delivery. Every
// id lookup has to go through one of these.
function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/[^0-9]/g, '');
}

function phoneForDispatch(dispatch, participantId) {
  const match = (dispatch.recipients || []).find((recipient) => recipient.participantId === participantId);
  return digitsOnly(match && match.phone);
}

function phoneForRecipient(message, participantId) {
  const match = (message.recipientSnapshot || []).find((person) => person.id === participantId);
  return digitsOnly(match && match.phone);
}

async function dispatchCampaign(database, provider, dispatch, { now = new Date().toISOString() } = {}) {
  if (!provider || !dispatch || !dispatch.messageId) return { skipped: true };
  // A batch-capable provider (Solapi) takes a whole campaign in one request
  // and answers with what it accepted. Acceptance is not delivery, so the
  // campaign stays unresolved until polling confirms the real outcome.
  if (typeof provider.sendBatch === 'function') {
    return dispatchCampaignBatch(database, provider, dispatch, { now });
  }

  let finalMessage = null;
  const results = [];
  for (const recipient of dispatch.recipients) {
    const outcome = await provider.send({
      channel: dispatch.channel,
      to: recipient.phone,
      text: dispatch.text,
      reference: `${dispatch.messageId}:${recipient.participantId}`,
    });
    results.push({ ...recipient, ...outcome });
  }

  // Write the outcome in its own transaction, keyed by the event so the
  // update is a single row: a delivery must never be left claiming SENDING
  // once the real result is known.
  await database.transaction(async (client) => {
    const row = await client.query(
      'SELECT payload FROM event_workspaces WHERE event_id = $1 FOR UPDATE',
      [dispatch.eventId]
    );
    if (!row.rows[0]) return;
    // node-postgres already parses jsonb columns, so this is normally an
    // object. Tolerate a string as well rather than assuming.
    const raw = row.rows[0].payload;
    const workspace = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!workspace || !Array.isArray(workspace.messages)) return;
    const message = workspace.messages.find((item) => item.id === dispatch.messageId);
    if (!message) return;

    const deliveries = Array.isArray(message.deliveries) ? message.deliveries : [];
    let delivered = 0;
    for (const result of results) {
      const delivery = deliveries.find((item) => item.participantId === result.participantId);
      if (!delivery) continue;
      if (result.delivered) {
        delivered += 1;
        delivery.status = 'SENT';
        delivery.providerId = result.providerId || null;
        delivery.error = null;
      } else {
        delivery.status = 'FAILED';
        delivery.error = result.error || '발송하지 못했습니다';
      }
      delivery.at = now;
    }

    // A partial send is neither a success nor a failure; say so rather than
    // rounding it to one of them.
    message.status = delivered === 0 ? 'FAILED' : delivered === results.length ? 'SENT' : 'PARTIAL';
    message.cost = null;
    message.dispatchedAt = now;
    message.deliveredCount = delivered;

    finalMessage = message;
    await client.query(
      'UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1',
      [dispatch.eventId, JSON.stringify(workspace)]
    );
  });

  return { results, delivered: results.filter((item) => item.delivered).length, message: finalMessage };
}

// Batch dispatch: one provider call for the whole campaign, then a write-back
// that records acceptance per recipient. Delivery is deliberately left
// unresolved — resolveDelivery() decides it from a later poll.
async function dispatchCampaignBatch(database, provider, dispatch, { now = new Date().toISOString() } = {}) {
  let finalMessage = null;
  let batchResult = null;
  let imageId = null;
  if (String(dispatch && dispatch.channel).toUpperCase() === 'MMS') {
    const image = await loadMmsImage(database, dispatch);
    if (!image.ok) {
      batchResult = failAllRecipients(dispatch, image.reason, image.error);
    } else if (!provider || typeof provider.uploadImage !== 'function') {
      batchResult = failAllRecipients(dispatch, 'MMS_UNSUPPORTED', 'MMS를 지원하지 않는 공급사입니다');
    } else {
      let uploaded;
      try {
        uploaded = await provider.uploadImage({ bytes: image.bytes, name: image.name });
      } catch (error) {
        uploaded = { ok: false, reason: 'UPLOAD_FAILED', error: (error && error.message) || '이미지 접수에 실패했습니다' };
      }
      if (!uploaded.ok) {
        batchResult = failAllRecipients(dispatch, uploaded.reason || 'UPLOAD_FAILED', uploaded.error || '이미지 접수에 실패했습니다');
      } else {
        imageId = uploaded.imageId;
      }
    }
  }
  if (!batchResult) {
    try {
      batchResult = await provider.sendBatch(dispatch.recipients.map((recipient) => ({
        participantId: recipient.participantId,
        channel: dispatch.channel,
        to: recipient.phone,
        text: dispatch.text,
        subject: dispatch.subject,
        variables: recipient.variables,
        templateId: dispatch.templateId || null,
        ...(imageId ? { imageId } : {}),
      })));
    } catch (error) {
      batchResult = { accepted: false, reason: 'TRANSPORT', error: error && error.message };
    }
  }

  const byParticipant = new Map();
  for (const entry of (batchResult && batchResult.registered) || []) byParticipant.set(entry.participantId, entry);
  for (const entry of (batchResult && batchResult.rejected) || []) byParticipant.set(entry.participantId, { ...entry, accepted: false });

  // Read the message ids back from the group so a later poll can resolve them.
  let idsByNumber = new Map();
  if (batchResult && batchResult.accepted && batchResult.groupId && typeof provider.groupMessages === 'function') {
    try {
      const group = await provider.groupMessages(batchResult.groupId);
      if (group && group.ok) {
        for (const value of Object.values(group.messages || {})) {
          idsByNumber.set(String(value.to || '').replace(/[^0-9]/g, ''), value.messageId);
        }
      }
    } catch (error) {
      // Polling can still work from the group id alone; a missing id map
      // must not lose the fact that the messages were accepted.
      idsByNumber = new Map();
    }
  }

  await database.transaction(async (client) => {
    const row = await client.query('SELECT payload FROM event_workspaces WHERE event_id = $1 FOR UPDATE', [dispatch.eventId]);
    if (!row.rows[0]) return;
    const raw = row.rows[0].payload;
    const workspace = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!workspace || !Array.isArray(workspace.messages)) return;
    const message = workspace.messages.find((item) => item.id === dispatch.messageId);
    if (!message) return;

    const deliveries = Array.isArray(message.deliveries) ? message.deliveries : [];
    let accepted = 0;
    for (const delivery of deliveries) {
      const outcome = byParticipant.get(delivery.participantId);
      if (!outcome) {
        delivery.status = 'FAILED';
        delivery.error = (batchResult && batchResult.error) || '공급사 응답에서 이 수신자를 확인하지 못했습니다';
        delivery.at = now;
        continue;
      }
      if (outcome.accepted) {
        accepted += 1;
        delivery.status = 'SENDING';
        delivery.sentType = outcome.type || null;
        // Deliveries do not store the number (it lives in the recipient
        // snapshot), so the id is matched through the dispatch recipients.
        delivery.solapiMessageId = idsByNumber.get(phoneForDispatch(dispatch, delivery.participantId)) || null;
        delivery.error = null;
      } else {
        delivery.status = 'FAILED';
        delivery.error = outcome.error || '접수가 거부되었습니다';
      }
      delivery.at = now;
    }

    message.providerGroupId = (batchResult && batchResult.groupId) || null;
    message.dispatchedAt = now;
    message.acceptedCount = accepted;
    message.deliveryUnconfirmed = accepted > 0;
    // Nothing may be called sent until polling says so.
    message.status = accepted === 0 ? 'FAILED' : 'SENDING';
    finalMessage = message;

    await client.query(
      'UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1',
      [dispatch.eventId, JSON.stringify(workspace)]
    );
  });

  return { accepted: Boolean(batchResult && batchResult.accepted), acceptedCount: finalMessage ? finalMessage.acceptedCount : 0, message: finalMessage, deliveryUnconfirmed: true };
}

// Loads the MMS campaign photo from our own file storage for the single
// provider upload. The bytes never enter the workspace payload or the
// recipient snapshots — only the stored file id does.
async function loadMmsImage(database, dispatch) {
  const fileId = String((dispatch && dispatch.imageFileId) || '');
  if (!fileId) {
    return { ok: false, reason: 'MMS_IMAGE_REQUIRED', error: 'MMS 캠페인의 이미지를 확인하세요' };
  }
  let rows = [];
  try {
    const result = await database.query(
      'SELECT id, event_id, storage_key, original_name, content_type, size_bytes FROM stored_files WHERE id = $1 AND event_id = $2',
      [fileId, dispatch.eventId]
    );
    rows = (result && result.rows) || [];
  } catch (error) {
    return { ok: false, reason: 'IMAGE_UNREADABLE', error: 'MMS 이미지를 읽지 못했습니다' };
  }
  const row = rows[0];
  if (!row) {
    return { ok: false, reason: 'MMS_IMAGE_REQUIRED', error: 'MMS 캠페인의 이미지 파일을 찾을 수 없습니다' };
  }
  if (row.content_type !== 'image/jpeg') {
    return { ok: false, reason: 'IMAGE_TYPE', error: 'MMS 이미지는 JPG 형식을 사용하세요' };
  }
  if (Number(row.size_bytes) > 200 * 1024) {
    return { ok: false, reason: 'IMAGE_TOO_LARGE', error: 'MMS 이미지는 JPG 200KB 이하만 가능합니다' };
  }
  const root = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '../data/storage'));
  const absolute = path.resolve(root, String(row.storage_key || ''));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    return { ok: false, reason: 'IMAGE_UNREADABLE', error: 'MMS 이미지 파일을 읽지 못했습니다' };
  }
  try {
    const bytes = await fs.readFile(absolute);
    return { ok: true, bytes, name: String(row.original_name || 'mms.jpg') };
  } catch (error) {
    return { ok: false, reason: 'IMAGE_UNREADABLE', error: 'MMS 이미지 파일을 읽지 못했습니다' };
  }
}

function failAllRecipients(dispatch, reason, error) {
  return {
    accepted: false,
    reason,
    error,
    rejected: (dispatch.recipients || []).map((recipient) => ({
      participantId: recipient.participantId,
      reason,
      error,
    })),
  };
}

// Resolves campaigns that were accepted but not yet confirmed delivered.
//
// This is the other half of dispatchCampaignBatch: acceptance is not arrival,
// so SENDING only becomes SENT/PARTIAL/FAILED once Solapi reports the real
// result. Called on demand (the operator opening the campaign) rather than by
// a background worker, because there is no scheduler in this product and a
// polling loop would need one to be reliable.
async function resolveDelivery(database, provider, eventId, { now = new Date().toISOString() } = {}) {
  if (!provider || typeof provider.pollResults !== 'function') return { skipped: true };

  const row = await database.query('SELECT payload FROM event_workspaces WHERE event_id = $1', [eventId]);
  if (!row.rows[0]) return { skipped: true };
  const raw = row.rows[0].payload;
  const workspace = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const messages = Array.isArray(workspace && workspace.messages) ? workspace.messages : [];

  const pending = messages.filter((message) => message.status === 'SENDING' && Array.isArray(message.deliveries));
  if (!pending.length) return { resolved: 0, pending: 0 };

  let resolvedCount = 0;
  const updates = [];

  for (const message of pending) {
    let ids = message.deliveries.map((delivery) => delivery.solapiMessageId).filter(Boolean);

    // The id map can be missing when the group read failed at dispatch time.
    // Recovering it here keeps the campaign resolvable instead of stuck.
    if (!ids.length && message.providerGroupId && typeof provider.groupMessages === 'function') {
      try {
        const group = await provider.groupMessages(message.providerGroupId);
        if (group && group.ok) {
          const byNumber = new Map();
          for (const value of Object.values(group.messages || {})) {
            byNumber.set(String(value.to || '').replace(/[^0-9]/g, ''), value.messageId);
          }
          for (const delivery of message.deliveries) {
            const id = byNumber.get(phoneForRecipient(message, delivery.participantId));
            if (id) delivery.solapiMessageId = id;
          }
          ids = message.deliveries.map((delivery) => delivery.solapiMessageId).filter(Boolean);
        }
      } catch (error) {
        // Fall through: the campaign stays SENDING and will be retried.
      }
    }

    if (!ids.length) continue;
    const polled = await provider.pollResults(ids);
    if (!polled || !polled.ok) continue;

    let delivered = 0;
    let failed = 0;
    let stillPending = 0;
    for (const delivery of message.deliveries) {
      const result = polled.results[delivery.solapiMessageId];
      if (!result) { stillPending += 1; continue; }
      if (result.state === 'PENDING') { stillPending += 1; continue; }
      if (result.state === 'DELIVERED') {
        delivered += 1;
        delivery.status = 'SENT';
        delivery.sentType = result.type || delivery.sentType || null;
        // An alimtalk that fell back to text still arrived, but the operator
        // should be able to see that it did not arrive as alimtalk.
        delivery.replacedFallback = Boolean(result.replacement);
        delivery.receivedAt = result.receivedAt || null;
        delivery.error = null;
      } else {
        failed += 1;
        delivery.status = 'FAILED';
        delivery.error = result.reason || '발송에 실패했습니다';
        delivery.statusCode = result.statusCode || null;
      }
      delivery.at = now;
    }

    if (stillPending) {
      // Some recipients are unresolved; the campaign stays in flight rather
      // than being rounded to a result we do not have.
      message.status = 'SENDING';
      message.deliveredCount = delivered;
      message.failedCount = failed;
      message.deliveryUnconfirmed = true;
      updates.push(message);
      continue;
    }

    resolvedCount += 1;
    message.status = failed === 0 ? 'SENT' : delivered === 0 ? 'FAILED' : 'PARTIAL';
    message.deliveredCount = delivered;
    message.failedCount = failed;
    message.deliveryUnconfirmed = false;
    message.resolvedAt = now;
    updates.push(message);
  }

  if (updates.length) {
    await database.transaction(async (client) => {
      const locked = await client.query('SELECT payload FROM event_workspaces WHERE event_id = $1 FOR UPDATE', [eventId]);
      if (!locked.rows[0]) return;
      const current = typeof locked.rows[0].payload === 'string' ? JSON.parse(locked.rows[0].payload) : locked.rows[0].payload;
      if (!current || !Array.isArray(current.messages)) return;
      for (const updated of updates) {
        const target = current.messages.find((item) => item.id === updated.id);
        if (!target) continue;
        target.status = updated.status;
        target.deliveries = updated.deliveries;
        target.deliveredCount = updated.deliveredCount;
        target.failedCount = updated.failedCount;
        target.deliveryUnconfirmed = updated.deliveryUnconfirmed;
        target.resolvedAt = updated.resolvedAt;
      }
      await client.query(
        'UPDATE event_workspaces SET payload = $2::jsonb, revision = revision + 1, updated_at = now() WHERE event_id = $1',
        [eventId, JSON.stringify(current)]
      );
    });
  }

  return { resolved: resolvedCount, pending: updates.length - resolvedCount, total: pending.length, messages: updates };
}

module.exports.dispatchCampaign = dispatchCampaign;
module.exports.dispatchCampaignBatch = dispatchCampaignBatch;
module.exports.resolveDelivery = resolveDelivery;
