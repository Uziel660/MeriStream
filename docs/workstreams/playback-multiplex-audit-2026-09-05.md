# Auditoría de reproducción y multiplexado — 2026-09-05

Esta auditoría es una prueba de humo controlada contra el servidor local. No modifica catálogos ni estados de `SourceLink`.

## Prueba por proveedor

Se seleccionó un episodio real por proveedor y se midió `GET /api/v1/play/:episode_id` (latencia de resolución y cantidad de candidatos). Todos los casos respondieron HTTP 200.

| Proveedor | Latencia observada | Streams devueltos | Resultado |
|---|---:|---:|---|
| AnimeFLV | 16 ms | 8 | OK en `/play` |
| AnimeFLV espejo | 23 ms | 4 | OK en `/play` |
| Cinecalidad | 9 ms | 0 | Registro `OFICIAL` sin candidato; reparar/filtrar |
| Doramasflix | 27 ms | 8 | OK en `/play` |
| Doramasflix.io | 51 ms | 3 | OK en `/play` |
| HiAnimes | 8 ms | 4 | OK en `/play` |
| HiAnimes.se | 17 ms | 6 | OK en `/play` |
| JKAnime | 9 ms | 8 | OK en `/play` |
| JKAnime.net | 10 ms | 5 | OK en `/play` |
| LaMovie | 8 ms | 2 | OK en `/play` |
| LaMovie.org | 10 ms | 8 | OK en `/play` |
| LatAnime | 13 ms | 4 | OK en `/play` |
| LatAnime.org | 10 ms | 8 | OK en `/play` |
| GNULA player | 139 ms | 5 | OK en `/play` |
| TioAnime | 11 ms | 8 | OK en `/play` |
| TioPlus | 10 ms | 6 | OK en `/play` |
| TioPlus.app | 7 ms | 5 | OK en `/play` |
| GNULA ww3 | 10 ms | 4 | OK en `/play` |
| VerAnimes wwv | 9 ms | 4 | OK en `/play` |
| VerAnimes espejo | 7 ms | 2 | OK en `/play` |
| AnimeFLV www3 | 13 ms | 8 | OK en `/play` |

La prueba de resolución final, ejecutada de forma secuencial para no saturar el servidor, dio HTTP 200 en 9 proveedores canónicos. LaMovie y TioPlus entregaron manifiestos HLS con bytes y `content-type` de playlist; AnimeFLV devolvió una URL directa pero su CDN rechazó la sonda de bytes. Doramasflix, HiAnimes, JKAnime, LatAnime, GNULA y VerAnimes conservaron un embed resoluble para el reproductor. No se convierten estos resultados en `is_verified=true`: todavía falta una reproducción de navegador por candidato.

## Prueba de multiplexado

Se probaron seis episodios con enlaces de múltiples plataformas:

- Un episodio tuvo 14 sitios almacenados y 28 enlaces; `/play` devolvió 8 candidatos de 6 sitios en 195 ms.
- Cinco episodios tuvieron 11 sitios almacenados y 16 enlaces; cada uno devolvió 8 candidatos de 6 sitios entre 31 y 101 ms.
- En los seis casos la respuesta fue HTTP 200 y todos los candidatos fueron embeds canónicos; el ranking alterna TioAnime, LatAnime, JKAnime, AnimeFLV, GNULA/WW3 y VerAnimes según disponibilidad.

## Interpretación

La cascada y el multiplexado están funcionando a nivel de catálogo/resolución. La auditoría de bytes aún no es 100 % verde: hay un CDN AnimeFLV que rechazó la sonda, un registro Cinecalidad sin streams y varios proveedores que requieren que el navegador abra el embed. Además, durante la verificación global el presupuesto del backend puede devolver `503 backend_busy`; eso es saturación controlada del servidor, no un fallo del proveedor.

## Smoke E2E de la interfaz local

Se ejecutó `e2e/local-playback-smoke.spec.ts` contra `http://127.0.0.1:3010` con un solo worker. La prueba abrió la obra **Duna**, esperó la respuesta real de `/api/v1/play/:episode_id` (HTTP 200), confirmó más de un candidato en `ranked_streams`, mostró el botón **Cambiar Servidor de Streaming**, abrió **Servidores Disponibles** y seleccionó una segunda opción. Resultado: **1 passed (7,4 s)**.

Este smoke prueba el flujo y el multiplexado de la UI; no afirma que cada embed externo entregue bytes dentro de Chromium. La matriz por proveedor y la sonda de manifiestos quedan como la evidencia de resolución descrita arriba.

