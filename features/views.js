(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Single definition of shell screens. The entries mirror the
  // `index.html` sections in nav order; `labelKey` points at `i18n/ko.json`.
  // Extended routes (results/settings/...) stay reachable via navigate but
  // are not shell sections, so they are deliberately absent here.
  var REGISTRY = [
    { id: 'agency-home', section: 'agency-home-view', mount: 'agency-home-mount', labelKey: 'agency-home', layer: 'agency' },
    { id: 'agency-events', section: 'agency-events-view', mount: 'agency-events-mount', labelKey: 'agency-events', layer: 'agency' },
    { id: 'agency-clients', section: 'agency-clients-view', mount: 'agency-clients-mount', labelKey: 'agency-clients', layer: 'agency' },
    { id: 'agency-team', section: 'agency-team-view', mount: 'agency-team-mount', labelKey: 'agency-team', layer: 'agency' },
    { id: 'overview', section: 'overview-view', mount: 'overview-mount', labelKey: 'overview', layer: 'event' },
    { id: 'participants', section: 'participants-view', mount: 'people-list', labelKey: 'participants', layer: 'event' },
    { id: 'checkin', section: 'checkin-view', mount: 'checkin-mount', labelKey: 'checkin', layer: 'onsite' },
    { id: 'booth', section: 'booth-view', mount: 'booth-mount', labelKey: 'booth', layer: 'onsite' },
    { id: 'participant', section: 'participant-view', mount: 'home-mount', labelKey: 'participant', layer: 'participant' },
    { id: 'engage', section: 'engage-view', mount: 'engage-mount', labelKey: 'engage', layer: 'event' },
    { id: 'content', section: 'content-view', mount: 'content-mount', labelKey: 'content', layer: 'event' },
    { id: 'messages', section: 'messages-view', mount: 'messages-mount', labelKey: 'messages', layer: 'event' },
    { id: 'stage', section: 'stage-view', mount: 'stage-mount', labelKey: 'stage', layer: 'event' },
    { id: 'screen', section: 'screen-view', mount: 'screen-mount', labelKey: 'screen', layer: 'screen' },
  ];

  var LAYERS = [
    { id: 'agency', label: '대행사', defaultView: 'agency-home', views: ['agency-home', 'agency-events', 'agency-clients', 'agency-team'] },
    { id: 'event', label: '행사', defaultView: 'overview', views: ['overview', 'participants', 'engage', 'content', 'messages', 'stage'] },
    { id: 'onsite', label: '현장', defaultView: 'checkin', views: ['checkin', 'booth'] },
    { id: 'participant', label: '참가자', defaultView: 'participant', views: ['participant'] },
    { id: 'screen', label: '스크린', defaultView: 'screen', views: ['screen'] },
  ];

  function copy(entry) {
    return { id: entry.id, section: entry.section, mount: entry.mount, labelKey: entry.labelKey, layer: entry.layer };
  }

  function copyLayer(layer) {
    return {
      id: layer.id,
      label: layer.label,
      defaultView: layer.defaultView,
      views: layer.views.slice(),
    };
  }

  // Fresh copies so callers cannot mutate the registry.
  ETKO.viewRegistry = function () {
    return REGISTRY.map(copy);
  };

  ETKO.layerRegistry = function () {
    return LAYERS.map(copyLayer);
  };

  ETKO.layerForView = function (view) {
    for (var i = 0; i < REGISTRY.length; i += 1) {
      if (REGISTRY[i].id === view) return REGISTRY[i].layer;
    }
    return null;
  };

  ETKO.defaultViewForLayer = function (layerId) {
    for (var i = 0; i < LAYERS.length; i += 1) {
      if (LAYERS[i].id === layerId) return LAYERS[i].defaultView;
    }
    return null;
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
