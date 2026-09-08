# MeriStream provider resolution

The provider gateway keeps TMDB as the canonical identity and resolves a title
or episode just in time. The public contract is:

```text
TMDB identity
  -> provider gateway
  -> direct API clients and curated site adapters
  -> native HLS, DASH or MP4 sources
  -> host health/cooldown ranking
  -> MeriStream internal player
```

## Public TMDB catalog

The browse surface is backed by TMDB and is independent from the imported
provider tables. This keeps a scraper import from creating duplicate cards or
hiding a title that has not been ingested yet.

Public endpoints:

- `GET /api/v1/catalog/search?q=<text>&limit=100` queries TMDB directly for
  the complete ranked search space (up to five upstream pages per media
  family) and returns movie, series and anime cards. It is separate from the
  60-card trending bootstrap, so a title does not need to be preloaded to be
  found.
- `GET /api/v1/catalog/public?kind=all|movie|series|anime&limit=60` returns
  TMDB cards (with a short in-memory server cache) with stable IDs such as `tmdb-movie-550` and
  `tmdb-anime-94664`.
- `page=1` is the small Inicio bootstrap. Explorar and the Películas, Series
  and Anime views request later pages independently through their own “Cargar
  más” action; no full TMDB catalog is downloaded into the browser or database.
- `GET /api/v1/catalog/public/:kind/:tmdbId` returns the canonical detail,
  IMDb ID when TMDB exposes it, and virtual episodes whose locators use the
  form `tmdb://<kind>/<tmdbId>/<season>/<episode>`.
- `GET /api/v1/providers/:kind/:tmdbId` resolves playback just in time. The
  frontend never needs a provider database row in order to ask for a TMDB
  title's sources.

The header search is collapsed to a keyboard accessible magnifying-glass
button and expands across the available width when opened. Requests made with
an optional per-user TMDB key include `X-TMDB-Personal-Key`; the server uses it
only for that request and falls back to `TMDB_API_KEY` when it is absent.

The frontend tries the public endpoint first and falls back to a bounded
`/api/v1/shows?lite=true&limit=60` batch only when TMDB is unavailable. The legacy `Show` and
`Episode` tables remain available to the admin and to gradual source imports;
they are not the identity of a public card.

Anime detail enrichment queries AniList without a key. When AniList is
unavailable, the public route queries Kitsu and its mapping endpoint to obtain
`anilist_id`, `mal_id`, `kitsu_id`, and title aliases. The provider gateway uses
the MAL ID to create ZokoAnime's public `/stream/mal/...` locator dynamically;
VidSrc uses the TMDB TV ID directly. A resumable identity repair tool
(`tools/repair-anime-identities.ts`) can persist only exact TMDB/MAL Wikidata
edges or high-confidence title matches; run it dry first and apply in bounded
batches. Unmatched works remain available through TMDB/VidSrc and are never
assigned a guessed MAL ID.

TMDB responses are cached in memory for five minutes and are fetched on demand;
the entire TMDB catalog is not copied into PostgreSQL. A database backup should
be taken before any optional reset or re-bootstrap of the legacy catalog.

`GET /api/v1/providers/:kind/:tmdbId` returns `sources` only when a provider
has supplied a native HLS, DASH or MP4 URL. Provider pages and iframes stay in
`fallbackCandidates` for the explicit recovery cascade and are never promoted
to the direct source list. Signed media URLs are resolved JIT; stable locators
are retained when an API supplies one so the player can renew a source.

The internal player accepts only native HLS, DASH and MP4. A page or embed
candidate may be resolved on demand, but an unresolved or embed-only result is
marked unavailable and advances the provider failover chain; it is never opened
as an external player. MPD playback is handled by the lazy `dash.js` client and
manifests that require origin headers use the internal proxy session.

All provider and CDN requests use the standard server HTTP client with normal
TLS verification. MeriStream does not use browser-fingerprint evasion, TLS
verification bypasses, CAPTCHA handling, DRM decryption, paywall bypasses or
authentication workarounds. Anti-bot and access-control responses are recorded
as health failures so the provider can cool down or fail over.

## Curated sources

