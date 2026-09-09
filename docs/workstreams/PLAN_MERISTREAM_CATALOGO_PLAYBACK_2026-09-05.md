# Plan maestro de MeriStream: catálogo, metadatos y reproducción

**Fecha:** 5 de septiembre de 2026  
**Proyecto:** MeriStream  
**Objetivo:** dejar el catálogo restaurado desde la rama de GitHub, completo y verificable, con metadatos canónicos por TMDB, enlaces de episodios funcionales, reproducción estable y selección/multiplexación de servidores confiable.

## 1. Resultado que se busca

MeriStream se considerará terminado cuando:

1. Cada proveedor configurado haya recorrido su catálogo real completo (todas sus páginas, no solo una muestra).
2. Películas, series, doramas y anime estén normalizados como una sola entidad canónica, sin crear duplicados por título, idioma o proveedor.
3. Cada obra tenga, cuando TMDB lo permita, su `tmdbId`, título, poster, backdrop/banner, géneros y descripción en español.
4. Los episodios estén asociados a la obra correcta y con sus enlaces de fuente guardados.
5. Los enlaces de varias plataformas para la misma obra se conserven juntos para permitir multiplexación y cambio de servidor.
6. El reproductor pueda resolver una fuente válida, mostrar alternativas y cambiar de servidor aunque la primera fuente falle o llegue por resolución JIT.
7. Las pruebas de API, scraping, reproducción y UI terminen sin errores bloqueantes.
8. Se entregue un informe final con conteos, pendientes explicados y evidencia reproducible.

## 2. Proveedores dentro del alcance

Se deben conservar y verificar los proveedores solicitados:

- Doramasflix (películas, doramas y variedades).
- HiAnimes.
- LaMovie (películas, series y anime).
- Cinecalidad.
- TubePelis.
- TioPlus (películas y series).
- AnimeFLV (`animeflv.or.at`) con respaldo compatible de JKAnime.
- LatAnime.
- TioAnime.
- VerAnimes.
- GNULA HD (películas, series y anime; `ww3.gnulahd.nu`).

Los nombres de dominio y las URLs concretas se mantienen en la configuración del proyecto; no se deben copiar credenciales ni URLs firmadas en informes públicos.

## 3. Estado comprobado hasta ahora

### Verificación del catálogo

- La verificación integral sigue ejecutándose en la fase `catalog`.
- Último registro conocido: **67.792 de 67.808**, con **0 errores**. El total puede crecer porque durante el recorrido se descubren nuevos elementos.
- Hay 29 tareas `full_catalog` completadas, 4 tareas antiguas canceladas por rutas obsoletas y 6 tareas `source_recovery` completadas. No hay filas actuales con estado `failed`.
- Las cuatro cancelaciones corresponden a rutas históricas reemplazadas por las rutas vigentes; no representan un fallo del catálogo actual.

El conteo de cada proveedor y el porcentaje final no se deben declarar definitivos hasta que termine esta ejecución y se genere la auditoría posterior.

### Cobertura histórica de referencia

La auditoría anterior (antes de la reparación final) registró 38.369 obras, 175.363 episodios, 72.148 episodios con más de un sitio y 16.702 episodios sin enlaces. Es una línea base útil, no el resultado final: la verificación actual puede aumentar esos totales.

### Reproducción y multiplexación

La matriz de plataformas ejecutó 12 proveedores distintos y 6 obras con enlaces multiplexados:

- **18/18** respuestas de la API HTTP 200.
- Mediana de respuesta **24 ms**, promedio **66,9 ms**, P95 **215 ms**.
- No faltó ningún proveedor solicitado en la muestra.
- Las obras multiplexadas mostraron entre 9 y 14 sitios almacenados por obra y entre 5 y 8 candidatos rankeados.

Esta matriz valida el resolver, el ranking y la agregación de enlaces almacenados. No sustituye una prueba visual de cada video incrustado ni garantiza que un proveedor externo no cambie después.

### Calidad de código y pruebas

- Suite Vitest: **626/626 pruebas correctas**.
- `npm run lint`: correcto.
- `npm run build`: correcto.
- Pruebas en vivo previas: TubePelis y VerAnimes resolvieron sus muestras; Cinecalidad JIT respondió y devolvió streams.
- El fallback de AnimeFLV a JKAnime está implementado.
- El reproductor conserva los `ranked_streams` de resolución JIT y mezcla alternativas para que “Cambiar servidor” no desaparezca.
- El detector de idioma evita tratar “Sub Español” como doblaje y el motor de metadatos evita mostrar descripciones extranjeras como si fueran españolas.

