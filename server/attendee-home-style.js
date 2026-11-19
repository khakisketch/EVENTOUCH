'use strict';

// Event-scoped participant-home customization (homeStyle).
//
// The homeStyle object lives nested under pageExperience.draft/published and
// is published as one unit with the rest of the attendee page. Everyone
// viewing the same event sees the same PUBLISHED design; drafts never leak
// into the public projection.
//
// Contract (agreed with the frontend track):
//   pageExperience.draft/published.homeStyle = {
//     backgroundColor: '#B9DEF0',
//     heroTitle: null,      // null/blank falls back to the actual event name (max 80 unicode chars)
//     heroSubtitle: '',     // plain short text, distinct from intro (max 100)
//     heroLayout: 'centered' | 'bottom-overlay' | 'image-only',
//     titleScale: 'standard' | 'large',
//     imageFocus: 'center' | 'top' | 'bottom',
//     textAlign: 'left' | 'center' | 'right',
//     textTone: 'light' | 'dark',
//     overlay: 'none' | 'soft' | 'strong',
//     layout: 'tile' | 'poster' | 'instagram',   // home composition (default 'tile')
//     bannerKind: 'image' | 'gradient' | 'solid',  // banner fill; 'image' uses the uploaded picture
//     bannerColor: '#1E2026',                      // solid color / gradient start
//     bannerColor2: '#C8441F',                     // gradient end
//     bannerAngle: 'diagonal' | 'vertical' | 'horizontal',
//   }
//
// No arbitrary HTML/CSS/fonts/URL-data images: text stays plain (the React
// client escapes it) and the backend rejects control characters, truly
// invalid types, and oversize explicit values with 400 field errors.
// Unknown keys are ignored by allowlist. Defaults live ONLY here.

const DEFAULT_HOME_STYLE = {
  backgroundColor: '#B9DEF0',
  heroTitle: null,
  heroSubtitle: '',
  heroLayout: 'centered',
  titleScale: 'standard',
  imageFocus: 'center',
  textAlign: 'center',
  textTone: 'light',
  overlay: 'none',
  layout: 'tile',
  bannerKind: 'image',
  bannerColor: '#1E2026',
  bannerColor2: '#C8441F',
  bannerAngle: 'diagonal',
};

const KNOWN_KEYS = Object.keys(DEFAULT_HOME_STYLE);

const ENUMS = {
  heroLayout: new Set(['centered', 'bottom-overlay', 'image-only']),
  titleScale: new Set(['standard', 'large']),
  imageFocus: new Set(['center', 'top', 'bottom']),
  textAlign: new Set(['left', 'center', 'right']),
  textTone: new Set(['light', 'dark']),
  overlay: new Set(['none', 'soft', 'strong']),
  // 'instagram' is the photo-first home (approved participant photos). It is a
  // pure presentation choice: the public projection already carries only
  // approved photos, and a page with none reads as the tile home.
  layout: new Set(['tile', 'poster', 'instagram']),
  bannerKind: new Set(['image', 'gradient', 'solid']),
  bannerAngle: new Set(['diagonal', 'vertical', 'horizontal']),
};

// Owner decision 2026-11-19: the typography layout and the poster list-menu
// shape are retired (the first release offers tile, poster and instagram, and
// poster menus are always round). Stored pages are never rewritten: a retired
// layout reads as the tile home, publishes as tile and saves as tile, and the
// stored menuShape key is simply no longer a known key.
const RETIRED_LAYOUTS = new Map([['typography', 'tile']]);

const COLOR_KEYS = new Set(['backgroundColor', 'bannerColor', 'bannerColor2']);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const HERO_TITLE_MAX = 80;
const HERO_SUBTITLE_MAX = 100;

