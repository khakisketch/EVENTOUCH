'use strict';

// Current visual-token smoke checks, not a mandate for every future screen.
// Permission/receipt tests remain independent from presentation choices.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../apps/web/app', file), 'utf8');

test('current design tokens preserve the product white/orange reference', () => {
  const css = read('tokens.css');
  for (const token of ['--paper: #FFFFFF;', '--ground: #FFFFFF;', '--workspace-ground: #FFFFFF;', '--nav: #FAFBFC;', '--brand: #EA552E;', '--brand-hover: #C7441C;', '--on-brand: #19191C;', '--brand-text: #8E351F;', '--ink: #1E2026;', '--muted: #61656C;', '--line: #E5E5E7;', '--focus: #2453A6;', '--radius-medium: 12px;', '--radius-large: 16px;', '--radius-card: 18px;', '--h1: 28px;', '--body-work: 15px;']) {
    assert.ok(css.includes(token), token);
  }
  assert.match(css, /--display-font: var\(--body-font\);/u);
  assert.match(css, /--body-font: 'Pretendard Variable'/u);
});

test('workbench and overview backgrounds cannot accidentally inherit stage black', () => {
  for (const file of ['console/events/[id]/participants/participants.module.css', 'console/events/[id]/messages/MessagingWorkspace.module.css', 'console/events/[id]/event-overview.module.css']) {
    assert.doesNotMatch(read(file), /background:\s*var\(--stage(?:-2)?\)/u, file);
  }
});

test('message preview is escaped and clearly identifies synthetic substitutions', () => {
  const source = read('console/events/[id]/messages/MessagingWorkspace.tsx');
  const start = source.indexOf('<section className={styles.draftPreview}');
  const end = source.indexOf('</section>', start);
  assert.ok(start >= 0 && end > start, 'the actual preview region must exist');
  const preview = source.slice(start, end + '</section>'.length);
  assert.match(preview, /aria-labelledby="message-preview-heading"/u);
  assert.match(preview, /id="message-draft-preview"/u);
  assert.match(preview, /previewMessageExample\(campaignDraft\.body, state\.eventName, state\.eventDate\)/u);
  assert.match(preview, /이름·티켓 링크·번호는 예시입니다/u);
  assert.match(preview, /실제 내용과 길이, 문자 유형은 수신자별로 달라질 수 있습니다/u);
  assert.doesNotMatch(preview, /아직 저장·발송하지 않았습니다/u, 'a committed response may be lost; the preview cannot assert non-delivery');
  assert.doesNotMatch(preview, /dangerouslySetInnerHTML|replaceAll|ticket\}|ticket\.|fetch\(|postCommand|executeCampaignCreate/u);
});

test('invitation states use the same open auth frame without heading eyebrows', () => {
  const page = read('invite/[token]/page.tsx');
  const accept = read('invite/[token]/InviteAccept.tsx');
  assert.match(page, /auth-page invite-page/u);
  assert.match(page, /className="auth-brand"/u);
  assert.match(accept, /auth-card invite-card/u);
  assert.doesNotMatch(page + accept, /className="eyebrow"/u);
  assert.match(read('globals.css'), /\.invite-page \.invite-card\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;/su);
});

test('theme verification owns SSR and never targets a running external web server', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/web-theme-audit.cjs'), 'utf8');
  assert.match(source, /startOwnedNext\(\{ apiBase: harness\.baseUrl \}\)/u);
  assert.match(source, /webBase: owned\.baseUrl/u);
  assert.doesNotMatch(source, /process\.env\.WEB_BASE|127\.0\.0\.1:8777/u);
  assert.match(source, /owned\.close\(\)/u);
  assert.match(source, /if \(name === 'attendee.page.publish-reviewed'\)/u);
  assert.match(source, /getByRole\('button', \{ name: '게시하기', exact: true \}\)\.click\(\)/u);
  assert.match(source, /opening review never publishes/u);
});

test('console fixtures cross browser filesystems as bytes and keep real QR decoding', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-console-audit.cjs'), 'utf8');
  assert.match(audit, /name: 'ops-map-fixture\.png', mimeType: 'image\/png', buffer:/u);
  assert.match(audit, /EVENTOUCH_CAMERA_MEDIA_ROOT/u);
  assert.match(audit, /--use-file-for-fake-video-capture=\$\{cameraVideo\}/u);
  assert.match(audit, /fs\.unlinkSync\(cameraVideo\)/u);
  const boundaries = fs.readFileSync(path.join(__dirname, '../scripts/web-console-boundaries.cjs'), 'utf8');
  assert.match(boundaries, /const headingSelector = 'h2\[id\^="module-title-"\]'/u);
  assert.match(boundaries, /const fill = 12/u);
  assert.match(boundaries, /headings\[24\]/u);
});

test('message preview does not replace recipient review or explicit command confirmation', () => {
  const source = read('console/events/[id]/messages/MessagingWorkspace.tsx');
  assert.match(source, /id="campaign-recipients"/u);
  assert.match(source, /id="campaign-submit"/u);
  assert.match(source, /<ConsoleConfirm\s+summary=\{confirmLines\(sendPending\.summary\)\}/u);
  assert.match(source, /void executeCampaignCreate\(pending\)/u);
});

test('published attendee appearance remains event-local, including non-white choices', () => {
  const home = read('event/[slug]/home/home.module.css');
  assert.match(home, /background: var\(--home-background-color, #b9def0\)/u);
  assert.match(home, /var\(--home-viewport-height\)/u);
  assert.doesNotMatch(read('globals.css'), /--home-background-color:/u);
  assert.match(read('tokens.css'), /--ref-navy: #2E3D5B;/u);
});

test('the full-product renderer owns isolated fixtures and checks actual loaded routes', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  assert.match(audit, /startAuditFixture\(\)/u);
  assert.match(audit, /\[1440, 1280, 390, 320\]/u);
  assert.match(audit, /waitFor\(\{ state: 'visible' \}\)/u);
  assert.match(audit, /violations\.length === 0/u);
  assert.match(audit, /all collected checks must pass/u);
  assert.match(audit, /published customer style survives the white shell/u);
  assert.doesNotMatch(audit, /process\.env\.WEB_BASE|127\.0\.0\.1:8891/u);
});
