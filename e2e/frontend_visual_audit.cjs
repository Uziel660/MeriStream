const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.MERISTREAM_URL || 'http://127.0.0.1:3010';
const OUT_DIR = path.resolve(process.cwd(), 'artifacts/frontend-visual');
fs.mkdirSync(OUT_DIR, { recursive: true });

const tmdb = (size, imagePath) => `https://image.tmdb.org/t/p/${size}${imagePath}`;

const catalog = [
  {
    id: 'tmdb-movie-550', tmdb_id: 550, title: 'Fight Club', kind: 'movie', category: 'movie',
    description: 'Un oficinista insomne y un vendedor de jabón forman un club clandestino que termina convirtiéndose en algo mucho más grande.',
    synopsis: 'Un oficinista insomne y un vendedor de jabón forman un club clandestino que termina convirtiéndose en algo mucho más grande.',
    poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg', backdrop_path: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
    poster_url: tmdb('w500', '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg'), banner_url: tmdb('w1280', '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg'), backdrop_url: tmdb('w1280', '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg'),
    rating: 8.4, year: 1999, genres: ['Drama', 'Suspenso'], episode_count: 1, is_trending: true, sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
  },
  {
    id: 'tmdb-movie-693134', tmdb_id: 693134, title: 'Dune: Parte Dos', kind: 'movie', category: 'movie',
    description: 'Paul Atreides se une a Chani y los Fremen mientras busca venganza y afronta una decisión capaz de cambiar el destino del universo.',
    synopsis: 'Paul Atreides se une a Chani y los Fremen mientras busca venganza y afronta una decisión capaz de cambiar el destino del universo.',
    poster_path: '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', backdrop_path: '/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg',
    poster_url: tmdb('w500', '/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg'), banner_url: tmdb('w1280', '/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg'), backdrop_url: tmdb('w1280', '/xOMo8BRK7PfcJv9JCnx7s5hj0PX.jpg'),
    rating: 8.2, year: 2024, genres: ['Ciencia ficción', 'Aventura'], episode_count: 1, is_trending: true, sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
  },
  {
    id: 'tmdb-movie-335984', tmdb_id: 335984, title: 'Blade Runner 2049', kind: 'movie', category: 'movie',
    description: 'Un nuevo blade runner descubre un secreto enterrado que puede alterar lo que queda de la sociedad.', synopsis: 'Un nuevo blade runner descubre un secreto enterrado que puede alterar lo que queda de la sociedad.',
    poster_path: '/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg', backdrop_path: '/ilRyazdMJwN05exqhwK4tMKBYZs.jpg',
    poster_url: tmdb('w500', '/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg'), banner_url: tmdb('w1280', '/ilRyazdMJwN05exqhwK4tMKBYZs.jpg'), backdrop_url: tmdb('w1280', '/ilRyazdMJwN05exqhwK4tMKBYZs.jpg'),
    rating: 7.6, year: 2017, genres: ['Ciencia ficción', 'Drama'], episode_count: 1, is_trending: true, sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
  },
  {
    id: 'tmdb-movie-157336', tmdb_id: 157336, title: 'Interstellar', kind: 'movie', category: 'movie',
    description: 'Un grupo de exploradores atraviesa un agujero de gusano para encontrar un nuevo hogar para la humanidad.', synopsis: 'Un grupo de exploradores atraviesa un agujero de gusano para encontrar un nuevo hogar para la humanidad.',
    poster_path: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', backdrop_path: '/xJHokMbljvjADYdit5fK5VQsXEG.jpg',
    poster_url: tmdb('w500', '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg'), banner_url: tmdb('w1280', '/xJHokMbljvjADYdit5fK5VQsXEG.jpg'), backdrop_url: tmdb('w1280', '/xJHokMbljvjADYdit5fK5VQsXEG.jpg'),
    rating: 8.5, year: 2014, genres: ['Ciencia ficción', 'Drama'], episode_count: 1, is_trending: true, sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
  },
  {
    id: 'tmdb-movie-414906', tmdb_id: 414906, title: 'The Batman', kind: 'movie', category: 'movie',
    description: 'Batman sigue las pistas de un asesino que expone los secretos más oscuros de Gotham.', synopsis: 'Batman sigue las pistas de un asesino que expone los secretos más oscuros de Gotham.',
    poster_path: '/74xTEgt7R36Fpooo50r9T25onhq.jpg', backdrop_path: '/b0PlSFdDwbyK0cf5RxwDpaOJQvQ.jpg',
    poster_url: tmdb('w500', '/74xTEgt7R36Fpooo50r9T25onhq.jpg'), banner_url: tmdb('w1280', '/b0PlSFdDwbyK0cf5RxwDpaOJQvQ.jpg'), backdrop_url: tmdb('w1280', '/b0PlSFdDwbyK0cf5RxwDpaOJQvQ.jpg'),
    rating: 7.7, year: 2022, genres: ['Crimen', 'Drama'], episode_count: 1, is_trending: true, sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
  },
  {
    id: 'tmdb-series-1396', tmdb_id: 1396, title: 'Breaking Bad', kind: 'series', category: 'series',
    description: 'Un profesor de química transforma su vida al entrar en el negocio de la metanfetamina.', synopsis: 'Un profesor de química transforma su vida al entrar en el negocio de la metanfetamina.',
    poster_path: '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg', backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
    poster_url: tmdb('w500', '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg'), banner_url: tmdb('w1280', '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg'), backdrop_url: tmdb('w1280', '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg'),
    rating: 8.9, year: 2008, genres: ['Drama', 'Crimen'], episode_count: 62, is_trending: true, sources: { master_m3u8: '', fallback_mp4: null, qualities: [], subtitles: [] }
  },
];

