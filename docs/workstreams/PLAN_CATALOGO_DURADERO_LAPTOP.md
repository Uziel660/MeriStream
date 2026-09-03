# Plan de catálogo recuperable y reproducción verificable — laptop

Estado: ejecución activa. Ya se aplicaron el contrato inicial de evidencia, la deduplicación/fusión de páginas y la conservación de fuentes del reescaneo. La reimportación completa no-TubePelis está encolada y se procesa de forma reanudable con dos tareas como máximo.

## 1. Resultado buscado y límites reales

Reconstruir y mantener las fuentes de películas, series y anime, incluidos sus episodios, de todos los proveedores configurados y descubiertos en el catálogo. TioPlus está incluido; TubePelis queda excluido por indicación del usuario. La laptop es el entorno de trabajo: no se aplican los límites del ASUS a esta pasada.

Lo permanente será la identidad de la obra, su página original, sus referencias de reproductores y el procedimiento probado para obtener una reproducción nueva. El manifiesto firmado será una resolución temporal, nunca la única identidad de la fuente.

No es posible garantizar que un archivo ajeno nunca desaparezca, que un proveedor no cambie ni que todos permitan extraer video fuera de su iframe. El objetivo verificable es procesar todo el alcance y convertir cada fuente posible a un formato que reproduzca nuestro reproductor. No renombrar una página o un embed como éxito: si no se puede convertir, queda visible como pendiente/error y no entra en la selección automática.

## 2. Hallazgos que condicionan el orden

Lectura directa de los archivos del repositorio. Codebase Memory no respondió: dos intentos y comprobación de cobertura devolvieron Transport closed. Por tanto, estos hallazgos no constituyen una auditoría exhaustiva del grafo ni una prueba en vivo de todos los sitios.

La primera medición real del estado actual quedó en `catalog_coverage_audit_*.md` y la prueba de adaptadores en `catalog_adapter_audit_*.md`. En la base hay 21.175 obras, 84.037 episodios multi-fuente, 68.812 episodios sin ningún SourceLink y solo 881 con más de un proveedor. Esto confirma que el problema no es únicamente el reproductor: una gran parte del catálogo son episodios metadata-only o proceden de importaciones que todavía no atravesaron la fusión. Hay 22 grupos de MediaItem potencialmente duplicados por la misma clave normalizada/tipo/año; los ejemplos observados están mayoritariamente sin enlaces, así que deben reconciliarse con evidencia antes de fusionarlos automáticamente.

La auditoría en vivo, de una muestra por preset y sin TubePelis, encontró catálogos que responden (LaMovie, TioPlus, Cinecalidad, LatAnime, TioAnime, VerAnimes y Doramasflix), un fallo de acceso en AnimeFLV y presets que son fichas individuales y devuelven cero tarjetas (TVMaze/Archive). En las muestras hubo directos y embeds en LaMovie, Cinecalidad, TioPlus, LatAnime, TioAnime y VerAnimes; Doramasflix devolvió páginas de capítulo sin media en esa pasada. El script no declara reproducción: separa HTML, embed y media para no ocultar estos fallos.

- server/sourceRecoveryWorker.ts agrupa recuperación por episodio, conserva el localizador canónico y deja `is_verified=false` hasta tener media comprobada. Eso no demuestra por sí solo reproducción ni recupera todos los proveedores originales. Si sus candidatos existentes fallan, la búsqueda nueva solo se activa cuando la lista inicial estaba vacía. La selección de episodios necesita preservar temporada, no solo número.
- server/taskWorker.ts ya ofrece enqueueFullCatalogSweep y controles de concurrencia. Se reutilizará ese descubrimiento, evitando crear otro crawler independiente. Su cola JSON y la recuperación de trabajos deben evolucionar para checkpoints por elemento y reinicio fiable; no usar colas finalizadas como inventario permanente.
- server/verificationWorker.ts declara fases de metadatos, catálogo y normalización. Esas fases no equivalen a decodificación de video en el reproductor.
- prisma/schema.prisma ya contiene MediaItem, MediaEpisode con temporada y episodio, y SourceLink por episodio/sitio/URL. is_verified y last_checked no distinguen descubrimiento, resolución, video y renovación.
- LaMovieAdapter ya consulta APIs de catálogo y reproductor. Primero se diagnosticará esa ruta existente. extractStream reduce resoluciones a URLs, perdiendo el vínculo estructurado con el embed y sus metadatos. También puede generar direcciones de episodios a partir de conteos de TMDB: deben quedar como candidatas hasta comprobar existencia e identidad, no como episodios disponibles.
- server/platformPageResolvers.ts recibe listas planas, elige un candidato por heurística y puede reconstruir cabeceras por el dominio de la URL final. Es necesario transportar el contexto original de extracción, no inferirlo solamente desde una CDN.
- Las pruebas unitarias y las páginas guardadas no prueban estabilidad universal. Las observaciones anteriores de un video en el minuto 29 o 31, con reanudaciones, no acreditan esa cantidad de minutos continuos ni una renovación real del token.

