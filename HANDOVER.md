# MERISTREAM — INFORME DE TRASPASO TÉCNICO Y ESTADO DEL SISTEMA (HANDOVER DOCUMENT)
**Fecha de generación:** 5 de Septiembre de 2026  
**Destinatario:** Siguiente Agente de Inteligencia Artificial / Desarrollador  
**Proyecto:** MeriStream (Plataforma de Streaming Unificada de Anime, Películas y Series)

---

## 1. RESUMEN EJECUTIVO Y RESTRICCIONES CRÍTICAS

MeriStream es una plataforma web completa de streaming que unifica 10 proveedores y agregadores externos en un catálogo único de **38,448 obras** y más de **250,000 enlaces de reproducción** respaldados en PostgreSQL.

### ⚠️ RESTRICCIONES ABSOLUTAS DE DISEÑO (OBLIGATORIAS)

1. **RESTRICCIÓN DE HARDWARE (LAPTOP SERVER 2 GB RAM):**
   - El servidor de producción definitivo correrá en una laptop con **solamente 2 GB de RAM**.
   - **PROHIBIDO EL USO DE PLAYWRIGHT / CHROMIUM HEADLESS EN PRODUCCIÓN:** No se pueden instanciar navegadores headless en los workers de streaming ni en endpoints en tiempo real. 
   - El backend utiliza Node.js ligero, `undici` para streaming binario de alto rendimiento, e `ImpitHttpClient` (@crawlee/impit-client) para evadir WAFs (Cloudflare/DDoS-Guard con huella JA3/JA4 Chrome) sin sobrecarga de memoria.
2. **REGLA "NADA DE EMBED":**
   - El usuario ha exigido terminantemente que **NO** se muestren reproductores embebidos (`<iframe>` con anuncios, popups, redirecciones o captchas de terceros).
   - Todo el contenido debe reproducirse en nuestro reproductor propio:
     - Streams HLS (`.m3u8`) procesados con **HLS.js**.
     - Archivos directos (`.mp4`) reproducidos nativamente en el elemento `<video>` de HTML5.
   - Si un proveedor o episodio no tiene ningún stream directo nativo válido o sus servidores están caídos, la API debe devolver **`404 No se pudieron obtener servidores de reproducción nativa directos`** en lugar de degradar a un iframe con anuncios.

---

## 2. ARQUITECTURA GENERAL DEL SISTEMA

```
+-------------------------------------------------------------------------+
|                              FRONTEND                                   |
|  React 18 + Vite + Tailwind CSS + Lucide Icons + HLS.js + Plyr          |
|  - UnifiedHeader (Buscador reactivo 200ms con auto-sync de estado)      |
|  - App.tsx (Prioridad absoluta a la búsqueda sobre pestañas de catálogo)|
|  - HLSPlayerModal (Reproductor nativo HLS/MP4 con auto-failover)        |
+-------------------------------------------------------------------------+
                                    |
                        HTTP REST / JSON / HLS Streams
                                    |
+-------------------------------------------------------------------------+
|                          BACKEND (server.ts)                            |
|  Express 5 + Node.js (Puerto 3010)                                      |
|  - HostProfiles: Cabeceras anti-hotlinking (Goodstream, Vimeos, etc.)   |
|  - StreamSorter: Tiers de calidad (Tier 1: UGC, Goodstream, Acek, etc.) |
|  - Resolvers JIT: Extracción bajo demanda de enlaces directos           |
|  - DeliveryPlanner & PlaybackSessions: Relay transparente si requerido  |
+-------------------------------------------------------------------------+
            |                                       |
+---------------------------+       +------------------------------------+
|    BASE DE DATOS          |       |        TÚNEL CLOUDFLARE            |
|  PostgreSQL 16 en Docker  |       |  cloudflared tunnel                |
|  Puerto 5433              |       |  URL de acceso público externo     |
|  38,448 Shows en tabla    |       +------------------------------------+
|  MediaEpisode + SourceLink|
+---------------------------+
```

---

## 3. PROVEEDORES INTEGRADOS (10 FUENTES)

El sistema agrega contenido de 10 fuentes principales:

