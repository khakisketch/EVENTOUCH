(function (E) {
  'use strict';
  const esc = E.esc;
  const uiState = () => E.ui.boothMap || (E.ui.boothMap = { local: null, selectedId: null, viewport: { scale: 1, x: 0, y: 0 }, imageStatus: {} });
  const safeList = value => Array.isArray(value) ? value : [];
  const mapState = () => E.work().boothMap || { draft: null, published: null };
  const fileRef = map => map && (map.image || map.file || map.fileRef) || null;
  const mapPoints = map => safeList(map && map.points);
  const eventId = () => E.event().id;
  const link = (label, href, cls = '', id = '') => '<a class="btn ' + esc(cls) + '" href="' + esc(href) + '"' + (id ? ' data-od-id="' + esc(id) + '"' : '') + '>' + esc(label) + '</a>';
  const imageUrl = (file, isPublic) => file && file.fileId && E.remote && E.remote.fileURL
    ? E.remote.fileURL(isPublic ? { slug: E.event().slug, fileId: file.fileId, public: true } : { eventId: eventId(), fileId: file.fileId }) : '';
  const statusName = status => ({ OPEN: '진행 중', WAITING: '대기 중', CLOSED: '종료' }[status] || '상태 확인 중');
  const pointFor = (points, boothId) => points.find(point => point.boothId === boothId);
  const numeric = (value, name) => {
    if (typeof value === 'string' && !value.trim()) throw Error(name + ' 위치를 입력하세요.');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw Error(name + ' 위치는 0과 1 사이 숫자로 입력하세요.');
    return Math.round(n * 10000) / 10000;
  };

  // An invalid/expired bearer link must not hide this public map. Keep valid
  // ticket hydration unchanged; retry as a guest only when the ticket read is
  // definitively not found on the stamp route.
  if (E.remote && typeof E.remote.loadPublic === 'function') {
    const loadPublic = E.remote.loadPublic;
    E.remote.loadPublic = async function (slug, ticket = '') {
      const route = E.parseRoute?.() || E.route;
      if (ticket && route?.scope === 'attendee' && route.page === 'stamp') {
        try { return await loadPublic.call(this, slug, ticket); }
        catch (error) {
          if (error.status !== 404) throw error;
          return loadPublic.call(this, slug, '');
        }
      }
      return loadPublic.call(this, slug, ticket);
    };
  }

  E.boothMapLocalState = () => {
    const state = uiState();
    const authoritative = mapState();
    if (!state.local || state.local.eventId !== eventId()) {
      const source = authoritative.draft || authoritative.published || {};
      const image = fileRef(source);
      state.local = { eventId: eventId(), image: image ? { ...image } : null, points: mapPoints(source).map(p => ({ boothId: p.boothId, x: p.x, y: p.y })), expectedDraftVersion: authoritative.draft?.version || 0, dirty: false, savedDraft: !!authoritative.draft, replacementPending: false, conflict: false };
      state.imageStatus = {};
    }
    return state.local;
  };
  E.boothMapImageFailed = () => '<div class="booth-map-fallback" role="status"><strong>배치도를 표시할 수 없습니다.</strong><p>부스 목록에서 위치와 인증 상태를 확인할 수 있습니다.</p></div>';
  E.boothMapSetPoint = (boothId, x, y) => {
    if (!E.work().booths.some(booth => booth.id === boothId)) throw Error('현재 행사에 등록된 부스를 선택하세요.');
    const point = { boothId, x: numeric(x, '가로'), y: numeric(y, '세로') };
    const local = E.boothMapLocalState();
    if (local.replacementPending) throw Error('새 배치도 이미지를 먼저 빈 위치로 저장하세요.');
    const old = pointFor(local.points, boothId);
    if (old) Object.assign(old, point); else local.points.push(point);
    local.dirty = true;
    uiState().selectedId = boothId;
    return point;
  };
  E.boothMapRemovePoint = boothId => {
    const local = E.boothMapLocalState();
    local.points = local.points.filter(point => point.boothId !== boothId);
    local.dirty = true;
  };
  E.boothMapSetViewport = (action, amount, bounds = {}) => {
    const viewport = uiState().viewport;
    if (action === 'in') viewport.scale = Math.min(3, Math.round((viewport.scale + .25) * 100) / 100);
    else if (action === 'out') viewport.scale = Math.max(1, Math.round((viewport.scale - .25) * 100) / 100);
    else if (action === 'reset') Object.assign(viewport, { scale: 1, x: 0, y: 0 });
    const minX = -Math.max(0, Number(bounds.width || 0) * (viewport.scale - 1));
    const minY = -Math.max(0, Number(bounds.height || 0) * (viewport.scale - 1));
    if (action === 'left') viewport.x = Math.max(minX, viewport.x - (amount || 24));
    else if (action === 'right') viewport.x = Math.min(0, viewport.x + (amount || 24));
    else if (action === 'up') viewport.y = Math.max(minY, viewport.y - (amount || 24));
    else if (action === 'down') viewport.y = Math.min(0, viewport.y + (amount || 24));
    viewport.x = Math.max(minX, Math.min(0, viewport.x));
    viewport.y = Math.max(minY, Math.min(0, viewport.y));
    return viewport;
  };
  E.boothMapUploadFile = async file => {
    if (!file || !file.name) throw Error('배치도 파일을 선택하세요.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('PNG, JPEG, WebP 이미지 파일을 사용하세요.');
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 600000) throw Error('배치도 파일은 1B 이상 600KB 이하여야 합니다.');
    if (!E.remote || typeof E.remote.uploadFile !== 'function') throw Error('배치도 파일 연결을 사용할 수 없습니다. 서버 연결 상태를 확인하세요.');
    const uploaded = await E.remote.uploadFile(file, { eventId: eventId(), commandId: E.id('booth-map-upload') });
    const local = E.boothMapLocalState();
    const replacesSavedDraft = local.savedDraft && local.image?.fileId !== uploaded.fileId;
    local.image = uploaded;
    local.points = [];
    local.dirty = true;
    local.replacementPending = !!replacesSavedDraft;
    local.conflict = false;
    uiState().imageStatus[uploaded.fileId] = 'loading';
    return uploaded;
  };

  function boothList(points, completedIds, participant) {
    const booths = safeList(E.work().booths);
    const duplicateCounts = new Map();
    booths.forEach(b => duplicateCounts.set(b.name, (duplicateCounts.get(b.name) || 0) + 1));
    return booths.length ? '<ul class="booth-map-list" aria-label="부스 목록">' + booths.map((booth, boothIndex) => {
      const index = boothIndex + 1;
      const label = booth.name + ((duplicateCounts.get(booth.name) || 0) > 1 ? ' ' + index : '');
      const point = pointFor(points, booth.id);
      const visited = completedIds.includes(booth.id), selected = uiState().selectedId === booth.id;
      const state = participant ? (visited ? '인증 완료' : '아직 인증되지 않음') : '티켓 인증 후 확인';
      return '<li><button type="button" class="booth-map-list-item' + (visited ? ' is-visited' : '') + (selected ? ' is-selected' : '') + '" data-action="booth-map-select" data-id="' + esc(booth.id) + '" data-od-id="booth-map-list-' + esc(booth.id) + '" aria-pressed="' + selected + '" aria-label="' + esc(label + ', ' + statusName(booth.status) + ', ' + state) + '"><span class="booth-map-list-number" aria-hidden="true">' + (index) + '</span><span class="booth-map-list-copy"><strong>' + esc(label) + '</strong><span>' + esc(booth.zone || '구역 안내 없음') + ' · ' + esc(statusName(booth.status)) + (point ? '' : ' · 위치 미지정') + '</span></span><span class="booth-map-list-state">' + (visited ? '<svg class="booth-map-list-state-icon" aria-hidden="true" focusable="false" viewBox="0 0 20 20"><path d="m4 10 4 4 8-8"/></svg>' : '') + esc(state) + '</span></button></li>';
    }).join('') + '</ul>' : '<p class="booth-map-fallback">등록된 부스가 없습니다. 행사 운영자에게 문의하세요.</p>';
  }
  function renderStage(map, points, completedIds, isPublic, editor) {
    const file = fileRef(map);
    const state = uiState();
    if (!file || !imageUrl(file, isPublic)) return '<div class="booth-map-fallback" role="status"><strong>' + (editor ? '배치도 파일을 등록해 주세요.' : '배치도가 아직 게시되지 않았습니다.') + '</strong><p>부스 목록에서 각 부스의 구역과 인증 상태를 확인할 수 있습니다.</p></div>';
    const status = state.imageStatus?.[file.fileId] || 'loading';
    if (status === 'error') return E.boothMapImageFailed();
    const width = Number.isFinite(file.width) && file.width > 0 ? file.width : 16;
    const height = Number.isFinite(file.height) && file.height > 0 ? file.height : 10;
    const viewport = state.viewport;
    const transform = 'translate(' + viewport.x + 'px,' + viewport.y + 'px) scale(' + viewport.scale + ')';
    const pins = points.map((point, index) => {
      const booth = E.work().booths.find(item => item.id === point.boothId);
      if (!booth) return '';
      const selected = state.selectedId === booth.id;
      const completed = completedIds.includes(booth.id);
      const number = E.work().booths.findIndex(item => item.id === booth.id) + 1;
      const edge = (point.x === 0 ? ' is-edge-left' : point.x === 1 ? ' is-edge-right' : '') + (point.y === 0 ? ' is-edge-top' : point.y === 1 ? ' is-edge-bottom' : '');
      return '<button type="button" class="booth-map-pin' + edge + (selected ? ' is-selected' : '') + (completed ? ' is-visited' : '') + '" style="left:' + (point.x * 100) + '%;top:' + (point.y * 100) + '%" data-action="booth-map-select" data-id="' + esc(booth.id) + '" data-od-id="booth-map-pin-' + esc(booth.id) + '" aria-pressed="' + selected + '" aria-label="' + esc(number + '번 ' + booth.name + ', ' + statusName(booth.status) + (completed ? ', 인증 완료' : '')) + '"><span>' + number + '</span><i class="booth-map-pin-anchor" aria-hidden="true"></i></button>';
    }).join('');
    const ready = status === 'ready';
    const onerror = ' data-booth-map-image data-file-id="' + esc(file.fileId) + '"';
    const loading = ready ? '' : '<p class="booth-map-loading" role="status" aria-live="polite">배치도를 불러오는 중입니다. 부스 목록은 계속 이용할 수 있습니다.</p>';
    return '<div class="booth-map-stage' + (ready ? ' is-ready' : ' is-loading') + '" data-map-canvas data-map-ready="' + ready + '" style="--booth-map-ratio:' + width + ' / ' + height + ';--booth-map-mobile-width:' + Math.round(360 * width / height) + 'px">' + loading + '<div class="booth-map-art" style="transform:' + transform + '"><img src="' + esc(imageUrl(file, isPublic)) + '" alt="' + esc(E.event().name + ' 부스 배치도') + '" width="' + width + '" height="' + height + '"' + onerror + '>' + pins + '</div></div>';
  }
  const viewportControls = ready => {
    if (!ready) return '';
    const paths = {
      plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
      reset: '<path d="M20 7v5h-5M20 12a8 8 0 1 1-2.34-5.66L20 9"/>',
      left: '<path d="m14 5-7 7 7 7"/>', up: '<path d="m5 14 7-7 7 7"/>',
      down: '<path d="m5 10 7 7 7-7"/>', right: '<path d="m10 5 7 7-7 7"/>'
    };
    const icon = name => '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
    const button = (name, label, value, id) => '<button type="button" class="btn" data-action="booth-map-zoom" data-value="' + value + '" data-od-id="' + id + '" aria-label="' + label + '">' + icon(name) + '</button>';
    return '<div class="booth-map-controls" role="group" aria-label="배치도 보기 조절">' +
      button('plus', '배치도 확대', 'in', 'booth-map-zoom-in') + button('minus', '배치도 축소', 'out', 'booth-map-zoom-out') + button('reset', '보기 초기화', 'reset', 'booth-map-zoom-reset') +
      '<span class="booth-map-pan" role="group" aria-label="배치도 이동">' + button('left', '배치도 왼쪽 이동', 'left', 'booth-map-pan-left') + button('up', '배치도 위쪽 이동', 'up', 'booth-map-pan-up') + button('down', '배치도 아래쪽 이동', 'down', 'booth-map-pan-down') + button('right', '배치도 오른쪽 이동', 'right', 'booth-map-pan-right') + '</span></div>';
  };

  E.boothStampPage = () => {
    const ev = E.event(), work = E.work(), published = mapState().published;
    const candidate = E.person(), participant = candidate && E.ticketValid(candidate) ? candidate : null;
    const summary = E.boothStampSummary(work.booths, work.visits, participant?.id);
    const points = mapPoints(published), completedIds = summary.visitedBoothIds;
    const notice = participant && summary.total
      ? '<p class="booth-map-progress" role="status">내 인증 <strong>' + summary.completed + ' / ' + summary.total + '</strong></p>'
      : participant ? '<p class="booth-map-guest" role="status">아직 등록된 부스가 없습니다.</p>'
      : '<p class="booth-map-guest" role="status">티켓 등록 후 내 인증 현황을 확인할 수 있어요.</p>';
    const certify = participant && participant.status === 'APPROVED' && ['FREE', 'PAID'].includes(participant.paymentStatus)
      ? (work.stampMode === 'SELF' ? '<section class="booth-map-certify" data-od-id="booth-map-certify"><p>' + (participant.inside ? '부스 QR을 스캔해 인증을 확인하세요.' : '행사 입장 후 부스 인증을 이용할 수 있습니다.') + '</p><div class="actions">' + E.button('부스 QR 스캔', 'camera-scan', 'data-type="self" data-od-id="booth-self-scan"', 'primary') + E.button('코드 직접 입력', 'self-booth-input', 'data-od-id="booth-self-code"') + '</div></section>' : '<section class="booth-map-certify" data-od-id="booth-map-certify"><p>' + (participant.inside ? '부스 담당 스태프에게 내 티켓 QR을 보여주세요.' : '행사 입장 후 부스 인증을 이용할 수 있습니다.') + '</p>' + link('내 티켓 제시', E.aurl('ticket'), 'primary', 'booth-ticket-entry') + '</section>')
      : participant ? '<section class="booth-map-certify" data-od-id="booth-map-certify" role="status">참가가 확정되면 부스 인증을 이용할 수 있습니다.</section>' : '<section class="booth-map-certify booth-map-entry-actions" data-od-id="booth-map-certify"><div class="actions">' + link('참가 신청', E.aurl('register'), 'primary', 'booth-register-entry') + link('내 티켓', E.aurl('ticket'), '', 'booth-ticket-entry') + '</div></section>';
    const selected = E.work().booths.find(booth => booth.id === uiState().selectedId);
    const selectedPoint = selected && pointFor(points, selected.id);
    const selectedVisit = selected && completedIds.includes(selected.id);
    const selectedDetails = '<p class="booth-map-selected" role="status" aria-live="polite">' + (selected ? '<strong>선택한 부스: ' + esc(selected.name) + '</strong> · ' + esc(selected.zone || '구역 안내 없음') + ' · ' + esc(statusName(selected.status)) + (selectedPoint ? '' : ' · 위치 미지정') + (participant ? (selectedVisit ? ' · 내 인증 완료' : ' · 내 인증 전') : '') : '목록이나 배치도에서 부스를 선택하세요.') + '</p>';
    const stageStatus = published && published.image?.fileId ? uiState().imageStatus?.[published.image.fileId] || 'loading' : 'error';
    const jumps = '<button type="button" class="btn" data-action="booth-map-jump" data-target="booth-map-view" data-od-id="booth-map-jump-map">배치도 보기</button><button type="button" class="btn" data-action="booth-map-jump" data-target="booth-map-list" data-od-id="booth-map-jump-list">부스 목록</button>';
    const metadata = '<p class="booth-map-event-meta" data-od-id="booth-map-event-meta"><span class="booth-map-meta-part" data-od-id="booth-map-meta-event">' + esc(ev.name) + '</span><span class="booth-map-meta-separator" aria-hidden="true"> · </span><span class="booth-map-meta-part" data-od-id="booth-map-meta-date">' + esc(ev.date || '일정 안내 예정') + '</span></p>';
    return '<section class="booth-map-page" aria-labelledby="booth-map-title" data-od-id="booth-map-page"><header class="booth-map-heading" data-od-id="booth-map-heading"><h1 id="booth-map-title" data-od-id="booth-map-title">스탬프 투어</h1>' + metadata + notice + '<nav class="booth-map-jump" aria-label="스탬프 투어 보기">' + jumps + '</nav></header><div class="booth-map-public-layout"><section class="booth-map-view" id="booth-map-view" aria-label="행사 배치도" tabindex="-1" data-od-id="booth-map-view">' + renderStage(published, points, completedIds, true, false) + (published ? viewportControls(stageStatus === 'ready') : '') + '</section>' + certify + '<section class="booth-map-list-panel" id="booth-map-list" aria-labelledby="booth-map-list-title" tabindex="-1" data-od-id="booth-map-list-panel"><h2 id="booth-map-list-title" data-od-id="booth-map-list-title">부스 목록</h2>' + boothList(points, completedIds, participant) + selectedDetails + '</section></div></section>';
  };

  function editorMarkup() {
    if (!E.can('booth', true) || !E.event().features.includes('stamp')) return '';
    const local = E.boothMapLocalState(), authoritative = mapState(), state = uiState();
    const rows = safeList(E.work().booths).map((booth, i) => {
      const point = pointFor(local.points, booth.id), x = point ? point.x : '', y = point ? point.y : '';
      return '<li class="booth-map-edit-row"><button type="button" class="booth-map-list-item" data-action="booth-map-select" data-id="' + esc(booth.id) + '" aria-pressed="' + (state.selectedId === booth.id) + '"><span class="booth-map-list-number">' + (i + 1) + '</span><span class="booth-map-list-copy"><strong>' + esc(booth.name) + '</strong><span>' + esc(booth.zone || '구역 안내 없음') + ' · ' + esc(statusName(booth.status)) + (point ? '' : ' · 위치 미지정') + '</span></span></button><div class="booth-map-coordinate"><label>가로 위치<input type="number" name="x" min="0" max="1" step="0.01" inputmode="decimal" value="' + esc(x) + '" aria-label="' + esc(booth.name + ' 가로 위치, 0에서 1') + '"' + (local.replacementPending ? ' disabled' : '') + '></label><label>세로 위치<input type="number" name="y" min="0" max="1" step="0.01" inputmode="decimal" value="' + esc(y) + '" aria-label="' + esc(booth.name + ' 세로 위치, 0에서 1') + '"' + (local.replacementPending ? ' disabled' : '') + '></label><button type="button" class="btn" data-action="booth-map-place" data-id="' + esc(booth.id) + '"' + (local.replacementPending ? ' disabled' : '') + '>좌표 적용</button>' + (point ? '<button type="button" class="btn" data-action="booth-map-remove" data-id="' + esc(booth.id) + '">위치 삭제</button>' : '') + '</div></li>';
    }).join('');
    const canPublish = !!authoritative.draft && !local.dirty && !local.replacementPending;
    const draftImageStatus = local.image?.fileId ? state.imageStatus?.[local.image.fileId] || 'loading' : 'error';
    const conflict = local.conflict ? '<div class="booth-map-conflict" role="alert"><p>서버 초안이 먼저 변경되어 저장하지 못했습니다. 내 좌표는 유지되었습니다.</p><div class="actions">' + E.button('현재 초안에 내 좌표 유지', 'booth-map-rebase', 'data-od-id="booth-map-rebase"') + E.button('현재 초안 불러오기 · 내 변경 폐기', 'booth-map-discard', 'data-od-id="booth-map-discard"') + '</div><p>좌표 유지 선택은 같은 지도와 같은 부스 구성에서만 가능합니다. 확인 후 초안을 직접 저장하세요.</p></div>' : '';
    const replacement = local.replacementPending ? '<p class="booth-map-replacement" role="status">새 배치도는 아직 초안에 저장되지 않았습니다. 위치를 비운 상태로 먼저 저장하면 기존 초안 이미지와 연결됩니다.</p>' : '';
    const editorImage = local.image ? { image: local.image, points: local.points } : null;
    return '<section class="booth-map-editor" aria-labelledby="booth-map-editor-title" data-od-id="booth-map-editor"><header><div><p class="eyebrow">운영자 도구</p><h2 id="booth-map-editor-title" data-od-id="booth-map-editor-title">부스 배치도</h2><p>이미지를 올리고 부스별 위치를 선택하세요. 좌표는 이미지 안의 0–1 비율입니다.</p></div><span class="booth-map-state">' + (authoritative.published ? '현재 게시본 유지' : '미게시') + '</span></header><div class="booth-map-editor-grid"><div class="booth-map-editor-canvas"><label class="booth-map-upload">배치도 이미지 선택<input type="file" accept="image/png,image/jpeg,image/webp" data-booth-map-upload data-od-id="booth-map-upload"><small>PNG, JPEG 또는 WebP · 600KB 이하</small></label>' + renderStage(editorImage, local.points, [], false, true) + viewportControls(draftImageStatus === 'ready') + replacement + '<p class="help" data-map-selection-status role="status" aria-live="polite">' + (local.replacementPending ? '초안을 먼저 저장하기 전까지 위치를 지정할 수 없습니다.' : '목록에서 부스를 선택한 뒤 배치도에서 위치를 누르거나 좌표를 입력하세요.') + '</p></div><div class="booth-map-editor-properties"><h3>부스 위치</h3><p class="help">같은 이름의 부스는 목록 번호로 구분합니다. 배치하지 않은 부스도 목록에 남습니다.</p>' + (rows ? '<ul class="booth-map-edit-list">' + rows + '</ul>' : E.empty('등록된 부스가 없습니다', '먼저 부스를 추가하세요.')) + '</div></div>' + conflict + '<div class="booth-map-editor-footer"><p role="status">' + (local.replacementPending ? '새 이미지를 빈 위치로 먼저 저장해야 합니다.' : local.dirty ? '저장되지 않은 변경이 있습니다.' : authoritative.draft ? '저장된 초안 버전 ' + authoritative.draft.version : '초안이 없습니다.') + '</p><div class="actions">' + E.button('초안 저장', 'booth-map-save', 'data-od-id="booth-map-save"', 'primary') + E.button('배치도 게시', 'booth-map-publish', 'data-od-id="booth-map-publish" ' + (canPublish ? '' : 'disabled')) + (authoritative.published ? E.button('게시 해제', 'booth-map-unpublish', 'data-version="' + authoritative.published.version + '" data-od-id="booth-map-unpublish"') : '') + '</div></div></section>';
  }
  E.boothMapEditor = editorMarkup;
  const oldBooths = E.views.booths;
  if (typeof oldBooths === 'function') E.views.booths = (...args) => oldBooths(...args) + editorMarkup();

  E.actions['booth-map-select'] = (data, button) => {
    uiState().selectedId = data.id;
    const root = button?.closest('.booth-map-page, .booth-map-editor');
    root?.querySelectorAll('[data-action="booth-map-select"]').forEach(item => {
      const selected = item.dataset.id === data.id;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    if (root?.classList.contains('booth-map-page')) {
      const booth = E.work().booths.find(item => item.id === data.id), point = booth && pointFor(mapPoints(mapState().published), data.id);
      const own = E.person(), isOwn = own && E.ticketValid(own), summary = E.boothStampSummary(E.work().booths, E.work().visits, isOwn ? own.id : null);
      const detail = root.querySelector('.booth-map-selected');
      if (detail && booth) detail.textContent = '선택한 부스: ' + booth.name + ' · ' + (booth.zone || '구역 안내 없음') + ' · ' + statusName(booth.status) + (point ? '' : ' · 위치 미지정') + (isOwn ? (summary.visitedBoothIds.includes(booth.id) ? ' · 내 인증 완료' : ' · 내 인증 전') : '');
    } else {
      const status = root?.querySelector('[data-map-selection-status]'), booth = E.work().booths.find(item => item.id === data.id);
      if (status && booth) status.textContent = '선택한 부스: ' + booth.name + ' · ' + (booth.zone || '구역 안내 없음') + ' · ' + statusName(booth.status) + ' · 목록에서 좌표를 직접 입력하거나 배치도 위치를 선택하세요.';
    }
  };
  E.actions['booth-map-jump'] = data => {
    const target = document.getElementById(data.target);
    if (!target) throw Error('이동할 배치도 구역을 찾을 수 없습니다.');
    target.focus({ preventScroll: true });
    const top = Math.max(0, (window.scrollY || window.pageYOffset || 0) + target.getBoundingClientRect().top);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
  };
  E.actions['booth-map-zoom'] = (data, button) => {
    const root = button?.closest('.booth-map-page, .booth-map-editor');
    const stage = root?.querySelector('[data-map-canvas]');
    const viewport = E.boothMapSetViewport(data.value, 24, { width: stage?.clientWidth, height: stage?.clientHeight });
    const art = root?.querySelector('.booth-map-art');
    if (art) art.style.transform = 'translate(' + viewport.x + 'px,' + viewport.y + 'px) scale(' + viewport.scale + ')';
  };
  E.actions['booth-map-place'] = (data, button) => {
    const row = button.closest('.booth-map-edit-row');
    if (!row) throw Error('부스 좌표를 찾을 수 없습니다.');
    if (E.boothMapLocalState().replacementPending) throw Error('새 배치도 이미지를 먼저 빈 위치로 저장하세요.');
    E.boothMapSetPoint(data.id, row.querySelector('[name="x"]').value, row.querySelector('[name="y"]').value);
    E.dirty = true;
    window.requestAnimationFrame?.(() => document.querySelectorAll('[data-action="booth-map-place"]').forEach(item => { if (item.dataset.id === data.id) item.focus(); }));
  };
  E.actions['booth-map-remove'] = data => {
    E.boothMapRemovePoint(data.id);
    E.dirty = true;
    window.requestAnimationFrame?.(() => document.querySelectorAll('[data-action="booth-map-remove"]').forEach(item => { if (item.dataset.id === data.id) item.focus(); }));
  };
  async function refreshMapDraft(local, discard) {
    if (typeof E.remote?.bootstrap !== 'function') throw Error('최신 초안을 불러올 수 없습니다. 연결 상태를 확인하세요.');
    const eventBefore = eventId(), accountBefore = E.session?.id;
    await E.remote.bootstrap();
    if (eventId() !== eventBefore || E.session?.id !== accountBefore || !E.can('booth', true)) throw Error('행사 또는 운영 권한이 바뀌었습니다. 현재 화면을 확인한 뒤 다시 시작하세요.');
    const draft = mapState().draft, image = fileRef(draft);
    if (!draft || !image?.fileId) throw Error('현재 서버 초안을 확인하지 못했습니다. 내 변경은 그대로 남아 있습니다.');
    if (discard) {
      uiState().local = null;
      E.boothMapLocalState();
      E.toast('현재 서버 초안을 불러왔습니다. 기존 좌표 변경은 폐기했습니다.');
      E.dirty = true;
      return;
    }
    const boothIds = safeList(E.work().booths).map(booth => booth.id).sort();
    const previousBoothIds = (local.conflictBoothIds || []).slice().sort();
    if (image.fileId !== local.image?.fileId || boothIds.join('|') !== previousBoothIds.join('|')) throw Error('초안 이미지 또는 부스 구성이 바뀌었습니다. 내 좌표는 유지되며 현재 배치와 직접 비교한 뒤 조정하세요.');
    local.expectedDraftVersion = draft.version;
    local.savedDraft = true;
    local.conflict = false;
    local.replacementPending = false;
    local.dirty = true;
    E.toast('내 좌표를 유지했습니다. 현재 초안 버전 ' + draft.version + '을 확인하고 저장을 눌러 적용하세요.');
    E.dirty = true;
  }
  E.actions['booth-map-rebase'] = () => refreshMapDraft(E.boothMapLocalState(), false);
  E.actions['booth-map-discard'] = () => refreshMapDraft(E.boothMapLocalState(), true);
  E.actions['booth-map-save'] = async () => {
    const local = E.boothMapLocalState();
    if (!local.image?.fileId) throw Error('배치도 이미지를 먼저 선택하세요.');
    if (local.replacementPending && local.points.length) throw Error('새 배치도는 위치를 비운 상태로 먼저 저장하세요.');
    let result;
    try { result = await E.run('booth.map.save', { fileId: local.image.fileId, points: local.points.map(p => ({ boothId: p.boothId, x: p.x, y: p.y })), expectedDraftVersion: local.expectedDraftVersion }); }
    catch (error) {
      if (error.status === 409 || error.code === 'STALE_DATA') {
        local.conflict = true;
        local.conflictBoothIds = safeList(E.work().booths).map(booth => booth.id);
        E.dirty = true;
        E.render?.();
      }
      throw error;
    }
    const next = result?.boothMap?.draft;
    if (!next) throw Error('초안 저장 결과를 확인하지 못했습니다. 새로고침해 서버 상태를 확인하세요.');
    local.image = fileRef(next) || local.image;
    local.points = mapPoints(next).map(p => ({ boothId: p.boothId, x: p.x, y: p.y }));
    local.expectedDraftVersion = next.version;
    local.dirty = false;
    local.savedDraft = true;
    local.replacementPending = false;
    local.conflict = false;
    E.toast('배치도 초안을 저장했습니다.');
    E.dirty = true;
    window.requestAnimationFrame?.(() => document.querySelectorAll('[data-action="booth-map-save"]').forEach(item => item.focus()));
  };
  E.actions['booth-map-publish'] = async () => {
    const local = E.boothMapLocalState(), draft = mapState().draft;
    if (local.dirty) throw Error('저장되지 않은 변경이 있습니다. 먼저 초안을 저장하세요.');
    if (!draft) throw Error('게시할 초안이 없습니다. 먼저 초안을 저장하세요.');
    await E.run('booth.map.publish', { expectedDraftVersion: draft.version });
    E.toast('배치도를 게시했습니다.');
    E.dirty = true;
    window.requestAnimationFrame?.(() => document.querySelectorAll('[data-action="booth-map-publish"]').forEach(item => item.focus()));
  };
  E.actions['booth-map-unpublish'] = async data => {
    const version = Number(data.version ?? mapState().published?.version);
    if (!Number.isInteger(version) || version < 1) throw Error('게시 버전을 확인할 수 없습니다.');
    await E.run('booth.map.unpublish', { expectedPublishedVersion: version });
    E.toast('배치도 게시를 해제했습니다.');
    E.dirty = true;
    window.requestAnimationFrame?.(() => document.querySelectorAll('[data-action="booth-map-unpublish"]').forEach(item => item.focus()));
  };

  document.addEventListener('change', async event => {
    const input = event.target;
    if (!input.matches?.('[data-booth-map-upload]')) return;
    const replace = async () => {
      try { await E.boothMapUploadFile(input.files?.[0]); E.toast('새 배치도를 선택했습니다. 위치를 다시 지정한 뒤 저장하세요.'); E.render(); window.requestAnimationFrame?.(() => document.querySelector('[data-booth-map-upload]')?.focus()); }
      catch (error) { E.dialog('배치도를 선택하지 못했습니다', E.notice(esc(error.message), 'error')); }
    };
    if ((E.boothMapLocalState().points.length || E.boothMapLocalState().savedDraft) && typeof E.confirm === 'function') E.confirm('배치도 교체', '현재 배치한 부스 좌표를 비우고 새 이미지로 바꿉니다. 저장된 초안은 빈 위치로 먼저 저장해야 다시 배치할 수 있습니다. 기존 게시본은 새 지도를 게시할 때까지 유지됩니다.', replace);
    else await replace();
  });
  document.addEventListener('error', event => {
    const image = event.target.closest?.('[data-booth-map-image]');
    if (image) { const state = uiState(), id = image.dataset.fileId; if (id && state.imageStatus[id] !== 'error') { state.imageStatus[id] = 'error'; E.render?.(); } }
  }, true);
  document.addEventListener('load', event => {
    const image = event.target.closest?.('[data-booth-map-image]');
    if (image) { const state = uiState(), id = image.dataset.fileId; if (id && state.imageStatus[id] !== 'ready') { state.imageStatus[id] = 'ready'; E.render?.(); } }
  }, true);
  document.addEventListener('click', event => {
    const canvas = event.target.closest?.('[data-map-canvas]');
    if (!canvas || event.target.closest('[data-action="booth-map-select"]')) return;
    if (!canvas.closest('.booth-map-editor') || canvas.dataset.mapReady !== 'true') return;
    const local = E.boothMapLocalState(), selected = uiState().selectedId;
    if (!selected || !local.image || local.replacementPending) return;
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const viewport = uiState().viewport;
    const x = Math.max(0, Math.min(1, (event.clientX - box.left - viewport.x) / (box.width * viewport.scale)));
    const y = Math.max(0, Math.min(1, (event.clientY - box.top - viewport.y) / (box.height * viewport.scale)));
    E.boothMapSetPoint(selected, x, y);
    E.dirty = true;
    E.render();
    window.requestAnimationFrame?.(() => document.querySelectorAll('[data-action="booth-map-place"]').forEach(item => { if (item.dataset.id === selected) item.focus(); }));
  });
})(window.ET);
