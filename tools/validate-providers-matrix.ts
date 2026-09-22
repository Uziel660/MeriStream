import { PrismaClient } from '@prisma/client';
import { EmbedResolvers, providerResolverRegistry } from '../server/resolvers.js';
import { isPlatformPageUrl, resolvePlatformPage } from '../server/platformPageResolvers.js';
import { ScraperManager } from '../server/scrapers/ScraperManager.js';
import * as fs from 'fs';

const prisma = new PrismaClient();

const PROVIDER_CONFIGS: Record<string, { showSources: string[]; sourceSites: string[] }> = {
  animeflv: {
    showSources: ['animeflv', 'ww3'],
    sourceSites: ['www3.animeflv.net', 'animeflv', 'animeflv.net', 'animeflv.or.at'],
  },
  jkanime: {
    showSources: ['jkanime'],
    sourceSites: ['jkanime.net', 'jkanime'],
  },
  tioanime: {
    showSources: ['tioanime'],
    sourceSites: ['tioanime', 'tioanime.com'],
  },
  latanime: {
    showSources: ['latanime'],
    sourceSites: ['latanime', 'latanime.org'],
  },
  veranimes: {
    showSources: ['veranimes', 'wwv'],
    sourceSites: ['wwv.veranimes.net', 'wwv'],
  },
  hianimes: {
    showSources: ['hianimes'],
    sourceSites: ['hianimes', 'hianimes.se'],
  },
  cinecalidad: {
    showSources: ['cinecalidad'],
    sourceSites: ['cinecalidad', 'cinecalidad.am'],
  },
  tubepelis: {
    showSources: ['tubepelis'],
    sourceSites: ['tubepelis.com'],
  },
  tioplus: {
    showSources: ['tioplus'],
    sourceSites: ['tioplus.app', 'tioplus'],
  },
  lamovie: {
    showSources: ['lamovie', 'lamovie_movies', 'lamovie_animes', 'lamovie_series'],
    sourceSites: ['lamovie.org', 'lamovie'],
  },
  gnula: {
    showSources: ['gnula_movies', 'gnula_series', 'gnula_anime'],
    sourceSites: ['gnula', 'ww3.gnulahd.nu', 'player.gnulahd.nu'],
  },
  doramasflix: {
    showSources: ['doramasflix', 'doramasflix_variedades', 'doramasflix_peliculas'],
    sourceSites: ['doramasflix.io', 'doramasflix', 'doramasflix_variedades', 'doramasflix_peliculas'],
  },
};

const requestedProviders = process.argv
  .slice(2)
  .flatMap((value) => value.split(","))
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const PROVIDERS = requestedProviders.length > 0
  ? requestedProviders.filter((provider) => PROVIDER_CONFIGS[provider])
  : Object.keys(PROVIDER_CONFIGS);

interface ServerTestResult {
  rawUrl: string;
  hostName: string;
  resolvedDirectUrl: string | null;
  isDirect: boolean;
  httpStatus: number | null;
  contentType: string | null;
  latencyMs: number | null;
  isHlsOrMp4: boolean;
  error?: string;
}

interface WorkTestResult {
  workId: string;
  title: string;
  category: string;
  locatorUrl: string;
  serversCount: number;
  nativePlayableServersCount: number;
  servers: ServerTestResult[];
}

interface ProviderSummary {
  provider: string;
  totalWorksTested: number;
  worksPassedNative: number;
  totalServersTested: number;
  totalServersDirect: number;
  averageLatencyMs: number;
  works: WorkTestResult[];
}

