'use strict';

// Shared pure helpers for the server command executors.
//
// domain.js, participants.js and operations.js each defined their own copies
// of these functions. The copies were behaviorally identical, which meant a
// contract change (id format, ticket hashing, bearer parsing) had to be made
// in three places. This module is the single owner; the executors keep their
// own authorize/lock/receipt logic, which genuinely differs per path.

const crypto = require('node:crypto');

function failure(status, message, field, code) {
  const error = new Error(message);
  error.status = status;
  if (field) error.field = field;
  if (code) error.code = code;
  return error;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value, max = 500) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function commandIdentifier(value) {
  const id = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw failure(400, '요청 식별자를 확인하세요', 'commandId');
  return id;
}

function nextId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashTicket(token) {
  return token ? crypto.createHash('sha256').update(token).digest('hex') : null;
}

function findTicket(workspace, token) {
  return list(workspace && workspace.participants).find((person) => person && person.ticket === token) || null;
}

function ticketCode(value) {
  const raw = clean(value, 2048);
  if (!raw.includes('ticket=')) return raw;
  try {
    const query = raw.slice(raw.indexOf('?') + 1);
    return new URLSearchParams(query).get('ticket') || raw;
  } catch (error) {
    return raw;
  }
}

module.exports = {
  failure,
  object,
  list,
  clean,
  commandIdentifier,
  nextId,
  hashTicket,
  ticketHash: hashTicket,
  findTicket,
  ticketCode,
};
