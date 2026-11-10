'use strict';

// Inspect the locked original, not the normalization that replaces a
// malformed collection with an empty one. Missing legacy fields retain the
// existing closed/empty defaults; explicit unreadable values do not.
function archivePreconditions(raw) {
  const valid = raw && typeof raw === 'object' && !Array.isArray(raw);
  const workspace = valid ? raw : {};
  const participantsAvailable = Boolean(valid) && (!Object.hasOwn(workspace, 'participants') ||
    (Array.isArray(workspace.participants) && workspace.participants.every(person => person && typeof person === 'object' && !Array.isArray(person))));
  const registrationAvailable = Boolean(valid) && (!Object.hasOwn(workspace, 'registrationOpen') || typeof workspace.registrationOpen === 'boolean');
  const modulesAvailable = Boolean(valid) && (!Object.hasOwn(workspace, 'modules') ||
    (Array.isArray(workspace.modules) && workspace.modules.every(module => module && typeof module === 'object' && !Array.isArray(module) &&
      typeof module.status === 'string' && ['DRAFT', 'OPEN', 'CLOSED'].includes(module.status.toUpperCase()))));
  return {
    version: 1,
    participantsAvailable,
    registrationAvailable,
    modulesAvailable,
    registrationOpen: registrationAvailable ? workspace.registrationOpen === true : null,
    openModules: modulesAvailable ? (Array.isArray(workspace.modules) ? workspace.modules.filter(module => module.status.toUpperCase() === 'OPEN').length : 0) : null,
  };
}
module.exports = { archivePreconditions };