## 4. Fases pendientes y orden de ejecución

### Fase A — Dejar terminar la verificación integral

1. Mantener activa la ejecución actual sin reiniciar el API.
2. Usar el temporizador real de 5 minutos entre consultas de progreso.
3. Esperar a que el proceso auxiliar detecte `idle` y genere su marcador de finalización.
4. No interpretar un `100/100` intermedio como resultado final si el total sigue creciendo.

### Fase B — Recuperación de fuentes pendientes

1. Ejecutar el puente dirigido de enlaces históricos de TubePelis con cursor nuevo.
2. Auditar episodios sin enlaces y los que tienen una sola fuente.
3. Reintentar únicamente lo que esté pendiente o haya expirado, con backoff y límites por dominio.
4. Mantener todos los sitios válidos para la misma obra/episodio; no reemplazar un enlace bueno por uno único.

### Fase C — Reiniciar el servidor con el build corregido

1. Detener solamente el proceso exacto de `dist/server.cjs` cuando no haya trabajos activos.
2. Iniciar el build nuevo y esperar `/health`.
3. Ejecutar las pruebas E2E de búsqueda, apertura de obra, reproducción, segundo servidor y fallback de IDs canónicos.
4. Si la UI sigue mostrando datos viejos, confirmar que el navegador y el proceso API apuntan al mismo build antes de diagnosticar la base de datos.

### Fase D — Salud de fuentes y estabilidad

1. Ejecutar el audit de salud por proveedor con muestras pequeñas y límites conservadores.
2. Clasificar cada resultado como `ok`, temporal, bloqueado, sin stream o error de parser.
3. No marcar como fallido un proveedor por un timeout aislado; exigir reintento y evidencia repetida.
4. Medir latencia de API, resolución JIT y tiempo hasta el primer stream por separado.

### Fase E — Metadatos y normalización

1. Ejecutar la auditoría de idioma después de la verificación de catálogo.
2. Reparar obras sin `tmdbId` con búsqueda progresiva: título limpio, año, tipo y alias; registrar los casos ambiguos.
3. Mantener `tmdbId` como identificador canónico en portada, detalle, episodios y reproductor.
4. Traducir solo cuando la descripción no sea española; conservar un placeholder español si TMDB/traductores fallan.
5. Revisar duplicados y fusionar únicamente cuando título, año, tipo y evidencia de fuente coincidan.

### Fase E.1 — Consolidación de fichas legacy duplicadas

1. Detectar fichas que representan la misma obra entre `Show` legacy y `MediaItem` canónico, especialmente entradas de GNULA sin poster ni metadata.
2. Conservar episodios, URLs y `source` de la ficha legacy antes de consolidar; no eliminar una ficha si sus fuentes no están migradas.
3. Reutilizar la identidad TMDB/MAL/AniList únicamente cuando el tipo, título normalizado, año o evidencia de fuente coincidan de forma suficiente.
4. Evitar que la proyección pública muestre una ficha enriquecida junto a otra tarjeta vacía de la misma obra.
5. Registrar por separado los casos ambiguos, los packs/especiales y los eventos que no tienen una identidad externa única.
6. Añadir una auditoría por proveedor para distinguir duplicado, ficha sin metadata, ficha sin fuente y obra realmente nueva.

### Fase F — Auditoría final de cobertura

1. Generar el informe de cobertura por proveedor, tipo de contenido, páginas recorridas, obras, episodios y enlaces.
2. Separar claramente `sin enlaces`, `sin TMDB`, `sin poster`, `sin backdrop` y `sin stream resoluble`.
3. Comparar contra la línea base y explicar cada disminución o aumento.
4. Confirmar que no queden tareas activas, fallidas inexplicadas ni marcadores auxiliares antiguos.
5. Revisar manualmente las entradas sin identidad externa y separar las que sí pueden heredar una identidad de legacy de las que requieren una búsqueda específica.

### Fase G — Cierre

