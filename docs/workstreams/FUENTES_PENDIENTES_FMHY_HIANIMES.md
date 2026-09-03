# Fuentes pendientes: HiAnimes y FMHY (fase final)

Estado: **HiAnimes integrado en piloto; candidatos FMHY pendientes de auditoría**.
La integración de HiAnimes ya cubre catálogo, ficha, episodio y resolución JIT
sin navegador pesado. Los candidatos FMHY se mantienen separados hasta superar
las pruebas de media reproducible.
No se añadirá una fuente por el mero hecho de responder HTTP 200: debe pasar
catálogo → ficha → episodio → media reproducible en nuestro reproductor, y dejar
un procedimiento repetible.

## HiAnimes (`hianimes.se`)

**Hallazgo técnico.** La web es un frontend que consulta `animehot.cc/api` y usa
`anitv.cfd/api` como respaldo. La API observada expone:

- `POST /filter` con `page`, `limit` y `type`; respondió 2.029 animes para `type=All`.
- `GET /anime/{slug}`; devolvió ficha, episodios, IDs y enlaces de cada idioma.
- Los episodios entregan enlaces a hosts externos como ZokoAnime y MegaPlay.

**Prueba de disponibilidad.** La ficha de *Your Name.* y la de *One Piece* se
obtuvieron correctamente. Un enlace ZokoAnime respondió con un reproductor HTML
que contiene un token ofuscado (`window.__P`) y requiere ejecutar su receta XOR
para obtener la configuración; un enlace MegaPlay probado devolvió HTTP 410.

**Decisión:** integrado como `HiAnimesAdapter` con resolución JIT de ZokoAnime,
validación de hosts por episodio y paginación API. MegaPlay se conserva como
alternativa descubierta, pero no se marca verificado hasta que entregue media;
el token Zoko nunca se persiste como URL firmada.

## Candidatos FMHY — Spanish / Español → Streaming

La lista de FMHY mezcla streaming, descargas, IPTV y catálogos. Se separan aquí
para no contaminar la cola de reproducción con sitios que solo descargan, exigen
cuenta/DRM o son televisión en directo.

### Candidatos para una auditoría de adaptador

| Sitio | HTTP observado | Siguiente prueba | Decisión provisional |
| --- | ---: | --- | --- |
| HDFull | 200 | catálogo, ficha y fuente; comprobar registro | Pendiente |
| SoloLatino | 200 | separar páginas de catálogo de enlaces de vídeo | Pendiente |
| Cinezo | 200 | catálogo, ficha y media; comprobar anti-bot | Pendiente |
| PelisPedia | 200 | ficha/episodio y media; revisar soft-404 | Pendiente |
| Cine Libre Online | 200 | validar que las fichas apuntan a YouTube reproducible | Pendiente |
| Cine.ar Play | 200 | determinar geobloqueo/DRM y si ofrece una URL pública | Pendiente |
| Retina Latina | 200 | determinar catálogo y DRM/geo antes de adaptar | Pendiente |
| RTVCPlay | 200 | comprobar catálogo y manifestos públicos | Pendiente |

### No incorporar al barrido actual

- **TubePelis:** excluido explícitamente por el usuario.
- **PelisPlus, Zona-Leros y similares:** no se incorporan solo por aparecer en la
  lista; requieren una prueba completa y varios dominios observados están muertos,
  bloqueados o cambian con frecuencia.
- **Tele-libre, Teleonline, LaQuay TDT, IPTV y deportes:** son televisión en vivo,
  no fuentes de episodios de películas/series para este catálogo.
- **Sitios de descargas, torrents, foros o Google Drive:** no son adaptadores de
  reproducción JIT y no se añaden a `GET /play`.
- **Tubi, Pluto y Vix:** son servicios con catálogo y reglas de región/DRM; se
  auditarán como integración legal independiente, sin asumir que un HTTP 200
  equivale a un HLS accesible.

## Criterio de entrada para la fase final

1. Dos páginas de catálogo sin repetición ni falsos finales de paginación.
2. Tres fichas de tipos distintos y al menos cinco episodios/fuentes.
3. Resolución JIT repetible dos veces, con identidad canónica y sin guardar una
   URL firmada como identidad.
4. Manifiesto/MP4 comprobado y reproducción corta en nuestra UI; un iframe o una
   página canónica sin conversión cuenta como pendiente, no como éxito.
5. Adaptador y pruebas por separado, sin navegador pesado en cada carga y sin
   modificar el contrato de otros proveedores.

### Evidencia externa consultada

- [HiAnimes](https://hianimes.se/) y [ejemplo de ficha](https://hianimes.se/details/your-name.-umhtxk)
- [FMHY — Spanish / Español, sección Streaming / Streamear](https://fmhy.net/non-english)
