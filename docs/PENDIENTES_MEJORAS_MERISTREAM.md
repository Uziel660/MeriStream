# Pendientes de Meristream

Lista de trabajo para retomar la mejora integral de la aplicación. Se basa en los problemas observados en la aplicación real, el código y las pruebas realizadas; no sustituye la validación final después de cada cambio.

## Estado de partida

- Rama de trabajo: `lastversion`.
- Último commit publicado de esta revisión: `6d1d833 perf: parallelize provider fallbacks and bound slow APIs` (incluye la optimización común de servidores y el presupuesto no bloqueante para VidSrc).
- El worktree estaba limpio al crear esta lista.
- El `.env` de `E:\merinuevo\.env` ya se copió al proyecto local. Mantenerlo ignorado por Git y no exponer sus valores.
- El servidor local de desarrollo se probó en `http://localhost:3010/`.
- Esta lista se conserva como hoja de ruta; el estado de cada punto se actualiza con evidencia y commits.

## Auditoría de avance (2026-09-09)

### Ya aplicado y verificable

- **Separación visual del género y el título del hero:** commit `c2a2014`.
- **Panel `/admin` independiente y carga diferida del panel:** `src/main.tsx`, `AdminGate` lazy; commit `b6a60d8` y consolidación `88c3299`.
- **Responsive de catálogo, preferencias y navegación móvil:** commits `eaf2d68`, `d3b02db` y ajustes posteriores de estilos.
- **Imágenes adaptativas:** `src/utils/imageSizes.ts`, `SmartImage`, `srcset`/`sizes`, lazy loading en tarjetas y resolución TMDB por contexto; commits `5cda255`, `68ca1ec` y `88c3299`.
- **Carga diferida de overlays, modales y administración:** `src/components/lazy/DeferredOverlays.tsx` y `src/main.tsx`.
- **Cachés, índices locales, paginación y eliminación de solicitudes duplicadas:** commits `e57134c`, `c01a153`, `318124d` y `cfc9e93`.
- **Búsqueda existente:** debounce/cancelación en el header, búsqueda TMDB separada de trending, deduplicación, ranking base por popularidad y aliases locales; identificadores exactos TMDB/IMDb (`tt...`) ya funcionan.
- **Subtítulos fuera del camino crítico de reproducción:** el bootstrap los solicita en paralelo y los anexa sin reiniciar el vídeo (`src/utils/playbackBootstrap.ts`, `src/App.tsx`).
- **Texto de subtítulos legible:** `SubtitleProxy` prioriza UTF-8 válido, repara mojibake frecuente (`Ã`, `Â`, `â`) cuando está demostrado y limpia etiquetas HTML/entidades (`<i>`, `<br>`, `&amp;`) antes de generar WebVTT; el parser del reproductor repite la limpieza como defensa para pistas externas.
- **Posición de subtítulos:** Preferencias conserva arriba/centro/abajo y añade modo personalizado con coordenadas horizontal/vertical limitadas al 8–92% para evitar recortes en móvil; la configuración se guarda por perfil y el reproductor reacciona sin reiniciar el vídeo.
- **Protecciones parciales del fallback:** retirada de niveles HLS obsoletos, watchdog de congelación de 20 s y failover acotado; `PlyrPlayerModal` ya intenta `recoverMediaError`.

### Aplicado y verificado en `b2d2a3c`