## 3. Arquitectura mínima: tres responsabilidades separadas

### Regla de mantenibilidad

La reestructuración está autorizada, pero no se resolverá con un archivo monolítico ni con un segundo framework. El contrato de fuentes, la cola, la extracción por proveedor, la comprobación de media y la selección del reproductor serán módulos independientes. Como guía, cada archivo nuevo debe mantenerse alrededor de 150–400 líneas; si supera 500, se divide por responsabilidad antes de integrarlo. Una excepción de un adaptador ya existente debe justificarse por su tamaño actual, no copiarse a los demás.

Cada módulo tendrá una interfaz estrecha, pruebas junto al código y un registro de errores tipado. Los adaptadores compartirán utilidades HTTP, normalización y resolución profunda; no duplicarán lógica de TTL, proxy, matching o persistencia. La migración de datos será incremental y reversible. No se añadirá código de navegador al endpoint de reproducción, ni un crawler diferente por cada proveedor.

| Responsabilidad | Trabajo | Qué persiste |
| --- | --- | --- |
| Descubrimiento y extracción en laptop | Inventariar sitios, fichas, temporadas, episodios y reproductores; validar identidad y repetibilidad | Páginas originales, IDs del proveedor, cadena de fuentes, versión del adaptador y resultados |
| Resolución al reproducir | Recuperar la mejor referencia ya conocida y conseguir una URL vigente; volver a la ficha solo si es necesario | Caché temporal acotada, contexto de entrega y sesión |
| Reproducción y observación | HLS/MP4 en nuestro reproductor; medir primer cuadro, buffer, cortes y renovación | Resultado breve correlacionado, no video ni logs ilimitados |

Reutilizar PostgreSQL y los workers actuales. No añadir Redis, Kubernetes, servicios de pago ni una segunda plataforma de colas sin una necesidad medida.

Guardar una cadena como obra/episodio → ficha original → ID/embed del host → media extraída → resolución temporal. El embed es solo una pista de extracción; nunca es el resultado final ni un fallback de reproducción. Conservar varios hosts cuando existan. Dos sitios que apuntan al mismo archivo del mismo host no cuentan como dos respaldos independientes.

Una receta es código del adaptador versionado con IDs y contexto necesarios; no un script arbitrario recibido del proveedor que después se ejecute en el servidor. Si la extracción exige navegador cada vez, registrarlo como tal: una importación más lenta no elimina mágicamente ese costo futuro.

## 4. Fase 0 — inventario, respaldo y denominadores

1. Crear respaldo consistente de PostgreSQL y verificar restauración en base separada. Mantener historial, favoritos, progreso, IDs y todos los SourceLinks antiguos; no subir secretos ni tokens a los reportes.
2. Inventariar proveedores desde adaptadores, configuración, catálogo moderno, catálogo legacy y colas existentes. Normalizar aliases de dominio sin confundir sitio de catálogo con host de video.
3. Contar obras, episodios y parejas episodio/proveedor: sin fuente, página guardada, embed, directo estable, firmado vencido, resolución comprobada y reproducción comprobada. Publicar por separado cobertura de una obra y cobertura de sus proveedores originales.
4. Sembrar el descubrimiento desde URLs e IDs conocidos y usar APIs/sitemaps/paginación donde existan. Aprovechar metadatos válidos para no pedir otra vez posters y TMDB por cada fuente.
5. Recorrer también los listados actuales de los proveedores: encontrar las fuentes que faltan y los títulos nuevos. Mantener los nuevos en preparación hasta superar los criterios de publicación. Un fallo HTTP no equivale a fin de paginación ni a desaparición de una obra.

Salida: manifiesto del alcance con contadores y exclusiones. Los informes antiguos limitados a tres dominios no representan todo el catálogo.

## 5. Fase 1 — contrato de fuentes y adaptadores, antes del barrido masivo

Extender de forma compatible los modelos existentes; no reemplazar la base completa.