async function probeDirectMedia(url: string, headers: Record<string, string> = {}): Promise<{ status: number; contentType: string; latencyMs: number; isValidMedia: boolean }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let fetchUrl = url;
    if (fetchUrl.startsWith('/')) {
      fetchUrl = `http://127.0.0.1:3010${fetchUrl}`;
    }

    const reqHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      ...headers,
    };

    if (url.includes('mp4upload.com') && !reqHeaders['Referer']) {
      reqHeaders['Referer'] = 'https://www.mp4upload.com/';
    }
    if (url.includes('aniwatchtv.uk') && !reqHeaders['Referer']) {
      reqHeaders['Referer'] = 'https://zokoanime.video/';
    }
    if (url.includes('vimeos') && !reqHeaders['Accept-Encoding']) {
      reqHeaders['Accept-Encoding'] = 'identity';
    }

    if (/\.mp4(\?|#|$)/i.test(url)) {
      reqHeaders['Range'] = 'bytes=0-1024';
    }

    const res = await fetch(fetchUrl, {
      method: 'GET',
      headers: reqHeaders,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    const contentType = res.headers.get('content-type') || '';
    const status = res.status;

    let isValidMedia = false;
    if (status === 200 || status === 206) {
      if (
        contentType.includes('mpegurl') ||
        contentType.includes('application/x-mpegURL') ||
        contentType.includes('application/vnd.apple.mpegurl') ||
        contentType.includes('video/') ||
        contentType.includes('application/octet-stream')
      ) {
        isValidMedia = true;
      } else {
        const text = await res.text();
        if (text.startsWith('#EXTM3U') || text.includes('#EXT-X-STREAM-INF')) {
          isValidMedia = true;
        }
      }
    }

    return { status, contentType, latencyMs, isValidMedia };
  } catch (err: any) {
    return { status: 0, contentType: '', latencyMs: Date.now() - start, isValidMedia: false };
  }
}

async function testServer(candidateUrl: string): Promise<ServerTestResult> {
  let hostName = 'unknown';
  try {
    hostName = new URL(candidateUrl).hostname;
  } catch {
    hostName = candidateUrl.substring(0, 30);
  }

  const isAlreadyDirect = EmbedResolvers.isDirectMediaUrl(candidateUrl);
  if (isAlreadyDirect) {
    const probe = await probeDirectMedia(candidateUrl);
    return {
      rawUrl: candidateUrl,
      hostName,
      resolvedDirectUrl: candidateUrl,
      isDirect: true,
      httpStatus: probe.status,
      contentType: probe.contentType,
      latencyMs: probe.latencyMs,
      isHlsOrMp4: probe.isValidMedia,
    };
  }

  try {
    const meta = await EmbedResolvers.resolveWithMeta(candidateUrl);
    const resolvedUrl = meta.url;
    const isDirect = Boolean(resolvedUrl && EmbedResolvers.isDirectMediaUrl(resolvedUrl));

    if (isDirect) {
      const probe = await probeDirectMedia(resolvedUrl, meta.requiredHeaders);
      return {
        rawUrl: candidateUrl,
        hostName,
        resolvedDirectUrl: resolvedUrl,
        isDirect: true,
        httpStatus: probe.status,
        contentType: probe.contentType,
        latencyMs: probe.latencyMs,
        isHlsOrMp4: probe.isValidMedia,
      };
    } else {
      return {
        rawUrl: candidateUrl,
        hostName,
        resolvedDirectUrl: null,
        isDirect: false,
        httpStatus: null,
        contentType: null,
        latencyMs: null,
        isHlsOrMp4: false,
        error: 'Resolved as embed or unresolvable host',
      };
    }
  } catch (err: any) {
    return {
      rawUrl: candidateUrl,
      hostName,
      resolvedDirectUrl: null,
      isDirect: false,
      httpStatus: null,
      contentType: null,
      latencyMs: null,
      isHlsOrMp4: false,
      error: err?.message || 'Error resolving embed',
    };
  }
}

async function findDistinctWorksForProvider(providerKey: string, count = 5): Promise<Array<{ id: string; title: string; category: string; locator: string; allCandidateUrls: string[] }>> {
  const config = PROVIDER_CONFIGS[providerKey] || { showSources: [providerKey], sourceSites: [providerKey] };

  const results: Array<{ id: string; title: string; category: string; locator: string; allCandidateUrls: string[] }> = [];
  const seenTitles = new Set<string>();

  // 1. Consultar SourceLink primero (contiene los streams reales del catálogo)
  const sourceLinks = await prisma.sourceLink.findMany({
    where: {
      source_site: { in: config.sourceSites },
      url: { not: '' },
    },
    include: {
      media_episode: {
        include: {
          media_item: true,
        },
      },
    },
    take: 300,
  });

  for (const link of sourceLinks) {
    if (results.length >= count) break;
    const media = link.media_episode?.media_item;
    if (!media || !media.title || seenTitles.has(media.title.toLowerCase())) continue;

    const siblings = await prisma.sourceLink.findMany({
      where: {
        media_episode_id: link.media_episode_id,
      },
      take: 10,
    });

    // La tabla conserva enlaces históricos de embeds que pueden seguir
    // apareciendo antes que la ficha canónica. La reproducción real ya
    // prefiere la ficha estable porque puede obtener un stream nuevo; la
    // auditoría debe medir exactamente ese mismo camino.
    const isSameProviderLink = (candidate: (typeof siblings)[number]) => {
      const sourceSite = String(candidate.source_site || "").toLowerCase();
      return config.sourceSites.some((site) => sourceSite === site.toLowerCase() || sourceSite.includes(site.toLowerCase()))
        || sourceSite.includes(providerKey.toLowerCase());
    };
    const canonicalSibling = siblings.find((candidate) =>
      isSameProviderLink(candidate)
      && String(candidate.link_type || "").toLowerCase() !== "embed"
      && isPlatformPageUrl(candidate.canonical_locator || candidate.url),
    );
    const preferredLocator = canonicalSibling?.canonical_locator || canonicalSibling?.url;

    seenTitles.add(media.title.toLowerCase());
    results.push({
      id: media.id,
      title: media.title,
      category: media.kind || 'movie',
      locator: preferredLocator || link.canonical_locator || link.url,
      allCandidateUrls: Array.from(new Set([
        preferredLocator,
        link.canonical_locator,
        link.url,
        ...siblings.map((s) => s.url),
      ].filter(Boolean))),
    });
  }

  // 2. Si faltan obras, buscar en Show
  if (results.length < count) {
    const shows = await prisma.show.findMany({
      where: {
        source: { in: config.showSources },
      },
      include: {
        episodes: {
          where: { source_url: { not: '' } },
          take: 1,
          orderBy: { episode_number: 'asc' },
        },
      },
      take: count * 5,
    });

    for (const show of shows) {
      if (results.length >= count) break;
      const ep = show.episodes[0];
      if (!ep || !ep.source_url || seenTitles.has(show.title.toLowerCase())) continue;

      seenTitles.add(show.title.toLowerCase());
      results.push({
        id: show.id,
        title: show.title,
        category: show.category,
        locator: ep.source_url,
        allCandidateUrls: [ep.source_url],
      });
    }
  }

  return results;
}

async function validateProvider(provider: string): Promise<ProviderSummary> {
  console.log(`\n======================================================`);
  console.log(`>>> AUDITANDO PROVEEDOR: [${provider.toUpperCase()}]`);
  console.log(`======================================================`);

  const works = await findDistinctWorksForProvider(provider, 5);
  console.log(`Encontradas ${works.length} obras en base de datos para ${provider}`);

  const summary: ProviderSummary = {
    provider,
    totalWorksTested: works.length,
    worksPassedNative: 0,
    totalServersTested: 0,
    totalServersDirect: 0,
    averageLatencyMs: 0,
    works: [],
  };

  const allLatencies: number[] = [];

  for (let i = 0; i < works.length; i++) {
    const work = works[i];
    console.log(`\n[${provider}] Obra ${i + 1}/${works.length}: "${work.title}" (${work.category})`);
    console.log(`  Locator: ${work.locator}`);

    let candidateUrls: string[] = [];

    if (isPlatformPageUrl(work.locator)) {
      try {
        console.log(`  Resolviendo pagina canonica...`);
        // Usar exactamente el registro que usa el runtime. Antes esta
        // auditoría llamaba al resolutor genérico incluso para GNULA, lo que
        // podía ocultar mejoras del adaptador específico y producir un falso
        // negativo distinto al flujo real de reproducción.
        const resolver = providerResolverRegistry.findResolver(work.locator);
        const canonical = resolver
          ? await resolver.resolve(work.locator)
          : await resolvePlatformPage(work.locator);
        if (canonical?.resolved && canonical.url && canonical.url !== work.locator) {
          candidateUrls = [canonical.url];
        }
      } catch (err: any) {
        console.log(`  Fallo al resolver plataforma: ${err?.message}`);
      }
    }

    if (candidateUrls.length === 0) {
      const adapter = ScraperManager.getInstance().getAdapter(work.locator, provider);
      if (adapter && typeof (adapter as any).extractStream === 'function') {
        try {
          console.log(`  Extrayendo streams con adaptador ${adapter.name}...`);
          const extracted = await (adapter as any).extractStream(work.locator);
          if (extracted) {
            candidateUrls = Array.from(new Set([
              extracted.stream_url,
              ...(extracted.all_available_streams || []),
            ].filter(Boolean)));
          }
        } catch (err: any) {
          console.log(`  Fallo en extractStream de adaptador: ${err?.message}`);
        }
      }
    }

    // Descartar la propia URL canónica si quedó como único candidato y usar candidatos de SourceLink
    candidateUrls = candidateUrls.filter((u) => u && u !== work.locator && !isPlatformPageUrl(u));

    if (candidateUrls.length === 0 && work.allCandidateUrls && work.allCandidateUrls.length > 0) {
      candidateUrls = work.allCandidateUrls.filter((u) => u && u !== work.locator && !isPlatformPageUrl(u));
    }

    if (candidateUrls.length === 0) {
      candidateUrls = [work.locator];
    }

    console.log(`  Candidatos descubiertos: ${candidateUrls.length}`);
    const serverResults: ServerTestResult[] = [];

    for (const url of candidateUrls) {
      console.log(`    Probando: ${url.substring(0, 75)}...`);
      const srvRes = await testServer(url);
      serverResults.push(srvRes);
      summary.totalServersTested++;

      if (srvRes.isDirect && srvRes.isHlsOrMp4) {
        summary.totalServersDirect++;
        if (srvRes.latencyMs) allLatencies.push(srvRes.latencyMs);
        console.log(`      ✔ DIRECTO NATIVO: ${srvRes.resolvedDirectUrl?.substring(0, 70)} | HTTP ${srvRes.httpStatus} | ${srvRes.latencyMs}ms | ${srvRes.contentType}`);
      } else {
        console.log(`      ✖ NO DIRECTO / EMBED: ${srvRes.hostName} (${srvRes.error || 'embed'})`);
      }
    }

    const hasPlayableNative = serverResults.some((s) => s.isDirect && s.isHlsOrMp4);
    if (hasPlayableNative) {
      summary.worksPassedNative++;
      console.log(`  => RESULTADO OBRA: ✔ REPRODUCCION NATIVA GARANTIZADA`);
    } else {
      console.log(`  => RESULTADO OBRA: ✖ SIN STREAM NATIVO COMPROBADO`);
    }

    summary.works.push({
      workId: work.id,
      title: work.title,
      category: work.category,
      locatorUrl: work.locator,
      serversCount: serverResults.length,
      nativePlayableServersCount: serverResults.filter((s) => s.isDirect && s.isHlsOrMp4).length,
      servers: serverResults,
    });
  }

  if (allLatencies.length > 0) {
    summary.averageLatencyMs = Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length);
  }

  console.log(`\nRESUMEN [${provider.toUpperCase()}]:`);
  console.log(`  Obras con stream nativo: ${summary.worksPassedNative}/${summary.totalWorksTested}`);
  console.log(`  Servidores directos comprobados: ${summary.totalServersDirect}/${summary.totalServersTested}`);
  console.log(`  Latencia promedio: ${summary.averageLatencyMs}ms`);

  return summary;
}