1. Ejecutar Vitest, lint, build, pruebas E2E y matriz de reproducción/multiplexación.
2. Guardar los informes JSON y Markdown con fecha.
3. Restaurar la configuración normal (`sync_known_episodes=true` y límites operativos).
4. Detener/eliminar el temporizador auxiliar una vez generado el informe final.
5. Entregar un resumen final con métricas, advertencias reales y comandos para reproducir las auditorías.

## 5. Paralelismo y límites seguros

- El worker de catálogo usa paginación automática y concurrencia adaptativa de elementos (8 a 12 según presión); no se debe aumentar sin medir errores, memoria y bloqueos por dominio.
- Las pruebas independientes (auditoría, E2E y matriz) se ejecutan después de la verificación o contra una copia/endpoint de lectura para no competir con ella.
- Las solicitudes a TMDB deben respetar el límite efectivo, usar caché, deduplicación, reintentos con backoff y no repetir búsquedas ya resueltas.
- La concurrencia por proveedor debe ser menor que la concurrencia total para evitar bloqueos y falsos `failed`.
- La base PostgreSQL corre en el contenedor `voidstream-pg`, publicado en el puerto local configurado; no es necesario apagar bases de otros proyectos si usan otro contenedor/puerto.

## 6. Temporizador y política de revisión

El proceso `tools/post-idle-final-verification.ps1` actúa como supervisor:

1. Consulta el estado cada **5 minutos**.
2. Mientras el estado no cambie, no hace trabajo adicional ni envía nuevas solicitudes de progreso.
3. Tras `idle`, encadena recuperación, reinicio controlado, E2E, salud de fuentes, auditoría de idiomas y pruebas finales.
4. Cuando termina, escribe el marcador `data/post-idle-final-verification.done.json`; entonces se debe retirar el temporizador y no seguir despertándolo.

## 7. Criterios de aceptación finales

- [ ] Todas las tareas vigentes están `completed` o tienen una explicación documentada.
- [ ] No hay `failed` sin clasificar.
- [ ] Todas las rutas de catálogo vigentes recorrieron sus páginas hasta el final real.
- [ ] La auditoría de cobertura final está generada y enlazada.
- [ ] Las obras con varias fuentes conservan y exponen alternativas.
- [ ] El botón “Cambiar servidor” funciona tras carga normal y tras resolución JIT.
- [ ] La prueba de fallback canónico funciona con la API recién reiniciada.
- [ ] Los metadatos visibles usan `tmdbId` y descripción en español o placeholder explícito.
- [ ] Salud de fuentes, E2E, Vitest, lint y build están documentados.
- [ ] El temporizador auxiliar fue detenido al finalizar.

## 8. Cómo consultar el estado sin depender del panel

Desde `E:\Meristream` se pueden revisar de forma segura:

```powershell
# Proceso auxiliar y antigüedad del último registro (no consulta la API)
$p = Get-Process -Id 29812 -ErrorAction SilentlyContinue
if ($p) { "HELPER_ALIVE=1 PID=$($p.Id)" } else { "HELPER_ALIVE=0" }
Get-Item logs/post-idle-final-verification.launch.out.log |
  Select-Object LastWriteTime, Length

# Marcador de finalización
Test-Path data/post-idle-final-verification.done.json

# Estado del contenedor PostgreSQL
docker exec voidstream-pg pg_isready -U voidstream -d voidstream
```

Para consultar detalles de tareas o auditorías se deben usar los informes generados en `docs/workstreams/` y no copiar contraseñas desde `.env` o desde la línea de comandos de procesos.

## 9. Archivos y evidencias principales

- `tools/post-idle-final-verification.ps1` — supervisor con temporizador de 5 minutos.
- `tools/playback-platform-matrix.ts` — matriz de plataformas y multiplexación.
- `docs/workstreams/playback-platform-matrix-2026-09-05.md` — lectura humana de la matriz.
- `docs/workstreams/playback-platform-matrix-2026-09-05.json` — resultados estructurados.
- `tools/catalog_coverage_audit.ts` — auditoría de cobertura.
- `tools/metadata-language-audit.ts` — auditoría de idioma y metadatos.
- `tools/backfill-legacy-source-links.ts` — recuperación dirigida de fuentes históricas.
- `docs/workstreams/PROGRESO_EJECUCION_2026-09-03.md` — bitácora acumulada.

**Próximo paso automático:** dejar que concluya la verificación integral y, al siguiente ciclo de 5 minutos, continuar con la cadena de recuperación y validación indicada arriba.
