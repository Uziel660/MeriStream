# NITIFLIX / VOIDSTREAM — Plataforma de Streaming Personal

**Versión 6.0** | Node.js + React + PostgreSQL 16

---

## Qué es esto

Una plataforma de streaming personal estilo Netflix. Sirve para:
- **Buscar y ver** películas, series y animes
- **Importar contenido** desde 12+ sitios web (AnimeFLV, Cinecalidad, TioPlus, Archive.org, etc.)
- **Reproducir** con reproductor HLS/MP4 integrado, sin anuncios
- **Administrar** todo desde un panel de control

---

## Requisitos

| Requisito | Versión mínima | Cómo verificar |
|-----------|---------------|----------------|
| Node.js | 18+ (recomendado 20 o 24) | `node --version` |
| npm | 8+ | `npm --version` |
| Docker | Cualquier versión reciente | `docker --version` |

---

## Instalación paso a paso

### 1. Clonar el repositorio

```bash
git clone https://github.com/Uziel660/finalnewtify.git
cd finalnewtify
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Arrancar PostgreSQL (base de datos)

```bash
docker run -d --name voidstream-pg ^
  -e POSTGRES_HOST_AUTH_METHOD=trust ^
  -e POSTGRES_DB=voidstream ^
  -e POSTGRES_USER=voidstream ^
  -e POSTGRES_PASSWORD=voidstream123 ^
  -p 5433:5432 postgres:16-alpine
```

> En Mac/Linux usá `\` en lugar de `^` para continuar la línea.

### 4. Crear archivo de configuración

Crear un archivo llamado `.env` en la raíz del proyecto con este contenido:

```
DATABASE_URL="postgresql://voidstream:voidstream123@localhost:5433/voidstream?schema=public"
```

### 5. Preparar la base de datos

```bash
npx prisma db push
npx prisma generate
```

### 6. Arrancar la app

```bash
npm run dev
```

### 7. Abrir en el navegador

👉 **http://localhost:3000**

**Listo.** Ya tenés la app funcionando.

---

## Cómo usar la app

### Página principal

Al abrir `http://localhost:3000` ves:
- **Barra de búsqueda** arriba: escribí el nombre de una película o anime
- **Categorías**: Anime, Películas, Series, Terror, etc.
- **Hero Banner**: show destacado con imagen grande
- **Filas de contenido**: categorías organizadas

**La búsqueda es instantánea** — no necesitás esperar, se filtra en memoria.

### Buscar contenido

1. Escribí en la barra de búsqueda (arriba a la derecha)
2. Los resultados aparecen al instante (sin lag)
3. Podés filtrar por categoría haciendo clic en los botones

### Ver un título

1. Hacé clic en cualquier tarjeta de contenido
2. Se abre el modal con descripción, póster y lista de episodios
3. Elegí un episodio y hací clic en "Play"

### Reproducir

El reproductor carga automáticamente el mejor stream disponible:
- **HLS** (calidad adaptable) si está disponible
- **MP4** como fallback
- **Servidores alternativos** si uno falla (failover automático)

---

## Panel de administración

### Acceder

1. Ir a **http://localhost:3000/admin**
2. Iniciar sesión con las credenciales configuradas en `.env`:
   - Usuario: `admin` (o el que pongas en `ADMIN_USER`)
   - Contraseña: la que pongas en `ADMIN_PASS`

### Importar contenido

**Importar una serie/película:**
1. Copiá la URL del sitio fuente (ej: `https://animeflv.net/anime/naruto`)
2. Pegala en el campo "URL a analizar"
3. Hacé clic en "Analizar"
4. Revisá la información detectada
5. Hací clic en "Importar"

**Importar varias a la vez:**
1. Pegá múltiples URLs (una por línea)
2. Hací clic en "Importar en lote"

### Rastreo automático (Crawler)

1. Configurá la URL base del sitio a rastrear
2. Elegí el alcance:
   - **Páginas específicas**: rastrea solo las páginas que indiques
   - **Catálogo completo**: rastrea todo el sitio automáticamente
