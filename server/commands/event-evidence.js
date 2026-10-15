'use strict';

// Event evidence photos (행사 증빙 사진 보관함).
//
// A separate collection from attendee photo-wall posts (`workspace.photos`,
// PENDING/APPROVED/HIDDEN with participant identity and public visibility).
// Evidence records carry no participant identity, are never projected
// publicly, and are written only through the domain event-command route by
// AGENCY or event-member MANAGER (enforced by the shared authorizeOperator /
// access gates, not re-checked here).
//
// Fixed stable section keys (server source of truth; UI mirrors these):
//   SPACE, STAGE, PARTICIPANT_BOOTH, ONSITE_DIRECTION,
//   PRE_SETUP, ARRIVAL_REGISTRATION, PROGRAM, AWARDS

const COMMANDS = new Set([
  'evidence.photo.add',
  'evidence.photo.move',
  'evidence.photo.remove',
]);

const EVIDENCE_SECTIONS = Object.freeze({
  SPACE: '공간구성',
  STAGE: '무대연출',
  PARTICIPANT_BOOTH: '참가자부스',
  ONSITE_DIRECTION: '현장연출',
  PRE_SETUP: '사전세팅',
  ARRIVAL_REGISTRATION: '도착/등록',
  PROGRAM: '프로그램',
  AWARDS: '시상식',
});

const EVIDENCE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function evidencePhotos(workspace) {
  if (!Array.isArray(workspace.evidencePhotos)) workspace.evidencePhotos = [];
  return workspace.evidencePhotos;
}

function requireSection(ctx, value) {
  const section = ctx.clean(value, 40);
  if (!Object.hasOwn(EVIDENCE_SECTIONS, section)) {
    throw ctx.fail(400, '증빙 사진 분류를 확인하세요', 'section');
  }
  return section;
}

function findRecord(ctx, id) {
  const record = list(ctx.workspace.evidencePhotos).find(
    (item) => item && item.id === ctx.clean(id, 120)
  );
  if (!record) throw ctx.fail(404, '증빙 사진을 찾을 수 없습니다');
  return record;
}

// Evidence images must come from the operator upload route
// (POST /api/events/:eventId/files, created_by = uploader account).
// Guest ticket uploads (created_by NULL) belong to the attendee photo flow
// and can never be filed as evidence.
async function requireOperatorFile(ctx, image) {
  const resolved = await ctx.resolveFile(image, {
    eventId: ctx.event.id,
    contentTypes: EVIDENCE_IMAGE_TYPES,
    maxBytes: EVIDENCE_MAX_BYTES,
  });
  const row = await ctx.client.query(
    'SELECT created_by FROM stored_files WHERE id = $1 AND event_id = $2 LIMIT 1',
    [resolved.fileId, ctx.event.id]
  );
  if (!row.rows[0]) throw ctx.fail(404, '행사에 등록된 파일을 찾을 수 없습니다');
  if (row.rows[0].created_by == null) {
    throw ctx.fail(400, '운영자 업로드 이미지만 등록할 수 있습니다', 'image');
  }
  return resolved;
}

async function addPhoto(ctx, input) {
  const section = requireSection(ctx, input.section);
  const image = await requireOperatorFile(ctx, input.image);
  const records = evidencePhotos(ctx.workspace);
  const photo = {
    id: ctx.commandId,
    section,
    image,
    uploadedAt: ctx.now,
    uploadedBy: String(ctx.actor && ctx.actor.id || ''),
  };
  records.unshift(photo);
  return { status: 201, body: { photo: { ...photo }, sectionLabel: EVIDENCE_SECTIONS[section] } };
}

function movePhoto(ctx, input) {
  const section = requireSection(ctx, input.section);
  const record = findRecord(ctx, input.id);
  // Re-filing into the same section is a no-op success (idempotent).
  record.section = section;
  return { body: { photo: { ...record }, sectionLabel: EVIDENCE_SECTIONS[section] } };
}

function removePhoto(ctx, input) {
  const records = evidencePhotos(ctx.workspace);
  const index = records.findIndex((item) => item && item.id === ctx.clean(input.id, 120));
  if (index < 0) throw ctx.fail(404, '증빙 사진을 찾을 수 없습니다');
  const [removed] = records.splice(index, 1);
  // Metadata only: the shared stored_files bytes stay untouched so other
  // references (attendee posts, branding, program attachments) keep working.
  return { body: { ok: true, id: String(removed.id) } };
}

async function apply(ctx) {
  switch (ctx.command) {
    case 'evidence.photo.add': return addPhoto(ctx, ctx.input);
    case 'evidence.photo.move': return movePhoto(ctx, ctx.input);
    case 'evidence.photo.remove': return removePhoto(ctx, ctx.input);
    default: throw ctx.fail(400, '지원하지 않는 증빙 사진 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, EVIDENCE_SECTIONS, EVIDENCE_IMAGE_TYPES, EVIDENCE_MAX_BYTES, apply };