- **VidSrc/NXSHA:** detección de etiquetas multidioma, preferencia de audio propagada al resolver, búsqueda acotada de mejores candidatos, subtítulos ordenados por preferencia y eliminación del falso valor por defecto `"en"` (`server/providers/api/vidsrcClient.ts`).
- **Filtro de identidad conservador:** el idioma original TMDB viaja hasta el gateway y una etiqueta VidSrc explícitamente incompatible se descarta salvo que el manifiesto exponga una pista esperada (caso `La isla olvidada`/`[Korean]`). La caché también separa las preferencias de idioma.
- **Idiomas indios y variantes:** aliases en `server/utils/languageDetector.ts`, normalización de provider policy y etiquetas de subtítulos.
- **SubtitleCat:** rechazo de resultados con año visible incompatible y pruebas de regresión para `La isla olvidada`.
- **Búsqueda multilingüe:** la búsqueda consulta TMDB en `es-419` y `en-US`, fusiona títulos bajo el mismo TMDB ID, conserva aliases y ordena por relevancia antes de popularidad (`server/publicCatalog.ts`). Esto cubre muchos desacuerdos TMDB/IMDb, pero todavía no es una consulta directa a la base de títulos de IMDb.
- **Puente local de títulos/aliases:** las fichas ya cargadas también se comparan por título localizado, alias almacenado, título inglés, original y japonés; los resultados locales y TMDB se fusionan solo cuando la identidad es inequívoca y se vuelven a ordenar por coincidencia (`src/App.tsx`). Así una búsqueda tipo `Forgotten Island` puede encontrar una ficha guardada como `La isla olvidada` sin adivinar entre candidatos ambiguos.
- **Lectura de preferencias:** `useHiddenGenres` ya no lee `localStorage` durante el inicializador síncrono; hidrata después del primer paint y luego sincroniza servidor/pestañas.
- **Recuperación HLS:** ante un `mediaError` fatal se intenta una recuperación in-place una vez por intento antes de escalar a proxy/failover; se registra el motivo.
- **Arranque VidSrc optimizado:** el gateway acepta el primer mirror y el primer hash HLS compatible/usable, descarta el idioma explícitamente incorrecto antes de sondear segmentos y corta el lote cuando todos apuntan al mismo CDN fallido; NXSHA consulta scrapers en lotes paralelos.
- **Arranque LatAnime optimizado:** el adaptador devuelve el primer HLS vivo sin esperar todos los embeds; `/api/v1/catalog/episode-servers` evita volver a desofuscar los fallbacks cuando ya existe un directo validado. Los demás locators siguen disponibles para resolución JIT.
- **Arranque común de plataformas:** `/api/v1/catalog/episode-servers` ya resuelve en paralelo los hasta cinco candidatos de LatAnime, TioAnime, Gnula y Cinecalidad, conservando el ranking original. ZokoAnime mantiene su ruta especial de metadata/Referer y no se mezcla con la optimización genérica.
- **Gateway sin bloqueo por VidSrc:** cuando la base ya tiene un fallback local recuperable, `/api/v1/providers/:kind/:tmdbId` solo espera 1,2 s al API externo; devuelve LatAnime/TioAnime/Gnula/Cinecalidad/ZokoAnime y deja VidSrc terminando en segundo plano para la caché. Si no hay fallback (p. ej. una obra solo VidSrc), conserva la espera completa.
- **Prioridad de imágenes:** `SmartImage` conserva `fetchPriority="high"` para el hero; antes el wrapper lo eliminaba y anulaba la pista LCP.
- **CLS del primer render:** el hero reserva una altura responsive estable, la imagen declara `width/height` panorámicos y se muestran skeletons de recomendaciones mientras llega la respuesta; además `index.html` preconecta con `image.tmdb.org`.
- **Pruebas E2E nuevas:** regresión VidSrc para TMDB `1465063` y auditoría móvil de home, ficha y login `/admin` (`e2e/provider-identity-guards.spec.ts`, `e2e/mobile-layout.spec.ts`).

### Evidencia de validación de esta revisión

- `npm run lint`: correcto (`tsc --noEmit`).
- Pruebas dirigidas de VidSrc, catálogo, subtítulos e idiomas: **54/54** correctas.
- `npm run build`: correcto; los avisos de chunks grandes corresponden al reproductor HLS/dash cargado bajo demanda.
- Pruebas unitarias dirigidas tras el puente de búsqueda: **27/27** correctas (`searchCatalogMerge`, `publicCatalog`).
- Prueba real `GET /api/v1/providers/movie/1465063?...&originalLanguage=en`: VidSrc etiquetado `[Korean]` ya no entra en `sources`.
- Prueba real `GET /api/v1/providers/movie/550?...&originalLanguage=en`: se conserva una fuente VidSrc con `audioLanguage: en`.
- Prueba real de latencia VidSrc/LatAnime (2026-09-09): `LatAnime One Piece` (`/ver/one-piece-latino-episodio-1`) pasó de aproximadamente **5,2 s** en la ruta completa a **1,1–2,3 s** en cuatro ejecuciones posteriores (variación de red); VidSrc `Fight Club` quedó en aproximadamente **3,1–4,2 s** cuando el upstream entrega HLS y el caso incompatible `1465063` corta en aproximadamente **4,1 s**, frente a ~13,7 s al recorrer todos los mirrors.
- Barrido real de servidores (2026-09-09), con locators de la base: ZokoAnime **0,4–0,5 s** y conserva HLS + subtítulos; TioAnime **~2,1–2,2 s** después de eliminar la espera serie del coordinador; Cinecalidad **~1,4–1,6 s** con Vimeos/Goodstream; LatAnime **~1,6–1,9 s** con HLS directo y locators JIT; Gnula **~1,8–2,2 s**, pero sus tres `player.php` actuales no exponen una pista nativa verificable y quedan correctamente como no resueltos.
- Con el presupuesto del gateway, un One Piece no cacheado con VidSrc lento pasó de **~13 s** a **~1,2 s** de respuesta, devolviendo los fallbacks locales; tras finalizar VidSrc en segundo plano, la siguiente petición usa la fuente cacheada. `La isla olvidada` sin fallback local conserva la espera completa (**~4,1 s**) y no se presenta como reproducible cuando la identidad/idioma no encajan.
- Prueba real de subtítulos para TMDB `1465063`: devolvió pistas `es-419`, `es` y `en` desde SubtitleCat, sin el año conflictivo de `Fantasy Island (1977)`.
- La suite completa de Vitest terminó **811/811** correcta tras el último cambio. La ejecución E2E conjunta terminó **14/18**: los cuatro fallos restantes son expectativas antiguas del test (fallback local y botón de paginación que ya fue sustituido por autoload, más una etiqueta accesible antigua), no errores del puente de búsqueda; los cinco E2E de búsqueda y los cuatro de móvil/identidad sí pasaron.
- E2E dirigido móvil + identidad VidSrc: **4/4** correctos.
- Medición automatizada de imagen hero: `loading=eager`, `fetchPriority=high`, sin overflow horizontal en 390 px; `/admin` conserva campos y botón de 44 px.
- Medición local con PerformanceObserver en sesión limpia: CLS aproximado **0,025** en escritorio (1280×720) y **0,086** en móvil (390×844), frente a ~0,33/~0,67 antes del placeholder y la reserva de filas. El resultado puede variar con red, caché y extensiones.

