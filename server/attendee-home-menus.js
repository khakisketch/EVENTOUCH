'use strict';

// The ticket and application entries are deliberately not configurable.
// Stored values contain identifiers only, never labels, links or markup.
const ORDER = ['notice', 'lucky', 'roulette', 'vote', 'stamp'];
const KEYS = new Set(ORDER);
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const MAX_PROGRAMS = 100;
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function normalizeHomeMenus(value) {
  const source = plain(value);
  const order = [...new Set((Array.isArray(source.order) ? source.order : []).filter(item => KEYS.has(item)))];
  for (const key of ORDER) if (!order.includes(key)) order.push(key);
  const hidden = [...new Set((Array.isArray(source.hidden) ? source.hidden : []).filter(item => KEYS.has(item)))];
  const programs = [...new Set((Array.isArray(source.programs) ? source.programs : []).filter(item => typeof item === 'string' && ID.test(item)))].slice(0, MAX_PROGRAMS);
  return { order, hidden, programs };
}
function validateHomeMenus(value, fail) {
  if (value === null) return normalizeHomeMenus(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '홈 메뉴 구성을 확인하세요', 'homeMenus');
  for (const key of ['order', 'hidden', 'programs']) {
    if (!Array.isArray(value[key])) throw fail(400, '홈 메뉴 구성을 확인하세요', 'homeMenus');
    if (new Set(value[key]).size !== value[key].length) throw fail(400, '중복된 홈 메뉴를 확인하세요', 'homeMenus');
  }
  if (value.order.length > ORDER.length || value.hidden.length > ORDER.length || value.programs.length > MAX_PROGRAMS ||
      value.order.some(item => !KEYS.has(item)) || value.hidden.some(item => !KEYS.has(item)) ||
      value.programs.some(item => typeof item !== 'string' || !ID.test(item))) throw fail(400, '홈 메뉴 구성을 확인하세요', 'homeMenus');
  return normalizeHomeMenus(value);
}
module.exports = { HOME_MENU_ORDER: ORDER, normalizeHomeMenus, validateHomeMenus };
