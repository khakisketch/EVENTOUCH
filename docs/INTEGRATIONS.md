# Live provider contracts

Code defines adapter details. This document keeps the decisions and observations that a local test cannot supply.

## Messaging

- Live SMS, LMS, MMS, and Kakao AlimTalk require explicitly configured Solapi credentials, a registered sender, and any approved channel templates. Keep credentials in a private runtime secret store; do not commit them or log raw provider responses containing personal data.
- A provider acceptance is not recipient delivery. Show and record queued, accepted, delivered, rejected, and unknown outcomes distinctly. Reconcile an unknown send before retrying so an uncertain response does not create a duplicate message.
- Existing scheduled sends remain manual. New real schedules default to manual; automatic execution is allowed only when both deployment and that schedule explicitly opt in. Do not enable automatic sending during a mixed-version rollout that may interpret older schedules differently.
- Message and replacement-SMS charges are paid by the event agency. There is no product billing flow in v1. Verify the payer, sender identity, consented test recipients, approved template, and expected charge before any live send.
- A mock provider verifies local behavior only. Never describe it as provider acceptance or delivery.

## Account email

- SMTP is opt-in and must use TLS certificate validation. Configure the actual public origin and credentials only in the runtime secret store. A `connected` state means configuration is usable; it does not prove mailbox delivery or safe link handling.
- Recovery is for an account holder at an address they verified in advance. Existing email data and invitation acceptance are not proof of address ownership. An agency owner cannot reset a shared account globally. Manual identity proof for accounts without a verified address requires a separately approved owner and procedure before operation.
- Never log reset or verification links, tokens, passwords, or provider secrets. Email mock mode and synthetic TLS checks are not live delivery evidence.

## External acceptance

Before production use, record an actual human review in a private copy of [`ops/acceptance.example.json`](../ops/acceptance.example.json). Use only approved test recipients. Verify SMS and fallback behavior, MMS, approved-template AlimTalk, email verification and recovery, and the operator's end-to-end event workflow. Record provider acceptance separately from observed delivery. Do not fill a check from configuration, source inspection, or a synthetic test.

The release check reads that private record but does not send messages, change a database, or deploy. Commands and environment variable names live in `.env.example`, `package.json`, and the deployment configuration. Credentials, recipient contact details, and the filled acceptance record stay outside Git.