3. Hací clic en "Iniciar Rastreo"
4. El worker corre en segundo plano y mostrá el progreso

### Gestionar el catálogo

- **Ver**: pestaña "Biblioteca" muestra todos los títulos importados
- **Buscar**: filtrá por nombre en la biblioteca
- **Eliminar**: hací clic en el botón de eliminar en cualquier título
- **Editar**: hací clic en un título para ver sus detalles y fuentes de video

---

## Scripts disponibles

```bash
npm run dev          # Arrancar en modo desarrollo
npm run build        # Compilar para producción
npm start            # Arrancar en modo producción
npm test             # Ejecutar todos los tests
npm run lint         # Verificar tipos de TypeScript
```

### Scripts de utilidad

```bash
npx tsx tools/fast-migrate-pg.ts        # Migrar datos de SQLite a PostgreSQL
npx tsx tools/add-fulltext-search.ts    # Agregar índices de búsqueda
npx tsx tools/fast-start.ts             # Auto-configurar y arrancar todo
npx tsx tools/merge-dbs.ts              # Fusionar múltiples bases SQLite
npx tsx tools/safe-migrate-pg.ts        # Migración segura con verificación
npx tsx tools/watchdog-runner.ts        # Runner del watchdog independiente
```

---

## Variables de entorno (.env)

| Variable | Ejemplo | Descripción |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://...@localhost:5433/voidstream` | Conexión a PostgreSQL |
| `ADMIN_USER` | `admin` | Usuario del panel admin |
| `ADMIN_PASS` | `tu-password` | Contraseña del panel admin |

---

## Estructura del proyecto

```
├── prisma/
│   └── schema.prisma          # Modelo de datos (Show, Episode, MediaItem, etc.)
├── server/
│   ├── showService.ts         # CRUD de shows + búsqueda
│   ├── taskWorker.ts          # Worker de rastreo en segundo plano
│   ├── metadataEngine.ts      # Enriquecimiento de metadatos (TMDB, AniList)
│   ├── verificationWorker.ts  # Verificación automática del catálogo
│   ├── writeBuffer.ts         # Cola de escrituras en memoria
│   ├── scrapers/
│   │   ├── ScraperManager.ts  # Factory de adaptadores
│   │   └── adapters/          # 12 adaptadores para diferentes sitios
│   └── resolvers.ts           # Resolución de streams de video
├── src/
│   ├── App.tsx                # Componente principal React
│   ├── components/
│   │   ├── AdminPanel.tsx     # Panel de administración
│   │   ├── HLSPlayerModal.tsx # Reproductor de video
│   │   ├── UnifiedHeader.tsx  # Barra de búsqueda y navegación
│   │   └── MediaDetailsModal.tsx  # Modal de detalles
│   └── utils/                 # Utilidades (colores, imágenes, streams)
├── tools/                     # Scripts de utilidad
├── server.ts                  # Servidor Express (API REST)
├── .env.example               # Plantilla de variables de entorno
└── package.json               # Dependencias y scripts
```

---

## Base de datos

### PostgreSQL (default desde v6.0)

La app usa PostgreSQL 16 desplegado en Docker. Características:
- **Full-Text Search**: búsqueda instantánea con índices GIN
- **Fuzzy matching**: tolerancia a errores de ortografía (pg_trgm)
- **Workers paralelos**: hasta 5 trabajos simultáneos (MVCC)
- **Trigger automático**: el campo de búsqueda se actualiza solo

### Comandos útiles de PostgreSQL

```bash
# Verificar que está corriendo
docker ps | grep voidstream-pg

# Conectar a la base
docker exec -it voidstream-pg psql -U voidstream -d voidstream

# Ver cuántos shows hay
docker exec voidstream-pg psql -U voidstream -d voidstream -c "SELECT COUNT(*) FROM \"Show\";"

# Reiniciar
docker restart voidstream-pg

# Detener
docker stop voidstream-pg

# Eliminar (borra los datos)
docker rm -f voidstream-pg
```

