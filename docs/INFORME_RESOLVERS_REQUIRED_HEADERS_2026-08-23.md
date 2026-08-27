# Informe: Resolvers con Blacklist, requiredHeaders (Vimeos) y MegaResolver Universal

**Fecha:** 2026-08-23
**Rama:** `e2e-barrido-adaptadores`
**Alcance:** `server/resolvers.ts`, `server/hostProfiles.ts`, `server.ts`, `src/api/client.ts`, `src/types.ts`

## Objetivo

Optimizar el pipeline de auditoría de telemetría de video con 3 componentes en `server/resolvers.ts`:
1. **Blacklist global** de proveedores muertos.
2. **VimeosResolver**: extractor del `.m3u8` maestro con `requiredHeaders` obligatorios (el nodo CDN responde 403 sin ellos según telemetría).
3. **MegaResolver Universal**: normalización de URLs de Mega.

## Cambios realizados

### 1. `server/resolvers.ts`

#### Blacklist global
```ts
export const DEAD_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
  "voe.sx", "voe", "mixdrop", "filemoon",
]);

export function isValidProvider(url: string): boolean
```
Devuelve `false` si la URL contiene alguno de los dominios muertos. Pensado para filtrarse antes de gastar fetches en el pipeline.

#### VimeosResolver (extractor m3u8 maestro)
```ts
export interface VimeosResolution {
  url: string;              // "" si no se pudo resolver
  requiredHeaders: { Origin: "https://vimeos.net"; Referer: "https://vimeos.net/" };
}
export async function resolveVimeosEmbed(embedUrl: string): Promise<VimeosResolution>
```
- Estrategia: fetch del HTML del embed → desempaquetar Dean Edwards Packer si existe (`jsUnpacker.unpackGeneric`) → regex sobre el objeto `sources` del player → primera URL `.m3u8`.
- `requiredHeaders` se devuelve **siempre**, incluso en fallo/timeout, porque aplica a cualquier consumo posterior del stream.
- Reutiliza `VimeosResolver.isVimeosUrl()` e `isDownloadHostUrl()` de `server/scrapers/vimeosResolver.ts` (no duplica la clase existente).
- Timeout: 7500ms con `AbortController`.

#### requiredHeaders en `ResolvedStreamMeta`
La interfaz `ResolvedStreamMeta` ganó `requiredHeaders?: Record<string, string>` y `EmbedResolvers.resolveWithMeta()` lo adjunta cuando `provider === "Vimeos"` — cubre tanto embeds como MP4 directos del CDN (`s{N}.vimeos.net`). Sin cambios de firma que rompan los adapters consumidores.

#### MegaResolver Universal
```ts
export interface NormalizedMega {
  fileId: string;
  fileKey: string;
  canonicalUrl: string;  // https://mega.nz/file/{ID}#{KEY}
  embedUrl: string;      // https://mega.nz/embed/{ID}#{KEY}
}
export function normalizeMegaUrl(url: string): NormalizedMega | null
```
Extrae ID+key de cualquier variante pública (`/file/`, legacy `/#!id!key`, `/embed/`) reutilizando el parser verificado `server/resolvers/megaResolver.ts`.

### 2. `server/hostProfiles.ts` — fuente única por host

Perfil nuevo para que `/api/v1/proxy/stream` **inyecte realmente** los headers al reproducir:

```ts
export const VIMEOS_REQUIRED_HEADERS = {
  Origin: "https://vimeos.net",
  Referer: "https://vimeos.net/",
} as const;

// En HOST_PROFILES:
{
  match: ["vimeos.net"],
  refererMode: "fixed",
  referer: VIMEOS_REQUIRED_HEADERS.Referer,
  extraHeaders: { Origin: VIMEOS_REQUIRED_HEADERS.Origin },
}
```
`resolvers.ts` importa esta constante (fuente única, sin duplicación). Cubre embeds y nodos `s{N}.vimeos.net`.

### 3. `server.ts` — propagación en la API

`POST /api/v1/resolve-embed` ahora incluye `requiredHeaders: meta.requiredHeaders` en las ramas `regex_fast` y `unresolved_embed`. Respuesta ejemplo (vimeos):

```json
{
  "url": "https://s1.vimeos.net/v/....mp4?token=...",
  "original_url": "https://vimeos.net/embed-abc.html",
  "resolved": true,
  "type": "direct",
  "provider": "Vimeos",
  "requiredHeaders": { "Origin": "https://vimeos.net", "Referer": "https://vimeos.net/" },
  "strategy": "regex_fast"
}
```

### 4. Cliente TypeScript — propiedad opcional

| Archivo | Interfaz | Campo añadido |
|---|---|---|
| `src/api/client.ts` | retorno de `resolveEmbed()` | `requiredHeaders?: Record<string, string>` |
| `src/api/client.ts` | retorno de `getEpisodeServers()` | idem |
| `src/types.ts` | `MediaStreamOut` | idem |

