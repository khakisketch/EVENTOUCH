# Customer proposal and acceptance boundaries

The customer proposal PDF and demo prototype were removed from the repository. This mapping preserves their requirements, not their proposed screen or implementation. It is not evidence that the customer has accepted the differences below. Code and tests define implementation; written customer agreement and real-world observations define acceptance.

## Requirements and decisions

| Proposal requirement | Agreed scope or constraint | Customer acceptance still needed |
|---|---|---|
| Event creation, phases, capacity, and operations overview | Event lifecycle is operated by agency staff. | End-to-end operator acceptance. |
| Attendee list, registration, editing, and selected deletion | Cancellation invalidates the ticket; cancellation of an attendee already checked in is blocked. A paid registration becomes a refund request; the service does not issue a refund. | Confirm whether cancellation satisfies “selected deletion” or whether permanent deletion is required. Do not enable permanent deletion before retention policy approval. |
| Attendee mobile home and event-specific menus (proposal pp. 107–122) | Keep application and ticket access available; event information and published participation programs may be configured for the attendee home. | Confirm menu configuration as the accepted proposal scope. |
| Excel/TXT import and exports, including login-link files | Import and roster export are in scope. Login-link spreadsheets are excluded because each link is a bearer credential. CSV can preserve text in the exported file, but spreadsheet software may auto-convert values when opened. | Confirm the login-link file exclusion and form/template export scope. |
| Check-in/out, QR, manual lookup, desk and name-tag printing | Staff authorization and server confirmation remain required. Ambiguous manual attendee matches require field-lead identity confirmation. | Approve the现场 identity-check policy; validate cameras, label stock and printers on actual devices. |
| Kiosk/tablet mode | Shared tablets use an assigned staff account. Unattended, unauthenticated self-check-in is excluded. Attendees may announce arrival from a desk poster on their own phone; staff confirm entry at every desk, with or without name tags. | Accept the display-only mode and exclusion, and the poster arrival flow (name-and-phone identification). The owner placed the flow on the delivery link on 2026-11-25; the customer's written acceptance is still pending. |
| Draw, polls, surveys, quiz, Q&A and attendee participation | Participation and operator moderation are in scope; feature availability and publish state remain explicit. | Accept the shipped flows with real users. Quiz similarity scoring and rankings have no agreed rule. |
| Templates, SMS/AlimTalk, bulk/individual, immediate/scheduled sends | Keep existing schedules and send history. Provider acceptance, delivery, failure and unknown outcome are distinct. Existing and new schedules are manual by default; automatic execution requires explicit deployment and per-schedule opt-in. 자동 안내(참가 확정·리마인드)는 기본 꺼짐이며 같은 옵트인(배포 설정 + 행사·규칙별 켜기)을 따른다. 행사 기준 예약은 행사 날짜 변경을 따라 이동하거나(미발송 한정) 지난 시각이면 취소된다. | Verify real provider setup, approved templates, charges, recipients and delivery. Permanent message/template deletion policy is undecided. |
| MMS | Photo messaging is in scope. | Verify actual image handoff and delivery with the provider. |
| Booth use or stamp mode; attendee photo gallery and ZIP | Booth modes are event operations. Attendee photo-wall content is separate from private event-evidence photos. | Accept real event flows; see the separately approved evidence-photo scope below. |
| Notices, timetable, venue and board | Notices, structured schedules, venue information and participant board are in scope. | Confirm structured schedules in place of timetable images. |
| Results report, cover and PDF | Snapshot report and browser print/PDF are in scope. Customer-company automatic delivery and PPT editing are excluded. | Accept report contents and verify actual printers/output. |
| Event photo management | Use the separately approved evidence-photo scope below. | Confirm the operational workflow. |
| Customer-company management and client credentials | Agency staff manage customer-company records; client portal and client logins are excluded. | Written confirmation of the portal/login exclusion. |
| Administrator access log, domains and messaging setup | Only a person's own successful-login timestamp may be collected when an explicit retention period is configured. IP/device tracking and cross-agency account logs are not included. Provider credentials stay in runtime secrets. | Define the scope and retention of any broader administrator audit log; confirm provider and domain setup. |
| Public landing page, inquiry, terms and privacy policy | Landing page and contact information are provided; legal terms and privacy text are not final product acceptance. | Legal review and approval of terms/privacy text. |
| Hard-coded master credentials | Fixed credentials from the proposal are intentionally excluded for security. | No change; initial access remains a separately provisioned agency account. |

## Data and privacy constraints

- Event duplication copies event configuration and definitions, not attendee records, tickets, check-in, sends, draws, audit history or file references.
- “Register another attendee with these details” reuses name and affiliation only. It never copies contact details, consent, ticket, check-in, outcome, reward or file data.
- Existing form answers are retained when a field is hidden. Do not change the type of a field with answers or remove a choice that an existing answer uses. Hiding a field does not mean erasing its stored answers.
- Login history records only the account holder's successful-login timestamp when a retention period has been explicitly set. The retention period and any broader audit-log scope remain unresolved.

## Approved event-evidence photo scope

- Keep the private event-evidence archive separate from the attendee photo wall; they have different purposes, access and publication rules.
- Evidence uses the eight fixed proposal categories: venue setup, stage, participant booths, event styling, pre-event setup, arrival/registration, program, and awards. Agency owners and managers assigned to that event may manage them.
- An event-evidence ZIP rechecks event access and contains only the selected category. An attendee photo-wall ZIP contains approved photos only; hidden and pending photos are excluded.
- Removing an item from the evidence archive removes its metadata reference only. It does not delete original file bytes or revoke ordinary event-file access.
- Free-form categories, categorizing attendee photos into evidence sections, and report-layout integration are outside this approved scope.

Anything listed above as requiring customer confirmation remains out of scope until the customer approves the change in writing.
