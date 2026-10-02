(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  // Photo review + photowall + screen output (Task 7). Consumes
  // ETKO.workspace(), which owns `photos` and
  // `product:{presentation,media}`. Wall/output settings live on
  // `product.presentation:{type,assetId,layout,seconds}` (lazily
  // ensured, never replacing the product object).

  var MAX_DATA_PHOTOS = 3;
  var MAX_DATA_LENGTH = 1048576;
  var DATA_URL_PATTERN = /^data:image\/(jpeg|jpg|png|webp);base64,/;
  var PHOTO_STATUSES = ['APPROVED', 'PENDING', 'HIDDEN'];
  var WALL_LAYOUTS = ['grid', 'spotlight'];
  var OUTPUT_TYPES = ['idle', 'media', 'poll', 'quiz', 'draw', 'photos'];

  function text(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function mediaWorkspace() {
    var ws = ETKO.workspace();
    if (!Array.isArray(ws.photos)) ws.photos = [];
    if (!ws.product || typeof ws.product !== 'object') {
      ws.product = { presentation: null, media: [] };
    }
    if (!Array.isArray(ws.product.media)) ws.product.media = [];
    if (!ws.product.presentation || typeof ws.product.presentation !== 'object') {
      ws.product.presentation = { type: 'idle', assetId: null, layout: 'grid', seconds: 10 };
    }
    var presentation = ws.product.presentation;
    if (OUTPUT_TYPES.indexOf(presentation.type) === -1) presentation.type = 'idle';
    if (WALL_LAYOUTS.indexOf(presentation.layout) === -1) presentation.layout = 'grid';
    if (typeof presentation.seconds !== 'number' || presentation.seconds < 3 || presentation.seconds > 60) {
      presentation.seconds = 10;
    }
    if (!Array.isArray(ws.participants)) ws.participants = [];
    return ws;
  }

  function findParticipant(ws, id) {
    for (var i = 0; i < ws.participants.length; i += 1) {
      if (ws.participants[i] && ws.participants[i].id === id) return ws.participants[i];
    }
    return null;
  }

  function findPhoto(ws, id) {
    for (var i = 0; i < ws.photos.length; i += 1) {
      if (ws.photos[i] && ws.photos[i].id === id) return ws.photos[i];
    }
    return null;
  }

  function nextPhotoId(ws) {
    var max = 0;
    ws.photos.forEach(function (p) {
      var m = /^ph(\d+)$/.exec((p && p.id) || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = 'ph' + (max + 1);
    while (findPhoto(ws, id)) {
      max += 1;
      id = 'ph' + (max + 1);
    }
    return id;
  }

  function copyPhoto(photo) {
    return {
      id: photo.id,
      participantId: photo.participantId,
      caption: photo.caption,
      data: photo.data,
      status: photo.status,
    };
  }

  // Upload one participant photo. New photos wait in PENDING review.
  // Only JPEG/PNG/WebP data URLs up to 1MB (by length), and at most
  // 3 photos are stored with data.
  ETKO.uploadPhoto = function (participantId, input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('photos');
    var ws = mediaWorkspace();
    var person = findParticipant(ws, participantId);
    if (!person) throw new Error('참가자를 찾을 수 없습니다');
    var opts = input || {};
    var data = typeof opts.data === 'string' ? opts.data : '';
    if (!DATA_URL_PATTERN.test(data)) throw new Error('사진 형식을 확인하세요');
    if (data.length > MAX_DATA_LENGTH) throw new Error('사진 용량은 1MB 이하만 가능합니다');
    var withData = ws.photos.filter(function (p) {
      return p && typeof p.data === 'string' && p.data;
    }).length;
    if (withData >= MAX_DATA_PHOTOS) throw new Error('사진은 최대 3장까지 저장할 수 있습니다');
    var record = {
      id: nextPhotoId(ws),
      participantId: person.id,
      caption: text(opts.caption),
      data: data,
      status: 'PENDING',
    };
    ws.photos.push(record);
    return copyPhoto(record);
  };

  // Review uploaded photos. Unknown ids throw
  // `사진을 찾을 수 없습니다`.
  ETKO.moderatePhotos = function (ids, status) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('photos');
    var ws = mediaWorkspace();
    var next = text(status).toUpperCase();
    if (PHOTO_STATUSES.indexOf(next) === -1) throw new Error('상태를 확인하세요');
    var list = Array.isArray(ids) ? ids : [ids];
    return list.map(function (id) {
      var photo = findPhoto(ws, id);
      if (!photo) throw new Error('사진을 찾을 수 없습니다');
      photo.status = next;
      return copyPhoto(photo);
    });
  };

  // Approved photos only: the photowall never shows unreviewed uploads.
  ETKO.wallPhotos = function () {
    return mediaWorkspace()
      .photos.filter(function (p) {
        return p && p.status === 'APPROVED';
      })
      .map(copyPhoto);
  };

  // Photowall output settings: grid or one-at-a-time, 3..60s rotation.
  ETKO.setWall = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('screen');
    var ws = mediaWorkspace();
    var opts = input || {};
    var layout = text(opts.layout).toLowerCase();
    if (WALL_LAYOUTS.indexOf(layout) === -1) throw new Error('레이아웃을 확인하세요');
    var seconds = Number(opts.seconds);
    if (!isFinite(seconds) || seconds < 3 || seconds > 60) {
      throw new Error('전환 시간을 확인하세요');
    }
    ws.product.presentation.layout = layout;
    ws.product.presentation.seconds = Math.floor(seconds);
    return { layout: layout, seconds: Math.floor(seconds) };
  };

  // Screen output selection. A media asset must exist in product.media,
  // a photos asset must exist in photos; unknown assets throw.
  ETKO.setOutput = function (input) {
    if (typeof ETKO.requireWrite === 'function') ETKO.requireWrite('screen');
    var ws = mediaWorkspace();
    var opts = input || {};
    var type = text(opts.type).toLowerCase();
    if (OUTPUT_TYPES.indexOf(type) === -1) throw new Error('화면 종류를 확인하세요');
    var assetId = opts.assetId === undefined || opts.assetId === null ? null : text(opts.assetId);
    if (assetId) {
      if (type === 'media') {
        var media = null;
        for (var i = 0; i < ws.product.media.length; i += 1) {
          if (ws.product.media[i] && ws.product.media[i].id === assetId) media = ws.product.media[i];
        }
        if (!media) throw new Error('자료를 찾을 수 없습니다');
      } else if (type === 'photos') {
        if (!findPhoto(ws, assetId)) throw new Error('사진을 찾을 수 없습니다');
      }
    }
    ws.product.presentation.type = type;
    ws.product.presentation.assetId = assetId || null;
    return { type: type, assetId: assetId || null };
  };

  // Persist after successful mutations (no-op without a backend).
  try {
    if (typeof ETKO.persistWrap === 'function') ETKO.persistWrap(['uploadPhoto', 'moderatePhotos', 'setWall', 'setOutput']);
  } catch (err) {}

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
