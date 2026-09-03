# Reporte de Auditoría de SourceLinks — Meristream

**Fecha de ejecución:** `2026-09-02T23:03:19.264Z`  
**Proveedores auditados:** `tioplus.app`, `lamovie.org`, `cinecalidad.am`  
**Total enlaces auditados:** `6241`  
**Total fuentes a reconstruir:** `330`  

> [!NOTE]
> Este reporte fue generado en modo estrictamente de solo lectura. No se ha modificado la base de datos.
> Todas las URLs han sido sanitizadas: se han eliminado todos los tokens, firmas y query strings sensibles.

## Resumen General por Categoría

| Categoría | Total Enlaces | Descripción |
| :--- | :--- | :--- |
| `canonical_page` | 5648 | Páginas de detalle oficiales del portal del proveedor |
| `canonical_embed` | 239 | Embeds externos con ID permanente (Voe, Mega, Dood, etc.) |
| `stable_direct` | 24 | Streams directos HLS/MP4 permanentes sin expiración |
| `active_ephemeral_direct` | 0 | Streams HLS/MP4 firmados aún vigentes o con expiración no determinable (validar JIT) |
| `expired_ephemeral_direct` | 329 | Streams HLS/MP4 firmados con firma temporal vencida |
| `invalid_catalog_page` | 1 | URLs de catálogo o paginación (/page/N/) guardadas como fuente |
| `unknown` | 0 | URLs no reconocidas o malformadas |

## Desglose por Proveedor

### Proveedor: `tioplus.app`

- **Total enlaces:** 348
- **Páginas canónicas (`canonical_page`):** 0
- **Embeds canónicos (`canonical_embed`):** 61
- **Directos estables (`stable_direct`):** 24
- **Directos efímeros activos/no determinables (`active_ephemeral_direct`):** 0
- **Directos efímeros vencidos (`expired_ephemeral_direct`):** 263
- **URLs inválidas de catálogo (`invalid_catalog_page`):** 0
- **Fuentes que deben reconstruirse desde página canónica:** **263**
- **Episodios con hermana canónica viva:** 0
- **Episodios sin ninguna fuente válida restante:** 165

### Proveedor: `lamovie.org`

- **Total enlaces:** 5456
- **Páginas canónicas (`canonical_page`):** 5280
- **Embeds canónicos (`canonical_embed`):** 136
- **Directos estables (`stable_direct`):** 0
- **Directos efímeros activos/no determinables (`active_ephemeral_direct`):** 0
- **Directos efímeros vencidos (`expired_ephemeral_direct`):** 40
- **URLs inválidas de catálogo (`invalid_catalog_page`):** 0
- **Fuentes que deben reconstruirse desde página canónica:** **40**
- **Episodios con hermana canónica viva:** 23
- **Episodios sin ninguna fuente válida restante:** 0

### Proveedor: `cinecalidad.am`

- **Total enlaces:** 437
- **Páginas canónicas (`canonical_page`):** 368
- **Embeds canónicos (`canonical_embed`):** 42
- **Directos estables (`stable_direct`):** 0
- **Directos efímeros activos/no determinables (`active_ephemeral_direct`):** 0
- **Directos efímeros vencidos (`expired_ephemeral_direct`):** 26
- **URLs inválidas de catálogo (`invalid_catalog_page`):** 1
- **Fuentes que deben reconstruirse desde página canónica:** **27**
- **Episodios con hermana canónica viva:** 9
- **Episodios sin ninguna fuente válida restante:** 1

## Plan de Acciones Propuesto (Sin Ejecución de Modificaciones)

A continuación se detallan las acciones de remediación recomendadas:

### [PLAN-TIOPLUS-01] Reconstruir catálogo canónico para episodios con HLS efímeros vencidos
- **Proveedor:** `tioplus.app`
- **Severidad:** `HIGH`
- **Registros afectados:** `263`
- **Justificación:** El 100% de los streams directos de tioplus.app corresponden a acek-cdn y dramiyos-cdn firmados con s+e ya vencidos. No existe ninguna URL de detalle en tioplus.app almacenada.
- **Pasos planificados:**
  1. Identificar los MediaItems asociados a los episodios afectados.
  1. Ejecutar scraper canónico de tioplus.app para extraer la URL de página canónica (/pelicula/... o /serie/...) y/o embeds permanentes.
  1. Insertar las nuevas fuentes canónicas con source_kind='page' o 'embed'.
  1. Depurar de forma segura los SourceLinks expirados una vez verificada la nueva fuente canónica.

