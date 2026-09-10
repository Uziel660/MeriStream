# Plan de trabajo — MeriStream / Admin

Esta lista reúne las mejoras solicitadas y sirve como checklist persistente del panel.

## Verificación e identificación

- [x] Separar visualmente las acciones principales de Verificación, mantenimiento, configuración y métricas.
- [x] Añadir identificación explícita del catálogo interno (Cinecalidad, Gnula, TioPlus y demás fuentes) contra TMDB.
- [x] Permitir editar manualmente TMDB, MAL, AniList y Kitsu por obra.
- [x] Mostrar y filtrar obras sin TMDB ID desde el catálogo interno.
- [ ] Hacer que la cola de identidad externa se entienda como reporte/control separado.
- [ ] Permitir auditar y ejecutar manualmente cada operación automática.

## Workers / Cola de tareas

- [x] Hacer funcional el botón Nueva tarea con un endpoint propio de creación.
- [x] Formulario con URL, nombre, alcance, páginas y delay.
- [x] Elegir resolver preferido y conservarlo al reanudar.
- [x] Elegir tipo de contenido (automático, película, serie, anime o documental).
- [x] Elegir paginación automática, plantilla o ejemplos.
- [x] Detectar plantillas a partir de enlaces de página 2 y página 3.
- [x] Usar la plantilla guardada durante todo el descubrimiento del worker.
- [x] Unificar los ajustes globales del worker en un único bloque visual.
- [x] Mostrar en cada tarea la configuración efectiva usada.
- [x] Mejorar mensajes de error, validación y estado de creación.

## Catálogo, fuentes y rutas

- [x] Política global de fuentes por plataforma: normal, legacy o automática.
- [x] Excepción por obra y por stream para forzar ruta normal o legacy.
- [ ] Revisar disponibilidad bajo demanda en Vidsrc, Zoro/ZokoAnime y demás servidores.
- [ ] Reportar fallos agregados por fuente y servidor con suficiente detalle operativo.
- [ ] Mantener preferencias manuales de la obra al refrescar datos de TMDB.
- [ ] Hacer que búsqueda y filtros del catálogo interno usen el mismo flujo que la búsqueda pública.

## Series y anime

- [x] Edición de identificadores MAL/AniList para mejorar resolución de ZokoAnime.
- [ ] Gestión más cómoda por temporadas, episodios y servidores.
- [ ] Edición masiva o por temporada de idioma de audio y subtítulos.

## Duplicados y visibilidad

- [x] Revisar candidatos de coincidencia antes de fusionar obras.
- [x] Permitir decidir manualmente si dos obras se fusionan.
- [x] Eliminar obras del catálogo público.
- [ ] Añadir restauración/visibilidad reversible y filtros de obras ocultas.

## Despliegue y validación

- [x] PostgreSQL funcionando como servicio local.
- [x] Túnel manual de cloudflared para `stream.merith.me`.
- [x] Recompilar, probar API/UI y comprobar el flujo completo en el túnel después de cada bloque.

## Integración Jules — 10/09/2026

- [x] Integrar PR #47 (tests de etiquetas).
- [x] Integrar PR #48 (tests de imágenes y soporte de PostgreSQL en pruebas).
- [x] Integrar PR #49 (CORS restringido y redirección HTTPS segura).
- [x] Integrar PR #50, #51 y #52 (eliminar componentes sin referencias).
- [x] Integrar PR #53, #57 y #62 (reconciliación por lotes y eliminación de consultas N+1).
- [x] Integrar PR #54 (comprobación de episodios duplicados en una sola consulta).
- [x] Integrar PR #55 (refactor de eventos HLS; se omitieron cambios de tests inválidos).
- [x] Integrar PR #56 (tests de limpieza de texto y fallback de PostgreSQL en CI).
- [x] Integrar PR #58 y #61 (reparación de géneros y títulos pegados).
- [x] Integrar PR #59 (consultas lite parametrizadas contra inyección SQL).
- [x] Integrar PR #60 (tests de géneros ocultos y dependencias jsdom/testing-library).
- [x] Integrar PR #63 (casos límite de etiquetas de episodios).
- [x] Integrar PR #64 (refactor del verificador, conservando el modo de identidad del catálogo).