### Backup

```bash
# Crear backup
docker exec voidstream-pg pg_dump -U voidstream voidstream > backup.sql

# Restaurar backup
cat backup.sql | docker exec -i voidstream-pg psql -U voidstream -d voidstream
```

---

## Solución de problemas

### La app no arranca

| Error | Causa | Solución |
|-------|-------|----------|
| `Cannot find module` | Faltan dependencias | `npm install` |
| `ECONNREFUSED localhost:5433` | PostgreSQL no está corriendo | `docker start voidstream-pg` |
| `P2021: Table does not exist` | Tablas no creadas | `npx prisma db push` |
| `EPERM: operation not permitted` | Proceso usando el engine | Cerrar otras terminales con `npm run dev` |
| `P1000: Authentication failed` | Password incorrecta | Verificar `.env` y `POSTGRES_HOST_AUTH_METHOD=trust` |

### El reproductor no carga video

1. Verificá que la fuente tenga streams activos
2. Probá con otro servidor (el failover automático debería funcionar)
3. Revisá la consola del navegador (F12) para errores

### La búsqueda es lenta

No debería serlo desde v6.0. Si lo es:
1. Verificá que el catálogo se cargó con `?lite=true`
2. Abrí DevTools > Network y fijate cuánto pesa la respuesta de `/api/v1/shows`

### El crawler no avanza

1. Verificá que la URL fuente esté online
2. Revisá los logs en la pestaña "Jobs" del admin
3. Pausá y reanudá el trabajo

---

## Técnicas de rendimiento aplicadas

### Backend

| Técnica | Dónde | Qué hace |
|---------|-------|----------|
| **Write-Buffer RAM** | `server/writeBuffer.ts` | Todas las escrituras a DB van a una cola en memoria. Un writer secuencial las aplica cada 5ms. Los workers NUNCA tocan la DB directamente |
| **Endpoint lite** | `GET /api/v1/shows?lite=true` | Devuelve shows SIN episodios. Payload ~2MB vs ~15MB |
| **Full-Text Search** | PostgreSQL tsvector + GIN | Búsqueda por texto en milisegundos. El trigger auto-actualiza el campo de búsqueda |
| **Fuzzy matching** | pg_trgm | Tolerancia a typos: "narut" todavía encuentra "Naruto" |
| **Paginación server-side** | `?page=1&limit=500` | Evita traer 12K+ registros de una |
| **MVCC PostgreSQL** | Workers paralelos | Hasta 5 workers simultáneos sin locks ni bloqueos |
| **PRAGMAs eliminados** | `server.ts` | Ya no se usan WAL/busy_timeout de SQLite |

### Frontend

| Técnica | Dónde | Qué hace |
|---------|-------|----------|
| **Catálogo en memoria** | `App.tsx` | Carga UNA VEZ al montar (~2MB), filtra localmente |
| **Búsqueda local** | `filteredShows` useMemo | `Array.filter()` en memoria = instantáneo, cero API calls |
| **Debounce 300ms** | `UnifiedHeader.tsx` | Evita filtrar en cada tecla, espera a que deje de escribir |
| **Episodios bajo demanda** | `MediaDetailsModal.tsx` | Solo carga episodios cuando el usuario abre un título |
| **Lazy loading de imágenes** | `SmartImage.tsx` | Las imágenes cargan cuando entran en viewport |

### Scraping

| Técnica | Dónde | Qué hace |
|---------|-------|----------|
| **Adaptadores Strategy** | `server/scrapers/adapters/` | Cada sitio tiene su adaptador. Si uno falla, el genérico toma el relevo |
| **Rate limiting + jitter** | `server/taskWorker.ts` | Delay entre requests + jitter aleatorio para no ser bloqueado |
| **Anti-bot detection** | `server/utils/antiBot.ts` | Detecta Cloudflare, 429s. Auto-throttle por dominio |
| **Deduplicación** | `server/showService.ts` | Por mal_id o título normalizado. Fusiona episodios, no crea duplicados |
| **Write buffer** | `server/writeBuffer.ts` | Las escrituras van a un buffer JSONL y se aplican cuando la DB responde |

