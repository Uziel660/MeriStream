# Pendientes de Meristream

Lista de trabajo para retomar la mejora integral de la aplicación. Se basa en los problemas observados en la aplicación real, el código y las pruebas realizadas; no sustituye la validación final después de cada cambio.

## Estado de partida

- Rama de trabajo: `lastversion`.
- Último commit conocido: `c2a2014 fix: separate hero genres from title`.
- El worktree estaba limpio al crear esta lista.
- El `.env` de `E:\merinuevo\.env` ya se copió al proyecto local. Mantenerlo ignorado por Git y no exponer sus valores.
- El servidor local de desarrollo se probó en `http://localhost:3010/`.
- En este turno no se ha cambiado código: solo se ha creado este documento.

## Prioridad P0 — integridad de reproducción

### 1. VidSrc/NXSHA debe respetar el idioma elegido

- Analizar las etiquetas de NXSHA (`[English]`, `[Korean]`, `Hindi`, `Multi-Lang`, etc.) antes de elegir el HLS.
- Pasar el idioma preferido del selector hasta `resolveVidSrcEmbed`/`resolveNxshaMultiLang`.
- Puntuar y ordenar candidatos: coincidencia exacta con el idioma solicitado primero; `Multi-Lang` después; idiomas no coincidentes solo como último recurso.
- Buscar más de un servidor/candidato cuando el primero tiene un idioma explícitamente incompatible. Mantener un límite y paralelismo razonable para no empeorar la latencia.
- No asignar `"en"` por defecto cuando no existe pista de audio. Si solo se conoce la etiqueta NXSHA, mostrar ese idioma real; si no se conoce, dejarlo indeterminado.
- Ampliar la normalización de idiomas para hindi y otros idiomas indios que pueden aparecer en VidSrc/subtítulos: `hi`, `ta`, `te`, `ml`, `bn`, `mr`, `pa`, `kn`, `gu`, `ur`, además de variantes de español/portugués y códigos alternativos.
- Exponer la etiqueta/idioma detectado en la fuente para que el selector no afirme “inglés” cuando el stream es coreano o indio.
- Añadir pruebas unitarias para el parseo de etiquetas, el ranking con preferencia `en`/`es` y el comportamiento sin pistas HLS.

### 2. Evitar contenido equivocado (caso `La isla olvidada`)

- El resolver actual acepta el primer HLS técnicamente reproducible y no comprueba identidad de contenido.
- Investigar una validación segura antes de aceptar VidSrc: título/alias/año de TMDB frente a metadatos disponibles del proveedor, nombre de archivo, duración y/o respuesta del reproductor.
- Si una fuente tiene una etiqueta de idioma incompatible o señales claras de otra obra, no seleccionarla automáticamente; continuar con otro candidato/proveedor o mostrar que no hay fuente fiable.
- Nunca ocultar la incertidumbre: registrar por qué se descartó o aceptó cada candidato.
- Añadir una prueba de regresión para TMDB `1465063` que impida presentar como inglés una fuente etiquetada `[Korean]`.
- Validar también una obra coreana legítima para no romper títulos cuyo audio original no es inglés.

## Prioridad P0 — subtítulos

### 3. Evitar falsos positivos

- Fortalecer `SubtitleCatProvider` para que una búsqueda con año no acepte páginas cuyo título/URL contiene otro año (caso observado: una entrada de `Fantasy Island 1977` para `La isla olvidada`).
- Mantener coincidencia por título/alias, pero exigir compatibilidad de año cuando el proveedor lo expone.
- Aplicar la comprobación tanto al resultado de búsqueda como a la página/fichero de subtítulos.
- Crear pruebas con HTML simulado: rechazar año conflictivo y aceptar título/año correcto.

### 4. Mejorar detección y cobertura

- Normalizar correctamente códigos y nombres de idiomas de VidSrc, OpenSubtitles, YIFY y SubtitleCat, incluidos idiomas indios y variantes regionales.
- Ordenar las pistas por los idiomas seleccionados por el usuario sin eliminar innecesariamente alternativas válidas.
- Mantener el fallback entre proveedores (`opensubtitles-v3`, `tvsubtitles`, `yify`, `subtitlecat`) y medir qué obras siguen sin pista.
- Revisar que cada URL pase por `SubtitleProxy` y por su lista de hosts permitidos; no introducir descargas directas inseguras.
- Añadir pruebas de integración para una obra con subtítulos VidSrc, una con fallback externo y una sin subtítulos.
- Mostrar un estado claro cuando no hay subtítulos, en vez de dejar un selector vacío o una pista incorrecta.

## Prioridad P1 — fallback y estabilidad del reproductor

### 5. No cambiar de servidor durante una reproducción sana

- Auditar los eventos HLS `fatal`, `waiting`, `stalled`, `mediaError` y `networkError`.
- Separar errores recuperables de fallos reales: intentar recuperación HLS (`recoverMediaError`/reintento acotado) antes de cambiar de servidor cuando proceda.
- Conservar el intento de proxy como segunda oportunidad, pero no saltar de servidor por un evento transitorio.
- Mantener el watchdog de congelación de 20 s solo cuando el playhead no avanza de verdad; comprobar que no se dispara durante pausas, cambios de pestaña o buffering normal.
- Registrar en cada failover: servidor, URL, evento HLS, estado `readyState`, tiempo sin avance y destino elegido.
- Mostrar al usuario una razón breve y no perder posición cuando el cambio sea necesario.
- Probar una reproducción real con varios servidores durante varios minutos y simular errores de red/media para verificar que el cambio no ocurre sin causa.

## Prioridad P1 — búsqueda y selección de candidatos

### 6. Buscar por títulos TMDB e IMDb

- Al buscar desde la barra, consultar/usar el título principal de TMDB, títulos alternativos/localizados y el título asociado al IMDb ID.
- Resolver el IMDb ID desde TMDB cuando sea posible y consultar sus aliases/títulos sin bloquear la primera respuesta.
- Unificar resultados duplicados por TMDB ID/IMDb ID.
- Puntuar candidatos por coincidencia exacta, prefijo, idioma del título, año, tipo (película/serie) y popularidad; mostrar primero los mejores candidatos.
- Mantener la respuesta rápida: debounce, caché de consultas recientes, límite de resultados y cancelación de solicitudes obsoletas.
- Añadir pruebas para títulos que difieren entre TMDB e IMDb, títulos traducidos y resultados ambiguos.

## Prioridad P1 — rendimiento sin quitar funciones

### 7. LCP y carga inicial

- Confirmar el elemento LCP real en una sesión limpia. El diagnóstico observó `img.feature-image` descubierto después de ejecutar un chunk, con aproximadamente 516 ms de espera de descubrimiento dentro de un LCP total de ~733 ms.
- Preconstruir o inyectar de forma segura el preload de la imagen hero solo cuando se conozca el recurso correcto; no precargar una imagen dinámica equivocada.
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

