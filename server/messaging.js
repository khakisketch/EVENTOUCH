'use strict';

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

module.exports = {
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
async function dispatchCampaign(database, provider, dispatch, { now = new Date().toISOString() } = {}) {
  if (!provider || !dispatch || !dispatch.messageId) return { skipped: true };

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

module.exports.dispatchCampaign = dispatchCampaign;
