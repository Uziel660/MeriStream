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
    const artwork = ({ title, subtitle, from, to, wide = false }) => {
      const width = wide ? 1600 : 480;
      const height = wide ? 900 : 720;
      const titleSize = wide ? 96 : 54;
      const titleY = wide ? 670 : 570;
      const posterText = wide ? '' : `<text x="42" y="490" fill="#fff" fill-opacity=".78" font-family="Arial,sans-serif" font-size="20" font-weight="700" letter-spacing="5">${subtitle.toUpperCase()}</text>
        <text x="42" y="${titleY}" fill="#fff" font-family="Arial,sans-serif" font-size="${titleSize}" font-weight="700">${title}</text>
        <text x="46" y="620" fill="#fff" fill-opacity=".78" font-family="Arial,sans-serif" font-size="17" letter-spacing="4">MERISTREAM</text>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
        <rect width="100%" height="100%" fill="url(#bg)"/>
        <circle cx="${wide ? 1210 : 370}" cy="${wide ? 220 : 210}" r="${wide ? 280 : 150}" fill="#fff" fill-opacity=".12"/>
        <path d="M0 ${wide ? 700 : 530} Q${wide ? 650 : 190} ${wide ? 400 : 370} ${width} ${wide ? 600 : 440} V${height} H0Z" fill="#07090f" fill-opacity=".52"/>
        <path d="M0 ${wide ? 760 : 590} Q${wide ? 700 : 220} ${wide ? 590 : 490} ${width} ${wide ? 710 : 540}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="${wide ? 4 : 3}"/>
        ${posterText}
      </svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    };
    const sample = [
      {
        id: 'tmdb-movie-550', tmdb_id: 550, title: 'MeriStream Movie',
        normalized_title: 'meristream movie', category: 'movie', kind: 'movie',
        year: 2026, rating: 8.4, genres: 'Drama', status: 'Finalizado',
        poster_url: artwork({ title: 'MeriStream', subtitle: 'Una historia original', from: '#1c2349', to: '#ec8b3c' }),
        banner_url: artwork({ title: 'MeriStream', subtitle: 'Una historia original', from: '#101936', to: '#d77a37', wide: true }),
        backdrop_url: artwork({ title: 'MeriStream', subtitle: 'Una historia original', from: '#101936', to: '#d77a37', wide: true }),
        sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
      },
      {
        id: 'tmdb-series-1396', tmdb_id: 1396, title: 'MeriStream Series',
        normalized_title: 'meristream series', category: 'series', kind: 'series',
        year: 2026, rating: 8.7, genres: 'Drama', status: 'Emisión',
        poster_url: artwork({ title: 'MeriStream', subtitle: 'La serie', from: '#123d43', to: '#7d59bd' }),
        banner_url: '', backdrop_url: '',
        sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
      },
      {
        id: 'tmdb-anime-21', tmdb_id: 21, title: 'MeriStream Anime',
        normalized_title: 'meristream anime', category: 'anime', kind: 'anime',
        year: 2026, rating: 8.2, genres: 'Animación, Acción', status: 'Emisión',
        poster_url: artwork({ title: 'MeriStream', subtitle: 'Anime original', from: '#531c4e', to: '#df6b63' }),
        banner_url: '', backdrop_url: '',
        sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
      }
    ];
    await evaluate(call, `(() => {
      const sample = ${JSON.stringify(sample)};
      window.history.scrollRestoration = 'manual';
      window.scrollTo(0, 0);
      localStorage.setItem('nitiflix_catalog_cache_v5', JSON.stringify({ data: sample, timestamp: Date.now() }));
      return true;
    })()`);
    await call('Page.reload', { ignoreCache: true });
    let state = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      state = await evaluate(call, `(async () => {
        const cards = [...document.querySelectorAll('.media-card')];
        const visibleCards = cards.filter((card) => {
          const bounds = card.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < innerHeight && bounds.right > 0 && bounds.left < innerWidth;
        });
        const images = visibleCards.map((card) => card.querySelector('.media-poster-image')).filter(Boolean);
        const hero = document.querySelector('.feature-art img.feature-image');
        await Promise.all([...images, hero].filter(Boolean).map((image) => image.decode ? image.decode().catch(() => {}) : Promise.resolve()));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
          cards: cards.length,
          visibleCards: visibleCards.length,
          images: images.filter((image) => image.complete && image.naturalWidth > 0).length,
          hero: Boolean(hero && hero.complete && hero.naturalWidth > 0)
        };
      })()`);
      if (state?.cards >= 2 && state.visibleCards >= 2 && state.images >= 2 && state.hero) break;
      await delay(250);
    }
    const viewportState = await evaluate(call, `(async () => {
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const headerElement = document.querySelector('.site-header');
      const heroElement = document.querySelector('.feature-art');
      const header = headerElement ? headerElement.getBoundingClientRect() : null;
      const heroArt = heroElement ? heroElement.getBoundingClientRect() : null;
      const cards = [...document.querySelectorAll('.media-row .media-card')].slice(0, 2);
      const ratingRights = cards.map((card) => {
        const rating = card.querySelector('.media-card-meta .rating');
        return rating ? rating.getBoundingClientRect().right : 0;
      });
      return {
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        headerBottom: header ? header.bottom : 0,
        heroHeight: heroArt ? heroArt.height : 0,
        posterWidths: cards.map((card) => card.getBoundingClientRect().width),
        ratingRights
      };
    })()`);
    console.log(JSON.stringify({ action, ...state, ...viewportState }));
    if (state?.cards < 2 || state.visibleCards < 2 || state.images < 2 || !state.hero) throw new Error('Seeded catalog artwork did not finish rendering');
    if (viewportState?.scrollY !== 0 || viewportState.headerBottom <= 0 || viewportState.heroHeight < 100) throw new Error(`Catalog screenshot did not return to its complete top-of-page layout: ${JSON.stringify(viewportState)}`);
    if (viewportState.posterWidths.some((width) => width > viewportState.viewportWidth * 0.5) || viewportState.ratingRights.some((right) => right > viewportState.viewportWidth)) throw new Error(`Mobile catalog cards overflow the viewport: ${JSON.stringify(viewportState)}`);
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
    const state = await evaluate(call, `(() => {
      const previews = [...document.querySelectorAll('.interface-style-preview')];
      const first = previews[0];
      const bounds = first?.getBoundingClientRect();
      return {
        visible: Boolean(document.querySelector('.preferences-panel')),
        previewCount: previews.length,
        firstPreview: bounds ? { width: bounds.width, height: bounds.height } : null,
        previewDisplay: first ? getComputedStyle(first).display : null,
        previewBeforeWidth: first ? getComputedStyle(first, '::before').width : null,
      };
    })()`);
    if (!state.visible) throw new Error('Preferences bottom sheet did not open');
    if (state.previewCount < 4 || state.firstPreview?.width < 100 || state.firstPreview?.height < 32 || state.previewDisplay !== 'block' || Number.parseFloat(state.previewBeforeWidth) < 20) {
      throw new Error(`Interface style previews are not laid out visibly: ${JSON.stringify(state)}`);
    }
    console.log(JSON.stringify({ action, opened: state.visible, ...state }));
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
      const backdrop = document.querySelector('.native-player-more-backdrop');
      const video = document.querySelector('[data-player-root] video');
      const bounds = sheet ? sheet.getBoundingClientRect() : null;
      const styleSummary = (node) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
        return {
          tag: node.tagName,
          className: typeof node.className === 'string' ? node.className : '',
          text: (node.textContent || '').trim().slice(0, 48),
          bounds: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          style: {
            display: style.display,
            position: style.position,
            zIndex: style.zIndex,
            color: style.color,
            webkitTextFillColor: style.webkitTextFillColor,
            backgroundColor: style.backgroundColor,
            opacity: style.opacity,
            visibility: style.visibility,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            transform: style.transform,
          },
          svg: node.querySelector('svg') ? {
            display: getComputedStyle(node.querySelector('svg')).display,
            color: getComputedStyle(node.querySelector('svg')).color,
            stroke: getComputedStyle(node.querySelector('svg')).stroke,
            opacity: getComputedStyle(node.querySelector('svg')).opacity,
          } : null,
          hitStack: document.elementsFromPoint(x, y).slice(0, 4).map((element) => ({
            tag: element.tagName,
            className: typeof element.className === 'string' ? element.className : '',
            zIndex: getComputedStyle(element).zIndex,
          })),
        };
      };
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
        videoPlayback: video ? { paused: video.paused, currentTime: video.currentTime, readyState: video.readyState } : null,
        sheetBounds: bounds ? { top: bounds.top, right: bounds.right, bottom: bounds.bottom } : null,
        viewport: { width: innerWidth, height: innerHeight },
        lastReachable,
        scrollHeight: sheet ? sheet.scrollHeight : null,
        clientHeight: sheet ? sheet.clientHeight : null,
        paintDiagnostics: {
          userAgent: navigator.userAgent,
          devicePixelRatio: window.devicePixelRatio,
          sheet: styleSummary(sheet),
          backdrop: styleSummary(backdrop),
          video: styleSummary(video),
          actions: [actions[0], actions[1], actions[2], lastAction].filter(Boolean).map(styleSummary),
        },
      };
    })()`);
    if (!state?.visible) throw new Error('Player More sheet did not open');
    if (!state.sheetBounds || state.sheetBounds.top < -1 || state.sheetBounds.right > state.viewport.width + 1 || state.sheetBounds.bottom > state.viewport.height + 1 || !state.lastReachable) {
      throw new Error(`Player More actions are clipped or unreachable: ${JSON.stringify(state)}`);
    }
    if (!state.labels.some((label) => /compartir/i.test(label))) {
      throw new Error(`Player More lost native share action: ${JSON.stringify(state.labels)}`);
    }
    await delay(700);
    const playbackAfterOpen = await evaluate(call, `(() => {
      const video = document.querySelector('[data-player-root] video');
      return video ? { paused: video.paused, currentTime: video.currentTime, readyState: video.readyState } : null;
    })()`);
    state.videoProgressWhileOpen = playbackAfterOpen && state.videoPlayback
      ? playbackAfterOpen.currentTime - state.videoPlayback.currentTime
      : null;
    if (!playbackAfterOpen || playbackAfterOpen.paused || playbackAfterOpen.readyState < 2 || state.videoProgressWhileOpen < 0.15) {
      throw new Error(`Playback stopped while player More controls were open: ${JSON.stringify({ before: state.videoPlayback, after: playbackAfterOpen, delta: state.videoProgressWhileOpen })}`);
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
    const startedAt = Date.now();
    let state = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      state = await evaluate(call, `({
        player: Boolean(document.querySelector('[data-player-root]')),
        catalog: Boolean(document.querySelector('.site-header')),
        route: location.pathname + location.search,
        historyState: window.history.state,
      })`);
      if (!state.player && state.catalog && state.route === '/') break;
      await delay(200);
    }
    state.returnToCatalogMs = Date.now() - startedAt;
    console.log(JSON.stringify({ action, state }));
    if (state.player || !state.catalog || state.route !== '/') throw new Error('Android Back did not return from the player to the catalog');
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
    if (state.paused) throw new Error('HLS playback paused before the player screenshot was captured');
    if (state.currentTime <= 0.25) throw new Error(`Video did not make playback progress (currentTime=${state.currentTime})`);
    if (state.videoWidth <= 0 || state.videoHeight <= 0) throw new Error(`HLS video frame has no decoded dimensions (${state.videoWidth}x${state.videoHeight})`);
  } else if (action === 'performance') {
    const metrics = await evaluate(call, `(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map((entry) => [entry.name, Math.round(entry.startTime)]));
      const resources = performance.getEntriesByType('resource');
      const resourceBytes = resources.reduce((sum, entry) => sum + Number(entry.transferSize || 0), 0);
      const memory = performance.memory || null;
      return {
        shell: document.documentElement.dataset.nativeShell || null,
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
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
