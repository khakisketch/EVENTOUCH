'use strict';

// Reopened 2026-11-24 (DESIGN.md "행사장 대형 화면 확정 구성", owner: 참여형 장면에 QR 카드,
// mockup locked-five option A): poll, quiz and Q&A scenes carry a white QR card on the
// right. Notices, program, photos and the draw never do. A card that cannot be drawn
// leaves the scene exactly as it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../apps/web/app/screen/[slug]');
const board = fs.readFileSync(path.join(dir, 'DisplayBoard.tsx'), 'utf8');
const card = fs.readFileSync(path.join(dir, 'JoinCard.tsx'), 'utf8');
const page = fs.readFileSync(path.join(dir, 'page.tsx'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'board-stage.module.css'), 'utf8');

function branch(type) {
  const start = board.indexOf(`data.display.type === "${type}"`);
  assert.ok(start > 0, `${type} branch exists`);
  return board.slice(start, start + 700);
}

test('only the poll, quiz and Q&A scenes ask for the card', () => {
  for (const type of ['poll', 'quiz', 'qa']) assert.match(branch(type), /join: true/u, `${type} joins`);
  for (const type of ['notice', 'photo']) assert.doesNotMatch(branch(type), /join: true/u, `${type} does not`);
  assert.doesNotMatch(branch('draw'), /join: true/u, 'the draw keeps its violet and gold stage without a card');
  assert.equal((board.match(/join: true/gu) ?? []).length, 3);
  assert.match(board, /selected\.join && !drawSelected \? <JoinCard slug=\{slug\} publicBase=\{publicBase\} \/> : null/u);
  assert.match(board, /data-join=\{selected\.join && !drawSelected \? "true" : undefined\}/u);
  // The rotating frames (notices, program, venue) are built after the selected return and never join.
  const rotation = board.slice(board.indexOf('const frames: Array'));
  assert.doesNotMatch(rotation, /JoinCard/u);
});

test('the card uses the existing QR renderer and the attendee page address', () => {
  assert.match(card, /import QRCode from "react-qr-code"/u);
  assert.match(card, /\/event\/\$\{encodeURIComponent\(slug\)\}/u, 'the address is the current attendee page');
  assert.match(card, /publicBase \?\? window\.location\.origin/u, 'configured public base first, then this screen\'s origin');
  assert.match(card, /휴대폰 카메라로<br \/>스캔해 참여하세요/u);
  assert.match(page, /configuredPublicBase\(\)/u);
  assert.match(page, /<DisplayBoard slug=\{slug\} publicBase=\{configuredPublicBase\(\)\} \/>/u);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../apps/web/package.json'), 'utf8'));
  assert.ok(pkg.dependencies['react-qr-code'], 'no new dependency: the ticket QR library is reused');
});

test('before the address is known or when the QR fails there is no card', () => {
  assert.match(card, /if \(!url\) return null/u);
  assert.match(card, /getDerivedStateFromError/u);
  assert.match(card, /this\.state\.failed \? null : this\.props\.children/u);
  const { attendeePageUrl } = (() => {
    const ts = require(path.join(__dirname, '../apps/web/node_modules/typescript'));
    const start = card.indexOf('export function attendeePageUrl');
    const source = card.slice(start, card.indexOf('\n}\n', start) + 3).replace('export function', 'function');
    const code = ts.transpileModule(`${source}\nglobalThis.attendeePageUrl = attendeePageUrl;`, { compilerOptions: { target: 'ES2020' } }).outputText;
    const sandbox = { URL, encodeURIComponent, globalThis: {} };
    sandbox.globalThis = sandbox;
    require('node:vm').runInNewContext(code, sandbox);
    return sandbox;
  })();
  assert.equal(attendeePageUrl('', 'han'), '');
  assert.equal(attendeePageUrl('https://eventouch.example', 'han woo'), 'https://eventouch.example/event/han%20woo');
  assert.equal(attendeePageUrl('https://eventouch.example/', 'han'), 'https://eventouch.example/event/han');
  assert.equal(attendeePageUrl('not a url', 'han'), '');
});

test('the card is a white column beside the scene, sized for the back row, in tokens', () => {
  assert.match(css, /\[data-join="true"\]\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/su);
  assert.match(css, /\.joinCard\s*\{[^}]*background:\s*var\(--paper\)[^}]*color:\s*var\(--ink\)/su);
  assert.match(css, /\.joinQr\s*\{[^}]*width:\s*min\(30vh,\s*100%\)/su, 'the QR is about 30% of the screen height');
  assert.match(css, /\.joinCard small\s*\{[^}]*font-size:\s*clamp\(/su, 'the address is room-scale type');
  const block = css.slice(css.indexOf('Reopened 2026-11-24'), css.indexOf('Reopened 2026-11-20: states'));
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/u, 'no raw colours');
  assert.doesNotMatch(block, /border-radius:\s*\d+px/u, 'no raw radii');
});

test('what the audits and the locked composition read is unchanged', () => {
  assert.match(board, /<h2 className=\{drawSelected \? drawStyles\.cinematicHeading : undefined\}>\{selected\.title\}<\/h2>/u);
  assert.match(board, /module\.revealed/u, 'quiz answers stay behind the reveal');
  assert.match(board, /연결 확인 중 · 마지막 화면입니다/u);
});