La resolución canónica ya quedó comprobada con la matriz siguiente; todavía
queda la validación visual de cada embed y, cuando termine la verificación
global, la sonda ligera de salud que lee un primer bloque de los directos.

## Matriz práctica solicitada (ejecutada 2026-09-05 06:05Z)

Se ejecutó una matriz de baja carga sobre episodios ya almacenados: **12/12
plataformas respondieron HTTP 200 y devolvieron al menos un candidato**. Once
casos usan el grafo canónico; TubePelis se comprobó mediante su episodio legacy
con resolución JIT. Las latencias observadas fueron de 12–316 ms para `/play`
(la ruta canónica es DB-only y no dispara scrapers; el caso legacy sí resuelve
su página bajo demanda). La muestra de Cinecalidad se tomó de **Minions
Monstruos**, no del registro de prueba `OFICIAL`.

También se probaron **6 episodios multiplexados** con 9–14 sitios y 21–33
enlaces guardados; los seis respondieron HTTP 200, con 3–8 candidatos y entre
2–6 sitios distintos en el ranking. El detalle reproducible (sin URLs firmadas)
está en [playback-platform-matrix-2026-09-05.md](E:/Meristream/docs/workstreams/playback-platform-matrix-2026-09-05.md).

TubePelis no tiene `SourceLink` canónicos porque la transferencia histórica lo
dejó fuera de la cola de persistencia, por lo que no aparece en `/play`. Para
no confundir ausencia de catálogo con caída del proveedor, se ejecutó su
adaptador en vivo sobre **4 películas reales: 4/4 extrajeron un manifiesto HLS**
en 805–1855 ms. VerAnimes también se comprobó en vivo con 3/3 episodios y 3
servidores alternativos por episodio. Esa evidencia confirma que ambos
adaptadores responden; la importación/persistencia de TubePelis queda como una
acción aparte, no se modifica durante esta auditoría.

## Cambios preparados después de la prueba

- El probador de servidores del panel ahora consulta también `MediaItem/MediaEpisode/SourceLink` (no sólo el esquema histórico) y reconoce aliases por dominio/URL. GNULA, VerAnimes, Doramasflix, HiAnimes y las demás plataformas ya pueden aparecer aunque no tengan episodios legacy.
- El probador descarta una página web cruda cuando el extractor no devuelve un embed o medio; así no presenta un HTTP 200 de una página como si fuera vídeo reproducible.
- Las fichas históricas sin episodios legacy ahora hacen fallback a sus `MediaEpisode/SourceLink` canónicos cuando existe una coincidencia segura; así la portada no deja obras fusionadas sin botón de reproducción.
- El reproductor ahora fusiona en caliente todos los `ranked_streams` que devuelve
  `/catalog/episode-servers` al resolver una ficha canónica. Así el botón
  **Cambiar servidor** aparece también cuando la obra empezó con un único
  localizador y el multiplexor descubre las alternativas después del primer
  play.
- El descubrimiento de catálogos exige dos páginas vacías consecutivas o dos páginas repetidas antes de declarar el fin. Esto evita el corte prematuro observado en GNULA Series (la sonda en vivo mostró contenido aún después de la página 10).

### Resiliencia AnimeFLV / JKAnime

Durante la suite completa del 05/09 el espejo `animeflv.or.at` tuvo una
respuesta transitoria fallida, aunque el flujo JKAnime sí estaba disponible.
El adaptador ahora intenta automáticamente el directorio `jkanime.net` para
un barrido AnimeFLV cuando el espejo WordPress no responde; para fichas
AnimeFLV también busca la obra por título en JKAnime antes de devolver un
episodio de metadatos. La prueba live se repitió después del cambio: **4/4
tests pasan**, con streams directos/embeds válidos.

### Re-ejecución más reciente (2026-09-05 07:13Z)

Se volvió a ejecutar `tools/playback-platform-matrix.ts` después de excluir
el único alias sintético `test-index.local`: **18/18** casos correctos (12
proveedores + 6 multiplexados), todos HTTP 200 y con candidatos. La latencia
global fue 23 ms de mediana, 41,2 ms de promedio y 112 ms en P95. Los seis
casos multiplexados conservaron 9–14 sitios reales y 13–33 enlaces.

El smoke E2E volvió a abrir Duna, mostró el selector y permitió cambiar de
servidor. Su aserción final de *Valle salvaje* sigue pendiente porque el
proceso API que estaba levantado era el build anterior: la consulta directa a
la base confirma episodios canónicos, pero ese proceso aún no aplica el
fallback recién compilado. Se repetirá después del reinicio controlado al
quedar `verification` en estado `idle`.
