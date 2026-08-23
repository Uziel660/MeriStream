# 📋 Reporte E2E — Adaptador Cinecalidad (2026-08-22)

> Auditoría end-to-end del adaptador `server/scrapers/adapters/CinecalidadAdapter.ts`
> contra el sitio fuente `cinecalidad.am`, incluyendo diagnóstico de los errores
> observados en tráfico de red (403 goodstream/vimeos, status 0 en segmentos).

## 1. Estado del adaptador

**FIXEADO** — 1 bug real corregido dentro del territorio del adaptador.
El resto de fallos observados en red eran limitaciones externas o comportamiento
normal del player (detalle en §4).

## 2. Qué se probó

| # | Prueba | Resultado |
|---|---|---|
| 1 | `POST /api/v1/catalog/analyze` home (`https://www.cinecalidad.am/`) | ✅ `page_type=catalog`, **12 títulos** con poster TMDb, año, rating y géneros correctos |
| 2 | `analyze` ficha "La captura" (`/ver-pelicula/la-captura/`) | ✅ `page_type=detail`, episodio sintetizado para película + **6 streams detectados** (goodstream m3u8 resuelto JIT, voe.sx, doodstream, vimeos ×2, embed goodstream) |
| 3 | m3u8 goodstream con token recién generado | ✅ 200 — determinista según UA: Chrome/124 → 200, UA corto o sin UA → 403. El perfil ya existente en `server/hostProfiles.ts` lo cubre correctamente |
| 4 | `vimeos.net/d/{id}_h` (lo que entrega EmbedResolvers) | ❌ **página HTML de descarga** ("Descargar archivo azlpa-….mp4 · 1.0 GB"), NO es video. **Causa raíz de los fallos de reproducción de vimeos** |
| 5 | POST `op=download_orig&id={id}&mode=h&hash={hash}` sobre esa página | ✅ devuelve HTML con enlace MP4 directo firmado (`https://s{N}.vimeos.net/v/.../*.mp4?t=…`), verificado con curl y Node fetch |
| 6 | Token fresco del MP4 vimeos | ✅ 206 `video/mp4` con Range, sin referer, con referer externo (cinecalidad) e incluso referer de vimeos — acepta todo |
| 7 | Caducidad del token vimeos | ✅ estable al menos **4 minutos** (206 en t+0s, t+2min, t+4min). El 403 original del informe era un token viejo, no hotlink-protection por referer |
| 8 | Tests `tests/scrapers/CinecalidadAdapter.test.ts` | ✅ **5/5 pasan** (2 corridas, incluida una con la película Thunderbolts que rota el catálogo) |
| 9 | `npx tsc --noEmit` | ✅ limpio |
| 10 | Verificación E2E a nivel adaptador (tsx directo, 2 fichas) | ✅ **0 páginas `/d/` restantes** en `all_available_streams`; MP4 vimeos presente en ambas |

## 3. Cambios hechos

**Único archivo modificado:** `server/scrapers/adapters/CinecalidadAdapter.ts` (+94 / −5)

### 3.1 Nuevo método `resolveVimeosDirect(url)`

Resuelve el MP4 jugable a partir de la página `/d/{id}_h`:

```
1. GET  https://vimeos.net/d/{id}_h        → HTML con <input name="hash" value="...">
2. espera 600 ms
3. POST op=download_orig&id={id}&mode=h&hash={hash}
   → HTML con enlace directo https://s{N}.vimeos.net/v/.../*.mp4?...
```

**Hallazgo crítico documentado en el código:** el hash emitido por el GET queda
atado al perfil de headers de ESA petición. Si el GET lleva headers "de navegador"
(p.ej. `Accept-Language: es-ES`) y el POST no (o viceversa), el server responde 200
pero sirve la página SIN el enlace `.mp4`. Matriz verificada experimentalmente:

| GET | POST | ¿Enlace mp4? |
|---|---|---|
| mínimo (solo UA) | mínimo (UA + Referer + Content-Type) | ✅ 5/5 |
| común (UA+Accept+AL) | mínimo | ❌ |
| mínimo | con `Accept-Language` | ❌ |
| mínimo | con `Accept: */*` | ❌ |