## Verificación

### Tests
```
npx vitest run server/resolvers.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)

npx tsc --noEmit -p tsconfig.json   → limpio
```

Suite completa: **154/159 pasan**. Los 5 fallos son pre-existentes, verificados ejecutándolos sobre el árbol limpio con `git stash` (fallan igual sin estos cambios):
- `server/utils/streamSorter.test.ts` ×1: espera `mega.io → TIER 4`, pero el código solo matchea el token `mega.nz`. Desalineación test/código ajena a esta tarea.
- `tests/scrapers/TubePelisAdapter.test.ts` ×4: integración real contra `tubepelis.com` (falla por red/sitio).

## Notas y límites

- **`POST /api/v1/catalog/episode-servers` no propaga `requiredHeaders`**: ese endpoint devuelve arrays planos de strings desde `BaseAdapter.extractStream()`, que descarta metadata. Propagarlo requeriría refactorizar toda la cadena de adapters (fuera de alcance).
- El header en el JSON es informativo para el cliente; la inyección efectiva ocurre server-side en el proxy vía perfil de host (patrón ya establecido en el repo: headers por host viven en `hostProfiles.ts`, nunca hardcodeados en `server.ts`).
- Trabajo paralelo detectado durante la edición (imports de `obscureResolvers`, providers Bysekoze/Hexload) quedó intacto.

---

## Adenda (2026-08-23): migración multi-fuente aplicada y sorter verificado

Hallazgos de la sesión posterior a este informe (diseño en `docs/DB_MULTISOURCE_ARCHITECTURE.md`):

### 1. `streamSorter` — desalineación mega.io RESUELTA

La nota de arriba ("espera `mega.io → TIER 4` pero el código solo matchea `mega.nz`") quedó obsoleta: se añadieron `mega.io` y `mega.co.nz` a los tokens TIER 4 de `server/utils/streamSorter.ts`, alineándolo con la convención de familia Mega que ya usaba `src/utils/streamOptimizer.ts`. Resultado:

```
npx vitest run server/utils/streamSorter.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Cobertura del test nuevo: jerarquía completa 1→4, hosts desconocidos entre tier 3 y 4 (`UNKNOWN_TIER = 3.5`), case-insensitivity, pureza (no muta la entrada), orden estable intra-tier y entrada vacía.

### 2. Esquema Prisma — migración aditiva aplicada a dev.db

- `prisma/schema.prisma`: modelos `MediaItem`, `MediaEpisode`, `SourceLink` añadidos **junto a** `Show`/`Episode` (sin renombrarlos: `server.ts`, `showService.ts` y el frontend consumen `source_url`/`episode_number`; el renombrado completo queda para una fase aparte).
- Backup previo: `prisma/dev.db.backup-multisource`.
- `npx prisma db push` OK; tablas verificadas en SQLite: `MediaItem`, `MediaEpisode`, `SourceLink` presentes.
- **Gotcha operativo**: `prisma generate` falló con `EPERM ... query_engine-windows.dll.node` porque el servidor Node del puerto 3005 tenía la DLL bloqueada. Tras detener el proceso, generate OK y smoke test `prisma.mediaItem.findMany()` accesible. Si vuelve a pasar: matar PID de 3005 antes de regenerar.
- **Gotcha de diseño**: el upsert por `@@unique([normalized_title, kind, year])` no sirve cuando `year` es NULL (SQL `UNIQUE` no agrupa nulos entre sí y Prisma no acepta null en el selector compuesto). `syncMediaItemSources` usa `findFirst` + create/update explícito.

### 3. `server/showService.ts` — inserción con array de sources

- `SaveShowInput` extendido con `sources?: SourceLinkInput[]` (nivel obra) y `sources?: SourceLinkInput[]` por episodio, más `source_site` como origen por defecto del crawl.
- Nueva export `syncEpisodeSources(mediaItemId, season, episodeNumber, sources, defaultSite)`: upsert idempotente de `MediaEpisode` (clave compuesta obra/temporada/número) y de cada `SourceLink` (clave episodio/sitio/url; si existe refresca `last_checked`/`is_verified`). `priority_tier` se calcula con `getStreamTier` del sorter; `link_type` inferido por extensión (direct) vs resto (embed); `host` extraído del hostname.
- Hook `syncMediaItemSources` best-effort tras el guardado legacy (create y merge paths): un fallo del espejo multi-fuente se loguea `[MultiSource]` pero no rompe el guardado principal.

### 4. Verificación

```
npx tsc -p tsconfig.json --noEmit            → limpio (src)
tsc estricto sobre server/showService.ts     → solo errores PRE-EXISTENTES de
                                               metadataEngine.ts(298-299) y metadataMerge.ts(119),
                                               reproducidos con árbol limpio vía git stash
