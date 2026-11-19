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
  // Content rows title themselves with h3 since the confirmed programs ledger (2026-11-14).
  assert.match(boundaries, /const headingSelector = 'h3\[id\^="module-title-"\]'/u);
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

for (const [name, route] of [
  ['application-fields', '/console/events/:id/settings/fields'],
  ['account-email', '/account/email'],
  ['recover', '/recover'],
]) {
  test(`the review captures the standalone ${name} screen`, () => {
    const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
    assert.ok(audit.includes(`['${name}', '${route}',`), `${route} must be an actual captured destination, not implied by its parent`);
  });
}

test('every non-redirect application page has an actual capture destination', () => {
  const ts = require('../apps/web/node_modules/typescript');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  const file = ts.createSourceFile('audit.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const normalized = value => value.split('?')[0].replace(/\[[^\]]+\]|:[a-zA-Z]\w*/g, ':parameter');
  const destinations = new Set();
  const visit = node => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length >= 3 && ts.isStringLiteral(node.elements[0])) {
      const route = node.elements[1];
      const value = ts.isStringLiteral(route) || ts.isNoSubstitutionTemplateLiteral(route) ? route.text
        : ts.isTemplateExpression(route) ? route.head.text + route.templateSpans.map(span => ':parameter' + span.literal.text).join('') : '';
      if (value.startsWith('/')) destinations.add(normalized(value));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const pages = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.name === 'page.tsx') pages.push(filename);
    }
  };
  const app = path.join(__dirname, '../apps/web/app');
  walk(app);
  const routes = pages.map(filename => normalized('/' + path.relative(app, path.dirname(filename)).split(path.sep).join('/')));
  const missing = covered => routes.filter(route => route !== '/staff/login' && !covered.has(route));
  assert.deepEqual(missing(destinations), [], 'a parent screen is not coverage for a standalone page');
  const withoutRecovery = new Set(destinations); withoutRecovery.delete('/recover');
  assert.ok(missing(withoutRecovery).includes('/recover'), 'the coverage gate detects a missing real destination');
  assert.match(read('staff/login/page.tsx'), /redirect\(safe \? `\/login\?next=/);
});

test('overview role check follows the live primary contract instead of an always-orange approval', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  assert.doesNotMatch(audit, /\[data-task="approval"\] a/);
  assert.match(audit, /overviewStage === 'LIVE'/u);
  assert.match(audit, /live task queue stays ghost/u);
  assert.match(audit, /first task owns the single primary/u);
  assert.match(audit, /archived overview keeps no primary/u);
});

test('draws and rewards markers wait on the actual named regions', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  assert.ok(audit.includes(`['draws', '/console/events/:id/draws', 'section[aria-label="무대"]']`), 'stage ids are dynamic per kind');
  assert.ok(audit.includes(`['rewards', '/console/events/:id/rewards', { role: 'link', name: '참가자 명단' }]`), 'empty rewards have no list region, so wait for the loaded page action');
  assert.doesNotMatch(audit, /#draws-programs|#rewards-list/);
  assert.ok(audit.includes("getByRole('heading', { name: '무대 선택', exact: true })"));
  assert.ok(audit.includes("picker.getByRole('button', { pressed: true })"));
  assert.match(audit, /참여 이벤트에서 추첨 무대를 만들고 공개하세요/u);
});

test('white product readiness follows loaded content, design, settings and reports rather than closed editors', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  for (const marker of ['#content-panel', '#theme-save-draft', '#settings-basics']) assert.ok(audit.includes(marker), marker);
  assert.ok(audit.includes("{ role: 'tab', name: /^보고서/ }"));
  assert.doesNotMatch(audit, /#content-notices|#home-intro|#set-name|#reports-list/);
});

test('account-form captures explicitly use mock-only mail and never request delivery', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  assert.match(audit, /process\.env\.EVENTOUCH_MAIL_MOCK = '1'/);
  assert.match(audit, /process\.env\.EVENTOUCH_PUBLIC_URL = 'http:\/\/127\.0\.0\.1:1'/);
  assert.match(audit, /mockOutbox\.length === initialMailCount/);
  assert.ok(audit.includes("account.getByRole('alert')"), 'framework route announcements are outside account-form error checks');
});

test('attendee icon geometry measures visible text instead of an obsolete CSS class', () => {
  const audit = fs.readFileSync(path.join(__dirname, '../scripts/web-white-product-audit.cjs'), 'utf8');
  assert.doesNotMatch(audit, /querySelector\('\[class\*="menuLabel"\]'\)/);
  assert.match(audit, /labelRight: label\?\.right/);
  assert.match(audit, /item\.labelRight <= item\.buttonRight \+ 1/);
  assert.match(audit, /item\.iconBottom <= item\.labelTop \+ 1/);
});