function unicodeLength(value) {
  return [...value].length;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultHomeStyle() {
  return { ...DEFAULT_HOME_STYLE };
}

function fieldError(fail, key, message) {
  throw fail(400, message, `homeStyle.${key}`);
}

// Strict per-field validation for an explicitly supplied value. Returns the
// normalized value. Throws a 400 field error on any violation.
function validateField(key, value, fail) {
  if (COLOR_KEYS.has(key)) {
    if (typeof value !== 'string' || !HEX_COLOR.test(value.trim())) {
      fieldError(fail, key, key === 'backgroundColor' ? '홈 배경색을 확인하세요' : '배너 색을 확인하세요');
    }
    return value.trim().toUpperCase();
  }
  if (key === 'heroTitle') {
    if (value === null) return null;
    if (typeof value !== 'string') fieldError(fail, key, '홈 대표 문구를 확인하세요');
    if (CONTROL_CHARS.test(value)) fieldError(fail, key, '홈 대표 문구에 사용할 수 없는 문자가 있습니다');
    if (unicodeLength(value) > HERO_TITLE_MAX) fieldError(fail, key, '홈 대표 문구는 80자 이내로 입력하세요');
    return value;
  }
  if (key === 'heroSubtitle') {
    if (typeof value !== 'string') fieldError(fail, key, '홈 보조 문구를 확인하세요');
    if (CONTROL_CHARS.test(value)) fieldError(fail, key, '홈 보조 문구에 사용할 수 없는 문자가 있습니다');
    if (unicodeLength(value) > HERO_SUBTITLE_MAX) fieldError(fail, key, '홈 보조 문구는 100자 이내로 입력하세요');
    return value;
  }
  if (Object.hasOwn(ENUMS, key)) {
    if (key === 'layout' && RETIRED_LAYOUTS.has(value)) return RETIRED_LAYOUTS.get(value);
    if (typeof value !== 'string' || !ENUMS[key].has(value)) {
      fieldError(fail, key, '홈 화면 표시 값을 확인하세요');
    }
    return value;
  }
  return undefined;
}

// Read-safe normalization for stored or projected values. Never throws:
// malformed stored JSON degrades field-by-field to the default safe
// allowlist instead of failing the read (the public projection must never
// 500 on legacy or hand-edited rows).
function normalizeHomeStyle(value) {
  const merged = defaultHomeStyle();
  if (!isPlainObject(value)) return merged;
  for (const key of KNOWN_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const raw = value[key];
    try {
      if (COLOR_KEYS.has(key)) {
        if (typeof raw === 'string' && HEX_COLOR.test(raw.trim())) merged[key] = raw.trim().toUpperCase();
      } else if (key === 'heroTitle') {
        if (raw === null) merged[key] = null;
        else if (typeof raw === 'string' && !CONTROL_CHARS.test(raw) && unicodeLength(raw) <= HERO_TITLE_MAX) {
          merged[key] = raw;
        }
      } else if (key === 'heroSubtitle') {
        if (typeof raw === 'string' && !CONTROL_CHARS.test(raw) && unicodeLength(raw) <= HERO_SUBTITLE_MAX) {
          merged[key] = raw;
        }
      } else if (Object.hasOwn(ENUMS, key)) {
        if (key === 'layout' && RETIRED_LAYOUTS.has(raw)) merged[key] = RETIRED_LAYOUTS.get(raw);
        else if (typeof raw === 'string' && ENUMS[key].has(raw)) merged[key] = raw;
      }
    } catch (error) {
      // Defensive: normalization never throws; the default stands.
    }
  }
  return merged;
}

// Explicit update validation for attendee.page.save. `input` is the supplied
// homeStyle value (already known non-null): unknown keys are ignored by
// allowlist, supplied known fields are validated strictly, and omitted known
// fields merge from the stored style instead of resetting.
function validateHomeStyleUpdate(input, stored, fail) {
  if (!isPlainObject(input)) throw fail(400, '홈 화면 설정을 확인하세요', 'homeStyle');
  const merged = normalizeHomeStyle(stored);
  for (const key of KNOWN_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    merged[key] = validateField(key, input[key], fail);
  }
  return merged;
}

// Publish-time gate for the stored draft style. Legacy drafts without a
// style publish with defaults; a malformed or malicious stored style is
// rejected with a 400 field error rather than silently published.
function assertPublishableHomeStyle(stored, fail) {
  if (stored === undefined) return defaultHomeStyle();
  if (!isPlainObject(stored)) throw fail(400, '홈 화면 설정을 확인하세요', 'homeStyle');
  const merged = defaultHomeStyle();
  for (const key of KNOWN_KEYS) {
    if (!Object.hasOwn(stored, key)) continue;
    merged[key] = validateField(key, stored[key], fail);
  }
  return merged;
}

module.exports = {
  DEFAULT_HOME_STYLE,
  HERO_TITLE_MAX,
  HERO_SUBTITLE_MAX,
  defaultHomeStyle,
  normalizeHomeStyle,
  validateHomeStyleUpdate,
  assertPublishableHomeStyle,
};
