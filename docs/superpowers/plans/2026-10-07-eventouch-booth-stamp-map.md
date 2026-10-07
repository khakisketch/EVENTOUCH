# EVENTOUCH Booth Stamp Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Preserve the previously selected inline execution method; bounded helpers are optional under the workspace/ownership policy. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 운영자가 배치도에 기존 부스 위치를 지정하고 참가자가 지도와 목록에서 본인의 서버 확정 스탬프 인증 현황을 확인한다.

**Architecture:** 기존 행사 JSONB workspace에 지도 초안/게시본을 추가하고 기존 `booth.visit` 기록으로 완료 상태를 파생한다. 파일은 PostgreSQL Task8 공통 파일 API에 연결하며, 기존 `#/event/:slug/stamp` 화면을 확장한다. Build는 서버/데이터/전송/검증을, 연결된 디자인 워크스페이스는 실제 UI 소스와 렌더 리뷰를 맡는다.

**Tech Stack:** 현재 Node/CommonJS/`node:test`/PostgreSQL/`pg`/vanilla HTML·JS·CSS. 새 라이브러리, 외부 지도 공급자, 위치 API 없음.

**Spec:** `docs/superpowers/specs/2026-10-07-eventouch-booth-stamp-map-design.md` (written design and implementation plan approved; user requested development).

## Global Constraints

- 인증 기준: 서버가 확정한 기존 `booth.visit` 기록. QR 해독만 성공하거나 요청을 보내기만 한 상태는 완료가 아니다.
- 제외: GPS, 현재 위치, 마지막 인증 위치 강조, 위치 추적, 길 찾기, 위치 확인용 QR, 구역/다각형 그리기, 외부 지도 공급자, 새 보상 규칙.
- 기존 SELF/STAFF 인증 방식, 입장·티켓 검증, 운영 시간·수량·인당 횟수·권한·멱등성은 그대로 유지한다.
- 한 행사 배치도 한 장, PNG/JPEG/WebP. PDF 지도 편집은 제외한다.
- 지도 변경에 결제 체험·공급자 연동을 추가하지 않는다. 기존 결제 코드·데이터 제거는 별도 범위다.
- 실제 시각 소스/스타일/반응형 수정은 디자인 워크스페이스 소유. Build가 대체 UI나 CSS 수정을 만들지 않는다.
- 운영 DB 접속·배포·외부 게시·새 지도 서비스·의존성 설치는 이 설계 승인에 포함하지 않는다. 제품 승인과 기술 검증은 구분한다.
- 검증은 승인된 격리 PostgreSQL과 가상 계정/행사만 사용한다. `EVENTOUCH_TEST_DATABASE_URL`은 기존 승인된 테스트 환경에서 제공하며, 미설정으로 건너뛴 검사는 통과로 기록하지 않는다.

## Review Focus

- 이미지 교체·초안 저장 중 기존 게시본은 유지되어야 하며, 교체 이미지에 이전 핀이 잘못 붙으면 안 된다 (Task2 replacement/publish tests, Task4 browser).
- 동일 이름/반복 인증/지도 미배치/종료 부스는 ID 기반으로 정확히 집계되어야 한다 (Task3 literal-fixture summary tests).
- 공개 파일 URL로 다른 행사 파일이나 지도 초안·비공개 사진을 읽을 수 없어야 한다 (Task1 file-boundary tests, Task2 projection tests).
- STAFF 기기의 인증 성공은 참가자 재조회 후에만 완료로 보이고, 실패한 QR은 완료 표시를 만들면 안 된다 (Task4/5 changed-flow tests).
- 확대·터치·키보드·이미지 오류에서도 핀과 목록을 사용할 수 있어야 하며, 등록/티켓/스태프 화면이 회귀하면 안 된다 (Task4 renders, Task5 integrated regression).

## Binding and Dependencies

