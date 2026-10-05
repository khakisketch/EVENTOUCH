(function (root) {
  'use strict';

  var ETKO = root.ETKO || (root.ETKO = {});

  var SESSION_COOKIE_NAME = 'etko_session';

  function fetchFn() {
    if (typeof root.fetch === 'function') return root.fetch.bind(root);
    if (typeof fetch === 'function') return fetch;
    throw new Error('서버에 연결할 수 없습니다');
  }

  async function request(method, urlPath, body) {
    const base = (ETKO.remote && ETKO.remote.base) || '';
    const headers = {};
    if (!ETKO.remote.jar) ETKO.remote.jar = {};
    const jarKeys = Object.keys(ETKO.remote.jar);
    if (jarKeys.length > 0) {
      headers.cookie = jarKeys.map((k) => k + '=' + ETKO.remote.jar[k]).join('; ');
    }
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res = null;
    try {
      res = await fetchFn()(base + urlPath, {
        method,
        headers,
        credentials: 'same-origin',
        body: payload,
      });
    } catch (err) {
      throw new Error('서버에 연결할 수 없습니다');
    }
    try {
      const setCookies =
        typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      setCookies.forEach((line) => {
        const match = /^\s*([^=;]+)=([^;]*)/.exec(String(line));
        if (match) ETKO.remote.jar[match[1].trim()] = decodeURIComponent(match[2].trim());
      });
      if (ETKO.remote.jar[SESSION_COOKIE_NAME] === '') delete ETKO.remote.jar[SESSION_COOKIE_NAME];
    } catch (err) {}
    let data = null;
    try {
      data = await res.json();
    } catch (err) {}
    if (!res.ok) {
      const error = new Error((data && data.error) || '요청을 처리하지 못했습니다');
      if (data && data.field) error.field = data.field;
      error.status = res.status;
      throw error;
    }
    return data;
  }

  ETKO.remote = {
    base: '',
    get(path) {
      return request('GET', path);
    },
    post(path, body) {
      return request('POST', path, body);
    },
    put(path, body) {
      return request('PUT', path, body);
    },
    patch(path, body) {
      return request('PATCH', path, body);
    },
    del(path) {
      return request('DELETE', path);
    },
  };

  // Detect a real product server. Static-only previews answer 404 here.
  // Never throws: unreachable means local demo mode.
  ETKO.bootRemote = async function () {
    try {
      const health = await ETKO.remote.get('/api/health');
      if (!health || health.ok !== true) return { mode: 'demo' };
    } catch (err) {
      return { mode: 'demo' };
    }
    try {
      const me = await ETKO.remote.get('/api/auth/me');
      if (me && me.user) return { mode: 'server', user: me.user };
    } catch (err) {}
    return { mode: 'login-needed' };
  };

  // Pull shared events + workspaces into the local store shape.
  ETKO.pullRemoteStore = async function () {
    const data = await ETKO.remote.get('/api/events');
    if (!ETKO.store) ETKO.store = { events: [], workspaces: {}, activeEventId: null };
    ETKO.store.events = data.events || [];
    let pulled = 0;
    for (const ev of ETKO.store.events) {
      if (!ev || !ev.id) continue;
      try {
        const detail = await ETKO.remote.get('/api/events/' + ev.id + '/workspace');
        if (detail && detail.workspace) {
          ETKO.store.workspaces[ev.id] = detail.workspace;
          pulled += 1;
        }
      } catch (err) {}
    }
    if (!ETKO.store.activeEventId || !ETKO.store.workspaces[ETKO.store.activeEventId]) {
      ETKO.store.activeEventId =
        (data && data.activeEventId) ||
        (ETKO.store.events[0] && ETKO.store.events[0].id) ||
        null;
    }
    return { events: ETKO.store.events.length, pulled };
  };

  // Replay locally queued offline scans after a local sync. Runs only
  // with an authenticated server session; otherwise skipped so demo and
  // logged-out flows never fire doomed requests. Server-side duplicate
  // detection keeps replays idempotent.
  ETKO.replayPending = async function (eventId, pending) {
    if (ETKO.serverSession !== true) return { applied: 0, duplicates: 0, skipped: true };
    const entries = Array.isArray(pending) ? pending.filter(Boolean) : [];
    if (!eventId || entries.length === 0) return { applied: 0, duplicates: 0, skipped: true };
    try {
      return await ETKO.replayOutbox(eventId, entries);
    } catch (err) {
      return { applied: 0, duplicates: 0, skipped: true };
    }
  };
  ETKO.replayOutbox = async function (eventId, entries) {
    let applied = 0;
    let duplicates = 0;
    for (const entry of entries || []) {
      if (!entry) continue;
      const result = await ETKO.remote.post('/api/events/' + eventId + '/checkin', {
        code: entry.code,
        direction: entry.direction || 'IN',
        online: true,
      });
      if (result && result.key === 'success') applied += 1;
      else duplicates += 1;
    }
    return { applied, duplicates };
  };

  // Login gate rendered inside agency-home when the server is reachable
  // but no session exists. Calls onDone(user) after a successful login.
  ETKO.loginCardHtml = function () {
    return (
      '<section class="login-gate" aria-label="로그인"><h2>로그인</h2>' +
      '<p>운영 서버에 연결되었습니다. 계정으로 로그인하세요.</p>' +
      '<div class="inline-form"><div class="field"><label>아이디<input data-login-id type="text" autocomplete="username" /></label></div>' +
      '<div class="field"><label>비밀번호<input data-login-password type="password" autocomplete="current-password" /></label></div>' +
      '<p class="field-error" data-login-error role="alert" hidden></p>' +
      '<button type="button" data-login-submit>로그인</button></div></section>'
    );
  };

  ETKO.renderLoginInto = function (container, onDone) {
    if (!container) return '';
    container.innerHTML = ETKO.loginCardHtml();
    const idEl = container.querySelector ? container.querySelector('[data-login-id]') : null;
    const pwEl = container.querySelector ? container.querySelector('[data-login-password]') : null;
    const buttons = container.querySelectorAll ? container.querySelectorAll('[data-login-submit]') : [];
    Array.prototype.forEach.call(buttons, function (btn) {
      if (typeof btn.addEventListener !== 'function') return;
      btn.addEventListener('click', async function () {
        try {
          const data = await ETKO.remote.post('/api/auth/login', {
            id: idEl && idEl.value !== undefined ? String(idEl.value) : '',
            password: pwEl && pwEl.value !== undefined ? String(pwEl.value) : '',
          });
          ETKO.serverSession = true;
          if (typeof onDone === 'function') onDone(data && data.user);
        } catch (err) {
          const alert = container.querySelector ? container.querySelector('[data-login-error]') : null;
          if (alert) {
            alert.textContent = err.message;
            alert.hidden = false;
          }
        }
      });
    });
    return container.innerHTML;
  };

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = ETKO;
  }
})((typeof window !== 'undefined' && window) || globalThis);
