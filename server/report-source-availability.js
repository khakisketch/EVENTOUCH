'use strict';

// Keep the operator projection and the authoritative report-creation guard
// on the same source rules. Absence is the established legacy empty value;
// explicit malformed values are never evidence of an empty collection.
function reportSourceAvailability(raw) {
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const validRaw = Boolean(record(raw));
  const obj = validRaw ? raw : {};
  const collection = (key, item) => validRaw && (!Object.hasOwn(obj, key) ||
    (Array.isArray(obj[key]) && obj[key].every(item)));
  const list = key => Array.isArray(obj[key]) ? obj[key] : [];
  const result = {
    venue: validRaw && (!Object.hasOwn(obj, 'venue') || Boolean(record(obj.venue))),
    participants: collection('participants', record), checks: collection('checks', record),
    responses: collection('responses', record), modules: collection('modules', record),
    groups: collection('groups', item => typeof item === 'string'),
    booths: collection('booths', record), questions: collection('questions', record),
    photos: collection('photos', record), survey: false, draw: false,
  };
  const nonnegative = value => value === undefined ||
    ((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0);
  result.booths = result.booths && list('booths').every(booth => nonnegative(booth.used) && nonnegative(booth.capacity));
  const modules = list('modules');
  result.draw = result.modules && modules.every(module => module.type !== 'draw' || module.drawHistory === undefined ||
    (Array.isArray(module.drawHistory) && module.drawHistory.every(draw => record(draw) && Array.isArray(draw.winners))));
  const surveyQuestions = result.modules && modules.every(module => module.type !== 'survey' || module.questions === undefined ||
    (Array.isArray(module.questions) && module.questions.every(question => typeof question === 'string')));
  const surveyIds = new Set(result.modules ? modules.filter(module => module.type === 'survey').map(module => module.id) : []);
  result.survey = surveyQuestions && result.responses && list('responses').every(response => !surveyIds.has(response.moduleId) ||
    (record(response.ratings) && Object.values(response.ratings).every(value =>
      (typeof value === 'number' || (typeof value === 'string' && /^[1-5]$/.test(value))) && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 5)));
  return result;
}

module.exports = { reportSourceAvailability };
