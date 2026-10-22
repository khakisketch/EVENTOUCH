// Attendee registration: the form states the outcome, recovers from a
// duplicate application, and puts phone verification before the fields it
// gates.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const form = read("apps/web/app/event/[slug]/register/RegisterForm.tsx");

test("the registration form states what the attendee gets", () => {
  assert.match(form, /참가 티켓이 바로 발급됩니다/u);
  assert.match(form, /registration-lead/u);
});

test("phone verification comes before the fields it gates", () => {
  const verification = form.indexOf('className="verification-panel"');
  const fields = form.indexOf("{fields.map((field) => {");
  assert.ok(verification > 0 && fields > 0);
  assert.ok(verification < fields, "verification must not be the thing an attendee discovers after typing everything");
});

test("a duplicate application offers the way back to the ticket", () => {
  assert.match(form, /alreadyRegistered/u);
  assert.match(form, /이미 신청하신 연락처로 등록되어 있습니다/u);
  assert.match(form, /ticket\/recover/u);
});

test("the attendee's keyboard can fill the common fields", () => {
  assert.match(form, /field\.id === "name" \? "name"/u);
  assert.match(form, /field\.id === "email" \? "email"/u);
  assert.match(form, /field\.id === "company" \? "organization"/u);
  assert.match(form, /field\.id === "phone" \? "tel"/u);
});