- SourceLink conserva página original, sitio, host, ID externo cuando exista, tipo real de fuente, idioma/versión, relación con la ficha o embed padre y versión de extracción. No borrar parámetros que formen parte de la identidad legítima de una página.
- Añadir observaciones separadas: discovered, identity_matched, extracted, media_checked, player_verified y refresh_checked. Son evidencias con fecha/contexto, no un único booleano ni necesariamente una secuencia que borre la evidencia anterior.
- Registrar last_success, last_failure, razón tipada, retry_at y método de entrega comprobado. Un 403 aislado no prueba que el archivo esté muerto ni que su token venció; distinguir permisos/contexto, bloqueo, caducidad y error de extracción.
- El resultado de resolver transporta el localizador renovable, URL temporal, expiración conocida o desconocida, cabeceras permitidas, identidad de sesión, generación y proveedor/host. Validar entradas ausentes sin llamar trim sobre undefined.
- Las cookies y credenciales necesarias permanecen restringidas al backend. No reenviar cabeceras sensibles a cualquier dominio de una redirección; validar destinos y recursos del proxy para evitar SSRF.
- Distinguir página de catálogo, ficha, embed y media. Un embed descubierto queda en embed_discovered hasta que un resolutor obtenga HLS/MP4 (o el formato nativo que admitamos) y pase la prueba del reproductor. No utilizar delivery_mode=embed para declarar reproducible una ficha o un iframe no resuelto.
- Match por ID fiable + tipo de obra; fallback por título/año con evidencia adicional. Series y anime requieren temporada, episodio, especiales y numeración absoluta explícitos. Coincidencias ambiguas van a revisión, no se unen por substring ni por el primer resultado de búsqueda.
- Unificar ingreso por workers, importación legacy y herramientas: todos deben pasar por el mismo contrato; ningún escritor conserva is_verified=true como sinónimo de página insertada.

Hacer un piloto diverso de 10–20 fuentes por proveedor y por plantilla significativa: películas, episodios de temporadas distintas, anime, varios hosts y casos fallidos conocidos. Este piloto valida el adaptador, no el resto del catálogo. Reutilizar APIs/HTML primero. Para cada embed, intentar en orden: URL en atributos/JSON, scripts y APIs del proveedor, desofuscación controlada y, como último recurso de extracción en la laptop, un navegador aislado que observe las solicitudes de red del reproductor. El navegador se usa para descubrir el manifiesto, no para reproducirlo en producción. Bloqueos, CAPTCHA, DRM o autenticación no disponibles se reportan como no convertibles, no se eluden.

La resolución profunda tendrá límites explícitos: profundidad máxima de redirección/iframe, lista de dominios permitidos, tiempo, bytes y número de solicitudes. Cada URL descubierta se clasifica y se vuelve a procesar hasta encontrar media; las páginas que solo devuelven HTML, un reproductor DRM o un token sin origen renovable no pasan a player_verified. El adaptador debe guardar qué paso produjo el resultado para poder repetirlo después.

Salida obligatoria: desde una ficha conocida se obtiene media o un diagnóstico exacto, conservando la cadena. Si una plantilla de LaMovie u otro sitio falla, se corrige antes de multiplicar el mismo fallo por miles de fichas.

### Ejecución aplicada (2026-09-03)

- Doramasflix dejó de depender de HTML repetido: el adaptador usa su endpoint GraphQL oficial para `/doramas`, `/peliculas` y `/variedades`, respeta `page`, conserva 24 elementos por página y mantiene el HTML como fallback. La auditoría de dos páginas entregó 48/48 elementos únicos en las tres rutas.
- `GET /api/v1/play/:episode_id` ya no devuelve una respuesta aparentemente correcta con `stream_url` vacío cuando un `MediaEpisode` histórico carece de SourceLinks. Busca la obra/episodio legacy y ejecuta la resolución JIT; si tampoco hay localizador, responde un diagnóstico 404 explícito.
- El worker de catálogo ya no convierte una página `/browse`, `/peliculas` o similar que falló en una obra ficticia. Las tareas de catálogo sin tarjetas se marcan fallidas sin escribir registros.
- Se lanzó la cola completa de todos los presets activos excepto TubePelis (TioPlus incluido): 13 tareas `full_catalog`, con máximo 2 tareas simultáneas y 800 ms de separación por solicitud. El proceso continúa en segundo plano y se puede reanudar desde `CrawlTask`.
- Se retiró el único registro ficticio creado por la ejecución anterior de AnimeFLV antes de endurecer el worker. AnimeFLV sigue bloqueado externamente con HTTP 521 y quedará como tarea fallida, no como contenido inventado.
- La ampliación solicitada de HiAnimes y FMHY queda deliberadamente para la fase final. La auditoría preliminar y los criterios de entrada están en `FUENTES_PENDIENTES_FMHY_HIANIMES.md`; no se agregan sitios por un HTTP 200 aislado ni se mezcla una fuente de descargas/TV en vivo con los episodios reproducibles.

La reimportación puede tardar horas y no implica que un proveedor externo mantenga disponibilidad. Lo que queda persistente es la obra, la relación episodio/fuente y el método repetible; la URL firmada se obtiene al reproducir.

### Completitud de catálogo y fusión de obras

Esta comprobación es independiente de la reproducción. Para cada adaptador se
probará que una página de catálogo devuelve todos sus elementos distintos, que
la paginación no repite ni salta páginas y que cada ficha conserva tipo, título,
año, URL y origen. El fin de catálogo solo se acepta por página vacía o cursor
oficial agotado; una respuesta 200 con HTML de bloqueo o una página repetida se
marca como error/reintento, no como catálogo terminado.

