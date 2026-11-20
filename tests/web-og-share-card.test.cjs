"use strict";

// Link-preview card (og:image) for shared EVENTOUCH URLs. Source-only: the real
// PNG and tags were checked against a production `next start` (1200x630, og:image
// absolute from EVENTOUCH_PUBLIC_URL). Reopened 2026-11-20.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP = path.join(__dirname, "..", "apps", "web", "app");
const card = fs.readFileSync(path.join(APP, "opengraph-image.tsx"), "utf8");
const layout = fs.readFileSync(path.join(APP, "layout.tsx"), "utf8");
const compose = fs.readFileSync(path.join(__dirname, "..", "docker-compose.yml"), "utf8");

test("a default 1200x630 PNG card is served for every route through the root segment", () => {
  assert.match(card, /export const size = \{ width: 1200, height: 630 \};/);
  assert.match(card, /export const contentType = "image\/png";/);
  assert.match(card, /export const runtime = "nodejs";/);
  assert.match(card, /export default async function OpengraphImage/);
});

test("the card draws EVENTOUCH on the brand gradient and loads Pretendard for Hangul", () => {
  assert.match(card, /EVENTOUCH/);
  assert.match(card, /행사 운영 워크스페이스/);
  assert.match(card, /linear-gradient\(135deg, #EA552E/);
  assert.match(card, /Pretendard-ExtraBold\.otf/);
  assert.match(card, /Pretendard-Bold\.otf/);
});

test("metadata resolves absolute share URLs from EVENTOUCH_PUBLIC_URL at request time", () => {
  assert.match(layout, /export async function generateMetadata\(\)/);
  assert.match(layout, /configuredPublicBase\(\)/);
  assert.match(layout, /metadataBase: base \? new URL\(base\) : undefined/);
  assert.match(layout, /twitter: \{ card: "summary_large_image"/);
  assert.equal(/export const metadata/.test(layout), false, "metadata and generateMetadata cannot both be exported");
});

test("the web container receives the same public origin the API uses", () => {
  const webBlock = compose.slice(compose.indexOf("\n  web:"), compose.indexOf("\nnetworks:"));
  assert.match(webBlock, /EVENTOUCH_PUBLIC_URL: \$\{EVENTOUCH_PUBLIC_URL:-\}/);
});
