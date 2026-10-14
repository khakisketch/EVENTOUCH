'use strict';

const PUBLIC_STAGES = new Set(['READY', 'LIVE', 'ENDED']);
const TICKET_TOKEN = /^(?:[A-Za-z0-9_-]{32,128}|ET:[A-Za-z0-9_-]{1,80}:T-[A-Za-z0-9_-]{32,128})$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function copy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function text(value, max = 5000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) result[key] = copy(source[key]);
  }
  return result;
}

function publicImage(value) {
  const source = object(value);
  const fileId = text(source.fileId, 160);
  const contentType = text(source.type, 80);
  const size = Number(source.size);
  if (/^[A-Za-z0-9_-]{1,160}$/.test(fileId) &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(contentType) &&
      Number.isSafeInteger(size) && size >= 0 && size <= 600000) {
    return {
      fileId,
      name: text(source.name, 200),
      type: contentType,
      size,
    };
  }
  const data = text(source.data, 900000);
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return null;
  const width = Number(source.width);
  const height = Number(source.height);
  return {
    data,
    width: Number.isFinite(width) && width > 0 && width <= 10000 ? width : 1,
    height: Number.isFinite(height) && height > 0 && height <= 10000 ? height : 1,
  };
}

function publicAttachment(value) {
  const source = object(value);
  const fileId = text(source.fileId, 160);
  const contentType = text(source.type, 80);
  const size = Number(source.size);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(fileId) || contentType !== 'application/pdf' ||
      !Number.isSafeInteger(size) || size < 0 || size > 600000) return null;
  return {
    fileId,
    name: text(source.name, 200),
    type: contentType,
    size,
  };
}

function publicValue(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => publicValue(item, depth + 1));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
      .slice(0, 100)
      .map(([key, item]) => [key, publicValue(item, depth + 1)])
  );
}

function publicEvent(row) {
  const source = object(row.payload);
  const stage = text(source.stage, 24).toUpperCase();
  if (!PUBLIC_STAGES.has(stage)) return null;
  const capacity = Number(source.capacity);
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: text(source.name, 160),
    date: text(source.date, 32),
    start: text(source.start, 16),
    end: text(source.end, 16),
    capacity: Number.isFinite(capacity) && capacity >= 0 ? capacity : 0,
    stage,
    features: [...new Set(array(source.features).filter((item) => typeof item === 'string').slice(0, 40))],
  };
}

function publicField(field) {
  const source = object(field);
  return {
    id: text(source.id, 100),
    label: text(source.label, 160),
    type: text(source.type, 24),
    required: source.required === true,
    options: array(source.options).filter((option) => typeof option === 'string').map((option) => option.slice(0, 200)),
  };
}

function publicPage(source) {
  const branding = object(source.branding);
  const page = object(object(source.pageExperience).published);
  const accent = /^#[0-9a-f]{6}$/i.test(page.accent) ? page.accent.toUpperCase() : '#E76D26';
  const published = {
    accent,
    intro: text(page.intro || branding.tagline || '참가에 필요한 안내와 내 티켓을 확인하세요.', 160),
    showAnnouncements: page.showAnnouncements !== false,
    showSchedule: page.showSchedule !== false,
    showVenue: page.showVenue !== false,
    showPrograms: page.showPrograms !== false,
    logo: publicImage(Object.hasOwn(page, 'logo') ? page.logo : branding.logo),
    keyvisual: publicImage(Object.hasOwn(page, 'keyvisual') ? page.keyvisual : branding.keyvisual),
  };
  return {
    pageExperience: { published },
    branding: { tagline: published.intro, logo: published.logo, keyvisual: published.keyvisual },
  };
}

function publicModule(module) {
  const source = object(module);
  const projected = {
    id: text(source.id, 120),
    type: text(source.type, 32),
    title: text(source.title, 300),
    status: text(source.status, 24),
    published: true,
  };
  if (Array.isArray(source.options)) projected.options = source.options.filter((option) => typeof option === 'string').map((option) => option.slice(0, 200));
  if (Array.isArray(source.questions)) projected.questions = source.questions.filter((question) => typeof question === 'string').map((question) => question.slice(0, 300));
  if (source.type === 'quiz') {
    projected.revealed = source.revealed === true;
    if (projected.revealed) projected.answer = text(source.answer, 1000);
  }
  if (source.type === 'draw') {
    projected.drawHistory = array(source.drawHistory).filter((result) => result && result.published === true).map((result) => ({
      id: text(result.id, 120),
      at: text(result.at, 64),
      published: true,
      winners: array(result.winners).map((winner) => ({
        name: text(winner && winner.name, 120),
        company: text(winner && winner.company, 160),
      })),
    }));
  }
  return projected;
}

