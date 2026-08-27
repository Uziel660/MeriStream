# Arquitectura de BD Multi-Fuente (MediaEpisode + SourceLink)

## Objetivo

Hoy el modelo `Episode` (prisma/schema.prisma:33) guarda **una sola URL** en
`source_url`. Eso obliga a duplicar registros cuando la misma película/episodio se
extrae de varios sitios, o a sobrescribir el enlace perdiendo los anteriores.

El diseño propuesto separa **entidad editorial** (la obra) de **enlaces extraídos**
(los streams), de modo que una película auditada aglutine `SourceLink` provenientes
de 3 fuentes distintas (Sitio A, Sitio B, Sitio C) bajo el mismo registro del
catálogo, permitiendo fallbacks automáticos sin duplicar la película.

## Modelo propuesto (Prisma)

```prisma
// ─── Entidad editorial única por obra ───────────────────────────────

model MediaItem {
  id               String   @id @default(cuid())
  normalized_title String   // clave de deduplicación entre orígenes
  title            String
  kind             String   // "movie" | "series" | "anime" | ...
  year             Int?
  poster_url       String?
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt

  episodes         MediaEpisode[]

  @@unique([normalized_title, kind, year])
  @@index([normalized_title])
}

model MediaEpisode {
  id             String     @id @default(cuid())
  media_item_id  String
  media_item     MediaItem  @relation(fields: [media_item_id], references: [id], onDelete: Cascade)
  season_number  Int        @default(1)
  episode_number Float

  links          SourceLink[]
  createdAt      DateTime   @default(now())
  updatedAt      DateTime   @updatedAt

  @@unique([media_item_id, season_number, episode_number])
}

// ─── Enlaces crudos, uno por (episodio, origen) ─────────────────────

model SourceLink {
  id             String      @id @default(cuid())
  media_episode_id String
  media_episode  MediaEpisode @relation(fields: [media_episode_id], references: [id], onDelete: Cascade)

  source_site    String      // "sitio-a.com" | "sitio-b.net" | ... (origen del scrape)
  url            String      // stream directo o página embed según link_type
  link_type      String      // "direct" | "embed"
  host           String?     // "goodstream", "mega.nz", ... para telemetría
  priority_tier  Int?        // 1..4 — salida de server/utils/streamSorter.ts
  is_verified    Boolean     @default(false)
  last_checked   DateTime?

  @@unique([media_episode_id, source_site, url])
}
```

### Claves del diseño

1. **Deduplicación en `MediaItem`**: `normalized_title` (ya existe como utilidad en
   `server/db.ts` → `normalizeTitle`) más `kind` y `year` forman la identidad de la
   obra. Dos scrapers que encuentran "Superman 1978" escriben sobre el mismo
   `MediaItem`, nunca crean dos fichas.
2. **Unicidad por episodio**: `@@unique([media_item_id, season_number,
   episode_number])` garantiza un solo nodo `MediaEpisode` por episodio aunque tres
   orígenes distintos lo descubran en la misma crawlea.
3. **Fan-out de enlaces**: cada hallazgo de URL inserta una fila `SourceLink`
   `(episode, source_site, url)`; si ya existe, se actualiza `last_checked` /
   `is_verified` en lugar de duplicar. La película vive una vez; los enlaces son N.
4. **Fallback automático**: el reproductor recibe los links ordenados por
   `priority_tier ASC` (jerarquía de `server/utils/streamSorter.ts`) y cae al
   siguiente al primer fallo. El tier persistido se recalcula en cada crawl para no
   envejecer.

## Migración desde el esquema actual

- `Show` → `MediaItem`, `Episode` → `MediaEpisode` (renombrado semántico; mismo rol).
- `Episode.source_url` migra como la primera fila `SourceLink` con
  `source_site = dominio del crawl` y `link_type = direct|embed`.
- Los endpoints existentes que leen `episode.source_url` pueden seguir sirviendo
  ese valor tomando el `SourceLink` con menor `priority_tier`.

## Consulta típica (fallback chain)

```ts
const links = await prisma.sourceLink.findMany({
  where: { media_episode_id: episodeId },
  orderBy: [{ priority_tier: "asc" }, { last_checked: "desc" }],
});
// El player itera links[0..n] y conmuta al siguiente ante error 4xx/5xx o timeout.
```

## Impacto en telemetría QA

Con `SourceLink.host` + `SourceLink.priority_tier` + `last_checked` persistidos, el
barrido E2E puede medir tasa de éxito por host y por origen (`source_site`) sin
acoplar el ranking a memoria de proceso: el informe de QA pasa a leer de BD y el
orden de reproducción deja de depender del cliente (`src/utils/streamOptimizer.ts`)
para volverse decisión de servidor.
