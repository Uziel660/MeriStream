# Validación de reproducción en navegador — 2026-09-08

Esta matriz se ejecutó con Playwright Chromium contra el servidor local. Cada caso siguió la ruta del usuario: ficha/landing → `resolve-embed` → sesión interna → master → primera playlist hija → primer segmento con `Range: bytes=0-1023`. Las URLs firmadas no se guardan en este informe; solo se conserva el host final y el estado observado.

## Ejecución final de la matriz (08:33–08:36 UTC)

Los artefactos reproducibles más recientes están en `work/provider-browser-current-*.json`.
Cada fila aceptada pasó por resolución del locator, sesión de entrega interna, manifiesto
HLS o MP4 y una lectura acotada del primer segmento. La identidad se comparó por TMDB
ID (y por MAL en Zoko); las diferencias de idioma del título no invalidan el match.

| Provider | Seleccionadas | Resolución | Manifest/MP4 | Segmento | Identidad por ID | Fallos excluidos |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cinecalidad | 10 | 10 | 10 | 10 | 10 | 0 |
| GnulaHD | 15 | 14 | 14 | 14 | 15 | 1 (One Piece, upstream) |
| LatAnime | 15 | 15 | 15 | 14 | 15 | 0 (1 MP4 sin segmento HLS) |
| ZokoAnime | 15 | 15 | 15 | 15 | 15 (MAL incluido) | 0 |
| TioAnime (legacy) | 15 | 13 | 13 | 13 | 13 | 2 (Mega upstream) |
| VidSrc | 10 | 10 | 10 | 10 | 10 | 0 |

Esto deja al menos diez reproducciones nativas aceptadas por cada adapter activo y
mantiene TioAnime únicamente como fallback legacy. Gnula y Tio conservan sus casos
upstream fallidos como fallos honestos; no se convierten en fuentes falsas.

| Provider | Obras probadas | Válidas | Muestra documentada | Host final observado | Estado |
| --- | ---: | ---: | ---: | --- | --- |
| cinecalidad | 20 | 20 | 10 | Vimeos (20; nodos p/s.vimeos) | 10/10 mínimo cumplido |
| gnula | 15 | 14 | 10 | SprintCDN (14; nodos edge rotativos) | 10/10 mínimo cumplido |
| latanime | 12 | 12 | 10 | SprintCDN (11) + MeriStream Mega relay (1) | 10/10 mínimo cumplido |
| zokoanime | 15 | 15 | 10 | hls2.aniwatchtv.uk (15) | 10/10 mínimo cumplido |
| tioanime | 15 | 13 | 10 | Cloudwindow Route (12) + Mega relay | 10/10 mínimo cumplido |
| vidsrc | 10 | 10 | 10 | dominios VidSrc `.site/.space/.website` (10) | 10/10 mínimo cumplido |

## Headers y entrega observados

- Vimeos (Cinecalidad): UA Chrome/124 + `Accept-Encoding: identity`, sin `Referer`; entrega HLS por sesión proxy.
- SprintCDN (GnulaHD/LatAnime): UA Chrome/124 + `Accept-Encoding: identity`, sin `Referer`; entrega HLS por sesión proxy.
- ZokoAnime `hls2.aniwatchtv.uk`: UA Chrome/124 y `Referer: https://zokoanime.video/`; entrega HLS por sesión proxy.
- VidSrc: el gateway conserva el `Referer` del player VidSrc y el UA requerido, y el navegador solo recibe rutas `/api/v1/playback/...`; no se expone el CDN.
- Mega/TioAnime y otros relays MP4 se marcan como rutas internas; la prueba usa `Range` y no descarga el archivo completo.

## Muestra aceptada (10 obras por adapter)

### cinecalidad