### Aún pendiente

- Validación de identidad del vídeo servido más allá del idioma: comparar título/alias/año/duración o metadatos del proveedor cuando estén disponibles, y registrar con mayor detalle por qué se acepta/descarta cada candidato.
- Preload literal del hero/LCP dinámico: no se añade porque la portada se decide después de consultar el catálogo y un `href` fijo podría descargar la película equivocada; se dejó preconnect, dimensiones, prioridad alta y reserva de layout.
- Auditoría visual completa de todas las rutas y estados autenticados, especialmente el panel `/admin`; home, ficha y login móvil ya tienen evidencia automatizada.
- E2E final de reproducción prolongada con varios servidores, idioma inglés, una obra solo VidSrc, una obra con fallback y una obra sin subtítulos.
- Validar en navegador que el fallback local iniciado durante el presupuesto de VidSrc no reinicia el reproductor cuando la resolución tardía queda disponible en caché; el gateway ya no bloquea la primera interacción, pero la promoción visual de una fuente tardía debe probarse con una sesión real.
- Informe visual/E2E final y revisión de identidad por título/duración siguen pendientes; los cambios de esta revisión están publicados en `lastversion`.

## Prioridad P0 — integridad de reproducción

### 1. VidSrc/NXSHA debe respetar el idioma elegido

**Estado: aplicado.** La detección, el ranking y el filtro conservador ya están en producción local y cubiertos por pruebas; queda ampliar la observabilidad si aparecen nuevos formatos de etiqueta.

- Analizar las etiquetas de NXSHA (`[English]`, `[Korean]`, `Hindi`, `Multi-Lang`, etc.) antes de elegir el HLS.
- Pasar el idioma preferido del selector hasta `resolveVidSrcEmbed`/`resolveNxshaMultiLang`.
- Puntuar y ordenar candidatos: coincidencia exacta con el idioma solicitado primero; `Multi-Lang` después; idiomas no coincidentes solo como último recurso.
- Buscar más de un servidor/candidato cuando el primero tiene un idioma explícitamente incompatible. Mantener un límite y paralelismo razonable para no empeorar la latencia.
- No asignar `"en"` por defecto cuando no existe pista de audio. Si solo se conoce la etiqueta NXSHA, mostrar ese idioma real; si no se conoce, dejarlo indeterminado.
- Ampliar la normalización de idiomas para hindi y otros idiomas indios que pueden aparecer en VidSrc/subtítulos: `hi`, `ta`, `te`, `ml`, `bn`, `mr`, `pa`, `kn`, `gu`, `ur`, además de variantes de español/portugués y códigos alternativos.
- Exponer la etiqueta/idioma detectado en la fuente para que el selector no afirme “inglés” cuando el stream es coreano o indio.
- Añadir pruebas unitarias para el parseo de etiquetas, el ranking con preferencia `en`/`es` y el comportamiento sin pistas HLS.

### 2. Evitar contenido equivocado (caso `La isla olvidada`) — filtro de idioma aplicado; identidad completa pendiente