- Current product workspace: `/home/ksi/Desktop/SI-Projects/EVENTOUCH/.worktrees/eventouch-postgres`, `feat/eventouch-postgres`; implementation base `6bf0e56`, map-spec commit `fd7efb5`. Recheck actual HEAD/status before execution; preserve pending Task7/design changes.
- Existing ledger: `docs/superpowers/plans/2026-10-07-eventouch-postgresql.md`; Tasks7–8/M1 not closed. Invitation helper `4d12110` remains in its dedicated worktree, not integrated. Attendee browser-first output still needs rendered review.
- Design project: `5601983f-a74b-4199-8c6d-969623f020c6`, exact product folder, entry `index.html`, brand `assets/css/tokens.css`. Verify binding/input access before writes. Preserve the existing inspection server and data; it is not a disposable restart fixture.
- This plan does not duplicate Task8 or claim existing M1 complete. Finish/integrate the required current adapter/invitation/file paths first, recording evidence in the existing workstream. Shared files have one writer; concurrent code writers require separate task-owned worktrees.
- Plan checklist: [ ] common-file prerequisite; [ ] map server/projection; [ ] client data contracts; [ ] design implementation/render review; [ ] integrated evidence and scoped closeout.

---

### Task 1: Complete/reuse the common PostgreSQL file prerequisite

**Files:** Reuse/update Task8-owned `server/api.js`, `server/server.js`, `tests/server-files.test.cjs`, `docs/DEPLOY.md`; create `server/files.js`, `server/image-metadata.js`, `server/migrations/002_stored-file-dimensions.sql`, `tests/server-image-metadata.test.cjs` if not already produced by Task8. Hyphenated migration slug follows the existing runner's filename filter. Do not create a second file service if equivalent work has landed.

**Interfaces:** `createFileService(database,{storageDir})` produces `upload({account,eventId,commandId,name,contentType,bytes}) -> FileRef`, `readOperator({account,eventId,fileId}) -> StoredFile`, and `readPublic({slug,fileId}) -> StoredFile`; `StoredFile` has a private server-side absolute path plus `FileRef`. `FileRef={fileId,name,type,size,width?,height?}` never contains storage paths. `inspectImage(bytes,contentType)->{width,height}` uses bounded PNG/JPEG/WebP headers and rejects unsupported/truncated headers; both dimensions must be integers in1..10000. Metadata parsing is not a claim that a browser can decode every image.

- Upload route: existing `POST /api/events/:eventId/files?name=...&commandId=...`, raw body, AGENCY/MANAGER with current event access; general limit remains8MiB. Map references follow the existing image-consumer ceiling600000 bytes, not a silent increase. Reject inline data/remote URLs, MIME mismatch and paths. Browser decoding/failure fallback remains required.
- Read routes: `GET /api/events/:eventId/files/:fileId` requires AGENCY/MANAGER access; STAFF denied. `GET /api/public/events/:slug/files/:fileId` serves only references reachable from that event's currently published/public content, including the published map when stamp is enabled. Draft-only/unreferenced/private/cross-event files return404. Never expose `storage_key`.
- Store bytes under Task8 `STORAGE_DIR`; metadata in `stored_files`. Migration adds nullable `width_px`/`height_px` with paired-positive validation. Generated names, capped writes, transaction/idempotency, upload rollback cleanup and restart persistence are common Task8 responsibilities.

- [ ] Write real API tests `map_image_upload_is_event_scoped`, `public_read_rejects_draft_or_foreign_file`, `staff_file_read_denied`, `same_upload_id_does_not_create_duplicate`, and metadata table cases (valid PNG/JPEG/WebP, truncated header, MIME mismatch, impossible dimensions). Assert stored bytes/dimensions, no raw storage key in response,201/200 success and403/404 denial.

For a real320×200 image fixture and the HTTP helper's response envelope, pin literal consumer expectations:

```js
assert.equal(up.status, 201);
assert.equal(up.json.file.width, 320);
assert.equal(up.json.file.height, 200);
assert.equal(Object.hasOwn(up.json.file, 'storage_key'), false);
assert.equal(draftOnlyPublicRead.status, 404);
assert.equal(staffRead.status, 403);
```