La fusión se comprobará en una matriz obra × proveedor × temporada × episodio.
Al importar el segundo proveedor, el registro de la obra y el episodio existente
debe conservarse y añadirse su SourceLink, sin reemplazar la primera fuente ni
crear un duplicado por diferencias de idioma, slug o alias de dominio. Cada
episodio llevará todas las fuentes entregadas por el análisis; ninguna capa de
“reescaneo ligero” podrá reducir un episodio a su URL primaria. La clave de
episodio siempre incluye temporada y número; para anime se registra también la
numeración absoluta cuando el adaptador la entregue.

Se harán pruebas de propiedades con catálogos sintéticos: N proveedores para
la misma obra, dos temporadas con el mismo número, URLs repetidas, títulos con
acentos/año y páginas fuera de orden. Se verificará que el resultado sea
idempotente y que un proveedor que aporta 100 fichas no termine representado
por 2 solo porque otra fuente ya creó la obra. Los contadores del worker
separarán fichas descubiertas, obras nuevas, obras fusionadas, episodios nuevos,
SourceLinks añadidos y fichas ambiguas.

## 6. Fase 2 — cola reanudable y paralelismo útil

Añadir trabajo por elemento en PostgreSQL en vez de reescribir toda una cola JSON por cada avance. Clave idempotente por ejecución/etapa/entidad/proveedor. Campos mínimos: estado, intentos, próximo intento, propietario, vencimiento de reserva, heartbeat y resultado.

Garantías: reclamar atómicamente; guardar resultado antes de marcar terminado; recuperar reservas vencidas; reejecutar sin duplicar; pausar/reanudar tras cierre del proceso. Aplicar también a los estados recovery_running, no solo al crawler normal. Un timeout debe cancelar la petición real y liberar su cupo, no limitarse a ganar un Promise.race.

Perfil inicial de laptop, ajustable después del piloto:

- Hasta 8 peticiones HTTP concurrentes globales, inicialmente 1–2 por dominio; subir hasta 16 globales solo si latencia y errores no empeoran. Estos cupos se comparten entre jobs, páginas, elementos y resolutores, incluidos hosts/CDN.
- Pool separado de 1–2 navegadores de validación, ampliable solo si ancho de banda y decodificación no distorsionan las pruebas.
- Presupuesto de bytes, duración y peticiones por fuente; reintentos con espera creciente y dispersión. Respetar Retry-After y reducir carga por proveedor ante 429/503.
- Prioridad para una reproducción solicitada por el usuario frente a crawling y verificaciones. Evitar que el barrido haga lenta la app aun en una laptop potente.
- Revisar el perfil de arranque actual limitado a 384 MB; crear un perfil de laptop medido, sin un límite arbitrariamente pequeño ni memoria ilimitada.

Reutilizar la paginación y adaptadores existentes, manteniendo un registro persistente de páginas visitadas, IDs, fingerprints y cursores. No asumir que un sitemap enumera todos los episodios: comprobarlo por proveedor.

## 7. Fase 3 — reescaneo completo, sin detenerse en el primer respaldo

Para cada obra y episodio del alcance, reconstruir todas sus fuentes encontradas en cada proveedor pertinente. Cada embed se somete a resolución profunda; si una alternativa falla, intentar las demás y después redescubrir desde el listado/búsqueda del proveedor. Una recuperación cruzada mejora la cobertura de la obra, pero no marca recuperado al proveedor original. Solo una media extraída y comprobada en nuestro reproductor marca la fuente como recuperada.

No inventar disponibilidad: una URL de episodio calculada, una extensión mp4 o un nombre de host conocido no son comprobaciones. Detectar soft-404, HTML de errores, páginas equivocadas y contenido de otra temporada. Registrar desconocidos para ampliar adaptadores sin declararlos automáticamente jugables.

Mantener el último resultado bueno mientras se verifica la nueva generación. Publicar por lotes pequeños mediante upserts y transacciones; no vaciar el catálogo ni alterar progreso del usuario. Conservar fuentes retiradas como histórico fuera de la selección automática.

Repetir la importación del mismo lote debe actualizar observaciones sin duplicar obras, episodios, idiomas ni fuentes. Un segundo recorrido de reconciliación identifica páginas saltadas, temporadas incompletas y tareas fallidas, en lugar de declarar éxito porque se vació una cola.

## 8. Fase 4 — comprobar extracción repetible y reproducción real

### Comprobación de todas las fuentes candidatas

