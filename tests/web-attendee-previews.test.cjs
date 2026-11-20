'use strict';

// Reopened 2026-11-20 (attendee consolidation): the console phone previews wear the
// attendee look (a1/a2) with the guide's own sections, attendeeLook lives in lib, the
// guide reads the published look through readAttendeeTheme, and a pinned notice glyph
// stays visible on a dark event color.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps/web');
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');

test('console phone previews wear the attendee look and keep no private ink algorithm', () => {
  const content = read('app/console/events/[id]/content/ContentPhonePreview.tsx');
  assert.doesNotMatch(content, /function readableInk|function luminance/u, 'the ink comes from lib/attendee-home');
  assert.match(content, /import \{ readableInk[^}]*\} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/attendee-home"/u);
  assert.match(content, /<AttendeeSurface\b/u);
  assert.match(content, /attendeeLook\(design\.homeStyle, design\.accent\)/u);
  assert.match(content, /<GuideSection\b/u);
  assert.match(content, /<GuideNoticeList\b/u);
  assert.match(content, /<GuideVenueCard\b/u);
  assert.match(content, /accent=\{design\.accent\}/u, 'the home screen gets the published 강조색 too');
  const guide = read('app/event/[slug]/page.tsx');
  assert.match(guide, /readAttendeeTheme\(slug, workspace\)/u, 'the guide reads the published look in one place');
  assert.doesNotMatch(guide, /function keyvisualSource|function text\(/u);
  for (const part of ['GuideSection', 'GuideNoticeList', 'GuideVenueCard']) assert.match(guide, new RegExp(`<${part}\\b`, 'u'), `the public guide draws its sections with ${part}`);
  const fields = read('app/console/events/[id]/settings/fields/FieldsPhonePreview.tsx');
  assert.match(fields, /<AttendeeSurface\b/u);
  assert.match(fields, /attendeeLook\(theme\.homeStyle, theme\.accent\)/u);
  const theme = read('app/console/events/[id]/page/ThemeWorkspace.tsx');
  assert.equal((theme.match(/accent=\{showingPublished \? state\.publishedPageFields\.accent : state\.pageFields\.accent\}/gu) ?? []).length, 2, 'both studio phones pass the 강조색');
  assert.ok(fs.existsSync(path.join(WEB, 'lib/attendee-look.ts')), 'attendeeLook lives in lib');
  assert.ok(!fs.existsSync(path.join(WEB, 'app/event/[slug]/attendee-look.ts')));
});

test('a pinned notice glyph takes the bubble ink, not the svg default that vanished on a dark event color', () => {
  const css = read('app/event/[slug]/public-event.module.css');
  // .menuIcon sets color on the svg itself, so the bubble's color never reached the glyph.
  assert.match(read('app/event/[slug]/home/home.module.css'), /\.menuIcon\s*\{[^}]*color:\s*var\(--ink\)/u);
  assert.match(css, /\.noticeList li\[data-pinned\] \.noticeIcon\s*\{[^}]*background:\s*var\(--ev-accent[^}]*color:\s*var\(--ev-on-accent/u);
  assert.match(css, /\.noticeList li\[data-pinned\] \.noticeIcon :global\(svg\)\s*\{\s*color:\s*inherit;/u);
});