- [x] Run `node --test tests/server-files.test.cjs tests/server-image-metadata.test.cjs` in the isolated DB environment; observe the missing PostgreSQL-file behavior failing before implementing it. Existing JSON `evt-1` roundtrip tests migrated to real PostgreSQL events; primary focused GREEN10/10 (independent combined check pending).
- [ ] Implement/reconcile the shared service and wire actual routes; re-check auth inside writes, fingerprint same-command uploads, remove only newly owned failed-upload bytes, preserve files on HTTP restart. Complete relevant Task8 documentation without starting Compose/deployment.
- [ ] Re-run these tests and current server regressions: `node --test tests/server-*.test.cjs`. Expected: new/current server tests pass,0 skips; classify remaining legacy UI failures separately.
- [ ] Independently verify and commit only Task8/file-owned changes at a coherent milestone; reuse an existing verified Task8 commit if this prerequisite has already been delivered.

### Task 2: Transactional map drafts, publication and public projection

**Files:** Create `server/commands/booth-map.js`, `tests/server-booth-map.test.cjs`; modify `server/commands/domain.js`, `server/state.js`, `server/public-events.js`, and `tests/server-public-event.test.cjs`. Keep existing booth certification code unchanged unless a failing contract test requires a scoped correction.

**Interfaces:** `booth-map.js` exports `COMMANDS` plus `async apply(ctx)->{status?,body}` using the existing domain executor context (`client,event,workspace,actor,now,input,command,resolveFile`). Register `booth.map.save/publish/unpublish` in the domain command set and dispatcher; none is a guest command. Map commands require stamp enabled, current AGENCY/MANAGER event access, and non-ARCHIVED event. Extend the existing domain `resolveStoredFile` query to retrieve Task1 dimension metadata and return it through `ctx.resolveFile`, without changing existing file consumers'600000-byte policies; the map rejects an image whose verified dimension metadata is absent.

- `boothMap={draft:null,published:null}` is the backward-compatible default. Draft is `{version,image:FileRef,points:[{boothId,x,y}]}`; published adds `publishedAt` and uses the source draft version.
- Save input `{fileId,points,expectedDraftVersion}`;0 denotes no prior draft. Versions increment once per successful save. Validate numeric finite x/y in inclusive[0,1], unique same-event booth IDs and image metadata from the file service/DB; never trust client dimensions. A conflicting draft version returns409.
- Replacing an existing draft image requires `points:[]`; reject stale nonempty positions with409. A later save may place new pins. Initial map creation may contain positions. The existing published snapshot stays unchanged throughout draft edits.
- Publish input `{expectedDraftVersion}` validates current file/booths again and deep-copies the draft. Unpublish input `{expectedPublishedVersion}` clears only the matching published snapshot (already unpublished is an idempotent no-op). Neither operation changes booths/visits. Existing command receipts protect retries.
- Public projection adds `boothMap:{published:...}` only for stamp-enabled public events; no draft. Remove orphan pin IDs from projection without deleting history. Public map file allowlist must use this same publication state, not arbitrary workspace references.

- [ ] Write tests `draft_is_not_public`, `publish_is_snapshot`, `replacement_clears_positions_and_preserves_publication`, `coordinate_and_booth_boundaries`, `foreign_file_rejected`, `guest_staff_and_foreign_manager_denied`, `archived_rejected`, `command_retry_and_version_conflict`, `unpublish_preserves_visits`, `orphan_pin_hidden`. Use literal expected coordinates/version/count and real PostgreSQL routes.

For a published version1 and a later version2 draft, require:

```js
assert.equal(publicRead.json.workspace.boothMap.published.version, 1);
assert.equal(Object.hasOwn(publicRead.json.workspace.boothMap, 'draft'), false);
assert.deepEqual(replacedDraft.points, []);
assert.equal(stalePublish.status, 409);
assert.deepEqual(afterUnpublishVisits, beforeUnpublishVisits);
```

- [x] Map command tests observed RED6 missing-command failures before code, then GREEN6/6 alongside file/metadata GREEN16/16; independent combined regression check pending.
- [ ] Implement the module/context wiring, normalization and allowlisted projection. Save/post failures roll back both draft and audit/receipt; publish locks the event with existing domain executor.
- [ ] Re-run focused tests plus `node --test tests/server-domain-commands.test.cjs tests/server-operations.test.cjs tests/server-public-event.test.cjs`; expect zero new failures/skips and unchanged certification semantics.
- [ ] Independent Test Runner checks the integrated server revision, then commit only map/server tests owned by this task.

### Task 3: Client data/transport contracts without visual implementation