---

## Decisiones de arquitectura (NO TOCAR sin entender)

### 1. Write-Buffer: los workers NUNCA tocan la DB

```
Worker → enqueueWrite() → Cola RAM → Writer secuencial → DB
```

**Por qué:** Evita carreras de escritura. Si varios workers escriben a la vez, PostgreSQL puede deadlockear o SQLite puede corromperse.

**Si querés modificar:** Nunca pongas `prisma.show.create()` directo en un worker. Usá `enqueueShowCreate()`, `enqueueShowUpdate()`, `enqueueWrite()`.

### 2. Endpoint lite SIN episodios

```
Frontend → /shows?lite=true → shows sin episodes → filtro local
Modal → /shows/:id → show CON episodes → solo cuando se abre
```

**Por qué:** 12K shows × ~6 episodios promedio = ~72K registros. Traerlos todos en cada búsqueda es lento e inútil.

**Si querés modificar:** No agregues `include: { episodes }` al endpoint lite. Si necesitas episodios, usá el endpoint `/shows/:id`.

### 3. Búsqueda local vs server-side

```
Frontend: Array.filter() en memoria (instantáneo)
Backend: tsvector + GIN (fallback si el catálogo crece a 100K+)
```

**Por qué:** La búsqueda local es instantánea (<1ms). La de PostgreSQL es rápida (~5ms) pero requiere round-trip a la DB.

**Si querés modificar:** No deshabilites la búsqueda local. Si agregás más campos de búsqueda, actualizá el `filteredShows` en `App.tsx`.

### 4. Schema Prisma: campos calculados NO van en el schema

El campo `search_vector` se maneja con raw SQL + trigger, NO en el schema.prisma.

**Por qué:** Prisma no soporta tsvector. Si lo ponés en el schema, Prisma intentará manejarlo y fallará.

**Si querés modificar:** Si agregás campos de PostgreSQL avanzados (JSONB, arrays, hstore), usá raw SQL para crearlos e initelos con `$executeRawUnsafe`.

### 5. IDs generados por el worker

Los IDs de show/episode se generan EN EL WORKER antes de encolar, no en el writer.

**Por qué:** El worker necesita el ID para referencias cruzadas (episodes necesitan show_id).

**Si querés cambiar el ID scheme:** Actualizá `generateId()` en el worker y verificá que no haya unique constraints que se rompan.

---

## Consideraciones al modificar la app

### Si agregás una nueva tabla

1. Agregar al `prisma/schema.prisma`
2. Ejecutar `npx prisma db push`
3. Si la tabla tiene text search, agregar índice GIN manualmente con `$executeRawUnsafe`
4. Actualizar `tools/fast-migrate-pg.ts` si querés que la migración la incluya

### Si agregás un nuevo endpoint

1. Agregarlo en `server.ts`
2. Si escribe a la DB, usar el write-buffer (no prisma directo)
3. Si es de solo lectura, pode prisma directo
4. Documentarlo en el README sección "API REST Endpoints"

### Si agregás un adaptador de scraping

1. Crear `server/scrapers/adapters/MiAdapter.ts`
2. Extender `BaseAdapter`
3. Implementar `canHandle(url)` y `scrape(url)`
4. Registrarlo en `ScraperManager.ts`
5. Probarlo con `npm test`

### Si modificás el reproductor

1. `src/components/HLSPlayerModal.tsx` es el reproductor principal
2. Usa Hls.js para streams .m3u8
3. El proxy anti-CORS está en `/api/v1/proxy/stream`
4. Los streams se resuelven Just-In-Time al dar play

### Si cambiás la base de datos

