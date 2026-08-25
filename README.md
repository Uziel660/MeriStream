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