**Files:** Create `assets/js/booth-map-data.js`, `tests/booth-map-data.test.cjs`; modify `assets/js/server-sync.js`, `tests/server-sync-client.test.cjs`, and mechanical script inclusion in `index.html`.

**Interfaces:** `E.boothStampSummary(booths,visits,participantId)->{total,completed,visitedBoothIds}` deduplicates current booth IDs and own confirmed visits; for no valid participant use `completed:null`, not0. `E.remote.uploadFile(file,{eventId,commandId})->FileRef` sends raw bytes with same-origin credentials and stable retry identity. `E.remote.fileURL({eventId,fileId,slug?,public:false})->sameOriginPath` uses Task1 operator/public routes; rejects missing/unsafe IDs. Map editing calls existing `E.run` with Task2 payloads.

- [ ] Write summary fixture tests with two same-name booths, repeated visits, foreign participant visits, an orphan visit, unplaced and CLOSED booths. Example booth IDs a/b/c plus own visits a/a/orphan produce total3/completed1; guest produces completednull and no visited IDs.

```js
const booths = [{id:'a',name:'같은 이름'}, {id:'b',name:'같은 이름'}, {id:'c',status:'CLOSED'}];
const visits = [
  {boothId:'a',participantId:'me'}, {boothId:'a',participantId:'me'},
  {boothId:'b',participantId:'other'}, {boothId:'orphan',participantId:'me'}
];
assert.deepEqual(E.boothStampSummary(booths, visits, 'me'),
  {total:3,completed:1,visitedBoothIds:['a']});
assert.deepEqual(E.boothStampSummary(booths, visits, null),
  {total:3,completed:null,visitedBoothIds:[]});
```

- [ ] Write upload/URL transport tests asserting raw bytes (not JSON/base64), credentials, normalized FileRef without paths, preserved HTTP errors, stable commandId after lost response and no local authoritative write. Register map command declarations in `E.handlers` so existing local authorization accepts group `booth`; explicit preview rejects new map writes with an explanatory error rather than calling the shared server.
- [x] Run `node --test tests/booth-map-data.test.cjs tests/server-sync-client.test.cjs`; observed missing-summary/transport RED5/25 before implementation, then GREEN25/25. Independent combined check pending.
- [ ] Implement only calculation/validation/transport/command declarations; no generated markup/styles/interaction layout. Include the data module before server adapter/startup and preserve current load-order overrides.
- [ ] Re-run focused tests and `node --check` for changed JS; independently verify and commit the nonvisual client slice. Leave actual map file/pin rendering to Task4.

### Task 4: Design-owned editor and attendee stamp-map rendering

**Files:** Design-owned `assets/js/booth-map-ui.js`, `assets/css/booth-map.css`, `tests/booth-map-presentation.test.cjs`; narrowly integrate existing `assets/js/attendee.js`, `assets/js/field.js` or current booth-view source, and `index.html`. Exact shared-file ownership is handed off sequentially; Build must not visually adapt the output.

**Interfaces:** Operate on Task2 `boothMap`, Task3 helpers and current `E.run`/routes/actions. Extend the existing organizer booth management, not event-creation wizard requirements. Attendee entry remains `#/event/:slug/stamp`; render public map/list before the existing ticket-only certification controls, without weakening guest restrictions for other modules.

- [ ] Confirm actual product source/write binding, readable representative floorplan asset and required states. Perform focused Mobbin research only for the unresolved map/editor pattern; keep canonical links and locally readable permitted images. No external brand assets or fabricated client floorplan.
- [ ] Give the design run the approved spec, real sources, file/map/certification contracts, existing tokens and sanitized fixtures. Preserve brand and browser-first shell. Select live implementation skill and record it; commission local execution only.
- [ ] Require semantic controls, click/touch and numeric-coordinate placement (dragging optional), save/publish/unpublish separation, map zoom/pan with normalized pins, selectable booth details, textual/icon completion marks, all-booth list and own completed/total summary. No public fake0 count without a ticket. Staff-certified progress updates only after explicit server reread/re-entry; no new push/polling.
- [ ] Design owner writes presentation contract tests against actual output; capture missing behaviors RED before its changes. Source tests do not prove render quality. Reconcile actual output files/hashes, not canonical-entry status alone.
- [ ] Host browser captures real editor/attendee at390×844 and1280×900; also320/768 overflow checks. Cover image loading/error, unpublished/no map,0 booths, unplaced/duplicate-name/CLOSED booth, no ticket, own completed/not-completed, keyboard/focus, zoom/pan and failed certification. Verify real save→publish→independent public read; do not label reconstructed presentation states as fresh backend writes.
- [ ] Commission a separate read-only review skill such as discovered `web-design-guidelines`, using the exact source snapshot and captures. Confirm images actually read. Track criterion→defect(screen/state/impact/desired result)→revision→render evidence→fixed/open; send visual repairs back to design until closure or a concrete blocker. Use axe when available, do not install or claim actual screen-reader/real-device testing without evidence.
- [ ] Re-run functional/source checks after refinements. Deliver product link labeled temporary/tailnet-only if applicable, target-viewports before/after captures and refreshed design preview/studio link with any missing preview disclosed. Independently verify before committing design-owned files.

