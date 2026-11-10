'use strict';

// The recorded application status and cancellation flag disagree. Do not
// decide a person's intent here; the operator review owns that decision.
function cancellationNeedsReview(person) {
  return Boolean(person && typeof person === 'object' && !Array.isArray(person) &&
    person.cancelled === true && String(person.status || '').toUpperCase() !== 'CANCELLED');
}
module.exports = { cancellationNeedsReview };
