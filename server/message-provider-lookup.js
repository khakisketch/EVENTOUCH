'use strict';

// Add a read-only lookup aid only to the existing operator projection. The
// stored campaign and its historical recipient snapshot are never changed.
function operatorMessageLookup(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      message.status !== 'SENDING' || message.genericSubmissionUnconfirmed !== true ||
      message.genericAttemptActive === false || !Array.isArray(message.deliveries)) return message;

  const attempt = message.providerSubmission;
  const recordedHttp = attempt && typeof attempt === 'object' && !Array.isArray(attempt) &&
    attempt.kind === 'HTTP' && typeof attempt.id === 'string' && Boolean(attempt.id);
  const recipients = Array.isArray(message.recipientIds) ? message.recipientIds : [];
  const snapshots = Array.isArray(message.recipientSnapshot) ? message.recipientSnapshot : [];
  const recipientCounts = new Map(), deliveryCounts = new Map(), snapshotsById = new Map();
  for (const id of recipients) if (typeof id === 'string' && id) recipientCounts.set(id, (recipientCounts.get(id) || 0) + 1);
  for (const delivery of message.deliveries) {
    if (delivery && typeof delivery === 'object' && typeof delivery.participantId === 'string' && delivery.participantId) {
      deliveryCounts.set(delivery.participantId, (deliveryCounts.get(delivery.participantId) || 0) + 1);
    }
  }
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.id !== 'string' || !snapshot.id) continue;
    const entries = snapshotsById.get(snapshot.id);
    if (entries) entries.push(snapshot); else snapshotsById.set(snapshot.id, [snapshot]);
  }

  return { ...message, deliveries: message.deliveries.map((delivery) => {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery) || delivery.status !== 'SENDING') return delivery;
    const id = delivery.participantId;
    const entries = typeof id === 'string' ? snapshotsById.get(id) : null;
    const valid = typeof id === 'string' && Boolean(id) && id.length <= 120 &&
      recipientCounts.get(id) === 1 && deliveryCounts.get(id) === 1 && entries?.length === 1;
    if (!valid) return { ...delivery, providerLookup: { maskedPhone: '', reference: null } };
    const digits = typeof entries[0].phone === 'string' ? entries[0].phone.replace(/\D/g, '') : '';
    const maskedPhone = digits.length >= 9 && digits.length <= 15 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : '';
    const reference = recordedHttp && typeof message.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(message.id)
      ? `${message.id}:${id}` : null;
    return { ...delivery, providerLookup: { maskedPhone, reference } };
  }) };
}

module.exports = { operatorMessageLookup };