- El resolver ya no acepta una etiqueta de idioma explícitamente incompatible cuando se conoce el idioma original TMDB y no hay una pista doblada válida. En la prueba real de TMDB `1465063`, la fuente `[Korean]` dejó `sources: []` en vez de presentarse como inglés.
- Falta una validación de identidad independiente del idioma: título/alias/año de TMDB frente a metadatos disponibles del proveedor, nombre de archivo, duración y/o respuesta del reproductor.
- Si una fuente tiene señales claras de otra obra, no seleccionarla automáticamente; continuar con otro candidato/proveedor o mostrar que no hay fuente fiable.
- Nunca ocultar la incertidumbre: registrar por qué se descartó o aceptó cada candidato.
- La prueba de regresión para TMDB `1465063` ya está en `e2e/provider-identity-guards.spec.ts` y evita presentar como inglés una fuente etiquetada `[Korean]`.
- Validar también una obra coreana legítima para no romper títulos cuyo audio original no es inglés.

## Prioridad P0 — subtítulos

### 3. Evitar falsos positivos

**Estado: aplicado para el año/título que se observó.** `SubtitleCatProvider` rechaza años visibles incompatibles y hay pruebas de regresión; queda ampliar la cobertura HTML a más proveedores.

- Fortalecer `SubtitleCatProvider` para que una búsqueda con año no acepte páginas cuyo título/URL contiene otro año (caso observado: una entrada de `Fantasy Island 1977` para `La isla olvidada`).
- Mantener coincidencia por título/alias, pero exigir compatibilidad de año cuando el proveedor lo expone.
- Aplicar la comprobación tanto al resultado de búsqueda como a la página/fichero de subtítulos.
- Crear pruebas con HTML simulado: rechazar año conflictivo y aceptar título/año correcto.

### 4. Mejorar detección y cobertura

**Estado: parcial.** La normalización, orden por preferencia y fallback existentes se conservaron; falta medir sistemáticamente las obras que aún no tienen pista y añadir casos de integración de cada proveedor.

- Normalizar correctamente códigos y nombres de idiomas de VidSrc, OpenSubtitles, YIFY y SubtitleCat, incluidos idiomas indios y variantes regionales.
- Ordenar las pistas por los idiomas seleccionados por el usuario sin eliminar innecesariamente alternativas válidas.
- Mantener el fallback entre proveedores (`opensubtitles-v3`, `tvsubtitles`, `yify`, `subtitlecat`) y medir qué obras siguen sin pista.
- Revisar que cada URL pase por `SubtitleProxy` y por su lista de hosts permitidos; no introducir descargas directas inseguras.
- Añadir pruebas de integración para una obra con subtítulos VidSrc, una con fallback externo y una sin subtítulos.
- Mostrar un estado claro cuando no hay subtítulos, en vez de dejar un selector vacío o una pista incorrecta.

## Prioridad P1 — fallback y estabilidad del reproductor

### 5. No cambiar de servidor durante una reproducción sana

**Estado: mejorado.** El arranque ya no espera mirrors/embeds equivalentes una vez que existe un HLS compatible y LatAnime conserva los demás locators para JIT. Sigue pendiente la prueba prolongada con cortes de red reales.

- Auditar los eventos HLS `fatal`, `waiting`, `stalled`, `mediaError` y `networkError`.
- Separar errores recuperables de fallos reales: `HLSPlayerModal` intenta `recoverMediaError` una vez por intento antes de cambiar de servidor cuando procede.
- Conservar el intento de proxy como segunda oportunidad, pero no saltar de servidor por un evento transitorio.
- Mantener el watchdog de congelación de 20 s solo cuando el playhead no avanza de verdad; comprobar que no se dispara durante pausas, cambios de pestaña o buffering normal.
- Registrar en cada failover: servidor, URL, evento HLS, estado `readyState`, tiempo sin avance y destino elegido.
- Mostrar al usuario una razón breve y no perder posición cuando el cambio sea necesario.
- Probar una reproducción real con varios servidores durante varios minutos y simular errores de red/media para verificar que el cambio no ocurre sin causa.

## Prioridad P1 — búsqueda y selección de candidatos

### 6. Buscar por títulos TMDB e IMDb

**Estado: parcial aplicado.** La barra usa títulos TMDB en español/inglés, originales/localizados y aliases guardados (incluidos aliases importados de la era IMDb), fusiona por identidad y ordena por relevancia. Sigue pendiente una consulta directa a un índice de títulos IMDb, porque el proyecto no dispone actualmente de esa fuente y no se ha inventado una integración.