| TMDB | Título | Tipo | Host final | Media | Child | Segmento | Identidad |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1386315 | A la carrera | movie | p5.vimeos.zip | 200 | 200 | 206 | TMDB OK |
| 6435 | Prácticamente magia | movie | s10.vimeos.net | 200 | 200 | 206 | TMDB OK |
| 10539 | Jim y el durazno gigante | movie | p6.vimeos.zip | 200 | 200 | 206 | TMDB OK; título localizado |
| 982620 | Terror en El Óceano | movie | s1.vimeos.net | 200 | 200 | 206 | TMDB OK; título localizado |
| 1147266 | Morirás en 6 horas | movie | p5.vimeos.zip | 200 | 200 | 206 | TMDB OK |
| 1529510 | Mi Perfecto Ex | movie | p6.vimeos.zip | 200 | 200 | 206 | TMDB OK |
| 985890 | Entre los vivos | movie | p3.vimeos.zip | 200 | 200 | 206 | TMDB OK; título localizado |
| 1067833 | Juego de brujas | movie | p6.vimeos.zip | 200 | 200 | 206 | TMDB OK |
| 974383 | Fin de la línea | movie | p5.vimeos.zip | 200 | 200 | 206 | TMDB OK; título localizado |
| 453296 | The Wrong Babysitter | movie | p6.vimeos.zip | 200 | 200 | 206 | TMDB OK |

### gnula

| TMDB | Título | Tipo | Host final | Media | Child | Segmento | Identidad |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 95350 | Linternas | series | edge1-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 30984 | Bleach | anime | edge2-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 125988 | Silo | series | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 113962 | Operaciones Especiales: Lioness | series | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 108978 | Reacher | series | edge1-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 255358 | Ghost in the Shell | anime | edge1-moscow-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 456 | Los Simpson | series | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 289324 | Star Wars Visions: La Jedi número 9 | anime | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 1399 | Juego de tronos | series | edge1-vienna-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 127532 | Solo Leveling | anime | edge1-moscow-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |

### latanime

| TMDB | Título | Tipo | Host final | Media | Child | Segmento | Identidad |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 123542 | Shiguang Dailiren | anime | edge2-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 685274 | Mobile Suit Gundam Hathaway | anime | edge2-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 910850 | MOBILE SUIT GUNDAM HATHAWAY The Sorcery of Nymph Circe | anime | edge2-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 30984 | Bleach | anime | interno | 206 | — | — | TMDB OK |
| 295999 | MAO | anime | edge1-moscow-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 83121 | Kaguya-sama wa Kokurasetai | anime | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 288971 | Tenmaku no Jaadugar | anime | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 289324 | Star Wars Visions: La Jedi número 9 | anime | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |
| 1679730 | La heroína del moño | anime | edge2-waw-sprintcdn.r66nv9ed.com | 200 | 200 | 206 | TMDB OK |
| 38464 | Blue Exorcist: The Blue Night Saga | anime | edge1-frankfurt-sprintcdn.owphbf24.com | 200 | 200 | 206 | TMDB OK |

### zokoanime

| TMDB | Título | Tipo | Host final | Media | Child | Segmento | Identidad |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 284644 | My Status as an Assassin Obviously Exceeds the Hero's | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 222624 | Gintama Mr. Ginpachi's Zany Class | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 284442 | A Gatherer's Adventure in Isekai | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 296287 | Plus-sized Misadventures in Love! | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 284388 | A Mangaka's Weirdly Wonderful Workplace | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 302169 | Anila to Cocora | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 285797 | Koupen Chan | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 256721 | Gachiakuta | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 283880 | Hands Off: Sawaranaide Kotesashi-kun | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |
| 289217 | Alma-chan Wants to Be a Family! | anime | hls2.aniwatchtv.uk | 200 | 200 | 206 | TMDB + MAL OK |

### tioanime

