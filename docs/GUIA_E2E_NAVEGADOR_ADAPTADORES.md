# 🧭 GUÍA E2E DE NAVEGADOR POR ADAPTADOR — Nitiflix

> Guía para una IA con herramientas de navegador MCP (playwright/chrome-devtools)
> que va a validar que el video REALMENTE se reproduce en el frontend.
> Escrita 2026-08-22 tras la validación E2E de red de los 12 adaptadores.

---

## 0) REGLAS CRÍTICAS (leer antes que nada)

1. **PROHIBIDO screenshots full-page, video recording, o dumps HTML/base64 grandes.**
   El proyecto tiene un límite de memoria de ~32MB en las herramientas MCP y ha
   crasheado repetidamente por capturas masivas en bucle. Si necesitas "ver":
   - Usa **snapshot de accesibilidad (texto)**, nunca screenshot.
   - Si es imprescindible un screenshot: viewport pequeño, JPEG quality baja,
     MÁXIMO 1 por adaptador, nunca en bucle.
2. **NO toques el servidor.** Ya está corriendo en `http://127.0.0.1:3005`
   (usa SIEMPRE `127.0.0.1`, NUNCA `localhost` — el puerto 3000 es otro servicio
   Docker/Gotenberg). No mates procesos node, no reinicies nada salvo que el
   usuario lo pida explícitamente.
3. **Un adaptador a la vez.** Completa el ciclo completo (§3) antes de pasar al
   siguiente. Reporta resultado y pasa al siguiente sin esperar instrucción.
4. **Timeouts cortos**: navegación ≤15s, waits ≤10s. Si algo no carga, márcalo
   FAIL y sigue; no reintentar más de 2 veces.
5. **No hagas commit ni modifiques código** durante la validación. Solo reportes.

---

## 1) CONTEXTO: CÓMO FUNCIONA EL FLUJO QUE VAS A PROBAR

```
Panel Admin (UI) → POST /api/v1/catalog/analyze {url}
   → ScraperManager → Adapter.analyze() → detected_streams[]
Botón ▶️ del episodio → HLSPlayerModal abre
   → rankAndSortServers() ordena servidores
   → .m3u8/.mp4 → HLS.js/video nativo vía PROXY /api/v1/proxy/stream
   → embed conocido → resolve-embed o iframe sandbox
Failover automático: si un servidor falla, salta al siguiente de la lista.
```

**Criterio de éxito = `<video>` en estado PLAYING con currentTime avanzando**
(no basta que el modal abra o que el loader desaparezca).

---

## 2) PREPARACIÓN

- URL base: `http://127.0.0.1:3005` (el frontend React se sirve desde ahí;
  en dev con `NODE_ENV != production` usa middleware de Vite embebido).
- Health check primero: `GET http://127.0.0.1:3005/api/v1/health`
  → debe responder `{"status":"ok",...}`. Si falla, ABORTA e informa (no
  intentes arrancar el servidor tú).
- Resolución sugerida del navegador: 1280×720 (viewport pequeño = menos memoria).

### Abrir el Panel Admin
- Botón en el header: `#open-admin-panel-btn` (título "Panel de Control e Ingesta").
- Input principal de ingesta Smart Ingest:
  `placeholder="Pega cualquier URL de anime, película, serie..."`.
- Tras pegar la URL, botón **"Analizar"**.
- El resultado muestra metadatos + lista de episodios/servidores. Cada episodio
  tiene un botón play circular ámbar (`title="Reproducir este stream"`, icono Play).

### Verificación del reproductor
Cuando el modal `HLSPlayerModal` abra:
1. Espera (≤10s) a que desaparezca el estado de carga / aparezca el `<video>`
   (clase `h-full w-full object-contain`) o el iframe del embed.
2. Para modo nativo HLS, evalúa por JS (NO leas propiedades gigantes):
   ```js
   () => {
     const v = document.querySelector('video');
     if (!v) return { mode: 'no-video' };
     return {
       readyState: v.readyState,
       paused: v.paused,
       currentTime: Number(v.currentTime.toFixed(1)),
       duration: isFinite(v.duration) ? Number(v.duration.toFixed(1)) : null,
       videoWidth: v.videoWidth,
       error: v.error ? v.error.code : null,
     };
   }
   ```
3. **PLAYING confirmado** si: `readyState >= 2`, `paused === false`,
   `videoWidth > 0` y `currentTime` avanza entre dos lecturas separadas ~3s.
4. Anota también el label del servidor activo (lista lateral de servidores del
   modal; el activo suele resaltarse). Si hubo failover automático aparecerá un
   aviso tipo "Conectando automáticamente a servidor de respaldo...".

---

## 3) CICLO POR ADAPTADOR (repetir para cada fila de §4)

```
a. GET /api/v1/health → ok
b. Abrir Panel Admin → pegar URL de prueba → Analizar
c. Verificar respuesta visible: título + póster + ≥1 episodio/servidor listado
d. Click botón ▶️ del primer episodio
e. Verificar <video> PLAYING según §2 (o iframe cargado en modo embed)
f. Probar 1 cambio manual de servidor del dropdown si hay >1 (opcional, +valor)
g. Cerrar modal (botón X o Escape)
h. REGISTRAR fila: adaptador | PASS/PASS*/FAIL | servidor que funcionó | evidencia breve
i. Siguiente adaptador
```