function publicQuestion(question) {
  const source = object(question);
  const likeCount = Math.min(1000, array(source.likes).length);
  return {
    id: text(source.id, 120),
    moduleId: text(source.moduleId, 120),
    name: text(source.name, 120),
    text: text(source.text, 1000),
    answer: text(source.answer, 2000),
    approved: source.approved === true,
    likes: Array.from({ length: likeCount }, () => true),
  };
}

function publicPhoto(photo, own = false) {
  const source = object(photo);
  const image = publicImage(source.image);
  if (!image) return null;
  return {
    id: text(source.id, 120),
    name: text(source.name, 120),
    image,
    caption: text(source.caption, 1000),
    status: source.status === 'APPROVED' ? 'APPROVED' : text(source.status, 24),
    at: text(source.at, 64),
    ...(own && source.participantId ? { participantId: text(source.participantId, 160) } : {}),
  };
}

function publicPost(post, own = false) {
  const source = object(post);
  return {
    id: text(source.id, 120),
    name: text(source.name, 120),
    body: text(source.body, 2000),
    status: text(source.status, 24),
    at: text(source.at, 64),
    ...(own && source.participantId ? { participantId: text(source.participantId, 160) } : {}),
  };
}

function publicDisplay(value) {
  // The venue screen is public by nature, so the operator's selection is
  // public too — but only the selection. Internal fields never cross over.
  const source = object(value);
  const type = ['notice', 'poll', 'draw', 'quiz', 'qa', 'photo'].includes(source.type)
    ? source.type
    : 'idle';
  if (type === 'idle') return { type: 'idle', moduleId: null };
  return {
    type,
    moduleId: typeof source.moduleId === 'string' ? source.moduleId.slice(0, 120) : null,
    noticeId: typeof source.noticeId === 'string' ? source.noticeId.slice(0, 120) : null,
  };
}

function publicWorkspace(value, event, participant = null) {
  const source = object(value);
  const attendeeId = participant && participant.id;
  const fields = array(source.publishedFields).map(publicField).filter((field) => field.id && field.label);
  const allowedFeatures = new Set(array(event.features));
  const modules = array(source.modules)
    .filter((module) => module && module.published === true && module.status !== 'DRAFT' && allowedFeatures.has(module.type))
    .map(publicModule);
  const qaModuleIds = new Set(modules.filter((module) => module.type === 'qa').map((module) => module.id));
  const questions = array(source.questions)
    .filter((question) => question && qaModuleIds.has(question.moduleId) && (
      question.approved === true || (attendeeId && question.participantId === attendeeId)
    ))
    .map(publicQuestion);
  const notices = array(source.notices).filter((item) => item && item.published === true).map((item) => ({
    ...pick(item, ['id', 'title', 'body', 'pinned', 'at']),
    published: true,
  }));
  const program = array(source.program).filter((item) => item && item.published === true).map((item) => {
    const attachment = publicAttachment(item.attachment);
    return {
      ...pick(item, ['id', 'title', 'date', 'start', 'end', 'place', 'location', 'description', 'speaker', 'speakers']),
      ...(attachment ? { attachment } : {}),
      published: true,
    };
  });
  const own = (items) => array(items).filter((item) => item && attendeeId && item.participantId === attendeeId);
  const photos = array(source.photos).filter((item) => item && (
    item.status === 'APPROVED' || (attendeeId && item.participantId === attendeeId)
  ))
    .map((item) => publicPhoto(item, Boolean(attendeeId && item.participantId === attendeeId))).filter(Boolean);
  const posts = array(source.posts).filter((item) => item && (
    item.status === 'APPROVED' || (attendeeId && item.participantId === attendeeId)
  )).map((item) => publicPost(item, Boolean(attendeeId && item.participantId === attendeeId)));
  const answers = participant && object(participant.answers);
  const allowedAnswerIds = new Set(fields.map((field) => field.id));
  const projectedParticipant = participant ? {
    ...pick(participant, [
      'id', 'name', 'company', 'phone', 'email', 'group', 'registrationType', 'status', 'inside',
      'everIn', 'ticket', 'ticketExpiresAt', 'revoked', 'paymentStatus', 'createdAt',
    ]),
    answers: Object.fromEntries(Object.entries(answers).filter(([key]) => allowedAnswerIds.has(key)).map(([key, answer]) => [key, publicValue(answer)])),
    consent: participant.consent && typeof participant.consent === 'object'
      ? pick(object(participant.consent), ['version', 'at'])
      : null,
  } : null;

  const venue = object(source.venue);
  const desks = array(source.desks).map((desk) => pick(desk, ['id', 'name', 'action']));
  const booths = array(source.booths).map((booth) => pick(booth, [
    'id', 'name', 'zone', 'status', 'capacity', 'limit', 'used', 'startsAt', 'endsAt',
  ]));
  const workspace = {
    participants: projectedParticipant ? [projectedParticipant] : [],
    fields: [],
    publishedFields: fields,
    formVersion: Number(source.publishedVersion) || 0,
    publishedVersion: Number(source.publishedVersion) || 0,
    registrationOpen: source.registrationOpen === true,
    approvalRequired: source.approvalRequired === true,
    consentText: text(source.consentText, 3000),
    consentVersion: Number(source.consentVersion) || 1,
    notices,
    program,
    venue: {
      name: text(venue.name, 200),
      address: text(venue.address, 1000),
      directions: text(venue.directions, 2000),
      contact: text(venue.contact, 500),
      description: text(venue.description, 2000),
    },
    groups: [],
    desks,
    booths,
    ...(allowedFeatures.has('stamp') ? {boothMap:{published:publicBoothMap(source.boothMap,booths)}} : {}),
    assignments: [],
    checks: [],
    visits: own(source.visits).map((item) => pick(item, ['id', 'boothId', 'participantId', 'at'])),
    modules,
    responses: own(source.responses).map((item) => ({
      ...pick(item, ['id', 'moduleId', 'participantId', 'answer', 'comment', 'at']),
      ...(item.ratings && typeof item.ratings === 'object' ? { ratings: publicValue(item.ratings) } : {}),
    })),
    questions,
    photos,
    posts,
    messages: [],
    reports: [],
    payments: own(source.payments).map((item) => pick(item, ['id', 'participantId', 'amount', 'status', 'at'])),
    rewards: own(source.rewards).map((item) => pick(item, ['id', 'participantId', 'name', 'status', 'at'])),
    audit: [],
    display: publicDisplay(source.display),
    branding: publicPage(source).branding,
    pageExperience: publicPage(source).pageExperience,
    stampMode: source.stampMode === 'SELF' ? 'SELF' : 'STAFF',
    allowReentry: source.allowReentry !== false,
    price: Math.max(0, Number(source.price) || 0),
  };
  return workspace;
}

