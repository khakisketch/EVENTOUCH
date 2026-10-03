(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Single definition of shell screens. The entries mirror the
  // `index.html` sections in nav order; `labelKey` points at `i18n/ko.json`.
  // Extended routes (results/settings/...) stay reachable via navigate but
  // are not shell sections, so they are deliberately absent here.
  var REGISTRY = [
    { id: 'agency-home', section: 'agency-home-view', mount: 'agency-home-mount', labelKey: 'agency-home' },
    { id: 'agency-events', section: 'agency-events-view', mount: 'agency-events-mount', labelKey: 'agency-events' },
    { id: 'agency-clients', section: 'agency-clients-view', mount: 'agency-clients-mount', labelKey: 'agency-clients' },
    { id: 'agency-team', section: 'agency-team-view', mount: 'agency-team-mount', labelKey: 'agency-team' },
    { id: 'overview', section: 'overview-view', mount: 'overview-mount', labelKey: 'overview' },
    { id: 'participants', section: 'participants-view', mount: 'people-list', labelKey: 'participants' },
    { id: 'checkin', section: 'checkin-view', mount: 'checkin-mount', labelKey: 'checkin' },
    { id: 'booth', section: 'booth-view', mount: 'booth-mount', labelKey: 'booth' },
    { id: 'participant', section: 'participant-view', mount: 'home-mount', labelKey: 'participant' },
    { id: 'engage', section: 'engage-view', mount: 'engage-mount', labelKey: 'engage' },
    { id: 'content', section: 'content-view', mount: 'content-mount', labelKey: 'content' },
    { id: 'messages', section: 'messages-view', mount: 'messages-mount', labelKey: 'messages' },
    { id: 'stage', section: 'stage-view', mount: 'stage-mount', labelKey: 'stage' },
    { id: 'screen', section: 'screen-view', mount: 'screen-mount', labelKey: 'screen' },
  ];

  function copy(entry) {
    return { id: entry.id, section: entry.section, mount: entry.mount, labelKey: entry.labelKey };
  }

  // Fresh copies so callers cannot mutate the registry.
  ETKO.viewRegistry = function () {
    return REGISTRY.map(copy);
  };

  function find(id) {
    for (var i = 0; i < REGISTRY.length; i += 1) {
      if (REGISTRY[i].id === id) return REGISTRY[i];
    }
    return null;
  }

  // Section/mount lookups. Unknown views return null, never throw.
  ETKO.sectionFor = function (view) {
    var entry = find(view);
    return entry ? entry.section : null;
  };

  ETKO.mountFor = function (view) {
    var entry = find(view);
    return entry ? entry.mount : null;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