**De PostgreSQL a SQLite:**
1. Cambiar `prisma/schema.prisma`: `provider = "sqlite"`
2. Quitar `.env` (o poner `DATABASE_URL="file:./dev.db"`)
3. Ejecutar `npx prisma db push`
4. Quitar full-text search (no existe en SQLite)
5. Los workers vuelven a ser 1 solo (SQLite tiene locks)

**De PostgreSQL a Turso/libSQL:**
1. Cambiar `DATABASE_URL` a `libsql://...`
2. Configurar `TURSO_AUTH_TOKEN`
3. Ejecutar `npx prisma db push`

---

## Portear a otras plataformas

### Android (React Native o Capacitor)

La app usa React + Vite. Para portear a Android:

**Opción 1: Capacitor (recomendado)**
```bash
npm install @capacitor/core @capacitor/cli
npx cap init nitiflix com.nitiflix.app
npx cap add android
npm run build
npx cap sync
npx cap open android
```
- El backend corre en un servidor remoto (no en el celular)
- Cambiar `localhost:3000` por la IP del servidor en `app.config.ts`
- El reproductor HLS funciona nativo en Android via ExoPlayer

**Opción 2: PWA (más fácil)**
- Agregar un `manifest.json` con iconos y colores
- Service worker para caché offline
- Se "instala" desde Chrome en Android

**Cosas a tener en cuenta:**
- El proxy anti-CORS (`/api/v1/proxy/stream`) DEBE correr en el servidor, no en el celular
- PostgreSQL debe estar en el servidor (no en Docker local del celular)
- Los scrapers hacen fetch a sitios externos: necesitan internet
- El reproductor HLS funciona nativo, pero MP4 puede necesitar configuración extra

### iOS (React Native o Capacitor)

Mismas opciones que Android. Consideraciones:
- HLS funciona nativo en iOS (es su formato preferido)
- CORS es menos estricto en WKWebView

### Deploy en servidor (producción)

```bash
# 1. Compilar
npm run build

# 2. Configurar .env con PostgreSQL de producción
DATABASE_URL="postgresql://user:pass@your-pg-host:5432/voidstream"

# 3. Iniciar
npm start
```

**Recomendaciones:**
- Usar PM2 o systemd para mantener el proceso vivo
- PostgreSQL en RDS (AWS), Cloud SQL (GCP) o DigitalOcean
- nginx como reverse proxy con SSL
- El dominio ngrok es solo para desarrollo

---

## Escalabilidad

### Cuánto aguanta la configuración actual

| Métrica | Capacidad actual |
|---------|-----------------|
| Shows en catálogo | 12,000+ (probado) |
| Búsqueda local | Instantánea hasta 50K shows |
| Workers paralelos | 5 simultáneos |
| Escrituras/segundo | ~200 (write buffer) |
| Conexiones DB | Pool de Prisma (~10) |

### Cuándo escalar

| Si necesitás... | Hacer... |
|-----------------|----------|
| 50K+ shows | La búsqueda local sigue funcionando, pero considerar paginación |
| 100K+ shows | Mover búsqueda a server-side (tsvector ya está configurado) |
| 1000+ usuarios simultáneos | Escalar PostgreSQL (read replicas) |
| Scraping masivo | Aumentar `max_concurrent_jobs` en WorkerSettings |
| Deploy global | Mover a Turso/libSQL (SQLite distribuido) o PlanetScale |

---

## Tecnologías usadas

| Componente | Tecnología |
|------------|-----------|
| Backend | Node.js + Express + TypeScript |
| Frontend | React 18 + TypeScript + Vite |
| Base de datos | PostgreSQL 16 (Docker) |
| ORM | Prisma 5.22 |
| Estilos | Tailwind CSS |
| Reproductor | Hls.js + Plyr |
| Tests | Vitest |
| Scraping | Cheerio + adaptadores custom |

---

## Licencia

Proyecto personal. Todos los derechos reservados.
