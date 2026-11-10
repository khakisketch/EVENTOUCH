'use strict';

const crypto = require('node:crypto');

// Index once for the whole roster; a large number of conflicts must not turn
// a bootstrap read into one full participant/payment scan per row.
function cancellationConflictIdentity(person) {
  const phone = String(person?.phone || '').replace(/\D/g, '');
  return JSON.stringify([String(person?.name || '').trim().toLowerCase(), String(person?.company || '').trim().toLowerCase(), phone.slice(0, 3), phone.slice(-4)]);
}

function cancellationConflictIndex(workspace) {
  const ids = new Map(), identities = new Map(), activeByPhone = new Map(), paymentsByPerson = new Map();
  let approvedCount = 0;
  for (const item of Array.isArray(workspace.participants) ? workspace.participants : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = String(item.id), phone = String(item.phone || '').replace(/\D/g, '');
    ids.set(id, (ids.get(id) || 0) + 1);
    const identity = cancellationConflictIdentity(item);
    identities.set(identity, (identities.get(identity) || 0) + 1);
    if (item.cancelled === true || String(item.status || '').toUpperCase() === 'CANCELLED') continue;
    const peers = activeByPhone.get(phone) || [];
    peers.push({ id: item.id, status: item.status, cancelled: item.cancelled });
    activeByPhone.set(phone, peers);
    if (item.status === 'APPROVED') approvedCount += 1;
  }
  for (const payment of Array.isArray(workspace.payments) ? workspace.payments : []) {
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) continue;
    const id = String(payment.participantId), entries = paymentsByPerson.get(id) || [];
    entries.push(payment); paymentsByPerson.set(id, entries);
  }
  const activePhoneDigests = new Map([...activeByPhone].map(([phone, peers]) => [phone, crypto.createHash('sha256').update(JSON.stringify(peers)).digest('hex')]));
  return { ids, identities, activePhoneDigests, paymentsByPerson, approvedCount };
}

// Bind the operator review to the same record and the same facts affecting
// restoration. A digest carries no bearer token or contact data in the UI.
// Missing legacy arrays remain empty; malformed explicit arrays fail closed.
function cancellationConflictFingerprint(workspace, rawWorkspace, event, person, index = cancellationConflictIndex(workspace)) {
  const raw = rawWorkspace && typeof rawWorkspace === 'object' && !Array.isArray(rawWorkspace) ? rawWorkspace : null;
  if (!raw || !event || !person || typeof person !== 'object' || Array.isArray(person) || person.cancelled !== true ||
      !['APPROVED', 'PENDING', 'WAITLIST'].includes(person.status) ||
      !Array.isArray(raw.participants) ||
      (Object.hasOwn(raw, 'payments') && !Array.isArray(raw.payments)) ||
      (Object.hasOwn(raw, 'audit') && !Array.isArray(raw.audit))) return null;
  if (typeof person.id !== 'string' || !person.id || index.ids.get(person.id) !== 1) return null;
  const phone = String(person.phone || '').replace(/\D/g, '');
  return crypto.createHash('sha256').update(JSON.stringify({ person, conflictingPeople: index.activePhoneDigests.get(phone) || null,
    identityCount: index.identities.get(cancellationConflictIdentity(person)), approvedCount: index.approvedCount,
    payments: index.paymentsByPerson.get(person.id) || [], stage: event.stage, capacity: event.capacity })).digest('hex');
}
module.exports = { cancellationConflictFingerprint, cancellationConflictIndex, cancellationConflictIdentity };
