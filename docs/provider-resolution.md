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

The latest public probes are stored in:

- `docs/reports/provider-host-probe-2026-09-07.json`
- `docs/reports/provider-resolver-probe-2026-09-07.json`