### [PLAN-CINECALIDAD-01] Eliminar / reclasificar URLs de catálogo /page/N/ asociadas erróneamente a episodios
- **Proveedor:** `cinecalidad.am`
- **Severidad:** `HIGH`
- **Registros afectados:** `1`
- **Justificación:** Se detectaron URLs de paginación (ej. https://www.cinecalidad.am/page/1/) guardadas como fuente de reproducción de episodios específicos.
- **Pasos planificados:**
  1. Aislar los registros de SourceLink que coincidan con regex /page/\d+/.
  1. Comprobar si el episodio cuenta con una página canónica hermana (/ver-pelicula/...).
  1. Si cuenta con hermana, marcar la URL de catálogo para remoción segura en una migración planificada.
  1. Actualizar el scraper de cinecalidad para evitar que la URL de navegación sea persistida como stream del ítem.

### [PLAN-CINECALIDAD-02] Remover enlaces directos temporales (Vimeos/Goodstream s+e) que ya cuentan con página canónica
- **Proveedor:** `cinecalidad.am`
- **Severidad:** `MEDIUM`
- **Registros afectados:** `26`
- **Justificación:** Cinecalidad almacena la página canónica (/ver-pelicula/...) junto a links directos firmados vencidos. Los links directos son redundantes y fallan de inmediato.
- **Pasos planificados:**
  1. Verificar que cada episodio con link Vimeos/Goodstream s+e tenga su página canónica hermana.
  1. Validar resolución JIT a demanda desde la página canónica.
  1. Purgar los registros de SourceLink directos expirados mediante migración controlada.

### [PLAN-LAMOVIE-01] Limpiar streams directos efímeros que cuentan con página canónica hermana
- **Proveedor:** `lamovie.org`
- **Severidad:** `MEDIUM`
- **Registros afectados:** `40`
- **Justificación:** Existen enlaces directos temporales a vimeos y goodstream que ya han expirado pero cuentan con su página canónica de lamovie.org/peliculas/.
- **Pasos planificados:**
  1. Asegurar que la resolución JIT esté operativa para páginas canónicas de lamovie.org.
  1. Descartar los SourceLinks de tipo direct firmados vencidos.

## Muestra de Enlaces Sanitizados (Máximo 10 por proveedor)

| Proveedor | Categoría | Host | URL Sanitizada (Sin Tokens / Query Strings) |
| :--- | :--- | :--- | :--- |
| `tioplus.app` | `expired_ephemeral_direct` | `yxqc9c2vqj7vepbl.acek-cdn.com` | `https://yxqc9c2vqj7vepbl.acek-cdn.com/hls2/01/08557/vplf3hxobboq_,l,n,h,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `1hyahuwewhyvwmq.acek-cdn.com` | `https://1hyahuwewhyvwmq.acek-cdn.com/hls2/01/08557/96f7oqqryybs_,l,n,h,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `yxqc9c2vqj7vepbl.acek-cdn.com` | `https://yxqc9c2vqj7vepbl.acek-cdn.com/hls2/01/08557/9jh53g0838bl_,l,n,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `wt4pjiive9agjpl.dramiyos-cdn.com` | `https://wt4pjiive9agjpl.dramiyos-cdn.com/hls2/01/08557/oj9g4slz0oo6_,l,n,h,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `o5czhgnohwluyzcb.acek-cdn.com` | `https://o5czhgnohwluyzcb.acek-cdn.com/hls2/01/08557/9ooufglnjg3h_,l,n,h,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `yxqc9c2vqj7vepbl.acek-cdn.com` | `https://yxqc9c2vqj7vepbl.acek-cdn.com/hls2/01/08545/pjabnk95yjpg_,l,n,h,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `yxqc9c2vqj7vepbl.acek-cdn.com` | `https://yxqc9c2vqj7vepbl.acek-cdn.com/hls2/01/08557/kg77qljxzf9y_,l,n,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `o5czhgnohwluyzcb.acek-cdn.com` | `https://o5czhgnohwluyzcb.acek-cdn.com/hls2/01/08545/t9pbs565atnn_,l,n,h,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `2zo6sb3myz7fapc.acek-cdn.com` | `https://2zo6sb3myz7fapc.acek-cdn.com/hls2/01/08535/by2x4rc2rfmh_,l,n,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `tioplus.app` | `expired_ephemeral_direct` | `vyy3aygtehnqnhdr.acek-cdn.com` | `https://vyy3aygtehnqnhdr.acek-cdn.com/hls2/01/08535/vsfs8pzhtdip_,l,n,.urlset/master.m3u8?[QUERY_STRIPPED]` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/bloodshot-2020/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/10-cosas-que-odio-de-ti-1999/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/paprika-el-reino-de-los-suenos-2006/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/no-es-mas-que-el-fin-del-mundo-2016/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/enemigo-de-todos-2016/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/hellraiser-ella-2022/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/animales-fantasticos-3-los-secretos-de-dumbledore-2022/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/animales-fantasticos-2-los-crimenes-de-grindelwald-2018/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/ligeramente-embarazada-2007/` |
| `lamovie.org` | `canonical_page` | `lamovie.org` | `https://lamovie.org/peliculas/desencantada-2022/` |
| `cinecalidad.am` | `invalid_catalog_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/page/1/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/intriga-internacional/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/reyes-de-las-olas-2/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/camara-policial/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/pena-de-muerte/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/power-rangers-la-pelicula/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/minions-monstruos/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-pelicula/esta-detras-de-ti/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-el-episodio/bodas-s-a-1x2/` |
| `cinecalidad.am` | `canonical_page` | `www.cinecalidad.am` | `https://www.cinecalidad.am/ver-el-episodio/bodas-s-a-1x3/` |