async function runMatrixValidation() {
  console.log('=================================================================');
  console.log('  MERISTREAM: AUDITORIA DE MATRIZ DE REPRODUCCION NATIVA 12 PROVEEDORES');
  console.log('=================================================================');

  const summaries: ProviderSummary[] = [];

  for (const provider of PROVIDERS) {
    try {
      const s = await validateProvider(provider);
      summaries.push(s);
    } catch (err: any) {
      console.error(`Error critico en proveedor ${provider}:`, err);
    }
  }

  console.log('\n\n=================================================================');
  console.log('                     TABLA RESUMEN FINAL                         ');
  console.log('=================================================================');
  console.log('| Proveedor     | Obras OK | Servidores Directos | Latencia Promedio | Estado Nativo |');
  console.log('|---------------|----------|---------------------|-------------------|---------------|');
  for (const s of summaries) {
    const statusStr = s.worksPassedNative >= 4 ? '✔ APROBADO' : s.worksPassedNative > 0 ? '⚠ PARCIAL' : '✖ FALLO';
    console.log(`| ${s.provider.padEnd(13)} | ${(s.worksPassedNative + '/' + s.totalWorksTested).padEnd(8)} | ${(s.totalServersDirect + '/' + s.totalServersTested).padEnd(19)} | ${(s.averageLatencyMs + 'ms').padEnd(17)} | ${statusStr.padEnd(13)} |`);
  }

  fs.writeFileSync('tools/matrix-validation-results.json', JSON.stringify(summaries, null, 2), 'utf-8');
  console.log('\nResultados detallados guardados en tools/matrix-validation-results.json');
}

runMatrixValidation()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