| Proveedor | Tipo | Estado Simulación Directa | Servidores Habituales |
| :--- | :--- | :--- | :--- |
| **AnimeFLV** (`animeflv.net`) | Anime | ✅ **100% Nativo** (HLS.js, 343 ms) | `playmudos.com` (`.m3u8`), Mega, Premilkyway |
| **JKAnime** (`jkanime.net`) | Anime | ✅ **100% Nativo** (HLS.js, 362 ms) | `playmudos.com`, Premilkyway, Acek-cdn |
| **LatAnime** (`latanime.org`) | Anime | ✅ **100% Nativo** (HLS.js, 752 ms) | `sprintcdn.r66nv9ed.com`, Bysekoze, MP4Upload |
| **TubePelis** (`tubepelis.com`) | Películas | ✅ **100% Nativo** (HLS.js, 665 ms) | `sprintcdn.owphbf24.com` (`.m3u8`) |
| **GNULA** (`ww3.gnulahd.nu`) | Películas | ✅ **100% Nativo** (HLS.js, 723 ms) | `premilkyway.com`, SprintCDN |
| **Cinecalidad** (`cinecalidad.am`)| Películas | ⚠️ **404 Limpio** (Anti-Embed activo) | Upstream requiere refresco JIT de selectores |
| **Doramasflix** (`doramasflix.io`)| Doramas | ⚠️ **404 Limpio** (Anti-Embed activo) | Upstream requiere refresco JIT de selectores |
| **LaMovie** (`lamovie.org`) | Películas | ⚠️ **404 Limpio** (Anti-Embed activo) | Servidores caídos o token dinámico |
| **TioPlus** (`tioplus.app`) | Películas | ⚠️ **Timeout CDN 7s** | CDN Waaw/cfglobalcdn saturado |
| **VerAnimes** (`veranimes.net`)| Anime | ⚠️ **404 Limpio** (Anti-Embed activo) | Upstream requiere actualización de regex |

---

## 4. PROBLEMAS CRÍTICOS RESUELTOS EN ESTA SESIÓN

### A. Corrección de la Barra de Búsqueda (Frontend y Backend)
- **Problema reportado:** El usuario indicó que al buscar títulos no aparecía nada, o la búsqueda fallaba.
- **Causa Raíz 1 (Jerarquía de vistas en `src/App.tsx`):**  
  El condicional de renderizado evaluaba primero `activeFilter === 'recommendations'` y `activeFilter === 'explore'` antes de verificar si `searchQuery` contenía texto. Si el usuario estaba navegando en la pestaña "Explorar catálogo" o en "Recomendaciones" y escribía en el buscador, la pantalla permanecía fija en esa vista y nunca mostraba los resultados.
  *Solución:* `searchQuery && searchQuery.trim().length >= 2` ahora tiene **prioridad 1** absoluta en el árbol JSX.