const expandedCatalog = Array.from({ length: 3 }, (_, block) => catalog.map((item, index) => ({
  ...item,
  id: block === 0 ? item.id : `${item.id}-v${block}`,
  title: block === 0 ? item.title : `${item.title}${block === 1 ? '' : ' — edición'}`,
  tmdb_id: item.tmdb_id + block * 100000 + index,
}))).flat();

function detailFor(kind, id) {
  const numericId = Number(id);
  const base = catalog.find((item) => item.kind === kind && item.tmdb_id === numericId) || catalog[0];
  return {
    ...base,
    id: `tmdb-${kind}-${numericId}`,
    tmdb_id: numericId,
    episodes: kind === 'movie' ? [{
      id: `tmdb-${kind}-${numericId}-s1-e1`, show_id: `tmdb-${kind}-${numericId}`, title: base.title,
      episode_number: 1, season_number: 1, source_url: `tmdb://${kind}/${numericId}/1/1`
    }] : Array.from({ length: 8 }, (_, i) => ({
      id: `tmdb-${kind}-${numericId}-s1-e${i + 1}`, show_id: `tmdb-${kind}-${numericId}`, title: `Episodio ${i + 1}`,
      episode_number: i + 1, season_number: 1, source_url: `tmdb://${kind}/${numericId}/1/${i + 1}`
    })),
    external_ids: { imdb_id: null, tvdb_id: null, wikidata_id: null }
  };
}

async function installMocks(page) {
  await page.route('**/api/v1/catalog/public?**', async (route) => {
    const url = new URL(route.request().url());
    const query = (url.searchParams.get('query') || '').toLowerCase();
    const shows = query ? expandedCatalog.filter((item) => item.title.toLowerCase().includes(query)) : expandedCatalog;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shows, total: shows.length, page: 1, pageSize: shows.length, totalPages: 1, source: 'tmdb' }) });
  });
  await page.route(/\/api\/v1\/catalog\/public\/(movie|series|anime)\/(\d+)(?:\?.*)?$/, async (route) => {
    const match = route.request().url().match(/\/catalog\/public\/(movie|series|anime)\/(\d+)/);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detailFor(match[1], match[2])) });
  });
  await page.route('**/api/v1/recommendations**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      hero: catalog[1],
      rails: [
        { id: 'cinema', title: 'Popular ahora', subtitle: 'Historias que están marcando el momento', shows: expandedCatalog.slice(0, 10) },
        { id: 'scifi', title: 'Universos enormes', subtitle: 'Ciencia ficción para perderse un rato', shows: expandedCatalog.slice(3, 14) },
      ]
    }) });
  });
  await page.route('**/api/v1/genres**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ genres: ['Acción', 'Drama', 'Ciencia ficción', 'Aventura', 'Suspenso', 'Crimen'] }) });
  });
  await page.route('**/api/v1/shows**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(expandedCatalog) });
  });
}

async function waitForImages(page) {
  await page.waitForTimeout(900);
  await page.evaluate(async () => {
    const images = Array.from(document.images);
    await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, 4000);
    })));
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await page.waitForTimeout(350);
}

async function captureViewport(browser, name, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installMocks(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.feature').waitFor({ state: 'visible', timeout: 15000 });
  await waitForImages(page);

  const homeLayout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  if (Math.max(homeLayout.documentScrollWidth, homeLayout.bodyScrollWidth) > homeLayout.innerWidth + 2) {
    pageErrors.push(`Home horizontal overflow: ${Math.max(homeLayout.documentScrollWidth, homeLayout.bodyScrollWidth)}px > ${homeLayout.innerWidth}px`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-home.png`), fullPage: false });

  const firstCard = page.locator('.media-card').first();
  await firstCard.waitFor({ state: 'visible', timeout: 10000 });
  await firstCard.click();
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 10000 });
  await waitForImages(page);

  const detailsLayout = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  if (Math.max(detailsLayout.documentScrollWidth, detailsLayout.bodyScrollWidth) > detailsLayout.innerWidth + 2) {
    pageErrors.push(`Details horizontal overflow: ${Math.max(detailsLayout.documentScrollWidth, detailsLayout.bodyScrollWidth)}px > ${detailsLayout.innerWidth}px`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, `${name}-details.png`), fullPage: false });

  fs.writeFileSync(path.join(OUT_DIR, `${name}-report.json`), JSON.stringify({ viewport, pageErrors, homeLayout, detailsLayout }, null, 2));
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const viewports = [
    ['mobile-320x700', { width: 320, height: 700 }],
    ['mobile-390x844', { width: 390, height: 844 }],
    ['tablet-768x1024', { width: 768, height: 1024 }],
    ['laptop-1024x768', { width: 1024, height: 768 }],
    ['desktop-1440x900', { width: 1440, height: 900 }],
    ['wide-1920x1080', { width: 1920, height: 1080 }],
  ];
  try {
    for (const [name, viewport] of viewports) {
      await captureViewport(browser, name, viewport);
    }
  } finally {
    await browser.close();
  }
  console.log(`Visual audit screenshots written to ${OUT_DIR}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
