'use strict';

// Operator-entered contact data arrives from spreadsheets: hyphens, spaces,
// "+82" and a leading 0 that Excel dropped are all common. The server and the
// import preview share these rules so what the preview shows is what is stored.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Digits only, then restore the domestic leading 0: "+82 10-1234-5678" and a
// spreadsheet's "1012345678" both become "01012345678". 8-digit service
// numbers (1588-xxxx) never start with a dropped 0, so only 9–10 digits are restored.
function normalizeContactPhone(value) {
  const digits = String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
  const international = /^82(0?)([1-9]\d{7,9})$/.exec(digits);
  if (international) return `0${international[2]}`;
  if (/^[1-9]\d{8,9}$/.test(digits)) return `0${digits}`;
  return digits;
}

// True when normalizing had to add the leading 0 (shown to the operator, never silent).
function phoneLeadingZeroRestored(value) {
  const digits = String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
  return normalizeContactPhone(value) !== digits;
}

function emailLooksValid(value) {
  const email = String(value === undefined || value === null ? '' : value).trim();
  return !email || EMAIL_SHAPE.test(email);
}

// 소속 comparison key: spacing, case and legal-entity marks do not make a different organization.
function companyKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .normalize('NFC')
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(재\)|재단법인|\(사\)|사단법인/g, '')
    .replace(/[\s·.,\-_/()]+/g, '')
    .toLowerCase();
}

function editDistanceWithin1(a, b) {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (x.length > y.length) i += 1;
    else if (y.length > x.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

// A likely typo of a known 소속: same key (spacing/(주) differences), or one
// character apart for names of 3+ characters. Never decides on its own; the
// caller offers it as a suggestion.
function companiesLookAlike(a, b) {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return Math.min([...ka].length, [...kb].length) >= 3 && editDistanceWithin1(ka, kb);
}

// Suggest the established spelling for a rare 소속: `counts` maps each spelling
// to how many people use it. A suggestion needs a clearly more common
// look-alike (at least 3 people and 3x as many), so two genuinely different
// small organizations are left alone.
function suggestCompany(value, counts) {
  const own = counts.get(value) || 0;
  let best = null;
  for (const [candidate, count] of counts) {
    if (candidate === value || !companiesLookAlike(value, candidate)) continue;
    if (companyKey(candidate) !== companyKey(value) && (count < 3 || count < Math.max(1, own) * 3)) continue;
    if (companyKey(candidate) === companyKey(value) && count <= own) continue;
    if (!best || count > best.count) best = { company: candidate, count };
  }
  return best;
}

module.exports = { normalizeContactPhone, phoneLeadingZeroRestored, emailLooksValid, companyKey, companiesLookAlike, suggestCompany };