- **Causa Raíz 2 (Corte en memoria a 25k títulos):**  
  El catálogo inicial cargaba 25,000 títulos en memoria, pero la base de datos contiene **38,448 obras**. Títulos ubicados más allá del registro 25,000 (como *"La captura"* en el #38,444 o *"Black Cat and a Witch"* en el #38,447) no existían en el estado local de React.
  *Solución:* Se conectó la búsqueda federada a PostgreSQL vía `/api/v1/shows?lite=true&search=...`, consultando toda la base de datos con índices full-text y uniendo los resultados en tiempo real.
- **Causa Raíz 3 (Bug SQL en `getShowsFromDbLite` en `server/showService.ts`):**  
  El query de búsqueda utilizaba `LOWER(title) LIKE $2` donde `$2` se pasaba como `s.toLowerCase()` **sin comodines `%`**. Esto obligaba a que el título fuera idéntico a la consulta exacta en lugar de buscar subcadenas. Además, `$1` introducía operadores booleanos manuales `&` que causaban discrepancias con `plainto_tsquery`.
  *Solución:* Se corrigió el parámetro a `%$s.toLowerCase()}%` y se pasó la cadena natural a `plainto_tsquery('simple', $1)`.
- **Causa Raíz 4 (Congelamiento de interfaz por Levenshtein sincrónico):**  
  `searchShows` en `src/utils/searchUtils.ts` calculaba la distancia de Levenshtein palabra por palabra sobre los 25,000 títulos en cada evento `onChange`, bloqueando el hilo de JavaScript en navegadores de bajo rendimiento.
  *Solución:* Se delegó el ordenamiento de relevancia a PostgreSQL (`ts_rank`) y en el cliente se realiza un filtrado instantáneo por coincidencia de subcadena sin retraso perceptible.
- **Causa Raíz 5 (Sincronización de componentes):**  
  Se agregó la prop `searchQuery` a `UnifiedHeader.tsx` para sincronizar bidireccionalmente el input con los botones de "Restablecer filtros" y limpiar la búsqueda al alternar entre categorías.

### B. Pruebas por Lote con Obras Diversas por Proveedor
- **Problema reportado:** En simulaciones anteriores, se probaba la misma obra repetidamente en diferentes proveedores (por ejemplo, *Yozakura* o *Solo Leveling* aparecían tanto en AnimeFLV como en JKAnime).
- **Solución implementada:** En `server.ts` (línea ~3177), la ruta `/api/v1/debug/simulate-frontend-playback?test_all=true` ahora mantiene un `chosenShows = new Set<string>()`, garantizando que **cada uno de los 10 proveedores evalúe una obra totalmente diferente**.

### C. Exclusión Estricta de Páginas Web Crudas (Eliminación de Iframes)
- **Solución en `server.ts`:** Se actualizó `handlePlayEpisode` para que si un scraper devuelve URLs de páginas completas (rutas con `/ver/`, `/pelicula/`, etc.), el backend las descarte activamente (`classifySourceKind(url) !== "page"`) y devuelva 404 en lugar de retornar una página HTML como stream de video. Esto erradica por completo la inyección de iframes con publicidad.

---

## 5. HERRAMIENTAS Y ENDPOINTS DE DIAGNÓSTICO CREADOS

### Endpoint de Simulación Frontend Click-to-Play
- **Ruta:** `GET /api/v1/debug/simulate-frontend-playback`
- **Parámetros disponibles:**
  - `?test_all=true`: Ejecuta la prueba secuencial de los 10 proveedores con 10 obras distintas.
  - `?provider=animeflv` (o `jkanime`, `cinecalidad`, etc.): Prueba un proveedor específico.
  - `?episode_id=<ID>`: Prueba un episodio concreto.
- **Qué hace internamente:**
  1. Invoca `/api/v1/play/:episode_id` simulando la llamada del reproductor.
  2. Evalúa la respuesta (código HTTP, latencia, lista clasificada `ranked_streams`).
  3. Ejecuta una sonda de red real (`probeStreamNetwork`) mediante peticiones `GET` con rango de bytes (`Range: bytes=0-2048`) y cabeceras de evasión anti-hotlinking.
  4. Verifica si el recurso devuelto es un manifiesto `#EXTM3U` válido o un archivo MP4 con encabezados `ftypmp42`, o si es una página HTML bloqueada.
  5. Realiza failover automático a los servidores de respaldo si el primario no responde.
  6. Devuelve un veredicto JSON estructurado con garantías de reproducción nativa sin iframes.

---

## 6. COMANDOS OPERACIONALES Y ENTORNO

### Variables y Puertos Activos
- **Puerto Servidor:** `3010` (`http://127.0.0.1:3010` o `http://0.0.0.0:3010`)
- **Puerto Base de Datos PostgreSQL:** `5433` (Contenedor Docker `voidstream-pg`)
  - URL de conexión: `postgresql://postgres:postgres@localhost:5433/meristream?schema=public`
- **Túnel Cloudflare (Activo en segundo plano):**
  - URL pública actual: `https://burns-definitely-candidates-recipient.trycloudflare.com`

### Comandos de Compilación y Ejecución
- **Compilar Frontend y Backend:**
  ```powershell
  npm run build
  ```
  *(Genera `dist/index.html`, bundles de Vite y `dist/server.cjs` con esbuild).*
- **Iniciar Servidor en Producción:**
  ```powershell
  npm run start
  ```
- **Probar Búsqueda desde Terminal:**
  ```powershell
  curl.exe -s "http://127.0.0.1:3010/api/v1/shows?lite=true&search=La+captura&limit=3"
  ```
- **Ejecutar Simulación E2E de los 10 Proveedores:**
  ```powershell
  curl.exe -s "http://127.0.0.1:3010/api/v1/debug/simulate-frontend-playback?test_all=true"
  ```

---

## 7. ARCHIVOS CLAVE MODIFICADOS

1. `src/App.tsx`:
   - Prioridad de renderizado para `searchQuery`.
   - Búsqueda federada server-side en PostgreSQL de 38,000+ obras.
   - Eliminación de Levenshtein sincrónico bloqueante; unión directa de resultados.
   - Sincronización de estado con `UnifiedHeader`.
2. `src/components/UnifiedHeader.tsx`:
   - Integración de prop `searchQuery` reactiva.
   - Limpieza automática de búsqueda al seleccionar categorías.
   - Debounce unificado a 200 ms.
3. `server/showService.ts`:
   - Corrección de comodines `%...%` en `getShowsFromDbLite` para coincidencia de subcadenas.
   - Limpieza del parámetro `plainto_tsquery('simple', $1)`.
4. `server.ts`:
   - Filtrado estricto contra iframes en `handlePlayEpisode`.
   - Diversidad de títulos en `simulate-frontend-playback` (`chosenShows`).
   - Sonda de red con cabeceras especializadas de `buildProxyHeaders`.
   - Detección de failover a servidores secundarios en la simulación.
5. `src/utils/streamOptimizer.ts` y `src/components/HLSPlayerModal.tsx`:
   - Corrección del detector de salud de servidores: ya no se marcan servidores falsamente como `'failed'` o muertos si la sonda rápida en background falla o da timeout.
   - Sonda HTTP mejorada: uso de `GET` con `Range: bytes=0-50` y cancelación inmediata del cuerpo (en lugar de `HEAD` que muchos CDNs rechazan con 405 Method Not Allowed).
   - Selector de servidores: todos los servidores inician como `'online'` disponibles (en lugar de parpadeo `'checking'`), se eliminó el tachado (`line-through`) y `cursor-not-allowed` erróneo sobre servidores que tuvieron fallos temporales, permitiendo al usuario seleccionarlos libremente. Confirmación a `'online'` en `MANIFEST_PARSED` y `loadedmetadata`.
6. `src/components/AdminPanel.tsx`:
   - Búsqueda en catálogo del panel de administración completamente reescrita: reemplazado el `fetch('/api/v1/shows?lite=true&limit=50000')` y filtrado en memoria (que congelaba la pestaña o fallaba) por búsqueda reactiva debounced (250 ms) contra PostgreSQL (`/api/v1/shows?lite=true&search=...&page=...&limit=50`).
   - Paginación dinámica con "Cargar más" y contador en tiempo real (`${shows.length} de ${total.toLocaleString()}`).
   - Botón de limpieza rápida de búsqueda (X) y soporte para búsquedas de 1 solo carácter en `server/showService.ts`.

---

## 8. PRÓXIMOS PASOS RECOMENDADOS PARA EL SIGUIENTE AGENTE

1. **Optimizar Scrapers con Fallo 404 (Cinecalidad, Doramasflix, LaMovie, VerAnimes):**
   - Actualmente, devuelven un 404 limpio que protege al usuario de iframes.
   - Para que reproduzcan exitosamente, se deben actualizar los extractores JIT correspondientes en `server/universalScraper.ts` o sus adaptadores en `server/scrapers/adapters/` para capturar los enlaces HLS/MP4 actualizados de los hosters que utilizan (como VidHide, StreamWish o servidores propios).
2. **Ajustar Timeout de CDNs Lentos (ej. TioPlus con Waaw/cfglobalcdn):**
   - En `TioPlus`, la sonda dio timeout a los 7 segundos. Aumentar ligeramente el timeout de probe o despriorizar el host `cfglobalcdn` en favor de servidores más rápidos en `server/serverPriorities.ts`.
3. **Caché en Navegador (Service Worker / PWA):**
   - Implementar un Service Worker básico para cachear los pósters de TMDB y Kitsu y reducir aún más el consumo de ancho de banda y memoria en la laptop del usuario.