1. Resolver desde su identidad persistente, nunca desde una CDN firmada histórica. Si la identidad es un embed, ejecutar la cadena de resolución profunda y conservar el paso que generó la media.
2. Para HLS: analizar manifiesto maestro y una variante seleccionada; comprobar manifiesto de media, recurso de inicialización y clave si aplican, y segmentos reales acotados. Para MP4: respuesta y bytes compatibles, Range cuando corresponda. Rechazar HTML con status 200. Comprobar con el mismo contexto y recorrido directo/proxy que usará el reproductor.
3. Volver a resolver sin reutilizar la caché local de resolución, en otra pasada, y comprobar media otra vez. La URL puede ser idéntica si sigue vigente; eso no es un fallo. Dos resoluciones inmediatas no acreditan renovación después del TTL.
4. Ejecutar prueba corta en nuestra UI para cada media extraída: forzar el candidato para que un fallback no oculte que falló, observar cuadros y progreso durante al menos 15–30 segundos tras el inicio. Registrar los intentos fallidos también. Se puede reutilizar un resultado si varias referencias identifican exactamente el mismo recurso y contexto; reportar esa deduplicación.

No afirmar que todas las calidades/idiomas están probados cuando solo se probó uno. Registrar combinaciones comprobadas y ampliar las pruebas de pistas anunciadas. Descargar un fragmento tampoco certifica que una película entera esté intacta.

### Pruebas profundas por combinación relevante de resolver/host/entrega

- Película larga, episodios, cambio de calidad/audio, seek adelante/atrás, pausa/reanudación y fallo recuperable de red.
- Sesión continua con tiempo de pared medido, sin cambios de código ni recargas durante la prueba. Probar desde antes hasta después de una caducidad real cuando sea posible; complementarlo con pruebas controladas de reloj, 403 y refresh, etiquetadas como simuladas.
- Probar manifiestos largos y varias pistas: elevar un límite de recursos del proxy a 2000 no demuestra que todos los segmentos futuros sobrevivan. Comprobar estabilidad y caducidad de los identificadores de recursos con políticas acotadas que no invaliden prematuramente recursos de una sesión activa.
- Muestras visuales al inicio, después de renovar y ante errores. Las capturas ayudan, pero una pantalla negra aislada puede ser contenido: combinar con cuadros presentados, dimensiones, avance y errores. Evitar descargar películas enteras como método rutinario.

### Evidencia del reproductor

Correlacionar run_id, source_id, attempt_id, generation y sesión. Medir clic→primer cuadro, método real de entrega, progreso de cuadros, buffer que contiene el playhead, cortes y duración, cambios de servidor, renovación y errores frontend/backend.

Usar requestVideoFrameCallback cuando esté disponible para observar cuadros enviados al compositor; no deducir video visible únicamente de play o currentTime. Complementar con screenshots y fallback compatible, sin procesamiento pesado de imagen. Referencia: [MDN — requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).

Métricas agregadas y eventos de transición; no enviar cada frame al backend. Excluir pausas, seeks y condiciones de pestaña en segundo plano del cálculo comparable de interrupciones. Redactar URLs firmadas, cookies y secretos en logs.

## 9. Fase 5 — reproducción rápida, JIT y continuidad

GET /play sigue siendo lectura rápida de DB/caché: no recorre todos los sitios. Selecciona una fuente con media extraída y comprobada, y su JIT usa el ID/embed ya conocido para obtener una URL vigente; vuelve a la ficha solo si cambió o desapareció. Resoluciones simultáneas de la misma fuente/contexto comparten trabajo. Un embed no convertido no se ofrece al reproductor como si fuera reproducible.

La caché de resolución incluye localizador, versión de adaptador, idioma/calidad si cambian el resultado y contexto relevante de entrega: origen de red, sesión y cabeceras. No compartir tokens ligados a una IP entre extracción en laptop y reproducción desde otro servidor. Al cambiar de entorno se re-resuelve desde los localizadores.

TTL conocido: renovar con margen adaptado al tiempo observado de resolución, duración de segmentos y reloj. TTL desconocido: política conservadora por host y recuperación ante rechazo, sin inventar expiraciones. Renovar solo sesiones activas o fuentes solicitadas, no todos los manifiestos del catálogo continuamente.

Antes de adjuntar una renovación, verificar que pertenece al intento actual. Preparar la nueva resolución y conservar posición/pistas; mantener el buffer útil cuando sea viable. Una renovación no debe iniciar dos reproductores ni dejar timers antiguos capaces de cambiar de servidor.

Clasificar elegibilidad y salud antes de aplicar cuotas por sitio/globales: no perder una buena alternativa por recortar la lista demasiado pronto. Priorizar reproducción nativa comprobada y rendimiento reciente por host/contexto, respetando selección manual; no priorizar todos los embeds sobre un directo estable sano solo por ser canónicos.

Direct-first cuando sea viable; proxy inmediatamente si sabemos que hacen falta cabeceras o CORS incompatible. No pagar un watchdog directo condenado en cada arranque. Un 403 de upstream requiere diagnóstico/renovación de contexto, no más capas de proxy.