| TMDB | Título | Tipo | Host final | Media | Child | Segmento | Identidad |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 1679730 | La heroína del moño | anime | ugc-cdn-caching-n3y5ud9vqosusforpv.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 286345 | Futsutsuka na Akujo dewa Gozaimasu ga: Suuguu Chouso Torikae Den | anime | ugc-cdn-caching-n3wvutylqavhuksgin.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 312266 | Hanaori-san wa Tensei shitemo Kenka ga Shitai | anime | ugc-cdn-caching-n3ixotzmyhx6nxk5ht.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 296286 | Fumando juntos detrás del súper | anime | ugc-cdn-caching-n3zzac1qwcu2wzlxg4.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 98865 | Mebius Dust | anime | ugc-cdn-caching-n3wfrcerk46zmlqom9.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 298103 | Ibitte Konai Gibo to Gishi | anime | ugc-cdn-caching-n3lkvxgheee2fzfh03.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 139512 | Otome Game Sekai wa Mob ni Kibishii Sekai desu 2 | anime | ugc-cdn-caching-n3ruf00x5endb2luld.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 258348 | Clevatess | anime | ugc-cdn-caching-n3wdv8gsbrzfgwxo1u.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 326119 | Thunder 3 | anime | ugc-cdn-caching-n3dvifdwlponu03jbm.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |
| 297826 | Dogul Wang | anime | ugc-cdn-caching-n35oon8upkzi1zeghh.cloudwindow-route.com | 200 | 200 | 206 | TMDB OK |

### vidsrc

| TMDB | Título | Tipo | Host final | Media | Child | Segmento | Identidad |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- |
| 550 | Fight Club | movie | comityofcognomen.site | 200 | 200 | 200 | TMDB OK |
| 603 | The Matrix | movie | zealotsofzenith.site | 200 | 200 | 200 | TMDB OK |
| 27205 | Inception | movie | peregrinepalaver.space | 200 | 200 | 206 | TMDB OK |
| 157336 | Interstellar | movie | noosphere-nectar.site | 200 | 200 | 200 | TMDB OK |
| 496243 | Parasite | movie | palindromepanorama.website | 200 | 200 | 200 | TMDB OK |
| 1399 | Game of Thrones | series | quorumofquiddity.site | 200 | 200 | 206 | TMDB OK |
| 1396 | Breaking Bad | series | antilogarithm-atlas.site | 200 | 200 | 200 | TMDB OK |
| 66732 | Stranger Things | series | seraphimonolith.space | 200 | 200 | 200 | TMDB OK |
| 94605 | Arcane | series | panoplypalaver.site | 200 | 200 | 206 | TMDB OK |
| 94954 | The Last of Us | series | demesnedialectic.website | 200 | 200 | 200 | TMDB OK |

## Hallazgos y límites

- Cinecalidad entregó Vimeos en los 20 casos probados; los 20 tuvieron master, child y segmento válidos. Cuatro títulos no coinciden literalmente porque TMDB devuelve la localización española, pero el TMDB ID y el locator de Cinecalidad permanecen alineados.
- GnulaHD terminó en hosts rotativos de SprintCDN en 14/15 casos; `One Piece` no produjo un stream nativo y quedó como fallo de resolución, sin exponerse como falso éxito.
- LatAnime terminó principalmente en SprintCDN; 11 casos tuvieron HLS completo y un caso (`Bleach`) entregó el relay MP4 interno con `206`. Los 12 conservaron identidad TMDB.
- ZokoAnime terminó en `hls2.aniwatchtv.uk` en 15/15 casos; todos tuvieron HLS completo y los IDs MAL comprobados por el gateway coincidieron. Un título solo difiere por localización española de TMDB.
- TioAnime sigue siendo legacy/fallback: 13/15 casos pasaron; los dos restantes fueron relays Mega con `502`/`429`. Hay 10 casos aceptados para verificar el camino de recuperación, pero no se usa como provider principal.
- VidSrc produjo fuentes directas en 10/10 casos de películas y series; los 10 pasaron por el proxy interno con master, child y primer segmento válidos. Las playlists largas dejaron de perder los primeros segmentos al ampliar el límite de locators opacos de la sesión; esto no descarga ni almacena bytes de vídeo.

El detalle sin URLs firmadas está en `provider-browser-validation-2026-09-08.json`. Los informes crudos de cada ejecución permanecen en `work/` como artefactos locales de depuración.