### Task 5: Integrated stamp journey, persistence and evidence closeout

**Files:** Create `tests/server-booth-map-journey.test.cjs`; maintain this plan, `docs/superpowers/product-state.md`, and the existing workstream evidence/handoff. Do not commit `.opencode/working-state.md`, capture inputs, credentials or unrelated pending changes.

**Interfaces:** Uses actual Task1 files + Task2 map commands/projection + Task3 transport + reviewed Task4 product UI. Existing signup/ticket/check-in and SELF/STAFF authorization remain the binding product contracts.

- [ ] Write/API-test organizer upload→draft→publish→guest map/no personal data→signup/ticket→desk IN→SELF booth certification→ticket reread/summary. Separately test assigned STAFF certification in a STAFF-mode event, denied wrong booth/ticket/assignment, closed booth, repeated commandId and mixed old/orphan visit records. Assert no fabricated completion and exactly one confirmed visit per retried command.

```js
assert.equal(firstCertification.status, 201);
assert.equal(replayedCertification.status, 200);
assert.equal(ownTicketRead.json.workspace.visits.length, 1);
assert.deepEqual(guestRead.json.workspace.visits, []);
assert.equal(restartedOwnTicketRead.json.workspace.visits.length, 1);
assert.equal(restartedMapRead.json.workspace.boothMap.published.version, 1);
```

- [ ] Exercise the same changed product flows in separate real browser sessions, including map pin/list consistency, publication persistence on reload, successful certification marks and failed scan remaining unmarked. Preserve current user inspection fixtures; use separate owned synthetic fixtures when needed.
- [ ] Restart only a separate test HTTP fixture against its unchanged isolated schema/files and re-read the same public map, own visits and session-bound state. Restarting with a new schema is not persistence evidence. No production/test-container/inspection-server restart implied.
- [ ] Independent Test Runner executes `node --test tests/server-*.test.cjs tests/booth-map-data.test.cjs tests/booth-map-presentation.test.cjs tests/attendee-browser-presentation.test.cjs` with approved DB environment, syntax and diff checks, followed by full `npm test`. Record actual revision/pending file hashes/counts/skips and all full-suite failures. Fix introduced failures; legacy-suite reconciliation remains recorded M1 work, never claim full green when failures remain.
- [ ] One fresh read-only whole-branch reviewer checks map/file/privacy and the Review Focus against actual code/evidence. Resolve important findings with regression tests and rerun affected independent checks; keep minor nonblocking findings in backlog.
- [ ] Commit only verified task-owned changes; reconcile ledgers/checkpoint/product-state. Report separately: implemented, design-reviewed, functionally verified, user-accepted, externally delivered. Map technical completion does not close M1 or authorize deployment. Retain any dirty/unintegrated helper worktree until its own safe integration/cleanup is proven.

## Plan Self-Review and Handoff

Coverage: spec§1–2→constraints/dependencies;§3/5→Tasks1–2/4;§4→Tasks2–3/5;§6→Task4;§7→Task5. Producer/consumer field names and routes are defined above; no inline storage/GPS/new provider path. Review Focus cases each have assigned tests. Reconcile Task8 producer contracts if already implemented instead of blindly recreating them.

Written design and implementation plan approved; executing inline under the user's development request. New scope/external effects/security-sensitive changes retain their gates.
