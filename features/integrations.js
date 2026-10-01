(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Integration provider registry. Areas are fixed; each area holds one
  // active provider. Defaults are built-in simulation providers so the
  // browser flow completes without external calls. Real providers replace
  // the slot via registerProvider; nothing here stores credentials.
  var AREAS = ['auth', 'messages', 'payments', 'devices'];

  var slots = {};

  function simulationProvider(area) {
    return { area: area, name: 'simulation', kind: 'simulation' };
  }

  // Fixed mode: this build never performs real external calls.
  ETKO.integrationMode = function () {
    return 'SIMULATION';
  };

  ETKO.integrationAreas = function () {
    return AREAS.slice();
  };

  // Register a provider for one area. Unknown areas throw a Korean error.
  // Returns the registered provider.
  ETKO.registerProvider = function (area, name, impl) {
    var key = String(area === undefined || area === null ? '' : area).trim().toLowerCase();
    if (AREAS.indexOf(key) === -1) throw new Error('연동 영역을 확인하세요');
    var label = String(name === undefined || name === null ? '' : name).trim();
    if (!label) throw new Error('연동 이름을 입력하세요');
    var provider = { area: key, name: label, kind: 'custom', impl: impl || {} };
    slots[key] = provider;
    return provider;
  };

  // Active provider for an area: registered custom or built-in simulation.
  ETKO.providerFor = function (area) {
    var key = String(area === undefined || area === null ? '' : area).trim().toLowerCase();
    if (AREAS.indexOf(key) === -1) throw new Error('연동 영역을 확인하세요');
    if (slots[key]) return slots[key];
    return simulationProvider(key);
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
