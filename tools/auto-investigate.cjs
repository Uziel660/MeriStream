const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const prisma = new PrismaClient();
const TMDB_KEY = process.env.TMDB_API_KEY;
if (!TMDB_KEY) throw new Error("TMDB_API_KEY is required");
const DRY_RUN = !process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

// TMDB base URL
const TMDB = "https://api.themoviedb.org/3";

async function tmdbFetch(path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${TMDB}${path}${sep}api_key=${TMDB_KEY}&language=es-MX`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function searchTMDB(title) {
  const data = await tmdbFetch(`/search/tv?query=${encodeURIComponent(title)}`);
  if (!data?.results?.length) return null;
  // Pick the first result with highest popularity
  return data.results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
}

async function getShowDetails(tmdbId) {
  return tmdbFetch(`/tv/${tmdbId}`);
}

async function getCollection(collectionId) {
  return tmdbFetch(`/collection/${collectionId}`);
}

// ── Season marker stripping (same as consolidate-seasons) ──
function stripSeasonMarkers(title) {
  let t = title
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/gi, "")
    .replace(/\bSeason\s*-?\s*\d{1,2}\b/gi, "")
    .replace(/\bTemporada\s*-?\s*\d{1,2}\b/gi, "")
    .replace(/\bs(\d{1,2})\b/gi, "")
    .replace(/\bPart\s*-?\s*(\d{1,2})\b/gi, "")
    .replace(/\bPart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/gi, "")
    .replace(/\bFinal\s+Season\b/gi, "")
    .replace(/\s*\((?:ONA|OVA|TV)\)\s*/gi, " ")
    .replace(/\s+the\s+Movie\s*\d*\s*:?.*$/gi, "")
    .replace(/\s+the\s+Movie\b/gi, "")
    .replace(/\s+Anime\s*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

function normalizeKey(title) {
  return stripSeasonMarkers(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}

function tokenize(text) {
  const norm = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/[^a-z0-9 ]/g, " ");
  return new Set(norm.split(/\s+/).filter(t => t.length > 1).map(w => w.replace(/s$/, "")));
}

function jaccard(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function isSpinoff(title) {
  return /\bVigilante/i.test(title) || /\bIllegals\b/i.test(title);
}

function isMovie(title) {
  return /\bthe\s+movie\b/i.test(title) || /\bpel[i\u00f3]cula\b/i.test(title);
}

async function investigateGroup(shows) {
  const results = [];

  for (const show of shows) {
    let tmdbInfo = null;

    if (show.tmdb_id) {
      tmdbInfo = await getShowDetails(show.tmdb_id);
    } else {
      // Search TMDB by title (strip "Anime" suffix for better results)
      const searchTitle = show.title.replace(/\s+Anime\s*$/i, "").trim();
      const searchResult = await searchTMDB(searchTitle);
      if (searchResult) {
        tmdbInfo = await getShowDetails(searchResult.id);
      }
    }

    results.push({
      id: show.id,
      title: show.title,
      tmdb_id: show.tmdb_id || tmdbInfo?.id || null,
      seasons: tmdbInfo?.number_of_seasons || 0,
      episodes: tmdbInfo?.number_of_episodes || 0,
      first_air: tmdbInfo?.first_air_date || null,
      collection_id: tmdbInfo?.belongs_to_collection?.id || null,
      collection_name: tmdbInfo?.belongs_to_collection?.name || null,
      networks: (tmdbInfo?.networks || []).map(n => n.name).join(", "),
      status: tmdbInfo?.status || null,
      db_eps: show._count?.episodes || 0,
    });

    // Rate limit: 40 req/s for TMDB API
    await new Promise(r => setTimeout(r, 30));
  }

  return results;
}

async function main() {
  console.log("=== AUTO-INVESTIGACIÓN TMDB ===");
  console.log(`Modo: ${DRY_RUN ? "DRY RUN" : "APPLY"}\n`);

  // Fetch all shows with episode counts
  const shows = await prisma.show.findMany({
    select: {
      id: true,
      title: true,
      tmdb_id: true,
      source: true,
      created_at: true,
      _count: { select: { episodes: true } },
    },
    orderBy: { created_at: "asc" },
  });

  console.log(`Total shows: ${shows.length}`);

  // Group by normalized base title
  const titleGroups = new Map();
  for (const show of shows) {
    const key = normalizeKey(show.title);
    if (!key || key.length < 3) continue;
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key).push(show);
  }

  // Only investigate groups with >1 show
  const dupGroups = [];
  for (const [key, group] of titleGroups) {
    if (group.length > 1) dupGroups.push({ baseKey: key, shows: group });
  }

  console.log(`Grupos duplicados: ${dupGroups.length}\n`);

  // Also group by tmdb_id for shows that have it
  const tmdbGroups = new Map();
  for (const show of shows) {
    if (show.tmdb_id) {
      const key = String(show.tmdb_id);
      if (!tmdbGroups.has(key)) tmdbGroups.set(key, []);
      tmdbGroups.get(key).push(show);
    }
  }
  const tmdbDups = [];
  for (const [tmdbId, group] of tmdbGroups) {
    if (group.length > 1) tmdbDups.push({ tmdbId, shows: group });
  }
  console.log(`Grupos tmdb_id duplicados: ${tmdbDups.length}\n`);

  const mergePlan = [];
  const investigateQueue = [...dupGroups, ...tmdbDups.map(g => ({ baseKey: `tmdb:${g.tmdbId}`, shows: g.shows }))];

  for (const group of investigateQueue) {
    if (group.shows.length < 2) continue;

    console.log(`\n--- Grupo: ${group.baseKey} (${group.shows.length} shows) ---`);
    for (const s of group.shows) {
      console.log(`  ${s.title} | tmdb=${s.tmdb_id || "?"} | eps=${s._count.episodes} | src=${s.source}`);
    }

    const info = await investigateGroup(group.shows);

    // Check if any shows share the same TMDB collection
    const collections = new Map();
    for (const item of info) {
      if (item.collection_id) {
        if (!collections.has(item.collection_id)) collections.set(item.collection_id, []);
        collections.get(item.collection_id).push(item);
      }
    }

    // Check if any shows share the same TMDB ID
    const tmdbIds = new Map();
    for (const item of info) {
      if (item.tmdb_id) {
        if (!tmdbIds.has(item.tmdb_id)) tmdbIds.set(item.tmdb_id, []);
        tmdbIds.get(item.tmdb_id).push(item);
      }
    }

    // Decision logic
    for (const [colId, items] of collections) {
      if (items.length > 1) {
        console.log(`  COLECCIÓN TMDB ${colId} (${items[0].collection_name}): ${items.map(i => i.title).join(", ")}`);
        mergePlan.push({
          action: "merge",
          reason: `collection:${colId}`,
          canonical: items.reduce((a, b) => a.db_eps > b.db_eps ? a : b),
          toMerge: items.filter(i => i.id !== items.reduce((a, b) => a.db_eps > b.db_eps ? a : b).id),
        });
      }
    }

    for (const [tmdbId, items] of tmdbIds) {
      if (items.length > 1) {
        const canonical = items.reduce((a, b) => a.db_eps > b.db_eps ? a : b);
        const toMerge = items.filter(i => i.id !== canonical.id);

        // Jaccard guard: skip if titles are completely different
        const safeMerges = toMerge.filter(m => {
          const sim = jaccard(canonical.title, m.title);
          if (sim < 0.15) {
            console.log(`  SKIP TMDB ${tmdbId}: "${m.title}" ≠ "${canonical.title}" (sim ${sim.toFixed(2)})`);
            return false;
          }
          return true;
        });

        if (safeMerges.length > 0) {
          console.log(`  TMDB ID ${tmdbId}: ${items.map(i => i.title).join(", ")}`);
          mergePlan.push({
            action: "merge",
            reason: `tmdb:${tmdbId}`,
            canonical,
            toMerge: safeMerges,
          });
        }
      }
    }

    // For shows without shared TMDB info, check season counts
    for (const item of info) {
      if (item.seasons > 1 && item.db_eps < item.episodes * 0.8) {
        console.log(`  PARCIAL: ${item.title} tiene ${item.seasons} temporadas en TMDB pero solo ${item.db_eps}/${item.episodes} eps en DB`);
      }
    }

    if (VERBOSE) {
      console.log("  Info TMDB:");
      for (const item of info) {
        console.log(`    ${item.title}: tmdb=${item.tmdb_id}, seasons=${item.seasons}, eps=${item.episodes}, collection=${item.collection_name || "ninguna"}`);
      }
    }
  }

  // Execute merges
  let mergesDone = 0;
  let epsMoved = 0;

  for (const plan of mergePlan) {
    if (plan.action !== "merge") continue;

    const canonical = plan.canonical;
    for (const merge of plan.toMerge) {
      console.log(`\nFUSIÓN: "${merge.title}" → "${canonical.title}" (${plan.reason})`);

      if (!DRY_RUN) {
        // Move episodes
        const lastEp = await prisma.episode.findFirst({
          where: { show_id: canonical.id },
          orderBy: { episode_number: "desc" },
          take: 1,
        });
        let nextNum = (lastEp?.episode_number ?? 0) + 1;

        const mergeEps = await prisma.episode.findMany({
          where: { show_id: merge.id },
          orderBy: { episode_number: "asc" },
        });

        let moved = 0;
        for (const ep of mergeEps) {
          const dupe = ep.source_url
            ? await prisma.episode.findFirst({ where: { show_id: canonical.id, source_url: ep.source_url } })
            : null;
          if (!dupe) {
            await prisma.episode.create({
              data: { show_id: canonical.id, episode_number: nextNum, title: ep.title, source_url: ep.source_url },
            });
          }
          nextNum++;
          moved++;
        }

        // Copy tmdb_id if canonical doesn't have one
        if (!canonical.tmdb_id && merge.tmdb_id) {
          await prisma.show.update({ where: { id: canonical.id }, data: { tmdb_id: merge.tmdb_id } });
        }

        await prisma.show.delete({ where: { id: merge.id } });
        epsMoved += moved;
        console.log(`  → ${moved} episodios movidos`);
      }

      mergesDone++;
    }
  }

  console.log(`\n=== RESULTADO ===`);
  console.log(`Fusiones: ${mergesDone}`);
  console.log(`Episodios movidos: ${epsMoved}`);
  console.log(`Shows restantes: ${shows.length - mergesDone}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
