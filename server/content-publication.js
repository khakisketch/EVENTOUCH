'use strict';

const { normalizeHomeMenus } = require('./attendee-home-menus');

// The top-level fields remain the live projection for old readers. New
// editors explicitly opt into draft saves; old writers retain immediate
// save semantics. Publication always requires the revision just reviewed.
const FIELDS = {
  notice: ['title', 'body', 'pinned', 'at'],
  program: ['title', 'date', 'start', 'end', 'place', 'description', 'attachment'],
  venue: ['name', 'address', 'directions', 'contact', 'description', 'map'],
};

function revision(value) {
  return Number.isSafeInteger(value?.version) && value.version >= 0 ? value.version : 0;
}

function contentFields(kind, value) {
  const result = {};
  for (const key of FIELDS[kind]) {
    if (Object.hasOwn(value || {}, key)) result[key] = structuredClone(value[key]);
  }
  return result;
}

function contentDraft(kind, value) {
  const draft = value?.draft;
  return contentFields(kind, draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : value);
}

function guardContentRevision(ctx, input, value, required = false) {
  if (!required && input.expectedVersion === undefined) return;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw ctx.fail(400, '검토한 콘텐츠 버전을 확인하세요', 'expectedVersion');
  }
  if (input.expectedVersion !== revision(value)) {
    throw ctx.fail(409, '다른 운영자가 내용을 변경했습니다. 최신 내용을 불러온 뒤 다시 검토하세요', 'expectedVersion');
  }
}

function saveContent(ctx, kind, input, old, next) {
  if (input.mode !== undefined && input.mode !== 'draft') throw ctx.fail(400, '저장 방식을 확인하세요', 'mode');
  guardContentRevision(ctx, input, old);
  const fields = contentFields(kind, next);
  const saved = old || {};
  if (input.mode !== 'draft' || !old) {
    // Clear optional assets on a legacy immediate save as well.
    for (const key of FIELDS[kind]) delete saved[key];
    Object.assign(saved, fields);
    if (kind !== 'venue') saved.published = input.mode === 'draft' ? false : next.published === true;
  }
  if (next.id) saved.id = next.id;
  saved.version = revision(old) + 1;
  saved.draft = fields;
  return saved;
}

async function publishContent(ctx, kind, input) {
  const value = kind === 'venue' ? ctx.workspace.venue
    : ctx.workspace[kind === 'notice' ? 'notices' : 'program'].find(item => item.id === ctx.clean(input.id, 120));
  if (!value) throw ctx.fail(404, '콘텐츠를 찾을 수 없습니다');
  if (kind === 'venue' && !ctx.event.features.includes('venue')) throw ctx.fail(409, '행사 설정에서 장소 안내 기능을 먼저 켜세요');
  guardContentRevision(ctx, input, value, true);
  if (kind !== 'venue' && typeof input.published !== 'boolean') throw ctx.fail(400, '게시 상태를 확인하세요', 'published');
  if (kind === 'venue' || input.published) {
    const draft = contentDraft(kind, value);
    // Re-check event ownership/type even when an old saved draft is used.
    if (kind === 'program' && draft.attachment) draft.attachment = await ctx.resolveFile(draft.attachment, {
      eventId: ctx.event.id, contentTypes: ['application/pdf'], maxBytes: 600000,
    });
    if (kind === 'venue' && draft.map) draft.map = {
      image: await ctx.resolveFile(draft.map.image, { eventId: ctx.event.id, contentTypes: ['image/png', 'image/jpeg'], maxBytes: 499999 }),
      alt: draft.map.alt,
    };
    value.draft = structuredClone(draft);
    for (const key of FIELDS[kind]) delete value[key];
    Object.assign(value, draft);
    value.publishedAt = ctx.now;
  }
  if (kind !== 'venue') value.published = input.published;
  value.version = revision(value) + 1;
  if (kind === 'program') ctx.workspace.program.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return { body: { [kind]: value } };
}

// These are the destinations actually described in the review, rather than
// the entire page revision: unrelated edits should not block publication.
// The command executor already holds the event/workspace row lock here.
function publicationDestinations(ctx, kind, id) {
  const page = ctx.workspace.pageExperience?.published;
  const published = page && typeof page === 'object' && !Array.isArray(page) ? page : {};
  if (kind === 'notice') {
    const visible = published.showAnnouncements !== false;
    const screenEnabled = Array.isArray(ctx.event.features) && ctx.event.features.includes('screen');
    const display = ctx.workspace.display;
    return {
      slug: ctx.event.slug,
      public: visible,
      home: visible && !normalizeHomeMenus(published.homeMenus).hidden.includes('notice'),
      screen: !screenEnabled ? 'off' : display?.type === 'notice' && display.noticeId === id ? 'selected' : 'available',
    };
  }
  if (kind === 'program') return { slug: ctx.event.slug, public: published.showPrograms !== false };
  return { slug: ctx.event.slug, public: Array.isArray(ctx.event.features) && ctx.event.features.includes('venue') && published.showVenue !== false };
}

async function publishReviewedContent(ctx, kind, input) {
  const expected = input.expectedDestinations;
  const keys = kind === 'notice' ? ['slug', 'public', 'home', 'screen'] : ['slug', 'public'];
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== keys.length || keys.some(key => !Object.hasOwn(expected, key)) ||
      typeof expected.slug !== 'string' || !expected.slug || expected.slug.length > 120 ||
      typeof expected.public !== 'boolean' || (kind === 'notice' &&
        (typeof expected.home !== 'boolean' || !['off', 'available', 'selected'].includes(expected.screen)))) {
    throw ctx.fail(400, '검토한 게시 위치를 확인하세요', 'expectedDestinations');
  }
  const current = publicationDestinations(ctx, kind, ctx.clean(input.id, 120));
  if (keys.some(key => expected[key] !== current[key])) {
    throw ctx.fail(409, '게시 위치가 변경되었습니다. 최신 설정을 확인하고 다시 검토하세요.', 'expectedDestinations', 'PUBLICATION_DESTINATIONS_CHANGED');
  }
  const result = await publishContent(ctx, kind, input);
  result.body.reviewedDestinations = current;
  return result;
}

function clearCopiedPublication(kind, value) {
  delete value.version;
  delete value.publishedAt;
  if (value.draft && typeof value.draft === 'object' && !Array.isArray(value.draft)) {
    const draft = contentFields(kind, value.draft);
    if (kind === 'program') draft.attachment = null;
    if (kind === 'venue') delete draft.map;
    value.draft = draft;
  }
  return value;
}

module.exports = { contentDraft, guardContentRevision, saveContent, publishContent, publishReviewedContent, clearCopiedPublication };
