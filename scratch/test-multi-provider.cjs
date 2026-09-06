const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROVIDERS = [
  { name: 'Cinecalidad', site: 'cinecalidad', pattern: 'cinecalidad' },
  { name: 'LatAnime', site: 'latanime', pattern: 'latanime' },
  { name: 'JKanime', site: 'jkanime', pattern: 'jkanime' },
  { name: 'AnimeFLV', site: 'animeflv', pattern: 'animeflv' },
  { name: 'LaMovie', site: 'lamovie', pattern: 'lamovie' },
  { name: 'Gnula', site: 'ww3', pattern: 'gnulahd' },
  { name: 'TioAnime', site: 'tioanime', pattern: 'tioanime' },
  { name: 'VerAnimes', site: 'veranimes', pattern: 'veranimes' }
];

async function probeUrl(url, timeoutMs = 7000) {
  if (!url) return { ok: false, error: 'Empty URL' };
  try {
    const target = url.startsWith('/') ? `http://127.0.0.1:3010${url}` : url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0',
        'Range': 'bytes=0-1024'
      }
    });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    const isHtml = ct.includes('text/html');
    const isMedia = ct.includes('video') || ct.includes('mpegurl') || ct.includes('octet-stream') || target.includes('.m3u8') || target.includes('.mp4');
    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      contentType: ct,
      isMedia: isMedia && !isHtml
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testProvider(prov) {
  console.log(`\n================================================================`);
  console.log(`PROBANDO PROVEEDOR: ${prov.name} (Filtro: ${prov.pattern})`);
  console.log(`================================================================`);

  // Find 5 shows from this provider that have episodes with links
  const shows = await prisma.show.findMany({
    where: {
      OR: [
        { source: { contains: prov.pattern, mode: 'insensitive' } },
        {
          episodes: {
            some: {
              source_url: { contains: prov.pattern, mode: 'insensitive' }
            }
          }
        }
      ]
    },
    take: 15,
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      title: true,
      category: true,
      poster_url: true,
      episodes: {
        take: 1,
        select: { id: true, source_url: true, episode_number: true }
      }
    }
  });

  const validShows = shows.filter(s => s.episodes && s.episodes.length > 0).slice(0, 5);
  console.log(`Encontradas ${validShows.length} obras para probar.`);

  const results = [];

  for (let i = 0; i < validShows.length; i++) {
    const show = validShows[i];
    const ep = show.episodes[0];
    const testNum = i + 1;

    console.log(`\n[${prov.name} #${testNum}] Obra: "${show.title}" (Episodio ${ep.episode_number || 1})`);
    console.log(`  Source URL: ${ep.source_url}`);
    console.log(`  Poster: ${show.poster_url?.slice(0, 70)}...`);

    // Call /api/v1/play/:episode_id
    try {
      const playRes = await fetch(`http://127.0.0.1:3010/api/v1/play/${ep.id}`);
      if (!playRes.ok) {
        console.log(`  ❌ /api/v1/play devolvió estado ${playRes.status}`);
        results.push({ show: show.title, epId: ep.id, status: 'PLAY_ERR_' + playRes.status });
        continue;
      }

      const playData = await playRes.json();
      const streamUrl = playData.stream_url;
      const ranked = playData.ranked_streams || [];
      const totalRanked = ranked.length;

      console.log(`  Total servidores devueltos: ${totalRanked}`);
      if (ranked.length > 0) {
        ranked.slice(0, 4).forEach((r, idx) => {
          console.log(`    [Servidor ${idx + 1}] Provider: ${r.provider || r.source_site} | Type: ${r.type || r.delivery_mode} | URL: ${r.url?.slice(0, 60)}...`);
        });
      }

      // Probe primary stream
      const primaryProbe = await probeUrl(streamUrl);
      console.log(`  Stream Primario: ${streamUrl?.slice(0, 70)}...`);
      console.log(`  Probe primario: Status=${primaryProbe.status || primaryProbe.error} Media=${primaryProbe.isMedia}`);

      // If primary is canonical or embed, try resolve-embed
      let resolvedServer = ranked[0]?.provider || prov.name;
      let finalStreamUrl = streamUrl;
      let isPlayable = primaryProbe.isMedia;

      if (!isPlayable && ranked.length > 0 && ranked[0].canonical_locator) {
        console.log(`  -> Requiere resolución JIT (/api/v1/resolve-embed)...`);
        try {
          const resEmbed = await fetch('http://127.0.0.1:3010/api/v1/resolve-embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: ranked[0].canonical_locator })
          });
          if (resEmbed.ok) {
            const embedData = await resEmbed.json();
            console.log(`  -> JIT Resuelto: type=${embedData.type} stream=${embedData.url?.slice(0, 60)} provider=${embedData.provider}`);
            if (embedData.url) {
              finalStreamUrl = embedData.url;
              resolvedServer = embedData.provider || resolvedServer;
              const probeJit = await probeUrl(finalStreamUrl);
              isPlayable = probeJit.isMedia || probeJit.ok;
            }
          }
        } catch (e) {
          console.log(`  -> Error JIT: ${e.message}`);
        }
      }

      console.log(`  VEREDICTO: ${isPlayable ? '✅ REPRODUCE OK' : '⚠️ REQUIERE EMBED/PROXY'} desde servidor [${resolvedServer}]`);
      results.push({
        title: show.title,
        epId: ep.id,
        serversCount: totalRanked,
        resolvedServer,
        isPlayable
      });

    } catch (e) {
      console.log(`  ❌ Error de llamada: ${e.message}`);
      results.push({ show: show.title, error: e.message });
    }
  }

  return { provider: prov.name, results };
}

async function runAll() {
  const summary = [];
  for (const prov of PROVIDERS) {
    const res = await testProvider(prov);
    summary.push(res);
  }

  console.log('\n================================================================');
  console.log('RESUMEN GENERAL DE PRUEBAS DE REPRODUCCIÓN POR PROVEEDOR');
  console.log('================================================================');
  for (const s of summary) {
    console.log(`\nProveedor: ${s.provider}`);
    for (const r of s.results) {
      console.log(`  - "${r.title}": Servidores=${r.serversCount} | Servidor activo=[${r.resolvedServer}] | Reproduce=${r.isPlayable ? 'SÍ' : 'NO'}`);
    }
  }
}

runAll().catch(console.error).finally(() => prisma.$disconnect());