Si el análisis UI falla por cualquier razón, haz fallback de diagnóstico SIN
navegador para diferenciar bug de frontend vs backend:
```bash
curl -s -X POST http://127.0.0.1:3005/api/v1/catalog/analyze \
  -H "Content-Type: application/json" -d '{"url":"<URL_DE_PRUEBA>"}' | head -c 800
```
Si curl funciona pero la UI no → bug frontend. Si ambos fallan → bug backend/sitio.

---

## 4) CASOS DE PRUEBA (en este orden)

| # | Adaptador | URL de prueba | Qué esperar |
|---|---|---|---|
| 0 | Sanity directo | reproducir desde Panel Admin la URL `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | HLS demo público: PLAYING inmediato sin failover. Si esto falla, el problema es el player, no los adaptadores — para y reporta |
| 0b | Sanity MP4 | `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4` | MP4 demo: PLAYING inmediato |
| 1 | Archive.org | `https://archive.org/details/night_of_the_living_dead` | película clásica dominio público; PLAYING |
| 2 | LaMovie | `https://lamovie.org/peliculas/bolt-un-perro-fuera-de-serie-2008/` | ⚠️ conocido: VOE puede servir placeholder Big Buck Bunny (video corre pero contenido = conejo = cuenta como PASS técnico, anota el placeholder). Probar otros servers del dropdown si pasa eso |
| 3 | Cinecalidad | `https://www.cinecalidad.am/ver-pelicula/regresando-a-casa-2/` | 6 servers; el m3u8 Goodstream debería ser el prioritario y reproducir |
| 4 | TubePelis | `https://www.tubepelis.com/pelicula/4603/spider-man-un-nuevo-dia.html` | 1 server válido (m3u8 Byse); tokens viven ~15min, si expiró vuelve a analizar antes de play |
| 5 | TioPlus | `https://tioplus.app/pelicula/supergirl-1984` | turboviplay m3u8 prioritario; PLAYING esperado |
| 6 | LatAnime | `https://latanime.org/anime/mushoku-tensei-jobless-reincarnation-temporada-3` | abrir ep1 desde la lista; mp4upload mp4 directo primero (proxy ya fuerza su Referer) |
| 7 | TioAnime | `https://tioanime.com/anime/naruto-shippuden-hd` | abrir ep1; embeds fiables primero (Mega/YourUpload/ok.ru). Mega embed puede tardar; el failover automático es normal aquí |
| 8 | VerAnimes | `https://wwv.veranimes.net/anime/naruto-honoo-no-chuunin-shiken-naruto-vs-konohamaru` | StreamWish resuelto; el CDN directo cfglobalcdn NO funcionará (cert externo) — si el player hace failover al embed y reproduce = PASS* |
| 9 | AnimeFLV | `https://www3.animeflv.net/anime/sousou-no-frieren` | abrir ep1; Mp4Upload normalizado |

Notas por sitio:
- Los animes muestran lista de episodios: haz click en **Episodio 1** primero si
  la ficha no trae streams directos, luego al ▶️ de ese episodio.
- Si un sitio cambia su DOM y el análisis devuelve vacío, repórtalo como
  "sitio cambió estructura" con el JSON crudo de analyze (≤800 chars).

---

## 5) FORMATO DEL REPORTE FINAL

Al terminar TODOS los casos, produce una tabla única:

```
| # | Adaptador | Estado | Servidor que reprodujo | currentTime alcanzado | Notas |
|---|-----------|--------|------------------------|----------------------|-------|
```

- Estados válidos: `PASS` (video nativo playing), `PASS-EMBED` (iframe embed
  cargó y mostró player del host), `FAIL` (con causa exacta), `SKIP` (sitio caído).
- Incluye al final: total PASS / total casos, y lista priorizada de bugs
  encontrados con archivo sospechado (frontend `src/components/HLSPlayerModal.tsx`
  vs backend `server.ts` proxy vs adaptador `server/scrapers/adapters/*`).
- Envía notificación de progreso tras cada adaptador completado (mecanismo
  configurado del entorno) y una notificación final con la tabla.

---

## 6) ERRORES COMUNES Y QUÉ SIGNIFICAN

| Síntoma | Causa probable |
|---|---|
| Modal abre pero `MEDIA_ERR_SRC_NOT_SUPPORTED` (código 4) | URL de página web colada como stream directo (isRawWebpage no cubrió ese dominio) |
| Loader infinito, consola con 403 del proxy | WAF del CDN rechazó headers → revisar/perfil en `server/hostProfiles.ts` |
| Video corre pero muestra Big Buck Bunny | Placeholder de VOE cuando el archivo real cayó (ya invalidado en ranking; si aparece, el sitio fuente tiene el archivo caído) |
| Failover automático múltiple y luego error | Todos los servers de ese episodio caídos hoy → probar otro episodio antes de marcar FAIL |
| `analyze` OK pero ▶️ no abre modal | Bug frontend: `onPlayHandler` / `all_available_streams` vacío en App.tsx |