- Al buscar desde la barra, consultar/usar el título principal de TMDB, títulos alternativos/localizados y el título asociado al IMDb ID.
- Resolver el IMDb ID desde TMDB cuando sea posible y consultar sus aliases/títulos sin bloquear la primera respuesta.
- Unificar resultados duplicados por TMDB ID/IMDb ID.
- Puntuar candidatos por coincidencia exacta, prefijo, idioma del título, año, tipo (película/serie) y popularidad; mostrar primero los mejores candidatos.
- Mantener la respuesta rápida: debounce, caché de consultas recientes, límite de resultados y cancelación de solicitudes obsoletas.
- Añadir pruebas para títulos que difieren entre TMDB e IMDb, títulos traducidos y resultados ambiguos.

## Prioridad P1 — rendimiento sin quitar funciones

### 7. LCP y carga inicial

- Confirmar el elemento LCP real en una sesión limpia. El diagnóstico original observó `img.feature-image` descubierto después de ejecutar un chunk, con aproximadamente 516 ms de espera de descubrimiento dentro de un LCP total de ~733 ms; la medición automatizada actual confirma `fetchPriority=high` y descubrimiento de la imagen antes del resto de tarjetas.
- Preconstruir o inyectar de forma segura el preload de la imagen hero solo cuando se conozca el recurso correcto; no precargar una imagen dinámica equivocada. Sigue pendiente por esa condición dinámica.
- Renderizar cuanto antes la estructura y los metadatos críticos del hero, dejando interacciones no críticas para después.
- Mover la lectura síncrona de `localStorage` de `useHiddenGenres.tsx` fuera del camino crítico (efecto o inicialización diferida) sin provocar parpadeos ni perder preferencias.
- Dividir/cargar bajo demanda componentes no críticos (admin, modales pesados, reproductor y herramientas secundarias), verificando que las rutas profundas sigan funcionando.
- Medir con perfil limpio: extensiones como Letyshops y Urban VPN aportaron más de 200 ms y no deben confundirse con regresiones de la app.

### 8. Imágenes y consumo de red

- Auditar cada imagen con su tamaño de renderizado real.
- Usar `srcset`/`sizes` y elegir tamaños TMDB proporcionales (no descargar posters de 342 px cuando se muestran a ~97 px).
- Aplicar lazy loading y `decoding="async"` a imágenes fuera del viewport; mantener prioridad alta solo para el hero/LCP.
- Evaluar WebP/AVIF y calidad ajustada donde el CDN lo permita, verificando compatibilidad y legibilidad de posters/backdrops.
- Reservar dimensiones/aspect ratio para evitar CLS.
- Repetir la medición y confirmar el ahorro aproximado observado (~1,1 MB) sin degradación visual.

## Prioridad P1 — experiencia móvil y futura migración

### 9. Auditoría responsive y táctil

- Revisar home, búsqueda, ficha, reproductor, selector de servidores/subtítulos y `/admin` en anchos móviles y tablet.
- Corregir solapamientos, textos truncados, targets táctiles pequeños, scroll horizontal y modales que no respetan el área segura.
- Comprobar orientación vertical/horizontal, teclado virtual, safe areas, gestos y controles de vídeo accesibles.
- Reducir peso/animaciones en móvil respetando `prefers-reduced-motion` y conexiones lentas.
- Probar con emulación móvil y, si es posible, un dispositivo físico antes de cerrar la tarea.

## Prioridad P1 — auditoría completa de producto

### 10. Revisión UI/UX y `/admin`

- Inspeccionar todas las rutas reales, incluida `/admin`, con capturas de pantalla y lectura de código.
- Documentar problemas confirmados de jerarquía, espaciado, contraste, estados vacíos/error/carga, foco de teclado y accesibilidad.
- Mantener la identidad visual actual; unificar patrones y limpiar inconsistencias sin eliminar capacidades del usuario.
- Revisar permisos, estados de error y feedback de acciones en administración sin exponer secretos.
- Entregar un informe final priorizado con evidencia (ruta, captura, archivo/línea, impacto y solución aplicada).

## Verificación y cierre

- Añadir/regresar pruebas unitarias para VidSrc, subtítulos, búsqueda y rendimiento crítico.
- Ejecutar suite completa, lint, build y pruebas E2E en escritorio y móvil.
- Repetir pruebas reales con `La isla olvidada`, `Fight Club`, una obra solo VidSrc, una obra con fallback y una obra sin subtítulos.
- Revisar logs para confirmar que no hay failovers silenciosos ni pistas de idioma falsas.
- Comprobar `git diff`, eliminar artefactos temporales y dejar el worktree limpio con solo la última versión solicitada.
- No incluir `.env`, tokens, dumps ni capturas temporales en el commit.
- Actualizar este documento marcando cada punto completado y enlazando el informe final.
