-- Recovery throttle scope split (additive only).
--
-- The anonymous recovery path and the signed-in reauthentication path use
-- different per-email buckets: anonymous requests for a victim's address
-- must never fill the victim's own verification bucket and deny them
-- without guessing any password. Widening only ADDS values; existing login
-- (account/address) and recovery readers are unchanged.

ALTER TABLE login_attempts DROP CONSTRAINT IF EXISTS login_attempts_scope_check;

ALTER TABLE login_attempts
  ADD CONSTRAINT login_attempts_scope_check
  CHECK (scope IN ('account', 'address', 'recovery-email', 'recovery-address', 'verify-email', 'verify-address'));