| Content | Primary | Secondary/fallback |
| --- | --- | --- |
| Movies and series, ES-LATAM | Cinecalidad (`Vimeos` common resolver) | GnulaHD (`bysevepoin` locator → rotating SprintCDN HLS) |
| Anime, ES-LATAM | LatAnime (SprintCDN HLS; Mega relay only when returned by the source) | — |
| Anime, JA + subtitles | ZokoAnime (`aniwatchtv.uk` HLS) | TioAnime legacy fallback |
| English movies, series and anime | Direct API clients and configured Stremio addons | VidSrc/VidSrc mirrors only when their API returns native media |

AnimeAV1, AnimeFLV, JKAnime, LaMovie, HiAnimes, VerAnimes, Doramasflix,
TioPlus, TubePelis and TioAnime are outside normal ingestion. TioAnime is
admitted only as the ZokoAnime anime recovery fallback.

The gateway ranks an explicit language preference first, then host health and
provider priority. Two consecutive non-auth failures open a host cooldown;
401/403 responses remain token-scoped and do not blacklist an entire origin.

The search path combines TMDB and PostgreSQL results, keeps local provider
links when a TMDB identity is shared, and supports accent-insensitive,
multilingual and typo-tolerant queries. Full-text and substring matches remain
the fast path; a bounded `pg_trgm` similarity fallback runs only when a query
has no literal title hit. The player and subtitle menus group mirrors by
language with a capped scroll area. Per-user preferences (priority languages,
default quality, subtitle position/size, contrast, reduced motion and an
optional TMDB key) are stored in a namespaced local record and applied without
changing playback contracts.

Subtitle tracks from provider manifests are preserved through JIT resolution and
rendered by the native `<track>` element. OpenSubtitles is an optional,
credential-gated supplement at `GET /api/v1/subtitles`; with no
`OPENSUBTITLES_API_KEY` configured it returns an empty result and never calls
the external download endpoint. Audio tracks are exposed from HLS and DASH
manifests through their native track selectors. The live probe on 2026-09-07
confirmed that a Cinecalidad Vimeos master contains Spanish as the default
audio rendition and English as an alternate rendition. The sampled GnulaHD,
LatAnime and ZokoAnime manifests each contained one audio rendition, so those
players cannot switch audio in-video; Zoko's `/sub` and `/dub` locators are
separate releases rather than two tracks in one manifest. The persisted
`audio_language` and `subtitle_language` fields describe the selected release
and do not promise a track selector when the upstream manifest has only one
rendition. The sampled Zoko payload exposed one English VTT track; a Spanish
subtitle track was not confirmed from that public response.

TMDB remains the identity used by catalog and playback requests. Anime records
may additionally carry the numeric AniList and MAL identifiers plus the Kitsu
resource id. The public catalog queries AniList first, then Kitsu mappings when
AniList is unavailable; the resolved identifiers are retained for deduplication
and provider APIs. Other legacy metadata jobs may still use Jikan separately.

The optional `kitsu_id` column is additive. Environments using the Prisma schema
must run `npx prisma db push` (or their normal schema deployment step) before
enabling writes that persist the new mapping; this is a schema sync only and
does not reset catalog data.

Proxy sessions support both `master.m3u8` and `master.mpd`. DASH `BaseURL` and
segment templates remain opaque to the browser while `$Number$`, `$Time$` and
other placeholders are expanded by dash.js before the internal resource relay,
so signed upstream URLs stay server-side and can be renewed on a 401/403.
The session keeps up to 10,000 short-lived opaque locators so long VidSrc/Vimeos
playlists do not evict their first segments; only URL metadata is retained and
media bytes are streamed through the relay.

The latest public probes are stored in:

- `docs/reports/provider-host-probe-2026-09-07.json`
- `docs/reports/provider-resolver-probe-2026-09-07.json`
- `docs/reports/provider-browser-validation-2026-09-08.md`
- `docs/reports/provider-browser-validation-2026-09-08.json`

The browser validation report is the current evidence for the minimum ten-work
acceptance gate. It records the final host, response status and content type for
the landing page, resolver, internal playback session, manifest, child playlist
and first media segment. A successful HLS case requires a `200` master and child
plus a `200`/`206` segment; internal MP4 relays are checked with a bounded range
request. Failures remain documented instead of being turned into fallback
successes. Public TMDB titles are shown in Spanish (`es-419`) when TMDB provides
that localization; when it does not, the canonical title or Japanese/English
title is kept to avoid inventing metadata.