Recuperar el mismo candidato antes del failover y cambiar solo ante fallo atribuible al intento activo. Error visual, retries, clave de attachment y estado de HLS deben compartir el ciclo de vida del intento; no resolver el aviso falso simplemente ocultando todos los errores mientras currentTime sea mayor que cero.

Ajustar ABR/buffer después de medir. No exigir varios minutos de buffer antes de mostrar el primer cuadro ni asumir que más buffer siempre arregla cortes. HLS.js combina objetivos temporales y límites de bytes; probar con la versión instalada. Referencia: [HLS.js — API y configuración de buffer](https://github.com/video-dev/hls.js/blob/master/docs/API.md).

## 10. Mantenimiento posterior sin reimportaciones destructivas

- Nuevos títulos y episodios: descubrimiento incremental, luego el mismo contrato de admisión, resolución y prueba. Ninguna vía rápida debe saltarse la validación.
- Actualizaciones del proveedor: revisar fingerprints/IDs y reextraer las fichas cambiadas; actualizar todas las fuentes afectadas por una versión de adaptador corregida.
- Fallo al reproducir: registrar, re-resolver o refrescar referencias; encolar reparación del origen y elegir otra media comprobada si hace falta. Si solo queda un embed, volver a ejecutar la extracción profunda antes de informar que no hay fuente. No poner un barrido de catálogo dentro de GET /play.
- Salud de fuentes con antigüedad: verificación gradual por prioridad/último uso y un barrido de reconciliación acotado. No descargar segmentos de todo el catálogo cada pocos minutos.
- Retirada: separar temporalmente no comprobable de ausencia confirmada. Solo marcar retirado tras evidencia repetida; conservar trazabilidad y no borrar la obra si otro proveedor la sirve.
- Procesos persistentes con progreso consultable. La ejecución real deberá instalar/iniciar explícitamente el proceso correspondiente; este plan no deja una tarea programada funcionando por sí solo.

## 11. Orden de implementación y criterios de salida

| Etapa | Reutilización/cambios principales | No avanzar sin |
| --- | --- | --- |
| 0. Inventario y respaldo | prisma/schema.prisma; herramientas de auditoría actuales | Alcance contado y restauración de prueba |
| 1. Contrato y piloto | SourceLink; adapters; resolvers; platformPageResolvers; ingreso legacy/moderno | Identidad correcta, cadena preservada, fallos tipados y muestras que reproducen |
| 2. Ejecución durable | taskWorker; sourceRecoveryWorker; herramientas de importación | Reinicio a mitad de lote sin pérdida/duplicados; cancelación y cupos compartidos |
| 3. Prueba real y JIT | playbackSessions; deliveryPlanner; HLSPlayerModal; pruebas e2e | Medición fiable, retry/failover coherentes, renovación y recursos largos probados |
| 4. Piloto integral | 100–300 fuentes diversas, o todas si hay menos | Dos pasadas, reporte de fallos, velocidad medida y publicación segura |
| 5. Barrido total | Reusar full_catalog con cola durable y validación | Cada elemento con resultado explícito; tareas pendientes/fallidas visibles |
| 6. Reconciliación y mantenimiento | Incremental por proveedor y observaciones | Informe por obra/episodio/proveedor/host, exclusiones y mecanismo de reparación |

Congelar primero el contrato compartido. Después pueden separarse trabajos de adaptadores/ingesta, workers/datos y reproductor/pruebas asignando archivos sin solapamiento. Integrar las pruebas de contrato antes del barrido; no desarrollar tres contratos distintos en paralelo. La revisión de cada etapa incluye tamaño, duplicación, dependencias y facilidad de rollback, además de las pruebas funcionales.

Criterios de aceptación:

- Todo elemento del alcance termina con estado y motivo; un estado fallido no se suma a recuperados. La disponibilidad de cada proveedor original se reporta por separado.
- Toda fuente anunciada como player_verified tiene media extraída, evidencia de nuestra UI y contexto/fecha. embed_discovered, embed-only, DRM no convertido y página canónica no satisfacen ese criterio ni entran en reproducción automática.
- Cada embed recuperable deja una receta repetible y un localizador renovable; los embeds no convertibles quedan contabilizados explícitamente como pendientes, nunca como enlaces funcionales.
- Las fuentes nuevas conservan un procedimiento de re-resolución probado o se etiquetan expresamente como estables no renovables/browser-only/no soportadas. No prometer renovación de un enlace sin origen.
- Reejecutar lotes y reiniciar procesos no duplica datos ni pierde tareas. Los datos del usuario sobreviven.
- Sin failover falso al reproducir, sin errores de una generación anterior sobre la actual y sin invalidación prematura de recursos del proxy.
- Pruebas de renovación y continuidad registran tiempo real y límites de cobertura. No se declara estabilidad de todos los proveedores a partir de una película.

Objetivos de rendimiento iniciales, sujetos al piloto en una red de referencia: p95 de clic a primer cuadro menor de 3 s con resolución caliente y menor de 8 s con JIT frío para fuentes HTTP nativas; interrupción no intencional menor de 1% en pruebas continuas. Son metas, no garantías ni criterios para borrar una fuente lenta. Medir navegador de extracción, proxy y distintos hosts por separado.

## 12. Duración y reporte honesto

No dar una hora de finalización antes de medir el piloto y contar el catálogo completo. Estimar por separado descubrimiento, detalle, resolución, bytes de comprobación y pruebas de navegador; domina la etapa más lenta, con restricciones por dominio y reintentos.

Ejemplo de escala, no estimación de este catálogo: 10.000 fuentes × 20 segundos de prueba de reproducción = 55,6 horas de navegador; con dos validaciones simultáneas son al menos 27,8 horas, sin contar arranque, fallos ni límites de red. Por eso conviene filtrar errores con HTTP primero, validar en UI por lotes y no prometer una certificación universal en unos minutos.

Mostrar avance por etapa/proveedor, fuentes admitidas, fallidas con motivo, pendientes, variantes comprobadas y ETA basada en velocidad reciente. Publicar los lotes buenos a medida que terminan sin esperar al último proveedor. Prioridad inicial: obras sin ninguna alternativa comprobada, luego recuperar diversidad de proveedores, luego ampliar catálogo y verificar combinaciones restantes; todas permanecen en el alcance final.

Entregables de la ejecución: migración reversible y snapshot previo, contrato y tests, módulos de fusión/deduplicación, auditorías reproducibles de adaptadores y cobertura, y guía de recuperación. Pendiente antes del barrido completo: cola de recuperación por elemento con checkpoint durable, corrección de plantillas que solo devuelven páginas, reconciliación de los 22 duplicados y una prueba de reproductor por muestra. El barrido total no debe iniciarse hasta que esos contadores se puedan observar y reanudar.

Regla de salida de ingeniería: si para soportar un proveedor se necesita un script aislado, cientos de excepciones de dominio o una nueva rama dentro del componente del reproductor, se detiene la integración y se rediseña el adaptador. El catálogo debe poder añadir o retirar proveedores sin convertir el backend en un archivo inmantenible.

## 10.1 Idiomas, audio y subtítulos (cambio de fuente sin corte visible)

- Guardar la pista de idioma en el contrato de la fuente (`link_type=sub|dub` y,
  cuando el proveedor la entrega, `audio_language`/`subtitle_language`). El
  enlace canónico sigue siendo la identidad; nunca se sustituye por el HLS
  firmado solo porque tenga una etiqueta de idioma.
- Detectar primero las pistas declaradas por el manifiesto HLS (`EXT-X-MEDIA`)
  y por el payload del proveedor. Si no hay declaración, usar únicamente una
  inferencia conservadora de la etiqueta (`sub`, `dub`, `latino`, `castellano`,
  `english`) y marcarla como inferida. No afirmar que el audio es español solo
  por el país del dominio.
- El frontend ofrece audio y subtítulos del manifiesto activo. Cuando el idioma
  existe en otra fuente, selecciona esa fuente en segundo plano, conserva el
  `currentTime`, espera `MANIFEST_PARSED`/`loadedmetadata` y restaura la pista;
  no arranca dos instancias de HLS.js ni reinicia el episodio desde cero.
- Las pistas WebVTT se resuelven y validan JIT junto a la fuente elegida. Se
  cachea solo la URL de subtítulos y su identidad durante la sesión; nunca se
  escanea el catálogo completo buscando subtítulos.
- Aceptación: probar una obra con audio español/inglés y otra con subtítulos
  español/inglés, alternar dos veces durante la reproducción y comprobar que el
  tiempo, la calidad y el estado de buffer sobreviven. Si una pista no existe,
  el selector debe decirlo explícitamente y mantener la reproducción actual.

## 10.2 Identidad TMDB y temporadas equivalentes

- Toda obra importada debe pasar por `enrichUniversalMetadata` o una identidad
  externa equivalente antes de entrar al grafo multi-fuente. `tmdb_id` es la
  clave preferida; título normalizado + año es el respaldo y queda marcado para
  revisión cuando hay ambigüedad.
- El backfill incluye explícitamente las filas con `tmdb_id` nulo, no solo las
  que carecen de póster o sinopsis. Se ejecuta por lotes reanudables y conserva
  los datos existentes si TMDB está temporalmente caído.
- Temporadas se fusionan por `(tmdb_id, kind, season_number, episode_number)`;
  una temporada igual de otra fuente añade SourceLinks al mismo episodio, no
  crea una nueva obra ni renumera episodios. Una secuela con TMDB distinto se
  mantiene separada aunque comparta título base.
- En cada pasada completa, las películas conocidas también se reanalizan una
  vez para recoger los enlaces del proveedor que las acaba de publicar; se
  conserva la temporada inferida del título/slug para series y anime.
- Antes de publicar una pasada completa, auditar: obras sin TMDB, grupos con el
  mismo TMDB dividido, episodios duplicados por temporada y SourceLinks de cada
  proveedor. El resultado debe incluir conteos y ejemplos reparados.
- El fallback por título normalizado queda limitado a la misma categoría; así
  un nombre coincidente no puede cruzar película/anime/serie sin evidencia de
  identidad TMDB.

## 10.3 Reducción segura de scripts

- No borrar scripts por tamaño. Primero generar un inventario de entradas,
  imports y última ejecución; clasificar cada uno como CLI vigente, prueba,
  migración histórica o duplicado.
- Consolidar solo utilidades sin efectos secundarios (conexión Prisma,
  parsing, reportes) en módulos compartidos. Los comandos de migración y
  recuperación quedan separados y con modo `--dry-run`/snapshot.
- Después de cada consolidación: ejecutar la prueba del comando original, una
  prueba de idempotencia y `git diff --check`. Archivar, no eliminar, cualquier
  script cuyo uso no pueda demostrarse.

## 10.4 Reparación de identidad TMDB reanudable

`tools/repair-tmdb-identities.ts` cubre las filas antiguas que quedaron sin
`tmdb_id` y revalida grupos donde un mismo ID fue asignado a títulos
incompatibles. Por seguridad, solo escribe con `--apply`; mantiene un cursor
JSON y un reporte, limita la concurrencia a cuatro y nunca elimina episodios ni
SourceLinks. La lista de Shows es estable aunque los IDs se rellenen durante la
ejecución, hereda la identidad desde un `Show` equivalente para completar
`MediaItem` sin repetir llamadas externas y prueba títulos alternativos con año
cuando el nombre local no coincide con TMDB. Tras finalizar el lote de conflictos
se ejecuta primero `npm run reconcile:tmdb` (dry-run); solo el mismo comando con
`--apply` mueve fuentes a `(temporada, episodio)`, crea un `MediaItem` canónico si
falta y conserva una guarda de similitud para no mezclar películas o spin-offs.

Ejemplo reanudable:

```text
npm run repair:tmdb -- --apply --concurrency 2 \
  --cursor-file data/tmdb-repair.cursor.json \
  --report docs/reports/tmdb-repair.json

npm run reconcile:tmdb -- --report docs/reports/tmdb-reconcile-dry.json
# Después de revisar el reporte:
npm run reconcile:tmdb -- --apply --report docs/reports/tmdb-reconcile-apply.json
```

El proceso informa explícitamente los títulos sin coincidencia; esos no se
rellenan con un ID popular ni se consideran fusionables hasta una revisión.

## 10.5 Reimportación de localizadores canónicos

La reimportación se ejecuta en dos pasadas persistentes: primero enlaces directos
históricos que ya caducaron y después todos los episodios con fuentes no excluidas.
La cola guarda únicamente identidad, proveedor y URL canónica; no almacena HTML ni
manifests firmados. Por ello la extracción de HLS se mantiene JIT y la tarea puede
procesar decenas de miles de episodios sin saturar el backend. El worker escribe un
checkpoint por elemento y reencola automáticamente cualquier trabajo que quedó
`running` al reiniciar el proceso, porque el worker anterior ya no existe.

En el entorno actual quedaron creadas las colas `recovery-1788413671226-qlzvv`
(10.000, modo `expired`) y `recovery-1788414964297-mxxrp` (28.352, modo `all`).
TubePelis se excluye en la selección y TioPlus permanece habilitado. El progreso y
los errores se consultan en `GET /api/v1/source-recovery/jobs`; repetir una pasada
es idempotente por la clave `(media_episode, source_site, url)`.

Antes de arrancar las colas se ejecutó también
`npm run backfill:canonical -- --apply --concurrency 4`: completó 15.261
localizadores persistibles y dejó fuera únicamente tres páginas de navegación
no canónicas.

El cierre automático de esta ejecución queda en
`npm run finalize:pipeline`: espera los barridos `full_catalog`, reencola pausas
transitorias mediante checkpoints y usa la sesión administrativa del servidor
para crear la recuperación final y lanzar la verificación completa. No importa
otro singleton del worker, por lo que no interrumpe la cola que ya está activa.

## 10.6 Puente de episodios legacy sin SourceLink

El modelo histórico `Show/Episode` todavía contiene URLs que no llegaron a
`MediaEpisode/SourceLink`. `tools/backfill-legacy-source-links.ts` cubre ese
vacío en lotes reanudables: empareja primero por TMDB y namespace (película vs
TV), después por título normalizado/año, conserva la temporada explícita y
guarda únicamente páginas, embeds o directos estables. Las URLs firmadas se
registran como efímeras para que el reproductor las resuelva JIT; TubePelis se
excluye. El modo de escritura requiere `--apply` y se ejecuta cuando no haya
workers de catálogo/fuentes activos.