npx vitest run                               → 155/159 pasan
```

Los 4 fallos son integración real contra sitios externos, verificados pre-existentes con `git stash`: `tests/scrapers/LaMovieAdapter.test.ts` (lamovie.org, red/sitio) entre otros del mismo tipo. Ninguna regresión de estos cambios.

---

# Anexo 2: Hallazgos QA — Resolvers oscuros Hexload / Bysekoze (latanime.org)

**Fecha:** 2026-08-23
**Alcance:** `server/scrapers/utils/obscureResolvers.ts` (nuevo), `server/resolvers.ts`, `test_obscure.ts`
**Método:** 100% `fetch` + `cheerio` + `jsUnpacker` (sin Playwright), contra URLs reales capturadas en telemetría.

## Contexto

El adaptador LatAnime (`server/scrapers/adapters/LatAnimeAdapter.ts`) emite nodos `hexload.com` y `bysekoze.com` que caían al resolver genérico y morían. Se implementaron resolvers dedicados con contrato **never-throw**: si la extracción explota o la ofuscación es indescifrable, devuelven `{ type: 'iframe', url: <embed original> }` para reproducción embebida + failover.

## Cambios

### 1. `server/scrapers/utils/obscureResolvers.ts` (nuevo)

- `resolveHexload()` / `resolveBysekoze()`: GET del embed (timeout 8s, headers navegador + Referer del origin) → extracción de `<script>` inline con cheerio → búsqueda `.m3u8`/`.mp4` vía `extractMediaUrlsFromCode` y `unpackDeanEdwards` (`jsUnpacker.ts`). Prioridad m3u8 > mp4 > URLs protocol-relative.
- Interfaz exportada: `ObscureResolution { type: 'direct' | 'iframe'; url: string; provider: string }`.
- Todo el flujo vive en try/catch: nunca propaga excepciones.

### 2. `server/resolvers.ts`

- Branch para `hexload` en `EmbedResolvers.resolve()` (usa `resolveHexload`; si no hay directo, devuelve el embed crudo).
- Provider names "Hexload" y "Bysekoze" en `getProviderName()`.
- **`isByseHost()` extendida con `bysekoze.com`** (ver hallazgo clave abajo).

## Hallazgos clave (prueba real)

### Bysekoze NO usa Dean Edwards: pertenece al ecosistema "Byse"

`GET https://bysekoze.com/e/c8k9c70sbcqo` devuelve la misma SPA React que byseqekaho/byselapuix:

```
status: 200 | bytes: 1964
title: Byse Frontend
tiene pack DeanEdwards: false | menciona m3u8: false
```

El video vive cifrado en `GET https://bysekoze.com/api/videos/c8k9c70sbcqo/`:

```
playback.algorithm: AES-256-GCM | playback.version: 20 | key_parts count: 30 | payload bytes: 740
```

Con `bysekoze.com` añadido a `isByseHost()`, el descifrado existente `resolveByse` (key = key_parts según permutación de `version`, AES-256-GCM, tag = últimos 16 bytes) lo resolvió directamente. **No intentar desempaquetado JS ni navegador: la ruta correcta es la API.**

### Hexload: archivos muertos (404)

`GET https://hexload.com/embed-ljdm74uwp` → `404 File Not Found`, sin pack Dean Edwards. La red de seguridad actuó según diseño: devolvió `{ type: 'iframe', url: original }` sin lanzar excepción; el failover continúa con el siguiente servidor.

## Output exacto de consola (`npx tsx test_obscure.ts`)

```
=== Bysekoze: https://bysekoze.com/e/c8k9c70sbcqo ===
obscureResolvers: {
  "type": "iframe",
  "url": "https://bysekoze.com/e/c8k9c70sbcqo",
  "provider": "Bysekoze"
}
-> obscure: IFRAME | 342ms
EmbedResolvers.resolve -> DIRECTO
   https://edge1-vienna-sprintcdn.owphbf24.com/hls2/06/11748/c8k9c70sbcqo_x/master.m3u8?t=...&s=...&e=10800&f=58741688&srv=1070&asn=174&sp=5500&p=0
-> pipeline total: 210ms

=== Hexload: https://hexload.com/embed-ljdm74uwp ===
obscureResolvers: {
  "type": "iframe",
  "url": "https://hexload.com/embed-ljdm74uwp",
  "provider": "Hexload"
}
-> obscure: IFRAME | 305ms
EmbedResolvers.resolve -> EMBED (fallback)
   https://hexload.com/embed-ljdm74uwp
-> pipeline total: 306ms
```

Nota: en Bysekoze el fallback `{type:'iframe'}` del módulo obscure es el camino esperado (su HTML no contiene media); el stream real sale del descifrado AES-GCM en `EmbedResolvers.resolve`. En Hexload ambos niveles caen a iframe porque el archivo no existe.

## Verificación

```
npx tsx test_obscure.ts             → Bysekoze DIRECTO (m3u8 firmado), Hexload iframe fallback, cero excepciones
npx tsc --noEmit -p tsconfig.json   → limpio
```
