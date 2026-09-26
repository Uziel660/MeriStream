const port = Number(process.env.DEVTOOLS_PORT || 9222);
const action = process.argv[2] || 'state';
const base = `http://127.0.0.1:${port}`;

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function discoverPage() {
  let pages = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${base}/json`);
      if (response.ok) pages = await response.json();
      const page = pages.find((item) => item.type === 'page' && /localhost/i.test(item.url || ''))
        || pages.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await delay(500);
  }
  throw new Error(`No debuggable Android WebView page found on ${base}`);
}

async function connect() {
  const page = await discoverPage();
  const url = new URL(page.webSocketDebuggerUrl);
  url.hostname = '127.0.0.1';
  url.port = String(port);

  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out opening WebView DevTools socket')), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('Failed to open WebView DevTools socket'));
    }, { once: true });
  });

  ws.addEventListener('message', (event) => {
    let payload;
    try { payload = JSON.parse(String(event.data)); } catch { return; }
    if (!payload.id || !pending.has(payload.id)) return;
    const { resolve, reject, timer } = pending.get(payload.id);
    pending.delete(payload.id);
    clearTimeout(timer);
    if (payload.error) reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else resolve(payload.result);
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 12000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  return { ws, call };
}

async function evaluate(call, expression, userGesture = false, awaitPromise = true) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result?.result?.value;
}

const { ws, call } = await connect();

try {
  await call('Runtime.enable');
  await call('Page.enable');

  if (action === 'seed-catalog') {
    await evaluate(call, `(() => {
      const sample = [
        {
          id: 'tmdb-movie-550', tmdb_id: 550, title: 'MeriStream Movie',
          normalized_title: 'meristream movie', category: 'movie', kind: 'movie',
          year: 2026, rating: 8.4, genres: 'Drama', status: 'Finalizado',
          poster_url: '', banner_url: '', backdrop_url: '',
          sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
        },
        {
          id: 'tmdb-series-1396', tmdb_id: 1396, title: 'MeriStream Series',
          normalized_title: 'meristream series', category: 'series', kind: 'series',
          year: 2026, rating: 8.7, genres: 'Drama', status: 'Emisión',
          poster_url: '', banner_url: '', backdrop_url: '',
          sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
        },
        {
          id: 'tmdb-anime-21', tmdb_id: 21, title: 'MeriStream Anime',
          normalized_title: 'meristream anime', category: 'anime', kind: 'anime',
          year: 2026, rating: 8.2, genres: 'Animación, Acción', status: 'Emisión',
          poster_url: '', banner_url: '', backdrop_url: '',
          sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
        }
      ];
      localStorage.setItem('nitiflix_catalog_cache_v5', JSON.stringify({ data: sample, timestamp: Date.now() }));
      return true;
    })()`);
    await call('Page.reload', { ignoreCache: true });
    await delay(1800);
    const count = await evaluate(call, `document.querySelectorAll('.media-card').length`);
    console.log(JSON.stringify({ action, cards: count }));
  } else if (action === 'open-menu') {
    const opened = await evaluate(call, `(() => {
      const button = document.querySelector('.mobile-nav-trigger');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!opened) throw new Error('Mobile navigation trigger was not found');
    await delay(350);
    console.log(JSON.stringify({ action, opened }));
  } else if (action === 'close-menu') {
    await evaluate(call, `document.querySelector('.mobile-nav-backdrop')?.click(); true`);
    await delay(200);
    console.log(JSON.stringify({ action, closed: true }));
  } else if (action === 'assert-menu-closed') {
    await delay(250);
    const menuOpen = await evaluate(call, `Boolean(document.querySelector('.mobile-nav-sheet'))`);
    console.log(JSON.stringify({ action, menuOpen }));
    if (menuOpen) throw new Error('Android Back did not close the mobile navigation sheet');
  } else if (action === 'open-preferences') {
    const opened = await evaluate(call, `(() => {
      if (!document.querySelector('.mobile-nav-sheet')) {
        document.querySelector('.mobile-nav-trigger')?.click();
      }
      const buttons = [...document.querySelectorAll('.mobile-nav-action')];
      const target = buttons.find((button) => /preferencias/i.test(button.textContent || ''));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!opened) throw new Error('Preferences action was not found in the mobile sheet');
    await delay(450);
    const visible = await evaluate(call, `Boolean(document.querySelector('.preferences-panel'))`);
    if (!visible) throw new Error('Preferences bottom sheet did not open');
    console.log(JSON.stringify({ action, opened: visible }));
  } else if (action === 'assert-preferences-closed') {
    await delay(250);
    const visible = await evaluate(call, `Boolean(document.querySelector('.preferences-panel'))`);
    console.log(JSON.stringify({ action, visible }));
    if (visible) throw new Error('Android Back did not close Preferences');
  } else if (action === 'open-auth') {
    const opened = await evaluate(call, `(() => {
      const button = document.querySelector('.account-login');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!opened) throw new Error('Account/login button was not found');
    await delay(350);
    const visible = await evaluate(call, `Boolean(document.querySelector('.auth-panel'))`);
    if (!visible) throw new Error('Auth sheet did not open');
    console.log(JSON.stringify({ action, opened: visible }));
  } else if (action === 'assert-auth-closed') {
    await delay(250);
    const visible = await evaluate(call, `Boolean(document.querySelector('.auth-panel'))`);
    console.log(JSON.stringify({ action, visible }));
    if (visible) throw new Error('Android Back did not close Auth');
  } else if (action === 'open-lists') {
    const opened = await evaluate(call, `(() => {
      if (!document.querySelector('.mobile-nav-sheet')) document.querySelector('.mobile-nav-trigger')?.click();
      const buttons = [...document.querySelectorAll('.mobile-nav-item')];
      const target = buttons.find((button) => /mis listas/i.test(button.textContent || ''));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!opened) throw new Error('Mis Listas navigation item was not found');
    await delay(900);
    const visible = await evaluate(call, `Boolean(document.querySelector('.my-lists-view'))`);
    if (!visible) throw new Error('Mis Listas surface did not render');
    console.log(JSON.stringify({ action, opened: visible }));
  } else if (action === 'open-list-create') {
    const opened = await evaluate(call, `(() => {
      const root = document.querySelector('.my-lists-view');
      if (!root) return false;
      const target = [...root.querySelectorAll('button')].find((button) => /nueva lista/i.test(button.textContent || ''));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!opened) throw new Error('Nueva Lista action was not found');
    await delay(350);
    const visible = await evaluate(call, `Boolean(document.querySelector('.native-list-modal-panel'))`);
    if (!visible) throw new Error('Create-list sheet did not open');
    console.log(JSON.stringify({ action, opened: visible }));
  } else if (action === 'assert-list-modal-closed') {
    await delay(250);
    const visible = await evaluate(call, `Boolean(document.querySelector('.native-list-modal-panel'))`);
    console.log(JSON.stringify({ action, visible }));
    if (visible) throw new Error('Android Back did not close list editor');
  } else if (action === 'open-explore-filters') {
    const opened = await evaluate(call, `(() => {
      if (!document.querySelector('.mobile-nav-sheet')) document.querySelector('.mobile-nav-trigger')?.click();
      const buttons = [...document.querySelectorAll('.mobile-nav-item')];
      const target = buttons.find((button) => /^explorar$/i.test((button.textContent || '').trim()));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!opened) throw new Error('Explorar navigation item was not found');
    await delay(900);
    const filtersOpened = await evaluate(call, `(() => {
      const trigger = document.querySelector('.native-explore-filter-trigger');
      if (!trigger) return false;
      trigger.click();
      return true;
    })()`);
    if (!filtersOpened) throw new Error('Explore filter trigger was not found');
    await delay(350);
    const visible = await evaluate(call, `Boolean(document.querySelector('.native-explore-filter-sheet'))`);
    if (!visible) throw new Error('Explore filter sheet did not open');
    console.log(JSON.stringify({ action, opened: visible }));
  } else if (action === 'assert-explore-filters-closed') {
    await delay(250);
    const visible = await evaluate(call, `Boolean(document.querySelector('.native-explore-filter-sheet'))`);
    console.log(JSON.stringify({ action, visible }));
    if (visible) throw new Error('Android Back did not close Explore filters');
  } else if (action === 'open-player') {
    await call('Page.navigate', { url: 'https://localhost/?test_player=1' });
    await delay(7000);
    const hasPlayer = await evaluate(call, `Boolean(document.querySelector('[data-player-root]'))`);
    if (!hasPlayer) throw new Error('Android smoke player did not mount');
    console.log(JSON.stringify({ action, hasPlayer }));
  } else if (action === 'play') {
    const result = await evaluate(call, `(async () => {
      const video = document.querySelector('video');
      if (!video) return { found: false };
      try { await video.play(); } catch (error) {}
      return { found: true, paused: video.paused, readyState: video.readyState, currentTime: video.currentTime };
    })()`, true, true);
    console.log(JSON.stringify({ action, ...result }));
  } else if (action === 'assert-player') {
    await delay(3500);
    const state = await evaluate(call, `(() => {
      const video = document.querySelector('video');
      const root = document.querySelector('[data-player-root]');
      if (!video) return { found: false, player: Boolean(root) };
      return {
        found: true,
        player: Boolean(root),
        paused: video.paused,
        currentTime: Number(video.currentTime || 0),
        duration: Number.isFinite(video.duration) ? video.duration : null,
        readyState: video.readyState,
        networkState: video.networkState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
        fullscreen: Boolean(document.fullscreenElement),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      };
    })()`);
    console.log(JSON.stringify({ action, state }, null, 2));
    if (!state?.found || !state.player) throw new Error('Player/video is not mounted');
    if (state.error) throw new Error(`Video error ${state.error.code}: ${state.error.message || 'unknown'}`);
    if (state.readyState < 2) throw new Error(`Video never reached HAVE_CURRENT_DATA (readyState=${state.readyState})`);
    if (state.currentTime <= 0.25) throw new Error(`Video did not make playback progress (currentTime=${state.currentTime})`);
  } else {
    const state = await evaluate(call, `({
      url: location.href,
      nativeShell: document.documentElement.dataset.nativeShell || null,
      performance: document.documentElement.dataset.msPerformance || null,
      menuOpen: Boolean(document.querySelector('.mobile-nav-sheet')),
      preferencesOpen: Boolean(document.querySelector('.preferences-panel')),
      accountOpen: Boolean(document.querySelector('.account-menu')),
      player: Boolean(document.querySelector('[data-player-root]')),
      title: document.title
    })`);
    console.log(JSON.stringify({ action, state }, null, 2));
  }
} finally {
  ws.close();
}
