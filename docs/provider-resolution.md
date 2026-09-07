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
| Movies and series, ES-LATAM | Cinecalidad (`vimeos` common resolver) | GnulaHD (page embeds; direct host unconfirmed) |
| Anime, ES-LATAM | LatAnime (`sprintcdn` HLS) | — |
| Anime, JA + ES subtitles | ZokoAnime (`aniwatchtv.uk` HLS) | TioAnime legacy fallback |
| English movies, series and anime | Direct API clients and configured Stremio addons | VidSrc/VidSrc mirrors only when their API returns native media |

AnimeAV1, AnimeFLV, JKAnime, LaMovie, HiAnimes, VerAnimes, Doramasflix,
TioPlus, TubePelis and TioAnime are outside normal ingestion. TioAnime is
admitted only as the ZokoAnime anime recovery fallback.

The gateway ranks an explicit language preference first, then host health and
provider priority. Two consecutive non-auth failures open a host cooldown;
401/403 responses remain token-scoped and do not blacklist an entire origin.

TMDB remains the identity used by catalog and playback requests. Anime records
may additionally carry the numeric AniList and MAL identifiers plus the Kitsu
resource id. Metadata enrichment queries AniList first, then Kitsu and Jikan;
the resolved identifiers are retained for deduplication and for provider APIs.

The optional `kitsu_id` column is additive. Environments using the Prisma schema
must run `npx prisma db push` (or their normal schema deployment step) before
enabling writes that persist the new mapping; this is a schema sync only and
does not reset catalog data.

Proxy sessions support both `master.m3u8` and `master.mpd`. DASH `BaseURL` and
segment templates remain opaque to the browser while `$Number$`, `$Time$` and
other placeholders are expanded by dash.js before the internal resource relay,
so signed upstream URLs stay server-side and can be renewed on a 401/403.

The latest public probes are stored in:

- `docs/reports/provider-host-probe-2026-09-07.json`
- `docs/reports/provider-resolver-probe-2026-09-07.json`