Conclusión aplicada: **GET mínimo + POST mínimo**, idénticos entre sí salvo
Referer/Content-Type del POST. Además, con hash recién emitido (<500 ms) el POST
a veces devuelve la página sin enlace → pausa de 600 ms entre GET y POST.

### 3.2 Nuevo método `fixVimeosStreams(streams)`

Sustituye cada URL `vimeos.net/d/{id}_h` de una lista por su MP4 directo; las que
fallan al resolverse se descartan (una página HTML no es reproducible).

Se aplica **dos veces** dentro de `extractStream()`:

1. Sobre los candidatos crudos (hash-links Base64 + `li[data-option]`), porque ahí
   aparece directamente `/d/{id}_h`.
2. Sobre la lista tras `EmbedResolvers.resolve()`, porque el resolver mapea
   `vimeos.net/embed-{id}.html` → `/d/{id}_h` y reintroduce la página rota.

### 3.3 Resultado del fix (verificado)

Ficha "Thunderbolts" — antes: lista contenía `vimeos.net/d/i95917axjpz0_h`
(no reproducible). Después:

```
* https://hls1.goodstream.one/hls2/...master.m3u8?t=...   (HLS nativo)
* https://voe.sx/e/2oql3jphtn6z
* https://filemoon.sx/e/s4lakpzkignd
* https://s8.vimeos.net/v/02/00006/i95917axjpz0_h/....mkv.mp4?t=...   ← NUEVO (MP4 directo)
* https://vimeos.net/embed-i95917axjpz0.html
* https://goodstream.one/embed-h69meg3b372i.html
* https://hlswish.com/e/vq84ew362jli
```

Idéntico resultado positivo en "La captura" (`s9.vimeos.net/...mp4`).

## 4. Pendientes FUERA DE SCOPE (no tocados, requieren aprobación)

> ⚠️ Estos puntos quedaron detectados pero están fuera del territorio del adaptador.

1. **`server/resolvers.ts`** — su rama VIMEOS convierte `embed-{id}.html` → `/d/{id}_h`
   (página no jugable). El adaptador cinecalidad lo compensa localmente, pero cualquier
   OTRO sitio cuyos streams pasen por EmbedResolvers seguirá heredando el bug.
   *Cambio propuesto:* replicar allí el flujo `download_orig`.
2. **`src/components/HLSPlayerModal.tsx:318-322`** — el referer enviado al proxy para
   hosts no listados es siempre `https://animeflv.or.at/` (incluido cinecalidad).
   No rompe nada hoy (goodstream y vimeos ignoran el referer del proxy), pero explica
   el referer sospechoso visto en los logs de red y es semánticamente incorrecto.
3. **Peticiones canceladas (status 0)** del informe de tráfico: son cancelaciones
   normales del player HLS.js al hacer failover entre servidores durante la selección
   automática, no un bug del proxy ni del adaptador.

## 5. Limitaciones externas conocidas (NO son bugs del adaptador)

- **Goodstream**: el token HLS exige exactamente el UA Chrome/124 usado al pedir el
  embed (verificado por bisección). Ya cubierto por `HOST_PROFILES` (`refererMode:
  none`, UA fijo, client undici). Tokens caducan ~12 h → el diseño JIT lo cubre.
- **Vimeos**: tokens de MP4 caducan en minutos-a-horas (página dice 12 h; medido
  estable ≥4 min). JIT resuelve cada play → sin impacto.
- Los errores 403 de `enc8/enc9.goodstream.one` del informe original correspondían a
  peticiones con UA incorrecto o tokens ya consumidos/caducados.

## 6. Validación final

- `npx tsc --noEmit` → OK
- `npx vitest run tests/scrapers/CinecalidadAdapter.test.ts` → **5/5**
- E2E adaptador (tsx) en 2 fichas reales → MP4 vimeos resuelto, 0 páginas `/d/`
- Sin commits ni pushes (según reglas de la tarea)
- ⚠️ **Pendiente de reinicio del server**: el cambio vive en `server/scrapers/**` y el
  server corre con tsx SIN watch → hay que reiniciarlo para que `/api/v1/catalog/analyze`
  sirva el fix. No se reinició porque otras sesiones pueden estar usándolo.

---
*Reporte generado por ox-alpha — auditoría cinecalidad 2026-08-22.*