function publicBoothMap(value,booths) {
  const published = object(object(value).published);
  const image = publicImage(published.image);
  const sourceImage = object(published.image);
  if (!image || !image.fileId || !Number.isSafeInteger(published.version) || published.version < 1 ||
      !Number.isInteger(sourceImage.width) || !Number.isInteger(sourceImage.height) ||
      sourceImage.width < 1 || sourceImage.height < 1 || sourceImage.width > 10000 || sourceImage.height > 10000) return null;
  const ids = new Set(booths.map(b => b.id)); const seen = new Set();
  const points = array(published.points).filter(p => {
    if (!p || !ids.has(p.boothId) || seen.has(p.boothId) || typeof p.x !== 'number' || typeof p.y !== 'number' ||
        !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return false;
    seen.add(p.boothId); return true;
  }).map(p => ({boothId:p.boothId,x:p.x,y:p.y}));
  return {version:published.version,image:{...image,width:sourceImage.width,height:sourceImage.height},points,publishedAt:text(published.publishedAt,64)};
}

function validParticipant(participant, token, now) {
  if (!participant || participant.ticket !== token || participant.revoked === true || participant.status === 'CANCELLED') return false;
  const expiresAt = Date.parse(participant.ticketExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function createPublicEvents(database) {
  async function findBySlug(slug) {
    const result = await database.query(
      `SELECT e.id, e.slug, e.payload, w.payload AS workspace_payload
       FROM events e LEFT JOIN event_workspaces w ON w.event_id = e.id
       WHERE e.slug = $1 LIMIT 1`,
      [slug]
    );
    return result.rows[0] || null;
  }

  async function loadPublicEvent(slugValue) {
    const slug = String(slugValue || '');
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return null;
    const row = await findBySlug(slug);
    if (!row) return null;
    const event = publicEvent(row);
    if (!event) return null;
    return { event, workspace: publicWorkspace(row.workspace_payload, event) };
  }

  async function loadTicket(eventSlugValue, tokenValue) {
    const slug = String(eventSlugValue || '');
    const token = String(tokenValue || '');
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) || !TICKET_TOKEN.test(token)) return null;
    const row = await findBySlug(slug);
    if (!row) return null;
    const event = publicEvent(row);
    if (!event) return null;
    const source = object(row.workspace_payload);
    const participant = array(source.participants).find((item) => validParticipant(item, token, Date.now()));
    if (!participant) return null;
    const workspace = publicWorkspace(source, event, participant);
    return { event, workspace, participant: workspace.participants[0] };
  }

  return { loadPublicEvent, loadTicket };
}

module.exports = { createPublicEvents, publicEvent, publicWorkspace, validParticipant };
