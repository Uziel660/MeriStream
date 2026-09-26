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

  const ensureMobileMenuOpen = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ready = await evaluate(call, `(() => {
        if (document.querySelector('.mobile-nav-sheet')) return { open: true, trigger: true, route: location.href };
        window.scrollTo({ top: 0, behavior: 'auto' });
        window.dispatchEvent(new Event('scroll'));
        const trigger = document.querySelector('.mobile-nav-trigger');
        if (!trigger) return { open: false, trigger: false, route: location.href };
        trigger.click();
        return { open: Boolean(document.querySelector('.mobile-nav-sheet')), trigger: true, route: location.href };
      })()`);
      if (ready?.open) return true;
      if (attempt === 0 || attempt === 5 || attempt === 11) {
        console.log(JSON.stringify({ action: 'ensure-mobile-menu', attempt, ...ready }));
      }
      await delay(180);
    }
    return false;
  };

  const clickMobileMenuAction = async (pattern, selector = '.mobile-nav-action') => evaluate(call, `(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const re = new RegExp(${JSON.stringify(pattern)}, 'i');
    const target = nodes.find((node) => re.test((node.textContent || '').trim()));
    if (!target) return { clicked: false, labels: nodes.map((node) => (node.textContent || '').trim()).filter(Boolean) };
    target.click();
    return { clicked: true, labels: nodes.map((node) => (node.textContent || '').trim()).filter(Boolean) };
  })()`);

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
    await evaluate(call, `(() => { const el = document.querySelector('.mobile-nav-backdrop'); if (el) el.click(); return true; })()`);
    await delay(200);
    console.log(JSON.stringify({ action, closed: true }));
  } else if (action === 'assert-menu-closed') {
    await delay(250);
    const menuOpen = await evaluate(call, `Boolean(document.querySelector('.mobile-nav-sheet'))`);
    console.log(JSON.stringify({ action, menuOpen }));
    if (menuOpen) throw new Error('Android Back did not close the mobile navigation sheet');
  } else if (action === 'open-preferences') {
    const menuReady = await ensureMobileMenuOpen();
    if (!menuReady) throw new Error('Could not open mobile navigation before Preferences');
    await delay(120);
    const result = await clickMobileMenuAction('preferencias');
    if (!result?.clicked) throw new Error(`Preferences action was not found. Mobile actions: ${JSON.stringify(result?.labels || [])}`);
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
    const menuReady = await ensureMobileMenuOpen();
    if (!menuReady) throw new Error('Could not open mobile navigation before Auth');
    await delay(120);
    const result = await clickMobileMenuAction('ingresar');
    if (!result?.clicked) throw new Error(`Login action was not found. Mobile actions: ${JSON.stringify(result?.labels || [])}`);
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      ready = await evaluate(call, `Boolean(document.querySelector('.auth-panel #auth-username')) && !Boolean(document.querySelector('.deferred-overlay-fallback'))`);
      if (ready) break;
      await delay(250);
    }
    if (!ready) throw new Error('Login form did not finish loading');
    await delay(500);
    console.log(JSON.stringify({ action, opened: ready }));
  } else if (action === 'assert-auth-closed') {
    await delay(250);
    const visible = await evaluate(call, `Boolean(document.querySelector('.auth-panel'))`);
    console.log(JSON.stringify({ action, visible }));
    if (visible) throw new Error('Android Back did not close Auth');
  } else if (action === 'open-lists') {
    const menuReady = await ensureMobileMenuOpen();
    if (!menuReady) throw new Error('Could not open mobile navigation before Mis Listas');
    await delay(120);
    const result = await clickMobileMenuAction('mis listas', '.mobile-nav-item');
    if (!result?.clicked) throw new Error(`Mis Listas item was not found. Navigation items: ${JSON.stringify(result?.labels || [])}`);
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
    const menuReady = await ensureMobileMenuOpen();
    if (!menuReady) throw new Error('Could not open mobile navigation before Explorar');
    await delay(120);
    const result = await clickMobileMenuAction('explorar', '.mobile-nav-item');
    if (!result?.clicked) throw new Error(`Explorar item was not found. Navigation items: ${JSON.stringify(result?.labels || [])}`);
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
  } else if (action === 'open-watch-party') {
    const menuReady = await ensureMobileMenuOpen();
    if (!menuReady) throw new Error('Could not open mobile navigation before Watch Party');
    await delay(120);
    const result = await clickMobileMenuAction('watch party');
    if (!result?.clicked) throw new Error(`Watch Party action was not found. Mobile actions: ${JSON.stringify(result?.labels || [])}`);
    await delay(450);
    const visible = await evaluate(call, `Boolean(document.querySelector('.watch-party-join-panel'))`);
    if (!visible) throw new Error('Watch Party join sheet did not open');
    console.log(JSON.stringify({ action, opened: visible }));
  } else if (action === 'assert-watch-party-closed') {
    await delay(300);
    const visible = await evaluate(call, `Boolean(document.querySelector('.watch-party-join-panel'))`);
    console.log(JSON.stringify({ action, visible }));
    if (visible) throw new Error('Android Back did not close Watch Party join sheet');
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
  } else if (action === 'open-player-more') {
    const opened = await evaluate(call, `(() => {
      const button = document.querySelector('button[aria-label="Más controles"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!opened) throw new Error('Player More button was not found');
    await delay(250);
    const state = await evaluate(call, `(() => {
      const actions = [...document.querySelectorAll('.mobile-player-more-action')];
      const sheet = document.querySelector('.native-player-more-sheet');
      const bounds = sheet ? sheet.getBoundingClientRect() : null;
      const lastAction = actions[actions.length - 1];
      let lastBounds = lastAction ? lastAction.getBoundingClientRect() : null;
      let lastReachable = Boolean(bounds && lastBounds && lastBounds.top >= bounds.top - 1 && lastBounds.bottom <= bounds.bottom + 1);
      if (sheet && lastAction && !lastReachable) {
        sheet.scrollTop = sheet.scrollHeight;
        lastBounds = lastAction.getBoundingClientRect();
        lastReachable = Boolean(bounds && lastBounds.top >= bounds.top - 1 && lastBounds.bottom <= bounds.bottom + 1);
        sheet.scrollTop = 0;
      }
      return {
        visible: actions.length > 0,
        labels: actions.map((node) => (node.textContent || '').trim()).filter(Boolean),
        sheetBounds: bounds ? { top: bounds.top, right: bounds.right, bottom: bounds.bottom } : null,
        viewport: { width: innerWidth, height: innerHeight },
        lastReachable,
        scrollHeight: sheet ? sheet.scrollHeight : null,
        clientHeight: sheet ? sheet.clientHeight : null,
      };
    })()`);
    if (!state?.visible) throw new Error('Player More sheet did not open');
    if (!state.sheetBounds || state.sheetBounds.top < -1 || state.sheetBounds.right > state.viewport.width + 1 || state.sheetBounds.bottom > state.viewport.height + 1 || !state.lastReachable) {
      throw new Error(`Player More actions are clipped or unreachable: ${JSON.stringify(state)}`);
    }
    if (!state.labels.some((label) => /compartir/i.test(label))) {
      throw new Error(`Player More lost native share action: ${JSON.stringify(state.labels)}`);
    }
    console.log(JSON.stringify({ action, ...state }));
  } else if (action === 'assert-player-more-closed') {
    await delay(250);
    const visible = await evaluate(call, `Boolean(document.querySelector('.mobile-player-more-action'))`);
    const player = await evaluate(call, `Boolean(document.querySelector('[data-player-root]'))`);
    console.log(JSON.stringify({ action, visible, player }));
    if (visible) throw new Error('Android Back did not close Player More controls');
    if (!player) throw new Error('Android Back closed the player instead of the top-most controls');
  } else if (action === 'open-player-party') {
    await evaluate(call, `(() => { const button = document.querySelector('button[aria-label="Más controles"]'); if (button) button.click(); })()`);
    await delay(200);
    const opened = await evaluate(call, `(() => {
      const action = [...document.querySelectorAll('.mobile-player-more-action')].find((node) => /ver en grupo|watch party/i.test(node.textContent || ''));
      if (action) action.click();
      return Boolean(action);
    })()`);
    if (!opened) throw new Error('Player Watch Party action was not found');
    await delay(300);
    const state = await evaluate(call, `({
      join: Boolean(document.querySelector('.watch-party-join-panel')),
      player: Boolean(document.querySelector('[data-player-root]')),
      historyOverlay: (window.history.state && window.history.state.meristream_native_overlay) || null,
    })`);
    console.log(JSON.stringify({ action, state }));
    if (!state.join || !state.player || state.historyOverlay === 'watch-party-join') {
      throw new Error(`Player Watch Party has the wrong layer or history state: ${JSON.stringify(state)}`);
    }
  } else if (action === 'assert-player-party-closed') {
    await delay(250);
    const state = await evaluate(call, `({
      join: Boolean(document.querySelector('.watch-party-join-panel')),
      player: Boolean(document.querySelector('[data-player-root]')),
    })`);
    console.log(JSON.stringify({ action, state }));
    if (state.join || !state.player) throw new Error('Android Back did not close only the player Watch Party sheet');
  } else if (action === 'open-player-quality') {
    const opened = await evaluate(call, `(() => {
      const button = document.querySelector('[data-player-controls] button[title="Calidad de video"]');
      if (button) button.click();
      return Boolean(button);
    })()`);
    if (!opened) throw new Error('Player quality selector button was not found');
    await delay(200);
    const visible = await evaluate(call, `Boolean(document.querySelector('[data-player-menu="quality"]'))`);
    if (!visible) throw new Error('Player quality selector did not open');
    console.log(JSON.stringify({ action, visible }));
  } else if (action === 'assert-player-quality-closed') {
    await delay(250);
    const state = await evaluate(call, `({
      selector: Boolean(document.querySelector('[data-player-menu="quality"]')),
      player: Boolean(document.querySelector('[data-player-root]')),
    })`);
    console.log(JSON.stringify({ action, state }));
    if (state.selector || !state.player) throw new Error('Android Back did not close only the player selector');
  } else if (action === 'assert-player-closed') {
    await delay(400);
    const state = await evaluate(call, `({
      player: Boolean(document.querySelector('[data-player-root]')),
      catalog: Boolean(document.querySelector('.site-header')),
      route: location.pathname + location.search,
      historyState: window.history.state,
    })`);
    console.log(JSON.stringify({ action, state }));
    if (state.player || !state.catalog) throw new Error('Android Back did not return from the player to the catalog');
  } else if (action === 'assert-native-player') {
    await delay(500);
    const state = await evaluate(call, `({
      nativeShell: document.documentElement.dataset.nativeShell || null,
      nativeBindings: document.documentElement.dataset.nativeBindings || null,
      player: Boolean(document.querySelector('[data-player-root]')),
      legacyWebview: document.documentElement.dataset.nativeLegacyWebview || null,
      playButtonBackground: (() => {
        const button = document.querySelector('[data-player-action-row] button[aria-label="Pausar"], [data-player-action-row] button[aria-label="Reproducir"]');
        return button ? getComputedStyle(button).backgroundColor : null;
      })(),
      orientation: (screen.orientation && screen.orientation.type) || null,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      fullscreen: Boolean(document.fullscreenElement)
    })`);
    console.log(JSON.stringify({ action, state }, null, 2));
    if (state.nativeShell !== 'android') throw new Error('Native Android shell marker is missing');
    if (state.nativeBindings !== 'ready') throw new Error(`Native Capacitor bindings are not ready: ${state.nativeBindings}`);
    if (!state.player) throw new Error('Player is not mounted');
    if (state.legacyWebview === 'true' && Number(state.playButtonBackground?.match(/\d+/)?.[0] || 255) > 100) {
      throw new Error(`Legacy WebView painted a light native player button: ${state.playButtonBackground}`);
    }
    const landscape = String(state.orientation || '').startsWith('landscape')
      || Number((state.viewport && state.viewport.width) || 0) > Number((state.viewport && state.viewport.height) || 0);
    if (!landscape) throw new Error(`Player did not enter landscape: ${JSON.stringify(state)}`);
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
  } else if (action === 'performance') {
    const metrics = await evaluate(call, `(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, Math.round(entry.startTime)]));
      const resources = performance.getEntriesByType('resource');
      const resourceBytes = resources.reduce((sum, entry) => sum + Number(entry.transferSize || 0), 0);
      const memory = performance.memory || null;
      return {
        shell: document.documentElement.dataset.nativeShell || null,
        performanceMode: document.documentElement.dataset.msPerformance || null,
        nativeBindings: document.documentElement.dataset.nativeBindings || null,
        navigation: {
          responseEnd: Math.round(Number(nav.responseEnd || 0)),
          domContentLoaded: Math.round(Number(nav.domContentLoadedEventEnd || 0)),
          loadEventEnd: Math.round(Number(nav.loadEventEnd || 0)),
        },
        paints,
        domNodes: document.getElementsByTagName('*').length,
        images: document.images.length,
        resources: resources.length,
        resourceTransferBytes: Math.round(resourceBytes),
        jsHeap: memory ? {
          used: Number(memory.usedJSHeapSize || 0),
          total: Number(memory.totalJSHeapSize || 0),
          limit: Number(memory.jsHeapSizeLimit || 0),
        } : null,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      };
    })()`);
    console.log(JSON.stringify({ action, metrics }, null, 2));
  } else if (action === 'assert-low-end-mode') {
    const mode = await evaluate(call, `document.documentElement.dataset.msPerformance || null`);
    console.log(JSON.stringify({ action, mode }));
    if (mode !== 'low') throw new Error(`Constrained Android did not select low performance mode (got ${mode})`);
  } else if (action === 'assert-native-plugins') {
    const plugins = await evaluate(call, `(() => {
      const cap = window.Capacitor;
      const names = ['App', 'Haptics', 'Keyboard', 'ScreenOrientation', 'Share', 'SystemBars'];
      const result = {};
      for (const name of names) {
        result[name] = Boolean(cap && typeof cap.isPluginAvailable === 'function' && cap.isPluginAvailable(name));
      }
      return result;
    })()`);
    const missing = Object.entries(plugins || {}).filter(([, available]) => !available).map(([name]) => name);
    console.log(JSON.stringify({ action, plugins, missing }));
    if (missing.length) throw new Error(`Native Capacitor plugins missing from APK: ${missing.join(', ')}`);
  } else {
    const state = await evaluate(call, `({
      url: location.href,
      nativeShell: document.documentElement.dataset.nativeShell || null,
      nativeBindings: document.documentElement.dataset.nativeBindings || null,
      legacyWebView: document.documentElement.dataset.nativeLegacyWebview || null,
      webViewMajor: document.documentElement.dataset.nativeWebviewMajor || null,
      performance: document.documentElement.dataset.msPerformance || null,
      menuOpen: Boolean(document.querySelector('.mobile-nav-sheet')),
      preferencesOpen: Boolean(document.querySelector('.preferences-panel')),
      accountOpen: Boolean(document.querySelector('.account-menu')),
      player: Boolean(document.querySelector('[data-player-root]')),
      title: document.title
    })`);
    console.log(JSON.stringify({ action, state }, null, 2));
    if (state?.nativeShell === 'android' && state?.nativeBindings !== 'ready') {
      throw new Error(`Android build did not bundle official native plugin bindings (state=${state?.nativeBindings})`);
    }
  }
} finally {
  ws.close();
}
