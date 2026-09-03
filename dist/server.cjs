"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// server/scrapers/utils/jsUnpacker.ts
function unpackDeanEdwards(packed) {
  if (!packed || !packed.includes("eval(function(p,a,c,k,e,")) {
    return packed;
  }
  try {
    const anchored = packed.match(PACKED_ANCHORED_RE);
    if (anchored) {
      return substituteKeywords(anchored[2], anchored[3], anchored[4], anchored[5].split("|"));
    }
    const argsMatch = packed.match(PACKED_ARGS_RE);
    if (!argsMatch) return packed;
    const payloadMatch = argsMatch[1].trim().match(PACKED_ARGS_PAYLOAD_RE);
    if (!payloadMatch) return packed;
    return substituteKeywords(payloadMatch[1], payloadMatch[2], payloadMatch[3], payloadMatch[4].split("|"));
  } catch {
    return packed;
  }
}
function unpackPackedScript(code) {
  return unpackDeanEdwards(code);
}
function unpackGeneric(code) {
  if (!code) return "";
  let result = code;
  if (result.includes("eval(function(p,a,c,k,e,")) {
    result = unpackDeanEdwards(result);
  }
  if (result.includes("atob(")) {
    result = result.replace(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g, (_, b64) => {
      try {
        return Buffer.from(b64, "base64").toString("utf-8");
      } catch {
        return b64;
      }
    });
  }
  if (result.includes("\\x")) {
    result = result.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return hex;
      }
    });
  }
  return result;
}
function extractMediaUrlsFromCode(code) {
  if (!code) return [];
  const cleanCode = unpackGeneric(code);
  const urls = [];
  const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/gi;
  const mp4Regex = /https?:\/\/[^\s"'<>]+\.mp4(?:\?[^\s"'<>]*)?/gi;
  const m3u8Matches = cleanCode.match(m3u8Regex) || [];
  const mp4Matches = cleanCode.match(mp4Regex) || [];
  [...m3u8Matches, ...mp4Matches].forEach((url) => {
    const clean = url.replace(/\\/g, "").replace(/["']/g, "");
    if (clean.startsWith("http") && !urls.includes(clean)) {
      urls.push(clean);
    }
  });
  return urls;
}
var PACKED_ENCODE_CHARS, encodeBase, PACKED_ANCHORED_RE, PACKED_ARGS_RE, PACKED_ARGS_PAYLOAD_RE, substituteKeywords;
var init_jsUnpacker = __esm({
  "server/scrapers/utils/jsUnpacker.ts"() {
    "use strict";
    PACKED_ENCODE_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    encodeBase = (num, rad) => {
      let res = "";
      do {
        res = PACKED_ENCODE_CHARS[num % rad] + res;
        num = Math.floor(num / rad);
      } while (num > 0);
      return res || "0";
    };
    PACKED_ANCHORED_RE = /eval\(function\(p,a,c,k,e,[rd]\)\s*\{[\s\S]*?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\1([\s\S]*?)\1\.split\(\1\|\1\)/;
    PACKED_ARGS_RE = /eval\(function\(p,a,c,k,e,[rd]\)\s*\{.+?return p\}\s*\(([\s\S]+?)\)\s*\)/;
    PACKED_ARGS_PAYLOAD_RE = /^['"]([\s\S]+?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\(['"]\|['"]\)/;
    substituteKeywords = (payload, radixRaw, countRaw, keywords) => {
      const radix = parseInt(radixRaw, 10) || 10;
      const count = parseInt(countRaw, 10) || 0;
      const dict = {};
      for (let i = 0; i < count; i++) {
        const key = encodeBase(i, radix);
        dict[key] = keywords[i] || key;
      }
      return payload.replace(/\b\w+\b/g, (w) => {
        return Object.prototype.hasOwnProperty.call(dict, w) && dict[w] ? dict[w] : w;
      });
    };
  }
});

// server/hostProfiles.ts
function resolveHostProfile(targetUrl) {
  const lower = targetUrl.toLowerCase();
  for (const profile of HOST_PROFILES) {
    if (profile.match.some((m) => lower.includes(m))) return profile;
  }
  return DEFAULT_PROFILE;
}
function buildProxyHeaders(targetUrl, playerReferer, rangeHeader) {
  const profile = resolveHostProfile(targetUrl);
  let referer;
  switch (profile.refererMode) {
    case "none":
      referer = void 0;
      break;
    case "fixed":
      referer = profile.referer;
      break;
    default:
      referer = playerReferer;
  }
  const headers = {
    "User-Agent": profile.userAgent ?? DEFAULT_PROFILE.userAgent,
    ...referer ? { Referer: referer } : {},
    ...profile.extraHeaders
  };
  if (rangeHeader) headers.Range = rangeHeader;
  return { headers, profile };
}
var CHROME_124_UA, CHROME_120_UA, VIMEOS_REQUIRED_HEADERS, HOST_PROFILES, DEFAULT_PROFILE;
var init_hostProfiles = __esm({
  "server/hostProfiles.ts"() {
    "use strict";
    CHROME_124_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    CHROME_120_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    VIMEOS_REQUIRED_HEADERS = {
      "User-Agent": CHROME_124_UA,
      "Accept-Encoding": "identity"
    };
    HOST_PROFILES = [
      {
        // ZokoAnime HLS CDN: requests without the player Referer return 403.
        // The canonical embed is zokoanime.video, so pin that Referer for both
        // manifests and segments while keeping the lightweight undici client.
        match: ["hls2.aniwatchtv.uk"],
        refererMode: "fixed",
        referer: "https://zokoanime.video/",
        userAgent: CHROME_124_UA,
        client: "undici"
      },
      {
        // AnimeFLV / Playmudos / Ducvomes CDNs:
        // impit-client (Rust HTTP/2) sufre 'Remote protocol error occurred' con los
        // datanodes de ducvomes. undici (fetch estándar) pasa limpio y sin cortes.
        // Re-verificado en vivo 2026-08-24: master nika.playmudos.com responde 200
        // incluso SIN headers; los 403 de las 05:31 eran URLs sin token (?st=&e=
        // ausentes o expirados), no un cambio de headers del CDN.
        match: ["ducvomes.com", "playmudos.com"],
        refererMode: "passthrough",
        userAgent: CHROME_120_UA,
        client: "undici"
      },
      {
        // TurboViPlay/TurboSPlayer (cadena HLS de tioplus.app, verificado 2026-08-22):
        // hoy no validan Referer (200 con cualquiera), pero reciben uno ajeno
        // (animeflv.*) vía passthrough. Perfil preventivo: imitar al usuario legítimo
        // de tioplus.app antes de que activen hotlink-protection (patrón MP4Upload).
        match: ["turboviplay.com", "turbosplayer.com"],
        refererMode: "fixed",
        referer: "https://tioplus.app/"
      },
      {
        // Zilla Networks (2026-08-22): Cloudflare activó WAF sobre /segs/* que
        // rechaza con 403 toda request sin Sec-Fetch-Site; con "same-origin"
        // pasa incluso sin UA ni Referer. Verificado por bisección con curl.
        match: ["zilla-networks.com"],
        refererMode: "none",
        extraHeaders: {
          Accept: "*/*",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors"
        },
        client: "undici"
      },
      {
        // Goodstream: token firmado contra UA Chrome/124 exacto del embed; nginx
        // rechaza con 403 cualquier request CON Referer o sin headers fetch estándar.
        // impit (huella HTTP/2 Rust) también da 403 → undici sí pasa.
        match: ["goodstream.one"],
        refererMode: "none",
        userAgent: CHROME_124_UA,
        extraHeaders: {
          Accept: "*/*",
          "Accept-Language": "*",
          "Sec-Fetch-Mode": "cors"
        },
        client: "undici"
      },
      {
        // MP4Upload: hotlink-protection; exige Referer de su propio dominio
        // (referer del sitio fuente → 403; www.mp4upload.com → 206).
        match: ["mp4upload.com"],
        refererMode: "fixed",
        referer: "https://www.mp4upload.com/",
        userAgent: CHROME_120_UA,
        // TLS handshake puede tardar ~35s; el default de undici (10s) corta la
        // conexión antes de recibir respuesta (UND_ERR_CONNECT_TIMEOUT).
        connectTimeoutMs: 35e3
      },
      {
        // Vimeos (re-bisección en vivo 2026-08-24): el CDN ahora RECHAZA el combo
        // anterior (Origin+Referer vimeos.net) y exige UA Chrome completo +
        // Accept-Encoding, SIN Referer/Origin. El HEAD está prohibido (403 siempre,
        // body de 146 bytes con Content-Length que envenena la rama MP4 del proxy:
        // "El origen ignoró Range (status 403)"), así que VimeosResolver entrega
        // m3u8 validado y la reproducción va por la rama HLS (solo GET).
        match: ["vimeos.", "vimeos.zip", "vimeos.net"],
        refererMode: "none",
        userAgent: CHROME_124_UA,
        extraHeaders: {
          "Accept-Encoding": "identity"
        },
        client: "undici",
        connectTimeoutMs: 15e3
      },
      {
        // Acek-CDN y SprintCDN (CDNs HLS de Goodstream / Cinecalidad / LaMovie):
        // nginx rechaza peticiones con Referer ajeno y con TLS no estándar (impit).
        // Exige undici + Chrome UA + Accept-Encoding: identity + sin Referer.
        match: ["acek-cdn.com", "sprintcdn"],
        refererMode: "none",
        userAgent: CHROME_124_UA,
        extraHeaders: {
          "Accept-Encoding": "identity"
        },
        client: "undici"
      },
      {
        // DoodStream (2026-08-23, resolver pass_md5.sh): el CDN de entrega exige el
        // Referer del propio embed (hotlink-protection estándar del ecosistema dood:
        // dood.watch/dsvplay.com/d000d.com/dood.la). Sin verificación curl en vivo;
        // si el CDN lo rechaza, ajustar contra telemetría de proxy-network.jsonl.
        match: ["dood.", "doodstream", "dsvplay.com", "d000d.com", "ds2play.com", "do7go"],
        refererMode: "passthrough",
        userAgent: CHROME_124_UA,
        client: "undici"
      },
      {
        // Uqload (tier 1 VerAnimes): MP4 directo sin hotlink verificado; passthrough
        // conservador con UA Chrome/124 (perfil default pero cliente explícito).
        // Sin fundamento curl en vivo → se documenta como preventivo.
        match: ["uqload."],
        refererMode: "passthrough",
        userAgent: CHROME_124_UA,
        client: "undici"
      },
      {
        // VidHide (tier 3): mismo ecosistema packed que StreamWish; su CDN suele
        // validar Referer del embed propio. Passthrough + UA moderno, preventivo.
        match: ["vidhide", "vixhide"],
        refererMode: "passthrough",
        userAgent: CHROME_124_UA,
        client: "undici"
      }
    ];
    DEFAULT_PROFILE = {
      match: [],
      refererMode: "passthrough",
      userAgent: CHROME_120_UA
    };
  }
});

// server/scrapers/vimeosResolver.ts
var import_undici, VimeosResolver;
var init_vimeosResolver = __esm({
  "server/scrapers/vimeosResolver.ts"() {
    "use strict";
    import_undici = require("undici");
    init_jsUnpacker();
    init_resolvers();
    init_hostProfiles();
    VimeosResolver = class {
      constructor() {
      }
      /** Hosts de descarga directa (páginas HTML sin stream embebido): no intentar resolver */
      static DOWNLOAD_HOSTS = ["1fichier.com", "megaup.net"];
      static DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
      static EMBED_TIMEOUT_MS = 7500;
      /** Intentos de embed→validación antes de caer al POST download_orig. */
      static MAX_EMBED_ATTEMPTS = 8;
      /** Pausa entre intentos (ms): no martillar el edge mientras rota backends. */
      static RETRY_PAUSE_MS = 350;
      /** Detecta cualquier forma de URL de vimeos: embed-{id}.html, /e/{id}, /d/{id}_h */
      static isVimeosUrl(url) {
        return /vimeos\.[a-z]+\/(?:embed-[a-zA-Z0-9]+\.html|e\/[a-zA-Z0-9]+|d\/[a-zA-Z0-9]+_h)/i.test(
          (url || "").trim()
        );
      }
      static isDownloadHostUrl(url) {
        const lower = (url || "").toLowerCase();
        return this.DOWNLOAD_HOSTS.some((h) => lower.includes(h));
      }
      /**
       * Resuelve un embed de vimeos.net a un stream jugable VALIDADO:
       * desempaqueta el player del embed y prueba candidatos (.m3u8 primero) con
       * GET real + headers del perfil hasta dar con un token vivo. Fallback final:
       * MP4 del POST download_orig (hoy suele estar muerto; se mantiene por si el
       * CDN relaja). Devuelve [] si nada valida.
       */
      static async resolveVimeos(embedUrl) {
        const url = (embedUrl || "").trim();
        if (!url || this.isDownloadHostUrl(url)) return [];
        for (let attempt = 1; attempt <= this.MAX_EMBED_ATTEMPTS; attempt++) {
          const html = await this.fetchText(url, this.EMBED_TIMEOUT_MS);
          if (!html || html.includes("File is no longer available")) break;
          const unpacked = unpackPackedScript(html);
          const found = extractMediaUrlsFromCode(unpacked);
          for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)["']/gi)) found.push(m[1]);
          const candidates = [...new Set(found)].filter(
            (u) => (u.includes(".m3u8") || u.includes(".mp4")) && !EmbedResolvers.isPlaceholderUrl(u)
          ).sort((a, b) => Number(b.includes(".m3u8")) - Number(a.includes(".m3u8"))).slice(0, 2);
          for (const candidate of candidates) {
            if (await this.validateStreamUrl(candidate)) return [candidate];
          }
          if (attempt < this.MAX_EMBED_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, this.RETRY_PAUSE_MS));
          }
        }
        const direct = await this.resolveViaDownloadOrig(url);
        if (direct && await this.validateStreamUrl(direct)) return [direct];
        return [];
      }
      /**
       * Sustituye cada enlace `/d/{id}_h` de vimeos por su stream jugable validado.
       * Los que no se puedan resolver se eliminan (la página HTML no es reproducible);
       * las demás URLs pasan intactas, preservando orden y sin duplicados.
       */
      static async fixVimeosStreams(streams) {
        const out = [];
        for (const u of streams) {
          if (/vimeos\.[a-z]+\/d\/[a-zA-Z0-9]+_h/i.test(u)) {
            const resolved = await this.resolveVimeos(u);
            if (resolved.length > 0 && !out.includes(resolved[0])) out.push(resolved[0]);
          } else if (!out.includes(u)) {
            out.push(u);
          }
        }
        return out;
      }
      static toDownloadPageUrl(url) {
        const match = url.match(/vimeos\.([a-z]+)\/(?:embed-|e\/)([a-zA-Z0-9]+)/i) || url.match(/vimeos\.([a-z]+)\/d\/([a-zA-Z0-9]+)_h/i);
        return match ? `https://vimeos.${match[1]}/d/${match[2]}_h` : null;
      }
      /**
       * GET real contra el stream con los MISMOS headers que usará el proxy
       * (buildProxyHeaders). .mp4 → exige 206 con Range; .m3u8 → 200 plano.
       * Es el filtro que garantiza no entregar tokens muertos al player.
       */
      static async validateStreamUrl(streamUrl) {
        const isMp4 = /\.mp4(\?|$)/i.test(streamUrl);
        try {
          const { headers } = buildProxyHeaders(streamUrl, "https://vimeos.net/");
          const res = await (0, import_undici.request)(streamUrl, {
            method: "GET",
            headers: isMp4 ? { ...headers, Range: "bytes=0-1023" } : headers,
            headersTimeout: 7e3,
            bodyTimeout: 7e3
          });
          res.body.on("error", () => {
          });
          res.body.destroy();
          return isMp4 ? res.statusCode === 206 : res.statusCode === 200;
        } catch {
          return false;
        }
      }
      /** Último recurso histórico: hash del GET + POST op=download_orig → MP4 directo. */
      static async resolveViaDownloadOrig(anyVimeosUrl) {
        const pageUrl = this.toDownloadPageUrl(anyVimeosUrl);
        if (!pageUrl) return null;
        const idMatch = pageUrl.match(/vimeos\.[a-z]+\/d\/([a-zA-Z0-9]+)_h/i);
        if (!idMatch) return null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.EMBED_TIMEOUT_MS);
        try {
          const pageRes = await fetch(pageUrl, {
            signal: controller.signal,
            headers: { "User-Agent": this.DEFAULT_UA }
          });
          if (!pageRes.ok) return null;
          const pageHtml = await pageRes.text();
          if (pageHtml.includes("File is no longer available")) return null;
          const hashMatch = pageHtml.match(/name="hash"\s+value="([^"]+)"/);
          if (!hashMatch) return null;
          await new Promise((r) => setTimeout(r, 600));
          const postRes = await fetch(pageUrl, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "User-Agent": this.DEFAULT_UA,
              Referer: pageUrl,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
              op: "download_orig",
              id: idMatch[1],
              mode: "h",
              hash: hashMatch[1]
            }).toString()
          });
          if (!postRes.ok) return null;
          const postHtml = await postRes.text();
          const mp4 = postHtml.match(
            /https?:\/\/s\d+\.vimeos\.[a-z]+\/[^"'\\\s]+\.mp4\?[^"'\\\s]*/i
          );
          return mp4 ? mp4[0] : null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }
      static async fetchText(url, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": this.DEFAULT_UA }
          });
          if (!res.ok) return null;
          return await res.text();
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }
    };
  }
});

// server/resolvers/megaResolver.ts
function isMegaUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return MEGA_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return /^(https?:\/\/)?(www\.)?(mega\.nz|mega\.io|mega\.co\.nz)\//i.test(url.trim());
  }
}
function parseMegaUrl(url) {
  const raw = (url || "").trim();
  let u = null;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!MEGA_HOSTS.has(u.hostname.toLowerCase())) return null;
  const segments = u.pathname.split("/").filter(Boolean);
  const fragment = u.hash.replace(/^#/, "");
  const queryKey = u.searchParams.get("key") || "";
  const legacyMatch = /^!([A-Za-z0-9_-]{5,12})!([A-Za-z0-9_-]{22,66})$/.exec(fragment);
  if (legacyMatch && segments.length === 0) {
    return buildLink("file", legacyMatch[1], legacyMatch[2]);
  }
  if (segments[0] === "file" && segments[1] && (fragment || queryKey)) {
    return buildLink("file", segments[1], fragment || queryKey);
  }
  if (segments[0] === "folder" && segments[1] && (fragment || queryKey)) {
    return buildLink("folder", segments[1], fragment || queryKey);
  }
  if (segments[0] === "embed" && segments[1] && (fragment || queryKey)) {
    return buildLink("file", segments[1], fragment || queryKey);
  }
  if (segments[0] === "embed" && segments[1] && segments[1].startsWith("!")) {
    const embMatch = /^!([^!]+)!([^!]+)$/.exec(segments[1]);
    if (embMatch) return buildLink("file", embMatch[1], embMatch[2]);
  }
  if (segments.length === 1 && segments[0].startsWith("!")) {
    const m = /^!([^!]+)!([^!]+)$/.exec(segments[0]);
    if (m) return buildLink("file", m[1], m[2]);
  }
  return null;
}
function buildLink(kind, fileId, fileKey) {
  const base = kind === "file" ? "file" : "folder";
  return {
    kind,
    fileId,
    fileKey,
    canonicalUrl: `https://mega.nz/${base}/${fileId}#${fileKey}`,
    embedUrl: `https://mega.nz/embed/${fileId}#${fileKey}`
  };
}
var MEGA_HOSTS;
var init_megaResolver = __esm({
  "server/resolvers/megaResolver.ts"() {
    "use strict";
    MEGA_HOSTS = /* @__PURE__ */ new Set(["mega.nz", "mega.io", "mega.co.nz"]);
  }
});

// server/scrapers/utils/obscureResolvers.ts
async function fetchEmbedHtml(embedUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const referer = new URL(embedUrl).origin + "/";
    const res = await fetch(embedUrl, {
      signal: controller.signal,
      headers: { ...EMBED_HEADERS, Referer: referer }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
function inlineScriptsText(html) {
  try {
    const $ = cheerio.load(html);
    return $("script").not("[src]").map((_, el) => $(el).html() || "").get().join("\n");
  } catch {
    return "";
  }
}
function firstMediaUrl(urls) {
  return urls.find((u) => u.includes(".m3u8")) || urls.find((u) => u.includes(".mp4")) || null;
}
function extractDirectMedia(html) {
  try {
    const scripts = inlineScriptsText(html);
    for (const chunk of [scripts, html]) {
      const direct = firstMediaUrl(extractMediaUrlsFromCode(chunk));
      if (direct) return direct;
    }
    for (const script of scripts.split("\n")) {
      if (!script.includes("eval(function(p,a,c,k,e,")) continue;
      const unpacked = unpackDeanEdwards(script);
      if (unpacked === script) continue;
      const direct = firstMediaUrl(extractMediaUrlsFromCode(unpacked));
      if (direct) return direct;
    }
    const combined = `${scripts}
${html}`;
    const relRe = /(?<![:\w])\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/gi;
    for (const match of combined.match(relRe) || []) {
      const abs = `https:${match}`;
      if (abs.includes(".m3u8")) return abs;
    }
  } catch {
    return null;
  }
  return null;
}
async function resolveObscureEmbed(originalEmbedUrl, provider) {
  try {
    const html = await fetchEmbedHtml(originalEmbedUrl);
    if (html) {
      const direct = extractDirectMedia(html);
      if (direct) return { type: "direct", url: direct, provider };
    }
  } catch {
  }
  return { type: "iframe", url: originalEmbedUrl, provider };
}
async function resolveHexload(embedUrl) {
  return resolveObscureEmbed(embedUrl, "Hexload");
}
var cheerio, FETCH_TIMEOUT_MS, EMBED_HEADERS;
var init_obscureResolvers = __esm({
  "server/scrapers/utils/obscureResolvers.ts"() {
    "use strict";
    cheerio = __toESM(require("cheerio"), 1);
    init_jsUnpacker();
    FETCH_TIMEOUT_MS = 8e3;
    EMBED_HEADERS = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    };
  }
});

// server/networkLogger.ts
function resolveRegisteredProvider(targetUrl, referer) {
  const u = (targetUrl || "").toLowerCase();
  const ref = (referer || "").toLowerCase();
  if (u.includes("mega.nz") || u.includes("mega.co") || u.includes("/stream/mega")) {
    return { providerName: "MEGA Cloud", category: "MEGA", isEmbed: false };
  }
  if (u.includes("ducvomes.com") || u.includes("playmudos.com") || u.includes("animeflv.net") || ref.includes("animeflv")) {
    return { providerName: "AnimeFLV (HLS)", category: "HLS Nativo", isEmbed: false };
  }
  if (u.includes("streamwish") || u.includes("dramiyos.com") || u.includes("premilky.com") || u.includes("wishembed") || u.includes("strwish") || u.includes("streamwis")) {
    return { providerName: "Streamwish", category: "CDN Video", isEmbed: u.includes("/e/") || u.includes("/embed") };
  }
  if (u.includes("voe.sx") || u.includes("voe.") || u.includes("byselapuix") || u.includes("yodabox") || u.includes("tuktukbox") || u.includes("launchprotective")) {
    return { providerName: "VOE (HighSpeed)", category: "Embed con Anuncios", isEmbed: true };
  }
  if (u.includes("goodstream.one") || u.includes("goodstream")) {
    return { providerName: "Goodstream HD", category: "HLS Nativo", isEmbed: false };
  }
  if (u.includes("zilla-networks.com") || u.includes("player.zilla-networks")) {
    return { providerName: "Zilla Networks", category: "HLS Nativo", isEmbed: false };
  }
  if (u.includes("mp4upload.com")) {
    return { providerName: "MP4Upload", category: "MP4 Directo", isEmbed: u.includes("/embed") };
  }
  if (u.includes("filemoon") || u.includes("moonplayer") || u.includes("filemooon")) {
    return { providerName: "Filemoon HD", category: "Embed con Anuncios", isEmbed: true };
  }
  if (u.includes("mixdrop.co") || u.includes("mixdrop.to") || u.includes("mixdrop")) {
    return { providerName: "Mixdrop", category: "Embed con Anuncios", isEmbed: true };
  }
  if (u.includes("dood") || u.includes("ds2play") || u.includes("doodstream")) {
    return { providerName: "Doodstream", category: "Embed con Anuncios", isEmbed: true };
  }
  if (u.includes("turboviplay.com") || u.includes("turbosplayer.com") || ref.includes("tioplus")) {
    return { providerName: "TurboViPlay (TioPlus)", category: "HLS Nativo", isEmbed: false };
  }
  if (u.includes("yourupload.com")) {
    return { providerName: "YourUpload", category: "Embed con Anuncios", isEmbed: true };
  }
  if (u.includes("vidmoly.to") || u.includes("vidmoly.me") || u.includes("vidmoly")) {
    return { providerName: "Vidmoly", category: "Embed con Anuncios", isEmbed: true };
  }
  if (u.includes("archive.org")) {
    return { providerName: "Archive.org", category: "MP4 Directo", isEmbed: false };
  }
  if (u.includes("googleapis.com") || u.includes("mux.dev")) {
    return { providerName: "Google Fast Direct", category: "MP4 Directo", isEmbed: false };
  }
  if (u.includes(".m3u8") || u.includes("mpegurl")) {
    const host2 = extractHost(targetUrl);
    return { providerName: `HLS (${host2})`, category: "HLS Nativo", isEmbed: false };
  }
  const host = extractHost(targetUrl);
  return { providerName: host, category: "CDN Video", isEmbed: false };
}
function maskSignedTokens(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    for (const key of Array.from(parsed.searchParams.keys())) {
      const lower = key.toLowerCase();
      if ([
        "t",
        "token",
        "jwt",
        "s",
        "e",
        "st",
        "sig",
        "signature",
        "auth",
        "hash",
        "key",
        "secret",
        "hdnts",
        "access_token",
        "authorization"
      ].includes(lower)) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/([?&](?:token|t|jwt|s|e|st|sig|signature|auth|hash)=)[^&]+/gi, "$1***");
  }
}
function formatTimestampForFile(date = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}
function extractHost(url) {
  try {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return new URL(url).hostname;
    }
    return url.split("/")[0] || "unknown";
  } catch {
    return "unknown";
  }
}
function classifyResource(url) {
  const lower = url.toLowerCase();
  if (lower.includes("mega.nz") || lower.includes("/stream/mega")) return "mega";
  if (lower.includes(".m3u8") || lower.includes("mpegurl")) return "m3u8";
  if (lower.includes(".ts") || lower.includes(".m4s") || lower.includes("/segs/") || lower.includes("/m3u8/"))
    return "segment";
  if (lower.includes(".mp4")) return "mp4";
  return "other";
}
function classifyError(status, errorMsg) {
  if (!errorMsg && status >= 200 && status < 400) return "none";
  if (status === 429 || errorMsg?.includes("429") || /cuota|quota|etempunavail/i.test(errorMsg || ""))
    return "quota_429";
  if (errorMsg?.includes("TIMEOUT") || errorMsg?.includes("timeout"))
    return "timeout";
  if (errorMsg?.includes("ENOTFOUND") || errorMsg?.includes("no resoluble"))
    return "dns";
  if (errorMsg?.includes("ECONNREFUSED") || errorMsg?.includes("ECONNRESET") || errorMsg?.includes("UND_ERR"))
    return "connection";
  if (status >= 400 && status < 500) return "http_4xx";
  if (status >= 500) return "http_5xx";
  if (errorMsg?.includes("incompleto") || errorMsg?.includes("corrupt"))
    return "stream_corrupt";
  return "connection";
}
function logProxyRequest(data) {
  const sanitizedUrl = maskSignedTokens(data.targetUrl);
  const info = resolveRegisteredProvider(data.targetUrl, data.referer);
  const entry = {
    id: nextProxyId++,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    targetUrl: sanitizedUrl,
    host: extractHost(data.targetUrl),
    providerName: data.provider || info.providerName,
    category: info.category,
    mediaTitle: data.mediaTitle,
    resourceType: classifyResource(data.targetUrl),
    upstreamStatus: data.upstreamStatus,
    ok: data.upstreamStatus >= 200 && data.upstreamStatus < 400 && !data.error,
    durationMs: data.durationMs,
    bytesReceived: data.bytesReceived,
    error: data.error,
    errorType: classifyError(data.upstreamStatus, data.error),
    referer: data.referer,
    client: data.client
  };
  const line = JSON.stringify(entry) + "\n";
  proxyWriteStream.write(line);
  if (sessionWriteStream && !sessionWriteStream.destroyed) {
    sessionWriteStream.write(JSON.stringify({ type: "network", ...entry }) + "\n");
  }
  return entry;
}
function logPlayerEvent(data) {
  const sanitizedUrl = maskSignedTokens(data.serverUrl);
  const host = extractHost(data.serverUrl);
  const info = resolveRegisteredProvider(data.serverUrl);
  const provider = data.provider || info.providerName || host;
  const entry = {
    id: nextPlayerId++,
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    eventType: data.eventType,
    provider,
    serverUrl: sanitizedUrl,
    host,
    playback_attempt_id: data.playback_attempt_id,
    mediaTitle: data.mediaTitle,
    episodeTitle: data.episodeTitle,
    durationBeforeErrorMs: data.durationBeforeErrorMs,
    bufferPauseCount: data.bufferPauseCount,
    status: data.status,
    reason: data.reason,
    details: data.details
  };
  const line = JSON.stringify(entry) + "\n";
  playerWriteStream.write(line);
  if (sessionWriteStream && !sessionWriteStream.destroyed) {
    sessionWriteStream.write(JSON.stringify({ type: "player", ...entry }) + "\n");
  }
  return entry;
}
function getHostStats() {
  const entries = readAllProxyEntries();
  const byProvider = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = entry.providerName || entry.host;
    const existing = byProvider.get(key);
    if (existing) existing.push(entry);
    else byProvider.set(key, [entry]);
  }
  const stats = [];
  for (const [provider, entries2] of byProvider) {
    const successes = entries2.filter((e) => e.ok).length;
    const failures = entries2.length - successes;
    const totalDuration = entries2.reduce((s, e) => s + e.durationMs, 0);
    const totalBytes = entries2.reduce((s, e) => s + e.bytesReceived, 0);
    const errorBreakdown = {};
    for (const e of entries2) {
      if (e.errorType && e.errorType !== "none") {
        errorBreakdown[e.errorType] = (errorBreakdown[e.errorType] || 0) + 1;
      }
    }
    const resourceBreakdown = {};
    for (const e of entries2) {
      if (!resourceBreakdown[e.resourceType]) {
        resourceBreakdown[e.resourceType] = { total: 0, ok: 0, fail: 0 };
      }
      resourceBreakdown[e.resourceType].total++;
      if (e.ok) resourceBreakdown[e.resourceType].ok++;
      else resourceBreakdown[e.resourceType].fail++;
    }
    stats.push({
      host: entries2[0].host,
      providerName: provider,
      category: entries2[0].category,
      totalRequests: entries2.length,
      successes,
      failures,
      successRate: entries2.length > 0 ? Math.round(successes / entries2.length * 100) : 0,
      avgDurationMs: entries2.length > 0 ? Math.round(totalDuration / entries2.length) : 0,
      totalBytes,
      errorBreakdown,
      resourceBreakdown,
      firstSeen: entries2[0].ts,
      lastSeen: entries2[entries2.length - 1].ts
    });
  }
  stats.sort((a, b) => b.totalRequests - a.totalRequests);
  return stats;
}
function getProviderHealthStats() {
  const events = readAllPlayerEntries();
  const byProvider = /* @__PURE__ */ new Map();
  for (const ev of events) {
    const key = ev.provider || "Desconocido";
    const existing = byProvider.get(key);
    if (existing) existing.push(ev);
    else byProvider.set(key, [ev]);
  }
  const results = [];
  for (const [provider, evs] of byProvider) {
    const successfulPlays = evs.filter((e) => e.eventType === "playback_started" || e.eventType === "embed_opened").length;
    const blackScreens = evs.filter((e) => e.eventType === "black_screen_stalled").length;
    const bufferingStalls = evs.filter((e) => e.eventType === "playback_buffering").length;
    const fatalErrors = evs.filter((e) => e.eventType === "playback_error").length;
    const failovers = evs.filter((e) => e.eventType === "failover_auto" || e.eventType === "quota_fallback").length;
    const totalAttempts = successfulPlays + blackScreens + fatalErrors;
    const playEvents = evs.filter((e) => e.eventType === "playback_started" && e.durationBeforeErrorMs);
    const avgTimeToPlayMs = playEvents.length > 0 ? Math.round(playEvents.reduce((s, e) => s + (e.durationBeforeErrorMs || 0), 0) / playEvents.length) : 0;
    const isEmbed = evs.some((e) => e.eventType === "embed_opened");
    let status = "EXCELENTE";
    if (blackScreens > 0 && successfulPlays === 0) {
      status = "MUERTO (PANTALLA NEGRA)";
    } else if (blackScreens > 0 || fatalErrors > 0 || bufferingStalls >= 3) {
      status = "INESTABLE (PAUSAS/STALLS)";
    } else if (isEmbed) {
      status = "ACEPTABLE (LENTO/ANUNCIOS)";
    }
    results.push({
      provider,
      category: isEmbed ? "Embed con Anuncios" : "Stream Nativo",
      totalAttempts: totalAttempts || evs.length,
      successfulPlays,
      blackScreens,
      bufferingStalls,
      fatalErrors,
      failovers,
      avgTimeToPlayMs,
      status,
      recentEvents: evs.slice(-6)
    });
  }
  results.sort((a, b) => b.totalAttempts - a.totalAttempts);
  return results;
}
function getRecentLogs(limit = 100) {
  const all = readAllProxyEntries();
  return all.slice(-limit);
}
function getRecentPlayerEvents(limit = 100) {
  const all = readAllPlayerEntries();
  return all.slice(-limit);
}
function readAllProxyEntries() {
  try {
    if (!import_fs.default.existsSync(PROXY_LOG_FILE)) return [];
    const content = import_fs.default.readFileSync(PROXY_LOG_FILE, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
function readAllPlayerEntries() {
  try {
    if (!import_fs.default.existsSync(PLAYER_LOG_FILE)) return [];
    const content = import_fs.default.readFileSync(PLAYER_LOG_FILE, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
function clearLogs() {
  proxyWriteStream.end();
  playerWriteStream.end();
  import_fs.default.writeFileSync(PROXY_LOG_FILE, "");
  import_fs.default.writeFileSync(PLAYER_LOG_FILE, "");
  proxyWriteStream = import_fs.default.createWriteStream(PROXY_LOG_FILE, { flags: "a" });
  playerWriteStream = import_fs.default.createWriteStream(PLAYER_LOG_FILE, { flags: "a" });
  nextProxyId = 1;
  nextPlayerId = 1;
}
function getLogFilePaths() {
  return {
    proxyLog: PROXY_LOG_FILE,
    playerLog: PLAYER_LOG_FILE
  };
}
var import_fs, import_path, LOG_DIR, SESSIONS_DIR, PROXY_LOG_FILE, PLAYER_LOG_FILE, currentSessionId, currentSessionFile, proxyWriteStream, playerWriteStream, sessionWriteStream, nextProxyId, nextPlayerId;
var init_networkLogger = __esm({
  "server/networkLogger.ts"() {
    "use strict";
    import_fs = __toESM(require("fs"), 1);
    import_path = __toESM(require("path"), 1);
    LOG_DIR = import_path.default.resolve("logs");
    SESSIONS_DIR = import_path.default.join(LOG_DIR, "sessions");
    PROXY_LOG_FILE = import_path.default.join(LOG_DIR, "proxy-network.jsonl");
    PLAYER_LOG_FILE = import_path.default.join(LOG_DIR, "player-events.jsonl");
    if (!import_fs.default.existsSync(LOG_DIR)) import_fs.default.mkdirSync(LOG_DIR, { recursive: true });
    if (!import_fs.default.existsSync(SESSIONS_DIR)) import_fs.default.mkdirSync(SESSIONS_DIR, { recursive: true });
    currentSessionId = formatTimestampForFile();
    currentSessionFile = import_path.default.join(SESSIONS_DIR, `session_${currentSessionId}.jsonl`);
    proxyWriteStream = import_fs.default.createWriteStream(PROXY_LOG_FILE, { flags: "a" });
    playerWriteStream = import_fs.default.createWriteStream(PLAYER_LOG_FILE, { flags: "a" });
    sessionWriteStream = import_fs.default.createWriteStream(currentSessionFile, { flags: "a" });
    nextProxyId = 1;
    nextPlayerId = 1;
  }
});

// server/resolvers/doodstreamResolver.ts
function isDoodstreamUrl(url) {
  const u = String(url || "").toLowerCase();
  return u.includes("dood.") || u.includes("dsvplay") || u.includes("d000d.") || u.includes("ds2play") || u.includes("do7go") || u.includes("dooood");
}
function buildEmbedHeaders(refererOrigin) {
  return {
    "User-Agent": CHROME_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: refererOrigin
  };
}
async function fetchWith(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS2);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}
async function resolveDoodstream(embedUrl) {
  const provider = "DoodStream";
  try {
    if (!isDoodstreamUrl(embedUrl)) {
      return { type: "embed", url: embedUrl, provider };
    }
    const origin = new URL(embedUrl).origin;
    const embedReferer = `${origin}/`;
    const htmlRes = await fetchWith(embedUrl, buildEmbedHeaders(embedReferer));
    if (!htmlRes.ok || !htmlRes.text) {
      logPlayerEvent({
        eventType: "embed_unresolvable",
        provider,
        serverUrl: embedUrl,
        details: `doodstream: embed HTTP ${htmlRes.status}`
      });
      return { type: "embed", url: embedUrl, provider };
    }
    const md5Match = htmlRes.text.match(/\/pass_md5\.sh\/[A-Za-z0-9]+\/[A-Za-z0-9]+/);
    if (!md5Match) {
      logPlayerEvent({
        eventType: "embed_unresolvable",
        provider,
        serverUrl: embedUrl,
        details: "doodstream: sin /pass_md5.sh en embed"
      });
      return { type: "embed", url: embedUrl, provider };
    }
    const md5Res = await fetchWith(`${origin}${md5Match[0]}`, buildEmbedHeaders(embedReferer));
    let direct = md5Res.ok ? md5Res.text.trim() : "";
    if (!direct.startsWith("http")) {
      return { type: "embed", url: embedUrl, provider };
    }
    const token = crypto.createHash("md5").update("support@dood.la").digest("hex");
    const sep = direct.includes("?") ? "&" : "?";
    direct = `${direct}${sep}token=${token}&expiry=${Date.now() + 36e5}`;
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), FETCH_TIMEOUT_MS2);
    try {
      let status = 0;
      let contentType = "";
      const head = await fetch(direct, {
        method: "HEAD",
        signal: headController.signal,
        headers: { "User-Agent": CHROME_UA, Referer: embedReferer }
      });
      status = head.status;
      contentType = head.headers.get("content-type") || "";
      if (status === 405) {
        const probe = await fetch(direct, {
          method: "GET",
          headers: { "User-Agent": CHROME_UA, Referer: embedReferer, Range: "bytes=0-1" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS2)
        });
        status = probe.status;
        contentType = probe.headers.get("content-type") || "";
        probe.body?.cancel().catch(() => {
        });
      }
      const playable = (status === 200 || status === 206) && (contentType.startsWith("video/") || contentType.includes("octet-stream") || contentType === "");
      if (!playable) {
        return { type: "embed", url: embedUrl, provider };
      }
    } catch {
    } finally {
      clearTimeout(headTimer);
    }
    return { type: "direct", url: direct, provider };
  } catch {
    return { type: "embed", url: embedUrl, provider };
  }
}
var crypto, FETCH_TIMEOUT_MS2, CHROME_UA;
var init_doodstreamResolver = __esm({
  "server/resolvers/doodstreamResolver.ts"() {
    "use strict";
    crypto = __toESM(require("crypto"), 1);
    init_networkLogger();
    FETCH_TIMEOUT_MS2 = 8e3;
    CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
});

// server/resolvers/uqloadResolver.ts
function isUqloadUrl(url) {
  return String(url || "").toLowerCase().includes("uqload");
}
async function fetchEmbedHtml2(embedUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS3);
  try {
    const res = await fetch(embedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": CHROME_UA2,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${new URL(embedUrl).origin}/`
      }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function resolveUqload(embedUrl) {
  const provider = "Uqload";
  try {
    if (!isUqloadUrl(embedUrl)) return { type: "embed", url: embedUrl, provider };
    const html = await fetchEmbedHtml2(embedUrl);
    if (!html) return { type: "embed", url: embedUrl, provider };
    const unpacked = unpackGeneric(html);
    const sourceMatch = unpacked.match(/sources\s*[:=]\s*\[?\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) || unpacked.match(/file\s*[:=]\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) || unpacked.match(/["'](https?:\/\/[^"']+\/v\/[^"']+\.mp4[^"']*)["']/i);
    if (sourceMatch) return { type: "direct", url: sourceMatch[1], provider };
    const media = extractMediaUrlsFromCode(html);
    const mp4 = media.find((u) => u.includes(".mp4")) || media.find((u) => u.includes(".m3u8"));
    if (mp4) return { type: "direct", url: mp4, provider };
    return { type: "embed", url: embedUrl, provider };
  } catch {
    return { type: "embed", url: embedUrl, provider };
  }
}
var FETCH_TIMEOUT_MS3, CHROME_UA2;
var init_uqloadResolver = __esm({
  "server/resolvers/uqloadResolver.ts"() {
    "use strict";
    init_jsUnpacker();
    FETCH_TIMEOUT_MS3 = 8e3;
    CHROME_UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
});

// server/resolvers/vidhideResolver.ts
function isVidhideUrl(url) {
  const u = String(url || "").toLowerCase();
  return u.includes("vidhide") || u.includes("vixhide") || u.includes("vid-hide");
}
async function fetchEmbedHtml3(embedUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS4);
  try {
    const res = await fetch(embedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": CHROME_UA3,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${new URL(embedUrl).origin}/`
      }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function pickStream(urls) {
  return urls.find((u) => u.includes(".m3u8")) || urls.find((u) => u.includes(".mp4")) || null;
}
async function resolveVidhide(embedUrl) {
  const provider = "VidHide";
  try {
    if (!isVidhideUrl(embedUrl)) return { type: "embed", url: embedUrl, provider };
    const html = await fetchEmbedHtml3(embedUrl);
    if (!html) {
      logPlayerEvent({
        eventType: "embed_unresolvable",
        provider,
        serverUrl: embedUrl,
        details: "vidhide: embed sin respuesta OK"
      });
      return { type: "embed", url: embedUrl, provider };
    }
    const unpacked = unpackGeneric(html);
    const declared = unpacked.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/i) || unpacked.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) || unpacked.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    if (declared) return { type: "direct", url: declared[1], provider };
    const picked = pickStream(extractMediaUrlsFromCode(unpacked)) || pickStream(extractMediaUrlsFromCode(html));
    if (picked) return { type: "direct", url: picked, provider };
    logPlayerEvent({
      eventType: "embed_unresolvable",
      provider,
      serverUrl: embedUrl,
      details: "vidhide: sin sources tras unpack"
    });
    return { type: "embed", url: embedUrl, provider };
  } catch {
    return { type: "embed", url: embedUrl, provider };
  }
}
var FETCH_TIMEOUT_MS4, CHROME_UA3;
var init_vidhideResolver = __esm({
  "server/resolvers/vidhideResolver.ts"() {
    "use strict";
    init_jsUnpacker();
    init_networkLogger();
    FETCH_TIMEOUT_MS4 = 8e3;
    CHROME_UA3 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
});

// server/resolutionMetadata.ts
function toEpochMs(value) {
  if (value === void 0 || value === "" || !/^\d+(?:\.\d+)?$/.test(String(value))) return void 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return void 0;
  const ms = numeric < 1e11 ? Math.round(numeric * 1e3) : Math.round(numeric);
  return ms >= MIN_PLAUSIBLE_EXPIRY_MS && ms <= MAX_PLAUSIBLE_EXPIRY_MS ? ms : void 0;
}
function jwtExpiration(value) {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[1].length > 8192) return void 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return toEpochMs(typeof payload.exp === "number" || typeof payload.exp === "string" ? payload.exp : void 0);
  } catch {
    return void 0;
  }
}
function parseStreamExpiry(url) {
  try {
    const parsed = new URL(url);
    const sParam = parsed.searchParams.get("s");
    const eParam = parsed.searchParams.get("e");
    const isVimeos = /(^|\.)vimeos\.[a-z]+$/i.test(parsed.hostname);
    if (sParam && eParam) {
      const sNum = Number(sParam);
      const eNum = Number(eParam);
      if (Number.isFinite(sNum) && Number.isFinite(eNum) && sNum > 0 && eNum > 0) {
        const expiresAt = toEpochMs(sNum + eNum);
        if (expiresAt) return { expiresAt, source: "query" };
      }
    }
    for (const key of ["expires", "expiry", "exp", ...isVimeos ? [] : ["e"]]) {
      const value = parsed.searchParams.get(key);
      const expiresAt = value ? toEpochMs(value) : void 0;
      if (expiresAt) return { expiresAt, source: "query" };
    }
    for (const key of ["token", "jwt", "access_token", "authorization"]) {
      const value = parsed.searchParams.get(key);
      const expiresAt = value ? jwtExpiration(value.replace(/^Bearer\s+/i, "")) : void 0;
      if (expiresAt) return { expiresAt, source: "jwt" };
    }
  } catch {
  }
  return {};
}
function providerSoftTtlMs(provider, upstreamUrl) {
  const identity = `${provider} ${upstreamUrl}`.toLowerCase();
  if (identity.includes("vimeos")) return 5 * 60 * 1e3;
  if (/dood|voe|streamwish|vidhide|uqload|byse/.test(identity)) return 8 * 60 * 1e3;
  return 12 * 60 * 1e3;
}
function createResolutionTiming(input) {
  const resolvedAt = input.now ?? Date.now();
  const explicit = parseStreamExpiry(input.upstreamUrl);
  const expiresAt = explicit.expiresAt ?? resolvedAt + providerSoftTtlMs(input.provider, input.upstreamUrl);
  const remaining = Math.max(0, expiresAt - resolvedAt);
  const refreshAfter = Math.max(resolvedAt, expiresAt - Math.min(6e4, Math.max(5e3, Math.floor(remaining * 0.2))));
  const resolutionId = input.resolutionId ?? crypto2.randomUUID();
  return {
    original_url: input.originalUrl,
    resolved_at: resolvedAt,
    expires_at: expiresAt,
    refresh_after: refreshAfter,
    resolution_id: resolutionId,
    generation: resolutionId,
    expiration_source: explicit.source ?? "provider-soft-ttl"
  };
}
function isDirectMedia(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u) || u.includes("/m3u8/") || u.includes("hls-vod");
}
function hasSignedQuery(url) {
  try {
    const params = new URL(url).searchParams;
    const sParam = params.get("s");
    const eParam = params.get("e");
    if (sParam && eParam) {
      const sNum = Number(sParam);
      const eNum = Number(eParam);
      if (Number.isFinite(sNum) && Number.isFinite(eNum) && sNum > 0 && eNum > 0) return true;
    }
    return [
      "t",
      "token",
      "jwt",
      "access_token",
      "authorization",
      "expires",
      "expiry",
      "exp",
      "sig",
      "signature",
      "hash",
      "auth",
      "hdnts",
      "policy",
      "key-pair-id"
    ].some((key) => params.has(key));
  } catch {
    return false;
  }
}
function classifySourceKind(url) {
  const clean = (url || "").trim();
  if (!clean) return "page";
  if (isDirectMedia(clean)) {
    const { expiresAt } = parseStreamExpiry(clean);
    if (expiresAt !== void 0 || hasSignedQuery(clean)) {
      return "ephemeral_direct";
    }
    return "stable_direct";
  }
  const lower = clean.toLowerCase();
  if (lower.includes("/embed") || lower.includes("/e/") || lower.includes("/v/") || lower.includes("/d/") || lower.includes("mega.nz") || lower.includes("vimeos.") || lower.includes("mp4upload.com") || lower.includes("yourupload.com") || lower.includes("ok.ru") || lower.includes("voe.sx") || lower.includes("voe.") || lower.includes("primeload.co") || lower.includes("byse") || lower.includes("hexload") || lower.includes("streamtape") || lower.includes("streamwish") || lower.includes("dood") || lower.includes("uqload") || lower.includes("vidhide") || lower.includes("goodstream") || lower.includes("fastre") || lower.includes("swhoi") || lower.includes("vidmoly") || lower.includes("upstream") || lower.includes("streamhide") || lower.includes("waaw") || lower.includes("hqq.") || lower.includes("divxplayer") || lower.includes("cvary.org")) {
    return "embed";
  }
  return "page";
}
var crypto2, MIN_PLAUSIBLE_EXPIRY_MS, MAX_PLAUSIBLE_EXPIRY_MS;
var init_resolutionMetadata = __esm({
  "server/resolutionMetadata.ts"() {
    "use strict";
    crypto2 = __toESM(require("crypto"), 1);
    MIN_PLAUSIBLE_EXPIRY_MS = Date.UTC(2020, 0, 1);
    MAX_PLAUSIBLE_EXPIRY_MS = Date.UTC(2100, 0, 1);
  }
});

// server/resolvers/zokoanimeResolver.ts
function isZokoAnimeUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host === ZOKO_HOST || host.endsWith(`.${ZOKO_HOST}`);
  } catch {
    return false;
  }
}
function decodePayload(blob) {
  try {
    const bytes = Buffer.from(blob, "base64");
    const decoded = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      decoded[i] = bytes[i] ^ ZOKO_KEY.charCodeAt(i % ZOKO_KEY.length);
    }
    const value = JSON.parse(new TextDecoder().decode(decoded));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function asString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function asSubtitles(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry;
    const src = asString(item.src);
    if (!src || !/^https?:\/\//i.test(src)) return [];
    return [{
      src,
      lang: asString(item.lang),
      label: asString(item.label),
      default: item.default === true
    }];
  });
}
async function resolveZokoAnime(embedUrl, options = {}) {
  const fail = () => ({
    url: "",
    subtitles: [],
    requiredHeaders: { ...ZOKO_REQUIRED_HEADERS }
  });
  const cleanUrl2 = typeof embedUrl === "string" ? embedUrl.trim() : "";
  if (!cleanUrl2 || !isZokoAnimeUrl(cleanUrl2)) return fail();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1e3, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(cleanUrl2, {
      signal: controller.signal,
      headers: {
        ...ZOKO_FETCH_HEADERS,
        Referer: ZOKO_REFERER
      }
    });
    if (!response.ok) return fail();
    const html = await response.text();
    const token = html.match(/window\.__P\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!token) return fail();
    const payload = decodePayload(token);
    const mediaUrl = asString(payload?.src);
    if (!mediaUrl || !/^https:\/\//i.test(mediaUrl) || !/\.(?:m3u8|mp4|webm)(?:[?#]|$)/i.test(mediaUrl)) {
      return fail();
    }
    return {
      url: mediaUrl,
      subtitles: asSubtitles(payload?.subtitles),
      title: asString(payload?.title),
      requiredHeaders: { ...ZOKO_REQUIRED_HEADERS }
    };
  } catch {
    return fail();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
var ZOKO_HOST, ZOKO_KEY, DEFAULT_TIMEOUT_MS, ZOKO_REFERER, ZOKO_FETCH_HEADERS, ZOKO_REQUIRED_HEADERS;
var init_zokoanimeResolver = __esm({
  "server/resolvers/zokoanimeResolver.ts"() {
    "use strict";
    ZOKO_HOST = "zokoanime.video";
    ZOKO_KEY = "otaku-embed-v1";
    DEFAULT_TIMEOUT_MS = 8e3;
    ZOKO_REFERER = "https://zokoanime.video/";
    ZOKO_FETCH_HEADERS = {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    };
    ZOKO_REQUIRED_HEADERS = {
      Referer: ZOKO_REFERER
    };
  }
});

// server/resolvers/hianimesResolver.ts
function isHianimesUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host === HIANIMES_HOST || host.endsWith(`.${HIANIMES_HOST}`);
  } catch {
    return false;
  }
}
function isHianimesWatchUrl(rawUrl) {
  try {
    return isHianimesUrl(rawUrl) && new URL(rawUrl).pathname.toLowerCase().startsWith("/watch/");
  } catch {
    return false;
  }
}
function hianimesSlugFromUrl(rawUrl) {
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part.toLowerCase() === "watch" || part.toLowerCase() === "details");
    const slug = index >= 0 ? parts[index + 1] : void 0;
    return slug ? decodeURIComponent(slug).trim() : void 0;
  } catch {
    return void 0;
  }
}
function asString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = asString2(entry);
    return text ? [text] : [];
  });
}
function asLinkSet(value) {
  const record = value && typeof value === "object" ? value : {};
  const clean = (entry) => asStringArray(entry).filter((url) => /^https?:\/\//i.test(url));
  return { sub: clean(record.sub), dub: clean(record.dub) };
}
function asEpisode(value) {
  if (!value || typeof value !== "object") return void 0;
  const item = value;
  const slug = asString2(item.slug) || asString2(Array.isArray(item.slugs) ? item.slugs[0] : void 0);
  if (!slug) return void 0;
  const number = typeof item.episodeNumber === "number" && Number.isFinite(item.episodeNumber) ? item.episodeNumber : Number.parseInt(asString2(item.episodeNumber) || "", 10);
  return {
    slug,
    title: asString2(item.title) || `Episode ${Number.isFinite(number) && number > 0 ? number : 1}`,
    episodeNumber: Number.isFinite(number) && number > 0 ? number : 1,
    link: asLinkSet(item.link)
  };
}
function normalizeAnimeRecord(value) {
  if (!value || typeof value !== "object") return void 0;
  const item = value;
  const title = asString2(item.title) || asString2(item.English) || asString2(item.Japanese) || asString2(item.slug);
  const slug = asString2(item.slug) || asString2(Array.isArray(item.slugs) ? item.slugs[0] : void 0);
  if (!title || !slug) return void 0;
  return {
    slug,
    title,
    englishTitle: asString2(item.English),
    japaneseTitle: asString2(item.Japanese),
    synopsis: asString2(item.synopsis),
    type: asString2(item.Type),
    status: asString2(item.Status),
    aired: asString2(item.Aired),
    score: asString2(item.Score),
    rating: asString2(item.Rating),
    image: asString2(item.image),
    landscapeImage: asString2(item.landScapeImage),
    genres: asStringArray(item.genres),
    episodes: Array.isArray(item.episodes) ? item.episodes.flatMap((ep) => {
      const normalized = asEpisode(ep);
      return normalized ? [normalized] : [];
    }) : []
  };
}
async function requestApi(path7, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS2) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const base of API_BASES) {
      try {
        const response = await fetch(`${base}${path7}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: "https://hianimes.se",
            Referer: "https://hianimes.se/",
            ...init.headers || {}
          }
        });
        if (response.ok) return await response.json();
      } catch {
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchHianimesFilter(page, limit = 20, type = "All") {
  const payload = await requestApi("/filter", {
    method: "POST",
    body: JSON.stringify({ page, limit, type })
  });
  if (!payload || typeof payload !== "object") return null;
  const raw = payload;
  const results = Array.isArray(raw.results) ? raw.results.filter((entry) => Boolean(entry && typeof entry === "object")) : [];
  const number = (value, fallback) => {
    const parsed = typeof value === "number" ? value : Number.parseInt(asString2(value) || "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    total: number(raw.total, results.length),
    page: number(raw.page, page),
    limit: number(raw.limit, limit),
    totalPages: number(raw.totalPages, page),
    results
  };
}
async function fetchHianimesAnime(slug) {
  const payload = await requestApi(`/anime/${encodeURIComponent(slug)}`);
  if (!payload || typeof payload !== "object") return null;
  const raw = payload;
  return normalizeAnimeRecord(raw.anime ?? payload);
}
async function fetchHianimesEpisode(slug) {
  const payload = await requestApi(`/episode/${encodeURIComponent(slug)}`);
  if (!payload || typeof payload !== "object") return { anime: null, episode: null };
  const raw = payload;
  const episode = asEpisode(raw.episode);
  const anime = normalizeAnimeRecord(raw.anime);
  return { anime: anime || null, episode: episode || null };
}
function episodeLinks(episode) {
  return [
    ...episode.link.sub.map((url, index) => ({ url, language: "sub", index })),
    ...episode.link.dub.map((url, index) => ({ url, language: "dub", index }))
  ];
}
var API_BASES, HIANIMES_HOST, DEFAULT_TIMEOUT_MS2;
var init_hianimesResolver = __esm({
  "server/resolvers/hianimesResolver.ts"() {
    "use strict";
    API_BASES = ["https://animehot.cc/api", "https://anitv.cfd/api"];
    HIANIMES_HOST = "hianimes.se";
    DEFAULT_TIMEOUT_MS2 = 8e3;
  }
});

// server/deliveryPlanner.ts
function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return void 0;
  }
}
function matchesHost(hostname, configuredHost) {
  const candidate = normalizeIdentity(configuredHost).replace(/^\.+|\.+$/g, "");
  return candidate.length > 0 && (hostname === candidate || hostname.endsWith(`.${candidate}`));
}
function buildResolveDeliveryResponse(meta, strategy, planner) {
  const is_proxyable = meta.is_proxyable ?? (meta.resolved && meta.type !== "embed");
  const is_refreshable = meta.is_refreshable ?? Boolean(meta.canonical_locator);
  return {
    ...meta,
    is_proxyable,
    is_refreshable,
    requiredHeaders: meta.requiredHeaders ? { ...meta.requiredHeaders } : void 0,
    strategy,
    delivery_mode: planner.classify(meta)
  };
}
function cloneMeta(meta) {
  return {
    ...meta,
    requiredHeaders: meta.requiredHeaders ? { ...meta.requiredHeaders } : void 0,
    subtitles: meta.subtitles ? meta.subtitles.map((track) => ({ ...track })) : void 0
  };
}
function freezeMeta(meta) {
  const copy = cloneMeta(meta);
  if (copy.requiredHeaders) Object.freeze(copy.requiredHeaders);
  return Object.freeze(copy);
}
var normalizeIdentity, DeliveryPlanner, ResolutionLeaseCache, ResolutionCoordinator;
var init_deliveryPlanner = __esm({
  "server/deliveryPlanner.ts"() {
    "use strict";
    init_resolutionMetadata();
    normalizeIdentity = (value) => (value || "").trim().toLowerCase();
    DeliveryPlanner = class {
      directProviders;
      directHosts;
      constructor(options = {}) {
        this.directProviders = new Set((options.directProviders ?? []).map(normalizeIdentity).filter(Boolean));
        this.directHosts = Object.freeze([...options.directHosts ?? []]);
      }
      classify(meta) {
        if (!meta.resolved || meta.is_proxyable === false || meta.type === "embed") return "embed";
        if (meta.requiredHeaders && Object.keys(meta.requiredHeaders).length > 0) return "proxy_required";
        if (this.directProviders.has(normalizeIdentity(meta.provider))) return "direct";
        const hostname = hostnameOf(meta.url);
        if (hostname && this.directHosts.some((known) => matchesHost(hostname, known))) return "direct";
        return "direct_trial";
      }
    };
    ResolutionLeaseCache = class {
      leases = /* @__PURE__ */ new Map();
      maxEntries;
      now;
      constructor(options = {}) {
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 128));
        this.now = options.now ?? Date.now;
      }
      get size() {
        this.cleanup();
        return this.leases.size;
      }
      put(meta) {
        const resolutionId = meta.resolution_id?.trim() || "";
        const originalUrl = meta.original_url?.trim() || "";
        const canonicalLocator = meta.canonical_locator?.trim() || "";
        const refreshBoundary = meta.is_refreshable ? meta.refresh_after : meta.expires_at;
        const validUntil = Math.min(refreshBoundary ?? Number.NaN, meta.expires_at ?? Number.NaN);
        if (meta.is_proxyable === false || !resolutionId || !originalUrl || meta.is_refreshable && !canonicalLocator || !Number.isFinite(validUntil) || validUntil <= this.now()) return false;
        this.cleanup();
        this.leases.delete(resolutionId);
        this.leases.set(resolutionId, { meta: freezeMeta(meta), validUntil });
        this.enforceLimit();
        return true;
      }
      /**
       * Returns a defensive copy only when `locator` is the original embed/page URL
       * or its canonical equivalent. It never authorizes lookup by `meta.url`.
       */
      get(resolutionId, locator) {
        const id = typeof resolutionId === "string" ? resolutionId.trim() : "";
        const requestedLocator = typeof locator === "string" ? locator.trim() : "";
        if (!id || !requestedLocator) return void 0;
        const lease = this.leases.get(id);
        if (!lease) return void 0;
        if (this.now() >= lease.validUntil) {
          this.leases.delete(id);
          return void 0;
        }
        const originalUrl = lease.meta.original_url?.trim() || "";
        const canonicalLocator = lease.meta.canonical_locator?.trim();
        if (requestedLocator !== originalUrl && requestedLocator !== canonicalLocator) return void 0;
        this.leases.delete(id);
        this.leases.set(id, lease);
        return cloneMeta(lease.meta);
      }
      cleanup() {
        const now = this.now();
        let removed = 0;
        for (const [id, lease] of this.leases) {
          if (now >= lease.validUntil) {
            this.leases.delete(id);
            removed += 1;
          }
        }
        return removed;
      }
      clear() {
        this.leases.clear();
      }
      enforceLimit() {
        while (this.leases.size > this.maxEntries) {
          const oldest = this.leases.keys().next().value;
          if (oldest === void 0) break;
          this.leases.delete(oldest);
        }
      }
    };
    ResolutionCoordinator = class {
      leases;
      resolver;
      locatorIndex = /* @__PURE__ */ new Map();
      inFlight = /* @__PURE__ */ new Map();
      maxEntries;
      now;
      constructor(resolver, options = {}) {
        this.resolver = resolver;
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 128));
        this.now = options.now ?? Date.now;
        this.leases = new ResolutionLeaseCache({ maxEntries: this.maxEntries, now: this.now });
      }
      async resolve(locator) {
        const stableLocator = typeof locator === "string" ? locator.trim() : "";
        if (!stableLocator) throw new TypeError("A non-empty stable locator is required");
        const cachedId = this.locatorIndex.get(stableLocator);
        if (cachedId) {
          const cached = this.leases.get(cachedId, stableLocator);
          if (cached) {
            this.touchLocator(stableLocator, cachedId);
            return cached;
          }
          this.locatorIndex.delete(stableLocator);
        }
        let shared = this.inFlight.get(stableLocator);
        if (!shared) {
          shared = this.resolveAndStore(stableLocator);
          this.inFlight.set(stableLocator, shared);
          void shared.finally(() => {
            if (this.inFlight.get(stableLocator) === shared) this.inFlight.delete(stableLocator);
          }).catch(() => void 0);
        }
        return cloneMeta(await shared);
      }
      /** Safe bridge for `POST /playback/sessions`; still requires the stable locator. */
      getByResolutionId(resolutionId, locator) {
        return this.leases.get(resolutionId, locator);
      }
      clear() {
        this.leases.clear();
        this.locatorIndex.clear();
      }
      async resolveAndStore(locator) {
        const raw = await this.resolver(locator);
        const hasCompleteTiming = Boolean(
          raw.resolution_id?.trim() && Number.isFinite(raw.resolved_at) && Number.isFinite(raw.refresh_after) && Number.isFinite(raw.expires_at)
        );
        const timing = raw.resolved && raw.url && !hasCompleteTiming ? createResolutionTiming({
          originalUrl: raw.original_url || locator,
          upstreamUrl: raw.url,
          provider: raw.provider,
          now: this.now(),
          resolutionId: raw.resolution_id
        }) : void 0;
        const isProxyable = raw.is_proxyable ?? (raw.resolved && raw.type !== "embed");
        const isRefreshable = raw.is_refreshable ?? Boolean(raw.canonical_locator);
        const resolved = freezeMeta({
          ...timing ? { ...raw, ...timing } : raw,
          is_proxyable: isProxyable,
          is_refreshable: isRefreshable
        });
        if (this.leases.put(resolved)) {
          const resolutionId = resolved.resolution_id?.trim();
          const originalUrl = resolved.original_url?.trim();
          if (resolutionId && originalUrl) this.indexLocator(originalUrl, resolutionId);
          if (resolutionId && resolved.canonical_locator) this.indexLocator(resolved.canonical_locator, resolutionId);
        }
        return resolved;
      }
      indexLocator(locator, resolutionId) {
        const stableLocator = typeof locator === "string" ? locator.trim() : "";
        if (!stableLocator) return;
        this.touchLocator(stableLocator, resolutionId);
        while (this.locatorIndex.size > this.maxEntries) {
          const oldest = this.locatorIndex.keys().next().value;
          if (oldest === void 0) break;
          this.locatorIndex.delete(oldest);
        }
      }
      touchLocator(locator, resolutionId) {
        this.locatorIndex.delete(locator);
        this.locatorIndex.set(locator, resolutionId);
      }
    };
  }
});

// server/platformPageResolvers.ts
function isLaMoviePageUrl(rawUrl) {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)lamovie\.(?:org|to|ws)$/i.test(host);
  } catch {
    return false;
  }
}
function isCinecalidadPageUrl(rawUrl) {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)cinecalidad\.[a-z]+$/i.test(host);
  } catch {
    return false;
  }
}
function isTioPlusPageUrl(rawUrl) {
  try {
    const url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
    const host = url.hostname.toLowerCase();
    return /(?:^|\.)tioplus\.[a-z]+$/i.test(host);
  } catch {
    return false;
  }
}
function isPlatformPageUrl(rawUrl) {
  const urlStr = typeof rawUrl === "string" ? rawUrl : rawUrl.href;
  if (EmbedResolvers.isDirectMediaUrl(urlStr)) return false;
  return isLaMoviePageUrl(rawUrl) || isCinecalidadPageUrl(rawUrl) || isTioPlusPageUrl(rawUrl);
}
function getPlatformProviderName(rawUrl) {
  if (isLaMoviePageUrl(rawUrl)) return "LaMovie";
  if (isCinecalidadPageUrl(rawUrl)) return "Cinecalidad";
  if (isTioPlusPageUrl(rawUrl)) return "TioPlus";
  return "Desconocido";
}
function buildUnresolvedResponse(cleanUrl2, provider) {
  return {
    url: cleanUrl2,
    original_url: cleanUrl2,
    canonical_locator: cleanUrl2,
    provider,
    resolved: false,
    type: "embed",
    delivery_mode: "embed",
    is_proxyable: false,
    is_refreshable: false,
    failure_reason: "unresolved",
    expires_at: void 0,
    refresh_after: void 0
  };
}
function scoreCandidate(candidateUrl, cleanUrl2, now) {
  const c = (candidateUrl || "").trim();
  if (!c) return null;
  if (c === cleanUrl2) return null;
  if (isPlatformPageUrl(c)) return null;
  if (EmbedResolvers.isPlaceholderUrl(c)) return null;
  if (!isValidProvider(c)) return null;
  const isDirect = EmbedResolvers.isDirectMediaUrl(c);
  if (isDirect) {
    const { expiresAt } = parseStreamExpiry(c);
    if (expiresAt !== void 0 && expiresAt <= now) {
      return null;
    }
    const lower = c.toLowerCase();
    const isHls = lower.includes(".m3u8") || lower.includes("/m3u8/") || lower.includes("hls-vod");
    return {
      url: c,
      isDirect: true,
      score: isHls ? 100 : 80
    };
  }
  if (isSupportedServer(c) || c.includes("mega.nz") || /vimeos\.[a-z]+/i.test(c) || c.includes("goodstream.")) {
    return {
      url: c,
      isDirect: false,
      score: 50
    };
  }
  return {
    url: c,
    isDirect: false,
    score: 20
  };
}
async function resolvePlatformPage(locator, options = {}) {
  const cleanUrl2 = (locator || "").trim();
  if (!cleanUrl2) {
    return {
      url: "",
      original_url: "",
      canonical_locator: void 0,
      provider: "Desconocido",
      resolved: false,
      type: "embed",
      delivery_mode: "embed",
      is_proxyable: false,
      is_refreshable: false,
      failure_reason: "empty_locator"
    };
  }
  const provider = getPlatformProviderName(cleanUrl2);
  const now = options.now ? options.now() : Date.now();
  let extracted = null;
  try {
    const extractor = options.streamExtractor ?? (async (url) => {
      const { extractStreamFromUrl: extractStreamFromUrl2 } = await Promise.resolve().then(() => (init_universalScraper(), universalScraper_exports));
      return extractStreamFromUrl2(url);
    });
    extracted = await extractor(cleanUrl2);
  } catch {
    extracted = null;
  }
  if (!extracted) {
    return buildUnresolvedResponse(cleanUrl2, provider);
  }
  const rawCandidates = [];
  if (extracted.stream_url) rawCandidates.push(extracted.stream_url);
  if (Array.isArray(extracted.all_available_streams)) {
    for (const s of extracted.all_available_streams) {
      if (s && !rawCandidates.includes(s)) rawCandidates.push(s);
    }
  }
  const scoredList = [];
  for (const candidate of rawCandidates) {
    const scored = scoreCandidate(candidate, cleanUrl2, now);
    if (scored) scoredList.push(scored);
  }
  if (scoredList.length === 0) {
    return buildUnresolvedResponse(cleanUrl2, provider);
  }
  scoredList.sort((a, b) => b.score - a.score);
  const best = scoredList[0];
  let requiredHeaders;
  if (/vimeos\.[a-z]+/i.test(best.url) || /p\d+\.vimeos\.zip/i.test(best.url)) {
    requiredHeaders = { ...VIMEOS_REQUIRED_HEADERS };
  } else if (/goodstream\./i.test(best.url)) {
    requiredHeaders = { Referer: "https://goodstream.one/" };
  }
  const isProxyable = best.isDirect;
  const timing = createResolutionTiming({
    originalUrl: cleanUrl2,
    upstreamUrl: best.url,
    provider,
    now
  });
  const partialMeta = {
    url: best.url,
    original_url: cleanUrl2,
    canonical_locator: cleanUrl2,
    provider,
    resolved: true,
    type: best.isDirect ? "direct" : "embed",
    is_proxyable: isProxyable,
    is_refreshable: true,
    requiredHeaders
  };
  const delivery_mode = defaultDeliveryPlanner.classify(partialMeta);
  return {
    ...partialMeta,
    delivery_mode,
    resolved_at: timing.resolved_at,
    refresh_after: timing.refresh_after,
    expires_at: timing.expires_at,
    resolution_id: timing.resolution_id,
    generation: timing.generation,
    failure_reason: void 0
  };
}
async function resolveLaMoviePage(locator, options) {
  return resolvePlatformPage(locator, options);
}
async function resolveCinecalidadPage(locator, options) {
  return resolvePlatformPage(locator, options);
}
async function resolveTioPlusPage(locator, options) {
  return resolvePlatformPage(locator, options);
}
var defaultDeliveryPlanner;
var init_platformPageResolvers = __esm({
  "server/platformPageResolvers.ts"() {
    "use strict";
    init_resolutionMetadata();
    init_deliveryPlanner();
    init_hostProfiles();
    init_resolvers();
    defaultDeliveryPlanner = new DeliveryPlanner();
  }
});

// server/resolvers.ts
function isValidProvider(url) {
  const u = (url || "").toLowerCase();
  if (!u) return false;
  for (const domain of DEAD_PROVIDER_DOMAINS) {
    if (u.includes(domain)) return false;
  }
  return true;
}
function isSupportedServer(url) {
  const u = (url || "").toLowerCase();
  if (!u) return false;
  return SUPPORTED_SERVER_HOST_PATTERNS.some((p) => p.test(u));
}
function hasSignedMediaQuery(rawUrl) {
  try {
    const params = new URL(rawUrl).searchParams;
    return [
      "t",
      "token",
      "jwt",
      "access_token",
      "authorization",
      "expires",
      "expiry",
      "exp",
      "s",
      "e",
      "sig",
      "signature",
      "hash",
      "auth",
      "hdnts",
      "policy",
      "key-pair-id"
    ].some((key) => params.has(key));
  } catch {
    return false;
  }
}
function isZokoCdnUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === "hls2.aniwatchtv.uk";
  } catch {
    return false;
  }
}
var crypto3, DEAD_PROVIDER_DOMAINS, SUPPORTED_SERVER_HOST_PATTERNS, EmbedResolvers, ProviderResolverRegistry, providerResolverRegistry;
var init_resolvers = __esm({
  "server/resolvers.ts"() {
    "use strict";
    crypto3 = __toESM(require("crypto"), 1);
    init_jsUnpacker();
    init_vimeosResolver();
    init_megaResolver();
    init_obscureResolvers();
    init_doodstreamResolver();
    init_uqloadResolver();
    init_vidhideResolver();
    init_hostProfiles();
    init_resolutionMetadata();
    init_zokoanimeResolver();
    init_hianimesResolver();
    init_platformPageResolvers();
    DEAD_PROVIDER_DOMAINS = /* @__PURE__ */ new Set([
      "voe.sx",
      "voe",
      "mixdrop",
      "mxdrop",
      "filemoon"
    ]);
    SUPPORTED_SERVER_HOST_PATTERNS = [
      /mega\.nz/i,
      /vimeos\.[a-z]+/i,
      /mp4upload\.com/i,
      /yourupload\.com/i,
      /ok\.ru/i,
      /voe\.sx/i,
      /voe\./i,
      /byselapuix/i,
      /primeload\.co/i,
      /byseqekaho\.com/i,
      /bysekoze\.com/i,
      /hexload/i,
      /streamtape\.(?:com|to)/i,
      /streamwish/i,
      /filemoon/i,
      /vidmoly/i,
      /upstream/i,
      /fastre/i,
      /streamhide/i,
      /swhoi/i,
      /dood/i,
      /dsvplay/i,
      /ds2play/i,
      /do7go/i,
      /d000d/i,
      /uqload/i,
      /vidhide/i,
      /vixhide/i,
      /hqq\./i,
      /waaw/i,
      /divxplayer/i,
      /cvary\.org/i,
      /zilla-networks\.com/i,
      /zokoanime\.video/i
    ];
    EmbedResolvers = class {
      constructor() {
      }
      static DEFAULT_TIMEOUT = 8e3;
      static DEFAULT_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      };
      /**
       * Determina si una URL representa un stream directo (.m3u8, .mp4, .webm)
       */
      static isDirectMediaUrl(url) {
        if (!url) return false;
        const u = url.toLowerCase();
        return /\.(m3u8|mp4|webm)(\?|$)/i.test(u) || u.includes("/m3u8/") || u.includes("hls-vod");
      }
      /**
       * Detecta streams placeholder servidos por el host (ej. VOE devuelve Big Buck Bunny
       * cuando el archivo real cayó). Deben tratarse como inválidos para forzar failover.
       */
      static isPlaceholderUrl(url) {
        if (!url) return false;
        const u = url.toLowerCase();
        return u.includes("big_buck_bunny") || u.includes("big-buck-bunny") || u.includes("bigbuckbunny") || // Demo genérico usado por CDNs cuando el archivo no existe
        u.includes("sample") && u.includes("mp4") && !u.includes("/sample/") || u.endsWith("_5mb.mp4");
      }
      /**
       * Obtiene el nombre del proveedor legible a partir de la URL
       */
      static getProviderName(url) {
        const u = (url || "").toLowerCase();
        if (u.includes("lamovie.")) return "LaMovie";
        if (u.includes("cinecalidad")) return "Cinecalidad";
        if (u.includes("tioplus")) return "TioPlus";
        if (u.includes("hianimes") || u.includes("zokoanime")) return "HiAnimes";
        if (u.includes("mega.nz")) return "Mega";
        if (u.includes("mp4upload.com")) return "MP4Upload";
        if (u.includes("voe.sx") || u.includes("voe.") || u.includes("byselapuix")) return "VOE";
        if (u.includes("streamtape")) return "Streamtape";
        if (u.includes("yourupload.com")) return "YourUpload";
        if (u.includes("ok.ru")) return "Okru";
        if (u.includes("filemoon")) return "Filemoon";
        if (u.includes("streamwish") || u.includes("swhoi")) return "StreamWish";
        if (u.includes("vidmoly")) return "Vidmoly";
        if (u.includes("dood") || u.includes("do7go") || u.includes("ds2play")) return "DoodStream";
        if (/vimeos\.[a-z]+/i.test(u)) return "Vimeos";
        if (u.includes("mixdrop") || u.includes("mxdrop")) return "Mixdrop";
        if (u.includes("hqq.tv") || u.includes("waaw")) return "Netu/HQQ";
        if (u.includes("byseqekaho.com") || u.includes("byselapuix.com") || u.includes("bysekoze")) return "Bysekoze";
        if (u.includes("hexload")) return "Hexload";
        if (u.includes("cfglobalcdn.com")) return "Fast CDN (HLS)";
        return "Servidor";
      }
      /**
       * Resuelve la URL real directa (.m3u8 / .mp4) a partir de una URL de iframe/embed con metadata completa.
       */
      static async resolveWithMeta(iframeUrl) {
        const rawUrl = (iframeUrl || "").trim();
        if (!rawUrl) {
          return {
            url: "",
            original_url: "",
            resolved: false,
            type: "embed",
            provider: "Desconocido",
            is_proxyable: false,
            is_refreshable: false,
            failure_reason: "empty_locator"
          };
        }
        const provider = this.getProviderName(rawUrl);
        if (this.isDirectMediaUrl(rawUrl) && !this.isPlaceholderUrl(rawUrl)) {
          if (isZokoCdnUrl(rawUrl)) {
            return {
              url: rawUrl,
              original_url: rawUrl,
              resolved: true,
              type: "direct",
              provider,
              delivery_mode: "direct_trial",
              is_proxyable: true,
              is_refreshable: false,
              requiredHeaders: { ...ZOKO_REQUIRED_HEADERS }
            };
          }
          const { expiresAt } = parseStreamExpiry(rawUrl);
          const hasExplicitExpiry = expiresAt !== void 0;
          if (hasExplicitExpiry) {
            const explicitlyExpired = expiresAt <= Date.now();
            return {
              url: rawUrl,
              original_url: rawUrl,
              canonical_locator: void 0,
              resolved: !explicitlyExpired,
              type: "direct",
              provider,
              delivery_mode: !explicitlyExpired ? "direct_trial" : "embed",
              is_proxyable: !explicitlyExpired,
              is_refreshable: false,
              ...explicitlyExpired ? {
                failure_reason: "expired_without_locator",
                expires_at: expiresAt,
                refresh_after: expiresAt
              } : {}
            };
          }
          const hasOpaqueSignature = hasSignedMediaQuery(rawUrl);
          return {
            url: rawUrl,
            original_url: rawUrl,
            resolved: true,
            type: "direct",
            provider,
            delivery_mode: "direct_trial",
            is_proxyable: true,
            is_refreshable: !hasOpaqueSignature,
            ...!hasOpaqueSignature ? { canonical_locator: rawUrl } : {}
          };
        }
        if (isPlatformPageUrl(rawUrl)) {
          return resolvePlatformPage(rawUrl);
        }
        if (isZokoAnimeUrl(rawUrl)) {
          const zoko = await resolveZokoAnime(rawUrl);
          if (zoko.url && !this.isPlaceholderUrl(zoko.url)) {
            return {
              url: zoko.url,
              original_url: rawUrl,
              canonical_locator: rawUrl,
              resolved: true,
              type: "direct",
              provider,
              delivery_mode: "direct_trial",
              is_proxyable: true,
              is_refreshable: true,
              requiredHeaders: { ...zoko.requiredHeaders },
              subtitles: zoko.subtitles.map((track, index) => ({
                id: `zoko-sub-${index}`,
                label: track.label || track.lang || `Subt\xEDtulo ${index + 1}`,
                language: track.lang || "en",
                src: track.src,
                is_default: track.default === true
              }))
            };
          }
        }
        if (isHianimesWatchUrl(rawUrl)) {
          const hianimes = await this.resolveHianimesWatchMeta(rawUrl);
          if (hianimes) {
            return {
              url: hianimes.url,
              original_url: rawUrl,
              canonical_locator: rawUrl,
              resolved: true,
              type: "direct",
              provider,
              delivery_mode: "direct_trial",
              is_proxyable: true,
              is_refreshable: true,
              ...hianimes.requiredHeaders ? { requiredHeaders: hianimes.requiredHeaders } : {},
              ...hianimes.subtitles ? { subtitles: hianimes.subtitles } : {}
            };
          }
        }
        const resolvedUrl = await this.resolve(rawUrl);
        const isDirect = this.isDirectMediaUrl(resolvedUrl) && !this.isPlaceholderUrl(resolvedUrl);
        const resolvedExpiry = isDirect ? parseStreamExpiry(resolvedUrl).expiresAt : void 0;
        if (isDirect && resolvedExpiry !== void 0 && resolvedExpiry <= Date.now()) {
          return {
            url: rawUrl,
            original_url: rawUrl,
            canonical_locator: rawUrl,
            resolved: false,
            type: "embed",
            provider,
            is_proxyable: false,
            is_refreshable: true,
            failure_reason: "unresolved"
          };
        }
        return {
          url: resolvedUrl,
          original_url: rawUrl,
          resolved: isDirect,
          type: isDirect ? "direct" : "embed",
          provider,
          // El embed original sí es un locator estable: puede volver a producir un
          // token nuevo cuando el upstream expire.
          ...isDirect ? { is_proxyable: true, is_refreshable: true, canonical_locator: rawUrl } : { is_proxyable: false, is_refreshable: false, failure_reason: "unresolved" },
          // Cubre tanto embeds como nodos del CDN (s{N}.vimeos.net, vimeos.zip):
          // los headers reales los aplica el proxy vía perfil de hostProfiles.
          ...provider === "Vimeos" ? { requiredHeaders: { ...VIMEOS_REQUIRED_HEADERS } } : {},
          ...isZokoCdnUrl(resolvedUrl) ? { requiredHeaders: { ...ZOKO_REQUIRED_HEADERS } } : {}
        };
      }
      /**
       * Resuelve la URL real directa (.m3u8 / .mp4) a partir de una URL de iframe/embed.
       * Si no se puede desofuscar a stream directo, devuelve la URL de embed sanitizada (ej. mega /embed).
       */
      static async resolve(iframeUrl) {
        const rawUrl = (iframeUrl || "").trim();
        if (!rawUrl) return "";
        if (isHianimesWatchUrl(rawUrl)) {
          const hianimesStream = await this.resolveHianimesWatch(rawUrl);
          if (hianimesStream) return hianimesStream;
          return rawUrl;
        }
        if (isZokoAnimeUrl(rawUrl)) {
          const zoko = await resolveZokoAnime(rawUrl);
          if (zoko.url && !this.isPlaceholderUrl(zoko.url)) return zoko.url;
          return rawUrl;
        }
        if (rawUrl.includes("mega.nz/file/")) {
          return rawUrl.replace("mega.nz/file/", "mega.nz/embed/");
        }
        if (rawUrl.includes("mega.nz/embed/")) {
          return rawUrl;
        }
        if (VimeosResolver.isVimeosUrl(rawUrl)) {
          const streams = await VimeosResolver.resolveVimeos(rawUrl);
          if (streams.length > 0 && !this.isPlaceholderUrl(streams[0])) return streams[0];
          return rawUrl;
        }
        if (rawUrl.includes("mp4upload.com")) {
          const mp4Direct = await this.resolveMp4Upload(rawUrl);
          if (mp4Direct) return mp4Direct;
        }
        if (rawUrl.includes("yourupload.com")) {
          const yuDirect = await this.resolveYourUpload(rawUrl);
          if (yuDirect) return yuDirect;
        }
        if (rawUrl.includes("ok.ru")) {
          const okDirect = await this.resolveOkru(rawUrl);
          if (okDirect) return okDirect;
        }
        if (rawUrl.includes("voe.sx") || rawUrl.includes("byselapuix.com") || rawUrl.includes("voe.")) {
          const voeDirect = await this.resolveVoe(rawUrl);
          if (voeDirect) return voeDirect;
        }
        if (rawUrl.includes("primeload.co")) {
          const primeDirect = await this.resolvePrimeload(rawUrl);
          if (primeDirect) return primeDirect;
        }
        if (this.isByseHost(rawUrl)) {
          const byseDirect = await this.resolveByse(rawUrl);
          if (byseDirect) return byseDirect;
        }
        if (rawUrl.includes("hexload")) {
          const hexload = await resolveHexload(rawUrl);
          if (hexload.type === "direct") return hexload.url;
          return rawUrl;
        }
        if (this.isBysesukiorHost(rawUrl)) {
          const bs = await this.resolveBysesukior(rawUrl);
          if (bs) return bs;
        }
        if (rawUrl.includes("streamtape.com") || rawUrl.includes("streamtape.to")) {
          const streamtapeDirect = await this.resolveStreamtape(rawUrl);
          if (streamtapeDirect) return streamtapeDirect;
        }
        if (rawUrl.includes("streamwish") || rawUrl.includes("filemoon") || rawUrl.includes("vidmoly") || rawUrl.includes("upstream") || rawUrl.includes("fastre") || rawUrl.includes("streamhide") || rawUrl.includes("swhoi")) {
          const unpacked = await this.resolvePackedEmbed(rawUrl);
          if (unpacked) return unpacked;
        }
        if (rawUrl.includes("dood.") || rawUrl.includes("doodstream") || rawUrl.includes("dsvplay") || rawUrl.includes("d000d") || rawUrl.includes("ds2play") || rawUrl.includes("do7go")) {
          const dood = await resolveDoodstream(rawUrl);
          if (dood.type === "direct") return dood.url;
          return rawUrl;
        }
        if (rawUrl.includes("uqload")) {
          const uq = await resolveUqload(rawUrl);
          if (uq.type === "direct") return uq.url;
          return rawUrl;
        }
        if (rawUrl.includes("vidhide") || rawUrl.includes("vixhide")) {
          const vh = await resolveVidhide(rawUrl);
          if (vh.type === "direct") return vh.url;
          return rawUrl;
        }
        if (rawUrl.includes("hqq.") || rawUrl.includes("waaw") || rawUrl.includes("divxplayer") || rawUrl.includes("cvary.org")) {
          const hqq = await this.resolveHqq(rawUrl);
          if (hqq) return hqq;
        }
        if (rawUrl.includes("goodstream.")) {
          const gs = await this.resolveGoodstream(rawUrl);
          if (gs) return gs;
          return rawUrl;
        }
        const generic = await this.resolveGeneric(rawUrl);
        return generic || rawUrl;
      }
      static async resolveHianimesWatch(rawUrl) {
        const slug = hianimesSlugFromUrl(rawUrl) || "";
        if (!slug) return null;
        const { episode } = await fetchHianimesEpisode(slug);
        if (!episode) return null;
        for (const link of episodeLinks(episode)) {
          const resolved = link.url.includes("zokoanime.video") ? (await resolveZokoAnime(link.url)).url : await this.resolve(link.url);
          if (resolved && resolved !== link.url && this.isDirectMediaUrl(resolved) && !this.isPlaceholderUrl(resolved)) return resolved;
        }
        return null;
      }
      static async resolveHianimesWatchMeta(rawUrl) {
        const slug = hianimesSlugFromUrl(rawUrl) || "";
        if (!slug) return null;
        const { episode } = await fetchHianimesEpisode(slug);
        if (!episode) return null;
        for (const link of episodeLinks(episode)) {
          if (isZokoAnimeUrl(link.url)) {
            const zoko = await resolveZokoAnime(link.url);
            if (!zoko.url || this.isPlaceholderUrl(zoko.url)) continue;
            return {
              url: zoko.url,
              requiredHeaders: { ...zoko.requiredHeaders },
              subtitles: zoko.subtitles.map((track, index) => ({
                id: `zoko-sub-${index}`,
                label: track.label || track.lang || `Subt\xEDtulo ${index + 1}`,
                language: track.lang || "en",
                src: track.src,
                is_default: track.default === true
              }))
            };
          }
          const resolved = await this.resolve(link.url);
          if (resolved && resolved !== link.url && this.isDirectMediaUrl(resolved) && !this.isPlaceholderUrl(resolved)) {
            return { url: resolved };
          }
        }
        return null;
      }
      /**
       * Resuelve el embed de hqq.ac / divxplayer (reproductor "raro" de VerAnimes).
       * El m3u8 maestro va directamente en el HTML del /e/{id}, en:
       *   - meta og:video / og:video:url
       *   - atributos data-* / var del player
       * Descarta m3u8 placeholder (el reproductor sirve el mismo video de demo
       * "TenchiMuyo_18" cuando el video real está tras captcha).
       */
      static async resolveHqq(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          if (/need_captcha\s*=\s*1/i.test(html)) return null;
          const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.(?:mp4\.)?m3u8(?:\?[^\s"'<>\\]*)?/gi;
          const matches = html.match(m3u8Regex) || [];
          const urls = matches.map((m) => m.replace(/\\/g, "").replace(/["']/g, ""));
          if (urls.length === 0) return null;
          const real = urls.filter((u) => !u.includes("153311550983uua") && !u.includes("cfglobalcdn.com"));
          return real.length > 0 ? real[0] : null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve stream directo de MP4Upload
       */
      static async resolveMp4Upload(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const unpacked = unpackGeneric(html);
          const match = unpacked.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) || unpacked.match(/["'](https?:\/\/[a-zA-Z0-9.\-_:]+\/d\/[^"']+\/video\.mp4)["']/i);
          if (match) return match[1];
          const direct = extractMediaUrlsFromCode(unpacked);
          return direct.find((u) => u.includes(".mp4")) || null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve stream directo de YourUpload
       */
      static async resolveYourUpload(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const match = html.match(/file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) || html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i) || html.match(/<source\s+src=["']([^"']+\.mp4[^"']*)["']/i);
          if (match) return match[1];
          const unpacked = unpackGeneric(html);
          const matchUnpacked = unpacked.match(/file:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
          if (matchUnpacked) return matchUnpacked[1];
          return null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve stream de OK.RU
       */
      static async resolveOkru(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const hlsMatch = html.match(/hlsManifestUrl["']?\s*:\s*["']([^"']+)["']/i) || html.match(/data-options=["']([^"']+)["']/i);
          if (hlsMatch) {
            const val = hlsMatch[1].replace(/&quot;/g, '"').replace(/\\"/g, '"').replace(/\\\//g, "/");
            if (val.includes(".m3u8")) {
              const directMatch = val.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
              if (directMatch) return directMatch[0];
            }
          }
          return null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve stream directo de VOE / ByseLapuix
       */
      static async resolveVoe(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const hlsMatch = html.match(/['"]hls['"]\s*:\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i) || html.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
          if (hlsMatch) return hlsMatch[1];
          const b64Match = html.match(/prompt\(['"][^'"]*['"],\s*['"]([A-Za-z0-9+/=]{20,})['"]\)/) || html.match(/sources\s*=\s*JSON\.parse\(atob\(['"]([A-Za-z0-9+/=]+)['"]\)\)/) || html.match(/atob\(['"]([A-Za-z0-9+/=]{20,})['"]\)/);
          if (b64Match) {
            try {
              const decoded = Buffer.from(b64Match[1], "base64").toString("utf-8");
              const media2 = extractMediaUrlsFromCode(decoded);
              if (media2.length > 0) return media2[0];
            } catch {
            }
          }
          const redirectMatch = html.match(/window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
          if (redirectMatch && redirectMatch[1] !== url) {
            const nextHtml = await this.fetchHtml(redirectMatch[1]);
            if (nextHtml) {
              const nextHls = nextHtml.match(/['"](https?:\/\/[^'"]+\.m3u8(?:\?[^'"]*)?)['"]/i);
              if (nextHls) return nextHls[1];
            }
          }
          const unpacked = unpackGeneric(html);
          const media = extractMediaUrlsFromCode(unpacked);
          return media.find((u) => u.includes(".m3u8")) || media[0] || null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve stream directo de Streamtape
       */
      static async resolveStreamtape(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const matchRobot = html.match(
            /document\.getElementById\(['"](?:robotlink|videolink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*['"]([^'"]+)['"]/i
          );
          if (matchRobot) {
            let streamUrl = matchRobot[1] + matchRobot[2];
            if (streamUrl.startsWith("//")) streamUrl = `https:${streamUrl}`;
            return streamUrl;
          }
          return null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve reproductor de Primeload.co a su .m3u8 maestro vía /api/v1/player/{code}
       */
      static async resolvePrimeload(url) {
        try {
          const codeMatch = url.match(/\/embed\/([a-zA-Z0-9_-]+)/);
          if (!codeMatch) return null;
          const code = codeMatch[1];
          const apiUrl = `https://primeload.co/api/v1/player/${code}`;
          const jsonText = await this.fetchHtml(apiUrl);
          if (!jsonText) return null;
          const data = JSON.parse(jsonText);
          return data.master_manifest || data.sources?.[0]?.src || null;
        } catch {
          return null;
        }
      }
      /**
       * Detecta hosts del ecosistema "Byse" (SPA React con playback AES-GCM).
       * El título de su HTML es "Byse Frontend" y sirve /assets/index-*.js.
       * bysekoze.com verificado 2026-08-23: misma SPA y misma /api/videos/{code}/.
       */
      static isByseHost(url) {
        return /byseqekaho\.com|byselapuix\.com|bysekoze\.com/i.test(url);
      }
      /**
       * Resuelve streams de backends Byse:
       * 1. GET {origin}/api/videos/{code}/ → JSON con playback {algorithm, iv, payload, key_parts, version}
       * 2. key = concat(base64url(key_parts[i])) según permutación de `version` (N^0, 31-N^0)
       * 3. AES-256-GCM decrypt (tag = últimos 16 bytes) → JSON con sources[].url (.m3u8 firmado)
       */
      static async resolveByse(url) {
        try {
          const match = url.match(/\/e\/([a-zA-Z0-9]+)/i);
          if (!match) return null;
          const origin = new URL(url).origin;
          const apiUrl = `${origin}/api/videos/${match[1]}/`;
          const json = await this.fetchHtml(apiUrl);
          if (!json) return null;
          const data = JSON.parse(json);
          const pb = data.playback;
          if (!pb || pb.algorithm !== "AES-256-GCM" || !Array.isArray(pb.key_parts)) return null;
          const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
          const v = parseInt(String(pb.version ?? ""), 10);
          const parts = Number.isInteger(v) ? [v ^ 0, 31 - (v ^ 0)] : [];
          const keyParts = Array.isArray(pb.key_parts) ? pb.key_parts : [];
          if (keyParts.length === 0) return null;
          const picked = parts.filter((i) => i >= 1 && i <= keyParts.length).map((i) => keyParts[i - 1]).filter((s) => typeof s === "string" && s.length > 0);
          const keyStr = picked.length > 0 ? picked : keyParts;
          const key = Buffer.concat(keyStr.map(b64url));
          const iv = b64url(pb.iv);
          const full = b64url(pb.payload);
          const tag = full.subarray(full.length - 16);
          const body = full.subarray(0, full.length - 16);
          const dec = crypto3.createDecipheriv("aes-256-gcm", key, iv);
          dec.setAuthTag(tag);
          const plain = Buffer.concat([dec.update(body), dec.final()]).toString("utf8");
          const inner = JSON.parse(plain);
          const m3u8 = (inner.sources || []).map((s) => s.url || "").find((u) => u.startsWith("http") && u.includes(".m3u8"));
          return m3u8 || null;
        } catch {
          return null;
        }
      }
      /**
       * Detecta bysesukior.com (variante Byse con playback cifrado, sirve .mp4 firmado).
       */
      static isBysesukiorHost(url) {
        return /bysesukior\.com/i.test(url);
      }
      /**
       * Desofusca bysesukior.com /e/{code} a su .mp4/.m3u8 real:
       * 1. GET {origin}/api/videos/{code}/ → JSON con playback {algorithm, iv, payload, key_parts, version}
       * 2. key = concat(base64url(key_parts[i])) según permutación de `version` (N^0, 31-N^0)
       * 3. AES-256-GCM decrypt (tag = últimos 16 bytes) → JSON con sources[].url
       * Si el backend no responde al patrón Byse, cae al extractor genérico de .mp4.
       */
      static async resolveBysesukior(url) {
        try {
          const match = url.match(/\/e\/([a-zA-Z0-9]+)/i);
          if (!match) return null;
          const origin = new URL(url).origin;
          const apiUrl = `${origin}/api/videos/${match[1]}/`;
          const json = await this.fetchHtml(apiUrl);
          if (!json) return await this.resolveGeneric(url);
          const data = JSON.parse(json);
          const pb = data.playback;
          if (!pb || pb.algorithm !== "AES-256-GCM" || !Array.isArray(pb.key_parts)) {
            return await this.resolveGeneric(url);
          }
          const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
          const v = parseInt(String(pb.version ?? ""), 10);
          const parts = Number.isInteger(v) ? [v ^ 0, 31 - (v ^ 0)] : [];
          const keyParts = pb.key_parts;
          const picked = parts.filter((i) => i >= 1 && i <= keyParts.length).map((i) => keyParts[i - 1]).filter((s) => typeof s === "string" && s.length > 0);
          const keyStr = picked.length > 0 ? picked : keyParts;
          const key = Buffer.concat(keyStr.map(b64url));
          const iv = b64url(pb.iv);
          const full = b64url(pb.payload);
          const tag = full.subarray(full.length - 16);
          const body = full.subarray(0, full.length - 16);
          const dec = crypto3.createDecipheriv("aes-256-gcm", key, iv);
          dec.setAuthTag(tag);
          const plain = Buffer.concat([dec.update(body), dec.final()]).toString("utf8");
          const inner = JSON.parse(plain);
          const media = (inner.sources || []).map((s) => s.url || "").find((u) => u.startsWith("http") && (u.includes(".mp4") || u.includes(".m3u8")));
          return media || await this.resolveGeneric(url);
        } catch {
          return null;
        }
      }
      /**
       * Resuelve reproductores con scripts empaquetados tipo Dean Edwards
       */
      static async resolvePackedEmbed(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const unpacked = unpackGeneric(html);
          const mediaUrls = extractMediaUrlsFromCode(unpacked);
          const m3u8 = mediaUrls.find((u) => u.includes(".m3u8"));
          if (m3u8) return m3u8;
          const mp4 = mediaUrls.find((u) => u.includes(".mp4"));
          if (mp4) return mp4;
          return null;
        } catch {
          return null;
        }
      }
      /**
       * Resuelve Goodstream: el m3u8 firmado está embebido directamente en el HTML del embed.
       * El script de jwplayer contiene la URL enc{N}.goodstream.one/hls2/.../master.m3u8?t=...
       * en texto plano dentro de la etiqueta <script>. Sin ofuscación.
       * Requiere Referer=goodstream.one para que Cloudflare entregue el HTML real.
       */
      static async resolveGoodstream(url) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);
          let html = null;
          try {
            const res = await fetch(url, {
              signal: controller.signal,
              headers: {
                "User-Agent": this.DEFAULT_HEADERS["User-Agent"],
                "Referer": "https://goodstream.one/",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
              }
            });
            clearTimeout(timer);
            if (!res.ok) return null;
            html = await res.text();
          } catch {
            clearTimeout(timer);
            return null;
          }
          if (!html || html.includes("File is no longer available") || html.includes("expired or has been deleted")) {
            return null;
          }
          const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
          const matches = html.match(m3u8Regex) || [];
          const cleaned = matches.map((m) => m.replace(/\\/g, "").replace(/['"]/g, "")).filter((m) => m.includes("goodstream") || m.includes(".goodstream."));
          const master = cleaned.find((m) => m.includes("master.m3u8") || m.includes(".urlset/"));
          return master || cleaned[0] || null;
        } catch {
          return null;
        }
      }
      /**
       * Fallback genérico para iframes
       */
      static async resolveGeneric(url) {
        try {
          const html = await this.fetchHtml(url);
          if (!html) return null;
          const unpacked = unpackGeneric(html);
          const mediaUrls = extractMediaUrlsFromCode(unpacked);
          return mediaUrls[0] || null;
        } catch {
          return null;
        }
      }
      static async fetchHtml(url) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);
          const res = await fetch(url, {
            signal: controller.signal,
            headers: {
              ...this.DEFAULT_HEADERS,
              Referer: new URL(url).origin + "/"
            }
          });
          clearTimeout(timer);
          if (!res.ok) return null;
          return await res.text();
        } catch {
          return null;
        }
      }
    };
    ProviderResolverRegistry = class {
      resolvers = [];
      constructor() {
        this.registerDefaults();
      }
      register(resolver) {
        this.resolvers.push(resolver);
      }
      getResolvers() {
        return this.resolvers;
      }
      findResolver(urlStr) {
        try {
          const parsed = new URL(urlStr);
          return this.resolvers.find((r) => r.matches(parsed));
        } catch {
          return void 0;
        }
      }
      async resolve(locator, context) {
        const raw = (locator || "").trim();
        if (!raw) {
          return {
            url: "",
            original_url: "",
            resolved: false,
            type: "embed",
            provider: "Desconocido",
            is_proxyable: false,
            is_refreshable: false,
            failure_reason: "empty_locator"
          };
        }
        const resolver = this.findResolver(raw);
        if (resolver) {
          return resolver.resolve(raw, context);
        }
        return EmbedResolvers.resolveWithMeta(raw);
      }
      registerDefaults() {
        this.register({
          name: "DirectMedia",
          matches: (url) => EmbedResolvers.isDirectMediaUrl(url.href) && !url.hostname.includes("mega.nz"),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: false,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Mega",
          matches: (url) => /mega\.(?:nz|io|co\.nz)/i.test(url.hostname),
          capabilities: {
            supportsDirect: false,
            supportsProxy: false,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Vimeos",
          matches: (url) => /vimeos\.[a-z]+/i.test(url.hostname) || /p\d+\.vimeos\.zip/i.test(url.hostname),
          capabilities: {
            supportsDirect: false,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: true
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "MP4Upload",
          matches: (url) => /mp4upload\.com/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "YourUpload",
          matches: (url) => /yourupload\.com/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Okru",
          matches: (url) => /ok\.ru/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "VOE",
          matches: (url) => /voe\.sx|voe\.|byselapuix\.com/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Primeload",
          matches: (url) => /primeload\.co/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Byse",
          matches: (url) => /byseqekaho\.com|byselapuix\.com|bysekoze\.com/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Bysesukior",
          matches: (url) => /bysesukior\.com/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Streamtape",
          matches: (url) => /streamtape\.(?:com|to)/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Doodstream",
          matches: (url) => /dood\.|doodstream|dsvplay|d000d|ds2play|do7go/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Uqload",
          matches: (url) => /uqload/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Vidhide",
          matches: (url) => /vidhide|vixhide/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Netu/HQQ",
          matches: (url) => /hqq\.|waaw|divxplayer|cvary\.org/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "Goodstream",
          matches: (url) => /goodstream\./i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: true
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "PackedEmbed",
          matches: (url) => /streamwish|filemoon|vidmoly|upstream|fastre|streamhide|swhoi/i.test(url.hostname),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
        this.register({
          name: "LaMovie",
          matches: (url) => isLaMoviePageUrl(url),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => resolveLaMoviePage(locator)
        });
        this.register({
          name: "Cinecalidad",
          matches: (url) => isCinecalidadPageUrl(url),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => resolveCinecalidadPage(locator)
        });
        this.register({
          name: "TioPlus",
          matches: (url) => isTioPlusPageUrl(url),
          capabilities: {
            supportsDirect: true,
            supportsProxy: true,
            supportsEmbed: true,
            renewable: true,
            requiresHeaders: false
          },
          resolve: async (locator) => resolveTioPlusPage(locator)
        });
        this.register({
          name: "GenericHtml",
          matches: () => true,
          capabilities: {
            supportsDirect: false,
            supportsProxy: false,
            supportsEmbed: true,
            renewable: false,
            requiresHeaders: false
          },
          resolve: async (locator) => EmbedResolvers.resolveWithMeta(locator)
        });
      }
    };
    providerResolverRegistry = new ProviderResolverRegistry();
  }
});

// server/validator.ts
var MediaValidator;
var init_validator = __esm({
  "server/validator.ts"() {
    "use strict";
    MediaValidator = class {
      constructor() {
      }
      static DEFAULT_TIMEOUT = 5e3;
      static VALID_CONTENT_TYPES = [
        "video/",
        "application/vnd.apple.mpegurl",
        "application/x-mpegurl",
        "application/octet-stream",
        "text/html"
      ];
      static KNOWN_EMBED_HOSTS = [
        "zilla-networks.com",
        "byselapuix.com",
        "mp4upload.com",
        "mega.nz",
        "mega.io",
        "mega.co.nz",
        "streamtape.com",
        "streamwish.",
        "yourupload.com",
        "vidmoly.",
        "luluvdo.",
        "streamhide.",
        "ok.ru",
        "vimeo.com",
        // DoodStream / Uqload / VidHide: hosts con resolver dedicado (F3). Se
        // aprueban sin fetch porque su validación HEAD/GET responde 403 al bot.
        "dood.",
        "doodstream.",
        "dsvplay.com",
        "d000d.com",
        "ds2play.com",
        "do7go",
        "uqload.",
        "vidhide",
        "vixhide",
        "fembed.",
        "upstream.",
        "embedsito.",
        "streamlare.",
        "fastre.",
        "gamovideo.",
        "netu.",
        "waaw.",
        "streamdav.",
        "streamhub."
      ];
      /** Lista negra del usuario: muertos/anuncio-basura, se descartan sin fetch. */
      static BLACKLISTED_HOSTS = ["voe", "mixdrop", "filemoon"];
      /**
       * Filtra y valida enlaces directos realizando peticiones HEAD/GET range ultra-rápidas
       */
      static async validateUrls(urls) {
        if (!urls || urls.length === 0) return [];
        const cleanUrls = Array.from(new Set(urls.map((u) => (u || "").trim()).filter((u) => u.startsWith("http"))));
        const validStreams = [];
        for (const cleanUrl2 of cleanUrls) {
          const urlLower = cleanUrl2.toLowerCase();
          if (this.BLACKLISTED_HOSTS.some((host) => urlLower.includes(host))) continue;
          if (this.KNOWN_EMBED_HOSTS.some((host) => urlLower.includes(host)) || urlLower.includes("/m3u8/") || urlLower.includes(".m3u8")) {
            validStreams.push(cleanUrl2);
            continue;
          }
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.DEFAULT_TIMEOUT);
            let res = await fetch(cleanUrl2, {
              method: "HEAD",
              signal: controller.signal,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            if (res.status === 405) {
              res = await fetch(cleanUrl2, {
                method: "GET",
                signal: controller.signal,
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                  Range: "bytes=0-1"
                }
              });
            }
            clearTimeout(timer);
            if (res.status === 200 || res.status === 206) {
              const contentType = (res.headers.get("content-type") || "").toLowerCase();
              if (this.VALID_CONTENT_TYPES.some((vt) => contentType.includes(vt)) || urlLower.includes(".mp4")) {
                validStreams.push(cleanUrl2);
              }
            }
          } catch {
          }
        }
        return validStreams;
      }
    };
  }
});

// server/utils/antiBot.ts
function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v !== void 0 && v !== null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}
function detectAntiBot(status, headers, bodySample, host) {
  const h = normalizeHeaders(headers);
  const cfMitigated = (h["cf-mitigated"] || "").toLowerCase();
  const server = (h["server"] || "").toLowerCase();
  const body = (bodySample || "").slice(0, 4e3).toLowerCase();
  if (cfMitigated.includes("challenge")) {
    return { blocked: true, kind: "cloudflare", evidence: `header cf-mitigated="${h["cf-mitigated"]}" (HTTP ${status})` };
  }
  const marker = CF_BODY_MARKERS.find((m) => body.includes(m));
  if (marker) {
    return { blocked: true, kind: "cloudflare", evidence: `body contiene "${marker}" (HTTP ${status})` };
  }
  if (server === "cloudflare" && (status === 403 || status === 503 || status === 429)) {
    return { blocked: true, kind: "cloudflare", evidence: `server=cloudflare con HTTP ${status}` };
  }
  if (status === 429) {
    const key = `${host || "__global__"}::429`;
    const now = Date.now();
    let rec = records.get(key);
    if (!rec) {
      rec = { hits: 0, lastAt: now, kind: "generic", hitTimestamps: [], recent429s: [] };
      records.set(key, rec);
    }
    rec.recent429s = rec.recent429s.filter((t) => now - t < ANTIBOT_HIT_WINDOW_MS);
    rec.recent429s.push(now);
    if (rec.recent429s.length >= REPEATED_429_THRESHOLD) {
      return {
        blocked: true,
        kind: "generic",
        evidence: `HTTP 429 repetido (${rec.recent429s.length} en ${Math.round(ANTIBOT_HIT_WINDOW_MS / 6e4)} min)`
      };
    }
    return { blocked: false, kind: null, evidence: "HTTP 429 aislado (a\xFAn no repetido)" };
  }
  return { blocked: false, kind: null, evidence: "" };
}
function recordAntiBotHit(host, verdict) {
  if (!host || !verdict?.blocked) return;
  const now = Date.now();
  let rec = records.get(host);
  if (!rec) {
    rec = { hits: 0, lastAt: now, kind: verdict.kind || "generic", hitTimestamps: [], recent429s: [] };
    records.set(host, rec);
  }
  rec.hits++;
  rec.lastAt = now;
  rec.kind = verdict.kind || rec.kind;
  rec.hitTimestamps.push(now);
  rec.hitTimestamps = rec.hitTimestamps.filter((t) => now - t < ANTIBOT_HIT_WINDOW_MS);
}
function countRecentAntiBotHits(host, windowMs = ANTIBOT_HIT_WINDOW_MS) {
  const rec = records.get(host);
  if (!rec) return 0;
  const now = Date.now();
  rec.hitTimestamps = rec.hitTimestamps.filter((t) => now - t < windowMs);
  return rec.hitTimestamps.length;
}
function getAntiBotReport() {
  const out = {};
  for (const [host, rec] of records) {
    if (host.endsWith("::429")) continue;
    out[host] = { hits: rec.hits, lastAt: rec.lastAt, kind: rec.kind };
  }
  return out;
}
var records, ANTIBOT_HIT_WINDOW_MS, CF_BODY_MARKERS, REPEATED_429_THRESHOLD;
var init_antiBot = __esm({
  "server/utils/antiBot.ts"() {
    "use strict";
    records = /* @__PURE__ */ new Map();
    ANTIBOT_HIT_WINDOW_MS = 10 * 60 * 1e3;
    CF_BODY_MARKERS = [
      "just a moment",
      "challenge-platform",
      "cf-browser-verification",
      "_cf_chl",
      "attention required"
    ];
    REPEATED_429_THRESHOLD = 2;
  }
});

// server/scrapers/BaseAdapter.ts
var cheerio2, COMMON_HEADERS, BaseScraperAdapter;
var init_BaseAdapter = __esm({
  "server/scrapers/BaseAdapter.ts"() {
    "use strict";
    cheerio2 = __toESM(require("cheerio"), 1);
    init_resolvers();
    init_validator();
    init_antiBot();
    COMMON_HEADERS = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    };
    BaseScraperAdapter = class {
      /**
       * Extrae streams de video en tiempo real (Just-In-Time) de una página específica de episodio/película.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        try {
          const html = await this.fetchHtml(cleanUrl2, 6e3);
          if (!html) {
            return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
          }
          const $ = cheerio2.load(html);
          const rawStreams = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl2);
          const resolvedStreams = [];
          for (const stream of rawStreams) {
            const resolved = await EmbedResolvers.resolve(stream);
            resolvedStreams.push(resolved || stream);
          }
          const validStreams = await MediaValidator.validateUrls(resolvedStreams);
          const finalStreams = validStreams.length > 0 ? validStreams : resolvedStreams.length > 0 ? resolvedStreams : [cleanUrl2];
          const allStreams = Array.from(new Set([...finalStreams, ...rawStreams, cleanUrl2].filter(Boolean)));
          return {
            stream_url: finalStreams[0] || cleanUrl2,
            all_available_streams: allStreams,
            title: $("title").text().trim() || void 0
          };
        } catch {
          return {
            stream_url: cleanUrl2,
            all_available_streams: [cleanUrl2]
          };
        }
      }
      /**
       * Utilidad común para realizar solicitudes HTTP con timeout y abort signal seguro.
       * Instrumentada con detección anti-bot (Cloudflare/WAF): cada respuesta se analiza
       * y un challenge detectado se registra globalmente y NO se devuelve como contenido.
       */
      async fetchHtml(url, timeoutMs = 7500) {
        let host = "unknown";
        try {
          host = new URL(url).hostname.replace(/^www\./, "") || host;
        } catch {
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(url, {
            signal: controller.signal,
            headers: COMMON_HEADERS
          });
          clearTimeout(timer);
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            if (response.status === 404 && text && text.length > 500 && (text.includes("<html") || text.includes("<body") || text.includes("<div"))) {
              return text;
            }
            const verdict2 = detectAntiBot(response.status, response.headers, text.slice(0, 500), host);
            if (verdict2.blocked) {
              recordAntiBotHit(host, verdict2);
              console.warn(`[AntiBot] ${host}: ${verdict2.kind} (${verdict2.evidence}) [${url}]`);
            }
            return null;
          }
          const html = await response.text();
          const verdict = detectAntiBot(response.status, response.headers, html.slice(0, 500), host);
          if (verdict.blocked) {
            recordAntiBotHit(host, verdict);
            console.warn(`[AntiBot] ${host}: ${verdict.kind} (${verdict.evidence}) [${url}]`);
            return null;
          }
          return html;
        } catch {
          return null;
        }
      }
      /**
       * Extrae URLs de reproducción, iframes, variables JavaScript y servidores de un HTML.
       */
      extractEmbedsAndStreamsFromHtml($, html, baseUrl) {
        const streams = [];
        const videoObjectMatch = html.match(/var\s+videos\s*=\s*(\{.+?\});/s) || html.match(/videos\s*=\s*(\{.+?\});/s);
        if (videoObjectMatch) {
          try {
            const parsed = JSON.parse(videoObjectMatch[1]);
            const servers = parsed.SUB || parsed.LAT || parsed.ENG || Object.values(parsed)[0] || [];
            if (Array.isArray(servers)) {
              servers.forEach((srv) => {
                if (srv.code && typeof srv.code === "string") {
                  const cleanCode = srv.code.replace(/\\/g, "");
                  if (!streams.includes(cleanCode)) streams.push(cleanCode);
                } else if (srv.url && typeof srv.url === "string") {
                  if (!streams.includes(srv.url)) streams.push(srv.url);
                }
              });
            }
          } catch {
          }
        }
        $("video source, video").each((_, el) => {
          const src = $(el).attr("src");
          if (src && !streams.includes(src)) {
            streams.push(this.resolveRelativeUrl(src, baseUrl));
          }
        });
        $("iframe").each((_, el) => {
          const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-player") || $(el).attr("data-url");
          if (src && !streams.includes(src)) {
            streams.push(this.resolveRelativeUrl(src, baseUrl));
          }
        });
        $("[data-video], [data-server], [data-url], [data-src], [data-player], [data-embed], [data-code]").each((_, el) => {
          const val = $(el).attr("data-video") || $(el).attr("data-url") || $(el).attr("data-src") || $(el).attr("data-player") || $(el).attr("data-embed") || $(el).attr("data-code") || "";
          if (val) {
            if (val.startsWith("http://") || val.startsWith("https://") || val.startsWith("//")) {
              const resolved = this.resolveRelativeUrl(val, baseUrl);
              if (!streams.includes(resolved)) streams.push(resolved);
            } else if (this.isBase64(val)) {
              try {
                const decoded = Buffer.from(val, "base64").toString("utf-8");
                if (decoded.startsWith("http") && !streams.includes(decoded)) {
                  streams.push(decoded);
                }
              } catch {
              }
            }
          }
        });
        const hostRegex = /https?:\/\/(?:www\.)?(?:mega\.nz|streamtape\.com|mp4upload\.com|yourupload\.com|streamwish\.[a-z0-9]+|filemoon\.[a-z0-9]+|voe\.[a-z0-9]+|dood\.[a-z0-9]+|doodstream\.[a-z0-9]+|ok\.ru|vidstream\.[a-z0-9]+|fembed\.[a-z0-9]+|mixdrop\.[a-z0-9]+|uqload\.[a-z0-9]+|upstream\.[a-z0-9]+|embedsito\.[a-z0-9]+|streamlare\.[a-z0-9]+|fastre\.[a-z0-9]+|vidmoly\.[a-z0-9]+|luluvdo\.[a-z0-9]+|streamhide\.[a-z0-9]+|gamovideo\.[a-z0-9]+|netu\.[a-z0-9]+|waaw\.[a-z0-9]+|streamdav\.[a-z0-9]+|streamhub\.[a-z0-9]+|zilla-networks\.com)\/[^\s"'<>]+/gi;
        const hostMatches = html.match(hostRegex);
        if (hostMatches) {
          hostMatches.forEach((m) => {
            const clean = m.replace(/\\/g, "");
            if (!streams.includes(clean)) streams.push(clean);
          });
        }
        const mediaFileRegex = /https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4|webm)[^\s"'<>]*/gi;
        const mediaMatches = html.match(mediaFileRegex);
        if (mediaMatches) {
          mediaMatches.forEach((m) => {
            const clean = m.replace(/\\/g, "");
            if (!streams.includes(clean)) streams.push(clean);
          });
        }
        return streams;
      }
      resolveRelativeUrl(url, base) {
        if (url.startsWith("//")) return `https:${url}`;
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        try {
          return new URL(url, base).toString();
        } catch {
          return url;
        }
      }
      isBase64(str) {
        if (str.length < 8 || str.length % 4 !== 0) return false;
        return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
      }
    };
  }
});

// server/utils/titleNormalizer.ts
function detectSeasonMarker(text) {
  for (const marker of SEASON_MARKERS) {
    const m = text.match(marker.re);
    if (m) return marker.resolve(m);
  }
  return null;
}
function isPlausibleTitle(title) {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (/^g[eé]nero\b/i.test(t)) return false;
  if (/g[eé]nero\s*:/i.test(t)) return false;
  if (JUNK_STANDALONE_WORDS.has(t.toLowerCase())) return false;
  const normalizedWords = t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  if (SCRAPER_PLACEHOLDER_TITLES.has(normalizedWords)) return false;
  const compact = t.replace(/[^a-zA-Z0-9]/g, "");
  if (!compact) return false;
  const isShort = compact.length <= 2;
  const isNumeric = /^\d+$/.test(compact);
  const knownShort = /^[A-ZÁÉÍÓÚÑ]/.test(t) && KNOWN_SHORT_TITLES.has(t.toLowerCase());
  if (isShort && !isNumeric && !knownShort) {
    const hasVowel = /[aeiouáéíóúü]/i.test(compact);
    if (!hasVowel || /^[a-zá-ú]/.test(t)) return false;
  }
  return true;
}
function withoutLastYear(text) {
  const re = new RegExp(YEAR_TOKEN_RE.source, "g");
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  return (text.slice(0, last.index) + " " + text.slice(last.index + last[0].length)).replace(/\s+/g, " ").trim();
}
function slugify(text) {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}
function parseRawTitle(raw) {
  const original = String(raw ?? "").replace(/\s+/g, " ").trim();
  let text = original;
  for (const [re, replacement] of MULTIWORD_QUALITY_RES) {
    text = text.replace(re, replacement);
  }
  text = text.replace(/[_]+/g, " ").replace(/\((19|20)\d{2}\)/g, (m) => m.replace(/[()]/g, "")).trim();
  let previous;
  do {
    previous = text;
    text = text.replace(PREFIX_NOISE_RE, "").trim();
  } while (text !== previous);
  text = text.replace(/[:\-–—|]\s*$/g, "").trim();
  const season = detectSeasonMarker(text);
  let year = null;
  for (let guard = 0; guard < 5; guard++) {
    const matches = text.match(YEAR_TOKEN_RE);
    if (!matches || matches.length === 0) break;
    const candidate = Number(matches[matches.length - 1]);
    const remainder = withoutLastYear(text);
    if (remainder === null || !slugify(remainder)) break;
    year = candidate;
    text = remainder;
  }
  const kept = [];
  let sawLatino = false;
  let sawCastellano = false;
  let sawSubs = false;
  let quality = null;
  let cut = false;
  const tokens = text.split(" ");
  for (const token of tokens) {
    const norm = slugify(token);
    if (!norm) continue;
    if (NOISE_TOKENS.has(norm)) {
      if (norm === "latino" || norm === "latinos") sawLatino = true;
      else if (norm === "castellano" || norm === "espanol" || norm === "espa\xF1ol") sawCastellano = true;
      else if (norm === "subtitulado" || norm === "subtitulada" || norm === "sub" || norm === "subs") sawSubs = true;
      else if (/^(hd|hdr|4k|uhd|fhd|fullhd|1080p|720p|480p|2160p)$/.test(norm)) quality = norm;
      if (STRUCTURAL_CUT_TOKENS.has(norm)) cut = true;
      continue;
    }
    if (!cut) kept.push(token);
  }
  const language = sawSubs ? "subtitulado" : sawLatino ? "latino" : sawCastellano ? "castellano" : null;
  let canonical = kept.join(" ").replace(/\s*[,\-–—:|]+\s*$/g, "").replace(/^["'“”]+|["'”]+$/g, "").replace(/\s+/g, " ").trim();
  if (!canonical) {
    canonical = original.trim();
  }
  return { canonical, year, season, language, quality, plausible: isPlausibleTitle(canonical) };
}
function normalizeTitleKey(raw) {
  const { canonical } = parseRawTitle(raw);
  return slugify(canonical);
}
function isSlugLikeTitle(title) {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 3) return false;
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(t)) return true;
  if (/^(?:ver|pelicula|serie|anime|watch)[-_]/i.test(t)) return true;
  if (/^[a-z0-9]{10,}$/.test(t) && !/[A-ZÁÉÍÓÚÑ\s]/.test(t)) return true;
  return false;
}
function splitConcatenatedWords(str) {
  const s = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = s.length;
  if (n < 6) return str;
  const dp = new Array(n + 1).fill(Infinity);
  const prev = new Array(n + 1).fill(-1);
  dp[0] = 0;
  for (let i = 0; i < n; i++) {
    if (dp[i] === Infinity) continue;
    for (let j = i + 1; j <= n; j++) {
      const word = s.substring(i, j);
      if (SEGMENTATION_DICT.has(word)) {
        const cost = dp[i] + 1;
        if (cost < dp[j]) {
          dp[j] = cost;
          prev[j] = i;
        }
      }
    }
  }
  if (dp[n] !== Infinity) {
    const words = [];
    let curr = n;
    while (curr > 0) {
      const p = prev[curr];
      words.unshift(s.substring(p, curr));
      curr = p;
    }
    return words.join(" ");
  }
  return str;
}
function cleanSlugToWords(slug) {
  if (!slug) return "";
  let text = slug.replace(/[-_]+/g, " ").trim();
  if (!text.includes(" ") && text.length >= 8 && text.toLowerCase() === text) {
    const segmented = splitConcatenatedWords(text);
    if (segmented !== text) {
      text = segmented;
    }
  }
  return text.replace(/\s+/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
}
var NOISE_TOKENS, STRUCTURAL_CUT_TOKENS, PREFIX_NOISE_RE, MULTIWORD_QUALITY_RES, WORD_SEASON_NUMS, ROMAN_SEASON_NUMS, SEASON_MARKERS, KNOWN_SHORT_TITLES, JUNK_STANDALONE_WORDS, SCRAPER_PLACEHOLDER_TITLES, YEAR_TOKEN_RE, SEGMENTATION_DICT;
var init_titleNormalizer = __esm({
  "server/utils/titleNormalizer.ts"() {
    "use strict";
    NOISE_TOKENS = /* @__PURE__ */ new Set([
      "ver",
      "veronline",
      "online",
      "gratis",
      "completa",
      "completo",
      "pelicula",
      "peliculas",
      "serie",
      "series",
      "capitulo",
      "episodio",
      "temporada",
      "latino",
      "latinos",
      "castellano",
      "espanol",
      "espa\xF1ol",
      "spanish",
      "subtitulado",
      "subtitulada",
      "sub",
      "subs",
      "vod",
      "hd",
      "hq",
      "hdr",
      "4k",
      "uhd",
      "fhd",
      "fullhd",
      "bluray",
      "brrip",
      "dvdrip",
      "webrip",
      "webdl",
      "x264",
      "x265",
      "hevc",
      "h264",
      "1080p",
      "720p",
      "480p",
      "2160p",
      "1080",
      "720",
      "480",
      "2160",
      "mega",
      "cuevana",
      "cinecalidad",
      "animeflv",
      "tioanime",
      "jkanime",
      "latanime",
      "zonaleros",
      "danime",
      "monoschinos",
      "animeyabu",
      "descargar",
      "descarga",
      "download",
      "estreno",
      "estrenos",
      "audio"
    ]);
    STRUCTURAL_CUT_TOKENS = /* @__PURE__ */ new Set([
      "ver",
      "online",
      "gratis",
      "completa",
      "completo",
      "capitulo",
      "episodio",
      "temporada",
      "descargar",
      "descarga",
      "download"
    ]);
    PREFIX_NOISE_RE = /^(?:ver\s+online(?:\s+gratis)?|ver|watch|pelicula|película|serie|anime|ova|donghua|full\s+movie|episodios\s+de)\s+/i;
    MULTIWORD_QUALITY_RES = [
      [/\bfull\s*hd\b/gi, " fullhd "],
      [/\b(blue|blu)\s*ray\b/gi, " bluray "],
      [/\bweb\s*(dl|rip)\b/gi, " web$1 "]
    ];
    WORD_SEASON_NUMS = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
      ninth: 9,
      tenth: 10,
      eleventh: 11,
      twelfth: 12
    };
    ROMAN_SEASON_NUMS = {
      ii: 2,
      iii: 3,
      iv: 4,
      vi: 6,
      vii: 7,
      viii: 8,
      ix: 9,
      xi: 11,
      xii: 12
    };
    SEASON_MARKERS = [
      { re: /\btemporada\s*(?:n[uú]mero\s*)?-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
      { re: /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, resolve: (m) => Number(m[1]) },
      {
        re: new RegExp(`\\b(${Object.keys(WORD_SEASON_NUMS).join("|")})\\s+season\\b`, "i"),
        resolve: (m) => WORD_SEASON_NUMS[m[1].toLowerCase()] ?? null
      },
      { re: /\bseason\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
      { re: /\bs(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
      { re: /\bpart\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
      {
        re: /\bpart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/i,
        resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null
      },
      {
        re: /(?:^|\s)(II|III|IV|VI|VII|VIII|IX|XI|XII)$/,
        resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null
      },
      { re: /\bfinal\s+season\b/i, resolve: () => null }
    ];
    KNOWN_SHORT_TITLES = /* @__PURE__ */ new Set(["up", "it", "x", "us", "we", "ox", "yo"]);
    JUNK_STANDALONE_WORDS = /* @__PURE__ */ new Set(["un", "una", "de", "del", "y", "o"]);
    SCRAPER_PLACEHOLDER_TITLES = /* @__PURE__ */ new Set([
      "contenido cinecalidad",
      "contenido lamovie",
      "pelicula tubepelis",
      "anime tioanime",
      "anime latanime",
      "anime veranimes",
      "contenido no disponible veranimes"
    ]);
    YEAR_TOKEN_RE = /\b(?:19|20)\d{2}\b/g;
    SEGMENTATION_DICT = /* @__PURE__ */ new Set([
      // Spanish articles, prepositions, pronouns
      "el",
      "la",
      "los",
      "las",
      "un",
      "una",
      "unos",
      "unas",
      "de",
      "del",
      "al",
      "en",
      "para",
      "por",
      "con",
      "sin",
      "sobre",
      "a",
      "y",
      "o",
      "u",
      "e",
      "que",
      "se",
      "su",
      "sus",
      "mi",
      "mis",
      "tu",
      "tus",
      "lo",
      "le",
      "les",
      "me",
      "te",
      "nos",
      "os",
      "no",
      "si",
      "mas",
      "m\xE1s",
      "pero",
      "como",
      "cuando",
      "donde",
      "quien",
      "quienes",
      "cual",
      "cuales",
      "este",
      "esta",
      "estos",
      "estas",
      "ese",
      "esa",
      "esos",
      "esas",
      "aquel",
      "aquella",
      // Common nouns & verbs in titles
      "temporada",
      "matar",
      "muerte",
      "muerto",
      "muerta",
      "vida",
      "amor",
      "corazon",
      "coraz\xF3n",
      "alma",
      "almas",
      "testigo",
      "testigos",
      "ultimo",
      "\xFAltimo",
      "ultima",
      "\xFAltima",
      "temple",
      "acero",
      "testamento",
      "testamentos",
      "hija",
      "hijas",
      "hijo",
      "hijos",
      "padre",
      "padres",
      "madre",
      "madres",
      "hermano",
      "hermanos",
      "hermana",
      "hermanas",
      "gilead",
      "primavera",
      "verano",
      "otono",
      "oto\xF1o",
      "invierno",
      "noche",
      "noches",
      "dia",
      "d\xEDas",
      "dias",
      "mundo",
      "mundos",
      "tiempo",
      "tiempos",
      "hora",
      "horas",
      "hombre",
      "hombres",
      "mujer",
      "mujeres",
      "nino",
      "ni\xF1o",
      "nina",
      "ni\xF1a",
      "casa",
      "casas",
      "camino",
      "caminos",
      "calle",
      "calles",
      "ciudad",
      "ciudades",
      "pueblo",
      "pueblos",
      "bosque",
      "guerra",
      "guerras",
      "paz",
      "batalla",
      "batallas",
      "soldado",
      "soldados",
      "ejercito",
      "ej\xE9rcito",
      "rey",
      "reyes",
      "reina",
      "reinas",
      "viaje",
      "viajes",
      "secreto",
      "secretos",
      "historia",
      "historias",
      "sombra",
      "sombras",
      "oscuridad",
      "luz",
      "luces",
      "fuego",
      "sangre",
      "destino",
      "destinos",
      "ojo",
      "ojos",
      "fuerza",
      "poder",
      "poderes",
      "final",
      "principio",
      "silencio",
      "viento",
      "mar",
      "mares",
      "tierra",
      "tierras",
      "cielo",
      "cielos",
      "estrella",
      "estrellas",
      "sol",
      "luna",
      "amigo",
      "amigos",
      "amiga",
      "amigas",
      "enemigo",
      "enemigos",
      "isla",
      "islas",
      "castillo",
      "palacio",
      "rio",
      "r\xEDo",
      "sueno",
      "sue\xF1o",
      "suenos",
      "sue\xF1os",
      "pesadilla",
      "pesadillas",
      "misterio",
      "misterios",
      "crimen",
      "crimenes",
      "cr\xEDmenes",
      "asesino",
      "asesinos",
      "asesina",
      "policia",
      "polic\xEDa",
      "detective",
      "detectives",
      "agente",
      "agentes",
      "doctor",
      "doctores",
      "profesor",
      "profesores",
      "maestro",
      "maestros",
      "escuela",
      "colegio",
      "hospital",
      "prision",
      "prisi\xF3n",
      "carcel",
      "c\xE1rcel",
      "oro",
      "plata",
      "diamante",
      "diamantes",
      "tesoro",
      "tesoros",
      "perro",
      "perros",
      "gato",
      "gatos",
      "lobo",
      "lobos",
      "dragon",
      "drag\xF3n",
      "dragones",
      "monstruo",
      "monstruos",
      "demonio",
      "demonios",
      "fantasma",
      "fantasmas",
      "zombie",
      "zombies",
      "vampiro",
      "vampiros",
      "robot",
      "robots",
      "nave",
      "naves",
      "espacio",
      "planeta",
      "planetas",
      "galaxia",
      "universo",
      "primero",
      "primera",
      "segundo",
      "segunda",
      "tercero",
      "tercera",
      "cuarto",
      "cuarta",
      "quinto",
      "quinta",
      "dos",
      "tres",
      "cuatro",
      "cinco",
      "seis",
      "siete",
      "ocho",
      "nueve",
      "diez",
      "cien",
      "mil",
      "gran",
      "grande",
      "pequeno",
      "peque\xF1o",
      "bueno",
      "malo",
      "nuevo",
      "nueva",
      "viejo",
      "vieja",
      "alto",
      "bajo",
      "negro",
      "negra",
      "blanco",
      "blanca",
      "rojo",
      "roja",
      "azul",
      "verde",
      "amarillo",
      "perdido",
      "perdida",
      "olvidado",
      "olvidada",
      "maldito",
      "maldita",
      "oculto",
      "oculta",
      "oscuro",
      "oscura",
      "eterno",
      "eterna",
      "infierno",
      "paraiso",
      "para\xEDso",
      "cazador",
      "cazadores",
      "venganza",
      "justicia",
      "ley",
      "escapar",
      "escape",
      "huida",
      "rescate",
      "salvar",
      "perder",
      "ganar",
      "vivir",
      "morir",
      "amar",
      "odiar",
      "buscar",
      "encontrar",
      "volver",
      "regreso",
      "caida",
      "ca\xEDda",
      "ascenso",
      "origen",
      "nacimiento",
      "imperio",
      "reino",
      "trono",
      "corona",
      "espada",
      "magia",
      "mago",
      "bruja",
      "hechizo",
      "pacto",
      "promesa",
      "traicion",
      "traici\xF3n",
      "culpa",
      "pecado",
      "miedo",
      "terror",
      "panico",
      "p\xE1nico",
      "peligro",
      "amenaza",
      "invasion",
      "invasi\xF3n",
      "rebelion",
      "rebeli\xF3n",
      "resistencia",
      "alianza",
      "legado",
      "cronicas",
      "cr\xF3nicas",
      "memorias",
      "diario",
      // French words
      "six",
      "jours",
      "ce",
      "cette",
      "ces",
      "printemps",
      "ete",
      "\xE9t\xE9",
      "automne",
      "hiver",
      "nuit",
      "jour",
      "homme",
      "femme",
      "enfant",
      "fille",
      "garcon",
      "gar\xE7on",
      "fils",
      "pere",
      "p\xE8re",
      "mere",
      "m\xE8re",
      "amour",
      "mort",
      "vie",
      "coeur",
      "c\u0153ur",
      "monde",
      "temps",
      "maison",
      "ville",
      "rue",
      "chemin",
      "deux",
      "trois",
      "quatre",
      "cinq",
      "sept",
      "huit",
      "neuf",
      "dix",
      "cent",
      "mille",
      "grand",
      "grande",
      "petit",
      "petite",
      "beau",
      "belle",
      "bon",
      "bonne",
      "mauvais",
      "noir",
      "blanc",
      "rouge",
      "bleu",
      "vert",
      "nouveau",
      "nouvelle",
      "vieux",
      "vieille",
      "premier",
      "premiere",
      "derniers",
      "dernier",
      "derniere",
      "plus",
      "moins",
      "sans",
      "avec",
      "pour",
      "dans",
      "sur",
      "sous",
      "par",
      "entre",
      "vers",
      "chez",
      "tout",
      "tous",
      "toute",
      "toutes",
      "rien",
      "autre",
      "autres",
      "meme",
      "m\xEAme",
      "aussi",
      "bien",
      "mal",
      "diable",
      "dieu",
      "ange",
      "forts",
      "fort",
      "forte",
      // English words
      "the",
      "of",
      "and",
      "in",
      "to",
      "is",
      "that",
      "for",
      "it",
      "as",
      "was",
      "with",
      "on",
      "at",
      "by",
      "this",
      "from",
      "they",
      "we",
      "say",
      "her",
      "she",
      "or",
      "an",
      "will",
      "my",
      "one",
      "all",
      "would",
      "there",
      "their",
      "what",
      "so",
      "up",
      "out",
      "if",
      "about",
      "who",
      "get",
      "which",
      "go",
      "me",
      "when",
      "make",
      "can",
      "like",
      "time",
      "no",
      "just",
      "him",
      "know",
      "take",
      "people",
      "into",
      "year",
      "your",
      "good",
      "some",
      "could",
      "them",
      "see",
      "other",
      "than",
      "then",
      "now",
      "look",
      "only",
      "come",
      "its",
      "over",
      "think",
      "also",
      "back",
      "after",
      "use",
      "two",
      "how",
      "our",
      "work",
      "first",
      "well",
      "way",
      "even",
      "new",
      "want",
      "because",
      "any",
      "these",
      "give",
      "day",
      "most",
      "us",
      "night",
      "man",
      "woman",
      "child",
      "children",
      "love",
      "dead",
      "death",
      "die",
      "life",
      "live",
      "living",
      "black",
      "white",
      "red",
      "blue",
      "green",
      "dark",
      "light",
      "shadow",
      "blood",
      "fire",
      "ice",
      "water",
      "earth",
      "wind",
      "sky",
      "star",
      "stars",
      "moon",
      "sun",
      "space",
      "world",
      "lost",
      "last",
      "king",
      "queen",
      "lord",
      "god",
      "devil",
      "angel",
      "monster",
      "beast",
      "dragon",
      "house",
      "room",
      "city",
      "town",
      "street",
      "road",
      "hunt",
      "hunter",
      "fall",
      "rise",
      "game",
      "war",
      "battle",
      "fight",
      "killer",
      "secret",
      "secrets",
      "silent",
      "silence",
      "fear",
      "ghost",
      "horror",
      "nightmare",
      "dream",
      "dreams",
      "boy",
      "girl",
      "friend",
      "friends",
      "enemy",
      "enemies",
      "dog",
      "dogs",
      "cat",
      "cats",
      "wolf",
      "wolves",
      "forever",
      "never",
      "beyond",
      "under",
      "inside",
      "outside",
      "behind",
      "before",
      "truth",
      "lie",
      "lies",
      "mind",
      "heart",
      "soul",
      "souls",
      "hero",
      "heroes",
      "iron",
      "steel",
      "gold",
      "silver",
      "crown",
      "sword",
      "gun",
      "guns",
      // Expanded dictionary for DB squashed titles
      "huracanes",
      "maze",
      "runner",
      "prueba",
      "hombres",
      "entre",
      "abuela",
      "exterminio",
      "huesos",
      "ninera",
      "balas",
      "tintin",
      "sol",
      "testimonio",
      "anne",
      "lee",
      "temporal",
      "state",
      "siege",
      "temple",
      "attack",
      "indiana",
      "jones",
      "maldito",
      "rescate",
      "metro",
      "juventud",
      "siniestra",
      "bodas",
      "pokemon",
      "ranger",
      "crimen",
      "sr",
      "carrito",
      "caballeros",
      "templarios",
      "perdicion",
      "brujas",
      "actitud",
      "anos",
      "despues",
      "doce",
      "asterix",
      "shinmai",
      "maou",
      "no",
      "testament",
      "specials",
      "anime",
      "hibike",
      "euphonium",
      "ensemble",
      "contest",
      "hen",
      "baka",
      "shoukanjuu",
      "matsuri",
      "departures",
      "story",
      "moses",
      "protegido",
      "ova",
      "fastest",
      "finger",
      "notorious",
      "talker",
      "runs",
      "worlds",
      "greatest",
      "clan",
      "fate",
      "grand",
      "order",
      "singularidad",
      "gran",
      "salomon",
      "shoukanju",
      "unico"
    ]);
  }
});

// server/metadataEngine.ts
function parseTitleQuery(raw) {
  const fallbackBase = raw.replace(/\s+/g, " ").trim();
  let title = fallbackBase;
  title = title.replace(/\s*(?:en\s+español\s+latino|español\s+latino|spanish\s+latino)/gi, " ");
  let season = null;
  for (const pattern of SEASON_PATTERNS) {
    const m = title.match(pattern.re);
    if (m) {
      season = pattern.resolve(m);
      title = title.replace(pattern.re, " ");
      break;
    }
  }
  let year = null;
  const yearMatch = title.match(YEAR_PATTERN);
  if (yearMatch) {
    year = Number.parseInt(yearMatch[0], 10);
    title = title.replace(YEAR_PATTERN, " ");
  }
  title = title.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ");
  title = title.trim();
  let previous;
  do {
    previous = title;
    title = title.replace(QUERY_PREFIX_RE, "");
  } while (title !== previous);
  title = title.replace(/\s*\(TV\)/i, "");
  title = title.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]|\s*\{[^}]*\}/g, "");
  title = title.replace(/\s*(?:Sub\s*Español|Audio\s*Latino|Latino|Castellano|Dual|1080p|720p|4K|HD|Full\s*HD|Online|Gratis|Free|Episodio\s*\d+|Capitulo\s*\d+|Cap\s*\d+|S\d+E\d+).*$/i, "");
  title = title.replace(/\s+[-|—]\s*$/, "");
  title = title.split(/\s+[-|—]\s+/)[0].trim();
  title = title.replace(/\s+\([^)]*\)$/g, "");
  title = title.replace(/^Ver\s+/i, "");
  title = title.replace(/\s+/g, " ").trim();
  return {
    baseTitle: title || fallbackBase,
    season,
    year
  };
}
function cleanQueryTitle(raw) {
  return parseTitleQuery(raw).baseTitle;
}
function isGenericQuery(lower) {
  return GENERIC_TITLES.has(lower) || lower.length < 3 || /^page\s*\d+$/i.test(lower) || lower.startsWith("page ") || lower.includes("pagina ");
}
function normalizeGenreKey(genre) {
  return String(genre ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function translateGenresToEs(genres) {
  const out = [];
  for (const g of Array.isArray(genres) ? genres : []) {
    if (typeof g !== "string" || !g.trim()) continue;
    const translated = GENRE_ES_ALIASES[normalizeGenreKey(g)] || g.trim();
    const parts = translated.split(",").map((p) => p.trim());
    for (const p of parts) {
      if (!out.includes(p)) out.push(p);
    }
  }
  return out;
}
function isSubstantiveDescription(description) {
  const t = String(description ?? "").trim();
  if (!t || t === "Sin descripci\xF3n disponible.") return false;
  return t.length >= 60;
}
function buildSearchCandidates(rawQuery) {
  const rawParsed = parseRawTitle(rawQuery);
  const legacy = parseTitleQuery(rawQuery);
  const tidy = (t) => t.replace(/\s+/g, " ").replace(/\s+(?:en|de|del|un|una|y|o)$/i, "").replace(/\s*[,\-–—:|]+\s*$/, "").trim();
  const out = [];
  for (const c of [tidy(rawParsed.canonical), tidy(legacy.baseTitle)]) {
    if (c && c.length >= 2 && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  const rawFallback = String(rawQuery ?? "").replace(/\s+/g, " ").trim();
  if (out.length === 0 && rawFallback) out.push(rawFallback);
  return out;
}
function buildDefaultMetadata(cleaned, rawQuery, hintKind, genres = ["Multimedia"]) {
  return {
    title: cleaned || rawQuery || "Contenido Multimedia",
    description: "Contenido indexado en VoidStream con reproductor Just-In-Time.",
    poster_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800&q=80",
    banner_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&q=80",
    rating: 8,
    year: 0,
    status: "Finalizado",
    genres,
    content_type: hintKind || "anime"
  };
}
async function fetchTMDBGenreMap(mediaType) {
  const cached = tmdbGenreCache.get(mediaType);
  if (cached && Date.now() - cached.fetchedAt < TMDB_GENRE_TTL_MS) {
    return cached.names;
  }
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return /* @__PURE__ */ new Map();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.themoviedb.org/3/genre/${mediaType}/list?language=es-MX&api_key=${apiKey}`, {
      // NOSONAR
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const names = /* @__PURE__ */ new Map();
      for (const g of data?.genres || []) {
        if (typeof g?.id === "number" && typeof g?.name === "string") {
          names.set(g.id, translateGenresToEs([g.name])[0] || g.name);
        }
      }
      tmdbGenreCache.set(mediaType, { names, fetchedAt: Date.now() });
      return names;
    }
  } catch {
  }
  return cached?.names || /* @__PURE__ */ new Map();
}
async function fetchTMDBEnUSResult(query, tmdbId) {
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&language=en-US&api_key=${apiKey}`, {
      // NOSONAR
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const match = (data?.results || []).find((r) => r?.id === tmdbId && r.media_type !== "person");
      if (!match) return null;
      return {
        title: match?.title || match?.name || "",
        overview: typeof match?.overview === "string" ? match.overview : ""
      };
    }
  } catch {
  }
  return null;
}
async function fetchTMDBMetadata(query, kind, seasonHint, yearHint) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&language=es-MX&api_key=${apiKey}`, {
      // NOSONAR
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        let candidates = data.results.filter((r) => r.media_type !== "person");
        if (kind === "movie") {
          candidates = candidates.filter((r) => r.media_type === "movie");
        } else if (kind === "series" || kind === "anime") {
          candidates = candidates.filter((r) => r.media_type === "tv");
        }
        const queryKey = normalizeTitleKey(query);
        const queryTokens = new Set(queryKey.match(/[a-z0-9]+/g) || []);
        const candidateScore = (candidate) => {
          const names = [candidate?.title, candidate?.name, candidate?.original_title, candidate?.original_name].filter((value) => typeof value === "string" && value.trim()).map((value) => normalizeTitleKey(value));
          let score = 0;
          for (const name of names) {
            if (!name || !queryKey) continue;
            if (name === queryKey) score = Math.max(score, 1);
            else if (name.includes(queryKey) || queryKey.includes(name)) score = Math.max(score, 0.82);
            else {
              const nameTokens = new Set(name.match(/[a-z0-9]+/g) || []);
              let overlap = 0;
              for (const token of queryTokens) if (nameTokens.has(token)) overlap++;
              const union = (/* @__PURE__ */ new Set([...queryTokens, ...nameTokens])).size;
              score = Math.max(score, union > 0 ? overlap / union : 0);
            }
          }
          const textualScore = score;
          const resultYear = Number.parseInt(String(candidate?.release_date || candidate?.first_air_date || "").slice(0, 4), 10);
          if (textualScore >= 0.15 && yearHint && resultYear === yearHint) score += 0.25;
          else if (textualScore >= 0.15 && yearHint && Number.isFinite(resultYear) && Math.abs(resultYear - yearHint) > 1) score -= 0.2;
          score += Math.min(0.03, Number(candidate?.popularity || 0) / 1e4);
          return score;
        };
        const rankedCandidates = candidates.map((candidate, index) => ({ candidate, index, score: candidateScore(candidate) })).sort((a, b) => b.score - a.score || a.index - b.index);
        let bestResult = rankedCandidates[0]?.candidate;
        if (rankedCandidates[0] && rankedCandidates[0].score < 0.15) bestResult = void 0;
        if (yearHint != null && Array.isArray(candidates)) {
          const yearMatch = rankedCandidates.find(({ candidate, score }) => {
            if (score < 0.15) return false;
            const r = candidate;
            const y = Number.parseInt(String(r.release_date || r.first_air_date || "").substring(0, 4), 10);
            return y === yearHint;
          })?.candidate;
          if (yearMatch) bestResult = yearMatch;
        }
        if (bestResult && !(bestResult.overview || "").trim()) {
          const withOverview = candidates.filter(
            (r) => (r.overview || "").trim().length > 0 && r.media_type === bestResult.media_type
          );
          if (withOverview.length > 0) {
            const sameYear = yearHint != null ? withOverview.find((r) => Number.parseInt(String(r.release_date || r.first_air_date || "").substring(0, 4), 10) === yearHint) : void 0;
            bestResult = sameYear || withOverview[0];
          }
        }
        if (bestResult) {
          const isTV = bestResult.media_type === "tv";
          const title = bestResult.title || bestResult.name || query;
          const originalTitle = bestResult.original_title || bestResult.original_name || title;
          let englishTitle = null;
          let enOverview = "";
          if (bestResult.original_language === "en" && (bestResult.overview || "").trim()) {
            englishTitle = bestResult.original_title || bestResult.original_name || title;
          } else {
            const enRes = await fetchTMDBEnUSResult(query, bestResult.id);
            englishTitle = enRes?.title || bestResult.original_title || bestResult.original_name || null;
            enOverview = enRes?.overview || "";
          }
          let overviewRaw = bestResult.overview || "";
          if (!overviewRaw.trim() && enOverview.trim()) overviewRaw = enOverview;
          const overview = await cleanAndTranslateDescription(overviewRaw);
          const posterPath = bestResult.poster_path || null;
          const backdropPath = bestResult.backdrop_path || null;
          const poster = posterPath ? `https://image.tmdb.org/t/p/w780${posterPath}` : null;
          const banner = backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : poster;
          const yearStr = bestResult.release_date || bestResult.first_air_date || "";
          const year = yearStr ? parseInt(yearStr.substring(0, 4), 10) : 0;
          const rating = bestResult.vote_average ? Math.round(bestResult.vote_average * 10) / 10 : 8;
          let genres = [];
          const genreMap = await fetchTMDBGenreMap(isTV ? "tv" : "movie");
          if (genreMap.size > 0 && Array.isArray(bestResult.genre_ids)) {
            genres = bestResult.genre_ids.map((gid) => genreMap.get(gid)).filter((g) => Boolean(g));
          }
          if (genres.length === 0) {
            genres = [isTV ? "Serie de TV" : "Pel\xEDcula"];
          }
          let contentType = kind || (isTV ? "series" : "movie");
          if (isTV && bestResult.origin_country && bestResult.origin_country.includes("JP")) {
            contentType = "anime";
          }
          void seasonHint;
          return {
            title,
            original_title: originalTitle,
            english_title: englishTitle || void 0,
            description: overview,
            poster_url: poster,
            banner_url: banner,
            rating,
            year,
            status: "Finalizado",
            // TMDB search doesn't give status directly without another fetch
            genres,
            content_type: contentType,
            tmdb_id: typeof bestResult.id === "number" ? bestResult.id : void 0,
            poster_path: posterPath,
            backdrop_path: backdropPath
          };
        }
      }
    }
  } catch {
  }
  return null;
}
function isSuspiciousAnimeMatch(meta) {
  if (!meta.tmdb_id) return false;
  const hasAnimationGenre = Array.isArray(meta.genres) && meta.genres.some((g) => /anim/i.test(g));
  const tooOldForAnime = meta.year < 1995;
  return !hasAnimationGenre || tooOldForAnime;
}
async function fillWeakDescription(meta, kindHint, query) {
  if (isSubstantiveDescription(meta.description)) return meta;
  const sources = [];
  if (kindHint === "anime" || kindHint === "series" || !kindHint) {
    sources.push(await fetchAnimeMetadata(query).then((m) => m ? { desc: m.description, genres: m.genres } : {}));
  }
  if (kindHint === "series" || kindHint === "movie" || !kindHint) {
    sources.push(await fetchTVMazeMetadata(query).then((m) => m ? { desc: m.description, genres: m.genres } : {}));
  }
  sources.push(await fetchWikipediaMetadata(query).then((m) => m ? { desc: m.description } : {}));
  for (const s of sources) {
    if (s.desc && isSubstantiveDescription(s.desc)) {
      meta.description = s.desc;
      const generic = /* @__PURE__ */ new Set(["Pel\xEDcula", "Serie de TV", "Multimedia", "Anime"]);
      if (meta.genres.length <= 1 && generic.has(meta.genres[0]) && s.genres && s.genres.length > 1) {
        meta.genres = translateGenresToEs(s.genres);
      }
      break;
    }
  }
  return meta;
}
async function enrichUniversalMetadata(rawQuery, hintKind) {
  const parsed = parseTitleQuery(rawQuery);
  const cleaned = parsed.baseTitle;
  const lower = cleaned.toLowerCase();
  const candidates = buildSearchCandidates(rawQuery);
  const yearHint = parsed.year ?? null;
  let tmdbData = null;
  for (const cand of candidates) {
    const res = await fetchTMDBMetadata(cand, hintKind, parsed.season, yearHint);
    if (!res) continue;
    if (!tmdbData) tmdbData = res;
    if (isSubstantiveDescription(res.description)) {
      tmdbData = res;
      break;
    }
  }
  if (tmdbData && (hintKind === "anime" || hintKind === "series") && isSuspiciousAnimeMatch(tmdbData)) {
    const animeMeta = await fetchAnimeMetadata(cleaned);
    if (animeMeta) return animeMeta;
    return fillWeakDescription(tmdbData, hintKind, cleaned);
  }
  if (tmdbData) return fillWeakDescription(tmdbData, hintKind, cleaned);
  if (isGenericQuery(lower)) {
    return buildDefaultMetadata(cleaned, rawQuery, hintKind, ["Multimedia"]);
  }
  if (hintKind === "open_archive" || lower.includes("archive.org") || lower.includes("dominio publico")) {
    const archiveMeta2 = await fetchArchiveOrgMetadata(cleaned);
    if (archiveMeta2) return archiveMeta2;
  }
  if (hintKind === "anime" || !hintKind) {
    const animeMeta = await fetchAnimeMetadata(cleaned);
    if (animeMeta && (animeMeta.rating > 0 || hintKind === "anime")) {
      return animeMeta;
    }
  }
  if (hintKind === "series" || hintKind === "movie" || !hintKind) {
    const tvMeta = await fetchTVMazeMetadata(cleaned);
    if (tvMeta) {
      if (hintKind) tvMeta.content_type = hintKind;
      return tvMeta;
    }
  }
  const archiveMeta = await fetchArchiveOrgMetadata(cleaned);
  if (archiveMeta) return archiveMeta;
  const wikiMeta = await fetchWikipediaMetadata(cleaned);
  if (wikiMeta) return wikiMeta;
  return buildDefaultMetadata(cleaned, rawQuery, hintKind, ["Acci\xF3n", "Aventura"]);
}
async function fetchAnimeMetadata(query) {
  const simplifiedQuery = query.replace(/\s*(?:\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|\b[IVXLCDM]+\b)/gi, "").replace(/\s*\([^)]*\)|\s*\[[^\]]*\]|\s*\{[^}]*\}/g, "").replace(/[-_]/g, " ").trim();
  const searchQuery = simplifiedQuery.length >= 3 ? simplifiedQuery : query;
  try {
    const graphqlQuery = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
          title {
            romaji
            english
            native
          }
          description(asHtml: false)
          coverImage {
            extraLarge
            large
          }
          bannerImage
          averageScore
          startDate {
            year
          }
          status
          genres
          episodes
        }
      }
    `;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch("https://graphql.anilist.co", {
      // NOSONAR
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: graphqlQuery, variables: { search: searchQuery } })
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const media = data?.data?.Media;
      if (media) {
        const poster = media.coverImage?.extraLarge || media.coverImage?.large || null;
        const banner = media.bannerImage || poster;
        const cleanDesc = await cleanAndTranslateDescription(media.description || "");
        return {
          title: media.title?.romaji || media.title?.english || query,
          original_title: media.title?.native || media.title?.romaji,
          japanese_title: media.title?.native || void 0,
          english_title: media.title?.english || void 0,
          description: cleanDesc || "Sin descripci\xF3n disponible.",
          poster_url: poster,
          banner_url: banner,
          rating: media.averageScore ? Math.round(media.averageScore / 10 * 10) / 10 : 8.2,
          year: media.startDate?.year || 0,
          status: media.status === "RELEASING" ? "En emisi\xF3n" : "Finalizado",
          // AniList devuelve géneros en inglés (Action, Comedy...): traducir.
          genres: translateGenresToEs(Array.isArray(media.genres) ? media.genres : []).length > 0 ? translateGenresToEs(media.genres) : ["Anime"],
          content_type: "anime"
        };
      }
    }
  } catch {
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4e3);
    const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`, {
      // NOSONAR
      signal: controller.signal,
      headers: {
        "User-Agent": "VoidStream-Universal-Scraper/2.5",
        Accept: "application/vnd.api+json"
      }
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json?.data && json.data.length > 0) {
        const attr = json.data[0].attributes || {};
        const poster = attr.posterImage?.large || attr.posterImage?.original || attr.posterImage?.medium;
        const cover = attr.coverImage?.large || attr.coverImage?.original || poster;
        return {
          title: attr.canonicalTitle || query,
          original_title: attr.titles?.ja_jp,
          japanese_title: attr.titles?.ja_jp || void 0,
          english_title: attr.titles?.en || void 0,
          description: await cleanAndTranslateDescription(attr.synopsis || ""),
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round(Number.parseFloat(attr.averageRating) / 10 * 10) / 10 : 8,
          year: attr.startDate ? Number.parseInt(attr.startDate.slice(0, 4), 10) : 0,
          status: attr.status === "current" ? "En emisi\xF3n" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime"
        };
      }
    }
  } catch {
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4e3);
    const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchQuery)}&limit=1`, {
      // NOSONAR
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" }
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      if (json?.data && json.data.length > 0) {
        const item = json.data[0];
        const poster = item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || item.images?.jpg?.image_url;
        const rawGenres = Array.isArray(item.genres) ? item.genres.map((g) => g.name).filter(Boolean) : [];
        const genres = translateGenresToEs(rawGenres).length > 0 ? translateGenresToEs(rawGenres) : ["Anime"];
        return {
          title: item.title || query,
          original_title: item.title_japanese || item.title,
          japanese_title: item.title_japanese || void 0,
          english_title: item.title_english || void 0,
          description: await cleanAndTranslateDescription(item.synopsis || ""),
          poster_url: poster,
          banner_url: poster,
          rating: item.score || 8.2,
          year: item.year || item.aired?.prop?.from?.year || 0,
          status: item.status === "Currently Airing" ? "En emisi\xF3n" : "Finalizado",
          genres,
          content_type: "anime",
          mal_id: item.mal_id
        };
      }
    }
  } catch {
  }
  return null;
}
async function fetchTVMazeMetadata(query) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}&embed=episodes`, {
      // NOSONAR
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" }
    });
    clearTimeout(timer);
    if (res.ok) {
      const show = await res.json();
      if (show && show.name) {
        const poster = show.image?.original || show.image?.medium || null;
        const cleanSummary = await cleanAndTranslateDescription(show.summary || "");
        const year = show.premiered ? Number.parseInt(show.premiered.slice(0, 4), 10) : 0;
        const isAnime = (show.type || "").toLowerCase() === "animation" && (show.genres || []).includes("Anime");
        const suggested_episodes = (show._embedded?.episodes || []).map((ep) => {
          const season = ep.season || 1;
          const number = ep.number || 1;
          return {
            number: season * 100 + number,
            title: `T${season}E${number}: ${ep.name || "Episodio"}`,
            url: ep.url || void 0
          };
        });
        return {
          title: show.name,
          original_title: show.name,
          description: cleanSummary || "Serie de televisi\xF3n indexada con \xE9xito.",
          poster_url: poster,
          banner_url: poster,
          rating: show.rating?.average || 8.2,
          year,
          status: show.status === "Running" ? "En emisi\xF3n" : "Finalizado",
          // TVMaze devuelve géneros en inglés (Drama, Science-Fiction...): traducir.
          genres: translateGenresToEs(show.genres || []).length > 0 ? translateGenresToEs(show.genres) : ["Serie de TV", "Drama"],
          content_type: isAnime ? "anime" : show.type === "Scripted" || show.type === "Reality" ? "series" : "movie",
          suggested_episodes: suggested_episodes.length > 0 ? suggested_episodes.slice(0, 30) : void 0
        };
      }
    }
  } catch {
  }
  return null;
}
async function fetchArchiveOrgMetadata(query) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:(movies)&fl[]=identifier,title,description,year,publicdate&sort[]=&rows=1&page=1&output=json`;
    const res = await fetch(searchUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const doc = data?.response?.docs?.[0];
      if (doc && doc.identifier) {
        const id = doc.identifier;
        const poster = `https://archive.org/services/img/${id}`;
        const streamMp4 = `https://archive.org/download/${id}/${id}.mp4`;
        return {
          title: doc.title || query,
          original_title: doc.title,
          description: await cleanAndTranslateDescription(doc.description || "Pel\xEDcula u obra audiovisual de libre acceso en Internet Archive."),
          poster_url: poster,
          banner_url: poster,
          rating: 8.5,
          year: doc.year ? Number.parseInt(doc.year, 10) : 1970,
          status: "Dominio P\xFAblico",
          genres: ["Cl\xE1sico", "Dominio P\xFAblico", "Cine de Culto"],
          content_type: "open_archive",
          suggested_episodes: [
            {
              number: 1,
              title: `${doc.title || "Pel\xEDcula Completa"} [Archive.org HD]`,
              url: streamMp4
            }
          ]
        };
      }
    }
  } catch {
  }
  return null;
}
async function fetchWikipediaMetadata(query) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {
      // NOSONAR
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" }
    });
    clearTimeout(timer);
    if (res.ok) {
      const page = await res.json();
      if (page && page.title && page.extract) {
        return {
          title: page.title,
          description: await cleanAndTranslateDescription(typeof page.extract === "string" ? page.extract : page.extract ? String(page.extract) : ""),
          poster_url: page.thumbnail?.source || page.originalimage?.source || null,
          banner_url: page.originalimage?.source || page.thumbnail?.source || null,
          rating: 8,
          year: 0,
          status: "Finalizado",
          genres: ["Pel\xEDcula / Obra"],
          content_type: "movie"
        };
      }
    }
  } catch {
  }
  return null;
}
function decodeHtmlEntities(text) {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16))).replace(/&amp;/g, "&");
}
async function tryGoogleTranslate(text) {
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (Array.isArray(json) && Array.isArray(json[0])) {
      const translated = json[0].map((x) => Array.isArray(x) ? String(x[0]) : "").join("");
      return translated || null;
    }
  } catch {
  }
  return null;
}
async function tryMyMemoryTranslate(text) {
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0, 500))}&langpair=en|es`);
    if (!res.ok) return null;
    const json = await res.json();
    const translated = json?.responseData?.translatedText;
    if (typeof translated === "string" && translated.trim()) return decodeHtmlEntities(translated);
  } catch {
  }
  return null;
}
async function cleanAndTranslateDescription(text) {
  if (!text || text.trim() === "") return "Sin descripci\xF3n disponible.";
  let cleaned = text.replace(/<[^>]*>?/gm, "").replace(/\n\s*\n/g, "\n").replace(/\(Source:[^)]+\)/gi, "").replace(/\[Written by[^\]]+\]/gi, "").replace(/Source:[^\n]+/gi, "").trim();
  if (cleaned.length === 0) return "Sin descripci\xF3n disponible.";
  const source = cleaned.substring(0, 1500);
  const google1 = await tryGoogleTranslate(source);
  if (google1) return google1;
  await new Promise((r) => setTimeout(r, 400));
  const google2 = await tryGoogleTranslate(source);
  if (google2) return google2;
  const fallback = await tryMyMemoryTranslate(source);
  if (fallback) return fallback;
  return cleaned;
}
var import_config, WORD_SEASON_NUMS2, ROMAN_SEASON_NUMS2, SEASON_PATTERNS, YEAR_PATTERN, QUERY_PREFIX_RE, GENERIC_TITLES, GENRE_ES_ALIASES, TMDB_GENRE_TTL_MS, tmdbGenreCache;
var init_metadataEngine = __esm({
  "server/metadataEngine.ts"() {
    "use strict";
    import_config = require("dotenv/config");
    init_titleNormalizer();
    WORD_SEASON_NUMS2 = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
      ninth: 9,
      tenth: 10,
      eleventh: 11,
      twelfth: 12
    };
    ROMAN_SEASON_NUMS2 = {
      ii: 2,
      iii: 3,
      iv: 4,
      vi: 6,
      vii: 7,
      viii: 8,
      ix: 9,
      xi: 11,
      xii: 12
    };
    SEASON_PATTERNS = [
      { re: /\btemporada\s*(?:n[uú]mero\s*)?-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      { re: /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      {
        re: new RegExp(`\\b(${Object.keys(WORD_SEASON_NUMS2).join("|")})\\s+season\\b`, "i"),
        resolve: (m) => WORD_SEASON_NUMS2[m[1].toLowerCase()] ?? null
      },
      { re: /\bseason\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      { re: /\bTP\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      { re: /\bS(\d{1,2})\s*E\d+\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      // "S2"/"S02" SOLO token independiente (\b evita "Boss 2"/"PS2").
      { re: /\bs(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      { re: /\bpart\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      {
        re: /\bpart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/i,
        resolve: (m) => ROMAN_SEASON_NUMS2[m[1].toLowerCase()] ?? null
      },
      { re: /\bT(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
      {
        re: /(?:^|\s)(II|III|IV|VI|VII|VIII|IX|XI|XII)$/,
        resolve: (m) => ROMAN_SEASON_NUMS2[m[1].toLowerCase()] ?? null
      },
      { re: /\bfinal\s+season\b/i, resolve: () => null }
    ];
    YEAR_PATTERN = /\b(19|20)\d{2}\b/;
    QUERY_PREFIX_RE = /^(?:Ver\s+Online|Ver|Pelicula|Película|Serie|Anime|Ova|Donghua|Watch|Full\s+Movie|Episodios\s+de)\s+/i;
    GENERIC_TITLES = /* @__PURE__ */ new Set([
      "anime",
      "anime online",
      "ver anime",
      "ver anime online",
      "contenido",
      "catalogo",
      "cat\xE1logo",
      "directorio",
      "pagina",
      "p\xE1gina",
      "movies",
      "series",
      "inicio",
      "home",
      "lista",
      "list",
      "animes",
      "pelicula",
      "pel\xEDculas",
      "movie",
      "tv",
      "show",
      "watch",
      "online"
    ]);
    GENRE_ES_ALIASES = {
      "action": "Acci\xF3n",
      // TMDB TV agrupa estos géneros como una sola etiqueta; conservar la
      // etiqueta compuesta evita que el multiplexor los trate como categorías
      // distintas al fusionar obras entre proveedores.
      "action adventure": "Acci\xF3n y Aventura",
      "action y aventura": "Acci\xF3n y Aventura",
      "adventure": "Aventura",
      "animation": "Animaci\xF3n",
      "anime": "Anime",
      "comedy": "Comedia",
      "drama": "Drama",
      "crime": "Crimen",
      "documentary": "Documental",
      "family": "Familia",
      "kids": "Infantil",
      "children": "Infantil",
      "mystery": "Misterio",
      "news": "Noticias",
      "reality": "Reality",
      "sci fi fantasy": "Ciencia Ficci\xF3n y Fantas\xEDa",
      "science fiction": "Ciencia Ficci\xF3n",
      "science fiction fantasy": "Ciencia Ficci\xF3n y Fantas\xEDa",
      "soap": "Telenovela",
      "soap opera": "Telenovela",
      "talk": "Talk Show",
      "talk show": "Talk Show",
      "war politics": "Guerra y Pol\xEDtica",
      "war": "B\xE9lico",
      "western": "Western",
      "fantasy": "Fantas\xEDa",
      "horror": "Terror",
      "thriller": "Suspenso",
      "suspense": "Suspenso",
      "romance": "Romance",
      "slice of life": "Vida Cotidiana",
      "supernatural": "Sobrenatural",
      "psychological": "Psicol\xF3gico",
      "sports": "Deportes",
      "sport": "Deportes",
      "music": "M\xFAsica",
      "musical": "Musical",
      "mecha": "Mecha",
      "ecchi": "Ecchi",
      "mahou shoujo": "Mahou Shoujo",
      "award winning": "Galardonado",
      "hentai": "Hentai",
      "erotica": "Er\xF3tica",
      "boys love": "Boys Love",
      "girls love": "Girls Love",
      "gourmet": "Gourmet",
      "avant garde": "Vanguardia",
      "history": "Historia",
      "espionage": "Espionaje",
      "travel": "Viajes",
      "legal": "Legal",
      "medical": "M\xE9dico",
      "food": "Cocina",
      "cooking": "Cocina",
      "short": "Cortometraje",
      "teens": "Adolescentes"
    };
    TMDB_GENRE_TTL_MS = 24 * 60 * 60 * 1e3;
    tmdbGenreCache = /* @__PURE__ */ new Map();
  }
});

// server/scrapers/adapters/DirectStreamAdapter.ts
var DirectStreamAdapter;
var init_DirectStreamAdapter = __esm({
  "server/scrapers/adapters/DirectStreamAdapter.ts"() {
    "use strict";
    init_BaseAdapter();
    init_metadataEngine();
    DirectStreamAdapter = class extends BaseScraperAdapter {
      id = "direct_stream";
      name = "Direct Video / HLS Stream";
      supportedDomains = ["* (Direct .m3u8, .mp4, .webm, .mkv)"];
      canHandle(url) {
        const lower = url.trim().toLowerCase();
        return lower.endsWith(".m3u8") || lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mkv") || lower.includes(".m3u8?") || lower.includes(".mp4?") || lower.includes("mux.dev/") || lower.includes("commondatastorage.googleapis.com/");
      }
      async analyze(input) {
        const streamUrl = input.trim();
        let title = "Stream de Video";
        try {
          const urlObj = new URL(streamUrl);
          const filename = urlObj.pathname.split("/").pop() || "";
          if (filename) {
            title = filename.replace(/\.(m3u8|mp4|webm|mkv)$/i, "").replace(/[-_]/g, " ");
          }
        } catch {
        }
        return {
          page_type: "direct_stream",
          content_type: "movie",
          title: cleanQueryTitle(title) || "Stream Multimedia",
          description: "Fuente de video directa indexada con compatibilidad HLS / MP4 nativa.",
          poster_url: null,
          banner_url: null,
          rating: 8.5,
          year: 0,
          status: "Directo",
          genres: ["Stream HLS", "Video HD"],
          detected_streams: [streamUrl],
          episodes: [
            {
              number: 1,
              title: "Reproducci\xF3n Principal",
              url: streamUrl
            }
          ],
          catalog_items: []
        };
      }
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        return {
          stream_url: cleanUrl2,
          all_available_streams: [cleanUrl2]
        };
      }
    };
  }
});

// server/scrapers/adapters/ArchiveOrgAdapter.ts
function extractYearFromText(text) {
  if (!text) return null;
  const flat = Array.isArray(text) ? text.join(" ") : text;
  const matches = flat.match(/\b(19\d{2}|20[0-2]\d)\b/g);
  if (!matches) return null;
  const maxValid = (/* @__PURE__ */ new Date()).getFullYear() + 1;
  for (const m of matches) {
    const year = parseInt(m, 10);
    if (year >= 1900 && year <= maxValid) return year;
  }
  return null;
}
function buildCorsUrl(identifier, name) {
  const encoded = name.split("/").map(encodeURIComponent).join("/");
  return `${CORS_BASE}/${identifier}/${encoded}`;
}
function extPriority(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp4")) return 0;
  if (lower.endsWith(".m3u8")) return 1;
  if (lower.endsWith(".webm")) return 2;
  if (lower.endsWith(".mkv")) return 3;
  return 4;
}
function formatScore(format) {
  const f = (format || "").toLowerCase();
  if (f.includes("h.264") || f.includes("h264") || f.includes("avc")) return 0;
  if (f.includes("mpeg4") || f.includes("512kb") || f.includes("512 kb")) return 1;
  if (f.includes("webm")) return 2;
  if (f.includes("matroska") || f.includes("mkv")) return 3;
  if (f.includes("mpeg") || f.includes("mp4")) return 1;
  return 4;
}
function sourcePriority(source) {
  const s = (source || "").toLowerCase();
  if (s === "derivative") return 0;
  if (s === "original") return 1;
  return 2;
}
var CORS_BASE, ArchiveOrgAdapter;
var init_ArchiveOrgAdapter = __esm({
  "server/scrapers/adapters/ArchiveOrgAdapter.ts"() {
    "use strict";
    init_BaseAdapter();
    init_metadataEngine();
    CORS_BASE = "https://cors.archive.org/cors";
    ArchiveOrgAdapter = class extends BaseScraperAdapter {
      id = "archive_org";
      name = "Internet Archive (Archive.org)";
      supportedDomains = ["archive.org"];
      canHandle(url) {
        return url.toLowerCase().includes("archive.org/details/");
      }
      /**
       * Defecto #23: valida por HEAD que una URL inventada realmente exista antes de
       * guardarla como fuente. Los ítems oscurecidos/borrados devuelven 403/404.
       */
      async headExists(url) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6e3);
          const res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal: controller.signal,
            headers: COMMON_HEADERS
          });
          clearTimeout(timer);
          return res.ok || res.status === 206;
        } catch {
          return false;
        }
      }
      async analyze(input) {
        const archiveUrl = input.trim();
        const match = archiveUrl.match(/archive\.org\/details\/([^/?#]+)/);
        const identifier = match ? match[1] : "";
        let title = identifier.replace(/[-_]/g, " ");
        let desc = "Pel\xEDcula o archivo de libre distribuci\xF3n en Internet Archive.";
        let itemYear = null;
        const poster = identifier ? `https://archive.org/services/img/${identifier}` : null;
        const detectedStreams = [];
        if (identifier) {
          try {
            const metaRes = await fetch(`https://archive.org/metadata/${identifier}`, { headers: COMMON_HEADERS });
            if (metaRes.ok) {
              const metaData = await metaRes.json();
              if (metaData.metadata) {
                title = metaData.metadata.title || title;
                desc = typeof metaData.metadata.description === "string" ? metaData.metadata.description : Array.isArray(metaData.metadata.description) ? metaData.metadata.description.join(" ") : desc;
                const rawYear = metaData.metadata.year ?? metaData.metadata.date;
                if (Array.isArray(rawYear)) {
                  itemYear = extractYearFromText(rawYear.join(" "));
                } else if (typeof rawYear === "string" && /^\d{4}/.test(rawYear.trim())) {
                  itemYear = parseInt(rawYear.trim().slice(0, 4), 10);
                } else if (typeof rawYear === "number") {
                  itemYear = rawYear;
                }
              }
              if (Array.isArray(metaData.files)) {
                const candidates = metaData.files.filter((f) => {
                  const name = String(f.name || "").trim();
                  if (!name) return false;
                  return /\.(mp4|m3u8|webm|mkv)(\?|#|$)/i.test(name);
                });
                candidates.sort((a, b) => {
                  const aName = String(a.name || "");
                  const bName = String(b.name || "");
                  const aExt = extPriority(aName);
                  const bExt = extPriority(bName);
                  if (aExt !== bExt) return aExt - bExt;
                  const aFmt = formatScore(a.format);
                  const bFmt = formatScore(b.format);
                  if (aFmt !== bFmt) return aFmt - bFmt;
                  const aSrc = sourcePriority(a.source);
                  const bSrc = sourcePriority(b.source);
                  if (aSrc !== bSrc) return aSrc - bSrc;
                  const aH = parseInt(String(a.height || ""), 10);
                  const bH = parseInt(String(b.height || ""), 10);
                  const aHasH = !isNaN(aH);
                  const bHasH = !isNaN(bH);
                  if (aHasH && bHasH && aH !== bH) return aH - bH;
                  const aSize = Number(a.size);
                  const bSize = Number(b.size);
                  const aHasSize = !isNaN(aSize) && aSize > 0;
                  const bHasSize = !isNaN(bSize) && bSize > 0;
                  if (aHasSize && bHasSize && aSize !== bSize) return aSize - bSize;
                  return aName.localeCompare(bName);
                });
                candidates.forEach((f) => {
                  const name = String(f.name || "").trim();
                  detectedStreams.push(buildCorsUrl(identifier, name));
                });
              }
            }
          } catch {
          }
        }
        if (!itemYear) itemYear = extractYearFromText(desc) || extractYearFromText(title);
        if (detectedStreams.length === 0 && identifier) {
          const guessedCors = `${CORS_BASE}/${identifier}/${encodeURIComponent(identifier)}.mp4`;
          if (await this.headExists(guessedCors)) {
            detectedStreams.push(guessedCors);
          }
        }
        return {
          page_type: "detail",
          content_type: "open_archive",
          title: cleanQueryTitle(title),
          description: desc,
          poster_url: poster,
          banner_url: poster,
          // Defecto #24: sin rating real en el API -> 0 para que el enriquecimiento
          // complete el hueco (antes: 8.2 fijo).
          rating: 0,
          // Año real del ítem; 0 (desconocido) si nada lo declara — nunca 1968 fijo.
          year: itemYear || 0,
          status: "Dominio P\xFAblico",
          genres: ["Cine Cl\xE1sico", "Dominio P\xFAblico", "Pel\xEDcula"],
          detected_streams: detectedStreams,
          episodes: [
            {
              number: 1,
              title: "Pel\xEDcula Completa",
              url: detectedStreams[0] || archiveUrl
            }
          ],
          catalog_items: []
        };
      }
      async extractStream(targetUrl) {
        const res = await this.analyze(targetUrl);
        const streams = res.detected_streams || [];
        return {
          stream_url: streams[0] || targetUrl,
          all_available_streams: streams.length > 0 ? streams : [targetUrl],
          title: res.title
        };
      }
    };
  }
});

// server/scrapers/adapters/TvMazeAdapter.ts
function toGlobalEpisodeNumber(season, number) {
  return season * 100 + number;
}
var cheerio3, TvMazeAdapter;
var init_TvMazeAdapter = __esm({
  "server/scrapers/adapters/TvMazeAdapter.ts"() {
    "use strict";
    cheerio3 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_metadataEngine();
    TvMazeAdapter = class extends BaseScraperAdapter {
      id = "tvmaze";
      name = "TVMaze International Shows";
      supportedDomains = ["tvmaze.com"];
      canHandle(url) {
        return url.toLowerCase().includes("tvmaze.com");
      }
      async analyze(input, explicitType) {
        const cleanUrl2 = input.trim();
        const urlObj = new URL(cleanUrl2);
        const showMatch = urlObj.pathname.match(/\/shows\/(\d+)/);
        if (showMatch) {
          const showId = showMatch[1];
          try {
            const apiRes = await fetch(`https://api.tvmaze.com/shows/${showId}?embed=episodes`, { headers: COMMON_HEADERS });
            if (apiRes.ok) {
              const data = await apiRes.json();
              const episodes = Array.isArray(data._embedded?.episodes) ? data._embedded.episodes.map((ep) => {
                const season = Number(ep.season) || 1;
                const number = Number(ep.number) || 1;
                return {
                  number: toGlobalEpisodeNumber(season, number),
                  title: ep.name ? `T${season}E${number}: ${ep.name}` : `Episodio ${number}`,
                  url: ep.url || cleanUrl2
                };
              }) : [];
              const title = cleanQueryTitle(data.name || "Serie TV");
              const desc = (data.summary || "").replace(/<[^>]+>/g, "").trim() || "Serie internacional indexada desde TVMaze.";
              const poster = data.image?.original || data.image?.medium || null;
              const rating = data.rating?.average ? Number(data.rating.average) : 8.5;
              const year = data.premiered ? parseInt(data.premiered.substring(0, 4), 10) : 0;
              const genres = Array.isArray(data.genres) && data.genres.length > 0 ? data.genres : ["Drama", "Serie"];
              return {
                page_type: "detail",
                content_type: "series",
                title,
                original_title: data.name,
                english_title: data.name,
                description: desc,
                poster_url: poster,
                banner_url: poster,
                rating,
                year,
                status: data.status || "Finalizado",
                genres,
                source_domain: "tvmaze.com",
                detected_streams: [],
                episodes: episodes.length > 0 ? episodes : [{ number: 1, title: "Episodio 1", url: cleanUrl2 }],
                catalog_items: []
              };
            }
          } catch {
          }
        }
        const html = await this.fetchHtml(cleanUrl2);
        if (!html) {
          const enriched = await enrichUniversalMetadata("TV Show", "series");
          return {
            page_type: "detail",
            content_type: "series",
            title: "TV Show",
            description: enriched.description || "",
            poster_url: enriched.poster_url || null,
            banner_url: enriched.banner_url || null,
            rating: enriched.rating || 8,
            year: enriched.year || 0,
            status: "Finalizado",
            genres: ["Series"],
            episodes: [{ number: 1, title: "Episodio 1", url: cleanUrl2 }],
            catalog_items: []
          };
        }
        const $ = cheerio3.load(html);
        const catalogItems = [];
        $("a[href*='/shows/']").each((_, el) => {
          const href = $(el).attr("href");
          const title = $(el).text().trim();
          const img = $(el).find("img").attr("src");
          if (href && title && title.length > 2 && !catalogItems.some((i) => i.url.includes(href))) {
            catalogItems.push({
              title: cleanQueryTitle(title),
              url: href.startsWith("http") ? href : `https://www.tvmaze.com${href}`,
              image_url: img || null,
              kind: "series"
            });
          }
        });
        if (catalogItems.length > 0) {
          await this.fillCatalogImages(catalogItems);
        }
        const isCatalog = explicitType === "catalog" || catalogItems.length >= 3;
        return {
          page_type: isCatalog ? "catalog" : "detail",
          content_type: "series",
          title: $("h1").first().text().trim() || "TVMaze Directory",
          description: $("article p").first().text().trim() || "Directorio de series internacionales TVMaze.",
          poster_url: catalogItems[0]?.image_url || null,
          banner_url: catalogItems[0]?.image_url || null,
          rating: 8.5,
          year: 0,
          status: "Activo",
          genres: ["Series", "TV"],
          source_domain: "tvmaze.com",
          detected_streams: [],
          episodes: [],
          catalog_items: catalogItems
        };
      }
      /**
       * Completa image_url (y año) de los ítems del catálogo consultando la API
       * pública /shows/{id} en paralelo con acotación. Falla silenciosamente:
       * es un enriquecimiento, no un requisito.
       */
      async fillCatalogImages(catalogItems) {
        const targets = catalogItems.filter((i) => !i.image_url).slice(0, 25);
        if (targets.length === 0) return;
        await Promise.allSettled(
          targets.map(async (item) => {
            const idMatch = item.url.match(/\/shows\/(\d+)/);
            if (!idMatch) return;
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5e3);
              const res = await fetch(`https://api.tvmaze.com/shows/${idMatch[1]}`, {
                headers: COMMON_HEADERS,
                signal: controller.signal
              });
              clearTimeout(timer);
              if (!res.ok) return;
              const data = await res.json();
              item.image_url = data.image?.medium || data.image?.original || null;
              if (!item.year && data.premiered) {
                item.year = parseInt(String(data.premiered).slice(0, 4), 10) || null;
              }
            } catch {
            }
          })
        );
      }
    };
  }
});

// server/pageClassifier.ts
var PageClassifier;
var init_pageClassifier = __esm({
  "server/pageClassifier.ts"() {
    "use strict";
    PageClassifier = class _PageClassifier {
      /**
       * Clasifica semánticamente una página evaluando señales de DOM y URL por puntuación (scoring)
       */
      static classify(url, $) {
        const scores = { collection: 0, detail: 0, episode: 0 };
        const urlLower = url.toLowerCase();
        let pathname = "";
        try {
          pathname = new URL(url).pathname.toLowerCase();
        } catch {
          pathname = urlLower;
        }
        const isPaginationOrCatalogPath = ["/browse", "/animes", "/catalog", "/category", "/genre", "/search", "/simulcasts", "/directory"].some((p) => pathname.includes(p)) || ["?page=", "?p=", "/page/"].some((p) => urlLower.includes(p));
        _PageClassifier.evaluateUrlSignals(pathname, isPaginationOrCatalogPath, scores);
        _PageClassifier.evaluateCollectionSignals($, scores);
        _PageClassifier.evaluateDetailSignals($, isPaginationOrCatalogPath, scores);
        _PageClassifier.evaluateEpisodeSignals($, scores);
        let winner = "detail";
        let maxScore = -1;
        Object.keys(scores).forEach((key) => {
          if (scores[key] > maxScore) {
            maxScore = scores[key];
            winner = key;
          }
        });
        return maxScore >= 2 ? winner : "detail";
      }
      static evaluateUrlSignals(pathname, isPaginationOrCatalogPath, scores) {
        if (isPaginationOrCatalogPath) {
          scores.collection += 4;
        }
        if (["/anime/", "/series/", "/movie/", "/title/", "/show/"].some((p) => pathname.includes(p)) && !isPaginationOrCatalogPath && !/(episodio|episode|watch|capitulo)/i.test(pathname)) {
          scores.detail += 2;
        }
        if (/(episodio|episode|watch|video|play|\bep-\d+)/i.test(pathname)) {
          scores.episode += 3;
        }
      }
      static evaluateCollectionSignals($, scores) {
        const cards = $("article, .item, .card, .film, .anime-card, li.anime, .post, .hentry, .ht_grid_1_4, .type-post, .browse-item");
        const images = $("img");
        const links = $("a[href]");
        if (cards.length >= 4) scores.collection += 4;
        if (images.length >= 10 && links.length >= 15) scores.collection += 2;
        if ($("ul.pagination, .nav-links, a[rel='next'], a.next, .pagination, .page-numbers").length > 0) {
          scores.collection += 3;
        }
      }
      static evaluateDetailSignals($, isPaginationOrCatalogPath, scores) {
        const h1Text = $("h1").text().trim();
        if (h1Text.length > 2 && !isPaginationOrCatalogPath) {
          scores.detail += 2;
        }
        const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
        if (ogDesc.length > 60 && !isPaginationOrCatalogPath) {
          scores.detail += 2;
        }
        let episodeLinkCount = 0;
        $("a[href]").each((_, el) => {
          const href = $(el).attr("href") || "";
          if (/(episodio|episode|capitulo)/i.test(href)) episodeLinkCount++;
        });
        if (episodeLinkCount >= 2 || $(".episodes, .episode-list, #episodes, .animeflv-episodes-data").length > 0) {
          scores.detail += 4;
        }
        $('script[type="application/ld+json"]').each((_, el) => {
          const text = $(el).html() || "";
          if (text.includes("TVSeries") || text.includes("Movie")) scores.detail += 3;
          if (text.includes("TVEpisode") || text.includes("VideoObject")) scores.episode += 3;
        });
      }
      static evaluateEpisodeSignals($, scores) {
        if ($("iframe, video, .player, #player, .video-player").length > 0) {
          scores.episode += 3;
        }
      }
    };
  }
});

// server/scrapers/adapters/AnimeFlvAdapter.ts
var cheerio4, KNOWN_EMBED_HOSTS, DOWNLOAD_ONLY_HOSTS, DEAD_OR_BLOCKED_HOST_PATTERNS, isKnownEmbedHost, isDownloadOnly, isDeadOrBlocked, AnimeFlvAdapter;
var init_AnimeFlvAdapter = __esm({
  "server/scrapers/adapters/AnimeFlvAdapter.ts"() {
    "use strict";
    cheerio4 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_metadataEngine();
    init_pageClassifier();
    init_validator();
    init_resolvers();
    KNOWN_EMBED_HOSTS = [
      "zilla-networks.com",
      "voe.",
      "byselapuix.com",
      "mp4upload.com",
      "mega.nz",
      "vidmoly.",
      "luluvdo.",
      "streamhide.",
      "ok.ru",
      "vimeo.com",
      "dood.",
      "doodstream.",
      "fembed.",
      "mixdrop.",
      "uqload.",
      "upstream.",
      "embedsito.",
      "streamlare.",
      "fastre.",
      "gamovideo.",
      "netu.",
      "waaw.",
      "streamdav.",
      "streamhub.",
      "streamwish.",
      "filemoon.",
      // Espejos reales detectados hoy
      "sfastwish.com",
      "vidhidevip.com",
      "mdbekjwqa.pw",
      "hlswish.com",
      "goodstream.one",
      "playmudos.com"
    ];
    DOWNLOAD_ONLY_HOSTS = ["mediafire.com", "drive.google.com", "4shared.com", "zippyshare.com"];
    DEAD_OR_BLOCKED_HOST_PATTERNS = [
      /cfglobalcdn\.com/i,
      /yourupload\.com/i,
      /streamtape\./i,
      /dsvplay\.com/i,
      /savefiles\.com/i,
      /d-s\.io/i,
      /a\d+\.mp4upload\.com/i,
      /vidcache\.net/i,
      /my\.mail\.ru/i,
      /v\.tioanime\.com/i
    ];
    isKnownEmbedHost = (url) => KNOWN_EMBED_HOSTS.some((h) => url.toLowerCase().includes(h));
    isDownloadOnly = (url) => DOWNLOAD_ONLY_HOSTS.some((h) => url.toLowerCase().includes(h));
    isDeadOrBlocked = (url) => DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));
    AnimeFlvAdapter = class _AnimeFlvAdapter extends BaseScraperAdapter {
      id = "animeflv";
      name = "AnimeFLV / Anime Streaming";
      supportedDomains = ["animeflv.net", "animeflv.or.at", "animeflv.or.am", "animeflv.me", "animeflv.ac", "animeflv.to", "jkanime.net"];
      /** Tope de páginas del AJAX de episodios de jkanime; se detiene antes en last_page. */
      static JK_PAGES = 1e3;
      canHandle(url) {
        const lower = url.toLowerCase();
        return lower.includes("animeflv.") || lower.includes("jkanime.");
      }
      async analyze(input, explicitType) {
        const urlOrQuery = input.trim();
        let urlObj;
        try {
          urlObj = new URL(urlOrQuery);
        } catch {
          const query = cleanQueryTitle(urlOrQuery);
          const searchUrls = await this.searchJkanime(query);
          if (searchUrls.length > 0) {
            return {
              page_type: "catalog",
              content_type: "anime",
              title: `Resultados para "${query}" - AnimeFLV`,
              description: `Candidatos encontrados para "${query}"`,
              poster_url: null,
              banner_url: null,
              rating: 0,
              year: 0,
              status: "Publicado",
              genres: ["Anime"],
              source_domain: "jkanime.net",
              episodes: [],
              catalog_items: searchUrls.map((url) => ({ title: query, url, kind: "anime" }))
            };
          }
          return this.fallbackSearch(urlOrQuery);
        }
        const domain = urlObj.hostname.toLowerCase();
        const isJkanime = domain.includes("jkanime");
        const html = await this.fetchHtml(urlOrQuery, isJkanime ? 12e3 : 7500);
        if (!html) {
          if (explicitType === "catalog") throw new Error(`FETCH_FAILED: ${urlOrQuery}`);
          return this.fallbackSearch(urlOrQuery);
        }
        const $ = cheerio4.load(html);
        const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
        const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
        const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
        const detectedStreams = this.extractAnimeflvStreams($, html, urlOrQuery);
        const extractedEpisodes = isJkanime ? await this.extractJkanimeEpisodes(html, urlObj) : this.extractAnimeflvEpisodes($, html, urlObj);
        const catalogItems = [];
        const seenUrls = /* @__PURE__ */ new Set();
        const cardSelectors = [
          "ul.ListAnimes > li",
          "ul.ListAnimes li",
          "article.anime",
          "article",
          ".anime-card",
          ".item",
          ".film",
          ".card",
          "li.anime",
          "ul.animes > li",
          ".list-animes > li",
          ".ht_grid_1_4",
          ".post",
          ".hentry",
          ".type-post",
          ".List-Episodes > div",
          ".listCats > div",
          ".browse-item"
        ];
        let cards = $([]);
        for (const selector of cardSelectors) {
          const found = $(selector);
          if (found.length >= 3) {
            cards = found;
            break;
          }
        }
        if (cards.length === 0) {
          for (const selector of cardSelectors) {
            const found = $(selector);
            if (found.length > 0) {
              cards = found;
              break;
            }
          }
        }
        cards.each((_, card) => {
          const item = this.extractAnimeflvCard($, card, urlObj.origin);
          if (item && !seenUrls.has(item.url)) {
            seenUrls.add(item.url);
            catalogItems.push(item);
          }
        });
        const classifiedType = PageClassifier.classify(urlOrQuery, $);
        const isCatalog = explicitType === "catalog" || explicitType !== "detail" && (classifiedType === "collection" || catalogItems.length >= 3 && extractedEpisodes.length === 0 || urlOrQuery.includes("/page/") || urlOrQuery.includes("?page="));
        const pageType = isCatalog ? "catalog" : "detail";
        const validatedStreams = await MediaValidator.validateUrls(detectedStreams);
        const finalStreams = validatedStreams.length > 0 ? validatedStreams : detectedStreams;
        if (isCatalog) {
          const catalogPoster = this.resolveRelativeUrl(ogImage, urlOrQuery) || (catalogItems[0]?.image_url || null);
          return {
            page_type: "catalog",
            content_type: "anime",
            title: ogTitle || `Cat\xE1logo Anime (${domain})`,
            description: ogDesc || `Directorio de ${catalogItems.length} animes en ${domain}.`,
            poster_url: catalogPoster,
            banner_url: catalogPoster,
            rating: 8.8,
            year: 0,
            status: "Cat\xE1logo",
            genres: ["Anime", "Cat\xE1logo"],
            source_domain: domain,
            detected_streams: [],
            episodes: [],
            catalog_items: catalogItems,
            raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: [] }
          };
        }
        const rawCleanTitle = cleanQueryTitle($("h1.Title, h1.entry-title, h1").first().text().trim() || ogTitle || urlObj.pathname.split("/").filter(Boolean).pop() || "Anime");
        const enriched = await enrichUniversalMetadata(rawCleanTitle, "anime");
        const wpTitle = $("h1.anime-title").first().text().trim() || void 0;
        const wpPosterRaw = $("img.poster-image").attr("src") || $("img.poster-image").attr("data-src") || void 0;
        const wpPoster = wpPosterRaw ? wpPosterRaw.startsWith("//") ? `https:${wpPosterRaw}` : wpPosterRaw.startsWith("http") ? wpPosterRaw : new URL(wpPosterRaw, urlOrQuery).toString() : void 0;
        const wpSynopsis = $(".anime-synopsis p").first().text().trim() || void 0;
        const wpGenres = [];
        $("span.genre-tag").each((_, el) => {
          const g = $(el).text().trim();
          if (g) wpGenres.push(g);
        });
        const wpRatingRaw = $(".anime-rating .rating-score").first().text().trim();
        const wpRating = parseFloat(wpRatingRaw) || void 0;
        let finalEpisodes = extractedEpisodes;
        if (finalEpisodes.length === 0) {
          if (detectedStreams.length > 0) {
            finalEpisodes = detectedStreams.map((st, idx) => ({
              number: idx + 1,
              title: `Episodio ${idx + 1}`,
              url: st
            }));
          } else {
            finalEpisodes = [{ number: 1, title: "Episodio 1", url: urlOrQuery }];
          }
        }
        return {
          page_type: pageType,
          content_type: "anime",
          title: wpTitle || enriched.title || rawCleanTitle,
          original_title: enriched.original_title,
          japanese_title: enriched.japanese_title,
          english_title: enriched.english_title,
          tmdb_id: enriched.tmdb_id,
          description: wpSynopsis || enriched.description || ogDesc || "Serie de anime indexada desde AnimeFLV.",
          poster_url: wpPoster || enriched.poster_url || this.resolveRelativeUrl(ogImage, urlOrQuery),
          banner_url: enriched.banner_url || wpPoster || this.resolveRelativeUrl(ogImage, urlOrQuery),
          rating: wpRating || enriched.rating || 8.5,
          year: enriched.year || 0,
          status: enriched.status || "En emisi\xF3n",
          genres: wpGenres.length > 0 ? wpGenres : enriched.genres.length > 0 ? enriched.genres : ["Anime", "Animaci\xF3n"],
          source_domain: domain,
          detected_streams: finalStreams,
          episodes: finalEpisodes,
          catalog_items: catalogItems,
          raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: finalStreams }
        };
      }
      async extractStream(url) {
        const cleanUrl2 = url.trim();
        if (cleanUrl2.toLowerCase().includes("jkanime.")) {
          return this.extractJkanimeStream(cleanUrl2);
        }
        const html = await this.fetchHtml(cleanUrl2);
        if (!html) {
          const mirrored = await this.extractViaJkanimeMirror(cleanUrl2);
          if (mirrored) return mirrored;
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        const $ = cheerio4.load(html);
        const rawStreams = this.extractAnimeflvStreams($, html, cleanUrl2);
        if (rawStreams.length === 0) {
          const mirrored = await this.extractViaJkanimeMirror(cleanUrl2);
          if (mirrored) return mirrored;
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        const { directStreams, embedStreams } = await this.resolveCandidates(rawStreams);
        const finalStreams = Array.from(/* @__PURE__ */ new Set([...directStreams, ...embedStreams]));
        return {
          stream_url: finalStreams[0] || cleanUrl2,
          all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl2]
        };
      }
      /**
       * Clasifica candidatos: embeds conocidos pasan tal cual (regla de oro), los demás
       * se resuelven en paralelo (acotado) buscando upgrades a .m3u8/.mp4 directo.
       * Excepción mp4upload: el embed se conserva como fallback pero su página expone
       * el .mp4 directo en JS plano (player.src), así que también se intenta resolver.
       * IMPORTANTE: el chequeo de host conocido va ANTES del de medio directo porque
       * algunos embeds usan extensiones falsas en el path (streamtape /e/{id}/x.mp4 es
       * una página HTML, no un archivo); clasificarlos como directos pone una página
       * muerta como stream principal (MEDIA_ERR_SRC_NOT_SUPPORTED).
       */
      async resolveCandidates(rawStreams) {
        const directStreams = [];
        const embedStreams = [];
        const needResolve = [];
        const mp4UploadTargets = [];
        for (const st of rawStreams) {
          const normalized = this.normalizeServerUrl(st);
          if (!normalized.startsWith("http")) continue;
          if (isDownloadOnly(normalized) || isDeadOrBlocked(normalized)) continue;
          if (normalized.toLowerCase().includes("mp4upload.com")) {
            const target = this.toMp4UploadEmbedUrl(normalized);
            if (!mp4UploadTargets.includes(target)) mp4UploadTargets.push(target);
            if (!embedStreams.includes(normalized)) embedStreams.push(normalized);
          } else if (isKnownEmbedHost(normalized)) {
            if (!embedStreams.includes(normalized)) embedStreams.push(normalized);
          } else if (EmbedResolvers.isDirectMediaUrl(normalized)) {
            if (!directStreams.includes(normalized)) directStreams.push(normalized);
          } else if (!needResolve.includes(normalized)) {
            needResolve.push(normalized);
          }
        }
        const targets = needResolve.slice(0, 6);
        const results = await Promise.allSettled([
          ...targets.map((t) => EmbedResolvers.resolveWithMeta(t)),
          ...mp4UploadTargets.map((t) => EmbedResolvers.resolveWithMeta(t))
        ]);
        results.forEach((r) => {
          if (r.status !== "fulfilled") return;
          const meta = r.value;
          if (!meta.url || isDeadOrBlocked(meta.url)) return;
          if (meta.resolved && meta.type === "direct") {
            if (!directStreams.includes(meta.url)) directStreams.push(meta.url);
          } else if (meta.url && !embedStreams.includes(meta.url)) {
            embedStreams.push(meta.url);
          }
        });
        for (const extra of needResolve.slice(6)) {
          if (!embedStreams.includes(extra)) embedStreams.push(extra);
        }
        return { directStreams, embedStreams };
      }
      /**
       * mp4upload: la página con el .mp4 directo es /embed-{code}.html; la variante
       * plana /{code} solo sirve el HTML de descarga (sin player).
       */
      toMp4UploadEmbedUrl(url) {
        const m = url.match(/mp4upload\.com\/(?:embed-)?([a-z0-9]+)(?:\.html?)?$/i);
        if (!m) return url;
        return `https://www.mp4upload.com/embed-${m[1]}.html`;
      }
      normalizeServerUrl(raw) {
        let u = (raw || "").trim().replace(/\\/g, "");
        if (u.includes("mega.nz/#!")) {
          u = u.replace("mega.nz/#!", "mega.nz/embed/#!");
        } else if (u.includes("mega.nz/file/")) {
          u = u.replace("mega.nz/file/", "mega.nz/embed/");
        } else if (u.includes("yourupload.com/watch/")) {
          u = u.replace("yourupload.com/watch/", "yourupload.com/embed/");
        } else if (u.includes("streamtape.com/v/")) {
          u = u.replace("streamtape.com/v/", "streamtape.com/e/");
        }
        return u;
      }
      /* ===================== jkanime ===================== */
      /**
       * Episodios de jkanime: el listado completo llega por AJAX paginado
       * (POST /ajax/episodes/{animeId}/{page} con _token CSRF + cookie de sesión).
       * El HTML crudo solo incluye el último episodio publicado.
       */
      async extractJkanimeEpisodes(html, urlObj) {
        try {
          const idMatch = html.match(/ajax\/episodes\/(\d+)\//);
          if (!idMatch) return [];
          const { html: freshHtml, cookie } = await this.fetchWithCookies(urlObj.toString());
          const source = freshHtml ?? html;
          const token = source.match(/name="csrf-token" content="([^"]+)"/)?.[1] || "";
          const animeId = source.match(/ajax\/episodes\/(\d+)\//)?.[1] || idMatch[1];
          if (!token) return [];
          const parts = urlObj.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
          const slug = parts[parts.length - 1] || "anime";
          const origin = urlObj.origin;
          const episodes = [];
          const seen = /* @__PURE__ */ new Set();
          for (let page = 1; page <= _AnimeFlvAdapter.JK_PAGES; page++) {
            const data = await this.jkanimeEpisodesPage(origin, animeId, page, token, cookie);
            if (!data || !Array.isArray(data.data)) break;
            for (const ep of data.data) {
              const num = Number(ep?.number);
              if (!Number.isFinite(num) || num <= 0 || seen.has(num)) continue;
              seen.add(num);
              const title = typeof ep?.title === "string" && ep.title.trim() ? ep.title.trim() : `Episodio ${num}`;
              episodes.push({
                number: num,
                title,
                url: `${origin}/${encodeURIComponent(slug)}/${num}/`
              });
            }
            const lastPage = Number(data.last_page);
            if (Number.isFinite(lastPage) && page >= lastPage) break;
          }
          return episodes.sort((a, b) => a.number - b.number);
        } catch {
          return [];
        }
      }
      /** GET que captura Set-Cookie junto al HTML (necesario para el CSRF de Laravel). */
      async fetchWithCookies(url, timeoutMs = 9e3) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal, headers: COMMON_HEADERS });
          clearTimeout(timer);
          const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
          const cookie = raw.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
          if (!res.ok) return { html: null, cookie };
          return { html: await res.text(), cookie };
        } catch {
          clearTimeout(timer);
          return { html: null, cookie: "" };
        }
      }
      async jkanimeEpisodesPage(origin, animeId, page, token, cookie) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 9e3);
          const res = await fetch(`${origin}/ajax/episodes/${animeId}/${page}`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              ...COMMON_HEADERS,
              "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              Referer: `${origin}/`,
              ...cookie ? { Cookie: cookie } : {}
            },
            body: new URLSearchParams({ _token: token }).toString()
          });
          clearTimeout(timer);
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      }
      /**
       * Streams de una página de episodio jkanime:
       * 1. `var servers = [{remote: <base64>, server: "..."}]` (mega/voe/mp4upload/streamtape/...)
       * 2. Iframes reales y cadenas JS tipo video[0] = '<iframe src="...jkplayer/um?..."'
       * Cada wrapper jkplayer resuelve internamente a un .m3u8 directo.
       */
      async extractJkanimeStream(url) {
        const html = await this.fetchHtml(url, 12e3);
        if (!html) return { stream_url: url, all_available_streams: [url] };
        const title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/)?.[1];
        const rawStreams = this.parseJkanimeServers(html);
        if (rawStreams.length === 0) {
          return { stream_url: url, all_available_streams: [url], title };
        }
        const { directStreams, embedStreams } = await this.resolveCandidates(rawStreams);
        const finalStreams = Array.from(/* @__PURE__ */ new Set([...directStreams, ...embedStreams]));
        return {
          stream_url: finalStreams[0] || url,
          all_available_streams: finalStreams.length > 0 ? finalStreams : [url],
          title
        };
      }
      parseJkanimeServers(html) {
        const streams = [];
        const push = (raw) => {
          const clean = this.normalizeServerUrl(raw);
          if (clean.startsWith("http") && !isDownloadOnly(clean) && !streams.includes(clean)) {
            streams.push(clean);
          }
        };
        const serversMatch = html.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);\s*(?:var|<\/script>)/);
        if (serversMatch) {
          try {
            const arr = JSON.parse(serversMatch[1]);
            for (const srv of arr) {
              if (!srv?.remote) continue;
              try {
                const decoded = Buffer.from(String(srv.remote), "base64").toString("utf-8").trim();
                if (/^https?:\/\//i.test(decoded)) push(decoded);
              } catch {
              }
            }
          } catch {
          }
        }
        const $ = cheerio4.load(html);
        $("iframe").each((_, el) => {
          const src = $(el).attr("src") || $(el).attr("data-src");
          if (!src) return;
          if (/jkanime\.net\/jkplayer\/[^"']*?\?(?:[^"']*&)?u=$/i.test(src)) return;
          push(src);
        });
        const jsIframe = /<iframe[^>]+src=["']([^"']+)["']/gi;
        let m;
        while ((m = jsIframe.exec(html)) !== null) {
          if (/jkanime\.net\/jkplayer\/[^"']*?\?(?:[^"']*&)?u=$/i.test(m[1])) continue;
          push(m[1]);
        }
        const jkPlayer = /https?:\/\/jkanime\.net\/jkplayer\/[^\s"'<>\\]+/gi;
        while ((m = jkPlayer.exec(html)) !== null) {
          if (/jkanime\.net\/jkplayer\/[^?]*\?[^#]*&?u=$/i.test(m[0])) continue;
          push(m[0]);
        }
        return streams;
      }
      /**
       * Espejo animeflv -> jkanime: dado `/ver/{slug}-{n}` busca el título en jkanime
       * (/buscar?q=) y extrae los servidores del episodio equivalente `{slug}/{n}/`.
       */
      async extractViaJkanimeMirror(afUrl) {
        try {
          const u = new URL(afUrl);
          const parts = u.pathname.split("/").filter(Boolean);
          const verIdx = parts.findIndex((p) => p.toLowerCase() === "ver");
          const tail = verIdx >= 0 ? parts[verIdx + 1] : void 0;
          if (!tail) return null;
          const numMatch = tail.match(/-(\d+(?:\.\d+)?)$/);
          if (!numMatch) return null;
          const epNum = parseFloat(numMatch[1]);
          const slug = tail.slice(0, tail.length - numMatch[0].length).toLowerCase();
          if (!slug) return null;
          const rawQuery = slug.replace(/-/g, " ");
          const baseQuery = rawQuery.replace(/\b(?:\d+(?:st|nd|rd|th)?|season)\b/gi, " ").replace(/\s+/g, " ").trim();
          const queryVariants = Array.from(new Set([
            rawQuery,
            baseQuery,
            baseQuery.replace(/([a-z])((?:san|kun|chan|sama)\b)/gi, "$1 $2"),
            baseQuery.split(" ").slice(-4).join(" ")
          ].filter((value) => value.length >= 3)));
          const candidates = (await Promise.all(queryVariants.map((query) => this.searchJkanime(query)))).flat().filter((value, index, values) => values.indexOf(value) === index);
          for (const animeUrl of candidates.slice(0, 6)) {
            const epUrl = `${animeUrl.replace(/\/+$/, "")}/${epNum}/`;
            const html = await this.fetchHtml(epUrl, 12e3);
            if (!html) continue;
            const rawStreams = this.parseJkanimeServers(html);
            if (rawStreams.length === 0) continue;
            const { directStreams, embedStreams } = await this.resolveCandidates(rawStreams);
            const finalStreams = Array.from(/* @__PURE__ */ new Set([...directStreams, ...embedStreams]));
            if (finalStreams.length > 0) {
              return { stream_url: finalStreams[0], all_available_streams: finalStreams };
            }
          }
          return null;
        } catch {
          return null;
        }
      }
      /** Búsqueda en jkanime: el formulario actual usa /buscar/<slug>, pero
       * algunos espejos todavía aceptan ?q=. Se prueban ambas rutas. */
      async searchJkanime(query) {
        const normalized = query.trim().replace(/\s+/g, " ");
        if (!normalized) return [];
        const slug = encodeURIComponent(normalized.toLowerCase().replace(/\s+/g, "-"));
        const targets = [
          `https://jkanime.net/buscar/${slug}`,
          `https://jkanime.net/buscar?q=${encodeURIComponent(normalized)}`
        ];
        const results = [];
        for (const target of targets) {
          const html = await this.fetchHtml(target, 1e4);
          if (!html) continue;
          const $ = cheerio4.load(html);
          const navigation = /* @__PURE__ */ new Set([
            "notificaciones",
            "guardado",
            "historial",
            "salir",
            "directorio",
            "horario",
            "comunidad",
            "aplicacion",
            "pedidos",
            "estrenos",
            "top",
            "login",
            "registro"
          ]);
          $(".anime__item a[href], a[href]").each((_, el) => {
            const raw = ($(el).attr("href") || "").trim();
            if (!raw) return;
            let href = raw;
            try {
              href = new URL(raw, "https://jkanime.net").toString();
            } catch {
            }
            if (!/^https?:\/\/jkanime\.net\/[^/]+\/?$/i.test(href)) return;
            const segment = new URL(href).pathname.split("/").filter(Boolean)[0]?.toLowerCase() || "";
            if (!segment || navigation.has(segment) || segment === "#") return;
            const clean = href.replace(/\/+$/, "") + "/";
            if (!results.includes(clean)) results.push(clean);
          });
          if (results.length > 0) break;
        }
        return results;
      }
      /* ===================== animeflv ===================== */
      /**
       * WordPress theme (animeflv.or.at) sirve servidores codificados en base64
       * dentro de botones y contenedores DOM.
       */
      extractWordPressServers($) {
        const servers = [];
        const seen = /* @__PURE__ */ new Set();
        const pushDecoded = (raw) => {
          const trimmed = (raw || "").trim();
          if (!trimmed || seen.has(trimmed)) return;
          seen.add(trimmed);
          try {
            const decoded = Buffer.from(trimmed, "base64").toString("utf-8").trim();
            if (/^https?:\/\//i.test(decoded)) {
              servers.push(decoded);
            }
          } catch {
          }
        };
        $("button.iframe_code[data-src]").each((_, el) => {
          const val = $(el).attr("data-src") || "";
          if (val) pushDecoded(val);
        });
        $("#iframeHolder[data-default-src]").each((_, el) => {
          const val = $(el).attr("data-default-src") || "";
          if (val) pushDecoded(val);
        });
        return servers;
      }
      extractAnimeflvStreams($, html, baseUrl) {
        const streams = [];
        const videoObjectMatch = html.match(/var\s+videos\s*=\s*(\{.+?\});/s) || html.match(/videos\s*=\s*(\{.+?\});/s);
        if (videoObjectMatch) {
          try {
            const parsed = JSON.parse(videoObjectMatch[1]);
            const serverGroups = [parsed.SUB, parsed.LAT, parsed.ENG, ...Object.values(parsed)].filter(Boolean);
            for (const grp of serverGroups) {
              if (Array.isArray(grp)) {
                grp.forEach((srv) => {
                  const link = srv.code || srv.url;
                  if (link && typeof link === "string") {
                    const clean = this.normalizeServerUrl(link);
                    if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
                  }
                });
              }
            }
          } catch {
          }
        }
        const videoArrayMatch = html.match(/var\s+videos\s*=\s*(\[.+?\]);/s);
        if (videoArrayMatch) {
          try {
            const parsed = JSON.parse(videoArrayMatch[1].replace(/'/g, '"'));
            if (Array.isArray(parsed)) {
              parsed.forEach((entry) => {
                if (Array.isArray(entry) && entry[1] && typeof entry[1] === "string") {
                  const clean = this.normalizeServerUrl(entry[1]);
                  if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
                }
              });
            }
          } catch {
          }
        }
        const standardStreams = this.extractEmbedsAndStreamsFromHtml($, html, baseUrl);
        standardStreams.forEach((st) => {
          const clean = this.normalizeServerUrl(st);
          if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
        });
        const wpServers = this.extractWordPressServers($);
        for (const raw of wpServers) {
          const clean = this.normalizeServerUrl(raw);
          if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
        }
        return streams;
      }
      extractAnimeflvEpisodes($, html, urlObj) {
        const extractedEpisodes = [];
        const epDataElement = $(".animeflv-episodes-data");
        if (epDataElement.length > 0) {
          try {
            const epData = JSON.parse(epDataElement.text().trim() || "[]");
            if (Array.isArray(epData)) {
              const sorted = [...epData].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
              sorted.forEach((ep) => {
                if (ep.permalink) {
                  extractedEpisodes.push({
                    number: Number(ep.number) || 1,
                    title: `Episodio ${ep.number || 1}`,
                    url: ep.permalink
                  });
                }
              });
            }
          } catch {
          }
        }
        if (extractedEpisodes.length > 0) {
          return extractedEpisodes;
        }
        const scriptTexts = [];
        $("script").each((_, el) => {
          const content = $(el).html() || "";
          if (content) scriptTexts.push(content);
        });
        const allScripts = scriptTexts.join("\n");
        const animeInfoMatch = allScripts.match(/var\s+anime_info\s*=\s*(\[[^;]+\]);/);
        const episodesMatch = allScripts.match(/var\s+episodes\s*=\s*(\[[^;]+\]);/);
        if (episodesMatch) {
          try {
            const epData = JSON.parse(episodesMatch[1]);
            let animeSlug = "";
            if (animeInfoMatch) {
              try {
                const info = JSON.parse(animeInfoMatch[1]);
                animeSlug = String(info[2] || "").trim();
              } catch {
              }
            }
            if (!animeSlug) {
              const seg = urlObj.pathname.split("/").filter(Boolean).pop() || "anime";
              animeSlug = decodeURIComponent(seg).toLowerCase().replace(/\s+/g, "-");
            } else {
              animeSlug = animeSlug.toLowerCase().replace(/\s+/g, "-");
            }
            if (Array.isArray(epData)) {
              const sorted = [...epData].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
              sorted.forEach((ep) => {
                const epNum = ep[0];
                const epUrl = `https://${urlObj.host}/ver/${encodeURIComponent(`${animeSlug}-${epNum}`).replace(/%2D/g, "-")}`;
                extractedEpisodes.push({
                  number: Number(epNum) || 1,
                  title: `Episodio ${epNum}`,
                  url: epUrl
                });
              });
            }
          } catch {
          }
        }
        if (extractedEpisodes.length === 0) {
          $("ul.episodes-list li a, .ListCaps a, ul.ListCaps li a, .capitulos-list a, .episode-list a").each((idx, el) => {
            const rawText = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
            let href = $(el).attr("href") || "";
            if (href && !href.startsWith("http")) {
              try {
                href = new URL(href, `https://${urlObj.host}`).toString();
              } catch {
              }
            }
            if (href && !extractedEpisodes.some((e) => e.url === href)) {
              const numMatch = rawText.match(/\b(?:episodio|capitulo|ep|cap)?\s*(\d+(?:\.\d+)?)\b/i) || href.match(/[-_](\d+(?:\.\d+)?)(?:\/|$|\.html)/i);
              const num = numMatch ? parseFloat(numMatch[1]) : idx + 1;
              extractedEpisodes.push({
                number: num,
                title: rawText.replace(/\s+/g, " "),
                url: href
              });
            }
          });
        }
        return extractedEpisodes;
      }
      extractAnimeflvCard($, card, baseUrl) {
        const animeAnchor = $(card).find("a.thumbnail-link, a[href*='/anime/'], h2.entry-title a, h3 a, h2 a, a[href]").first();
        if (animeAnchor.length === 0) return null;
        const href = (animeAnchor.attr("href") || "").trim();
        if (!href || href === "#" || href.startsWith("javascript:")) return null;
        let fullUrl = href;
        if (!fullUrl.startsWith("http")) {
          try {
            fullUrl = new URL(href, baseUrl).toString();
          } catch {
            return null;
          }
        }
        const img = $(card).find("img.anime-image, img").first();
        let imgUrl = null;
        if (img.length > 0) {
          const imgSrc = img.attr("data-src") || img.attr("data-cfsrc") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("srcset") || img.attr("src") || "";
          if (imgSrc) {
            const firstSrc = imgSrc.split(/\s+/)[0];
            try {
              imgUrl = new URL(firstSrc, baseUrl).toString();
            } catch {
              imgUrl = firstSrc.startsWith("//") ? `https:${firstSrc}` : firstSrc;
            }
          }
        }
        let cardTitle = "";
        const heading = $(card).find("h1, h2, h3, h4, h5, strong, .entry-title, .Title, .title").first();
        if (heading.length > 0 && heading.text().trim().length > 1) {
          cardTitle = heading.text().trim();
        }
        if (!cardTitle && img.length > 0 && img.attr("alt")) {
          cardTitle = img.attr("alt").trim();
        }
        if (!cardTitle) {
          cardTitle = animeAnchor.text().trim() || animeAnchor.attr("title") || "";
        }
        const lowerTitle = cardTitle.toLowerCase();
        if (!cardTitle || !fullUrl || ["inicio", "home", "directorio anime", "dmca", "contacto", "login", "terms of service", "skip to content"].some((b) => lowerTitle.includes(b))) {
          return null;
        }
        return {
          title: cleanQueryTitle(cardTitle),
          url: fullUrl,
          image_url: imgUrl,
          kind: "anime"
        };
      }
      resolveRelativeUrl(url, baseUrl) {
        if (!url) return null;
        if (url.startsWith("http")) return url;
        if (url.startsWith("//")) return `https:${url}`;
        if (url.startsWith("/")) {
          try {
            const u = new URL(baseUrl);
            return `${u.origin}${url}`;
          } catch {
            return `https://animeflv.net${url}`;
          }
        }
        return url;
      }
      async fallbackSearch(query) {
        const cleaned = cleanQueryTitle(query);
        const enriched = await enrichUniversalMetadata(cleaned, "anime");
        return {
          page_type: "detail",
          content_type: "anime",
          title: enriched.title || cleaned,
          original_title: enriched.original_title,
          japanese_title: enriched.japanese_title,
          english_title: enriched.english_title,
          tmdb_id: enriched.tmdb_id,
          description: enriched.description || `B\xFAsqueda para '${query}'`,
          poster_url: enriched.poster_url || null,
          banner_url: enriched.banner_url || null,
          rating: enriched.rating || 8,
          year: enriched.year || 0,
          status: enriched.status || "Finalizado",
          genres: enriched.genres || ["Anime"],
          episodes: [{ number: 1, title: "Episodio 1", url: `https://www3.animeflv.net/browse?q=${encodeURIComponent(cleaned)}` }],
          catalog_items: []
        };
      }
    };
  }
});

// server/scrapers/adapters/GenericAdapter.ts
var cheerio5, GenericAdapter;
var init_GenericAdapter = __esm({
  "server/scrapers/adapters/GenericAdapter.ts"() {
    "use strict";
    cheerio5 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_metadataEngine();
    init_pageClassifier();
    init_validator();
    GenericAdapter = class extends BaseScraperAdapter {
      id = "generic";
      name = "Universal Semantic Scraper (Fallback)";
      supportedDomains = ["* (Universal Fallback)"];
      canHandle(_url) {
        return true;
      }
      async analyze(input, explicitType) {
        const urlOrQuery = input.trim();
        if (!urlOrQuery.startsWith("http://") && !urlOrQuery.startsWith("https://")) {
          return this.handleSearchTerm(urlOrQuery);
        }
        try {
          const urlObj = new URL(urlOrQuery);
          const domain = urlObj.hostname.toLowerCase();
          const html = await this.fetchHtml(urlOrQuery);
          if (!html) {
            if (explicitType === "catalog") throw new Error(`FETCH_FAILED: ${urlOrQuery}`);
            return this.handleSearchTerm(urlOrQuery);
          }
          const $ = cheerio5.load(html);
          const ogTitle = $('meta[property="og:title"]').attr("content") || $('meta[name="twitter:title"]').attr("content") || $("title").text() || "";
          const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="twitter:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
          const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
          const ogVideo = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:url"]').attr("content") || "";
          const jsonLdData = [];
          $('script[type="application/ld+json"]').each((_, el) => {
            try {
              const text = $(el).html();
              if (text) {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) jsonLdData.push(...parsed);
                else jsonLdData.push(parsed);
              }
            } catch {
            }
          });
          const schemaMedia = jsonLdData.find(
            (item) => item["@type"] === "Movie" || item["@type"] === "TVSeries" || item["@type"] === "TVEpisode" || item["@type"] === "VideoObject"
          );
          let detectedKind = "anime";
          const pathAndTitle = (urlOrQuery + " " + ogTitle + " " + ogDesc).toLowerCase();
          if (domain.includes("anime") || pathAndTitle.includes("anime") || pathAndTitle.includes("manga")) {
            detectedKind = "anime";
          } else if (domain.includes("cuevana") || domain.includes("pelis") || pathAndTitle.includes("pelicula") || pathAndTitle.includes("movie") || schemaMedia?.["@type"] === "Movie") {
            detectedKind = "movie";
          } else if (pathAndTitle.includes("serie") || pathAndTitle.includes("temporada") || pathAndTitle.includes("season") || schemaMedia?.["@type"] === "TVSeries") {
            detectedKind = "series";
          }
          const detectedStreams = this.extractEmbedsAndStreamsFromHtml($, html, urlOrQuery);
          if (ogVideo && !detectedStreams.includes(ogVideo)) {
            detectedStreams.unshift(ogVideo);
          }
          const extractedEpisodes = [];
          const episodeSelectors = [
            "ul.episodes-list li a",
            ".episodes-list a",
            "ul.ListCaps li a",
            ".ListCaps a",
            ".capitulos-list a",
            "table.episodes-table tr a",
            ".episode-item a",
            "a[href*='/ver/']",
            "a[href*='episodio']",
            "a[href*='capitulo']",
            "a[href*='watch']"
          ];
          for (const selector of episodeSelectors) {
            $(selector).each((idx, el) => {
              const rawText = $(el).text().trim() || $(el).attr("title") || `Episodio ${idx + 1}`;
              let href = $(el).attr("href") || "";
              if (href && !href.startsWith("http")) {
                try {
                  href = new URL(href, urlOrQuery).toString();
                } catch {
                }
              }
              if (href && !extractedEpisodes.some((e) => e.url === href)) {
                const numMatch = rawText.match(/\b(?:episodio|capitulo|ep|cap)?\s*(\d+(?:\.\d+)?)\b/i) || href.match(/[-_](\d+(?:\.\d+)?)(?:\/|$|\.html)/i);
                const num = numMatch ? parseFloat(numMatch[1]) : idx + 1;
                extractedEpisodes.push({
                  number: num,
                  title: rawText.replace(/\s+/g, " "),
                  url: href
                });
              }
            });
            if (extractedEpisodes.length > 0) break;
          }
          const catalogItems = [];
          const seenCatalogUrls = /* @__PURE__ */ new Set();
          const cardSelectors = [
            "ul.ListAnimes > li",
            "article.anime",
            "article",
            ".anime-card",
            ".item",
            ".film",
            ".card",
            "li.anime",
            "ul.animes > li",
            ".list-animes > li",
            ".grid > div",
            ".catalog-grid > div",
            ".row > div",
            ".post",
            ".hentry",
            ".ht_grid_1_4",
            ".type-post",
            ".browse-item",
            ".catalog-card"
          ];
          let cards = $([]);
          for (const selector of cardSelectors) {
            const found = $(selector);
            if (found.length >= 3) {
              cards = found;
              break;
            }
          }
          cards.each((_, card) => {
            const anchors = $(card).find("a[href]");
            if (anchors.length === 0) return;
            const showUrl = this.extractShowUrlFromAnchors($, anchors, urlOrQuery, domain);
            if (!showUrl || seenCatalogUrls.has(showUrl)) return;
            const imgUrl = this.extractCardImgUrl($, card, urlOrQuery);
            const cardTitle = this.extractCatalogCardTitle($, card, anchors, showUrl);
            if (["inicio", "home", "directorio anime", "dmca", "contacto", "login"].some((b) => cardTitle.toLowerCase().includes(b))) {
              return;
            }
            seenCatalogUrls.add(showUrl);
            catalogItems.push({
              title: cleanQueryTitle(cardTitle),
              url: showUrl,
              image_url: imgUrl,
              kind: detectedKind
            });
          });
          if (catalogItems.length === 0) {
            const anchorSeen = /* @__PURE__ */ new Set();
            $("a[href]").each((_, el) => {
              const $a = $(el);
              const showUrl = this.extractShowUrlFromAnchors($, $a, urlOrQuery, domain);
              if (!showUrl || anchorSeen.has(showUrl)) return;
              anchorSeen.add(showUrl);
              const imgUrl = this.extractCardImgUrl($, el, urlOrQuery);
              const cardTitle = this.extractCatalogCardTitle($, el, $a, showUrl);
              if (!cardTitle) return;
              if (["inicio", "home", "directorio anime", "dmca", "contacto", "login"].some((b) => cardTitle.toLowerCase().includes(b))) return;
              seenCatalogUrls.add(showUrl);
              catalogItems.push({
                title: cleanQueryTitle(cardTitle),
                url: showUrl,
                image_url: imgUrl,
                kind: detectedKind
              });
            });
          }
          const classifiedType = PageClassifier.classify(urlOrQuery, $);
          const isCatalog = explicitType === "catalog" || explicitType !== "detail" && (classifiedType === "collection" || catalogItems.length >= 3 && extractedEpisodes.length === 0);
          const pageType = isCatalog ? "catalog" : "detail";
          const validatedStreams = await MediaValidator.validateUrls(detectedStreams);
          const finalStreams = validatedStreams.length > 0 ? validatedStreams : detectedStreams;
          if (isCatalog) {
            const catalogTitle = ogTitle || `Cat\xE1logo (${domain})`;
            const catalogPoster = this.resolveRelativeUrl(ogImage, urlOrQuery) || (catalogItems[0]?.image_url || null);
            return {
              page_type: "catalog",
              content_type: detectedKind,
              title: catalogTitle,
              description: ogDesc || `Directorio de ${catalogItems.length} obras multimedia detectadas en ${domain}.`,
              poster_url: catalogPoster,
              banner_url: catalogPoster,
              rating: 8.5,
              year: 0,
              status: "Cat\xE1logo",
              genres: ["Directorio", "Cat\xE1logo"],
              source_domain: domain,
              detected_streams: [],
              episodes: [],
              catalog_items: catalogItems,
              raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: [] }
            };
          }
          const rawCleanTitle = cleanQueryTitle(schemaMedia?.name || ogTitle || urlObj.pathname.split("/").pop() || "Contenido");
          const enriched = await enrichUniversalMetadata(rawCleanTitle, detectedKind);
          let finalEpisodes = extractedEpisodes;
          if (finalEpisodes.length === 0) {
            if (detectedKind === "movie" || detectedKind === "open_archive") {
              finalEpisodes = [{ number: 1, title: "Pel\xEDcula Completa", url: detectedStreams[0] || urlOrQuery }];
            } else if (detectedStreams.length > 0) {
              finalEpisodes = detectedStreams.map((st, idx) => ({ number: idx + 1, title: `Episodio ${idx + 1}`, url: st }));
            } else {
              finalEpisodes = [{ number: 1, title: "Episodio 1", url: urlOrQuery }];
            }
          }
          return {
            page_type: pageType,
            content_type: enriched.content_type || detectedKind,
            title: enriched.title || rawCleanTitle,
            original_title: enriched.original_title,
            japanese_title: enriched.japanese_title,
            english_title: enriched.english_title,
            description: enriched.description || ogDesc || "Contenido indexado en VoidStream.",
            poster_url: enriched.poster_url || this.resolveRelativeUrl(ogImage, urlOrQuery),
            banner_url: enriched.banner_url || this.resolveRelativeUrl(ogImage, urlOrQuery),
            rating: enriched.rating || 8,
            year: enriched.year || 0,
            status: enriched.status || "Finalizado",
            genres: enriched.genres.length > 0 ? enriched.genres : ["Multimedia"],
            source_domain: domain,
            detected_streams: finalStreams,
            episodes: finalEpisodes,
            catalog_items: catalogItems,
            raw_metadata: { og: { title: ogTitle, description: ogDesc, image: ogImage }, embeds: finalStreams }
          };
        } catch {
          return this.handleSearchTerm(urlOrQuery);
        }
      }
      resolveRelativeUrl(url, baseUrl) {
        if (!url) return null;
        if (url.startsWith("http")) return url;
        if (url.startsWith("//")) return `https:${url}`;
        if (url.startsWith("/")) {
          try {
            const u = new URL(baseUrl);
            return `${u.origin}${url}`;
          } catch {
            return null;
          }
        }
        return url;
      }
      async handleSearchTerm(query) {
        const cleaned = cleanQueryTitle(query);
        const enriched = await enrichUniversalMetadata(cleaned);
        const primaryUrl = `https://www3.animeflv.net/browse?q=${encodeURIComponent(cleaned)}`;
        const defaultEpisodes = enriched.suggested_episodes && enriched.suggested_episodes.length > 0 ? enriched.suggested_episodes.map((s) => ({
          number: s.number,
          title: s.title,
          url: s.url || primaryUrl
        })) : [{ number: 1, title: "Episodio 1", url: primaryUrl }];
        return {
          page_type: "detail",
          content_type: enriched.content_type || "anime",
          title: enriched.title || cleaned,
          original_title: enriched.original_title,
          japanese_title: enriched.japanese_title,
          english_title: enriched.english_title,
          description: enriched.description || `Resultados de b\xFAsqueda para '${query}'`,
          poster_url: enriched.poster_url || null,
          banner_url: enriched.banner_url || null,
          rating: enriched.rating || 8,
          year: enriched.year || 0,
          status: enriched.status || "Finalizado",
          genres: enriched.genres || ["Multimedia"],
          episodes: defaultEpisodes,
          catalog_items: []
        };
      }
      extractShowUrlFromAnchors($, anchors, urlOrQuery, domain) {
        let showUrl = null;
        anchors.each((_, a) => {
          const href = ($(a).attr("href") || "").trim();
          if (!href) return;
          let fullUrl = href;
          if (!fullUrl.startsWith("http")) {
            try {
              fullUrl = new URL(href, urlOrQuery).toString();
            } catch {
              return;
            }
          }
          try {
            const parsed = new URL(fullUrl);
            if (parsed.hostname.toLowerCase() === domain) {
              const pathLower = parsed.pathname.toLowerCase();
              if (pathLower !== "" && pathLower !== "/" && pathLower !== "/home" && pathLower !== "/inicio" && !["/category/", "/genre/", "/tag/", "/page/", "/browse", "#", "javascript:"].some((b) => pathLower.includes(b))) {
                showUrl = fullUrl;
                return false;
              }
            }
          } catch {
          }
        });
        return showUrl;
      }
      extractCardImgUrl($, card, urlOrQuery) {
        const img = $(card).find("img").first();
        if (img.length === 0) return null;
        const imgSrc = img.attr("data-src") || img.attr("data-lazy-src") || img.attr("data-original") || img.attr("srcset") || img.attr("src") || "";
        if (!imgSrc) return null;
        const firstSrc = imgSrc.split(/\s+/)[0];
        try {
          return new URL(firstSrc, urlOrQuery).toString();
        } catch {
          if (firstSrc.startsWith("//")) return `https:${firstSrc}`;
          if (firstSrc.startsWith("/")) {
            try {
              const u = new URL(urlOrQuery);
              return `${u.origin}${firstSrc}`;
            } catch {
              return null;
            }
          }
          return firstSrc;
        }
      }
      extractCatalogCardTitle($, card, anchors, showUrl) {
        const heading = $(card).find("h1, h2, h3, h4, h5, strong, .title, .entry-title").first();
        if (heading.length > 0 && heading.text().trim().length > 1) {
          return heading.text().trim();
        }
        const img = $(card).find("img").first();
        if (img.length > 0 && img.attr("alt")) {
          return img.attr("alt").trim();
        }
        let anchorTitle = "";
        anchors.each((_, a) => {
          const t = $(a).text().trim() || $(a).attr("title") || "";
          if (t.length > 1 && !["ver", "anime", "leer"].some((b) => t.toLowerCase().includes(b))) {
            anchorTitle = t;
            return false;
          }
        });
        if (anchorTitle) return anchorTitle;
        if (showUrl) {
          const parts = showUrl.replace(/\/$/, "").split("/");
          return parts[parts.length - 1].replace(/[-_]/g, " ");
        }
        return "";
      }
    };
  }
});

// server/scrapers/adapters/LaMovieAdapter.ts
var cheerio6, LaMovieAdapter;
var init_LaMovieAdapter = __esm({
  "server/scrapers/adapters/LaMovieAdapter.ts"() {
    "use strict";
    cheerio6 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_jsUnpacker();
    init_resolvers();
    init_vimeosResolver();
    LaMovieAdapter = class _LaMovieAdapter extends BaseScraperAdapter {
      id = "lamovie";
      name = "LaMovie (Pel\xEDculas, Series, Animes)";
      supportedDomains = ["lamovie.org", "lamovie.to", "lamovie.ws"];
      /** Hosts de descarga directa (no exponen stream embebido): no intentar resolver */
      static DOWNLOAD_HOSTS = ["1fichier.com", "megaup.net"];
      static DEAD_OR_BLOCKED_HOST_PATTERNS = [
        /cfglobalcdn\.com/i,
        /yourupload\.com/i,
        /streamtape\./i,
        /dsvplay\.com/i,
        /savefiles\.com/i,
        /d-s\.io/i,
        /a\d+\.mp4upload\.com/i,
        /vidcache\.net/i,
        /my\.mail\.ru/i,
        /v\.tioanime\.com/i
      ];
      static isDeadOrBlocked(url) {
        return _LaMovieAdapter.DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));
      }
      /**
       * Defecto #5: solo aceptar fuentes reproducibles — media directa (.m3u8/.mp4/
       * .webm/.mkv) o embeds de hosts de streaming conocidos. Descarta basura tipo
       * "10CCCCCC.rar" de MediaFire, .zip, magnet y páginas HTML crudas.
       */
      static isPlayableSourceUrl(url) {
        const lower = (url || "").toLowerCase();
        if (!lower.startsWith("http") && !lower.startsWith("magnet:")) return false;
        if (lower.startsWith("magnet:")) return false;
        if (/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(lower)) return true;
        const KNOWN_EMBED_HOSTS2 = [
          "goodstream.",
          "vidhide",
          "streamwish.",
          "hlswish.",
          "streamhide.",
          "filemoon.",
          "mp4upload.com",
          "mega.nz/embed",
          "voe.",
          "byselapuix.com",
          "mixdrop.",
          "dood.",
          "doodstream.",
          "streamtape.",
          "yourupload.com",
          "ok.ru",
          "uqload.",
          "luluvdo.",
          "vidmoly.",
          "upstream.",
          "streamlare.",
          "fastre.",
          "gamovideo.",
          "netu.",
          "waaw.",
          "streamdav.",
          "streamhub.",
          "fembed.",
          "embedsito.",
          "zilla-networks.com",
          "vimeo.com"
        ];
        if (KNOWN_EMBED_HOSTS2.some((h) => lower.includes(h))) return true;
        if (/\.(rar|zip|7z|exe|iso|pdf|jpg|jpeg|png|webp|gif|txt|srt|ass)(\?|#|$)/i.test(lower)) {
          return false;
        }
        return false;
      }
      /** Filtro de fuentes jugables para las listas finales. */
      static filterPlayableSources(urls) {
        return urls.filter((u) => _LaMovieAdapter.isPlayableSourceUrl(u));
      }
      canHandle(url) {
        const lower = url.toLowerCase();
        return lower.includes("lamovie.");
      }
      /**
       * Extrae el catálogo desde los sitemaps XML oficiales
       * Ejemplo: https://lamovie.org/wp-sitemap-posts-movies-1.xml
       */
      async extractCatalogFromSitemap(contentType, page = 1) {
        const sitemapMap = {
          movie: "movies",
          series: "tvshows",
          anime: "animes",
          documentary: "movies",
          open_archive: "movies"
        };
        const sitemapType = sitemapMap[contentType] || "movies";
        const sitemapUrl = `https://lamovie.org/wp-sitemap-posts-${sitemapType}-${page}.xml`;
        const xml = await this.fetchHtml(sitemapUrl, 1e4);
        if (!xml) return null;
        const $ = cheerio6.load(xml, { xmlMode: true });
        const items = [];
        $("loc").each((_, el) => {
          const url = $(el).text().trim();
          if (!url || !url.includes("/peliculas/") && !url.includes("/series/") && !url.includes("/animes/")) {
            return;
          }
          const slugMatch = url.match(/\/(?:peliculas|series|animes)\/([^/]+)\/?$/);
          if (!slugMatch) return;
          const slug = slugMatch[1];
          if (["peliculas", "series", "animes"].includes(slug)) return;
          const cleanTitle2 = slug.replace(/-\d{4}$/, "").replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
          items.push({
            title: cleanTitle2,
            url,
            kind: contentType
          });
        });
        return items;
      }
      /**
       * Catálogo vía el API interno de listado (verificado con curl, 2026-08-24):
       *   /wp-api/v1/listing/movies?page=N&postType={movies|tvshows|animes}&postsPerPage=24
       * Respuesta: { error, message, data: { posts:[...], pagination:{ total, last_page } } }
       * Cada post trae overview/genres/imdb_rating/images → items PRE-ENRIQUECIDOS.
       * NO usar postType=series/tv/anime: devuelven ~69k episodios sueltos mezclados.
       */
      async extractCatalogFromListingApi(contentType, page = 1) {
        const postType = contentType === "series" ? "tvshows" : contentType === "anime" ? "animes" : "movies";
        const fichaPrefix = postType === "movies" ? "peliculas" : postType === "tvshows" ? "series" : "animes";
        const apiUrl = `https://lamovie.org/wp-api/v1/listing/movies?page=${page}&postType=${postType}&postsPerPage=24`;
        const raw = await this.fetchHtml(apiUrl, 1e4);
        if (!raw) return null;
        try {
          const json = JSON.parse(raw);
          const posts = json?.data?.posts || [];
          const items = [];
          for (const p of posts) {
            if (!p?.slug || !p?.title) continue;
            const yearRaw = typeof p.release_date === "string" ? parseInt(p.release_date.slice(0, 4), 10) : NaN;
            const ratingRaw = Number(p.imdb_rating ?? p.rating ?? NaN);
            let image = null;
            if (typeof p.images === "string") image = p.images;
            else if (p.images && typeof p.images === "object") {
              image = p.images.poster || p.images.cover || p.images.thumbnail || p.images.original || null;
            }
            items.push({
              title: String(p.title).trim(),
              url: `https://lamovie.org/${fichaPrefix}/${p.slug}/`,
              image_url: image,
              kind: contentType,
              year: Number.isFinite(yearRaw) ? yearRaw : null,
              rating: Number.isFinite(ratingRaw) ? ratingRaw : null,
              // genres del API son IDs numéricos sin endpoint de taxonomía pública:
              // se omiten para no contaminar el catálogo; TMDB los llena en español al guardar.
              genres: void 0
            });
          }
          return items;
        } catch {
          return [];
        }
      }
      /**
       * Extrae el Post ID de WordPress desde el HTML
       * Busca en: <link rel="shortlink" href="https://lamovie.org/?p=ID" />
       */
      extractPostId(html) {
        const shortlinkMatch = html.match(/shortlink[^>]*\?p=(\d+)/i);
        if (shortlinkMatch) return shortlinkMatch[1];
        const jsonLdMatch = html.match(/"@id"\s*:\s*"[^"]*\/(\d+)"/);
        if (jsonLdMatch) return jsonLdMatch[1];
        const dataIdMatch = html.match(/data-id[="'](\d+)["']/i);
        if (dataIdMatch) return dataIdMatch[1];
        return null;
      }
      /**
       * Extrae episodios de una serie desde el HTML
       * Busca enlaces a /episodio/ o /temporada/
       */
      extractEpisodes(html, baseUrl) {
        const $ = cheerio6.load(html);
        const episodes = [];
        const episodeLinks2 = $("a[href*='/episodio/'], a[href*='/temporada/']");
        episodeLinks2.each((i, el) => {
          const href = $(el).attr("href");
          const title = $(el).text().trim();
          if (!href) return;
          const fullUrl = this.resolveRelativeUrl(href, baseUrl);
          const numberMatch = title.match(/(\d+)/) || href.match(/episodio-(\d+)/);
          const number = numberMatch ? parseInt(numberMatch[1], 10) : i + 1;
          episodes.push({
            number,
            title: title || `Episodio ${number}`,
            url: fullUrl,
            server_name: "LaMovie"
          });
        });
        return episodes;
      }
      /**
       * Deriva slug y postType de una URL de detalle (/peliculas|/series|/animes/{slug})
       * o de un episodio (/episodio/{slug}).
       */
      getSlugAndPostType(url) {
        const episodeMatch = url.match(/\/episodio\/([^/]+)\/?$/i);
        if (episodeMatch) return { slug: episodeMatch[1], postType: "episodes" };
        const pathMatch = url.match(/\/(?:peliculas|series|animes)\/([^/]+)\/?$/i);
        if (!pathMatch) return null;
        const lower = url.toLowerCase();
        const postType = lower.includes("/series/") ? "tvshows" : lower.includes("/animes/") ? "animes" : "movies";
        return { slug: pathMatch[1], postType };
      }
      /**
       * Conteos de episodios por temporada desde TMDB (fuente confiable: la API
       * pública de lamovie NO expone listados de episodios filtrados por show).
       * Costo: 1 search + 1 details por serie. TMDB tolera 40-50 req/s.
       */
      async fetchTmdbSeasonEpisodeCounts(title, year) {
        try {
          const key = process.env.TMDB_API_KEY;
          if (!key) return [];
          const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ""}&language=es-MX`;
          const searchRaw = await this.fetchHtml(searchUrl, 8e3);
          if (!searchRaw) return [];
          const search = JSON.parse(searchRaw);
          const id = search?.results?.[0]?.id;
          if (!id) return [];
          const detailsRaw = await this.fetchHtml(`https://api.themoviedb.org/3/tv/${id}?api_key=${key}&language=es-MX`, 8e3);
          if (!detailsRaw) return [];
          const details = JSON.parse(detailsRaw);
          return (details?.seasons || []).filter((s) => Number.isFinite(s?.season_number) && s.season_number >= 1 && Number.isFinite(s?.episode_count)).map((s) => ({ season: s.season_number, count: s.episode_count }));
        } catch {
          return [];
        }
      }
      /**
       * Episodios de serie/anime: HTML de la ficha primero; si la ficha no los lista
       * (el sitio es SPA y los carga con bearer), genera los slugs PREDECIBLES del
       * sitio usando los conteos REALES de TMDB:
       *   /episodio/<show-slug-sin-año>-temporada-S-episodio-E/
       * (patrón verificado: "avatar-la-leyenda-de-aang-2005" → episodio
       *  "avatar-la-leyenda-de-aang-temporada-3-episodio-21").
       * Cada episodio resuelve sus streams JIT: /episodio/ expone shortlink postId
       * y wp-api/v1/player?postId=X devuelve los embeds.
       */
      async buildEpisodeList(html, cleanUrl2, metadata) {
        const fromHtml = this.extractEpisodes(html, cleanUrl2);
        if (fromHtml.length > 0) return fromHtml;
        const info = this.getSlugAndPostType(cleanUrl2);
        if (!info) return [];
        const baseSlug = info.slug.replace(/-\d{4}$/, "");
        const seasons = await this.fetchTmdbSeasonEpisodeCounts(metadata.title, metadata.year);
        if (seasons.length === 0) return [];
        const episodes = [];
        let n = 0;
        for (const s of seasons) {
          for (let e = 1; e <= s.count; e++) {
            n++;
            episodes.push({
              number: n,
              title: `T${s.season}:E${e}`,
              url: `https://lamovie.org/episodio/${baseSlug}-temporada-${s.season}-episodio-${e}/`
            });
          }
        }
        return episodes;
      }
      /**
       * Obtiene el Post ID vía la API interna single (campo `_id`) cuando el HTML no lo expone.
       * Endpoint real descubierto en producción: /wp-api/v1/single/{postType}?slug={slug}&postType={postType}
       */
      async fetchPostIdFromInternalApi(url) {
        try {
          const info = this.getSlugAndPostType(url);
          if (!info) return null;
          const apiUrl = `https://lamovie.org/wp-api/v1/single/${info.postType}?slug=${encodeURIComponent(info.slug)}&postType=${info.postType}`;
          const raw = await this.fetchHtml(apiUrl, 8e3);
          if (!raw) return null;
          const json = JSON.parse(raw);
          const id = json?.data?._id;
          return id !== void 0 && id !== null ? String(id) : null;
        } catch {
          return null;
        }
      }
      /**
       * Consulta la API interna de la SPA para obtener metadatos completos del detalle.
       * Endpoint real descubierto en producción: /wp-api/v1/single/{postType}?slug={slug}&postType={postType}
       */
      async fetchInternalMetadata(url) {
        try {
          const info = this.getSlugAndPostType(url);
          if (!info) return null;
          const { slug, postType } = info;
          const apiUrl = `https://lamovie.org/wp-api/v1/single/${postType}?slug=${encodeURIComponent(slug)}&postType=${postType}`;
          const raw = await this.fetchHtml(apiUrl, 8e3);
          if (!raw) return null;
          const json = JSON.parse(raw);
          const data = json?.data;
          if (!data) return null;
          const uploadsBase = "https://lamovie.org/wp-content/uploads";
          const absImage = (p) => p ? p.startsWith("http") ? p : `${uploadsBase}${p.startsWith("/") ? "" : "/"}${p}` : void 0;
          const rawTitle = (data.title || "").trim();
          const cleanTitle2 = rawTitle.replace(/\s*\(\d{4}\)\s*$/, "").trim();
          let year;
          if (data.release_date) {
            const y = parseInt(String(data.release_date).slice(0, 4), 10);
            if (!Number.isNaN(y)) year = y;
          }
          let duration;
          if (data.runtime) {
            const mins = Math.round(parseFloat(data.runtime));
            if (!Number.isNaN(mins) && mins > 0) duration = `${mins} min`;
          }
          return {
            title: cleanTitle2 || rawTitle || void 0,
            original_title: data.original_title || void 0,
            description: data.overview || void 0,
            poster_url: absImage(data.images?.poster),
            banner_url: absImage(data.images?.backdrop),
            rating: data.rating !== void 0 && data.rating !== null ? parseFloat(data.rating) : void 0,
            year,
            duration
          };
        } catch {
          return null;
        }
      }
      /**
       * Extrae metadatos de una página de detalle.
       * Fuente primaria: API interna de la SPA (sitio renderizado en React).
       * Fallbacks: meta tags OpenGraph, JSON-LD (breadcrumb con año) y regex sobre el HTML.
       */
      async extractMetadata(html, url) {
        const $ = cheerio6.load(html);
        const api = await this.fetchInternalMetadata(url);
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const h1Title = $("h1").first().text().trim();
        let year = api?.year ?? 0;
        if (!year) {
          const breadcrumbName = html.match(/"ListItem","position":2,"name":"[^"]*?\((\d{4})\)"/i)?.[1];
          const parenYear = ogTitle.match(/\((\d{4})\)/)?.[1] || breadcrumbName;
          const yearMatch = parenYear || html.match(/Año[\s:]*(\d{4})/i)?.[1] || html.match(/release_date[\s:]*["'](\d{4})/i)?.[1];
          year = yearMatch ? parseInt(yearMatch, 10) : 0;
        }
        const originalTitleFromOg = ogTitle.match(/Pelicula\s+(.+?)\s*\(\d{4}\)/i)?.[1];
        const original_title = api?.original_title || originalTitleFromOg || void 0;
        const title = api?.title || ogTitle.replace(/\s*\(\d{4}\)\s*/, " ").replace(/\s*\|\s*LaMovie\s*$/i, "").trim() || h1Title || "Contenido LaMovie";
        const ogDesc = api?.description || $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || $(".overview, .sinopsis, .description").first().text().trim() || "";
        const ogImage = $('meta[property="og:image"]').attr("content");
        const posterUrl = api?.poster_url || (ogImage ? this.resolveRelativeUrl(ogImage, url) : void 0);
        const bannerUrl = api?.banner_url || posterUrl;
        const ratingMatch = html.match(/IMDb[\s:]*([\d.]+)/i) || html.match(/rating[\s:]*([\d.]+)/i);
        const rating = api?.rating ?? (ratingMatch ? parseFloat(ratingMatch[1]) : 7);
        const genres = [];
        $("a[href*='/genero/'], .genres a, .meta-genres a").each((_, el) => {
          const genre = $(el).text().trim();
          if (genre && !genres.includes(genre)) {
            genres.push(genre);
          }
        });
        const durationMatch = html.match(/Duración[\s:]*([\d]+\s*min)/i);
        const duration = api?.duration || (durationMatch ? durationMatch[1] : void 0);
        const content_type = url.includes("/series/") ? "series" : url.includes("/animes/") ? "anime" : "movie";
        return {
          title,
          original_title,
          description: ogDesc,
          poster_url: posterUrl,
          banner_url: bannerUrl,
          rating,
          year,
          genres,
          duration,
          content_type
        };
      }
      /**
       * Resuelve un iframe de reproductor desofuscando el JS interno
       */
      async resolveIframeStream(iframeUrl, referer = "https://lamovie.org/") {
        try {
          const html = await this.fetchHtml(iframeUrl, 7500, {
            Referer: referer,
            "User-Agent": COMMON_HEADERS["User-Agent"]
          });
          if (!html) return [];
          const unpacked = unpackGeneric(html);
          const urls = extractMediaUrlsFromCode(unpacked);
          return urls.filter(
            (url) => url.includes(".m3u8") || url.includes(".mp4") || url.includes(".webm")
          );
        } catch {
          return [];
        }
      }
      /**
       * Extrae streams de video usando la API interna de LaMovie.
       * Cadena resiliente: Post ID del HTML (shortlink) > API interna single (`_id`) >
       * extracción genérica de embeds del HTML. Nunca lanza excepción.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        try {
          const html = await this.fetchHtml(cleanUrl2, 1e4);
          let postId = html ? this.extractPostId(html) : null;
          if (!postId) {
            postId = await this.fetchPostIdFromInternalApi(cleanUrl2);
          }
          let embedUrls = [];
          const downloadUrls = [];
          if (postId && html) {
            const playerApiUrl = `https://lamovie.org/wp-api/v1/player?postId=${postId}&demo=0`;
            const playerRes = await this.fetchHtml(playerApiUrl, 7500, {
              Referer: cleanUrl2,
              "User-Agent": COMMON_HEADERS["User-Agent"]
            });
            if (playerRes) {
              try {
                const playerData = JSON.parse(playerRes);
                const embeds = playerData?.data?.embeds || playerData?.embeds || [];
                embeds.forEach((e) => {
                  if (e.url && typeof e.url === "string") {
                    embedUrls.push(e.url.trim());
                  }
                });
                const downloads = playerData?.data?.downloads || playerData?.downloads || [];
                downloads.forEach((d) => {
                  if (d.url && typeof d.url === "string") {
                    let u = d.url.trim();
                    if (u.includes("mega.nz")) {
                      u = u.replace("mega.nz/file/", "mega.nz/embed/").replace("mega.nz/#!", "mega.nz/embed/#!");
                    }
                    if (/^https?:\/\//i.test(u)) {
                      downloadUrls.push(u);
                    }
                  }
                });
              } catch {
              }
            }
          }
          if (embedUrls.length === 0 && html) {
            try {
              const $ = cheerio6.load(html);
              const rawEmbeds = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl2);
              for (const raw of rawEmbeds) {
                if (raw.includes(".m3u8") || raw.includes(".mp4")) {
                  if (!embedUrls.includes(raw)) embedUrls.push(raw);
                } else if (!downloadUrls.some((d) => d === raw)) {
                  if (!embedUrls.includes(raw)) embedUrls.push(raw);
                }
              }
            } catch {
            }
          }
          if (html) {
            for (const dl of downloadUrls) {
              if (!embedUrls.includes(dl)) embedUrls.push(dl);
            }
          }
          const isDownloadHost = (u) => _LaMovieAdapter.DOWNLOAD_HOSTS.some((h) => u.toLowerCase().includes(h));
          const resolved = await Promise.all(
            embedUrls.map(async (embedUrl) => {
              const isDownload = isDownloadHost(embedUrl);
              const isEmbedPage = !embedUrl.includes(".m3u8") && !embedUrl.includes(".mp4") && !embedUrl.startsWith("magnet:") && !isDownload;
              let direct = null;
              if (isEmbedPage) {
                if (VimeosResolver.isVimeosUrl(embedUrl)) {
                  const urls = await VimeosResolver.resolveVimeos(embedUrl);
                  if (urls.length > 0) direct = urls[0];
                } else {
                  const meta = await EmbedResolvers.resolveWithMeta(embedUrl);
                  if (meta.resolved && meta.url && !EmbedResolvers.isPlaceholderUrl(meta.url)) {
                    direct = meta.url;
                  }
                }
              }
              return { embedUrl, isDownload, direct };
            })
          );
          const directStreams = [];
          const embedStreams = [];
          for (const { embedUrl, isDownload, direct } of resolved) {
            if (isDownload) continue;
            if (direct && !_LaMovieAdapter.isDeadOrBlocked(direct) && !directStreams.includes(direct)) {
              directStreams.push(direct);
            }
            if (!_LaMovieAdapter.isDeadOrBlocked(embedUrl) && !embedStreams.includes(embedUrl)) {
              embedStreams.push(embedUrl);
            }
          }
          let title;
          if (html) {
            const $ = cheerio6.load(html);
            title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || $("title").text().trim() || void 0;
          }
          const playableDirects = _LaMovieAdapter.filterPlayableSources(directStreams);
          const playableEmbeds = _LaMovieAdapter.filterPlayableSources(embedStreams);
          const finalStreams = playableDirects.length > 0 ? [...playableDirects, ...playableEmbeds] : playableEmbeds;
          return {
            stream_url: finalStreams[0] || cleanUrl2,
            all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl2],
            title: title || void 0
          };
        } catch {
          return {
            stream_url: cleanUrl2,
            all_available_streams: [cleanUrl2]
          };
        }
      }
      /**
       * Analiza una URL de LaMovie (catálogo, detalle o stream)
       */
      async analyze(input, explicitType) {
        const cleanUrl2 = input.trim();
        const urlObj = new URL(cleanUrl2);
        const path7 = urlObj.pathname.toLowerCase().replace(/\/$/, "");
        const postTypeParam = (urlObj.searchParams.get("postType") || "").toLowerCase();
        let contentType;
        if (postTypeParam === "tvshows") {
          contentType = "series";
        } else if (postTypeParam === "animes") {
          contentType = "anime";
        } else {
          const isSeries = path7.includes("/series") || path7.includes("/tvshows");
          const isAnime = path7.includes("/animes") || path7.includes("/anime");
          contentType = isSeries ? "series" : isAnime ? "anime" : "movie";
        }
        const pageParam = urlObj.searchParams.get("page") || cleanUrl2.match(/\/page\/(\d+)/)?.[1] || "1";
        const pageNum = Math.max(1, parseInt(pageParam, 10) || 1);
        const isCatalog = explicitType === "catalog" || path7 === "" || path7 === "/" || path7 === "/peliculas" || path7 === "/series" || path7 === "/animes" || path7.match(/^\/(?:peliculas|series|animes)\/page\/\d+/i) !== null || urlObj.searchParams.has("page");
        if (isCatalog) {
          const fromApi = await this.extractCatalogFromListingApi(contentType, pageNum);
          let catalogItems = fromApi || [];
          if (catalogItems.length === 0) {
            catalogItems = await this.extractCatalogFromSitemap(contentType, pageNum) || [];
          }
          if (catalogItems.length === 0 && fromApi === null && explicitType === "catalog") {
            throw new Error(`FETCH_FAILED: ${cleanUrl2}`);
          }
          const titleType = contentType === "movie" ? "Pel\xEDculas" : contentType === "series" ? "Series" : "Animes";
          return {
            page_type: "catalog",
            content_type: contentType,
            title: `Cat\xE1logo de ${titleType} - LaMovie (P\xE1g ${pageNum})`,
            description: `Cat\xE1logo de ${titleType} en LaMovie (${catalogItems.length} t\xEDtulos disponibles)`,
            poster_url: null,
            banner_url: null,
            rating: 8,
            year: 0,
            status: "Publicado",
            genres: [titleType, "Directorio"],
            source_domain: "lamovie.org",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const html = await this.fetchHtml(cleanUrl2, 1e4);
        if (!html) {
          return {
            page_type: "detail",
            content_type: contentType,
            title: "Contenido LaMovie",
            description: "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "lamovie.org",
            episodes: [],
            catalog_items: []
          };
        }
        const metadata = await this.extractMetadata(html, cleanUrl2);
        const episodes = contentType === "series" || contentType === "anime" ? await this.buildEpisodeList(html, cleanUrl2, { title: metadata.title, year: metadata.year }) : [{ number: 1, title: metadata.title || "Pel\xEDcula Completa", url: cleanUrl2 }];
        let detectedStreams = [];
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          try {
            const streamResult = await this.extractStream(cleanUrl2);
            detectedStreams = streamResult.all_available_streams;
          } catch {
          }
        }
        return {
          page_type: "detail",
          content_type: metadata.content_type,
          title: metadata.title,
          original_title: metadata.original_title,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: metadata.rating,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          duration: metadata.duration || null,
          source_domain: "lamovie.org",
          detected_streams: detectedStreams.length > 0 ? detectedStreams : void 0,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
    };
  }
});

// server/scrapers/adapters/LatAnimeAdapter.ts
var cheerio7, BASE_URL, DEAD_OR_BLOCKED_HOST_PATTERNS2, isDeadOrBlocked2, LatAnimeAdapter;
var init_LatAnimeAdapter = __esm({
  "server/scrapers/adapters/LatAnimeAdapter.ts"() {
    "use strict";
    cheerio7 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    BASE_URL = "https://latanime.org";
    DEAD_OR_BLOCKED_HOST_PATTERNS2 = [
      /cfglobalcdn\.com/i,
      /yourupload\.com/i,
      /streamtape\./i,
      /dsvplay\.com/i,
      /savefiles\.com/i,
      /d-s\.io/i,
      /a\d+\.mp4upload\.com/i,
      /vidcache\.net/i,
      /my\.mail\.ru/i,
      /v\.tioanime\.com/i
    ];
    isDeadOrBlocked2 = (url) => DEAD_OR_BLOCKED_HOST_PATTERNS2.some((p) => p.test(url));
    LatAnimeAdapter = class extends BaseScraperAdapter {
      id = "latanime";
      name = "LatAnime (Animes)";
      supportedDomains = ["latanime.org"];
      canHandle(url) {
        const lower = url.toLowerCase();
        return lower.includes("latanime.org");
      }
      /**
       * Búsqueda de animes en latanime.org (/buscar?q=...)
       */
      async search(query) {
        const searchUrl = `${BASE_URL}/buscar?q=${encodeURIComponent(query.trim())}`;
        const html = await this.fetchHtml(searchUrl, 1e4);
        if (!html) return [];
        return this.extractCatalogItems(html);
      }
      /**
       * Extrae items de catálogo desde el Home o resultados de búsqueda.
       * Los enlaces a animes son `a[href^="https://latanime.org/anime/"]`.
       */
      extractCatalogItems(html) {
        const $ = cheerio7.load(html);
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        $("a[href*='/anime/']").each((_, el) => {
          const href = $(el).attr("href");
          if (!href) return;
          const url = this.resolveRelativeUrl(href, BASE_URL);
          if (!url || !url.startsWith(`${BASE_URL}/anime/`)) return;
          if (seen.has(url)) return;
          seen.add(url);
          const $link = $(el);
          const $h3 = $link.find("h3").first();
          const $img = $link.find("img").first();
          const rawImg = $img.attr("data-src") || $img.attr("src") || "";
          const imageUrl = rawImg && !rawImg.includes("capblank") ? this.resolveRelativeUrl(rawImg, BASE_URL) : null;
          const title = $h3.text().trim() || ($img.attr("alt") || "").trim() || $link.text().trim() || this.titleFromSlug(href);
          const detailsText = $link.find(".seriedetails span").last().text().trim();
          const yearMatch = detailsText.match(/(19|20)\d{2}/);
          const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
          items.push({
            title,
            url: href,
            image_url: imageUrl,
            kind: "anime",
            year
          });
        });
        return items;
      }
      /**
       * Metadatos de una página de detalle usando OpenGraph y la sinopsis del sitio.
       */
      extractMetadata(html, url) {
        const $ = cheerio7.load(html);
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const h1Title = $("h1").first().text().trim();
        const title = ogTitle.replace(/\s*[-–—]\s*Latanime\s*$/i, "").trim() || h1Title || this.titleFromSlug(url) || "Anime";
        const ogImage = $('meta[property="og:image"]').attr("content");
        const poster_url = ogImage ? this.resolveRelativeUrl(ogImage, url) : void 0;
        const ogDesc = $('meta[property="og:description"]').attr("content") || "";
        const sinopsis = $(".sinopsis").first().text().trim() || $("p.text-sm").first().text().trim() || $("p.description").first().text().trim();
        const description = ogDesc || sinopsis || "";
        const genres = [];
        $("a[href*='/genero/'], .genres a, .meta-genres a").each((_, el) => {
          const genre = $(el).text().trim();
          if (genre && !genres.includes(genre)) genres.push(genre);
        });
        const yearMatch = html.match(/Año[\s:]*(\d{4})/i)?.[1] || description.match(/(19\d{2}|20[0-2]\d)/)?.[0] || html.match(/release_date[\s:]*["'](19\d{2}|20[0-2]\d)/i)?.[1];
        const year = yearMatch ? parseInt(yearMatch, 10) : 0;
        return {
          title,
          description,
          poster_url,
          banner_url: poster_url,
          genres,
          year,
          content_type: "anime"
        };
      }
      /**
       * Lista de episodios: todos los `a` cuyo href contiene "/ver/".
       * El número de episodio se extrae de la URL (formato: ...-episodio-N).
       */
      extractEpisodes(html, baseUrl) {
        const $ = cheerio7.load(html);
        const episodes = [];
        const seen = /* @__PURE__ */ new Set();
        $("a[href*='/ver/']").each((_, el) => {
          const href = $(el).attr("href");
          if (!href || seen.has(href)) return;
          seen.add(href);
          const fullUrl = this.resolveRelativeUrl(href, baseUrl);
          const numberMatch = fullUrl.match(/-episodio-(\d+)/) || fullUrl.match(/(\d+)\s*$/);
          const number = numberMatch ? parseInt(numberMatch[1], 10) : episodes.length + 1;
          const linkText = $(el).text().replace(/\s+/g, " ").trim();
          const capMatch = linkText.match(/capitulo\s*(\d+)/i);
          const title = capMatch ? `Capitulo ${capMatch[1]}` : linkText || `Episodio ${number}`;
          episodes.push({
            number,
            title,
            url: fullUrl,
            server_name: "LatAnime"
          });
        });
        return episodes.sort((a, b) => a.number - b.number);
      }
      /**
       * Decodifica los valores Base64 del atributo data-player y devuelve las URLs de iframe.
       */
      decodeDataPlayers(html) {
        const $ = cheerio7.load(html);
        const iframes = [];
        $("[data-player]").each((_, el) => {
          const encoded = $(el).attr("data-player");
          if (!encoded) return;
          try {
            const decoded = Buffer.from(encoded, "base64").toString("utf-8").trim();
            if (/^https?:\/\//i.test(decoded) && !isDeadOrBlocked2(decoded) && !iframes.includes(decoded)) {
              iframes.push(decoded);
            }
          } catch {
          }
        });
        return iframes;
      }
      async analyze(input, explicitType) {
        const cleanUrl2 = input.trim();
        const url = new URL(cleanUrl2);
        const path7 = url.pathname.toLowerCase();
        const isCatalogRoute = path7 === "/" || /^\/(animes|browse|letra|emision)(\/.*)?$/.test(path7) || path7.startsWith("/buscar");
        if (explicitType === "catalog" || isCatalogRoute) {
          const target = path7 === "/" ? BASE_URL : `${url.origin}${url.pathname}${url.search}`;
          const html2 = await this.fetchHtml(target, 1e4);
          if (!html2) throw new Error(`FETCH_FAILED: ${target}`);
          const catalogItems = this.extractCatalogItems(html2);
          return {
            page_type: "catalog",
            content_type: "anime",
            title: path7.startsWith("/buscar") ? `B\xFAsqueda en LatAnime` : "Cat\xE1logo de Animes - LatAnime",
            description: `Cat\xE1logo completo de animes en LatAnime (${catalogItems.length} t\xEDtulos)`,
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "latanime.org",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const html = await this.fetchHtml(cleanUrl2, 1e4);
        if (!html) {
          return {
            page_type: "detail",
            content_type: "anime",
            title: "Anime LatAnime",
            description: "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "latanime.org",
            episodes: [],
            catalog_items: []
          };
        }
        const metadata = this.extractMetadata(html, cleanUrl2);
        const episodes = this.extractEpisodes(html, cleanUrl2);
        let detectedStreams;
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          const isEpisodePage = /\/ver\//.test(path7) || /\/ver\//.test(cleanUrl2);
          const target = isEpisodePage ? cleanUrl2 : episodes[0]?.url;
          if (target) {
            try {
              const streamResult = await this.extractStream(target);
              const mediaOnly = streamResult.all_available_streams.filter(
                (s) => !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(s)
              );
              if (mediaOnly.length > 0) detectedStreams = mediaOnly;
            } catch {
            }
          }
        }
        return {
          page_type: "detail",
          content_type: metadata.content_type,
          title: metadata.title,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: 7,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          source_domain: "latanime.org",
          detected_streams: detectedStreams,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
      /**
       * Extrae streams de video de una página de episodio:
       * 1. Busca elementos [data-player] y decodifica su Base64 -> URLs de iframe.
       * 2. Resuelve cada iframe con EmbedResolvers para obtener .m3u8/.mp4 directos.
       * 3. Retorna el primer stream directo exitoso y lista el resto.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        if (!html) {
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        const $ = cheerio7.load(html);
        const title = $('meta[property="og:title"]').attr("content")?.replace(/\s*[-–—]\s*Latanime\s*$/i, "").trim() || $("h2").filter((_, el) => /-\s*\d+\s*$/.test($(el).text())).first().text().replace(/\s*-\s*\d+\s*$/, "").trim() || $("h1").first().text().trim() || void 0;
        const iframeUrls = this.decodeDataPlayers(html);
        if (iframeUrls.length === 0) {
          const genericStreams = await super.extractStream(cleanUrl2);
          return { ...genericStreams, title };
        }
        const resolutions = await Promise.all(
          iframeUrls.map(async (iframeUrl) => {
            try {
              return { iframeUrl, resolved: await EmbedResolvers.resolve(iframeUrl) };
            } catch {
              return { iframeUrl, resolved: "" };
            }
          })
        );
        const all_available_streams = [];
        const directStreams = [];
        for (const { iframeUrl, resolved } of resolutions) {
          if (resolved && !isDeadOrBlocked2(resolved) && !all_available_streams.includes(resolved)) {
            all_available_streams.push(resolved);
          }
          const isDirectMedia2 = /\.(m3u8|mp4|webm)(\?|$)/i.test(resolved) && resolved !== iframeUrl;
          if (isDirectMedia2 && !isDeadOrBlocked2(resolved) && !directStreams.includes(resolved)) {
            directStreams.push(resolved);
          }
          if (!isDeadOrBlocked2(iframeUrl) && !all_available_streams.includes(iframeUrl)) {
            all_available_streams.push(iframeUrl);
          }
        }
        const finalStreams = directStreams.length > 0 ? [...directStreams, ...all_available_streams.filter((s) => !directStreams.includes(s))] : all_available_streams;
        return {
          stream_url: finalStreams[0] || cleanUrl2,
          all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl2],
          title
        };
      }
      titleFromSlug(url) {
        const match = url.match(/\/anime\/([^/]+)/);
        if (!match) return "Anime LatAnime";
        return match[1].replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
      }
    };
  }
});

// server/scrapers/adapters/TioAnimeAdapter.ts
var cheerio8, BASE_URL2, DEAD_HOST_PATTERNS, TioAnimeAdapter;
var init_TioAnimeAdapter = __esm({
  "server/scrapers/adapters/TioAnimeAdapter.ts"() {
    "use strict";
    cheerio8 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    init_validator();
    init_titleNormalizer();
    BASE_URL2 = "https://tioanime.com";
    DEAD_HOST_PATTERNS = [
      /cfglobalcdn\.com/i,
      /vidcache\.net/i,
      /v\.tioanime\.com\/embed\.php/i,
      /my\.mail\.ru\/video\/embed/i,
      /yourupload\.com/i,
      /streamtape\.com/i,
      /dsvplay\.com/i,
      /savefiles\.com/i,
      /d-s\.io/i,
      /a\d+\.mp4upload\.com/i
    ];
    TioAnimeAdapter = class extends BaseScraperAdapter {
      id = "tioanime";
      name = "TioAnime";
      supportedDomains = ["tioanime.com", "www.tioanime.com"];
      canHandle(url) {
        const lower = url.toLowerCase();
        return lower.includes("tioanime.com");
      }
      /**
       * Búsqueda de animes en tioanime.com
       * Intenta /directorio?q= , /?s= y fallback a /directorio con filtrado local
       */
      async search(query) {
        const q = query.trim();
        if (!q) return [];
        const candidates = [
          `${BASE_URL2}/directorio?q=${encodeURIComponent(q)}`,
          `${BASE_URL2}/?s=${encodeURIComponent(q)}`,
          `${BASE_URL2}/directorio?search=${encodeURIComponent(q)}`
        ];
        for (const url of candidates) {
          const html2 = await this.fetchHtml(url, 1e4);
          if (!html2) continue;
          const items = this.extractCatalogItems(html2);
          if (items.length > 0) {
            const lowerQ2 = q.toLowerCase();
            const filtered2 = items.filter((i) => i.title.toLowerCase().includes(lowerQ2));
            return filtered2.length > 0 ? filtered2 : items;
          }
        }
        const html = await this.fetchHtml(`${BASE_URL2}/directorio`, 1e4);
        if (!html) return [];
        const all = this.extractCatalogItems(html);
        if (all.length === 0) return [];
        const lowerQ = q.toLowerCase();
        const filtered = all.filter((i) => i.title.toLowerCase().includes(lowerQ));
        return filtered.length > 0 ? filtered : all.slice(0, 20);
      }
      /**
       * Extrae items de catálogo desde HTML.
       * Prioridad: <article>  (especificación estricta)
       */
      extractCatalogItems(html) {
        const $ = cheerio8.load(html);
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        $("article").each((_, el) => {
          const $article = $(el);
          let href = $article.find("a[href*='/anime/']").first().attr("href") || $article.find("a").first().attr("href") || $article.attr("href") || "";
          if (!href || seen.has(href)) return;
          const fullUrl = this.resolveRelativeUrl(href.trim(), BASE_URL2);
          if (!fullUrl || seen.has(fullUrl)) return;
          seen.add(fullUrl);
          seen.add(href);
          const $img = $article.find("img").first();
          const rawImg = $img.attr("data-src") || $img.attr("src") || "";
          const imageUrl = rawImg ? this.resolveRelativeUrl(rawImg.trim(), BASE_URL2) : null;
          const h3Title = $article.find("h3").first().text().trim();
          const titleAttr = ($article.attr("title") || "").trim();
          const altTitle = ($img.attr("alt") || "").trim();
          const anchorText = $article.find("a").first().text().trim();
          const title = h3Title || titleAttr || altTitle || anchorText || this.titleFromSlug(fullUrl);
          if (!title || title.length < 2) return;
          const lower = title.toLowerCase();
          if (["inicio", "home", "directorio", "dMCA", "contacto", "login"].some((b) => lower.includes(b.toLowerCase()))) {
            if (title.length < 15) return;
          }
          items.push({
            title: title.replace(/\s+/g, " ").trim(),
            url: fullUrl,
            image_url: imageUrl,
            kind: "anime"
          });
        });
        if (items.length === 0) {
          const fallbackSelectors = [
            "a[href*='/anime/']",
            ".anime-card a",
            ".card a",
            ".item a",
            "ul.ListAnimes a",
            ".list-animes a"
          ];
          for (const sel of fallbackSelectors) {
            $(sel).each((_, el) => {
              const href = $(el).attr("href");
              if (!href || seen.has(href)) return;
              const fullUrl = this.resolveRelativeUrl(href.trim(), BASE_URL2);
              if (seen.has(fullUrl)) return;
              seen.add(fullUrl);
              seen.add(href);
              const $link = $(el);
              const $img = $link.find("img").first();
              const rawImg = $img.attr("data-src") || $img.attr("src") || "";
              const imageUrl = rawImg ? this.resolveRelativeUrl(rawImg.trim(), BASE_URL2) : null;
              const title = $link.find("h3").first().text().trim() || ($img.attr("alt") || "").trim() || $link.text().trim() || $link.attr("title")?.trim() || this.titleFromSlug(fullUrl);
              if (!title) return;
              items.push({
                title: title.replace(/\s+/g, " ").trim(),
                url: fullUrl,
                image_url: imageUrl,
                kind: "anime"
              });
            });
            if (items.length > 0) break;
          }
        }
        return items;
      }
      /**
       * Metadatos de página de detalle usando OpenGraph y sinopsis
       */
      extractMetadata(html, url) {
        const $ = cheerio8.load(html);
        const animeInfoMatch = html.match(/var\s+anime_info\s*=\s*(\[.*?\]);/s);
        let jsTitle = "";
        if (animeInfoMatch) {
          try {
            const parsed = JSON.parse(animeInfoMatch[1].replace(/'/g, '"'));
            if (Array.isArray(parsed) && typeof parsed[2] === "string" && parsed[2].trim()) {
              jsTitle = parsed[2].trim();
            }
          } catch {
          }
        }
        const h1Title = $("h1.title, article.anime-single h1, h1").filter((_, el) => {
          const t = $(el).text().trim();
          return t.length > 0 && !/^(anime|tioanime|anime tioanime)$/i.test(t);
        }).first().text().trim();
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const cleanOg = ogTitle.replace(/\s*[-–—|•]\s*(?:TioAnime|Anime)\s*$/i, "").replace(/^Ver\s+/i, "").trim();
        const slugTitle = this.titleFromSlug(url);
        let title = "";
        if (jsTitle && isPlausibleTitle(jsTitle)) {
          title = jsTitle;
        } else if (h1Title && isPlausibleTitle(h1Title)) {
          title = h1Title;
        } else if (cleanOg && isPlausibleTitle(cleanOg)) {
          title = cleanOg;
        } else {
          title = cleanSlugToWords(slugTitle) || slugTitle;
        }
        let ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
        if (!ogImage) {
          const thumbImg = $(".thumb img").first().attr("src") || $("figure img").first().attr("src") || $("img").first().attr("src") || "";
          if (thumbImg) ogImage = thumbImg;
        }
        const poster_url = ogImage ? this.resolveRelativeUrl(ogImage.trim(), url) : void 0;
        const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
        const sinopsis = $("p.sinopsis").first().text().trim() || $(".sinopsis").first().text().trim() || $("p.description").first().text().trim() || $(".description").first().text().trim() || "";
        const description = sinopsis || ogDesc || "";
        const genres = [];
        $("a[href*='/genero/'], .genres a, .meta-genres a, p.genres a").each((_, el) => {
          const g = $(el).text().trim();
          if (g && !genres.includes(g)) genres.push(g);
        });
        let year = void 0;
        const yearCandidates = [
          html.match(/Año[\s:]*(\d{4})/i),
          html.match(/<span class="year">(\d{4})<\/span>/i),
          description.match(/\b(19|20)\d{2}\b/),
          html.match(/"year"\s*:\s*"?(\d{4})"?/i),
          html.match(/\b(19|20)\d{2}\b/)
        ];
        for (const m of yearCandidates) {
          if (m) {
            const candidate = m[0].match(/\b(19|20)\d{2}\b/)?.[0] || m[1];
            if (candidate) {
              const parsed = parseInt(candidate, 10);
              if (!isNaN(parsed) && parsed > 1900 && parsed < 2100) {
                year = parsed;
                break;
              }
            }
          }
        }
        if (year === null || year === void 0) year = null;
        return {
          title,
          description,
          poster_url,
          banner_url: poster_url,
          genres,
          // Defecto #16/#24: desconocido -> 0 (el enriquecimiento o el default de
          // showService deciden), nunca el año corriente.
          year: year && !isNaN(year) ? year : 0,
          content_type: "anime"
        };
      }
      /**
       * Lista de episodios: soporta JS `var anime_info` + `var episodes` (TioAnime) y fallback DOM
       * TioAnime inyecta: var anime_info = ["id","slug","Title"]; var episodes = [220,...,1];
       * URLs se generan como /ver/${slug}-${num}  (ej. /ver/naruto-1)
       */
      extractEpisodes(html, baseUrl) {
        const animeInfoMatch = html.match(/var\s+anime_info\s*=\s*(\[.*?\]);/s);
        const episodesMatch = html.match(/var\s+episodes\s*=\s*(\[.*?\]);/s);
        if (animeInfoMatch && episodesMatch) {
          try {
            const animeInfo = JSON.parse(animeInfoMatch[1].replace(/'/g, '"'));
            const episodesArr = JSON.parse(episodesMatch[1]);
            if (Array.isArray(animeInfo) && Array.isArray(episodesArr)) {
              const slug = typeof animeInfo[1] === "string" ? animeInfo[1] : "";
              const titleBase = typeof animeInfo[2] === "string" ? animeInfo[2] : "Episodio";
              if (slug && episodesArr.length > 0) {
                const episodes2 = [];
                const seenNums = /* @__PURE__ */ new Set();
                for (const raw of episodesArr) {
                  const num = Number(raw);
                  if (isNaN(num) || seenNums.has(num)) continue;
                  seenNums.add(num);
                  const url = this.resolveRelativeUrl(`/ver/${slug}-${num}`, baseUrl);
                  episodes2.push({
                    number: num,
                    title: `${titleBase} Episodio ${num}`,
                    url,
                    server_name: "TioAnime"
                  });
                }
                if (episodes2.length > 0) return episodes2.sort((a, b) => a.number - b.number);
              }
            }
          } catch {
          }
          try {
            const numsStr = episodesMatch[1];
            const nums = [...numsStr.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10));
            const slugMatch = animeInfoMatch[1].match(/"([^"]+)"/g);
            const slug = slugMatch && slugMatch[1] ? slugMatch[1].replace(/"/g, "") : "";
            if (nums.length > 0 && slug) {
              const episodes2 = nums.map((n) => ({
                number: n,
                title: `Episodio ${n}`,
                url: this.resolveRelativeUrl(`/ver/${slug}-${n}`, baseUrl),
                server_name: "TioAnime"
              }));
              if (episodes2.length > 0) return episodes2.sort((a, b) => a.number - b.number);
            }
          } catch {
          }
        }
        const $ = cheerio8.load(html);
        const episodes = [];
        const seen = /* @__PURE__ */ new Set();
        const selectors = [
          "a[href*='/ver/']",
          ".episodes a",
          ".episodes-list a",
          ".episode-list a",
          "ul.episodes li a",
          "li.episode a",
          ".capitulos-list a"
        ];
        for (const sel of selectors) {
          $(sel).each((_, el) => {
            const href = $(el).attr("href");
            if (!href || seen.has(href)) return;
            const fullUrl = this.resolveRelativeUrl(href.trim(), baseUrl);
            if (seen.has(fullUrl)) return;
            seen.add(href);
            seen.add(fullUrl);
            const linkText = $(el).text().replace(/\s+/g, " ").trim();
            const titleAttr = $(el).attr("title")?.trim() || "";
            let number = null;
            const urlNumMatch = fullUrl.match(/-episodio-(\d+)/i) || fullUrl.match(/-(\d+)(?:\/|$)/) || fullUrl.match(/\/(\d+)(?:\/|$)/);
            if (urlNumMatch) number = parseInt(urlNumMatch[1], 10);
            if (number === null) {
              const textNumMatch = (linkText || titleAttr).match(/(?:episodio|capitulo|cap\.?|ep\.?)\s*(\d+)/i);
              if (textNumMatch) number = parseInt(textNumMatch[1], 10);
            }
            if (number === null || isNaN(number)) {
              number = episodes.length + 1;
            }
            const textTitle = linkText || titleAttr || `Episodio ${number}`;
            const isAnimeLink = href.includes("/anime/");
            if (isAnimeLink && !/episodio|capitulo|\/ver\//i.test(href) && !/episodio|capitulo/i.test(linkText)) {
              return;
            }
            episodes.push({
              number,
              title: textTitle,
              url: fullUrl,
              server_name: "TioAnime"
            });
          });
        }
        if (episodes.length === 0) {
          $("a[href]").each((_, el) => {
            const href = $(el).attr("href") || "";
            if (!href || seen.has(href)) return;
            if (!/episodio|capitulo|\/ver\//i.test(href) && !/episodio|capitulo/i.test($(el).text())) return;
            const fullUrl = this.resolveRelativeUrl(href.trim(), baseUrl);
            if (seen.has(fullUrl)) return;
            seen.add(href);
            seen.add(fullUrl);
            const linkText = $(el).text().replace(/\s+/g, " ").trim();
            const numMatch = linkText.match(/(\d+)/) || href.match(/-(\d+)(?:\/|$)/) || href.match(/(\d+)/);
            const number = numMatch ? parseInt(numMatch[1], 10) : episodes.length + 1;
            episodes.push({
              number,
              title: linkText || `Episodio ${number}`,
              url: fullUrl,
              server_name: "TioAnime"
            });
          });
        }
        return episodes.sort((a, b) => a.number - b.number);
      }
      /**
       * Extrae el array global `var videos = [["Server","https://..."], ...]`
       * Maneja escaped slashes `\/` y comillas
       */
      extractVideosArray(html) {
        const streams = [];
        const regex = /var\s+videos\s*=\s*(\[[\s\S]*?\])\s*;/;
        const match = html.match(regex);
        if (match && match[1]) {
          let rawJson = match[1].trim();
          rawJson = rawJson.replace(/\\\//g, "/");
          try {
            const parsed = JSON.parse(rawJson);
            if (Array.isArray(parsed)) {
              for (const entry of parsed) {
                if (Array.isArray(entry) && entry.length >= 2) {
                  const url = entry[1];
                  if (typeof url === "string" && url.trim().startsWith("http")) {
                    const clean = url.replace(/\\/g, "").trim();
                    if (!streams.includes(clean)) streams.push(clean);
                  }
                } else if (typeof entry === "string" && entry.startsWith("http")) {
                  const clean = entry.replace(/\\/g, "").trim();
                  if (!streams.includes(clean)) streams.push(clean);
                }
              }
            }
            if (streams.length > 0) return streams;
          } catch {
          }
          const urlRegex = /https?:\/\/[^"'\s<>]+/g;
          const urlMatches = rawJson.match(urlRegex);
          if (urlMatches) {
            for (const m of urlMatches) {
              const clean = m.replace(/\\/g, "").replace(/["']+$/, "").trim();
              if (clean.startsWith("http") && !streams.includes(clean)) {
                streams.push(clean);
              }
            }
            if (streams.length > 0) return streams;
          }
          try {
            const singleToDouble = rawJson.replace(/'/g, '"');
            const parsed2 = JSON.parse(singleToDouble);
            if (Array.isArray(parsed2)) {
              for (const entry of parsed2) {
                if (Array.isArray(entry) && entry.length >= 2 && typeof entry[1] === "string") {
                  const clean = entry[1].replace(/\\/g, "").trim();
                  if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
                }
              }
            }
          } catch {
          }
        }
        if (streams.length === 0) {
          const altRegex = /videos\s*=\s*(\[[\s\S]*?\])\s*;/;
          const altMatch = html.match(altRegex);
          if (altMatch && altMatch[1]) {
            const urlRegex = /https?:\/\/[^"'\s<>]+/g;
            const urlMatches = altMatch[1].match(urlRegex);
            if (urlMatches) {
              for (const m of urlMatches) {
                const clean = m.replace(/\\/g, "").trim();
                if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
              }
            }
          }
        }
        return streams;
      }
      async analyze(input, explicitType) {
        const cleanUrl2 = input.trim();
        let path7 = "";
        try {
          const urlObj = new URL(cleanUrl2);
          path7 = urlObj.pathname.toLowerCase();
        } catch {
          if (explicitType === "catalog" || cleanUrl2.length < 100) {
            const catalogItems = await this.search(cleanUrl2);
            return {
              page_type: "catalog",
              content_type: "anime",
              title: `Resultados para "${cleanUrl2}" - TioAnime`,
              description: `B\xFAsqueda de ${catalogItems.length} animes en TioAnime para "${cleanUrl2}"`,
              poster_url: catalogItems[0]?.image_url || null,
              banner_url: catalogItems[0]?.image_url || null,
              rating: 0,
              year: 0,
              status: "Publicado",
              genres: [],
              source_domain: "tioanime.com",
              episodes: [],
              catalog_items: catalogItems
            };
          }
          return {
            page_type: "detail",
            content_type: "anime",
            title: this.titleFromSlug(cleanUrl2) || "Anime",
            description: "URL inv\xE1lida",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "tioanime.com",
            episodes: [],
            catalog_items: []
          };
        }
        if (explicitType === "catalog" || path7 === "/" || path7 === "/directorio" || path7 === "/directorio/" || /^\/(directorio|browse|letra|emision)?\/?$/.test(path7)) {
          const isCatalogRoot = path7 === "/" || path7 === "";
          let html2 = isCatalogRoot ? null : await this.fetchHtml(cleanUrl2, 1e4);
          if (!html2) html2 = await this.fetchHtml(`${BASE_URL2}/directorio`, 1e4);
          if (!html2) html2 = await this.fetchHtml(BASE_URL2, 1e4);
          if (!html2) throw new Error(`FETCH_FAILED: ${cleanUrl2}`);
          const catalogItems = this.extractCatalogItems(html2);
          return {
            page_type: "catalog",
            content_type: "anime",
            title: "Cat\xE1logo de Animes - TioAnime",
            description: `Cat\xE1logo completo de animes en TioAnime (${catalogItems.length} t\xEDtulos)`,
            poster_url: catalogItems[0]?.image_url || null,
            banner_url: catalogItems[0]?.image_url || null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "tioanime.com",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const html = await this.fetchHtml(cleanUrl2, 1e4);
        if (!html) {
          return {
            page_type: "detail",
            content_type: "anime",
            title: this.titleFromSlug(cleanUrl2) || "Anime",
            description: "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "tioanime.com",
            episodes: [],
            catalog_items: []
          };
        }
        if (this.isErrorPage(html)) {
          return {
            page_type: "detail",
            content_type: "anime",
            title: this.titleFromSlug(cleanUrl2) || "Anime",
            description: "Contenido no encontrado en TioAnime",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "No encontrado",
            genres: [],
            source_domain: "tioanime.com",
            episodes: [],
            catalog_items: [],
            detected_streams: void 0
          };
        }
        const metadata = this.extractMetadata(html, cleanUrl2);
        const episodes = this.extractEpisodes(html, cleanUrl2);
        let detectedStreams;
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          try {
            const first = episodes[0];
            const target = first ? first.url : cleanUrl2;
            const streamResult = await this.extractStream(target);
            detectedStreams = streamResult.all_available_streams;
          } catch {
          }
        }
        return {
          page_type: "detail",
          content_type: metadata.content_type,
          title: metadata.title,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: 7,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          source_domain: "tioanime.com",
          detected_streams: detectedStreams,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
      /**
       * Detecta la página de error de TioAnime. fetchHtml (BaseAdapter) devuelve el
       * body de respuestas 404 cuando parecen HTML completo (comportamiento necesario
       * para LaMovie/WordPress), así que aquí se filtra por los marcadores del template
       * de error: <title>Error 404 - TioAnime</title> y <h1 class="title">Ups... Prueba de nuevo</h1>.
       * El "404" solo se comprueba dentro del <title> para no dar falsos positivos
       * con episodios cuyo número sea 404.
       */
      isErrorPage(html) {
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const pageTitle = (titleMatch ? titleMatch[1] : "").toLowerCase();
        if (/error\s*404|no encontrado|ups\.?\.\.?\s*prueba de nuevo/.test(pageTitle)) return true;
        const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        const h1Text = (h1Match ? h1Match[1].replace(/<[^>]+>/g, " ") : "").toLowerCase();
        if (/ups/.test(h1Text) && /prueba de nuevo/.test(h1Text)) return true;
        return false;
      }
      isDeadHost(url) {
        return DEAD_HOST_PATTERNS.some((p) => p.test(url));
      }
      /**
       * Criterio estricto de media directa reproducible para E2E:
       * .m3u8/.mp4/.webm/.mkv (incluye variantes con ?/#) o lo que detecte
       * EmbedResolvers como directo, excluyendo placeholders del host
       * (Big Buck Bunny demo) y hosts muertos documentados.
       */
      isDirectMedia(url) {
        if (!url) return false;
        if (this.isDeadHost(url)) return false;
        if (EmbedResolvers.isPlaceholderUrl(url)) return false;
        if (EmbedResolvers.isDirectMediaUrl(url)) return true;
        return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url);
      }
      /**
       * Ordena streams priorizando media directa reproducible.
       * Mantiene orden relativo dentro de cada grupo (directos primero, embeds después).
       * Elimina placeholders y hosts muertos documentados que puedan colarse tras
       * EmbedResolvers.resolve (ej. hqq devuelve .m3u8 cfglobalcdn placeholder).
       * Respeta deduplicación previa.
       */
      orderDirectFirst(streams) {
        const alive = streams.filter((u) => !this.isDeadHost(u) && !EmbedResolvers.isPlaceholderUrl(u));
        const base = alive.length > 0 ? alive : streams.filter((u) => !EmbedResolvers.isPlaceholderUrl(u));
        const direct = base.filter((u) => this.isDirectMedia(u));
        const embed = base.filter((u) => !direct.includes(u));
        return [...direct, ...embed];
      }
      /**
       * Extrae streams de video de una página de episodio:
       * 1. Busca `var videos = [[...]]` y parsea JSON
       * 2. Resuelve cada URL con EmbedResolvers (VOE directo vía resolveVoeDirect + genérico)
       * 3. Valida con MediaValidator y ORDENA priorizando directo reproducible (.m3u8/.mp4/.webm/.mkv)
       *    por sobre embeds (mega.nz/embed etc.). El E2E exige media directa, nunca embed como stream_url.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        if (!html) {
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        if (this.isErrorPage(html)) {
          return { stream_url: "", all_available_streams: [] };
        }
        const $ = cheerio8.load(html);
        const title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content")?.replace(/\s*[-–—]\s*TioAnime\s*$/i, "").trim() || $("title").text().trim() || void 0;
        const videos = this.extractVideosArray(html);
        if (videos.length === 0) {
          const rawStreams = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl2);
          if (rawStreams.length === 0) {
            return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2], title };
          }
          const { resolved: resolved2, originals: originals2 } = await this.sanitizeAndResolve(rawStreams);
          const combined = [...resolved2, ...originals2];
          const withEmbedResolution2 = await Promise.all(
            combined.map(async (url) => {
              try {
                const r = await EmbedResolvers.resolve(url);
                return r || url;
              } catch {
                return url;
              }
            })
          );
          const merged2 = [];
          for (const url of withEmbedResolution2) {
            if (!merged2.includes(url)) merged2.push(url);
          }
          for (const url of combined) {
            if (!merged2.includes(url)) merged2.push(url);
          }
          const validated2 = await MediaValidator.validateUrls(merged2);
          const base2 = validated2.length > 0 ? validated2 : merged2;
          const ordered2 = this.orderDirectFirst(base2);
          return {
            stream_url: ordered2[0] || cleanUrl2,
            all_available_streams: ordered2.length > 0 ? ordered2 : [cleanUrl2],
            title
          };
        }
        const { resolved, originals } = await this.sanitizeAndResolve(videos);
        const allAvailable = [];
        for (const url of resolved) {
          if (!allAvailable.includes(url)) allAvailable.push(url);
        }
        for (const url of originals) {
          if (!allAvailable.includes(url)) allAvailable.push(url);
        }
        const withEmbedResolution = await Promise.all(
          allAvailable.map(async (url) => {
            try {
              const r = await EmbedResolvers.resolve(url);
              return r || url;
            } catch {
              return url;
            }
          })
        );
        const merged = [];
        for (const url of withEmbedResolution) {
          if (!merged.includes(url)) merged.push(url);
        }
        for (const url of allAvailable) {
          if (!merged.includes(url)) merged.push(url);
        }
        const validated = await MediaValidator.validateUrls(merged);
        const base = validated.length > 0 ? validated : merged;
        const ordered = this.orderDirectFirst(base);
        return {
          stream_url: ordered[0] || cleanUrl2,
          all_available_streams: ordered.length > 0 ? ordered : [cleanUrl2],
          title
        };
      }
      titleFromSlug(url) {
        try {
          const pathname = new URL(url).pathname;
          const parts = pathname.split("/").filter(Boolean);
          const slug = parts[parts.length - 1] || "anime";
          return slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
        } catch {
          const match = url.match(/\/([^/]+)\/?$/);
          if (!match) return "Anime";
          return match[1].replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
        }
      }
      /**
       * Decodificador del player VOE moderno. La página /e/{code} hace redirect JS a un
       * dominio rotativo cuyo HTML trae un <script type="application/json"> con el setup
       * del player ofuscado. Pipeline real extraído de su loader:
       *   rot13 -> reemplazar pares ['@$','^^','~@','%?','*~','!!','#&'] por '_'
       *         -> quitar '_' y concatenar -> base64 decode -> shift -3 por char
       *         -> reverse -> base64 decode -> JSON { source: "<master.m3u8 firmado>", ... }
       * El m3u8 resultante se reproduce nativo (sin iframe, sin publicidad del host).
       */
      async resolveVoeDirect(iframeUrl) {
        try {
          let html = await this.fetchHtml(iframeUrl, 8e3);
          if (!html) return null;
          if (!html.includes('type="application/json"')) {
            const redirectMatch = html.match(
              /window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i
            );
            if (redirectMatch && redirectMatch[1] !== iframeUrl) {
              html = await this.fetchHtml(redirectMatch[1], 8e3);
              if (!html) return null;
            }
          }
          const blobMatch = html.match(/type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
          if (!blobMatch) return null;
          const blob = blobMatch[1].trim();
          const rot13 = blob.replace(/[a-zA-Z]/g, (c) => {
            const base = c <= "Z" ? 65 : 97;
            return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
          });
          const PAIRS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
          let step2 = rot13;
          for (const pair of PAIRS) {
            step2 = step2.split(pair).join("_");
          }
          step2 = step2.split("_").join("");
          const b64decoded = Buffer.from(step2, "base64");
          let shifted = "";
          for (let i = 0; i < b64decoded.length; i++) {
            shifted += String.fromCharCode(b64decoded[i] - 3);
          }
          const reversed = shifted.split("").reverse().join("");
          const jsonStr = Buffer.from(reversed, "base64").toString("utf-8");
          const data = JSON.parse(jsonStr);
          if (typeof data.source === "string" && /\.m3u8(\?|$)/.test(data.source)) {
            return data.source;
          }
          if (typeof data.direct_access_url === "string" && /\.(m3u8|mp4)(\?|$)/.test(data.direct_access_url)) {
            return data.direct_access_url;
          }
          return null;
        } catch {
          return null;
        }
      }
      /**
       * Filtra hosts muertos documentados y resuelve VOE a stream directo.
       * Devuelve [streamsFiltradosYResueltos, embedsOriginalesConservados].
       */
      async sanitizeAndResolve(streams) {
        const alive = streams.filter((s) => !DEAD_HOST_PATTERNS.some((p) => p.test(s)));
        const deadRemoved = streams.length - alive.length;
        if (deadRemoved > 0) {
          console.log(`[TioAnime] ${deadRemoved} stream(s) descartado(s): host muerto documentado`);
        }
        const resolved = [];
        const originals = [];
        await Promise.all(
          alive.map(async (url) => {
            let finalUrl = url;
            if (/voe\./i.test(url)) {
              const voeDirect = await this.resolveVoeDirect(url);
              if (voeDirect) {
                console.log(`[TioAnime] VOE resuelto a HLS directo: ${voeDirect.slice(0, 80)}...`);
                finalUrl = voeDirect;
              }
            }
            if (!resolved.includes(finalUrl)) resolved.push(finalUrl);
            if (finalUrl !== url && !originals.includes(url)) {
              originals.push(url);
            }
          })
        );
        return { resolved, originals };
      }
    };
  }
});

// server/scrapers/adapters/TioPlusAdapter.ts
function cleanTitle(raw) {
  return raw.replace(/\s*[-–—]\s*TioPlus(\.net|\.app)?\s*$/i, "").replace(/^Ver\s+/i, "").replace(/\s+Online Gratis\b.*$/i, "").replace(/\s+/g, " ").trim();
}
var cheerio9, BASE_URL3, TioPlusAdapter;
var init_TioPlusAdapter = __esm({
  "server/scrapers/adapters/TioPlusAdapter.ts"() {
    "use strict";
    cheerio9 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    init_validator();
    BASE_URL3 = "https://tioplus.app";
    TioPlusAdapter = class _TioPlusAdapter extends BaseScraperAdapter {
      id = "tioplus";
      name = "TioPlus";
      supportedDomains = ["tioplus.app", "www.tioplus.app"];
      /**
       * Players SPA tipo "pelisplus" (strp2p/4meplayer/upns y sus rotaciones de dominio).
       * Verificado manualmente el 2026-08-21: son apps JS que cifran el token del
       * fragmento con WebCrypto contra su API interna (/api/v1/player?t=), responden
       * {"error":"Token is invalid"} a peticiones sin sesión JS, usan `restrictEmbed`
       * para bloquear iframes externos y detectan headless browsers. No resolubles
       * server-side ni reproducibles en el reproductor de la app -> se descartan.
       */
      static UNPLAYABLE_SPA_HOSTS = [
        "strp2p.com",
        "4meplayer.pro",
        "upns.pro"
      ];
      static DEAD_OR_BLOCKED_HOST_PATTERNS = [
        /cfglobalcdn\.com/i,
        /yourupload\.com/i,
        /streamtape\./i,
        /dsvplay\.com/i,
        /savefiles\.com/i,
        /d-s\.io/i,
        /a\d+\.mp4upload\.com/i,
        /vidcache\.net/i,
        /my\.mail\.ru/i,
        /v\.tioanime\.com/i
      ];
      canHandle(url) {
        const lower = url.toLowerCase();
        return lower.includes("tioplus.app");
      }
      /**
       * Detecta URLs de players SPA no reproducibles o hosts caídos.
       */
      isUnplayablePlayerUrl(url) {
        const lower = url.toLowerCase();
        if (_TioPlusAdapter.UNPLAYABLE_SPA_HOSTS.some((h) => lower.includes(h))) return true;
        if (_TioPlusAdapter.DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url))) return true;
        try {
          const u = new URL(url);
          return u.pathname === "/" && u.hash.length > 1;
        } catch {
          return false;
        }
      }
      /**
       * Búsqueda vía la API interna del sitio (`/api/search/{q}` devuelve HTML de articles).
       * Fallback: catálogo del Home filtrado localmente.
       */
      async search(query) {
        const q = query.trim();
        if (!q) return [];
        const html = await this.fetchHtml(`${BASE_URL3}/api/search/${encodeURIComponent(q)}`, 1e4);
        if (html) {
          const items = this.extractCatalogItems(html);
          if (items.length > 0) return items;
        }
        const homeHtml = await this.fetchHtml(BASE_URL3, 1e4);
        if (!homeHtml) return [];
        const all = this.extractCatalogItems(homeHtml);
        if (all.length === 0) return [];
        const lowerQ = q.toLowerCase();
        const filtered = all.filter((i) => i.title.toLowerCase().includes(lowerQ));
        return filtered.length > 0 ? filtered : all.slice(0, 20);
      }
      /**
       * Extrae items de catálogo desde HTML (Home, listados o resultados de la API de búsqueda).
       * Prioridad `<article>`; fallback `div.item`.
       */
      extractCatalogItems(html) {
        const $ = cheerio9.load(html);
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        const processCard = ($card) => {
          let $link = $card.find("a[href*='/pelicula/'], a[href*='/anime/'], a[href*='/serie/'], a[href*='/dorama/']").first();
          if ($link.length === 0) $link = $card.is("a") ? $card : $card.find("a").first();
          const href = ($link.attr("href") || "").trim();
          if (!href) return;
          const fullUrl = this.resolveRelativeUrl(href, BASE_URL3);
          if (!fullUrl || seen.has(fullUrl)) return;
          seen.add(fullUrl);
          const $img = $card.find("img").first();
          const rawImg = $img.attr("data-src") || $img.attr("src") || "";
          const imageUrl = rawImg && !rawImg.includes("placeholder") ? this.resolveRelativeUrl(rawImg.trim(), BASE_URL3) : null;
          const h2Title = $card.find("h2").first().text().trim();
          const altTitle = ($img.attr("alt") || "").trim();
          const title = h2Title || altTitle || this.titleFromSlug(fullUrl);
          if (!title || title.length < 2) return;
          const typeClass = ($card.find(".typeItem").attr("class") || "").toLowerCase();
          const kind = this.kindFromTypeItem(typeClass) || this.kindFromUrl(fullUrl);
          const yearMatch = title.match(/\((\d{4})\)\s*$/);
          const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
          items.push({
            title: title.replace(/\s+/g, " ").trim(),
            url: fullUrl,
            image_url: imageUrl,
            kind,
            year
          });
        };
        $("article").each((_, el) => processCard($(el)));
        if (items.length === 0) {
          $("div.item").each((_, el) => processCard($(el)));
        }
        return items;
      }
      /**
       * Metadatos de página de detalle: OpenGraph (og:title / og:image de image.tmdb.org),
       * descripción, géneros, año (/year/) y rating.
       */
      extractMetadata(html, url) {
        const $ = cheerio9.load(html);
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const h1Title = $("h1.slugh1").first().text().trim() || $("h1").first().text().trim();
        const cleanOgTitle = cleanTitle(ogTitle);
        const title = cleanOgTitle || h1Title || $("title").text().trim() || this.titleFromSlug(url);
        let ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
        if (!ogImage) {
          const bgStyle = $(".bg").first().attr("style") || "";
          const bgMatch = bgStyle.match(/url\(["']?([^"')]+)["']?\)/i);
          if (bgMatch) ogImage = bgMatch[1];
        }
        const poster_url = ogImage ? this.resolveRelativeUrl(ogImage.trim(), url) : void 0;
        const ogDesc = $('meta[property="og:description"]').attr("content") || "";
        const siteDesc = $(".description p").first().text().trim();
        const description = siteDesc || ogDesc.replace(/^Ver\s+.*Online Gratis.*$/i, "").trim();
        const genres = [];
        $(".genres a[href*='/genero/']").each((_, el) => {
          const g = $(el).text().trim();
          if (g && !genres.includes(g)) genres.push(g);
        });
        const yearMatch = html.match(/href="[^"]*\/year\/(\d{4})"/i)?.[1] || title.match(/\((\d{4})\)/)?.[1] || description.match(/\b(19|20)\d{2}\b/)?.[0] || url.match(/-(19\d{2}|20\d{2})(?:\/|$|\?)/i)?.[1];
        const year = yearMatch ? parseInt(yearMatch, 10) : 0;
        const ratingMatch = html.match(/Rating:\s*(?:<\/b>)?\s*([\d]+(?:[.,]\d+)?)/i);
        const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(",", ".")) : 0;
        return {
          title,
          description,
          poster_url,
          banner_url: poster_url,
          genres,
          year: isNaN(year) ? 0 : year,
          rating,
          content_type: this.kindFromUrl(url) || "series"
        };
      }
      /**
       * Lista completa de episodios:
       * 1. `var seasonsJson = {...}` (todas las temporadas, formato verificado)
       * 2. Fallback DOM: `#episodeList article.item a[href*="/season/"]`
       */
      extractEpisodes(html, baseUrl) {
        const jsonMatch = html.match(/var\s+seasonsJson\s*=\s*(\{[\s\S]*?\})\s*;/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed && typeof parsed === "object") {
              const episodes2 = [];
              const seenNums = /* @__PURE__ */ new Set();
              for (const seasonArr of Object.values(parsed)) {
                if (!Array.isArray(seasonArr)) continue;
                for (const ep of seasonArr) {
                  const season = Number(ep?.season);
                  const number = Number(ep?.episode);
                  if (isNaN(number) || isNaN(season)) continue;
                  const key = `${season}-${number}`;
                  if (seenNums.has(key)) continue;
                  seenNums.add(key);
                  episodes2.push({
                    number,
                    title: `${ep?.title || `Episodio ${number}`} (T${season})`,
                    url: this.buildEpisodeUrl(baseUrl, season, number),
                    source_type: "series",
                    server_name: "TioPlus"
                  });
                }
              }
              if (episodes2.length > 0) {
                return episodes2.sort((a, b) => a.number - b.number);
              }
            }
          } catch {
          }
        }
        const $ = cheerio9.load(html);
        const episodes = [];
        const seen = /* @__PURE__ */ new Set();
        $("#episodeList article a[href], article.item a[href]").each((_, el) => {
          const href = ($(el).attr("href") || "").trim();
          if (!href || !href.includes("/season/")) return;
          const fullUrl = this.resolveRelativeUrl(href, BASE_URL3);
          if (seen.has(fullUrl)) return;
          seen.add(fullUrl);
          const m = fullUrl.match(/\/season\/(\d+)\/episode\/(\d+)/i);
          const season = m ? parseInt(m[1], 10) : 1;
          const number = m ? parseInt(m[2], 10) : episodes.length + 1;
          const linkText = $(el).find("h2").first().text().replace(/\s+/g, " ").trim();
          episodes.push({
            number,
            title: linkText || `Episodio ${number} (T${season})`,
            url: fullUrl,
            server_name: "TioPlus"
          });
        });
        return episodes.sort((a, b) => a.number - b.number);
      }
      /**
       * CRÍTICO: decodifica los iframes ofuscados en Base64 de los botones de servidores.
       * Atributos soportados: data-video, data-server y data-tr (el sitio real usa los dos últimos).
       *
       * Casos verificados:
       * a) El valor decodifica directo a http(s) -> se usa tal cual.
       * b) El valor es Base64 opaco (ej. "cDI3Q2...") -> el reproductor real es
       *    `${BASE_URL}/player/${btoa(valor)}` (mecanismo de app.js); la página /player/
       *    contiene `window.location.href = '<embed>'` con el iframe real.
       */
      decodeDataVideos(html) {
        const $ = cheerio9.load(html);
        const candidates = [];
        const seen = /* @__PURE__ */ new Set();
        $("[data-video], [data-server], [data-tr]").each((_, el) => {
          const $el = $(el);
          const raw = $el.attr("data-video") || $el.attr("data-server") || $el.attr("data-tr") || "";
          const val = raw.trim();
          if (!val || seen.has(val)) return;
          seen.add(val);
          const decoded = this.decodeVideoValue(val);
          if (decoded && !candidates.includes(decoded)) candidates.push(decoded);
        });
        return candidates;
      }
      /**
       * Decodifica un valor individual de data-video/data-server/data-tr.
       * Devuelve URL directa (http) o URL del reproductor interno /player/{token}.
       */
      decodeVideoValue(val) {
        if (/^https?:\/\//i.test(val)) return val;
        let decoded = "";
        try {
          decoded = Buffer.from(val, "base64").toString("utf-8");
        } catch {
          return null;
        }
        if (/^https?:\/\//i.test(decoded)) return decoded;
        if (/^[A-Za-z0-9+/=]+$/.test(decoded) && decoded.length >= 16) {
          try {
            const decoded2 = Buffer.from(decoded, "base64").toString("utf-8");
            if (/^https?:\/\/[\x20-\x7E]+$/.test(decoded2)) return decoded2;
          } catch {
          }
        }
        if (/^[A-Za-z0-9+/=]{8,}$/.test(val)) {
          return `${BASE_URL3}/player/${Buffer.from(val, "binary").toString("base64")}`;
        }
        return null;
      }
      /**
       * Resuelve la página interna /player/{token} al embed real
       * (`window.location.href = 'https://...'` inyectado por su JS).
       */
      async resolvePlayerPage(playerUrl) {
        if (!playerUrl.includes("/player/")) return playerUrl;
        const html = await this.fetchHtml(playerUrl, 8e3);
        if (!html) return playerUrl;
        const m = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
        return m ? m[1] : playerUrl;
      }
      async analyze(input, explicitType) {
        const cleanUrl2 = input.trim();
        let path7 = "";
        try {
          path7 = new URL(cleanUrl2).pathname.toLowerCase();
        } catch {
          const catalogItems = await this.search(cleanUrl2);
          return {
            page_type: "catalog",
            content_type: "series",
            title: `Resultados para "${cleanUrl2}" - TioPlus`,
            description: `B\xFAsqueda de ${catalogItems.length} t\xEDtulos en TioPlus para "${cleanUrl2}"`,
            poster_url: catalogItems[0]?.image_url || null,
            banner_url: catalogItems[0]?.image_url || null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "tioplus.app",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const isCatalogPath = path7 === "/" || /^\/(peliculas|series|animes|doramas)(\/.*)?$/.test(path7) || path7.startsWith("/genero/") || path7.startsWith("/year/");
        if (explicitType === "catalog" || isCatalogPath) {
          const catalogUrl = this.resolveRelativeUrl(cleanUrl2, BASE_URL3);
          const html2 = await this.fetchHtml(catalogUrl, 1e4);
          if (!html2) throw new Error(`FETCH_FAILED: ${catalogUrl}`);
          const catalogItems = this.extractCatalogItems(html2);
          return {
            page_type: "catalog",
            content_type: "series",
            title: `Cat\xE1logo - TioPlus (${path7 === "/" ? "Inicio" : path7})`,
            description: `Cat\xE1logo de TioPlus (${catalogItems.length} t\xEDtulos)`,
            poster_url: catalogItems[0]?.image_url || null,
            banner_url: catalogItems[0]?.image_url || null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "tioplus.app",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const html = await this.fetchHtml(cleanUrl2, 1e4);
        if (!html) {
          return {
            page_type: "detail",
            content_type: this.kindFromUrl(cleanUrl2) || "series",
            title: "Contenido TioPlus",
            description: "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "tioplus.app",
            episodes: [],
            catalog_items: []
          };
        }
        const metadata = this.extractMetadata(html, cleanUrl2);
        const kind = this.kindFromUrl(cleanUrl2) || metadata.content_type;
        const episodes = kind === "movie" ? [] : this.extractEpisodes(html, cleanUrl2);
        let detectedStreams;
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          try {
            const streamResult = await this.extractStream(cleanUrl2);
            detectedStreams = streamResult.all_available_streams;
          } catch {
          }
        }
        return {
          page_type: "detail",
          content_type: kind,
          title: metadata.title,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: metadata.rating,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          source_domain: "tioplus.app",
          detected_streams: detectedStreams,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
      /**
       * Extrae streams de una página de episodio/película:
       * 1. decodeDataVideos -> candidatos (embeds directos o páginas /player/)
       * 2. Resolver páginas /player/ al embed real
       * 3. EmbedResolvers.resolve sobre cada embed
       * 4. MediaValidator.validateUrls y priorización de .m3u8/.mp4 directos
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        if (!html) {
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        const $ = cheerio9.load(html);
        const title = $("h1.slugh1").first().text().trim() || cleanTitle($('meta[property="og:title"]').attr("content") || "") || $("title").text().trim() || void 0;
        const candidates = this.decodeDataVideos(html);
        if (candidates.length === 0) {
          const genericStreams = await super.extractStream(cleanUrl2);
          return { ...genericStreams, title };
        }
        const playableCandidates = candidates.filter((c) => !this.isUnplayablePlayerUrl(c));
        if (playableCandidates.length === 0) {
          const genericStreams = await super.extractStream(cleanUrl2);
          return { ...genericStreams, title };
        }
        const embedUrls = await Promise.all(
          playableCandidates.map(async (c) => {
            try {
              return c.includes("/player/") ? await this.resolvePlayerPage(c) : c;
            } catch {
              return c;
            }
          })
        );
        const resolutions = await Promise.all(
          embedUrls.map(async (embedUrl) => {
            if (this.isUnplayablePlayerUrl(embedUrl)) return null;
            try {
              const resolved = await EmbedResolvers.resolve(embedUrl);
              return { embedUrl, resolved: resolved || embedUrl };
            } catch {
              return { embedUrl, resolved: embedUrl };
            }
          })
        );
        const usableResolutions = resolutions.filter(
          (r) => r !== null
        );
        const all_available_streams = [];
        for (const { embedUrl, resolved } of usableResolutions) {
          if (!all_available_streams.includes(resolved)) all_available_streams.push(resolved);
          if (resolved !== embedUrl && !all_available_streams.includes(embedUrl)) {
            all_available_streams.push(embedUrl);
          }
        }
        const validated = await MediaValidator.validateUrls(all_available_streams);
        const finalBase = validated.length > 0 ? validated.filter((s) => !this.isUnplayablePlayerUrl(s)) : all_available_streams.filter((s) => !this.isUnplayablePlayerUrl(s));
        const direct = finalBase.filter((s) => /\.(m3u8|mp4|webm)(\?|#|$)/i.test(s));
        let rankedDirect = direct;
        if (direct.length > 1) {
          try {
            rankedDirect = await this.rankDirectByProbe(direct);
          } catch {
            rankedDirect = direct;
          }
        }
        const ordered = rankedDirect.length > 0 ? [...rankedDirect, ...finalBase.filter((s) => !rankedDirect.includes(s))] : finalBase;
        return {
          stream_url: ordered[0] || cleanUrl2,
          all_available_streams: ordered.length > 0 ? ordered : [cleanUrl2],
          title
        };
      }
      /**
       * Probe barato de alcanzabilidad para ordenar directos.
       * HEAD (fallback GET Range) con timeout corto; no garantiza que
       * playlists/segmentos internos reproduzcan — solo evita priorizar
       * hosts muertos. La reproducción real la decide Chromium en E2E.
       */
      async rankDirectByProbe(direct) {
        const probe = await Promise.all(
          direct.map(async (url) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3500);
            try {
              let res = await fetch(url, {
                method: "HEAD",
                signal: controller.signal,
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                  Referer: `${BASE_URL3}/`
                }
              });
              if (res.status === 405 || res.status === 501) {
                res = await fetch(url, {
                  method: "GET",
                  signal: controller.signal,
                  headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    Referer: `${BASE_URL3}/`,
                    Range: "bytes=0-1"
                  }
                });
              }
              return { url, ok: res.ok };
            } catch {
              return { url, ok: false };
            } finally {
              clearTimeout(timer);
            }
          })
        );
        const reachable = probe.filter((r) => r.ok).map((r) => r.url);
        const unreachable = probe.filter((r) => !r.ok).map((r) => r.url);
        if (reachable.length === 0) return direct;
        return [...reachable, ...unreachable];
      }
      /** kind según span.typeItem del sitio: clases movie | anime | (serie) */
      kindFromTypeItem(typeClass) {
        if (typeClass.includes("movie")) return "movie";
        if (typeClass.includes("anime")) return "anime";
        if (typeClass.includes("serie") || typeClass.includes("dorama")) return "series";
        return null;
      }
      /** kind según la ruta: /pelicula/ -> movie, /anime/ -> anime, /serie/ -> series */
      kindFromUrl(url) {
        const lower = url.toLowerCase();
        if (lower.includes("/pelicula")) return "movie";
        if (lower.includes("/anime")) return "anime";
        if (lower.includes("/serie") || lower.includes("/dorama")) return "series";
        return null;
      }
      /** Construye URL de episodio respetando el prefijo /serie/ o /anime/ de la página actual */
      buildEpisodeUrl(baseUrl, season, episode) {
        try {
          const parts = new URL(baseUrl).pathname.split("/").filter(Boolean);
          const prefix = ["serie", "anime"].includes(parts[0]) ? parts[0] : "serie";
          const slug = parts[1] || "";
          return `${BASE_URL3}/${prefix}/${slug}/season/${season}/episode/${episode}`;
        } catch {
          return `${BASE_URL3}/serie/unknown/season/${season}/episode/${episode}`;
        }
      }
      titleFromSlug(url) {
        try {
          const parts = new URL(url).pathname.split("/").filter(Boolean);
          const slug = parts[1] || parts[0] || "titulo";
          return slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
        } catch {
          return "TioPlus";
        }
      }
    };
  }
});

// server/scrapers/adapters/CinecalidadAdapter.ts
var cheerio10, BASE_URL4, CinecalidadAdapter;
var init_CinecalidadAdapter = __esm({
  "server/scrapers/adapters/CinecalidadAdapter.ts"() {
    "use strict";
    cheerio10 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    init_vimeosResolver();
    init_validator();
    BASE_URL4 = "https://www.cinecalidad.am";
    CinecalidadAdapter = class _CinecalidadAdapter extends BaseScraperAdapter {
      id = "cinecalidad";
      name = "Cinecalidad";
      supportedDomains = ["cinecalidad.am", "www.cinecalidad.am", "cinecalidad.mx", "cinecalidad.im"];
      canHandle(url) {
        const lower = url.toLowerCase();
        return lower.includes("cinecalidad");
      }
      /**
       * Búsqueda de películas y series (?s=query). Usa la misma estructura de cards del Home.
       */
      async search(query) {
        const searchUrl = `${BASE_URL4}/?s=${encodeURIComponent(query.trim())}`;
        const html = await this.fetchHtml(searchUrl, 1e4);
        if (!html) return [];
        return this.extractCatalogItems(html);
      }
      /**
       * Extrae items del Home o resultados de búsqueda.
       * Imagen: prioriza data-src (TMDb) sobre src (placeholder base64).
       * Excluye las tarjetas publicitarias (enlaces con ancla #hash o dominios externos).
       */
      extractCatalogItems(html) {
        const $ = cheerio10.load(html);
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        const isFicha = (u) => /\/(?:ver-)?(?:pelicula|serie)\//i.test(u);
        const buildItem = ($el) => {
          const isAnchor = $el.is("a");
          const $link = isAnchor ? $el : $el.find('a[href*="/ver-pelicula/"], a[href*="/ver-serie/"], a[href*="/pelicula/"], a[href*="/serie/"]').first();
          const href = ($link.attr("href") || "").trim();
          if (!href) return;
          const url = this.resolveRelativeUrl(href, BASE_URL4);
          if (!url || seen.has(url) || !isFicha(url)) return;
          seen.add(url);
          const $img = $el.find("img").first();
          const dataSrc = ($img.attr("data-src") || "").trim();
          const src = ($img.attr("src") || "").trim();
          const rawImg = /^https?:\/\//i.test(dataSrc) ? dataSrc : /^https?:\/\//i.test(src) ? src : "";
          const image_url = rawImg ? this.resolveRelativeUrl(rawImg, BASE_URL4) : null;
          const title = $el.find(".in_title").first().text().trim() || ($img.attr("alt") || "").trim() || this.titleFromUrl(url);
          let year = null;
          $el.find(".home_post_content p").each((_, p) => {
            if (year !== null) return;
            const t = $(p).text().trim();
            if (/^(19|20)\d{2}$/.test(t)) year = parseInt(t, 10);
          });
          const ratingText = $el.find(".rating").first().text().trim().replace(",", ".");
          const ratingVal = parseFloat(ratingText);
          const rating = isNaN(ratingVal) ? null : ratingVal;
          const genres = [];
          $el.find(".home_post_cat a").each((_, g) => {
            const genre = $(g).text().trim();
            if (genre && !genres.includes(genre)) genres.push(genre);
          });
          items.push({
            title,
            url,
            image_url,
            kind: this.kindFromUrl(url),
            year,
            rating,
            genres
          });
        };
        $("article.item, article").each((_, el) => buildItem($(el)));
        if (items.length === 0) {
          $("a[href*='/ver-pelicula/'], a[href*='/ver-serie/'], a[href*='/pelicula/'], a[href*='/serie/']").each((_, el) => buildItem($(el)));
        }
        return items;
      }
      /**
       * Metadatos de una página de detalle: OpenGraph + poster img[data-src].
       * Nota verificada: el detalle NO expone og:image; el poster vive en un <img data-src> TMDb.
       */
      extractMetadata(html, url) {
        const $ = cheerio10.load(html);
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const h1Title = $("h1").filter((_, el) => {
          const t = $(el).text().trim();
          return t.length > 0 && !/^cinecalidad$/i.test(t);
        }).first().text().trim();
        const title = this.cleanTitle(ogTitle) || h1Title || "Contenido Cinecalidad";
        const description = $('meta[property="og:description"]').attr("content") || $(".custom_synop").first().text().trim() || "";
        const dataSrcPoster = $("img[data-src]").map((_, el) => ($(el).attr("data-src") || "").trim()).get().find((s) => /^https?:\/\//i.test(s));
        const srcPoster = $("img[src]").map((_, el) => ($(el).attr("src") || "").trim()).get().find((s) => /^https?:\/\//i.test(s));
        const ogImage = $('meta[property="og:image"]').attr("content");
        const posterRaw = dataSrcPoster || ogImage || srcPoster || "";
        const poster_url = posterRaw ? this.resolveRelativeUrl(posterRaw, url) : void 0;
        const genres = [];
        $('a[href*="/genero-de-la-pelicula/"]').each((_, g) => {
          const genre = $(g).text().trim();
          if (genre && !genres.includes(genre)) genres.push(genre);
        });
        const ratingMatch = html.match(/class="rating">\s*([\d.,]+)\s*</i) || html.match(/IMDb[\s:]*([\d.]+)/i);
        const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(",", ".")) : 0;
        const yearMatch = html.match(/A\u00f1o[\s:]*((?:19|20)\d{2})/i) || title.match(/((?:19|20)\d{2})/) || description.match(/((?:19|20)\d{2})/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : 0;
        const originalTitle = $("span").filter((_, el) => /Títulos:/i.test($(el).text())).first().text().replace(/^\s*Títulos:\s*/i, "").trim();
        const tmdbMatch = html.match(/videoapp\.zip\/e\/(?:movie|tv)\/(\d+)/i);
        const durationMatch = html.match(/(\d+\s*min(?:utos)?)/i);
        return {
          title,
          description,
          poster_url,
          banner_url: poster_url,
          rating,
          year,
          original_title: originalTitle || void 0,
          tmdb_id: tmdbMatch ? parseInt(tmdbMatch[1], 10) : void 0,
          genres,
          duration: durationMatch ? durationMatch[1] : null,
          content_type: this.kindFromUrl(url)
        };
      }
      /**
       * Episodios de una serie: ul.episodios li con .numerando ("S1-E1") y
       * .episodiotitle a[href*="/ver-el-episodio/"]. Número desde numerando o URL SxE.
       */
      extractEpisodes(html, baseUrl) {
        const $ = cheerio10.load(html);
        const episodes = [];
        const seen = /* @__PURE__ */ new Set();
        $("ul.episodios li").each((_, li) => {
          const $li = $(li);
          const $a = $li.find('a[href*="/ver-el-episodio/"]').first();
          const href = $a.attr("href");
          if (!href || seen.has(href)) return;
          seen.add(href);
          const fullUrl = this.resolveRelativeUrl(href, baseUrl);
          const numerando = $li.find(".numerando").first().text().trim();
          const numMatch = numerando.match(/E\s*(\d+)/i) || fullUrl.match(/-(\d+)x(\d+)\/?$/);
          const number = numMatch ? parseInt(numMatch[numMatch.length - 1], 10) : episodes.length + 1;
          const linkText = $a.text().replace(/\s+/g, " ").trim();
          episodes.push({
            number,
            title: linkText || `Episodio ${number}`,
            url: fullUrl,
            source_type: this.id,
            server_name: "Cinecalidad"
          });
        });
        return episodes.sort((a, b) => a.number - b.number);
      }
      /**
       * Técnica crítica: extrae la parte posterior al "#" de los href tipo "#aHR0c..."
       * y la decodifica en Base64 para obtener el enlace directo al reproductor,
       * saltándose la inyección JS de #dooplay_player_response.
       */
      decodeHashLinks(html) {
        const links = [];
        const regex = /#([A-Za-z0-9+/=]{16,})/g;
        let match;
        while ((match = regex.exec(html)) !== null) {
          try {
            const decoded = Buffer.from(match[1], "base64").toString("utf-8").trim();
            if (/^https?:\/\//i.test(decoded) && !links.includes(decoded)) {
              links.push(decoded);
            }
          } catch {
          }
        }
        return links;
      }
      /**
       * Reproductores dooplay: li[data-option] con URLs directas (excluye trailers de YouTube).
       */
      extractPlayerOptions(html, baseUrl) {
        const $ = cheerio10.load(html);
        const options = [];
        $("[data-option]").each((_, el) => {
          const val = ($(el).attr("data-option") || "").trim();
          if (!val) return;
          let candidate = this.resolveRelativeUrl(val, baseUrl);
          try {
            const encoded = new URL(candidate).searchParams.get("zopass");
            if (encoded) candidate = Buffer.from(encoded, "base64").toString("utf8").trim();
          } catch {
          }
          if (!/^https?:\/\//i.test(candidate) || /youtube\.com|youtu\.be/i.test(candidate)) return;
          if (!options.includes(candidate)) options.push(candidate);
        });
        return options;
      }
      /**
       * Embeds del reproductor: iframes del DOM (incluye `data-src`/`data-player`,
       * que el DOM actual de dooplay usa en lugar de `src` directo).
       */
      extractIframeEmbeds(html, baseUrl) {
        const $ = cheerio10.load(html);
        const out = [];
        $("iframe").each((_, el) => {
          const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-player") || $(el).attr("data-url") || $(el).attr("data-lazy-src") || "";
          if (!src) return;
          const resolved = this.resolveRelativeUrl(src, baseUrl);
          if (/^https?:\/\//i.test(resolved) && !/youtube\.com|youtu\.be/i.test(resolved) && !this.isJunkUrl(resolved) && !out.includes(resolved)) {
            out.push(resolved);
          }
        });
        return out;
      }
      /**
       * Servidores dooplay: cada `li[data-post][data-nume][data-type]` es un servidor
       * cuyo `embed_url` (Fembed, Mega, Uqload, etc.) se obtiene vía POST al AJAX de
       * dooplay (admin-ajax.php?action=doo_player_ajax). Salta la inyección JS que el
       * DOM actual ya no expone en el HTML estático.
       */
      async extractDooplayServerEmbeds(pageUrl, html) {
        const $ = cheerio10.load(html);
        const servers = [];
        $("li[data-post]").each((_, el) => {
          const $li = $(el);
          const post = ($li.attr("data-post") || "").trim();
          if (!post) return;
          const type = ($li.attr("data-type") || (this.kindFromUrl(pageUrl) === "series" ? "tv" : "movie")).trim();
          const nume = ($li.attr("data-nume") || "1").trim();
          servers.push({ post, type, nume });
        });
        if (servers.length === 0) return [];
        const nonce = ($("[data-nonce]").first().attr("data-nonce") || "").trim();
        const ajaxUrl = this.resolveRelativeUrl("/wp-admin/admin-ajax.php", pageUrl);
        const embeds = [];
        for (const s of servers.slice(0, 3)) {
          try {
            const body = `action=doo_player_ajax&post=${encodeURIComponent(s.post)}&type=${encodeURIComponent(s.type)}&nume=${encodeURIComponent(s.nume)}` + (nonce ? `&nonce=${encodeURIComponent(nonce)}` : "");
            const res = await fetch(ajaxUrl, {
              method: "POST",
              headers: {
                "User-Agent": COMMON_HEADERS["User-Agent"],
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                Referer: pageUrl
              },
              body
            });
            if (!res.ok) continue;
            const text = await res.text();
            let embed = "";
            try {
              const json = JSON.parse(text);
              embed = json.embed_url || json.embed || json.url || "";
            } catch {
              const m = text.match(/https?:\/\/[^\s"'<>\\]+/i);
              if (m) embed = m[0];
            }
            embed = (embed || "").trim();
            if (/^https?:\/\//i.test(embed) && !this.isJunkUrl(embed) && !embeds.includes(embed)) {
              embeds.push(embed);
            }
          } catch {
          }
        }
        return embeds;
      }
      /**
       * Scan directo del HTML por URLs de servidores soportados (Fembed, Mega, Uqload,
       * MP4Upload, Dood, etc.) que el DOM actual embebe en atributos/data-URLs.
       */
      extractKnownServerUrls(html) {
        const out = [];
        const regex = /https?:\/\/(?:www\.)?(?:[a-z0-9.-]+\.)?(?:fembed[0-9]*\.[a-z]+|feurl\.com|fembed\.flix?|mega\.nz|uqload\.[a-z]+|mp4upload\.com|dood\.[a-z]+|doodstream\.[a-z]+|ds2play\.com|d000d\.com|streamwish\.[a-z]+|vidmoly\.[a-z]+|upstream\.[a-z]+|gamovideo\.[a-z]+|netu\.[a-z]+|streamlare\.[a-z]+|fastre\.[a-z]+|ok\.ru|vimeos\.[a-z]+|byselapuix\.com|zilla-networks\.com|yourupload\.com|streamtape\.com)\/[^\s"'<>\\]+/gi;
        const matches = html.match(regex);
        if (matches) {
          for (const m of matches) {
            const clean = m.replace(/\\/g, "").replace(/["']/g, "").trim();
            if (/^https?:\/\//i.test(clean) && !this.isJunkUrl(clean) && !out.includes(clean)) {
              out.push(clean);
            }
          }
        }
        return out;
      }
      async analyze(input, explicitType) {
        const cleanInput = input.trim();
        if (!/^https?:\/\//i.test(cleanInput)) {
          const catalogItems = await this.search(cleanInput);
          return {
            page_type: "catalog",
            content_type: "movie",
            title: `B\xFAsqueda "${cleanInput}" - Cinecalidad`,
            description: `Resultados para "${cleanInput}" (${catalogItems.length} t\xEDtulos)`,
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "cinecalidad.am",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const path7 = new URL(cleanInput).pathname.toLowerCase();
        const isCatalog = explicitType === "catalog" || path7 === "/" || path7 === "" || /^\/page\/\d+/.test(path7);
        if (isCatalog) {
          let html2 = await this.fetchHtml(cleanInput, 1e4);
          if (!html2 && path7 !== "/" && path7 !== "") {
            html2 = await this.fetchHtml(`${BASE_URL4}/`, 1e4);
          }
          if (!html2) throw new Error(`FETCH_FAILED: ${cleanInput}`);
          const catalogItems = this.extractCatalogItems(html2);
          return {
            page_type: "catalog",
            content_type: "movie",
            title: "Cat\xE1logo de Pel\xEDculas y Series - Cinecalidad",
            description: `Cat\xE1logo completo en Cinecalidad (${catalogItems.length} t\xEDtulos)`,
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "cinecalidad.am",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const contentType = this.kindFromUrl(cleanInput);
        const html = await this.fetchHtml(cleanInput, 1e4);
        if (!html) {
          return {
            page_type: "detail",
            content_type: contentType,
            title: "Contenido Cinecalidad",
            description: "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "cinecalidad.am",
            episodes: [],
            catalog_items: []
          };
        }
        const metadata = this.extractMetadata(html, cleanInput);
        let episodes = contentType === "series" ? this.extractEpisodes(html, cleanInput) : [];
        if (episodes.length === 0 && contentType === "movie") {
          episodes = [
            {
              number: 1,
              title: metadata.title || "Pel\xEDcula",
              url: cleanInput,
              source_type: this.id,
              server_name: "Cinecalidad"
            }
          ];
        }
        let detectedStreams;
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          try {
            detectedStreams = (await this.extractStream(cleanInput)).all_available_streams;
          } catch {
          }
        }
        return {
          page_type: "detail",
          content_type: metadata.content_type,
          title: metadata.title,
          original_title: metadata.original_title,
          tmdb_id: metadata.tmdb_id,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: metadata.rating,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          duration: metadata.duration || null,
          source_domain: "cinecalidad.am",
          detected_streams: detectedStreams,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
      /**
       * Extrae streams de una página de película/episodio combinando varias fuentes
       * ordenadas por robustez (ver documentación de clase). Cada candidato se resuelve
       * con EmbedResolvers y se valida con MediaValidator.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        if (!html) {
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        const $ = cheerio10.load(html);
        const title = this.cleanTitle($('meta[property="og:title"]').attr("content") || "") || void 0;
        const hashLinks = this.decodeHashLinks(html);
        const dooplayEmbeds = await this.extractDooplayServerEmbeds(cleanUrl2, html);
        const iframeEmbeds = this.extractIframeEmbeds(html, cleanUrl2);
        const serverUrls = this.extractKnownServerUrls(html);
        const playerOptions = this.extractPlayerOptions(html, cleanUrl2);
        const rawCandidates = [];
        [...hashLinks, ...dooplayEmbeds, ...iframeEmbeds, ...serverUrls, ...playerOptions].filter((u) => u && /^https?:\/\//i.test(u) && !this.isJunkUrl(u)).forEach((u) => {
          if (!rawCandidates.includes(u)) rawCandidates.push(u);
        });
        const candidates = await VimeosResolver.fixVimeosStreams(rawCandidates);
        if (candidates.length === 0) {
          const generic = await super.extractStream(cleanUrl2);
          const cleanStreams = generic.all_available_streams.filter((u) => !this.isJunkUrl(u));
          const genericStreamUrl = cleanStreams.includes(generic.stream_url) ? generic.stream_url : cleanStreams[0] || cleanUrl2;
          return {
            stream_url: genericStreamUrl,
            all_available_streams: cleanStreams.length > 0 ? cleanStreams : [cleanUrl2],
            title
          };
        }
        const resolutions = await Promise.all(
          candidates.map(async (candidate) => {
            try {
              return { candidate, resolved: await EmbedResolvers.resolve(candidate) };
            } catch {
              return { candidate, resolved: "" };
            }
          })
        );
        const rawResolvedList = [];
        for (const { candidate, resolved } of resolutions) {
          if (resolved && !rawResolvedList.includes(resolved)) rawResolvedList.push(resolved);
          if (!rawResolvedList.includes(candidate)) rawResolvedList.push(candidate);
        }
        const resolvedList = await VimeosResolver.fixVimeosStreams(rawResolvedList);
        const validated = await MediaValidator.validateUrls(resolvedList);
        const usableValidated = validated.filter((u) => !this.isJunkUrl(u));
        const directMedia = usableValidated.filter((u) => /\.(m3u8|mp4|webm)(\?|$)/i.test(u));
        const validatedEmbeds = usableValidated.filter((u) => !directMedia.includes(u));
        let finalStreams;
        if (directMedia.length > 0) {
          finalStreams = [
            ...directMedia,
            ...validatedEmbeds,
            ...resolvedList.filter((u) => !usableValidated.includes(u) && !this.isJunkUrl(u))
          ];
        } else if (validatedEmbeds.length > 0) {
          finalStreams = [
            ...validatedEmbeds,
            ...resolvedList.filter((u) => !usableValidated.includes(u) && !this.isJunkUrl(u))
          ];
        } else {
          finalStreams = resolvedList.filter((u) => !this.isJunkUrl(u));
        }
        finalStreams = Array.from(new Set(finalStreams)).filter((u) => /^https?:\/\//i.test(u));
        return {
          stream_url: finalStreams[0] || cleanUrl2,
          all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl2],
          title
        };
      }
      kindFromUrl(url) {
        return /\/ver-(?:serie|el-episodio)\//i.test(url) ? "series" : "movie";
      }
      static DEAD_OR_BLOCKED_HOST_PATTERNS = [
        /cfglobalcdn\.com/i,
        /yourupload\.com/i,
        /streamtape\./i,
        /dsvplay\.com/i,
        /savefiles\.com/i,
        /d-s\.io/i,
        /a\d+\.mp4upload\.com/i,
        /vidcache\.net/i,
        /my\.mail\.ru/i,
        /v\.tioanime\.com/i
      ];
      /**
       * Filtra URLs basura que el fallback genérico puede arrastrar:
       * imágenes TMDb (lazy-load data-src), banners publicitarios, estáticos y hosts muertos.
       */
      isJunkUrl(url) {
        return /image\.tmdb\.org|adsanalytics\.org|\.(jpe?g|png|gif|webp|svg|css|js)(\?|$)/i.test(url) || _CinecalidadAdapter.DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));
      }
      cleanTitle(raw) {
        return raw.replace(/\s*[-–—|]\s*Cinecalidad.*$/i, "").replace(/^ver\b(?:\s+online)?(?:\s+gratis)?\s*/i, "").trim();
      }
      titleFromUrl(url) {
        const match = url.match(/\/ver-(?:pelicula|serie|el-episodio)\/([^/]+)/);
        if (!match) return "Contenido Cinecalidad";
        return match[1].replace(/-\d+x\d+\/?$/, "").replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
      }
    };
  }
});

// server/scrapers/hostHealth.ts
function hostKeyOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
function getRecord(url) {
  const key = hostKeyOf(url);
  let record = hostRecords.get(key);
  if (!record) {
    record = {
      state: "unknown",
      consecutiveFailures: 0,
      latencySamples: [],
      playbackAttempts: 0,
      playbackSuccesses: 0
    };
    hostRecords.set(key, record);
  }
  return record;
}
function getHostSemaphore(url) {
  const key = hostKeyOf(url);
  let semaphore = hostSemaphores.get(key);
  if (!semaphore) {
    semaphore = new Semaphore(MAX_PROBES_PER_HOST);
    hostSemaphores.set(key, semaphore);
  }
  return semaphore;
}
function pruneExpired(now) {
  if (hostRecords.size < 500 && negativeCache.size < 500) return;
  for (const [key, rec] of hostRecords) {
    if (rec.lastFailedAt !== void 0 && now - rec.lastFailedAt > NEGATIVE_CACHE_TTL_MS) hostRecords.delete(key);
  }
  for (const [key, until] of negativeCache) {
    if (until <= now) negativeCache.delete(key);
  }
}
function ewma(previous, sample, alpha = 0.25) {
  return previous === void 0 ? sample : previous * (1 - alpha) + sample * alpha;
}
function recordLatency(record, latencyMs) {
  record.ewmaLatencyMs = ewma(record.ewmaLatencyMs, latencyMs);
  record.latencySamples.push(latencyMs);
  if (record.latencySamples.length > 40) record.latencySamples.shift();
}
function percentile(values, fraction) {
  if (values.length === 0) return void 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
function adaptiveTimeout(url, opts, profileTimeout) {
  const record = getRecord(url);
  const configured = opts.timeoutMs ?? profileTimeout ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (opts.timeoutMs !== void 0) return Math.max(1, Math.min(MAX_ADAPTIVE_TIMEOUT_MS, opts.timeoutMs));
  const p95 = percentile(record.latencySamples, 0.95);
  const observed = Math.max(record.ewmaLatencyMs ?? 0, (p95 ?? 0) * 1.5);
  return Math.min(MAX_ADAPTIVE_TIMEOUT_MS, Math.max(MIN_ADAPTIVE_TIMEOUT_MS, configured, observed));
}
function reasonForStatus(status) {
  if (status === 401) return "auth_expired";
  if (status === 403) return "auth_rejected";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "probe_error";
}
function isSuccessfulStatus(status) {
  return status >= 200 && status < 400;
}
function resultForFailure(url, status, reason, error, latencyMs, fromCache = false) {
  const record = getRecord(url);
  if (reason === "auth_expired" || reason === "auth_rejected") {
    record.state = "degraded";
    record.reason = reason;
    record.lastCheckedAt = Date.now();
    return { url, ok: false, state: "degraded", status, reason, error, latencyMs, fromCache };
  }
  markHostFailed(url, NEGATIVE_CACHE_TTL_MS, reason);
  const current = getRecord(url);
  return {
    url,
    ok: false,
    state: current.state,
    status,
    reason: current.reason ?? reason,
    error,
    latencyMs,
    fromCache
  };
}
function resultForSuccess(url, status, latencyMs) {
  markHostHealthy(url);
  const record = getRecord(url);
  record.lastCheckedAt = Date.now();
  record.reason = void 0;
  record.state = "online";
  record.consecutiveFailures = 0;
  record.circuitOpenUntil = void 0;
  recordLatency(record, latencyMs);
  return { url, ok: true, state: "online", status, latencyMs };
}
function isHostBlacklisted(url) {
  const key = hostKeyOf(url);
  const until = negativeCache.get(key);
  if (until === void 0) return false;
  if (Date.now() >= until) {
    negativeCache.delete(key);
    const record = getRecord(url);
    record.state = "checking";
    record.circuitOpenUntil = void 0;
    return false;
  }
  return true;
}
function markHostFailed(url, ttlMs = NEGATIVE_CACHE_TTL_MS, reason = "network_error") {
  if (reason === "auth_expired" || reason === "auth_rejected") return;
  const key = hostKeyOf(url);
  const now = Date.now();
  const record = getRecord(url);
  const withinWindow = record.lastFailedAt !== void 0 && now - record.lastFailedAt <= NEGATIVE_CACHE_TTL_MS;
  record.consecutiveFailures = withinWindow ? record.consecutiveFailures + 1 : 1;
  record.lastFailedAt = now;
  record.lastCheckedAt = now;
  record.reason = reason;
  record.state = record.consecutiveFailures >= FAILURE_THRESHOLD ? "offline" : "degraded";
  if (record.consecutiveFailures >= FAILURE_THRESHOLD) {
    const until = now + ttlMs;
    negativeCache.set(key, until);
    record.circuitOpenUntil = until;
  }
  pruneExpired(now);
}
function markHostHealthy(url) {
  const key = hostKeyOf(url);
  const record = getRecord(url);
  record.consecutiveFailures = 0;
  record.state = "online";
  record.reason = void 0;
  record.circuitOpenUntil = void 0;
  record.lastFailedAt = void 0;
  record.lastCheckedAt = Date.now();
  negativeCache.delete(key);
}
function getHostHealth(url) {
  const key = hostKeyOf(url);
  const record = getRecord(url);
  return {
    host: key,
    state: record.state,
    reason: record.reason,
    consecutiveFailures: record.consecutiveFailures,
    ewmaLatencyMs: record.ewmaLatencyMs,
    p95LatencyMs: percentile(record.latencySamples, 0.95),
    playbackAttempts: record.playbackAttempts,
    playbackSuccesses: record.playbackSuccesses,
    lastCheckedAt: record.lastCheckedAt,
    circuitOpenUntil: record.circuitOpenUntil
  };
}
async function readPrefix(response, maxBytes = 16 * 1024) {
  if (!response.body) {
    if (typeof response.text === "function") return (await response.text()).slice(0, maxBytes);
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      const remaining = maxBytes - total;
      chunks.push(value.slice(0, remaining));
      total += Math.min(value.byteLength, remaining);
      if (value.byteLength >= remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
function isPlayableHlsManifest(prefix) {
  if (!prefix.includes("#EXTM3U")) return false;
  return /#EXTINF\s*:|#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA|PLAYLIST-TYPE|MAP|KEY)\s*:|#EXT-X-ENDLIST(?:\s|$)/i.test(prefix);
}
async function probeUncached(url, opts) {
  const startedAt = Date.now();
  const { headers, profile } = buildProxyHeaders(url, opts.playerReferer);
  const timeoutMs = adaptiveTimeout(url, opts, profile.connectTimeoutMs);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const isHls = /\.m3u8(?:\?|$)/i.test(url);
  const isMp4 = /\.mp4(?:\?|$)/i.test(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  let authStatusSeen;
  try {
    if (isHls) {
      const response = await fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "follow", headers });
      if (!isSuccessfulStatus(response.status)) {
        if (response.status === 401 || response.status === 403) authStatusSeen = reasonForStatus(response.status);
        await response.body?.cancel().catch(() => void 0);
        return resultForFailure(url, response.status, reasonForStatus(response.status), void 0, elapsed());
      }
      const prefix = await readPrefix(response);
      if (!isPlayableHlsManifest(prefix)) {
        return resultForFailure(
          url,
          response.status,
          "invalid_manifest",
          "HLS manifest missing playlist directives",
          elapsed()
        );
      }
      return resultForSuccess(url, response.status, elapsed());
    }
    const head = await fetchImpl(url, { method: "HEAD", signal: controller.signal, redirect: "follow", headers });
    await head.body?.cancel().catch(() => void 0);
    if (isSuccessfulStatus(head.status)) return resultForSuccess(url, head.status, elapsed());
    if (head.status === 401 || head.status === 403) authStatusSeen = reasonForStatus(head.status);
    if (isMp4) {
      const ranged = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { ...headers, Range: "bytes=0-100" }
      });
      await ranged.body?.cancel().catch(() => void 0);
      if (isSuccessfulStatus(ranged.status)) return resultForSuccess(url, ranged.status, elapsed());
      if (ranged.status === 401 || ranged.status === 403) authStatusSeen = reasonForStatus(ranged.status);
      return resultForFailure(url, ranged.status, reasonForStatus(ranged.status), void 0, elapsed());
    }
    return resultForFailure(url, head.status, reasonForStatus(head.status), void 0, elapsed());
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const reason = authStatusSeen ?? (timedOut ? "timeout" : "network_error");
    const message = error instanceof Error ? error.message : String(error);
    return resultForFailure(url, void 0, reason, message, elapsed());
  } finally {
    clearTimeout(timer);
  }
}
async function probeStream(url, opts = {}) {
  if (isHostBlacklisted(url)) {
    const record2 = getRecord(url);
    return {
      url,
      ok: false,
      state: "offline",
      reason: "circuit_open",
      fromCache: true,
      error: record2.circuitOpenUntil ? `circuit open until ${record2.circuitOpenUntil}` : void 0
    };
  }
  const record = getRecord(url);
  record.state = "checking";
  const hostSemaphore = getHostSemaphore(url);
  return globalSemaphore.run(() => hostSemaphore.run(() => probeUncached(url, opts)));
}
function recordPlaybackResult(url, signal) {
  const record = getRecord(url);
  record.playbackAttempts += 1;
  if (signal.latencyMs !== void 0 && signal.latencyMs >= 0) {
    record.playbackEwmaLatencyMs = ewma(record.playbackEwmaLatencyMs, signal.latencyMs, 0.2);
    recordLatency(record, signal.latencyMs);
  }
  if (signal.ok) {
    record.playbackSuccesses += 1;
    markHostHealthy(url);
  } else {
    markHostFailed(url, NEGATIVE_CACHE_TTL_MS, signal.reason ?? "playback_error");
  }
  return getHostHealth(url);
}
var DEFAULT_PROBE_TIMEOUT_MS, FAILURE_THRESHOLD, NEGATIVE_CACHE_TTL_MS, MIN_ADAPTIVE_TIMEOUT_MS, MAX_ADAPTIVE_TIMEOUT_MS, MAX_GLOBAL_PROBES, MAX_PROBES_PER_HOST, hostRecords, negativeCache, Semaphore, globalSemaphore, hostSemaphores, reportPlaybackSignal;
var init_hostHealth = __esm({
  "server/scrapers/hostHealth.ts"() {
    "use strict";
    init_hostProfiles();
    DEFAULT_PROBE_TIMEOUT_MS = 6e3;
    FAILURE_THRESHOLD = 2;
    NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1e3;
    MIN_ADAPTIVE_TIMEOUT_MS = 1200;
    MAX_ADAPTIVE_TIMEOUT_MS = 35e3;
    MAX_GLOBAL_PROBES = 2;
    MAX_PROBES_PER_HOST = 1;
    hostRecords = /* @__PURE__ */ new Map();
    negativeCache = /* @__PURE__ */ new Map();
    Semaphore = class {
      constructor(limit) {
        this.limit = limit;
      }
      limit;
      active = 0;
      waiters = [];
      async run(task) {
        if (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve));
        this.active += 1;
        try {
          return await task();
        } finally {
          this.active -= 1;
          this.waiters.shift()?.();
        }
      }
    };
    globalSemaphore = new Semaphore(MAX_GLOBAL_PROBES);
    hostSemaphores = /* @__PURE__ */ new Map();
    reportPlaybackSignal = recordPlaybackResult;
  }
});

// server/utils/textCleaner.ts
function cleanDescription(rawDescription, title) {
  if (!rawDescription) return "";
  let text = String(rawDescription);
  for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
    if (text.toLowerCase().includes(entity.toLowerCase())) {
      const reg = new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      text = text.replace(reg, replacement);
    }
  }
  text = text.replace(/&#(\d+);/g, (_, code) => {
    try {
      return String.fromCharCode(Number(code));
    } catch {
      return "";
    }
  }).replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return "";
    }
  });
  text = text.replace(/<[^>]*>/g, " ");
  text = text.replace(/Ã¡/g, "\xE1").replace(/Ã©/g, "\xE9").replace(/Ã­/g, "\xED").replace(/Ã³/g, "\xF3").replace(/Ãº/g, "\xFA").replace(/Ã±/g, "\xF1").replace(/Ã /g, "\xC1").replace(/Ã‰/g, "\xC9").replace(/Ã /g, "\xCD").replace(/Ã“/g, "\xD3").replace(/Ãš/g, "\xDA").replace(/Ã‘/g, "\xD1").replace(/â€“|â€”/g, "\u2014").replace(/â€œ|â€ /g, '"').replace(/â€˜|â€™/g, "'");
  text = text.replace(/^(?:sinopsis|descripci[oó]n|resumen|overview|summary)\s*:\s*/i, "").replace(/(?:ver|mira|disfruta)\s+(?:dorama|pel[ií]cula|anime|serie)?\s*[^.]*?\b(veranimes|cinecalidad|tioanime|tioplus|tubepelis|lamovie|animeflv|jkanime|latanime|doramasflix|cuevana|pelisplus)\b[^.]*?\./gi, "").replace(/ver\s+(?:dorama|anime|pel[ií]cula)?\s+.*?sub\s+español\s+online\s+.*?doramasflix/gi, "").replace(/💖\s*Doramasflix/gi, "").replace(/💓\s*dorama/gi, "");
  if (title) {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length >= 3) {
      const escapedTitle = trimmedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const titlePrefixRegex = new RegExp(`^${escapedTitle}\\s*[-:\u2013\u2014]?\\s*`, "i");
      text = text.replace(titlePrefixRegex, "");
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
function isAnomalousDescription(text, title) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 15) return true;
  if (SCRAPER_BRAND_REGEX.test(t)) return true;
  if (/(?:ver pel[ií]culas|ver anime|ver series|online gratis|sub espa[nñ]ol|cap[ií]tulo|audio latino)/i.test(t)) return true;
  if (/&(?:[a-z]{2,8}|#\d+|#x[0-9a-f]+);/i.test(t)) return true;
  if (/<[a-z][\s\S]*>/i.test(t)) return true;
  if (/Ã[¡éíóúñÁÉÍÓÚÑ]|â[€“—œ ˜™]/i.test(t)) return true;
  if (title && title.trim().length >= 4) {
    const cleanTitle2 = title.trim().toLowerCase();
    if (t.toLowerCase().startsWith(cleanTitle2)) return true;
  }
  if (/^(?:sin descripci|contenido indexado|obra multimedia indexada|placeholder|ver anime|ver peliculas)/i.test(t)) return true;
  return false;
}
var HTML_ENTITY_MAP, SCRAPER_BRAND_REGEX;
var init_textCleaner = __esm({
  "server/utils/textCleaner.ts"() {
    "use strict";
    HTML_ENTITY_MAP = {
      "&nbsp;": " ",
      "&amp;": "&",
      "&quot;": '"',
      "&apos;": "'",
      "&#39;": "'",
      "&lt;": "<",
      "&gt;": ">",
      "&aacute;": "\xE1",
      "&eacute;": "\xE9",
      "&iacute;": "\xED",
      "&oacute;": "\xF3",
      "&uacute;": "\xFA",
      "&ntilde;": "\xF1",
      "&Aacute;": "\xC1",
      "&Eacute;": "\xC9",
      "&Iacute;": "\xCD",
      "&Oacute;": "\xD3",
      "&Uacute;": "\xDA",
      "&Ntilde;": "\xD1",
      "&uuml;": "\xFC",
      "&Uuml;": "\xDC",
      "&iexcl;": "\xA1",
      "&iquest;": "\xBF",
      "&ccedil;": "\xE7",
      "&Ccedil;": "\xC7",
      "&ndash;": "\u2013",
      "&mdash;": "\u2014",
      "&hellip;": "\u2026",
      "&ldquo;": '"',
      "&rdquo;": '"',
      "&lsquo;": "'",
      "&rsquo;": "'",
      "&bull;": "\u2022",
      "&copy;": "\xA9",
      "&reg;": "\xAE",
      "&trade;": "\u2122",
      "&euro;": "\u20AC",
      "&pound;": "\xA3",
      "&yen;": "\xA5"
    };
    SCRAPER_BRAND_REGEX = /\b(veranimes|cinecalidad|tioanime|tioplus|tubepelis|lamovie|animeflv|jkanime|latanime|lat-anime|doramasflix|cuevana\d*|pelisplus|monoschinos|animesonline|tvmaze)\b/i;
  }
});

// server/scrapers/adapters/VerAnimesAdapter.ts
var cheerio11, BASE_URL5, DEAD_OR_BLOCKED_HOST_PATTERNS3, isDeadOrBlocked3, VerAnimesAdapter;
var init_VerAnimesAdapter = __esm({
  "server/scrapers/adapters/VerAnimesAdapter.ts"() {
    "use strict";
    cheerio11 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    init_validator();
    init_hostHealth();
    init_textCleaner();
    BASE_URL5 = "https://wwv.veranimes.net";
    DEAD_OR_BLOCKED_HOST_PATTERNS3 = [
      /cfglobalcdn\.com/i,
      /yourupload\.com/i,
      /streamtape\./i,
      /dsvplay\.com/i,
      /savefiles\.com/i,
      /d-s\.io/i,
      /vidcache\.net/i,
      /my\.mail\.ru/i,
      /v\.tioanime\.com/i
    ];
    isDeadOrBlocked3 = (url) => DEAD_OR_BLOCKED_HOST_PATTERNS3.some((p) => p.test(url));
    VerAnimesAdapter = class extends BaseScraperAdapter {
      id = "veranimes";
      name = "VerAnimes";
      supportedDomains = ["veranimes.net", "wwv.veranimes.net", "www.veranimes.net"];
      canHandle(url) {
        return url.toLowerCase().includes("veranimes.net");
      }
      /**
       * Búsqueda de animes en VerAnimes (/animes?buscar=...)
       */
      async search(query) {
        const searchUrl = `${BASE_URL5}/animes?buscar=${encodeURIComponent(query.trim())}`;
        const html = await this.fetchHtml(searchUrl, 1e4);
        if (!html) return [];
        return this.extractCatalogItems(html);
      }
      /**
       * Extrae items de catálogo desde el Home, listado /animes o resultados de búsqueda.
       * Estructura real verificada:
       *   <article class="li">
       *     <figure class="i"><a href="..."><img data-src="...cdn/img/{anime|portada}/x.webp" src="placeholder"></a><span>TV</span></figure>
       *     <h3 class="h"><a href="..." title="...">Título</a></h3>
       *   </article>
       */
      extractCatalogItems(html) {
        const $ = cheerio11.load(html);
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        $("article").each((_, el) => {
          const $art = $(el);
          const $link = $art.find("a[href*='/anime/']").first();
          const href = ($link.attr("href") || $art.find("a[href]").first().attr("href") || "").trim();
          if (!href || seen.has(href)) return;
          seen.add(href);
          const url = this.resolveRelativeUrl(href, BASE_URL5);
          const $img = $art.find("img").first();
          const rawImg = $img.attr("data-src") || $img.attr("src") || "";
          const isPlaceholder = /cdn\/img\/(anime|episode)\.png/i.test(rawImg);
          const imageUrl = rawImg && !isPlaceholder ? this.resolveRelativeUrl(rawImg, BASE_URL5) : null;
          const title = $art.find("h3.h a").text().trim() || ($img.attr("alt") || "").trim() || ($link.attr("title") || "").trim() || this.titleFromUrl(url);
          items.push({
            title,
            url,
            image_url: imageUrl,
            kind: "anime"
          });
        });
        return items;
      }
      /**
       * Metadatos de una página de detalle usando OpenGraph.
       */
      extractMetadata(html, url) {
        const $ = cheerio11.load(html);
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const h1Title = $("h1").first().text().trim();
        let rawTitle = ogTitle || h1Title || "";
        rawTitle = rawTitle.replace(/^Ver\s+/i, "").replace(/\s*[-–—|•]\s*VerAnime[s]?\s*$/i, "").replace(/\s*(?:Anime\s+)?(?:Sub\s+Español|Audio\s+Latino|Latino|Castellano)?\s*(?:Online)?\s*(?:Gratis)?\s*(?:en\s+HD)?\s*$/i, "").replace(/\s*\((?:TV|Movie|OVA|ONA)\)\s*/gi, " ").trim();
        const title = rawTitle || h1Title || this.titleFromUrl(url) || "Anime";
        const ogImage = $('meta[property="og:image"]').attr("content");
        const poster_url = ogImage ? this.resolveRelativeUrl(ogImage, url) : void 0;
        const rawDescription = $('meta[property="og:description"]').attr("content")?.trim() || "";
        const description = cleanDescription(rawDescription, title);
        const genres = [];
        $("ul.gn li a, .gn a").each((_, el) => {
          const genre = $(el).text().trim();
          if (genre && !genres.includes(genre)) genres.push(genre);
        });
        const yearMatch = html.match(/Año[\s:]*(\d{4})/i)?.[1] || html.match(/\b(19[5-9]\d|20[0-2]\d)\b/)?.[0] || url.match(/-(19\d{2}|20[0-2]\d)(?:\/|$|\?)/i)?.[1];
        const year = yearMatch ? parseInt(yearMatch, 10) : 0;
        return {
          title,
          description,
          poster_url,
          banner_url: void 0,
          // Dejar que el enriquecedor TMDB/AniList asigne un backdrop 16:9 real
          genres,
          year,
          content_type: "anime"
        };
      }
      /**
       * Lista de episodios de una página de detalle.
       *
       * Caso principal (página /anime/{slug}): los enlaces los construye el JS con
       * `var eps = ["N","N-1",...]` + atributo `data-sl`. Se reconstruyen como
       * {base}/ver/{sl}-{ep}.
       * Fallback: enlaces estáticos `a[href*="/ver/"]` (Home / listados).
       */
      extractEpisodes(html, baseUrl) {
        const episodes = [];
        const seen = /* @__PURE__ */ new Set();
        const base = baseUrl || BASE_URL5;
        const epsMatch = html.match(/var\s+eps\s*=\s*(\[[^\]]*\])/);
        const slMatch = html.match(/data-sl="([^"]+)"/);
        if (epsMatch && slMatch) {
          try {
            const eps = JSON.parse(epsMatch[1]);
            const slug = slMatch[1];
            for (const epn of eps) {
              const number = parseInt(epn, 10);
              if (!Number.isFinite(number)) continue;
              const url = this.resolveRelativeUrl(`/ver/${slug}-${epn}`, base);
              if (seen.has(url)) continue;
              seen.add(url);
              episodes.push({ number, title: `Episodio ${epn}`, url, server_name: "VerAnimes" });
            }
          } catch {
          }
        }
        if (episodes.length === 0) {
          const $ = cheerio11.load(html);
          $("a[href*='/ver/']").each((_, el) => {
            const href = $(el).attr("href");
            if (!href || href.includes("process")) return;
            const fullUrl = this.resolveRelativeUrl(href, base);
            if (seen.has(fullUrl)) return;
            seen.add(fullUrl);
            const numberMatch = fullUrl.match(/-([0-9]+)(?:\?.*)?$/) || fullUrl.match(/(\d+)\s*$/);
            const number = numberMatch ? parseInt(numberMatch[1], 10) : episodes.length + 1;
            const linkText = $(el).text().replace(/\s+/g, " ").trim();
            const capMatch = linkText.match(/[Ee]pisodio\s*(\d+)/);
            const title = capMatch ? `Episodio ${capMatch[1]}` : linkText || `Episodio ${number}`;
            episodes.push({ number, title, url: fullUrl, server_name: "VerAnimes" });
          });
        }
        return episodes.sort((a, b) => a.number - b.number);
      }
      /**
       * Localiza botones de selección de servidor (<li> o <button>) con URL de video
       * ofuscada y devuelve las URLs de iframe/embed decodificadas.
       *
       * Atributos soportados (en orden):
       * - `data-video`: URL plana (https://..., //...) o Base64
       * - `encrypt`:    URL codificada en hexadecimal (mecanismo real de VerAnimes,
       *                 equivalente JS: hex2a)
       */
      decodeDataVideoButtons(html) {
        if (!html || !html.includes("<")) return [];
        const $ = cheerio11.load(html);
        const urls = [];
        $("[data-video], [encrypt]").each((_, el) => {
          const $el = $(el);
          const raw = ($el.attr("data-video") || $el.attr("encrypt") || "").trim();
          if (!raw) return;
          const decoded = this.decodeServerValue(raw);
          if (decoded && !urls.includes(decoded)) urls.push(decoded);
        });
        return urls;
      }
      /**
       * Decodifica el valor de un botón de servidor:
       * URL plana → tal cual; hexadecimal → ASCII; Base64 → UTF-8.
       */
      decodeServerValue(value) {
        const v = value.trim();
        if (!v) return null;
        if (/^https?:\/\//i.test(v)) return v;
        if (v.startsWith("//")) return `https:${v}`;
        if (/^[0-9a-fA-F]+$/.test(v) && v.length >= 20 && v.length % 2 === 0) {
          const ascii = this.hexToAscii(v);
          if (/^https?:\/\//i.test(ascii)) return ascii;
        }
        if (this.isBase64(v)) {
          try {
            const decoded = Buffer.from(v, "base64").toString("utf-8").trim();
            if (/^https?:\/\//i.test(decoded)) return decoded;
          } catch {
          }
        }
        return null;
      }
      /**
       * Equivalente server-side de la función hex2a() del sitio.
       */
      hexToAscii(hex) {
        let str = "";
        for (let i = 0; i < hex.length; i += 2) {
          str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        }
        return str;
      }
      /**
       * Obtiene los botones de servidores reales de una página de episodio.
       *
       * Flujo verificado contra el sitio:
       * 1. La página trae <ul class="opt" data-encrypt="{id}"> vacío.
       * 2. El JS hace $.post('./process', {acc:'opt', i:id}); por el <base href>
       *    del sitio, './process' resuelve al ORIGEN: POST {origin}/process.
       * 3. La respuesta es el HTML de los <li encrypt="hex"> que este método
       *    decodifica con decodeDataVideoButtons().
       */
      async resolveServerButtons(episodeUrl) {
        const cleanUrl2 = episodeUrl.trim();
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        if (!html || this.isErrorPage(html)) return [];
        const inlineUrls = this.decodeDataVideoButtons(html);
        const encMatch = html.match(/<ul[^>]+class="opt"[^>]+data-encrypt="([^"]+)"/i) || html.match(/data-encrypt="([^"]+)"/i);
        let remoteUrls = [];
        if (encMatch) {
          const optionsHtml = await this.postProcessEndpoint(cleanUrl2, encMatch[1]);
          if (optionsHtml) {
            remoteUrls = this.decodeDataVideoButtons(optionsHtml);
          }
        }
        const all = [...remoteUrls, ...inlineUrls];
        return Array.from(new Set(all));
      }
      /**
       * POST al endpoint /process del origen (equivalente del $.post del sitio).
       */
      async postProcessEndpoint(pageUrl, encryptId) {
        try {
          const origin = new URL(pageUrl).origin;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1e4);
          const res = await fetch(`${origin}/process`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              ...{ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
              Referer: pageUrl,
              Origin: origin
            },
            body: new URLSearchParams({ acc: "opt", i: encryptId }).toString()
          });
          clearTimeout(timer);
          if (!res.ok) return null;
          const text = await res.text();
          if (!text || text.includes("<!DOCTYPE")) return null;
          return text;
        } catch {
          return null;
        }
      }
      async analyze(input, explicitType) {
        const cleanUrl2 = input.trim();
        let path7 = "/";
        try {
          path7 = new URL(cleanUrl2).pathname.toLowerCase();
        } catch {
        }
        if (explicitType === "catalog" || path7 === "/" || path7.startsWith("/animes")) {
          const fetchUrl = path7 === "/" ? BASE_URL5 : cleanUrl2;
          const html2 = await this.fetchHtml(fetchUrl, 1e4);
          if (!html2) throw new Error(`FETCH_FAILED: ${fetchUrl}`);
          const catalogItems = this.extractCatalogItems(html2);
          return {
            page_type: "catalog",
            content_type: "anime",
            title: "Cat\xE1logo de Animes - VerAnimes",
            description: `Cat\xE1logo de animes en VerAnimes (${catalogItems.length} t\xEDtulos)`,
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "wwv.veranimes.net",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        if (path7.startsWith("/ver/")) {
          const html2 = await this.fetchHtml(cleanUrl2, 12e3);
          if (html2 && this.isErrorPage(html2)) {
            return {
              page_type: "direct_stream",
              content_type: "anime",
              title: "Contenido no disponible - VerAnimes",
              description: `La p\xE1gina ${cleanUrl2} no existe en VerAnimes (error 404 del sitio).`,
              poster_url: null,
              banner_url: null,
              rating: 0,
              year: 0,
              status: "No encontrado",
              genres: [],
              source_domain: "wwv.veranimes.net",
              episodes: [],
              catalog_items: []
            };
          }
          const metadata2 = html2 ? this.extractMetadata(html2, cleanUrl2) : { title: "Episodio VerAnimes", description: "", poster_url: void 0, banner_url: void 0, genres: [], year: 0, content_type: "anime" };
          let detectedStreams2;
          if (!explicitType || explicitType === "stream" || explicitType === "auto") {
            try {
              const streamResult = await this.extractStream(cleanUrl2);
              detectedStreams2 = streamResult.all_available_streams.length > 0 ? streamResult.all_available_streams : void 0;
            } catch {
            }
          }
          return {
            page_type: "direct_stream",
            content_type: "anime",
            title: metadata2.title,
            description: metadata2.description,
            poster_url: metadata2.poster_url || null,
            banner_url: metadata2.banner_url || null,
            rating: 7,
            year: metadata2.year,
            status: "Publicado",
            genres: metadata2.genres,
            source_domain: "wwv.veranimes.net",
            detected_streams: detectedStreams2,
            episodes: [],
            catalog_items: []
          };
        }
        const html = await this.fetchHtml(cleanUrl2, 1e4);
        if (!html || this.isErrorPage(html)) {
          return {
            page_type: "detail",
            content_type: "anime",
            title: "Anime VerAnimes",
            description: html ? "El contenido solicitado no existe en VerAnimes (error 404 del sitio)." : "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "No encontrado",
            genres: [],
            source_domain: "wwv.veranimes.net",
            episodes: [],
            catalog_items: []
          };
        }
        const metadata = this.extractMetadata(html, cleanUrl2);
        const episodes = this.extractEpisodes(html, cleanUrl2);
        let detectedStreams;
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          try {
            const first = episodes[0];
            if (first) {
              const streamResult = await this.extractStream(first.url);
              detectedStreams = streamResult.all_available_streams;
            }
          } catch {
          }
        }
        return {
          page_type: "detail",
          content_type: metadata.content_type,
          title: metadata.title,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: 7,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          source_domain: "wwv.veranimes.net",
          detected_streams: detectedStreams,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
      /**
       * Extrae streams de video de una página de episodio:
       * 1. Obtiene los botones de servidores (POST /process + decodificación hex/data-video).
       * 2. Resuelve cada iframe con EmbedResolvers para obtener .m3u8/.mp4 directos.
       * 3. Valida con MediaValidator y prioriza streams directos.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        const is404 = !!html && this.isErrorPage(html);
        const title = html && !is404 ? (html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] || "").replace(/\s*[-–—]\s*VerAnime\s*$/i, "").trim() || void 0 : void 0;
        if (is404) {
          return { stream_url: "", all_available_streams: [], title };
        }
        let iframeUrls = [];
        if (html) {
          iframeUrls = this.decodeDataVideoButtons(html);
          const encMatch = html.match(/<ul[^>]+class="opt"[^>]+data-encrypt="([^"]+)"/i) || html.match(/data-encrypt="([^"]+)"/i);
          if (encMatch) {
            const optionsHtml = await this.postProcessEndpoint(cleanUrl2, encMatch[1]);
            if (optionsHtml) {
              for (const url of this.decodeDataVideoButtons(optionsHtml)) {
                if (!iframeUrls.includes(url)) iframeUrls.push(url);
              }
            }
          }
        }
        if (iframeUrls.length === 0) {
          const genericStreams = await super.extractStream(cleanUrl2);
          return { ...genericStreams, title };
        }
        const alive = iframeUrls.filter((u) => !isDeadOrBlocked3(u));
        const supported = alive.filter((u) => isSupportedServer(u));
        let candidates = supported;
        let deobfuscated = [];
        if (supported.length === 0) {
          for (const u of alive) {
            try {
              const d = await EmbedResolvers.resolve(u);
              if (d && /\.(m3u8|mp4|webm)(\?|$)/i.test(d) && !deobfuscated.includes(d)) {
                deobfuscated.push(d);
              }
            } catch {
            }
          }
        }
        const finalCandidates = candidates.length > 0 ? candidates : deobfuscated;
        if (finalCandidates.length === 0) {
          return { stream_url: "", all_available_streams: [], title };
        }
        const resolutions = await Promise.all(
          finalCandidates.map(async (iframeUrl) => {
            try {
              return { iframeUrl, resolved: await EmbedResolvers.resolve(iframeUrl) };
            } catch {
              return { iframeUrl, resolved: "" };
            }
          })
        );
        const all_available_streams = [];
        const directStreams = [];
        for (const { iframeUrl, resolved } of resolutions) {
          const finalUrl = resolved && !isDeadOrBlocked3(resolved) ? resolved : "";
          if (!finalUrl) continue;
          const isDirectMedia2 = /\.(m3u8|mp4|webm)(\?|$)/i.test(finalUrl);
          if (isDirectMedia2) {
            if (!directStreams.includes(finalUrl)) directStreams.push(finalUrl);
            if (!all_available_streams.includes(finalUrl)) all_available_streams.push(finalUrl);
          } else if (isSupportedServer(finalUrl) || isSupportedServer(iframeUrl)) {
            if (!all_available_streams.includes(finalUrl)) all_available_streams.push(finalUrl);
          }
        }
        let healthyDirects = [];
        if (directStreams.length > 0) {
          healthyDirects = await this.probeAndOrderDirectStreams(directStreams);
        }
        const failedDirects = directStreams.filter((d) => !healthyDirects.includes(d));
        const isUnreliableEmbed = (u) => /hqq\.|waaw|cvary\.org|divxplayer/i.test(u);
        const embedStreams = all_available_streams.filter((s) => !directStreams.includes(s));
        const reliableEmbeds = embedStreams.filter((s) => !isUnreliableEmbed(s));
        const lowPriorityEmbeds = embedStreams.filter((s) => isUnreliableEmbed(s));
        const sortedEmbeds = [...reliableEmbeds, ...lowPriorityEmbeds];
        const ordered = [...healthyDirects, ...sortedEmbeds, ...failedDirects];
        const validStreams = await MediaValidator.validateUrls(ordered);
        const finalStreams = validStreams.length > 0 ? validStreams : ordered;
        return {
          stream_url: finalStreams[0] || cleanUrl2,
          all_available_streams: finalStreams.length > 0 ? finalStreams : [cleanUrl2],
          title
        };
      }
      /**
       * Sonda de salud de URLs de media directo (.m3u8/.mp4), delegada al módulo
       * global hostHealth (headers del proxy según hostProfiles + caché negativa).
       * Devuelve las sanas primero (orden original) y descarta las que no
       * responden a tiempo.
       */
      async probeAndOrderDirectStreams(urls) {
        if (urls.length === 0) return [];
        const results = await Promise.all(
          urls.map((url) => probeStream(url, { playerReferer: "https://wwv.veranimes.net/", timeoutMs: 4e3 }))
        );
        return results.filter((r) => r.ok).map((r) => r.url);
      }
      /**
       * Detecta páginas de error del sitio (slug inexistente): VerAnimes devuelve
       * un HTTP 404 con ~37KB de HTML válido cuyo <title>/og:title es "Error 404".
       * BaseAdapter.fetchHtml devuelve ese cuerpo por diseño (workaround LaMovie),
       * así que hay que filtrarlo explícitamente antes de extraer metadatos.
       */
      isErrorPage(html) {
        if (!html) return false;
        const $ = cheerio11.load(html);
        const pageTitle = ($("title").first().text() || "").trim();
        const ogTitle = $('meta[property="og:title"]').attr("content") || "";
        const combined = `${pageTitle} ${ogTitle}`.toLowerCase();
        return /\b404\b/.test(combined) || combined.includes("no encontrado") || combined.includes("not found") || combined.startsWith("error");
      }
      titleFromUrl(url) {
        const match = url.match(/\/(?:anime|ver)\/([^/?#]+)/);
        if (!match) return "Anime";
        return match[1].replace(/-\d+$/, "").replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
      }
    };
  }
});

// server/scrapers/adapters/DoramasflixAdapter.ts
var cheerio12, BASE_URL6, GRAPHQL_URL, GRAPHQL_APP, CATALOG_PAGE_SIZE, NEXT_ACTION_ID, NEXT_ACTION_FALLBACK, DoramasflixAdapter;
var init_DoramasflixAdapter = __esm({
  "server/scrapers/adapters/DoramasflixAdapter.ts"() {
    "use strict";
    cheerio12 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    init_validator();
    BASE_URL6 = "https://doramasflix.io";
    GRAPHQL_URL = "https://user-api.fluxcedene.net/graphql";
    GRAPHQL_APP = "com.asiapp.doramasgo";
    CATALOG_PAGE_SIZE = 24;
    NEXT_ACTION_ID = "406bdec544eeb53cbefa09322cbda67963eb850496";
    NEXT_ACTION_FALLBACK = "40c3671ad750012fd1bcbcb050c7894f427d37a8b1";
    DoramasflixAdapter = class extends BaseScraperAdapter {
      id = "doramasflix";
      name = "Doramasflix (Doramas, Pel\xEDculas, Variedades)";
      supportedDomains = ["doramasflix.io", "doramasflix.co", "doramasflix.net", "doramasflix.in", "doramasflix.com"];
      canHandle(url) {
        const lower = url.toLowerCase();
        return this.supportedDomains.some((domain) => lower.includes(domain));
      }
      async analyze(input, explicitType) {
        const url = input.trim();
        if (explicitType === "stream" || url.includes("/capitulos/")) {
          const streamRes = await this.extractStream(url);
          return {
            page_type: "direct_stream",
            content_type: "series",
            title: streamRes.title || "Doramasflix Stream",
            description: "",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "ongoing",
            genres: ["Dorama"],
            detected_streams: streamRes.all_available_streams,
            episodes: [],
            catalog_items: []
          };
        }
        if (explicitType === "catalog" || url.endsWith("/peliculas") || url.endsWith("/variedades") || url.endsWith("/doramas")) {
          const items = await this.extractCatalog(url);
          const isMovie = url.includes("/peliculas");
          return {
            page_type: "catalog",
            content_type: isMovie ? "movie" : "series",
            title: `Cat\xE1logo ${isMovie ? "Pel\xEDculas" : "Doramas"} - Doramasflix`,
            description: "Cat\xE1logo extra\xEDdo de Doramasflix",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "ongoing",
            genres: ["Dorama"],
            episodes: [],
            catalog_items: items
          };
        }
        return this.extractDetail(url);
      }
      /**
       * Extrae el catálogo de /doramas, /peliculas o /variedades
       */
      async extractCatalog(url) {
        const apiItems = await this.extractCatalogFromGraphql(url);
        if (apiItems.length > 0) return apiItems;
        const html = await this.fetchHtml(url);
        if (!html) throw new Error(`FETCH_FAILED: ${url}`);
        const $ = cheerio12.load(html);
        const items = [];
        const seen = /* @__PURE__ */ new Set();
        const sel = "a[href*='/doramas/'], a[href*='/peliculas/'], a[href*='/variedades/'], a[href*='/pelicula/'], a[href*='/serie/'], a[href*='/anime/']";
        $(sel).each((_, el) => {
          const href = $(el).attr("href");
          if (!href || href === "/doramas" || href === "/peliculas" || href === "/variedades" || seen.has(href)) return;
          const fullUrl = this.resolveRelativeUrl(href, BASE_URL6);
          if (!fullUrl || seen.has(fullUrl)) return;
          seen.add(fullUrl);
          const $parent = $(el).closest("div, article");
          const title = $parent.find("h2, h3, .title, .name").first().text().trim() || $(el).attr("title")?.trim() || $parent.find("img").attr("alt")?.trim() || this.titleFromUrl(fullUrl);
          const img = $parent.find("img").attr("src") || $parent.find("img").attr("data-src") || $(el).find("img").attr("src") || "";
          let kind = "series";
          if (url.includes("/peliculas") || href.includes("/pelicula") || href.includes("/peliculas/")) kind = "movie";
          items.push({
            title: title || this.titleFromUrl(fullUrl),
            url: fullUrl,
            image_url: img ? this.resolveRelativeUrl(img, BASE_URL6) : null,
            kind
          });
        });
        return items;
      }
      async extractCatalogFromGraphql(url) {
        const page = this.catalogPageNumber(url);
        const path7 = (() => {
          try {
            return new URL(url).pathname.toLowerCase();
          } catch {
            return "";
          }
        })();
        const isMovie = path7.includes("/peliculas");
        const isVariety = path7.includes("/variedades");
        const query = isMovie ? `query PaginationMovie($sort: SortMovie, $limit: Int, $filter: FilterMoviesInput, $page: Int, $excludedLabelSlugs: [String!]) {
          paginationMovie(sort: $sort, limit: $limit, filter: $filter, page: $page, excludedLabelSlugs: $excludedLabelSlugs) {
            items { _id name name_es slug poster_path poster backdrop_path backdrop release_date }
          }
        }` : `query PaginationDorama($sort: SortDorama, $limit: Int, $filter: FilterDoramasInput, $page: Int, $excludedLabelSlugs: [String!]) {
          paginationDorama(sort: $sort, limit: $limit, filter: $filter, page: $page, excludedLabelSlugs: $excludedLabelSlugs) {
            items { _id name name_es slug isTVShow poster_path poster backdrop_path backdrop first_air_date }
          }
        }`;
        const filter = isMovie ? {} : isVariety ? { isTVShow: true } : { isTVShow: false };
        const variables = { sort: "_ID_DESC", limit: CATALOG_PAGE_SIZE, filter, page, excludedLabelSlugs: null };
        const response = await this.fetchGraphql(query, variables, url);
        if (!response || typeof response !== "object") return [];
        const container = isMovie ? response.data?.paginationMovie : response.data?.paginationDorama;
        const rawItems = container?.items;
        if (!Array.isArray(rawItems)) return [];
        const prefix = isMovie ? "/peliculas/" : isVariety ? "/variedades/" : "/doramas/";
        const result = [];
        const seen = /* @__PURE__ */ new Set();
        for (const raw of rawItems) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw;
          const slug = typeof item.slug === "string" ? item.slug.trim() : "";
          if (!slug || seen.has(slug)) continue;
          seen.add(slug);
          const title = this.firstString(item.name_es, item.name, slug);
          const poster = this.firstString(item.poster, item.poster_path);
          const backdrop = this.firstString(item.backdrop, item.backdrop_path);
          const year = this.yearFromValue(item.release_date ?? item.first_air_date);
          result.push({
            title,
            url: `${BASE_URL6}${prefix}${encodeURIComponent(slug)}`,
            image_url: poster || backdrop ? this.resolveRelativeUrl(poster || backdrop, BASE_URL6) : null,
            kind: isMovie ? "movie" : "series",
            year
          });
        }
        return result;
      }
      async fetchGraphql(query, variables, referer) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8e3);
        try {
          const response = await fetch(GRAPHQL_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
              ...COMMON_HEADERS,
              Accept: "application/json",
              "Content-Type": "application/json",
              Origin: BASE_URL6,
              Referer: referer,
              "X-App": GRAPHQL_APP
            },
            body: JSON.stringify({ query, variables })
          });
          if (!response.ok) return null;
          const payload = await response.json();
          if (Array.isArray(payload.errors) && payload.errors.length > 0) return null;
          return payload;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }
      catalogPageNumber(url) {
        try {
          const parsed = new URL(url);
          const raw = parsed.searchParams.get("page") || parsed.searchParams.get("p") || parsed.searchParams.get("pag") || "1";
          const page = Number.parseInt(raw, 10);
          return Number.isFinite(page) && page > 0 ? page : 1;
        } catch {
          return 1;
        }
      }
      firstString(...values) {
        return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() || "";
      }
      yearFromValue(value) {
        if (typeof value !== "string") return null;
        const match = value.match(/\b(19|20)\d{2}\b/);
        return match ? Number.parseInt(match[0], 10) : null;
      }
      /**
       * Extrae metadatos y lista de episodios desde la página de detalle
       */
      async extractDetail(url) {
        const html = await this.fetchHtml(url);
        if (!html) {
          return {
            page_type: "detail",
            content_type: "series",
            title: "",
            description: "",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "",
            genres: [],
            episodes: [],
            catalog_items: []
          };
        }
        const $ = cheerio12.load(html);
        const title = $("h1").first().text().trim() || $("meta[property='og:title']").attr("content") || $("title").text().trim();
        const description = $("meta[property='og:description']").attr("content") || $(".synopsis, .overview, p").first().text().trim();
        const poster_url = $("meta[property='og:image']").attr("content") || $(".poster img, img[src*='tmdb']").attr("src") || null;
        const episodes = [];
        const seenEp = /* @__PURE__ */ new Set();
        $("a[href*='/capitulos/']").each((idx, el) => {
          const href = $(el).attr("href");
          if (!href || seenEp.has(href)) return;
          seenEp.add(href);
          const epTitle = $(el).text().trim() || `Cap\xEDtulo ${idx + 1}`;
          episodes.push({
            number: idx + 1,
            title: epTitle,
            url: this.resolveRelativeUrl(href, BASE_URL6)
          });
        });
        const isMovie = url.includes("/pelicula/") || url.includes("/peliculas/") || episodes.length === 0;
        return {
          page_type: "detail",
          content_type: isMovie ? "movie" : "series",
          title,
          description,
          poster_url: poster_url ? this.resolveRelativeUrl(poster_url, BASE_URL6) : null,
          banner_url: null,
          rating: 0,
          year: 0,
          status: "ongoing",
          genres: ["Dorama"],
          episodes,
          catalog_items: []
        };
      }
      /**
       * Extrae episode_id tolerando HTML escapado de React Flight (\", \\u0022).
       */
      extractEpisodeId(html) {
        const normalized = html.replace(/\\u0022/g, '"').replace(/\\"/g, '"');
        const candidates = [
          // El frontend vigente entrega `initialEpisodes[].id` (antes era
          // `episode._id`). Mantener ambos formatos evita que el adaptador se
          // quede devolviendo la página del capítulo sin consultar sus servidores.
          /initialEpisodes[^]{0,800}?\"id\"\s*:\s*\"([a-f0-9]{24})\"/i,
          /initialEpisodes[^]{0,800}?["']id["']\s*:\s*["']([a-f0-9]{24})["']/i,
          /"episode"\s*:\s*\{[^}]*?"_id"\s*:\s*"([a-f0-9]{24})"/i,
          /'episode'\s*:\s*\{[^}]*?'_id'\s*:\s*['"]([a-f0-9]{24})['"]/i,
          /"_id"\s*:\s*"([a-f0-9]{24})"/i
        ];
        for (const re of candidates) {
          const m = normalized.match(re) || html.match(re);
          if (m) return m[1];
        }
        const fallback = normalized.match(/"([a-f0-9]{24})"/i) || html.match(/([a-f0-9]{24})/);
        if (fallback && /^[a-f0-9]{24}$/i.test(fallback[1] || fallback[0])) {
          const episodeNear = normalized.match(/episode[^]{0,400}([a-f0-9]{24})/i);
          if (episodeNear) return episodeNear[1];
          return fallback[1] || fallback[0];
        }
        return null;
      }
      /**
       * Construye el header Next-Router-State-Tree para POST Server Action.
       * Formato capturado live para /capitulos/<slug>.
       */
      buildNextRouterStateTree(targetUrl) {
        try {
          const slug = new URL(targetUrl).pathname.split("/").filter(Boolean).pop() || "unknown";
          const fullTree = `["",{"children":[["locale","es","d",null],{"children":["capitulos",{"children":[["slug","${slug}","d",null],{"children":["__PAGE__",{},null,null,0]}]}]}],"modal":["__DEFAULT__",{},null,null,0]},null,null,16]`;
          return encodeURIComponent(fullTree);
        } catch {
          return "";
        }
      }
      /**
       * Intenta descubrir el Next-Action vigente para getEpisodeLinks escaneando chunks.
       * Acotado y paralelo con cleanup garantizado. Si falla, devuelve el fallback conocido.
       */
      async discoverNextActionId(html) {
        const chunkRegex = /\/_next\/static\/chunks\/[^"']+\.js/g;
        const chunks = [...new Set(html.match(chunkRegex) || [])].slice(0, 8);
        if (chunks.length === 0) return NEXT_ACTION_ID;
        const controllers = [];
        const timers = [];
        try {
          const results = await Promise.all(
            chunks.map(async (c) => {
              const controller = new AbortController();
              controllers.push(controller);
              const timer = setTimeout(() => controller.abort(), 3500);
              timers.push(timer);
              try {
                const full = new URL(c, BASE_URL6).href;
                const res = await fetch(full, { signal: controller.signal, headers: COMMON_HEADERS });
                if (!res.ok) return null;
                const text = await res.text();
                const m = text.match(/createServerReference\("([a-f0-9]{40,64})"[^)]*"getEpisodeLinks"/);
                return m ? m[1] : null;
              } catch {
                return null;
              } finally {
                clearTimeout(timer);
              }
            })
          );
          const found = results.find((v) => !!v);
          if (found) return found;
        } finally {
          for (const t of timers) clearTimeout(t);
          for (const c of controllers) try {
            c.abort();
          } catch {
          }
        }
        const hexInHtml = html.match(/[a-f0-9]{40,42}/gi);
        if (hexInHtml?.includes(NEXT_ACTION_ID)) return NEXT_ACTION_ID;
        return NEXT_ACTION_ID;
      }
      /**
       * Parsea la respuesta de Next-Action sin asumir solo "1:".
       * Busca líneas que contengan JSON con links de embedshortener.
       */
      parseActionServers(actionText) {
        const lines = actionText.split("\n");
        for (const line of lines) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const payload = line.slice(colon + 1);
          if (!payload.trim().startsWith("[") && !payload.trim().startsWith("{")) continue;
          try {
            const parsed = JSON.parse(payload);
            if (Array.isArray(parsed) && parsed.some((s) => s && s.link)) return parsed;
            if (parsed && typeof parsed === "object") {
              const str = JSON.stringify(parsed);
              if (str.includes("embedshortener") || str.includes("link")) {
                if (Array.isArray(parsed)) return parsed;
                for (const v of Object.values(parsed)) {
                  if (Array.isArray(v) && v.some((x) => x?.link)) return v;
                }
              }
            }
          } catch {
          }
        }
        const fallback = actionText.match(/\[\{[^]*?embedshortener[^]*?\}\]/);
        if (fallback) {
          try {
            const parsed = JSON.parse(fallback[0]);
            if (Array.isArray(parsed)) return parsed;
          } catch {
          }
        }
        return null;
      }
      /**
       * Extrae y desencripta los servidores/embeds reales de un episodio mediante Next-Action + JWT decoding
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        const fetchTimerMap = [];
        try {
          const html = await this.fetchHtml(cleanUrl2, 8e3);
          if (!html) {
            return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
          }
          const $ = cheerio12.load(html);
          const pageTitle = $("title").text().trim() || void 0;
          const episodeId = this.extractEpisodeId(html);
          if (!episodeId) {
            return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2], title: pageTitle };
          }
          let actionId = NEXT_ACTION_ID;
          try {
            const discovered = await this.discoverNextActionId(html);
            if (discovered && /^[a-f0-9]{40,64}$/i.test(discovered)) actionId = discovered;
          } catch {
          }
          const tryActions = [actionId, NEXT_ACTION_FALLBACK].filter((v, i, a) => v && a.indexOf(v) === i);
          let finalReachable = [];
          for (let attempt = 0; attempt < 3 && finalReachable.length === 0; attempt++) {
            let actionText = null;
            for (const cand of tryActions) {
              let controller = null;
              let timer = null;
              try {
                controller = new AbortController();
                timer = setTimeout(() => controller.abort(), 8e3);
                if (timer) fetchTimerMap.push(timer);
                const tree = this.buildNextRouterStateTree(cleanUrl2);
                const actionRes = await fetch(cleanUrl2, {
                  method: "POST",
                  signal: controller.signal,
                  headers: {
                    ...COMMON_HEADERS,
                    Referer: cleanUrl2,
                    "Next-Action": cand,
                    "Next-Router-State-Tree": tree,
                    "Content-Type": "text/plain;charset=UTF-8",
                    Accept: "text/x-component"
                  },
                  body: JSON.stringify([{ episode_id: episodeId }])
                });
                if (!actionRes.ok) continue;
                actionText = await actionRes.text();
                if (actionText.includes("Server action not found")) continue;
                if (actionText.includes("embedshortener") || actionText.includes("link")) break;
                break;
              } catch {
                continue;
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            if (!actionText) continue;
            const rawServers = this.parseActionServers(actionText);
            if (!rawServers || !Array.isArray(rawServers) || rawServers.length === 0) continue;
            const embedUrls = [];
            for (const s of rawServers) {
              if (!s.link) continue;
              const decoded = this.decodeEmbedShortenerLink(s.link);
              if (decoded) embedUrls.push(decoded);
            }
            if (embedUrls.length === 0) continue;
            const resolvedStreams = [];
            for (const embedUrl of embedUrls) {
              const resolved = await EmbedResolvers.resolve(embedUrl);
              const candidate = resolved || embedUrl;
              if (candidate.toLowerCase() === cleanUrl2.toLowerCase()) continue;
              resolvedStreams.push(candidate);
            }
            if (resolvedStreams.length === 0) continue;
            const validStreams = await MediaValidator.validateUrls(resolvedStreams);
            const filteredValid = validStreams.filter((u) => u.toLowerCase() !== cleanUrl2.toLowerCase());
            const filteredResolved = resolvedStreams.filter((u) => u.toLowerCase() !== cleanUrl2.toLowerCase() && !u.includes("embedshortener.co"));
            const candidates = filteredValid.length > 0 ? filteredValid : filteredResolved.length > 0 ? filteredResolved : resolvedStreams;
            const directCandidates = candidates.filter((u) => this.isDirectMediaUrl(u));
            if (directCandidates.length === 0) continue;
            const reachable = [];
            for (const u of directCandidates) {
              if (await this.isDirectReachable(u)) reachable.push(u);
            }
            if (reachable.length > 0) {
              finalReachable = reachable;
              break;
            }
            if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
          }
          if (finalReachable.length === 0) {
            return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2], title: pageTitle };
          }
          return {
            stream_url: finalReachable[0],
            all_available_streams: finalReachable,
            title: pageTitle
          };
        } catch {
          return {
            stream_url: cleanUrl2,
            all_available_streams: [cleanUrl2]
          };
        } finally {
          for (const t of fetchTimerMap) clearTimeout(t);
        }
      }
      /**
       * Desencripta el enlace `https://embedshortener.co/e/<jwt>`
       * 1. Extrae el payload JWT (Base64URL)
       * 2. Parsea `{ "link": "<base64_embed_url>" }`
       * 3. Retorna la URL del reproductor desencriptada
       */
      decodeEmbedShortenerLink(embedShortenerUrl) {
        try {
          const jwt3 = embedShortenerUrl.split("/e/")[1];
          if (!jwt3) return null;
          const parts = jwt3.split(".");
          if (parts.length < 2) return null;
          let payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
          while (payloadB64.length % 4) payloadB64 += "=";
          const payloadJson = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
          if (!payloadJson.link) return null;
          let linkB64 = payloadJson.link.replace(/-/g, "+").replace(/_/g, "/");
          while (linkB64.length % 4) linkB64 += "=";
          return Buffer.from(linkB64, "base64").toString("utf-8");
        } catch {
          return null;
        }
      }
      isDirectMediaUrl(url) {
        return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url) || url.includes("/m3u8/") || url.includes("hls-vod");
      }
      /**
       * Verifica que un stream directo responde 200/206 y no es HTML.
       * Solo se considera éxito si es medio directo y reachable.
       */
      async isDirectReachable(url) {
        if (!this.isDirectMediaUrl(url)) return false;
        let controller = null;
        let timer = null;
        try {
          controller = new AbortController();
          timer = setTimeout(() => controller.abort(), 3500);
          let res = await fetch(url, {
            method: "HEAD",
            signal: controller.signal,
            headers: { "User-Agent": COMMON_HEADERS["User-Agent"] }
          });
          if (res.status === 405 || res.status === 501) {
            res = await fetch(url, {
              method: "GET",
              signal: controller.signal,
              headers: { "User-Agent": COMMON_HEADERS["User-Agent"], Range: "bytes=0-1" }
            });
          }
          if (res.status === 200 || res.status === 206) {
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("text/html")) return false;
            return true;
          }
          return false;
        } catch {
          return false;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      resolveRelativeUrl(relative, base) {
        try {
          return new URL(relative, base).href;
        } catch {
          return relative;
        }
      }
      titleFromUrl(url) {
        try {
          const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
          return slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim() || "Doramasflix";
        } catch {
          return "Doramasflix";
        }
      }
    };
  }
});

// server/scrapers/adapters/TubePelisAdapter.ts
var cheerio13, BASE_URL7, DEAD_OR_BLOCKED_HOST_PATTERNS4, isDeadOrBlocked4, TubePelisAdapter;
var init_TubePelisAdapter = __esm({
  "server/scrapers/adapters/TubePelisAdapter.ts"() {
    "use strict";
    cheerio13 = __toESM(require("cheerio"), 1);
    init_BaseAdapter();
    init_resolvers();
    init_validator();
    BASE_URL7 = "https://tubepelis.com";
    DEAD_OR_BLOCKED_HOST_PATTERNS4 = [
      /cfglobalcdn\.com/i,
      /yourupload\.com/i,
      /streamtape\./i,
      /dsvplay\.com/i,
      /savefiles\.com/i,
      /d-s\.io/i,
      /a\d+\.mp4upload\.com/i,
      /vidcache\.net/i,
      /my\.mail\.ru/i,
      /v\.tioanime\.com/i
    ];
    isDeadOrBlocked4 = (url) => DEAD_OR_BLOCKED_HOST_PATTERNS4.some((p) => p.test(url));
    TubePelisAdapter = class extends BaseScraperAdapter {
      id = "tubepelis";
      name = "TubePelis (Pel\xEDculas)";
      supportedDomains = ["tubepelis.com", "www.tubepelis.com"];
      canHandle(url) {
        return url.toLowerCase().includes("tubepelis.com");
      }
      /**
       * Búsqueda de películas (/buscar/?q=...)
       */
      async search(query) {
        const searchUrl = `${BASE_URL7}/buscar/?q=${encodeURIComponent(query.trim())}`;
        const html = await this.fetchHtml(searchUrl, 1e4);
        if (!html) return [];
        return this.extractCatalogItems(html);
      }
      /**
       * Extrae items del catálogo (Home, búsqueda o categorías).
       * Las cards reales no usan clase `.item`/`.pelicula`; el anclaje confiable es
       * `a[href*="/pelicula/{id}/{slug}.html"]`.
       */
      extractCatalogItems(html) {
        const $ = cheerio13.load(html);
        const items = [];
        const byUrl = /* @__PURE__ */ new Map();
        $('a[href*="/pelicula/"]').each((_, el) => {
          const href = $(el).attr("href") || "";
          const match = href.match(/\/pelicula\/(\d+)\/([^/]+)\.html/i);
          if (!match || byUrl.has(match[0])) return;
          const movieId = match[1];
          const rawImg = $(el).closest("div").find("img").first().attr("src") || $(el).closest("div").find("img").first().attr("data-src") || "";
          const imageUrl = rawImg && !rawImg.includes("placeholder") ? this.resolveRelativeUrl(rawImg, BASE_URL7) : `${BASE_URL7}/files/uploads/${movieId}.webp`;
          byUrl.set(match[0], {
            title: this.titleFromSlug(match[2]),
            url: this.resolveRelativeUrl(href, BASE_URL7),
            image_url: imageUrl,
            kind: "movie",
            year: null
          });
        });
        $("h3 a[href*='/pelicula/']").each((_, el) => {
          const href = $(el).attr("href") || "";
          const keyMatch = href.match(/\/pelicula\/(\d+)\/([^/]+)\.html/i);
          if (!keyMatch) return;
          const item = byUrl.get(keyMatch[0]);
          if (!item) return;
          const h3Text = $(el).text().replace(/\s+/g, " ").trim();
          if (h3Text) item.title = h3Text;
          else if (($(el).attr("title") || "").trim()) item.title = ($(el).attr("title") || "").trim();
          const metaText = $(el).closest("h3").next().text() || "";
          const yearMatch = metaText.match(/\b(19|20)\d{2}\b/);
          if (yearMatch) item.year = parseInt(yearMatch[0], 10);
        });
        $('a[title][href*="/pelicula/"]').each((_, el) => {
          const href = $(el).attr("href") || "";
          const keyMatch = href.match(/\/pelicula\/\d+\/[^/]+\.html/i);
          if (!keyMatch) return;
          const item = byUrl.get(keyMatch[0]);
          if (item && !item.title) item.title = ($(el).attr("title") || "").trim();
        });
        items.push(...byUrl.values());
        return items;
      }
      /**
       * Metadatos de una página de detalle: OpenGraph + JSON-LD Movie Schema.
       * Nota verificada: og:title a veces trae un lema promocional, por lo que el
       * nombre del JSON-LD Movie tiene prioridad cuando existe.
       */
      extractMetadata(html, url) {
        const $ = cheerio13.load(html);
        const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() || "";
        const ogImage = $('meta[property="og:image"]').attr("content");
        const poster_url = ogImage ? this.resolveRelativeUrl(ogImage, url) : void 0;
        const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || "";
        let ldName = "";
        let ldGenre = "";
        let ldRating = 0;
        let ldYear = 0;
        try {
          $('script[type="application/ld+json"]').each((_, el) => {
            const json = JSON.parse($(el).text());
            const nodes = Array.isArray(json) ? json : [json];
            for (const node of nodes) {
              if (node && node["@type"] === "Movie") {
                ldName = (node.name || "").trim();
                ldGenre = Array.isArray(node.genre) ? node.genre.join(", ") : node.genre || "";
                if (node.aggregateRating?.ratingValue) {
                  ldRating = parseFloat(node.aggregateRating.ratingValue) || 0;
                }
                if (node.datePublished) {
                  ldYear = parseInt(String(node.datePublished).slice(0, 4), 10) || 0;
                }
              }
            }
          });
        } catch {
        }
        const titleTag = $("title").text().replace(/\s*\|\s*TubePelis\s*$/i, "").trim();
        const title = ldName || ogTitle || $("h1").first().clone().children().remove().end().text().trim() || titleTag || "Pel\xEDcula TubePelis";
        const yearMatch = html.match(/[（(](19|20)(\d{2})[)）]/) || titleTag.match(/(19|20)(\d{2})/) || ogDesc.match(/(19|20)(\d{2})/);
        const matchedYear = yearMatch?.[0].match(/(?:19|20)\d{2}/)?.[0];
        const year = ldYear || (matchedYear ? parseInt(matchedYear, 10) : 0);
        const genres = [];
        if (ldGenre) {
          ldGenre.split(",").forEach((g) => {
            const clean = g.trim();
            if (clean && !genres.includes(clean)) genres.push(clean);
          });
        }
        if (genres.length === 0) {
          const keywords = $('meta[name="keywords"]').attr("content") || "";
          keywords.split(",").forEach((g) => {
            const clean = g.trim();
            if (clean && !/pelicula|online|gratis|ver|descargar|hd/i.test(clean) && !genres.includes(clean) && genres.length < 5) {
              genres.push(clean);
            }
          });
        }
        return {
          title,
          description: ogDesc || $('meta[name="description"]').attr("content")?.trim() || "",
          poster_url,
          banner_url: poster_url,
          genres,
          rating: ldRating || 7,
          year,
          content_type: "movie"
        };
      }
      /**
       * Episodios (TubePelis es solo películas; se mantiene por contrato BaseAdapter).
       * Escanea enlaces típicos de serie/capítulo si el sitio los llegara a añadir.
       */
      extractEpisodes(html, baseUrl) {
        const $ = cheerio13.load(html);
        const episodes = [];
        const seen = /* @__PURE__ */ new Set();
        $("a[href*='/ver/'], a[href*='/serie/'], a[href*='/capitulo/']").each((_, el) => {
          const href = $(el).attr("href");
          if (!href || seen.has(href)) return;
          seen.add(href);
          const fullUrl = this.resolveRelativeUrl(href, baseUrl);
          const linkText = $(el).text().replace(/\s+/g, " ").trim();
          const numberMatch = fullUrl.match(/(?:temporada-?|capitulo-?|episodio-?)(\d+)/i) || linkText.match(/(\d+)/);
          const number = numberMatch ? parseInt(numberMatch[1], 10) : episodes.length + 1;
          episodes.push({
            number,
            title: linkText || `Episodio ${number}`,
            url: fullUrl,
            server_name: "TubePelis"
          });
        });
        return episodes.sort((a, b) => a.number - b.number);
      }
      /**
       * CRÍTICO: decodifica los parámetros `v=` del proxy interno reproductor.php.
       * Cadena verificada contra el sitio real:
       *   data-src="https://www.tubepelis.com/reproductor.php?v=aHR0cHM6...%3D"
       *   → URL-decode (%3D → =) → Base64 decode → embed final (ej. https://voe.sx/...)
       */
      decodeReproductorParam(html) {
        const decoded = [];
        const regex = /reproductor\.php\?(?:[^"'>\s]*&)?v=([A-Za-z0-9+/=%]+)/gi;
        let m;
        while ((m = regex.exec(html)) !== null) {
          try {
            const urlDecoded = decodeURIComponent(m[1]);
            const base64Decoded = Buffer.from(urlDecoded, "base64").toString("utf-8").trim();
            if (/^https?:\/\//i.test(base64Decoded) && !decoded.includes(base64Decoded)) {
              decoded.push(base64Decoded);
            }
          } catch {
          }
        }
        return decoded;
      }
      /**
       * Recolecta los embeds jugables del HTML del reproductor:
       * 1. iframes del player (atributo data-src o src) que apuntan al proxy
       *    interno reproductor.php?v=... → decodifica el Base64 a su embed real.
       * 2. iframes del player con embed directo (mp4/HLS/host externo) sin proxy.
       * 3. fallback: escaneo de todo el HTML por reproductor.php (scripts/otros attrs).
       */
      extractPlayerEmbeds(html) {
        const $ = cheerio13.load(html);
        const embeds = [];
        $("iframe").each((_, el) => {
          const src = ($(el).attr("data-src") || $(el).attr("src") || "").trim();
          if (!/^https?:\/\//i.test(src)) return;
          if (/reproductor\.php/i.test(src)) {
            for (const decoded of this.decodeReproductorParam(src)) {
              if (!embeds.includes(decoded)) embeds.push(decoded);
            }
          } else if (!embeds.includes(src)) {
            embeds.push(src);
          }
        });
        for (const decoded of this.decodeReproductorParam(html)) {
          if (!embeds.includes(decoded)) embeds.push(decoded);
        }
        return embeds;
      }
      /**
       * Núcleo puro (sin fetch) de extracción de streams desde un HTML:
       * decodifica reproductor.php?v= → resuelve embeds → valida con MediaValidator.
       */
      async resolveStreamsFromHtml(html) {
        const embedUrls = this.extractPlayerEmbeds(html);
        if (embedUrls.length === 0) {
          return { stream_url: "", all_available_streams: [] };
        }
        const resolutions = await Promise.all(
          embedUrls.map(async (embedUrl) => {
            try {
              return { embedUrl, resolved: await EmbedResolvers.resolve(embedUrl) };
            } catch {
              return { embedUrl, resolved: "" };
            }
          })
        );
        const candidates = [];
        for (const { embedUrl, resolved } of resolutions) {
          const candidate = resolved || embedUrl;
          if (candidate.startsWith("http") && !isDeadOrBlocked4(candidate) && !candidates.includes(candidate)) {
            candidates.push(candidate);
          }
        }
        const validStreams = await MediaValidator.validateUrls(candidates);
        const finalStreams = (validStreams.length > 0 ? validStreams : candidates).filter((s) => !isDeadOrBlocked4(s));
        return {
          stream_url: finalStreams[0] || "",
          all_available_streams: finalStreams
        };
      }
      async analyze(input, explicitType) {
        const cleanInput = input.trim();
        if (!/^https?:\/\//i.test(cleanInput)) {
          const catalogItems = await this.search(cleanInput);
          return {
            page_type: "catalog",
            content_type: "movie",
            title: `B\xFAsqueda TubePelis: ${cleanInput}`,
            description: `Resultados de b\xFAsqueda en TubePelis (${catalogItems.length} t\xEDtulos)`,
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "tubepelis.com",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const path7 = new URL(cleanInput).pathname.toLowerCase();
        if (explicitType === "catalog" || path7 === "/" || /^\/(buscar|categoria|categorias|letra)\//.test(path7)) {
          const html2 = await this.fetchHtml(BASE_URL7, 1e4);
          const catalogItems = html2 ? this.extractCatalogItems(html2) : [];
          return {
            page_type: "catalog",
            content_type: "movie",
            title: "Cat\xE1logo de Pel\xEDculas - TubePelis",
            description: `Cat\xE1logo completo de pel\xEDculas en TubePelis (${catalogItems.length} t\xEDtulos)`,
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            source_domain: "tubepelis.com",
            episodes: [],
            catalog_items: catalogItems
          };
        }
        const html = await this.fetchHtml(cleanInput, 1e4);
        if (!html) {
          return {
            page_type: "detail",
            content_type: "movie",
            title: "Pel\xEDcula TubePelis",
            description: "No se pudo cargar la p\xE1gina",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Desconocido",
            genres: [],
            source_domain: "tubepelis.com",
            episodes: [],
            catalog_items: []
          };
        }
        const metadata = this.extractMetadata(html, cleanInput);
        const extractedEpisodes = this.extractEpisodes(html, cleanInput);
        const episodes = extractedEpisodes.length > 0 ? extractedEpisodes : [{ number: 1, title: metadata.title || "Pelicula Completa", url: cleanInput, server_name: "TubePelis" }];
        let detectedStreams;
        if (!explicitType || explicitType === "stream" || explicitType === "auto") {
          try {
            const result = await this.resolveStreamsFromHtml(html);
            detectedStreams = result.all_available_streams.length > 0 ? result.all_available_streams : void 0;
          } catch {
          }
        }
        return {
          page_type: "detail",
          content_type: metadata.content_type,
          title: metadata.title,
          description: metadata.description,
          poster_url: metadata.poster_url || null,
          banner_url: metadata.banner_url || null,
          rating: metadata.rating,
          year: metadata.year,
          status: "Publicado",
          genres: metadata.genres,
          source_domain: "tubepelis.com",
          detected_streams: detectedStreams,
          episodes,
          catalog_items: [],
          raw_metadata: {
            og: {
              title: metadata.title,
              description: metadata.description,
              image: metadata.poster_url || ""
            }
          }
        };
      }
      /**
       * Extrae streams de una página de película:
       * 1. Si la URL ya es un reproductor.php?v=..., decodifica directo.
       * 2. Si no, descarga el HTML y decodifica todos los v= encontrados.
       * 3. Resuelve cada embed con EmbedResolvers y valida con MediaValidator.
       */
      async extractStream(targetUrl) {
        const cleanUrl2 = targetUrl.trim();
        if (/reproductor\.php\?/i.test(cleanUrl2) && /[?&]v=/i.test(cleanUrl2)) {
          const html2 = `<iframe src="${cleanUrl2}"></iframe>`;
          const result2 = await this.resolveStreamsFromHtml(html2);
          return {
            stream_url: result2.stream_url || cleanUrl2,
            all_available_streams: result2.all_available_streams.length > 0 ? result2.all_available_streams : [cleanUrl2]
          };
        }
        const html = await this.fetchHtml(cleanUrl2, 12e3);
        if (!html) {
          return { stream_url: cleanUrl2, all_available_streams: [cleanUrl2] };
        }
        const $ = cheerio13.load(html);
        const title = $('script[type="application/ld+json"]').map((_, el) => {
          try {
            const json = JSON.parse($(el).text());
            const nodes = Array.isArray(json) ? json : [json];
            const movie = nodes.find((n) => n?.["@type"] === "Movie");
            return movie?.name || "";
          } catch {
            return "";
          }
        }).get().find(Boolean) || $("h1").first().clone().children().remove().end().text().trim() || void 0;
        const result = await this.resolveStreamsFromHtml(html);
        if (result.all_available_streams.length === 0) {
          const genericStreams = await super.extractStream(cleanUrl2);
          return { ...genericStreams, title };
        }
        return {
          stream_url: result.stream_url || cleanUrl2,
          all_available_streams: result.all_available_streams,
          title
        };
      }
      titleFromSlug(slug) {
        return slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim();
      }
    };
  }
});

// server/scrapers/adapters/HiAnimesAdapter.ts
function emptyResult(contentType = "anime") {
  return {
    page_type: "detail",
    content_type: contentType,
    title: "",
    description: "",
    poster_url: null,
    banner_url: null,
    rating: 0,
    year: 0,
    status: "",
    genres: [],
    episodes: [],
    catalog_items: []
  };
}
var BASE_URL8, PAGE_SIZE, HiAnimesAdapter;
var init_HiAnimesAdapter = __esm({
  "server/scrapers/adapters/HiAnimesAdapter.ts"() {
    "use strict";
    init_BaseAdapter();
    init_resolvers();
    init_zokoanimeResolver();
    init_hianimesResolver();
    init_resolutionMetadata();
    BASE_URL8 = "https://hianimes.se";
    PAGE_SIZE = 20;
    HiAnimesAdapter = class extends BaseScraperAdapter {
      id = "hianimes";
      name = "HiAnimes (API multi-host)";
      supportedDomains = ["hianimes.se"];
      canHandle(url) {
        return isHianimesUrl(url);
      }
      async analyze(input, explicitType) {
        const url = input.trim();
        if (explicitType === "stream" || isHianimesWatchUrl(url)) return this.analyzeWatch(url);
        if (explicitType === "catalog" || this.isCatalogUrl(url)) return this.analyzeCatalog(url);
        return this.analyzeDetail(url);
      }
      async extractStream(targetUrl) {
        const slug = hianimesSlugFromUrl(targetUrl);
        if (!slug) return { stream_url: targetUrl.trim(), all_available_streams: [targetUrl.trim()] };
        const { anime, episode } = await fetchHianimesEpisode(slug);
        if (!episode) return { stream_url: targetUrl.trim(), all_available_streams: [targetUrl.trim()], title: anime?.title };
        const candidates = [];
        for (const link of episodeLinks(episode)) {
          const resolved = await this.resolveCandidate(link.url);
          if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
          if (!candidates.includes(link.url)) candidates.push(link.url);
        }
        return {
          stream_url: candidates[0] || targetUrl.trim(),
          all_available_streams: candidates.length > 0 ? candidates : [targetUrl.trim()],
          title: episode.title || anime?.title
        };
      }
      async analyzeCatalog(url) {
        const parsed = new URL(url);
        const pageRaw = Number.parseInt(parsed.searchParams.get("page") || "1", 10);
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
        const type = this.catalogType(parsed.searchParams.get("type"));
        const response = await fetchHianimesFilter(page, PAGE_SIZE, type);
        if (!response) throw new Error(`FETCH_FAILED: ${url}`);
        const items = response.results.flatMap((raw) => {
          const anime = this.normalizeCatalogRecord(raw);
          return anime ? [anime] : [];
        });
        const nextPage = page < response.totalPages ? `${BASE_URL8}/filter?type=${encodeURIComponent(type)}&page=${page + 1}` : null;
        return {
          page_type: "catalog",
          content_type: type === "Movie" ? "movie" : "anime",
          title: `Cat\xE1logo ${type === "Movie" ? "de pel\xEDculas" : "de anime"} - HiAnimes`,
          description: "Cat\xE1logo paginado de HiAnimes mediante su API p\xFAblica.",
          poster_url: null,
          banner_url: null,
          rating: 0,
          year: 0,
          status: "",
          genres: [],
          episodes: [],
          catalog_items: items,
          next_page_url: nextPage
        };
      }
      async analyzeDetail(url) {
        const slug = this.detailSlug(url);
        if (!slug) return emptyResult();
        const anime = await fetchHianimesAnime(slug);
        if (!anime) return emptyResult();
        return this.detailResult(anime);
      }
      async analyzeWatch(url) {
        const slug = hianimesSlugFromUrl(url);
        if (!slug) return emptyResult();
        const { anime, episode } = await fetchHianimesEpisode(slug);
        if (!episode) return emptyResult(anime?.type?.toLowerCase() === "movie" ? "movie" : "anime");
        const resolved = await this.extractStream(url);
        const sourceEpisodes = {
          number: episode.episodeNumber,
          title: episode.title,
          url,
          source_type: "hianimes",
          server_name: "HiAnimes",
          sources: episodeLinks(episode).map((link) => ({
            url: link.url,
            source_site: this.hostOf(link.url),
            link_type: classifySourceKind(link.url) === "embed" ? "embed" : classifySourceKind(link.url) === "page" ? "page" : "direct",
            language: link.language,
            ...link.language === "sub" ? { audio_language: "ja", subtitle_language: "en" } : { audio_language: "en" },
            host: this.hostOf(link.url),
            // Resolver la variante primaria no acredita automáticamente todos los
            // hosts sub/dub; cada SourceLink se verifica de forma independiente en
            // la recuperación/JIT.
            is_verified: false
          }))
        };
        return {
          page_type: "direct_stream",
          content_type: anime?.type?.toLowerCase() === "movie" ? "movie" : "anime",
          title: anime?.title || episode.title,
          description: anime?.synopsis || "",
          poster_url: anime?.image || null,
          banner_url: anime?.landscapeImage || null,
          rating: this.numeric(anime?.score),
          year: this.year(anime?.aired),
          status: anime?.status || "",
          genres: anime?.genres || [],
          detected_streams: resolved.all_available_streams,
          episodes: [sourceEpisodes],
          catalog_items: []
        };
      }
      detailResult(anime) {
        const episodes = anime.episodes.map((episode) => this.episodeToExtracted(episode));
        const isMovie = (anime.type || "").toLowerCase() === "movie";
        return {
          page_type: "detail",
          content_type: isMovie ? "movie" : "anime",
          title: anime.title,
          original_title: anime.englishTitle || anime.japaneseTitle || null,
          japanese_title: anime.japaneseTitle || null,
          english_title: anime.englishTitle || null,
          description: anime.synopsis || "",
          poster_url: anime.image || null,
          banner_url: anime.landscapeImage || null,
          rating: this.numeric(anime.score),
          year: this.year(anime.aired),
          status: anime.status || "",
          genres: anime.genres,
          episodes,
          catalog_items: []
        };
      }
      episodeToExtracted(episode) {
        return {
          number: episode.episodeNumber,
          title: episode.title,
          url: `${BASE_URL8}/watch/${encodeURIComponent(episode.slug)}`,
          source_type: "hianimes",
          server_name: "HiAnimes",
          sources: episodeLinks(episode).map((link) => ({
            url: link.url,
            source_site: this.hostOf(link.url),
            link_type: classifySourceKind(link.url) === "embed" ? "embed" : classifySourceKind(link.url) === "page" ? "page" : "direct",
            language: link.language,
            ...link.language === "sub" ? { audio_language: "ja", subtitle_language: "en" } : { audio_language: "en" },
            host: this.hostOf(link.url),
            is_verified: false
          }))
        };
      }
      async resolveCandidate(url) {
        if (url.includes("zokoanime.video")) {
          const zoko = await resolveZokoAnime(url);
          return zoko.url || url;
        }
        const resolved = await EmbedResolvers.resolve(url);
        return resolved || url;
      }
      isCatalogUrl(url) {
        try {
          return new URL(url).pathname.toLowerCase().startsWith("/filter");
        } catch {
          return false;
        }
      }
      detailSlug(url) {
        try {
          const parts = new URL(url).pathname.split("/").filter(Boolean);
          const index = parts.findIndex((part) => part.toLowerCase() === "details" || part.toLowerCase() === "anime");
          return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : void 0;
        } catch {
          return void 0;
        }
      }
      catalogType(value) {
        const normalized = (value || "All").trim().toLowerCase();
        if (normalized === "movie" || normalized === "movies") return "Movie";
        if (normalized === "tv" || normalized === "series") return "TV";
        return "All";
      }
      normalizeCatalogRecord(raw) {
        const title = this.firstString(raw.title, raw.English, raw.Japanese, raw.slug);
        const slug = this.firstString(raw.slug, Array.isArray(raw.slugs) ? raw.slugs[0] : void 0);
        if (!title || !slug) return null;
        const type = this.firstString(raw.Type).toLowerCase();
        return {
          title,
          url: `${BASE_URL8}/details/${encodeURIComponent(slug)}`,
          image_url: this.firstString(raw.image, raw.landScapeImage) || null,
          kind: type === "movie" ? "movie" : "anime",
          year: this.year(this.firstString(raw.Aired)),
          rating: this.numeric(this.firstString(raw.Score)),
          genres: Array.isArray(raw.genres) ? raw.genres.filter((genre) => typeof genre === "string") : []
        };
      }
      firstString(...values) {
        return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() || "";
      }
      numeric(value) {
        const parsed = Number.parseFloat(value || "");
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      }
      year(value) {
        const match = value?.match(/\b(19|20)\d{2}\b/);
        return match ? Number.parseInt(match[0], 10) : 0;
      }
      hostOf(url) {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return "hianimes.se";
        }
      }
    };
  }
});

// server/scrapers/ScraperManager.ts
var ScraperManager;
var init_ScraperManager = __esm({
  "server/scrapers/ScraperManager.ts"() {
    "use strict";
    init_DirectStreamAdapter();
    init_ArchiveOrgAdapter();
    init_TvMazeAdapter();
    init_AnimeFlvAdapter();
    init_GenericAdapter();
    init_LaMovieAdapter();
    init_LatAnimeAdapter();
    init_TioAnimeAdapter();
    init_TioPlusAdapter();
    init_CinecalidadAdapter();
    init_VerAnimesAdapter();
    init_DoramasflixAdapter();
    init_TubePelisAdapter();
    init_HiAnimesAdapter();
    ScraperManager = class _ScraperManager {
      static instance;
      adapters = [];
      fallbackAdapter;
      constructor() {
        this.fallbackAdapter = new GenericAdapter();
        this.registerAdapter(new DirectStreamAdapter());
        this.registerAdapter(new ArchiveOrgAdapter());
        this.registerAdapter(new TvMazeAdapter());
        this.registerAdapter(new AnimeFlvAdapter());
        this.registerAdapter(new LaMovieAdapter());
        this.registerAdapter(new LatAnimeAdapter());
        this.registerAdapter(new TioAnimeAdapter());
        this.registerAdapter(new TioPlusAdapter());
        this.registerAdapter(new TubePelisAdapter());
        this.registerAdapter(new CinecalidadAdapter());
        this.registerAdapter(new VerAnimesAdapter());
        this.registerAdapter(new DoramasflixAdapter());
        this.registerAdapter(new HiAnimesAdapter());
      }
      static getInstance() {
        if (!_ScraperManager.instance) {
          _ScraperManager.instance = new _ScraperManager();
        }
        return _ScraperManager.instance;
      }
      /**
       * Registra un nuevo adaptador en el pool de scrapers
       */
      registerAdapter(adapter) {
        const existingIndex = this.adapters.findIndex((a) => a.id === adapter.id);
        if (existingIndex >= 0) {
          this.adapters[existingIndex] = adapter;
        } else {
          this.adapters.push(adapter);
        }
      }
      /**
       * Obtiene el adaptador más adecuado para una URL específica.
       */
      getAdapter(url, explicitAdapterId) {
        if (explicitAdapterId) {
          const explicit = this.adapters.find((a) => a.id === explicitAdapterId);
          if (explicit) return explicit;
        }
        const matched = this.adapters.find((a) => a.canHandle(url));
        return matched || this.fallbackAdapter;
      }
      /**
       * Obtiene un adaptador por su identificador único
       */
      getAdapterById(id) {
        return this.adapters.find((a) => a.id === id) || (this.fallbackAdapter.id === id ? this.fallbackAdapter : void 0);
      }
      /**
       * Lista todos los adaptadores disponibles y sus dominios soportados
       */
      getAvailableAdapters() {
        const list = this.adapters.map((a) => ({
          id: a.id,
          name: a.name,
          supportedDomains: a.supportedDomains
        }));
        list.push({
          id: this.fallbackAdapter.id,
          name: this.fallbackAdapter.name,
          supportedDomains: this.fallbackAdapter.supportedDomains
        });
        return list;
      }
      /**
       * Ejecuta el análisis universal delegando al adaptador correspondiente
       */
      async analyze(url, explicitType, explicitAdapterId) {
        const adapter = this.getAdapter(url, explicitAdapterId);
        return adapter.analyze(url, explicitType);
      }
      /**
       * Extrae streams Just-In-Time delegando al adaptador
       */
      async extractStream(url, explicitAdapterId) {
        const adapter = this.getAdapter(url, explicitAdapterId);
        return adapter.extractStream(url);
      }
      /**
       * Extrae listado de catálogo delegando al adaptador
       */
      async extractCatalog(catalogUrl, explicitAdapterId) {
        const result = await this.analyze(catalogUrl, "catalog", explicitAdapterId);
        return result.catalog_items || [];
      }
    };
  }
});

// server/catalogIntegrity.ts
function canonicalCatalogUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const url = new URL(rawUrl.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
    }
    const path7 = url.pathname.replace(/\/{2,}/g, "/");
    url.pathname = path7.length > 1 ? path7.replace(/\/$/, "") : "/";
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}
function dedupeCatalogItems(items) {
  const byUrl = /* @__PURE__ */ new Map();
  for (const item of items || []) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
    const key = canonicalCatalogUrl(item.url);
    const previous = byUrl.get(key);
    if (!previous) {
      byUrl.set(key, item);
      continue;
    }
    const merged = { ...previous };
    for (const [field, value] of Object.entries(item)) {
      const oldValue = merged[field];
      if ((oldValue === void 0 || oldValue === null || oldValue === "") && value !== void 0 && value !== null && value !== "") {
        merged[field] = value;
      }
    }
    byUrl.set(key, merged);
  }
  return [...byUrl.values()];
}
function catalogPageFingerprint(items) {
  return dedupeCatalogItems(items).map((item) => canonicalCatalogUrl(item.url)).sort().join("|");
}
function isRepeatedCatalogPage(items, previousFingerprint) {
  const fingerprint = catalogPageFingerprint(items);
  return Boolean(fingerprint) && fingerprint === previousFingerprint;
}
var TRACKING_PARAMETERS;
var init_catalogIntegrity = __esm({
  "server/catalogIntegrity.ts"() {
    "use strict";
    TRACKING_PARAMETERS = /^(utm_|fbclid$|gclid$|ref$|referrer$)/i;
  }
});

// server/universalScraper.ts
var universalScraper_exports = {};
__export(universalScraper_exports, {
  PRESET_SOURCES: () => PRESET_SOURCES,
  analyzeUniversalUrl: () => analyzeUniversalUrl,
  extractCatalogListing: () => extractCatalogListing,
  extractCatalogListingsBatch: () => extractCatalogListingsBatch,
  extractStreamFromUrl: () => extractStreamFromUrl,
  getActivePresets: () => getActivePresets,
  getCustomPresetOverrides: () => getCustomPresetOverrides,
  resetCustomPresetOverride: () => resetCustomPresetOverride,
  saveCustomPresetOverride: () => saveCustomPresetOverride,
  scraperManager: () => scraperManager
});
function getCustomPresetOverrides() {
  try {
    if (import_fs2.default.existsSync(PRESET_OVERRIDES_PATH)) {
      const data = import_fs2.default.readFileSync(PRESET_OVERRIDES_PATH, "utf-8");
      return JSON.parse(data) || {};
    }
  } catch (e) {
    console.error("Error leyendo custom_presets.json:", e);
  }
  return {};
}
function saveCustomPresetOverride(presetId, url) {
  try {
    const current = getCustomPresetOverrides();
    if (!url || !url.trim()) {
      delete current[presetId];
    } else {
      current[presetId] = url.trim();
    }
    const dir = import_path2.default.dirname(PRESET_OVERRIDES_PATH);
    if (!import_fs2.default.existsSync(dir)) import_fs2.default.mkdirSync(dir, { recursive: true });
    import_fs2.default.writeFileSync(PRESET_OVERRIDES_PATH, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando custom_presets.json:", e);
  }
}
function resetCustomPresetOverride(presetId) {
  try {
    const current = getCustomPresetOverrides();
    delete current[presetId];
    import_fs2.default.writeFileSync(PRESET_OVERRIDES_PATH, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {
    console.error("Error restableciendo custom_presets.json:", e);
  }
}
function getActivePresets() {
  const overrides = getCustomPresetOverrides();
  return PRESET_SOURCES.map((p) => ({
    ...p,
    original_url: p.example_url,
    is_custom: Boolean(overrides[p.id]),
    example_url: overrides[p.id] || p.example_url
  }));
}
async function analyzeUniversalUrl(input, explicitType, explicitAdapterId) {
  return scraperManager.analyze(input, explicitType, explicitAdapterId);
}
async function extractStreamFromUrl(targetUrl, explicitAdapterId) {
  return scraperManager.extractStream(targetUrl, explicitAdapterId);
}
async function extractCatalogListing(catalogUrl, explicitAdapterId) {
  return scraperManager.extractCatalog(catalogUrl, explicitAdapterId);
}
async function extractCatalogListingsBatch(pageUrls, opts = {}) {
  const concurrency = Math.max(1, Math.min(8, Math.round(opts.concurrency ?? 3)));
  const results = new Array(pageUrls.length);
  let cursor = 0;
  const worker = async () => {
    for (; ; ) {
      const idx = cursor++;
      if (idx >= pageUrls.length) return;
      const url = pageUrls[idx];
      try {
        if (opts.beforeRequest) await opts.beforeRequest();
        const items = await extractCatalogListing(url, opts.explicitAdapterId);
        results[idx] = { page_url: url, items: dedupeCatalogItems(items || []), error: null };
      } catch (e) {
        results[idx] = { page_url: url, items: [], error: String(e?.message || e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pageUrls.length) }, () => worker()));
  return results;
}
var import_fs2, import_path2, PRESET_SOURCES, scraperManager, PRESET_OVERRIDES_PATH;
var init_universalScraper = __esm({
  "server/universalScraper.ts"() {
    "use strict";
    import_fs2 = __toESM(require("fs"), 1);
    import_path2 = __toESM(require("path"), 1);
    init_ScraperManager();
    init_catalogIntegrity();
    PRESET_SOURCES = [
      {
        id: "doramas-doramasflix",
        name: "Doramasflix (Doramas / K-Dramas)",
        category: "series",
        description: "Cat\xE1logo completo de doramas, K-Dramas y series asi\xE1ticas con servidores Primeload/Filemoon/VOE.",
        example_url: "https://doramasflix.io/doramas",
        icon: "Tv"
      },
      {
        id: "movies-doramasflix",
        name: "Doramasflix Pel\xEDculas",
        category: "movies",
        description: "Pel\xEDculas asi\xE1ticas en espa\xF1ol latino y sub espa\xF1ol.",
        example_url: "https://doramasflix.io/peliculas",
        icon: "Film"
      },
      {
        id: "variety-doramasflix",
        name: "Doramasflix Variedades",
        category: "series",
        description: "Programas de variedad y TV shows asi\xE1ticos.",
        example_url: "https://doramasflix.io/variedades",
        icon: "Layers"
      },
      {
        id: "anime-animeflv",
        name: "AnimeFLV Cat\xE1logo (Anime Espa\xF1ol)",
        category: "anime",
        description: "Directorio /browse de animes con temporadas completas y servidores multi-fuente.",
        example_url: "https://www3.animeflv.net/browse",
        icon: "Tv"
      },
      {
        id: "anime-hianimes",
        name: "HiAnimes Cat\xE1logo (Anime multi-host)",
        category: "anime",
        description: "Cat\xE1logo paginado v\xEDa API p\xFAblica con servidores separados para subt\xEDtulos y doblaje.",
        example_url: "https://hianimes.se/filter?type=All&page=1",
        icon: "Tv"
      },
      {
        id: "movies-lamovie",
        name: "LaMovie Cat\xE1logo (Pel\xEDculas Latino)",
        category: "movies",
        description: "Cat\xE1logo paginado v\xEDa API wp-api/v1; fichas con embeds multi-servidor.",
        example_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24",
        icon: "Film"
      },
      {
        id: "series-lamovie",
        name: "LaMovie Series (TV)",
        category: "series",
        description: "1,089 series de TV v\xEDa API wp-api/v1 (postType=tvshows); items con p\xF3ster/g\xE9neros/imdb.",
        example_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24",
        icon: "Layers"
      },
      {
        id: "anime-lamovie",
        name: "LaMovie Animes",
        category: "anime",
        description: "970 animes v\xEDa API wp-api/v1 (postType=animes); items con p\xF3ster/g\xE9neros/imdb.",
        example_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24",
        icon: "Tv"
      },
      {
        id: "movies-cinecalidad",
        name: "Cinecalidad Cat\xE1logo (HD)",
        category: "movies",
        description: "Home-listado de pel\xEDculas en calidad HD con streams Goodstream/HLS directos.",
        example_url: "https://www.cinecalidad.am/",
        icon: "Film"
      },
      {
        id: "movies-tubepelis",
        name: "TubePelis Cat\xE1logo (Castellano)",
        category: "movies",
        description: "Listado de pel\xEDculas; fichas con servidores Byse cifrados AES-256-GCM descifrados JIT.",
        example_url: "https://www.tubepelis.com/peliculas.html",
        icon: "Film"
      },
      {
        id: "movies-tioplus",
        name: "TioPlus Cat\xE1logo (Multi-Fuente)",
        category: "movies",
        description: "Directorio paginado de pel\xEDculas con m\xFAltiples servidores embebidos.",
        example_url: "https://tioplus.app/peliculas",
        icon: "Film"
      },
      {
        id: "anime-latanime",
        name: "LatAnime Cat\xE1logo (Sub/Latino)",
        category: "anime",
        description: "Directorio completo de animes; episodios MP4Upload con Referer forzado.",
        example_url: "https://latanime.org/animes",
        icon: "Tv"
      },
      {
        id: "anime-tioanime",
        name: "TioAnime Cat\xE1logo (Multi-Servidor)",
        category: "anime",
        description: "Directorio completo; embeds Mega/YourUpload/ok.ru priorizados sobre ef\xEDmeros.",
        example_url: "https://tioanime.com/directorio",
        icon: "Tv"
      },
      {
        id: "anime-veranimes",
        name: "VerAnimes Cat\xE1logo (Espejo WWV)",
        category: "anime",
        description: "Directorio completo; StreamWish con failover autom\xE1tico a embed si el CDN cae.",
        example_url: "https://wwv.veranimes.net/animes",
        icon: "Tv"
      },
      {
        id: "series-tvmaze",
        name: "TV Shows Internacionales (TVMaze)",
        category: "series",
        description: "Series de televisi\xF3n mundiales con temporadas, sinopsis, reparto y fechas oficiales.",
        example_url: "https://www.tvmaze.com/shows/169/breaking-bad",
        icon: "Layers"
      },
      {
        id: "archive-org",
        name: "Internet Archive (Cine y Multimedia Libre)",
        category: "archive",
        description: "Pel\xEDculas cl\xE1sicas de dominio p\xFAblico, animaci\xF3n y documentales con streams directos MP4/HLS.",
        // Defecto #22: night_of_the_living_dead fue oscurecido por Archive.org
        // (is_dark desde 2025-02): sin archivos y con .mp4 inventado que da 403.
        example_url: "https://archive.org/details/his_girl_friday",
        icon: "Database"
      },
      {
        id: "open-hls",
        name: "Direct HLS Stream (.m3u8)",
        category: "direct",
        description: "Enlace directo de manifiesto HLS adaptativo con soporte de m\xFAltiples resoluciones.",
        example_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        icon: "Play"
      },
      {
        id: "open-mp4",
        name: "Direct Video File (.mp4 / .webm)",
        category: "direct",
        description: "Enlace directo a archivo de video accesible por HTTP/HTTPS.",
        example_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
        icon: "Sparkles"
      }
    ];
    scraperManager = ScraperManager.getInstance();
    PRESET_OVERRIDES_PATH = import_path2.default.join(process.cwd(), "prisma", "custom_presets.json");
  }
});

// server.ts
var server_exports = {};
__export(server_exports, {
  buildMultiSourceCascade: () => buildMultiSourceCascade,
  handlePlayEpisode: () => handlePlayEpisode
});
module.exports = __toCommonJS(server_exports);
var import_config3 = require("dotenv/config");
var import_promises3 = __toESM(require("dns/promises"), 1);
var import_express4 = __toESM(require("express"), 1);
var import_cors = __toESM(require("cors"), 1);
var import_path6 = __toESM(require("path"), 1);
init_universalScraper();
init_metadataEngine();

// server/taskWorker.ts
init_universalScraper();

// server/db.ts
var import_client = require("@prisma/client");
init_metadataEngine();
var import_config2 = require("dotenv/config");
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./dev.db";
}
var prisma = new import_client.PrismaClient();
function normalizeTitle(title) {
  if (!title) return "";
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}
function normalizeBaseTitle(title) {
  if (!title) return "";
  return normalizeTitle(parseTitleQuery(title).baseTitle);
}

// server/writeBuffer.ts
var import_fs3 = __toESM(require("fs"), 1);
var import_path3 = __toESM(require("path"), 1);
var DEFAULT_BUFFER_PATH = import_path3.default.join(process.cwd(), "data", "write-buffer.jsonl");
var bufferPath = DEFAULT_BUFFER_PATH;
var MAX_ATTEMPTS = 5;
var RAM_SOFT_LIMIT = 500;
var ramQueue = [];
var isWriting = false;
var totalEnqueued = 0;
var totalApplied = 0;
var totalFailed = 0;
var pendingSourceLinkKeys = /* @__PURE__ */ new Set();
function sourceLinkKey(op) {
  return [
    op.episodeRef.media_item_id,
    op.episodeRef.season_number,
    op.episodeRef.episode_number,
    String(op.data.source_site || "unknown"),
    String(op.data.url || "")
  ].join("\0");
}
function releasePendingSourceLink(op) {
  if (op.kind === "sourceLink.create") pendingSourceLinkKeys.delete(sourceLinkKey(op));
}
function generateId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${timestamp}${random}`;
}
function enqueueWrite(op) {
  const full = { ...op, fp: `${op.kind}:${JSON.stringify(op)}`, attempts: 0, at: (/* @__PURE__ */ new Date()).toISOString() };
  if (full.kind === "sourceLink.create") {
    const key = sourceLinkKey(full);
    if (pendingSourceLinkKeys.has(key)) return false;
    pendingSourceLinkKeys.add(key);
  }
  ramQueue.push(full);
  totalEnqueued++;
  return true;
}
function enqueueShowCreate(data) {
  const id = generateId();
  enqueueWrite({ kind: "show.create", id, data: { ...data, id } });
  return id;
}
function enqueueMediaItemCreate(data) {
  const id = generateId();
  enqueueWrite({ kind: "mediaItem.create", id, data: { ...data, id } });
  return id;
}
function enqueueEpisodeCreateMany(showId, episodes) {
  enqueueWrite({ kind: "episode.createMany", showId, data: episodes });
}
function enqueueShowUpdate(id, data) {
  enqueueWrite({ kind: "show.update", id, data });
}
function enqueueMediaItemUpdate(id, data) {
  enqueueWrite({ kind: "mediaItem.update", id, data });
}
function enqueueSourceLinkUpdate(id, data) {
  enqueueWrite({ kind: "sourceLink.update", id, data });
}
function ensureDir() {
  const dir = import_path3.default.dirname(bufferPath);
  if (!import_fs3.default.existsSync(dir)) import_fs3.default.mkdirSync({ recursive: true });
}
function flushRamToJsonl() {
  if (ramQueue.length === 0) return;
  ensureDir();
  const tmp = bufferPath + ".tmp";
  const existing = import_fs3.default.existsSync(bufferPath) ? import_fs3.default.readFileSync(bufferPath, "utf8") : "";
  import_fs3.default.writeFileSync(tmp, existing + ramQueue.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  import_fs3.default.renameSync(tmp, bufferPath);
  ramQueue = [];
}
function loadJsonlToRam() {
  if (!import_fs3.default.existsSync(bufferPath)) return;
  try {
    const ops = [];
    for (const line of import_fs3.default.readFileSync(bufferPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const op = JSON.parse(line);
        ops.push(op);
        if (op.kind === "sourceLink.create") {
          pendingSourceLinkKeys.add(sourceLinkKey(op));
        }
      } catch {
      }
    }
    if (ops.length > 0) {
      ramQueue.unshift(...ops);
      import_fs3.default.writeFileSync(bufferPath, "", "utf8");
    }
  } catch {
  }
}
async function applyOp(op) {
  switch (op.kind) {
    case "show.create": {
      try {
        await prisma.show.create({ data: op.data });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "show.update": {
      try {
        const exists = await prisma.show.findUnique({ where: { id: op.id }, select: { id: true } });
        if (!exists) return true;
        await prisma.show.update({ where: { id: op.id }, data: op.data });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "show.findOrCreate": {
      try {
        const existing = await prisma.show.findFirst({ where: op.where, select: { id: true } });
        if (existing) return true;
        await prisma.show.create({ data: op.create });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "mediaItem.create": {
      try {
        await prisma.mediaItem.create({ data: op.data });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "mediaItem.update": {
      try {
        const exists = await prisma.mediaItem.findUnique({ where: { id: op.id }, select: { id: true } });
        if (!exists) return true;
        await prisma.mediaItem.update({ where: { id: op.id }, data: op.data });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "episode.createMany": {
      try {
        await prisma.episode.createMany({ data: op.data, skipDuplicates: false });
      } catch (e) {
        if (e?.code === "P2002") {
          for (const ep of op.data) {
            try {
              await prisma.episode.create({ data: ep });
            } catch {
            }
          }
        } else {
          throw e;
        }
      }
      return true;
    }
    case "mediaEpisode.upsert": {
      try {
        await prisma.mediaEpisode.upsert({
          where: op.where,
          create: op.create,
          update: {}
        });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "sourceLink.create": {
      try {
        const ref = op.episodeRef;
        const episode = await prisma.mediaEpisode.upsert({
          where: {
            media_item_id_season_number_episode_number: ref
          },
          create: ref,
          update: {}
        });
        await prisma.sourceLink.create({
          data: { ...op.data, media_episode_id: episode.id }
        });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "sourceLink.update": {
      try {
        const exists = await prisma.sourceLink.findUnique({ where: { id: op.id }, select: { id: true } });
        if (!exists) return true;
        await prisma.sourceLink.update({ where: { id: op.id }, data: op.data });
      } catch (e) {
        if (e?.code === "P2002") return true;
        throw e;
      }
      return true;
    }
    case "crawlTask.update": {
      await prisma.crawlTask.update({ where: { id: op.id }, data: op.data });
      return true;
    }
    default:
      return true;
  }
}
async function writerLoop() {
  if (isWriting) return;
  isWriting = true;
  try {
    loadJsonlToRam();
    while (ramQueue.length > 0) {
      const op = ramQueue.shift();
      try {
        const ok = await applyOp(op);
        if (ok) {
          totalApplied++;
          releasePendingSourceLink(op);
        } else {
          op.attempts++;
          if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
          else {
            totalFailed++;
            releasePendingSourceLink(op);
          }
        }
      } catch {
        op.attempts++;
        if (op.attempts < MAX_ATTEMPTS) ramQueue.push(op);
        else {
          totalFailed++;
          releasePendingSourceLink(op);
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    isWriting = false;
  }
}
function startWriteBufferDrainer() {
  loadJsonlToRam();
  setInterval(() => {
    if (ramQueue.length > RAM_SOFT_LIMIT) {
      flushRamToJsonl();
    }
    const hasPersistedWrites = (() => {
      try {
        return import_fs3.default.existsSync(bufferPath) && import_fs3.default.statSync(bufferPath).size > 0;
      } catch {
        return false;
      }
    })();
    if (!isWriting && (ramQueue.length > 0 || hasPersistedWrites)) {
      writerLoop().catch(() => {
      });
    }
  }, 100).unref?.();
}
async function drainWriteBuffer() {
  const before = totalApplied;
  await writerLoop();
  return { applied: totalApplied - before, pending: ramQueue.length, failed: totalFailed };
}

// server/metadataBackfill.ts
init_metadataEngine();

// server/metadataMerge.ts
init_titleNormalizer();

// server/utils/genreNormalizer.ts
var KNOWN_GENRES_MAP = {
  accion: "Acci\xF3n",
  acci\u00F3n: "Acci\xF3n",
  action: "Acci\xF3n",
  aventura: "Aventura",
  adventure: "Aventura",
  animacion: "Animaci\xF3n",
  animaci\u00F3n: "Animaci\xF3n",
  animation: "Animaci\xF3n",
  anime: "Anime",
  comedia: "Comedia",
  comedy: "Comedia",
  crimen: "Crimen",
  crime: "Crimen",
  documental: "Documental",
  documentary: "Documental",
  drama: "Drama",
  familia: "Familia",
  familiar: "Familia",
  family: "Familia",
  fantasia: "Fantas\xEDa",
  fantas\u00EDa: "Fantas\xEDa",
  fantasy: "Fantas\xEDa",
  historia: "Historia",
  historico: "Historia",
  hist\u00F3rico: "Historia",
  history: "Historia",
  terror: "Terror",
  horror: "Terror",
  miedo: "Terror",
  musica: "M\xFAsica",
  m\u00FAsica: "M\xFAsica",
  musical: "M\xFAsica",
  music: "M\xFAsica",
  misterio: "Misterio",
  mystery: "Misterio",
  romance: "Romance",
  romantico: "Romance",
  rom\u00E1ntico: "Romance",
  "ciencia ficcion": "Ciencia Ficci\xF3n",
  "ciencia ficci\xF3n": "Ciencia Ficci\xF3n",
  "sci fi": "Ciencia Ficci\xF3n",
  "sci-fi": "Ciencia Ficci\xF3n",
  scifi: "Ciencia Ficci\xF3n",
  "science fiction": "Ciencia Ficci\xF3n",
  suspenso: "Suspenso",
  suspense: "Suspenso",
  thriller: "Suspenso",
  belica: "B\xE9lica",
  b\u00E9lica: "B\xE9lica",
  guerra: "B\xE9lica",
  war: "B\xE9lica",
  western: "Western",
  vaqueros: "Western",
  shonen: "Shonen",
  seinen: "Seinen",
  shojo: "Shojo",
  shoujo: "Shojo",
  isekai: "Isekai",
  ecchi: "Ecchi",
  mecha: "Mecha",
  sobrenatural: "Sobrenatural",
  supernatural: "Sobrenatural",
  psicologico: "Psicol\xF3gico",
  psicol\u00F3gico: "Psicol\xF3gico",
  psychological: "Psicol\xF3gico",
  "recuentos de la vida": "Recuentos de la vida",
  "slice of life": "Recuentos de la vida",
  deportes: "Deportes",
  sports: "Deportes",
  "artes marciales": "Artes Marciales",
  "martial arts": "Artes Marciales",
  superheroes: "Superh\xE9roes",
  superh\u00E9roes: "Superh\xE9roes",
  superheroe: "Superh\xE9roes",
  infantil: "Infantil",
  kids: "Infantil"
};
var JUNK_GENRE_TOKENS = /* @__PURE__ */ new Set([
  "multimedia",
  "directorio",
  "pelicula",
  "peliculas",
  "serie",
  "series",
  "ver",
  "online",
  "gratis",
  "hd",
  "latino",
  "castellano",
  "subtitulado",
  "completa",
  "estrenos",
  "estreno"
]);
function cleanGenreToken(token) {
  const norm = token.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (KNOWN_GENRES_MAP[norm]) {
    return KNOWN_GENRES_MAP[norm];
  }
  if (KNOWN_GENRES_MAP[token.trim().toLowerCase()]) {
    return KNOWN_GENRES_MAP[token.trim().toLowerCase()];
  }
  const t = token.trim();
  if (t.length <= 1) return "";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}
function formatAndNormalizeGenres(rawGenres, enrichedGenres) {
  if (Array.isArray(enrichedGenres) && enrichedGenres.length > 0) {
    const validEnriched = enrichedGenres.map((g) => cleanGenreToken(String(g))).filter((g) => g && !JUNK_GENRE_TOKENS.has(g.toLowerCase()));
    if (validEnriched.length > 0) {
      const rawStr = Array.isArray(rawGenres) ? rawGenres.join(",") : String(rawGenres || "").trim();
      const rawIsUnformatted = !rawStr || rawStr === "Multimedia" || !rawStr.includes(",") || rawStr.toLowerCase() === rawStr;
      if (rawIsUnformatted) {
        return Array.from(new Set(validEnriched)).join(", ");
      }
    }
  }
  if (!rawGenres) return "Multimedia";
  let tokens = [];
  if (Array.isArray(rawGenres)) {
    tokens = rawGenres.map((g) => String(g || "").trim()).filter(Boolean);
  } else if (typeof rawGenres === "string") {
    const str = rawGenres.trim();
    if (!str || str === "Multimedia") return "Multimedia";
    if (str.includes(",") || str.includes("/") || str.includes("|") || str.includes(";")) {
      tokens = str.split(/[,/|;]+/).map((s) => s.trim()).filter(Boolean);
    } else {
      const lower = str.toLowerCase();
      let remaining = lower;
      const foundCompounds = [];
      const compoundKeys = Object.keys(KNOWN_GENRES_MAP).filter((k) => k.includes(" "));
      for (const comp of compoundKeys) {
        if (remaining.includes(comp)) {
          foundCompounds.push(KNOWN_GENRES_MAP[comp]);
          remaining = remaining.replace(comp, " ");
        }
      }
      const words = remaining.split(/\s+/).map((w) => w.trim()).filter(Boolean);
      tokens = [...foundCompounds, ...words];
    }
  }
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  for (const token of tokens) {
    const cleaned = cleanGenreToken(token);
    const lowerNorm = cleaned.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!cleaned || JUNK_GENRE_TOKENS.has(lowerNorm) || seen.has(lowerNorm)) {
      continue;
    }
    seen.add(lowerNorm);
    result.push(cleaned);
  }
  return result.length > 0 ? result.join(", ") : "Multimedia";
}

// server/metadataMerge.ts
var PLACEHOLDER_DESCRIPTIONS = [
  /^contenido indexado en voidstream/i,
  /^sin descripción disponible\.?$/i,
  /^obra multimedia indexada\.?$/i,
  /^no se pudo cargar la página\.?$/i
];
var PLACEHOLDER_IMAGE_HOSTS = [/images\.unsplash\.com/i];
var TRAILING_ELLIPSIS_RE = /(?:\.{3,}|…)\s*$/;
var ELLIPSIS_ABBREV_RE = /(?:\b(?:etc|etc[eé]tera|vs|sr|sra|srta|dr|dra|ing|lic|av|apdo|ed|vol|n[uú]m|inc|ltd|ee\.?\s?uu|usa)\b\.?|(?:\b[a-z]\.){1,3}[a-z]\.?)$/i;
function endsWithTruncationEllipsis(value) {
  const t = String(value ?? "").replace(/\s+/g, " ").trimEnd();
  const m = t.match(TRAILING_ELLIPSIS_RE);
  if (!m || m.index === void 0) return false;
  return !ELLIPSIS_ABBREV_RE.test(t.slice(0, m.index).trimEnd());
}
function hasSubstantiveText(value) {
  const t = (value || "").trim();
  if (t.length < 12) return false;
  if (endsWithTruncationEllipsis(t)) return false;
  return !PLACEHOLDER_DESCRIPTIONS.some((p) => p.test(t));
}
function isUsableImage(value) {
  const t = (value || "").trim();
  if (!t) return false;
  return !PLACEHOLDER_IMAGE_HOSTS.some((p) => p.test(t));
}
function isPlausibleYear(year) {
  return typeof year === "number" && Number.isFinite(year) && year >= 1900 && year <= (/* @__PURE__ */ new Date()).getFullYear();
}
function applyEnrichmentGapFill(input, target, enriched) {
  if (!enriched) {
    target.genresStr = formatAndNormalizeGenres(input.genres || target.genresStr, null);
    if (isSlugLikeTitle(target.title)) {
      target.title = cleanSlugToWords(target.title);
    }
    return;
  }
  if (!target.malId && enriched.mal_id) target.malId = enriched.mal_id;
  if (!target.anilistId && enriched.anilist_id) target.anilistId = enriched.anilist_id;
  if (!target.japaneseTitle && enriched.japanese_title) {
    target.japaneseTitle = enriched.japanese_title;
  }
  if (!target.englishTitle && enriched.english_title) {
    target.englishTitle = enriched.english_title;
  }
  if (isSlugLikeTitle(target.title)) {
    if (enriched.title && !isSlugLikeTitle(enriched.title)) {
      target.title = enriched.title;
    } else {
      target.title = cleanSlugToWords(target.title);
    }
  }
  if (!hasSubstantiveText(input.description) && hasSubstantiveText(enriched.description)) {
    target.description = enriched.description;
  }
  if (!isUsableImage(target.posterUrl) && isUsableImage(enriched.poster_url)) {
    target.posterUrl = enriched.poster_url;
    if (!isUsableImage(target.bannerUrl) && isUsableImage(enriched.banner_url)) {
      target.bannerUrl = enriched.banner_url;
    }
  } else if (!isUsableImage(target.bannerUrl) && isUsableImage(enriched.banner_url)) {
    target.bannerUrl = enriched.banner_url;
  }
  if (!input.rating && enriched.rating) target.rating = enriched.rating;
  if (!isPlausibleYear(input.year) && isPlausibleYear(enriched.year)) {
    target.year = enriched.year;
  }
  if (!input.status && enriched.status) target.status = enriched.status;
  target.genresStr = formatAndNormalizeGenres(input.genres || target.genresStr, enriched.genres);
}

// server/metadataBackfill.ts
init_titleNormalizer();
init_textCleaner();
var state = {
  queue: [],
  queued: /* @__PURE__ */ new Set(),
  processed: 0,
  failed: 0,
  activeWorkers: 0,
  recent: [],
  timer: null
};
function isLandscapePosterUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return u.includes("w454_and_h254") || u.includes("w500_and_h282") || u.includes("w1280_and_h720") || u.includes("backdrop") || u.includes("fanart") || u.includes("banner") || u.includes("/still/") || u.includes("still_path") || u.includes("horizontal") || u.includes("_landscape") || u.includes("cover_land");
}
function isLowQualityImage(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return u.length < 15 || u.startsWith("data:") || u.includes("placeholder") || u.includes("default_poster") || u.includes("no-image") || u.includes("noposter") || u.includes("no_poster") || u.includes("nopic") || u.includes("no-cover") || u.includes("blank.png") || u.includes("dummyimage") || u.includes("veranimes.net") || u.includes("images.unsplash.com") || u.includes("/w92/") || u.includes("/w154/") || u.includes("/w185/") || u.includes("thumb_small") || u.includes("_preview") || u.includes("mini_") || u.includes("100x") || u.includes("150x");
}
function showNeedsBackfill(show) {
  if (show.title) {
    if (isSlugLikeTitle(show.title)) return true;
    const parsed = parseRawTitle(show.title);
    if (parsed.canonical !== show.title && isPlausibleTitle(parsed.canonical)) return true;
  }
  if (isAnomalousDescription(show.description, show.title)) {
    return true;
  }
  if (isLandscapePosterUrl(show.poster_url) || isLowQualityImage(show.poster_url) || isLowQualityImage(show.banner_url) || show.banner_url === show.poster_url) {
    return true;
  }
  if (show.genres) {
    const rawG = show.genres.trim();
    if (rawG === "Multimedia" || !rawG.includes(",") && rawG.includes(" ") || rawG.toLowerCase() === rawG) {
      return true;
    }
  }
  return !show.description || show.description.trim() === "" || !show.poster_url || !show.banner_url || !show.genres || show.genres.trim() === "" || show.genres === "Multimedia" || !show.year || show.year <= 0 || !show.tmdb_id;
}
function enqueueShowBackfill(showId) {
  if (!showId || state.queued.has(showId)) return;
  state.queued.add(showId);
  state.queue.push(showId);
  startWorker();
}
var BACKFILL_POOL = 20;
function startWorker() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    if (state.queue.length === 0 && state.activeWorkers === 0) {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
      return;
    }
    while (state.activeWorkers < BACKFILL_POOL && state.queue.length > 0) {
      const showId = state.queue.shift();
      if (!showId) break;
      state.queued.delete(showId);
      state.activeWorkers++;
      backfillShow(showId).then((r) => {
        state.processed++;
        if (r.changed.length > 0) {
          state.recent.unshift(r);
          state.recent = state.recent.slice(0, 20);
        }
      }).catch(() => {
        state.failed++;
      }).finally(() => {
        state.activeWorkers--;
      });
    }
  }, 100);
}
function isPlaceholderDescription(text) {
  const t = String(text || "").trim();
  if (t.length < 40) return true;
  return /sin descripci|no descrip|añade un resumen|no hemos añadido|contenido indexado|obra multimedia indexada|just-in-time/i.test(t);
}
async function backfillShow(showId) {
  const show = await prisma.show.findUnique({ where: { id: showId } });
  if (!show) {
    return { showId, title: "(eliminada)", changed: [], at: (/* @__PURE__ */ new Date()).toISOString() };
  }
  const result = {
    showId,
    title: show.title,
    changed: [],
    at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const data = {};
  if (show.title) {
    if (isSlugLikeTitle(show.title)) {
      data.title = cleanSlugToWords(show.title);
    } else {
      const parsed = parseRawTitle(show.title);
      if (parsed.canonical !== show.title && isPlausibleTitle(parsed.canonical)) {
        data.title = parsed.canonical;
      }
    }
  }
  const kind = show.category || "anime";
  let enriched = null;
  const searchTitle = String(data.title || show.title || "").trim();
  try {
    enriched = await enrichUniversalMetadata(searchTitle, kind);
  } catch {
    enriched = null;
  }
  const currentTitle = String(data.title ?? show.title ?? "");
  const currentDesc = (show.description || "").trim();
  const cleanedCurrentDesc = cleanDescription(currentDesc, currentTitle);
  if (cleanedCurrentDesc && cleanedCurrentDesc !== currentDesc) {
    data.description = cleanedCurrentDesc;
  }
  if (!enriched) {
    if (Object.keys(data).length > 0) {
      await prisma.show.update({ where: { id: showId }, data });
      result.changed = Object.keys(data);
      result.title = String(data.title ?? show.title);
    }
    return result;
  }
  if (!showNeedsBackfill(show) && Object.keys(data).length === 0) return result;
  const currentDescTruncated = endsWithTruncationEllipsis(currentDesc);
  const rawEnrichedDesc = enriched.description ? cleanDescription(String(enriched.description), currentTitle) : "";
  const enrichedDescOk = !isPlaceholderDescription(rawEnrichedDesc) && !endsWithTruncationEllipsis(rawEnrichedDesc);
  if ((!currentDesc || isPlaceholderDescription(currentDesc)) && enrichedDescOk) {
    data.description = rawEnrichedDesc;
  } else if (
    // Reparación de truncados o anomalías severas
    currentDesc !== "" && (currentDescTruncated || isAnomalousDescription(currentDesc, currentTitle)) && enrichedDescOk && rawEnrichedDesc.length > currentDesc.length
  ) {
    data.description = rawEnrichedDesc;
  }
  if ((!show.poster_url || isLowQualityImage(show.poster_url) || isLandscapePosterUrl(show.poster_url)) && enriched.poster_path) {
    data.poster_url = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
    data.poster_path = enriched.poster_path;
  } else if ((!show.poster_url || isLowQualityImage(show.poster_url) || isLandscapePosterUrl(show.poster_url)) && enriched.poster_url && !isLandscapePosterUrl(enriched.poster_url)) {
    data.poster_url = enriched.poster_url;
  }
  if ((!show.banner_url || show.banner_url === show.poster_url || isLowQualityImage(show.banner_url)) && enriched.backdrop_path) {
    data.banner_url = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
    data.backdrop_path = enriched.backdrop_path;
  } else if ((!show.banner_url || show.banner_url === show.poster_url || isLowQualityImage(show.banner_url)) && enriched.banner_url) {
    data.banner_url = enriched.banner_url;
  }
  if (isSlugLikeTitle(show.title)) {
    if (enriched.title && !isSlugLikeTitle(enriched.title)) {
      data.title = enriched.title;
      data.normalized_title = normalizeTitleKey(enriched.title);
      data.base_normalized_title = normalizeTitleKey(enriched.title);
    } else {
      const cleanWords = cleanSlugToWords(show.title);
      data.title = cleanWords;
      data.normalized_title = normalizeTitleKey(cleanWords);
      data.base_normalized_title = normalizeTitleKey(cleanWords);
    }
  }
  const currentGenres = show.genres || "";
  const normalizedGenres = formatAndNormalizeGenres(currentGenres, enriched.genres);
  if (normalizedGenres && normalizedGenres !== currentGenres && normalizedGenres !== "Multimedia") {
    data.genres = normalizedGenres;
  }
  if ((!show.year || show.year <= 0) && Number.isFinite(enriched.year) && enriched.year > 0) {
    data.year = enriched.year;
  }
  if (!show.tmdb_id && enriched.tmdb_id) {
    data.tmdb_id = enriched.tmdb_id;
  }
  if (Object.keys(data).length > 0) {
    try {
      await prisma.show.update({ where: { id: showId }, data });
    } catch (e) {
      enqueueWrite({ kind: "show.update", id: showId, data });
      console.warn(`[Backfill] Escritura diferida en write-buffer para obra ${showId}: ${e?.message || e}`);
    }
    result.changed = Object.keys(data);
    if (data.title) {
      result.title = String(data.title);
    }
    if (data.title || data.tmdb_id) {
      try {
        const base = show.base_normalized_title || show.normalized_title;
        const mediaKinds = kind === "anime" || kind === "series" ? { in: ["anime", "series"] } : kind;
        let item = data.tmdb_id ? await prisma.mediaItem.findFirst({
          // TMDB comparte namespace entre anime y series; solo las
          // películas/documentales permanecen en un namespace separado.
          where: { tmdb_id: data.tmdb_id, kind: mediaKinds },
          orderBy: { created_at: "asc" }
        }) : null;
        if (!item) {
          item = await prisma.mediaItem.findFirst({
            where: {
              OR: [
                { base_normalized_title: base, kind: mediaKinds },
                ...show.normalized_title !== base ? [{ normalized_title: show.normalized_title, kind: mediaKinds }] : []
              ]
            }
          });
        }
        if (item) {
          const itemData = {};
          if (data.title && item.title !== data.title) itemData.title = String(data.title);
          if (data.tmdb_id && !item.tmdb_id) itemData.tmdb_id = data.tmdb_id;
          if (Object.keys(itemData).length > 0) {
            await prisma.mediaItem.update({ where: { id: item.id }, data: itemData });
          }
        }
      } catch {
      }
    }
  }
  return result;
}
async function backfillMissingMetadata(limit = 100) {
  const shows = await prisma.show.findMany({
    where: {
      OR: [
        { description: "" },
        // Sinopsis truncadas por el sitio fuente: candidatas a reparación.
        { description: { endsWith: "..." } },
        { description: { endsWith: "\u2026" } },
        { poster_url: null },
        { banner_url: null },
        { genres: "Multimedia" },
        { year: { lte: 0 } },
        { tmdb_id: null }
      ]
    },
    orderBy: { created_at: "asc" },
    take: Math.min(Math.max(1, Math.round(limit) || 100), 2e3),
    select: { id: true }
  });
  for (const s of shows) enqueueShowBackfill(s.id);
  return { queued: shows.length };
}
function getBackfillStatus() {
  return {
    pending: state.queue.length,
    processed: state.processed,
    failed: state.failed,
    activeWorkers: state.activeWorkers
  };
}
async function forceShowMetadata(showId, customTitle) {
  const show = await prisma.show.findUnique({ where: { id: showId } });
  if (!show) throw new Error("Serie no encontrada");
  const kind = show.category || "anime";
  const enriched = await enrichUniversalMetadata(customTitle, kind);
  if (!enriched) throw new Error("No se encontraron metadatos en TMDB para este t\xEDtulo");
  const data = { title: customTitle };
  if (enriched.description) data.description = enriched.description;
  if (enriched.poster_path) data.poster_url = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
  else if (enriched.poster_url) data.poster_url = enriched.poster_url;
  if (enriched.backdrop_path) data.banner_url = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
  else if (enriched.banner_url) data.banner_url = enriched.banner_url;
  if (Array.isArray(enriched.genres) && enriched.genres.length > 0) data.genres = enriched.genres.join(", ");
  if (Number.isFinite(enriched.year) && enriched.year > 0) data.year = enriched.year;
  if (enriched.tmdb_id) data.tmdb_id = enriched.tmdb_id;
  const updated = await prisma.show.update({ where: { id: showId }, data });
  return updated;
}

// server/showService.ts
init_metadataEngine();
init_resolutionMetadata();

// server/utils/streamSorter.ts
var TIERS = [
  { tier: 1, tokens: ["ugc-cdn-caching", "goodstream", "acek-cdn", "uqload", "vimeos."] },
  // Genéricos AnimeFLV verificados sin 403 en validador + doodstream
  { tier: 2, tokens: ["ducvomes.com", "playmudos.com", "doodstream"] },
  { tier: 3, tokens: ["vidhide"] },
  { tier: 4, tokens: ["mega.nz", "mega.io", "mega.co.nz", "mp4upload"] }
];
var UNKNOWN_TIER = 3.5;
var BLACKLISTED_HOST_TOKENS = ["voe", "mixdrop", "mxdrop", "filemoon"];
function isBlacklistedHost(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower) return false;
  return BLACKLISTED_HOST_TOKENS.some((t) => lower.includes(t));
}
function getStreamTier(url) {
  const lower = String(url || "").toLowerCase();
  for (const { tier, tokens } of TIERS) {
    if (tokens.some((t) => lower.includes(t))) return tier;
  }
  return UNKNOWN_TIER;
}
function hostOfStreamUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
function familyKeyOfStreamUrl(url) {
  const host = hostOfStreamUrl(url);
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : host;
}
function sortStreamsByPriority(streams, hostPriority) {
  return streams.filter((s) => !isBlacklistedHost(s?.url)).sort((a, b) => {
    if (hostPriority) {
      const pa = hostPriority[familyKeyOfStreamUrl(a.url)];
      const pb = hostPriority[familyKeyOfStreamUrl(b.url)];
      if (pa !== void 0 || pb !== void 0) {
        const na = pa ?? Number.MAX_SAFE_INTEGER;
        const nb = pb ?? Number.MAX_SAFE_INTEGER;
        if (na !== nb) return na - nb;
      }
    }
    return getStreamTier(a.url) - getStreamTier(b.url);
  });
}

// server/showService.ts
init_titleNormalizer();
init_universalScraper();
init_catalogIntegrity();
var VERBOSE_DEDUP_LOGS = process.env.MERISTREAM_VERBOSE_DEDUP === "1";
var dedupLog = (...args) => {
  if (VERBOSE_DEDUP_LOGS) console.log(...args);
};
function sourceIdentityKey(url) {
  const kind = classifySourceKind(url);
  return kind === "page" || kind === "embed" ? canonicalCatalogUrl(url) : url.trim();
}
function tmdbCategoryFilter(kind) {
  return kind === "anime" || kind === "series" ? { category: { in: ["anime", "series"] } } : { category: kind };
}
function tmdbKindFilter(kind) {
  return kind === "anime" || kind === "series" ? { kind: { in: ["anime", "series"] } } : { kind };
}
function applyEnrichedMetadata(input, target, enriched) {
  applyEnrichmentGapFill(
    {
      title: input.title,
      description: input.description,
      poster_url: input.poster_url,
      banner_url: input.banner_url,
      rating: input.rating,
      year: input.year,
      status: input.status,
      genres: input.genres
    },
    target,
    enriched
  );
}
function buildNormalizedEpisodes(input, kind) {
  const inputEpisodes = input.episodes || [];
  const defaultSite = input.source_site || "unknown";
  const detectedStreams = Array.isArray(input.detected_streams) ? input.detected_streams.filter((s) => typeof s === "string" && Boolean(s.trim())) : [];
  const isMovie = kind === "movie" || input.content_type === "movie" || input.category === "movie";
  if (isMovie) {
    const rawEp = inputEpisodes[0] || null;
    const primaryUrl = rawEp?.url || rawEp?.source_url || detectedStreams[0] || input.source_url || input.url || "";
    const streamSources = [];
    const seenUrls = /* @__PURE__ */ new Set();
    if (primaryUrl) {
      const kind2 = classifySourceKind(primaryUrl);
      if (kind2 !== "ephemeral_direct") {
        streamSources.push({ url: primaryUrl, source_site: defaultSite, source_kind: kind2 });
        seenUrls.add(sourceIdentityKey(primaryUrl));
      }
    }
    for (const st of detectedStreams) {
      if (st && !seenUrls.has(sourceIdentityKey(st))) {
        const kind2 = classifySourceKind(st);
        if (kind2 !== "ephemeral_direct") {
          streamSources.push({ url: st, source_site: defaultSite, source_kind: kind2 });
          seenUrls.add(sourceIdentityKey(st));
        }
      }
    }
    if (rawEp?.sources) {
      for (const s of rawEp.sources) {
        if (s?.url && !seenUrls.has(sourceIdentityKey(s.url))) {
          const kind2 = classifySourceKind(s.url);
          if (kind2 !== "ephemeral_direct") {
            streamSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind2 });
            seenUrls.add(sourceIdentityKey(s.url));
          }
        }
      }
    }
    if (input.sources) {
      for (const s of input.sources) {
        if (s?.url && !seenUrls.has(sourceIdentityKey(s.url))) {
          const kind2 = classifySourceKind(s.url);
          if (kind2 !== "ephemeral_direct") {
            streamSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind2 });
            seenUrls.add(sourceIdentityKey(s.url));
          }
        }
      }
    }
    if (streamSources.length > 0) {
      return [
        {
          number: 1,
          title: rawEp?.title || "Pel\xEDcula Completa",
          url: streamSources[0].url,
          sources: streamSources
        }
      ];
    }
  }
  const normalizedEpisodes = inputEpisodes.filter((ep) => Boolean(ep.url || ep.source_url || ep.sources && ep.sources.length > 0)).map((ep, idx) => {
    const epNum = ep.number ?? ep.episode_number ?? idx + 1;
    const primaryUrl = ep.url || ep.source_url || ep.sources && ep.sources[0]?.url || "";
    const epSources = [];
    const seen = /* @__PURE__ */ new Set();
    if (primaryUrl) {
      const kind2 = classifySourceKind(primaryUrl);
      if (kind2 !== "ephemeral_direct") {
        epSources.push({ url: primaryUrl, source_site: defaultSite, source_kind: kind2 });
        seen.add(sourceIdentityKey(primaryUrl));
      }
    }
    if (ep.sources) {
      for (const s of ep.sources) {
        if (s?.url && !seen.has(sourceIdentityKey(s.url))) {
          const kind2 = classifySourceKind(s.url);
          if (kind2 !== "ephemeral_direct") {
            epSources.push({ ...s, source_site: s.source_site || defaultSite, source_kind: kind2 });
            seen.add(sourceIdentityKey(s.url));
          }
        }
      }
    }
    return {
      number: epNum,
      title: ep.title || (kind === "movie" ? "Pel\xEDcula Completa" : `Episodio ${epNum}`),
      url: epSources[0]?.url || "",
      sources: epSources
    };
  }).filter((episode) => Boolean(episode.url));
  if (normalizedEpisodes.length === 0) {
    const fallbackUrl = detectedStreams[0] || input.source_url || input.url || "";
    if (fallbackUrl) {
      const fallbackKind = classifySourceKind(fallbackUrl);
      const fallbackSources = detectedStreams.filter((st) => classifySourceKind(st) !== "ephemeral_direct").map((st) => ({ url: st, source_site: defaultSite, source_kind: classifySourceKind(st) }));
      const persistentFallbacks = fallbackSources.length > 0 ? fallbackSources : fallbackKind !== "ephemeral_direct" ? [{ url: fallbackUrl, source_site: defaultSite, source_kind: fallbackKind }] : [];
      if (persistentFallbacks.length > 0) {
        normalizedEpisodes.push({
          number: 1,
          title: kind === "movie" ? "Pel\xEDcula Completa" : "Episodio 1",
          url: persistentFallbacks[0].url,
          sources: persistentFallbacks
        });
      }
    }
  }
  return normalizedEpisodes;
}
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
async function syncEpisodeSources(mediaItemId, season, episodeNumber, sources, defaultSite) {
  const cleanSources = (sources || []).filter((s) => s && s.url && typeof s.url === "string" && s.url.trim());
  if (cleanSources.length === 0) return 0;
  const persistentSources = cleanSources.filter((s) => {
    const kind = classifySourceKind(s.url);
    return kind !== "ephemeral_direct";
  });
  if (persistentSources.length === 0) return 0;
  let sourcesAdded = 0;
  enqueueWrite({
    kind: "mediaEpisode.upsert",
    where: {
      media_item_id_season_number_episode_number: {
        media_item_id: mediaItemId,
        season_number: season,
        episode_number: episodeNumber
      }
    },
    create: { media_item_id: mediaItemId, season_number: season, episode_number: episodeNumber }
  });
  for (const src of persistentSources) {
    const rawUrl = src.url.trim();
    const kind = classifySourceKind(rawUrl);
    const linkType = src.link_type || (kind === "embed" ? "embed" : kind === "page" ? "page" : "direct");
    const site = src.source_site || defaultSite || "unknown";
    const existing = await prisma.sourceLink.findFirst({
      where: {
        url: rawUrl,
        source_site: site,
        media_episode: {
          media_item_id: mediaItemId,
          season_number: season,
          episode_number: episodeNumber
        }
      },
      select: {
        id: true,
        language: true,
        audio_language: true,
        subtitle_language: true,
        subtitles: true,
        canonical_locator: true,
        host: true,
        extraction_method: true,
        resolver_version: true
      }
    });
    if (!existing) {
      const queued = enqueueWrite({
        kind: "sourceLink.create",
        episodeRef: {
          media_item_id: mediaItemId,
          season_number: season,
          episode_number: episodeNumber
        },
        data: {
          source_site: site,
          url: rawUrl,
          link_type: linkType,
          language: src.language ?? null,
          audio_language: src.audio_language ?? null,
          subtitle_language: src.subtitle_language ?? null,
          subtitles: src.subtitles ?? void 0,
          host: src.host ?? hostOf(rawUrl),
          priority_tier: getStreamTier(rawUrl),
          // La importación solo demuestra que el enlace fue descubierto. La
          // resolución JIT/revisión del reproductor hará avanzar la evidencia.
          source_status: "discovered",
          canonical_locator: kind === "page" || kind === "embed" ? rawUrl : null,
          extraction_method: "catalog_import",
          resolver_version: "catalog-v2",
          // Importar una URL no demuestra que nuestro reproductor la haya
          // decodificado; la verificación se concede en la fase de media/UI.
          is_verified: false,
          last_checked: (/* @__PURE__ */ new Date()).toISOString()
        }
      });
      if (queued) sourcesAdded++;
    } else {
      const evidence = {};
      if (src.language && existing.language !== src.language) evidence.language = src.language;
      if (src.audio_language && existing.audio_language !== src.audio_language) evidence.audio_language = src.audio_language;
      if (src.subtitle_language && existing.subtitle_language !== src.subtitle_language) evidence.subtitle_language = src.subtitle_language;
      if (src.subtitles !== void 0 && existing.subtitles == null) evidence.subtitles = src.subtitles;
      if (!existing.canonical_locator && (kind === "page" || kind === "embed")) evidence.canonical_locator = rawUrl;
      if (!existing.host) evidence.host = src.host ?? hostOf(rawUrl);
      if (!existing.extraction_method) evidence.extraction_method = "catalog_import";
      if (!existing.resolver_version) evidence.resolver_version = "catalog-v2";
      if (Object.keys(evidence).length > 0) enqueueSourceLinkUpdate(existing.id, evidence);
    }
  }
  return sourcesAdded;
}
function pickYearCompatible(candidates, year) {
  if (candidates.length === 0) return null;
  if (year === null || !isPlausibleYear(year)) return candidates[0];
  const exact = candidates.filter((c) => c.year === year);
  if (exact.length > 0) return exact[0];
  const unknownish = candidates.filter((c) => !isPlausibleYear(c.year ?? null));
  return unknownish[0] ?? null;
}
async function findExistingShowByBase(baseNorm, year, category) {
  if (!baseNorm) return null;
  const candidates = await prisma.show.findMany({
    // El título normalizado es un fallback; nunca debe cruzar una película
    // con un anime/serie homónimo. La identidad TMDB se resuelve antes y
    // puede unir aliases reales, pero el fallback local conserva la categoría.
    where: { base_normalized_title: baseNorm, ...category ? { category } : {} },
    include: { episodes: true },
    orderBy: { created_at: "asc" }
  });
  return pickYearCompatible(candidates, year);
}
async function findExistingShow(malId, normTitle, normEng, normJap) {
  if (malId && malId > 0) {
    const byMal = await prisma.show.findUnique({
      where: { mal_id: malId },
      include: { episodes: true }
    });
    if (byMal) return byMal;
  }
  if (!normTitle) return null;
  const candidates = await prisma.show.findMany({
    where: { normalized_title: { in: [normTitle, normEng, normJap].filter(Boolean) } },
    take: 50,
    include: { episodes: true }
  });
  return candidates.find((s) => {
    const dbNormTitle = normalizeTitle(s.title);
    const dbNormJap = s.japanese_title ? normalizeTitle(s.japanese_title) : "";
    const dbNormEng = s.english_title ? normalizeTitle(s.english_title) : "";
    return dbNormTitle && dbNormTitle === normTitle || dbNormEng && dbNormEng === normTitle || dbNormJap && dbNormJap === normTitle || normEng && dbNormEng && dbNormEng === normEng || normEng && dbNormTitle && dbNormTitle === normEng || normJap && dbNormJap && dbNormJap === normJap;
  }) || null;
}
async function mergeShowEpisodes(existingShow, showData, normalizedEpisodes) {
  dedupLog(`[Deduplication] Obra existente detectada: '${existingShow.title}' (ID: ${existingShow.id}). Fusionando datos...`);
  const updatePayload = {};
  const existingTitleStr = String(existingShow.title ?? "").trim();
  const incomingTitleStr = String(showData.title ?? "").trim();
  const incomingIsClean = parseRawTitle(incomingTitleStr).canonical === incomingTitleStr;
  if (isSlugLikeTitle(existingTitleStr) && !isSlugLikeTitle(incomingTitleStr)) {
    dedupLog(`[Deduplication] T\xEDtulo reparado de slug: '${existingTitleStr}' \u2192 '${incomingTitleStr}'`);
    updatePayload.title = incomingTitleStr;
    updatePayload.normalized_title = normalizeTitleKey(incomingTitleStr) || normalizeTitle(incomingTitleStr);
    updatePayload.base_normalized_title = normalizeTitleKey(incomingTitleStr);
  } else if (incomingTitleStr && incomingIsClean && parseRawTitle(existingTitleStr).canonical !== existingTitleStr && normalizeTitleKey(existingTitleStr) === normalizeTitleKey(incomingTitleStr)) {
    dedupLog(`[Deduplication] T\xEDtulo normalizado: '${existingTitleStr}' \u2192 '${incomingTitleStr}'`);
    updatePayload.title = incomingTitleStr;
    updatePayload.normalized_title = normalizeTitleKey(incomingTitleStr) || normalizeTitle(incomingTitleStr);
  }
  if (!existingShow.mal_id && showData.malId) updatePayload.mal_id = showData.malId;
  if (!existingShow.anilist_id && showData.anilistId) updatePayload.anilist_id = showData.anilistId;
  if (!existingShow.tmdb_id && showData.tmdbId) updatePayload.tmdb_id = showData.tmdbId;
  if (!existingShow.original_title && showData.originalTitle) updatePayload.original_title = showData.originalTitle;
  if (!existingShow.japanese_title && showData.japaneseTitle) updatePayload.japanese_title = showData.japaneseTitle;
  if (!existingShow.english_title && showData.englishTitle) updatePayload.english_title = showData.englishTitle;
  if (!hasSubstantiveText(existingShow.description) && hasSubstantiveText(showData.description)) {
    updatePayload.description = showData.description;
  }
  if (isPlausibleYear(showData.year) && (!isPlausibleYear(existingShow.year) || showData.tmdbId && (!existingShow.tmdb_id || existingShow.tmdb_id === showData.tmdbId) && existingShow.year !== showData.year)) {
    updatePayload.year = showData.year;
  }
  if ((!existingShow.poster_url || existingShow.poster_url === "") && showData.posterUrl) updatePayload.poster_url = showData.posterUrl;
  if ((!existingShow.banner_url || existingShow.banner_url === "") && showData.bannerUrl) updatePayload.banner_url = showData.bannerUrl;
  if (showData.genresStr && showData.genresStr !== "Multimedia" && (!existingShow.genres || existingShow.genres === "Multimedia" || !existingShow.genres.includes(","))) {
    updatePayload.genres = showData.genresStr;
  }
  if (Object.keys(updatePayload).length > 0) {
    enqueueShowUpdate(existingShow.id, updatePayload);
  }
  const missingEps = normalizedEpisodes.filter(
    (ep) => !existingShow.episodes.some(
      (existingEp) => existingEp.episode_number === ep.number || ep.url && existingEp.source_url === ep.url
    )
  );
  const addedCount = missingEps.length;
  if (missingEps.length > 0) {
    await prisma.episode.createMany({
      data: missingEps.map((ep) => ({
        show_id: existingShow.id,
        episode_number: ep.number,
        title: ep.title,
        source_url: ep.url
      }))
    });
  }
  const updatedShow = await prisma.show.findUnique({
    where: { id: existingShow.id },
    include: {
      episodes: {
        orderBy: { episode_number: "asc" }
      }
    }
  });
  return {
    show: updatedShow,
    isDuplicate: true,
    episodesAdded: addedCount
  };
}
async function syncMediaItemSources(input, kind, legacyShowId, normalizedEpisodes, titleInfo) {
  try {
    const canonical = titleInfo.canonical || input.title;
    const norm = titleInfo.norm || normalizeTitle(canonical);
    if (!norm) return 0;
    const baseNorm = titleInfo.baseNorm || norm;
    const season = input.season ?? parseTitleQuery(canonical).season ?? 1;
    const enrichedAny = input._enriched || null;
    const year = titleInfo.year !== null && isPlausibleYear(titleInfo.year) ? titleInfo.year : input.year && isPlausibleYear(input.year) ? input.year : null;
    let legacyTmdbId = input.tmdb_id ?? enrichedAny?.tmdb_id ?? null;
    if (!legacyTmdbId && legacyShowId) {
      const legacy = await prisma.show.findUnique({
        where: { id: legacyShowId },
        select: { tmdb_id: true }
      });
      legacyTmdbId = legacy?.tmdb_id ?? null;
    }
    const tmdbId = legacyTmdbId;
    const orConditions = [
      { base_normalized_title: baseNorm, kind },
      ...baseNorm !== norm ? [{ normalized_title: norm, kind }] : []
    ];
    const itemCandidates = await prisma.mediaItem.findMany({
      where: { OR: orConditions },
      orderBy: { created_at: "asc" }
    });
    let mediaItem = tmdbId ? await prisma.mediaItem.findFirst({
      where: { tmdb_id: tmdbId, ...tmdbKindFilter(kind) },
      orderBy: { created_at: "asc" }
    }) : null;
    if (!mediaItem) mediaItem = pickYearCompatible(itemCandidates, year);
    if (!mediaItem) {
      const itemId = enqueueMediaItemCreate({
        normalized_title: norm,
        base_normalized_title: baseNorm,
        title: canonical,
        kind,
        year,
        tmdb_id: tmdbId,
        original_title: enrichedAny?.original_title || null,
        poster_url: input.poster_url || null,
        poster_path: enrichedAny?.poster_path || null,
        backdrop_path: enrichedAny?.backdrop_path || null
      });
      mediaItem = { id: itemId, normalized_title: norm, base_normalized_title: baseNorm, title: canonical, kind, year };
    } else {
      const updateData = {};
      if (!mediaItem.base_normalized_title) updateData.base_normalized_title = baseNorm;
      if (input.poster_url && !mediaItem.poster_url) updateData.poster_url = input.poster_url;
      if (tmdbId && !mediaItem.tmdb_id) updateData.tmdb_id = tmdbId;
      if (enrichedAny?.poster_path && !mediaItem.poster_path) updateData.poster_path = enrichedAny.poster_path;
      if (enrichedAny?.backdrop_path && !mediaItem.backdrop_path) updateData.backdrop_path = enrichedAny.backdrop_path;
      if (Object.keys(updateData).length > 0) {
        enqueueMediaItemUpdate(mediaItem.id, updateData);
      }
    }
    const defaultSite = input.source_site || "unknown";
    let sourcesAdded = 0;
    for (const ep of normalizedEpisodes) {
      const sources = [...ep.sources];
      if (ep.url && !sources.some((s) => s.url === ep.url)) {
        const epKind = classifySourceKind(ep.url);
        if (epKind !== "ephemeral_direct") {
          sources.unshift({ url: ep.url, source_kind: epKind });
        }
      }
      const added = await syncEpisodeSources(mediaItem.id, season, ep.number, sources, defaultSite);
      sourcesAdded += added || 0;
    }
    return sourcesAdded;
  } catch (e) {
    console.error(`[MultiSource] No se pudo sincronizar fuentes para obra legacy ${legacyShowId}:`, e);
    return 0;
  }
}
function enqueueBackfillIfIncomplete(show) {
  try {
    if (showNeedsBackfill(show)) enqueueShowBackfill(show.id);
  } catch {
  }
}
async function mergeSequelIntoTwin(twin, showData, normalizedEpisodes, input, kind, detectedSeason) {
  const norm = twin.normalized_title;
  const base = twin.base_normalized_title || twin.normalized_title;
  let maxSeason = 0;
  const mediaItem = await prisma.mediaItem.findFirst({
    where: { OR: [{ base_normalized_title: base, kind }, { normalized_title: norm, kind }] },
    orderBy: { created_at: "asc" }
  });
  if (mediaItem) {
    const agg = await prisma.mediaEpisode.aggregate({
      where: { media_item_id: mediaItem.id },
      _max: { season_number: true }
    });
    maxSeason = agg._max?.season_number ?? 0;
  }
  const seasonNumber = detectedSeason > 1 ? detectedSeason : Math.max(1, maxSeason + 1);
  const lastEp = await prisma.episode.findFirst({
    where: { show_id: twin.id },
    orderBy: { episode_number: "desc" },
    take: 1
  });
  let nextNumber = (lastEp?.episode_number ?? 0) + 1;
  let added = 0;
  for (const ep of normalizedEpisodes) {
    if (ep.url) {
      const dupe = await prisma.episode.findFirst({ where: { show_id: twin.id, source_url: ep.url } });
      if (dupe) continue;
    }
    await prisma.episode.create({
      data: { show_id: twin.id, episode_number: nextNumber, title: ep.title, source_url: ep.url }
    });
    nextNumber++;
    added++;
  }
  const twinTitleInfo = {
    canonical: twin.title,
    norm,
    baseNorm: base,
    year: twin.year ?? null
  };
  const sourcesAdded = await syncMediaItemSources({ ...input, season: seasonNumber }, kind, twin.id, normalizedEpisodes, twinTitleInfo);
  const patch = {};
  if (!twin.mal_id && showData.malId) patch.mal_id = showData.malId;
  if (!twin.anilist_id && showData.anilistId) patch.anilist_id = showData.anilistId;
  if (Object.keys(patch).length > 0) {
    enqueueShowUpdate(twin.id, patch);
  }
  dedupLog(
    `[Deduplication] SECUELA fusionada por TMDB ${showData.tmdbId}: "${showData.title}" \u2192 "${twin.title}" como temporada ${seasonNumber} (${added} episodios a\xF1adidos, numeraci\xF3n continua).`
  );
  const fresh = await prisma.show.findUnique({
    where: { id: twin.id },
    include: { episodes: { orderBy: { episode_number: "asc" } } }
  });
  return { show: fresh, isDuplicate: true, episodesAdded: added, sourcesAdded: sourcesAdded || 0 };
}
async function saveShowWithDeduplication(input) {
  const rawParsed = parseRawTitle(String(input.title ?? ""));
  const canonicalTitle = rawParsed.canonical || String(input.title ?? "").trim();
  const parsed = parseTitleQuery(canonicalTitle);
  const rawTitle = parsed.baseTitle || canonicalTitle;
  const kind = input.content_type || input.category || "anime";
  const season = input.season ?? rawParsed.season ?? parsed.season ?? 1;
  if (rawParsed.plausible === false || !isPlausibleTitle(canonicalTitle)) {
    throw new Error(`T\xEDtulo implausible descartado por el guard: "${input.title}"`);
  }
  const showData = {
    malId: input.mal_id || null,
    anilistId: input.anilist_id || null,
    tmdbId: input.tmdb_id || null,
    title: isSlugLikeTitle(canonicalTitle) ? cleanSlugToWords(canonicalTitle) : canonicalTitle,
    originalTitle: input.original_title || null,
    japaneseTitle: input.japanese_title || null,
    englishTitle: input.english_title || null,
    description: input.description || "",
    posterUrl: input.poster_url || null,
    bannerUrl: input.banner_url || null,
    rating: input.rating || 8,
    year: input.year && isPlausibleYear(input.year) ? input.year : rawParsed.year && isPlausibleYear(rawParsed.year) ? rawParsed.year : 0,
    status: input.status || "Finalizado",
    genresStr: formatAndNormalizeGenres(input.genres, null)
  };
  let enriched = null;
  try {
    const skipEnrich = input._skipEnrichment === true;
    const preEnriched = Boolean(input.tmdb_id);
    if (skipEnrich) {
      enriched = null;
    } else if (!preEnriched) {
      const identityQueries = [canonicalTitle, input.original_title, input.english_title, input.japanese_title].map((value) => String(value || "").trim()).filter((value, index, values) => value && values.findIndex((v) => v.toLowerCase() === value.toLowerCase()) === index).map((value) => showData.year > 0 ? `${value} ${showData.year}` : value).slice(0, 3);
      for (const query of identityQueries) {
        const candidate = await enrichUniversalMetadata(query, kind);
        if (!enriched) enriched = candidate;
        if (candidate?.tmdb_id || candidate?.mal_id || candidate?.anilist_id) {
          enriched = candidate;
          break;
        }
      }
    } else {
      enriched = {
        tmdb_id: input.tmdb_id ?? void 0,
        original_title: input.original_title ?? void 0,
        poster_path: input.poster_path,
        backdrop_path: input.backdrop_path
      };
    }
    applyEnrichedMetadata(input, showData, enriched);
    if (enriched?.tmdb_id && !showData.tmdbId) showData.tmdbId = enriched.tmdb_id;
    if (enriched?.original_title && !showData.originalTitle) showData.originalTitle = enriched.original_title;
    if (input.poster_path && !showData.posterUrl) showData.posterUrl = `https://image.tmdb.org/t/p/w780${input.poster_path}`;
    else if (enriched?.poster_path && !showData.posterUrl) showData.posterUrl = `https://image.tmdb.org/t/p/w780${enriched.poster_path}`;
    if (input.backdrop_path && !showData.bannerUrl) showData.bannerUrl = `https://image.tmdb.org/t/p/w1280${input.backdrop_path}`;
    else if (enriched?.backdrop_path && !showData.bannerUrl) showData.bannerUrl = `https://image.tmdb.org/t/p/w1280${enriched.backdrop_path}`;
    input._enriched = enriched;
  } catch (e) {
    console.error("Enrichment warning during deduplication:", e);
  }
  const normTitle = normalizeTitleKey(showData.title) || normalizeTitle(showData.title);
  const baseNorm = normalizeTitleKey(rawTitle) || normTitle;
  const normJap = showData.japaneseTitle ? normalizeTitle(showData.japaneseTitle) : "";
  const normEng = showData.englishTitle ? normalizeTitle(showData.englishTitle) : "";
  const dedupYear = showData.year > 0 ? showData.year : null;
  const normalizedEpisodes = buildNormalizedEpisodes(input, kind);
  const existingByTmdb = showData.tmdbId ? await prisma.show.findFirst({
    where: { tmdb_id: showData.tmdbId, ...tmdbCategoryFilter(kind) },
    include: { episodes: true },
    orderBy: { created_at: "asc" }
  }) : null;
  if (existingByTmdb && season > 1) {
    const result = await mergeSequelIntoTwin(existingByTmdb, showData, normalizedEpisodes, input, kind, season);
    enqueueBackfillIfIncomplete(result.show);
    return { ...result, season };
  }
  const existingShow = existingByTmdb ?? await findExistingShowByBase(baseNorm, dedupYear, kind) ?? await findExistingShow(showData.malId ?? showData.tmdbId ? showData.malId : null, normTitle, normEng, normJap);
  const titleInfo = {
    canonical: showData.title,
    norm: normTitle,
    baseNorm,
    year: dedupYear
  };
  if (existingShow) {
    const result = await mergeShowEpisodes(existingShow, showData, normalizedEpisodes);
    const sourcesAdded2 = await syncMediaItemSources(input, kind, result.show.id, normalizedEpisodes, titleInfo);
    enqueueBackfillIfIncomplete(result.show);
    return { ...result, sourcesAdded: sourcesAdded2, season };
  }
  if (showData.tmdbId) {
    const twin = await prisma.show.findFirst({
      where: { tmdb_id: showData.tmdbId, ...tmdbCategoryFilter(kind), base_normalized_title: { not: baseNorm } },
      orderBy: { created_at: "asc" }
    });
    if (twin) {
      const result = await mergeSequelIntoTwin(twin, showData, normalizedEpisodes, input, kind, season);
      enqueueBackfillIfIncomplete(result.show);
      return { ...result, season: result.show ? season : season };
    }
  }
  dedupLog(`[Deduplication] Nueva obra verificada sin duplicados. Encolando en buffer RAM...`);
  const rawSource = input.source || input.source_site || "";
  const normalizedSource = rawSource.includes(".") ? rawSource.replace(/^www\./, "").split(".")[0] || rawSource : rawSource;
  const showId = enqueueShowCreate({
    mal_id: showData.malId,
    anilist_id: showData.anilistId,
    tmdb_id: showData.tmdbId,
    title: showData.title,
    original_title: showData.originalTitle,
    japanese_title: showData.japaneseTitle,
    english_title: showData.englishTitle,
    normalized_title: normTitle,
    base_normalized_title: baseNorm,
    poster_path: enriched?.poster_path || null,
    backdrop_path: enriched?.backdrop_path || null,
    description: showData.description || "Obra multimedia indexada.",
    poster_url: showData.posterUrl,
    banner_url: showData.bannerUrl || showData.posterUrl,
    category: kind,
    rating: showData.rating,
    year: showData.year > 0 ? showData.year : 0,
    status: showData.status,
    genres: showData.genresStr,
    source: normalizedSource
  });
  enqueueEpisodeCreateMany(
    showId,
    normalizedEpisodes.map((ep) => ({
      show_id: showId,
      episode_number: ep.number,
      title: ep.title,
      source_url: ep.url
    }))
  );
  const createdShow = {
    id: showId,
    title: showData.title,
    normalized_title: normTitle,
    base_normalized_title: baseNorm,
    category: kind,
    year: showData.year > 0 ? showData.year : 0,
    description: showData.description || "Obra multimedia indexada.",
    poster_url: showData.posterUrl || null,
    banner_url: showData.bannerUrl || null,
    genres: showData.genresStr,
    status: showData.status,
    mal_id: showData.malId,
    anilist_id: showData.anilistId,
    tmdb_id: showData.tmdbId,
    episodes: normalizedEpisodes.map((ep, i) => ({
      id: `${showId}-ep${ep.number}`,
      episode_number: ep.number,
      title: ep.title,
      source_url: ep.url
    }))
  };
  const sourcesAdded = await syncMediaItemSources(input, kind, createdShow.id, normalizedEpisodes, titleInfo);
  enqueueBackfillIfIncomplete(createdShow);
  return {
    show: createdShow,
    isDuplicate: false,
    episodesAdded: normalizedEpisodes.length,
    sourcesAdded,
    season
  };
}
async function getShowsFromDb(search, category) {
  let where = {};
  if (category) {
    where.category = { contains: category };
  }
  if (search) {
    const s = search.toLowerCase().trim();
    where.OR = [
      { title: { contains: s } },
      { english_title: { contains: s } },
      { japanese_title: { contains: s } },
      { genres: { contains: s } }
    ];
  }
  const shows = await prisma.show.findMany({
    where,
    include: {
      episodes: {
        orderBy: { episode_number: "asc" }
      }
    },
    orderBy: { created_at: "desc" }
  });
  return shows;
}
async function getShowsFromDbLite(search, category, page, limit) {
  const pageNum = Math.max(1, page || 1);
  const pageSize = Math.min(5e4, Math.max(1, limit || 500));
  const skip = (pageNum - 1) * pageSize;
  if (search && search.trim().length >= 2) {
    const s = search.trim();
    const tsQuery = s.split(/\s+/).join(" & ");
    let categoryFilter = "";
    const params = [tsQuery, s.toLowerCase(), pageSize, skip];
    let paramIdx = 4;
    if (category) {
      paramIdx++;
      params.push(`%${category.toLowerCase()}%`);
      categoryFilter = `AND LOWER(category) LIKE $${paramIdx}`;
    }
    const showsQuery = `
      SELECT
        "id", "title", "original_title", "japanese_title", "english_title",
        "normalized_title", "description", "poster_url", "banner_url",
        "poster_path", "backdrop_path", "category", "rating", "year",
        "status", "genres", "created_at",
        ts_rank(search_vector, plainto_tsquery('simple', $1)) AS rank
      FROM "Show"
      WHERE (
        search_vector @@ plainto_tsquery('simple', $1)
        OR LOWER(title) LIKE $2
        OR LOWER("english_title") LIKE $2
        OR LOWER("japanese_title") LIKE $2
        OR LOWER(genres) LIKE $2
      )
      ${categoryFilter}
      ORDER BY rank DESC, "created_at" DESC
      LIMIT $3 OFFSET $4
    `;
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM "Show"
      WHERE (
        search_vector @@ plainto_tsquery('simple', $1)
        OR LOWER(title) LIKE $2
        OR LOWER("english_title") LIKE $2
        OR LOWER("japanese_title") LIKE $2
        OR LOWER(genres) LIKE $2
      )
      ${categoryFilter}
    `;
    const [shows2, countResult] = await Promise.all([
      prisma.$queryRawUnsafe(showsQuery, ...params),
      prisma.$queryRawUnsafe(countQuery, tsQuery, `%${s.toLowerCase()}%`, ...category ? [`%${category.toLowerCase()}%`] : [])
    ]);
    const total2 = countResult[0]?.total || 0;
    return { shows: shows2, total: total2, page: pageNum, pageSize, totalPages: Math.ceil(total2 / pageSize) };
  }
  let where = {};
  if (category) {
    where.category = { contains: category };
  }
  const [shows, total] = await Promise.all([
    prisma.show.findMany({
      where,
      select: {
        id: true,
        title: true,
        original_title: true,
        japanese_title: true,
        english_title: true,
        normalized_title: true,
        description: true,
        poster_url: true,
        banner_url: true,
        poster_path: true,
        backdrop_path: true,
        category: true,
        rating: true,
        year: true,
        status: true,
        genres: true,
        created_at: true,
        _count: { select: { episodes: true } }
      },
      orderBy: { created_at: "desc" },
      skip,
      take: pageSize
    }),
    prisma.show.count({ where })
  ]);
  return { shows, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) };
}
async function getShowByIdFromDb(id) {
  return prisma.show.findUnique({
    where: { id },
    include: {
      episodes: {
        orderBy: { episode_number: "asc" }
      }
    }
  });
}
async function deleteShowFromDb(id) {
  return prisma.show.delete({
    where: { id }
  });
}
async function clearAllShowsFromDb() {
  await prisma.episode.deleteMany({});
  await prisma.show.deleteMany({});
  await prisma.mediaItem.deleteMany({});
}
async function updateShowFields(showId, patch) {
  const existing = await prisma.show.findUnique({ where: { id: showId } });
  if (!existing) return null;
  const data = {};
  if (typeof patch.title === "string") {
    const raw = patch.title.replace(/\s+/g, " ").trim();
    if (raw) {
      const canonical = parseRawTitle(raw).canonical || raw;
      const parsed = parseTitleQuery(canonical);
      const baseTitle = parsed.baseTitle || canonical;
      const normTitle = normalizeTitleKey(canonical) || normalizeTitle(canonical);
      data.title = canonical;
      data.normalized_title = normTitle;
      data.base_normalized_title = normalizeTitleKey(baseTitle) || normTitle;
    }
  }
  if (typeof patch.description === "string") data.description = patch.description;
  if (patch.genres !== void 0 && patch.genres !== null) {
    data.genres = formatAndNormalizeGenres(patch.genres, null);
  }
  if (typeof patch.year === "number" && Number.isFinite(patch.year)) data.year = Math.round(patch.year);
  if (typeof patch.rating === "number" && Number.isFinite(patch.rating)) data.rating = patch.rating;
  if (typeof patch.status === "string" && patch.status.trim()) data.status = patch.status.trim();
  if (typeof patch.category === "string" && patch.category.trim()) data.category = patch.category.trim();
  if (patch.poster_url !== void 0) data.poster_url = patch.poster_url;
  if (patch.banner_url !== void 0) data.banner_url = patch.banner_url;
  if (patch.japanese_title !== void 0) data.japanese_title = patch.japanese_title;
  if (patch.english_title !== void 0) data.english_title = patch.english_title;
  if (Object.keys(data).length === 0) {
    return getShowByIdFromDb(showId);
  }
  enqueueShowUpdate(showId, data);
  return getShowByIdFromDb(showId);
}
function siteOfUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "") || "unknown";
    return host.split(".")[0] || host;
  } catch {
    return "unknown";
  }
}
async function refreshShowStreams(showId) {
  const summary = { episodes_checked: 0, sources_added: 0, episodes_without_streams: 0 };
  const show = await prisma.show.findUnique({
    where: { id: showId },
    include: { episodes: { orderBy: { episode_number: "asc" } } }
  });
  if (!show) return summary;
  const targetEpisodes = show.episodes.filter((ep) => ep.source_url);
  summary.episodes_checked = targetEpisodes.length;
  if (targetEpisodes.length === 0) return summary;
  const kind = show.category || "anime";
  const norm = show.normalized_title || normalizeTitle(show.title);
  const baseNorm = show.base_normalized_title || norm;
  const season = parseTitleQuery(show.title).season ?? 1;
  const itemCandidates = await prisma.mediaItem.findMany({
    where: {
      OR: [
        { base_normalized_title: baseNorm, kind },
        ...baseNorm !== norm ? [{ normalized_title: norm, kind }] : []
      ]
    },
    orderBy: { created_at: "asc" }
  });
  const mediaItem = pickYearCompatible(itemCandidates, show.year ?? null);
  if (!mediaItem) return summary;
  for (const ep of targetEpisodes) {
    try {
      const extracted = await extractStreamFromUrl(ep.source_url);
      const canonicalSources = Array.from(
        new Set(
          [ep.source_url, extracted.stream_url, ...extracted.all_available_streams || []].filter((url) => typeof url === "string" && Boolean(url.trim()))
        )
      ).filter((url) => classifySourceKind(url) !== "ephemeral_direct");
      if (canonicalSources.length === 0) {
        summary.episodes_without_streams++;
        continue;
      }
      const episodeSite = siteOfUrl(ep.source_url);
      const mediaEpisode = await prisma.mediaEpisode.findUnique({
        where: {
          media_item_id_season_number_episode_number: {
            media_item_id: mediaItem.id,
            season_number: season,
            episode_number: ep.episode_number
          }
        },
        include: { links: true }
      });
      const knownUrls = new Set((mediaEpisode?.links || []).map((l) => l.url));
      summary.sources_added += canonicalSources.filter((url) => !knownUrls.has(url)).length;
      await syncEpisodeSources(
        mediaItem.id,
        season,
        ep.episode_number,
        canonicalSources.map((url) => ({
          url,
          source_site: episodeSite,
          source_kind: classifySourceKind(url)
        })),
        "unknown"
      );
    } catch (e) {
      summary.episodes_without_streams++;
      console.error(`[RefreshStreams] No se pudo resolver '${ep.source_url}' (obra '${show.title}'):`, e);
    }
  }
  return summary;
}
async function quickSyncKnownShow(showId, data) {
  const show = await prisma.show.findUnique({ where: { id: showId }, include: { episodes: true } });
  if (!show) return { added: 0, sourcesAdded: 0 };
  const kind = show.category || "anime";
  const normalizedEpisodes = buildNormalizedEpisodes({
    title: data.title || show.title,
    category: kind,
    source_site: data.source_site,
    episodes: data.episodes
  }, kind);
  const showData = {
    malId: null,
    anilistId: null,
    title: data.title || show.title
  };
  const season = data.season ?? parseTitleQuery(data.title || "").season ?? parseTitleQuery(show.title).season ?? 1;
  const result = season > 1 ? await mergeShowEpisodes(show, showData, []) : await mergeShowEpisodes(show, showData, normalizedEpisodes);
  let legacyAdded = result.episodesAdded;
  if (season > 1 && normalizedEpisodes.length > 0) {
    const knownUrls = new Set(show.episodes.map((episode) => String(episode.source_url || "").trim()).filter(Boolean));
    const knownUntitled = new Set(
      show.episodes.filter((episode) => !episode.source_url).map((episode) => normalizeTitleKey(String(episode.title || ""))).filter(Boolean)
    );
    const missingSeasonEpisodes = normalizedEpisodes.filter(
      (episode) => episode.url ? !knownUrls.has(episode.url) : !knownUntitled.has(normalizeTitleKey(episode.title))
    );
    if (missingSeasonEpisodes.length > 0) {
      const maxLegacyNumber = show.episodes.reduce(
        (max, episode) => Math.max(max, Number(episode.episode_number) || 0),
        0
      );
      await prisma.episode.createMany({
        data: missingSeasonEpisodes.map((episode, index) => ({
          show_id: show.id,
          episode_number: maxLegacyNumber + index + 1,
          title: episode.title,
          source_url: episode.url
        }))
      });
      legacyAdded = missingSeasonEpisodes.length;
    }
  }
  const titleInfo = {
    canonical: show.title,
    norm: show.normalized_title,
    baseNorm: show.base_normalized_title || show.normalized_title,
    year: show.year ?? null
  };
  const sourcesAdded = await syncMediaItemSources(
    { title: show.title, source_site: data.source_site, season },
    kind,
    show.id,
    normalizedEpisodes,
    titleInfo
  );
  return { added: legacyAdded, sourcesAdded: sourcesAdded || 0 };
}

// server/taskWorker.ts
init_metadataEngine();
init_titleNormalizer();
init_antiBot();
init_catalogIntegrity();

// server/catalogFusion.ts
init_resolutionMetadata();
init_catalogIntegrity();
function cleanUrl(value) {
  return typeof value === "string" ? value.trim() : "";
}
function sourceKey(url) {
  const clean = cleanUrl(url);
  const kind = classifySourceKind(clean);
  return (kind === "page" || kind === "embed" ? canonicalCatalogUrl(clean) : clean).toLowerCase();
}
function normalizeExtractedEpisode(raw, fallbackSite) {
  const primaryUrl = cleanUrl(raw.url || raw.source_url);
  const normalizedSources = [];
  const seen = /* @__PURE__ */ new Set();
  for (const source of Array.isArray(raw.sources) ? raw.sources : []) {
    const url2 = cleanUrl(source?.url);
    if (!url2) continue;
    const key = sourceKey(url2);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedSources.push({
      url: url2,
      source_site: cleanUrl(source.source_site) || fallbackSite,
      link_type: cleanUrl(source.link_type) || void 0,
      host: cleanUrl(source.host) || void 0,
      is_verified: source.is_verified === true,
      language: cleanUrl(source.language) || void 0,
      audio_language: cleanUrl(source.audio_language) || void 0,
      subtitle_language: cleanUrl(source.subtitle_language) || void 0,
      subtitles: Array.isArray(source.subtitles) ? source.subtitles : void 0
    });
  }
  const url = primaryUrl || normalizedSources[0]?.url || "";
  if (!url) return null;
  const numberValue = Number(raw.number ?? raw.episode_number);
  const number = Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 1;
  const title = cleanUrl(raw.title) || `Episodio ${number}`;
  return {
    number,
    title,
    url,
    sources: normalizedSources.length > 0 ? normalizedSources : void 0
  };
}
function normalizeExtractedEpisodes(rawEpisodes, fallbackSite) {
  if (!Array.isArray(rawEpisodes)) return [];
  return rawEpisodes.map((episode) => normalizeExtractedEpisode(episode || {}, fallbackSite)).filter((episode) => episode !== null);
}

// server/catalogPagination.ts
function buildCatalogPageUrl(baseUrl, pageNumber) {
  try {
    const url = new URL(baseUrl);
    if (url.searchParams.has("page")) {
      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    }
    if (url.searchParams.has("p")) {
      url.searchParams.set("p", String(pageNumber));
      return url.toString();
    }
    if (url.searchParams.has("pag")) {
      url.searchParams.set("pag", String(pageNumber));
      return url.toString();
    }
    if (/\/page\/\d+\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/page\/\d+/, `/page/${pageNumber}`);
      return url.toString();
    }
    const host = url.hostname.toLowerCase();
    const catalogPath = url.pathname.replace(/\/+$/, "");
    const origin = url.origin;
    if (/(^|\.)animeflv\.(or\.(?:at|am)|la|cc|pe|iu|se)$/.test(host)) {
      return `${origin}${catalogPath}/page/${pageNumber}/`;
    }
    if (/(^|\.)tioplus\.app$/.test(host)) {
      return `${origin}${catalogPath}/${pageNumber}`;
    }
    if (/(^|\.)latanime\.org$/.test(host)) {
      return `${origin}${catalogPath || "/animes"}?p=${pageNumber}`;
    }
    if (/(^|\.)tioanime\.com$/.test(host)) {
      return `${origin}${catalogPath || "/directorio"}?p=${pageNumber}`;
    }
    if (/(^|\.)veranimes\.(net|com)$/.test(host)) {
      return `${origin}${catalogPath || "/animes"}?pag=${pageNumber}`;
    }
    if (/(^|\.)cinecalidad\.[a-z.]+$/.test(host)) {
      return `${origin}${catalogPath}/page/${pageNumber}/`;
    }
    if (/(^|\.)animeflv\.net$/.test(host)) {
      return `${origin}${catalogPath || "/browse"}?page=${pageNumber}`;
    }
    url.searchParams.set("page", String(pageNumber));
    return url.toString();
  } catch {
    return baseUrl.includes("?") ? `${baseUrl}&page=${pageNumber}` : `${baseUrl}?page=${pageNumber}`;
  }
}

// server/taskWorker.ts
function siteOf(url) {
  try {
    const host = new URL(url || "").hostname.replace(/^www\./, "") || "unknown";
    return host.split(".")[0] || host;
  } catch {
    return "unknown";
  }
}
var DEFAULT_SETTINGS = {
  default_delay_ms: 1500,
  jitter_enabled: true,
  max_concurrent_jobs: 1,
  user_agent_rotation: true,
  page_concurrency: 1,
  item_concurrency: 1
};
var DB_SETTING_KEYS = [
  "default_delay_ms",
  "jitter_enabled",
  "max_concurrent_jobs",
  "user_agent_rotation"
];
var FULL_CATALOG_HARD_PAGE_CAP = 1e4;
var MAX_CONSECUTIVE_PAGE_ERRORS = 5;
var NO_NEW_ITEM_PAGES_BEFORE_STOP = 2;
var DISCOVERY_MARKER_URL = "__nitiflix_discovery_complete__";
var ANTIBOT_HITS_TO_THROTTLE = 3;
var ANTIBOT_MAX_THROTTLE_FACTOR = 4;
var isDiscoveryMarker = (it) => Boolean(it) && it.url === DISCOVERY_MARKER_URL;
var stripDiscoveryMarkers = (items) => items.filter((it) => !isDiscoveryMarker(it));
function clampConcurrency(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(24, Math.round(n)));
}
function parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
    }
  }
  return [];
}
var BackgroundCrawlerWorker = class _BackgroundCrawlerWorker {
  /** Jobs en ejecución AHORA — permite RASPAR VARIOS CATÁLOGOS A LA VEZ
   *  (ejecución paralela hasta max_concurrent_jobs). */
  activeJobIds = /* @__PURE__ */ new Set();
  settings = { ...DEFAULT_SETTINGS };
  /** Debounce de persistencia de items_queue: el JSON es grande (cientos de KB)
   *  y 8 savers lo reescribian constantemente -> max 1 escritura cada 4s. */
  lastQueuePersistAt = 0;
  async persistQueueThrottled(jobId, queue, force = false) {
    const now = Date.now();
    if (!force && now - this.lastQueuePersistAt < 4e3) return;
    this.lastQueuePersistAt = now;
    await this.updateJobState(jobId, { items_queue: queue });
  }
  /** Token-bucket por dominio: el ritmo cortés se aplica al SITIO, no a TMDB/DB. */
  lastSiteHitByHost = /* @__PURE__ */ new Map();
  /** Override temporal de delay por host cuando el sitio muestra señales anti-bot. */
  antiBotThrottle = /* @__PURE__ */ new Map();
  /** Jobs en ejecución AHORA (para el GET de settings de la UI). */
  get activeJobCount() {
    return this.activeJobIds.size;
  }
  /** Registro anti-bot global (para el GET de settings de la UI). */
  getAntiBotReport() {
    return getAntiBotReport();
  }
  /** El poller no arranca hasta que la recuperación de huérfanos terminó. */
  recoveryDone = false;
  constructor() {
    this.recoverOrphanJobs().catch(() => {
    }).finally(() => {
      this.recoveryDone = true;
      void this.processNextInQueue();
    });
    setInterval(() => {
      if (this.recoveryDone) this.processNextInQueue();
    }, 1e3);
  }
  async recoverOrphanJobs() {
    try {
      const orphans = await prisma.crawlTask.findMany({ where: { status: "running" } });
      for (const job of orphans) {
        if (this.activeJobIds.has(job.id)) continue;
        const still = await prisma.crawlTask.findUnique({ where: { id: job.id }, select: { status: true } });
        if (still?.status !== "running") continue;
        await prisma.crawlTask.update({
          where: { id: job.id },
          data: { status: "pending" }
        });
        try {
          const queue = parseJsonArray(job.items_queue);
          let reset = 0;
          for (const item of queue) {
            if (item.status === "processing") {
              item.status = "pending";
              reset++;
            }
          }
          if (reset > 0) {
            await prisma.crawlTask.update({
              where: { id: job.id },
              data: { items_queue: JSON.stringify(queue) }
            });
          }
          if (job.id) console.log(`[Worker] Job hu\xE9rfano re-encolado: ${job.name || job.id} (${reset} items reseteados)`);
        } catch {
        }
      }
    } catch {
    }
  }
  init() {
    this.initSettings();
  }
  async initSettings() {
    try {
      const stored = await prisma.workerSettingsStore.findUnique({ where: { id: "default" } });
      if (stored) {
        const s = stored;
        this.settings = {
          default_delay_ms: stored.default_delay_ms,
          jitter_enabled: stored.jitter_enabled,
          max_concurrent_jobs: clampConcurrency(stored.max_concurrent_jobs, DEFAULT_SETTINGS.max_concurrent_jobs),
          user_agent_rotation: stored.user_agent_rotation,
          page_concurrency: clampConcurrency(s.page_concurrency, DEFAULT_SETTINGS.page_concurrency),
          item_concurrency: clampConcurrency(s.item_concurrency, DEFAULT_SETTINGS.item_concurrency)
        };
      } else {
        await prisma.workerSettingsStore.create({
          data: {
            id: "default",
            default_delay_ms: DEFAULT_SETTINGS.default_delay_ms,
            jitter_enabled: DEFAULT_SETTINGS.jitter_enabled,
            max_concurrent_jobs: DEFAULT_SETTINGS.max_concurrent_jobs,
            user_agent_rotation: DEFAULT_SETTINGS.user_agent_rotation
          }
        });
      }
    } catch {
    }
  }
  setImportCallback(_cb) {
  }
  getSettings() {
    return { ...this.settings };
  }
  async updateSettings(newSettings) {
    this.settings = {
      ...this.settings,
      ...newSettings,
      page_concurrency: clampConcurrency(newSettings.page_concurrency ?? this.settings.page_concurrency, DEFAULT_SETTINGS.page_concurrency),
      item_concurrency: clampConcurrency(newSettings.item_concurrency ?? this.settings.item_concurrency, DEFAULT_SETTINGS.item_concurrency)
    };
    try {
      const dbPayload = {};
      for (const key of DB_SETTING_KEYS) {
        if (newSettings[key] !== void 0) dbPayload[key] = this.settings[key];
      }
      if (Object.keys(dbPayload).length > 0) {
        await prisma.workerSettingsStore.upsert({
          where: { id: "default" },
          update: dbPayload,
          create: { id: "default", ...dbPayload }
        });
      }
      if (newSettings.default_delay_ms !== void 0) {
        await prisma.crawlTask.updateMany({
          where: { status: { in: ["pending", "running"] } },
          data: { rate_limit_delay_ms: newSettings.default_delay_ms }
        });
      }
    } catch (e) {
      console.error("Error guardando settings de worker:", e);
    }
  }
  async getAllJobs() {
    try {
      const tasks = await prisma.crawlTask.findMany({
        orderBy: { created_at: "desc" }
      });
      return tasks.map((t) => ({
        id: t.id,
        name: t.name,
        target_url: t.target_url,
        status: t.status,
        scope: t.scope,
        max_pages: t.max_pages,
        current_page: t.current_page,
        total_discovered: t.total_discovered,
        shows_imported: t.shows_imported,
        episodes_imported: t.episodes_imported,
        rate_limit_delay_ms: t.rate_limit_delay_ms,
        items_queue: stripDiscoveryMarkers(parseJsonArray(t.items_queue)),
        current_item_title: t.current_item_title || void 0,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: parseJsonArray(t.logs)
      }));
    } catch (e) {
      console.error("Error buscando jobs en DB:", e);
      return [];
    }
  }
  async getJob(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t = await prisma.crawlTask.findUnique({ where: { id } });
        if (!t) return null;
        return {
          id: t.id,
          name: t.name,
          target_url: t.target_url,
          status: t.status,
          scope: t.scope,
          max_pages: t.max_pages,
          current_page: t.current_page,
          total_discovered: t.total_discovered,
          shows_imported: t.shows_imported,
          episodes_imported: t.episodes_imported,
          rate_limit_delay_ms: t.rate_limit_delay_ms,
          items_queue: stripDiscoveryMarkers(parseJsonArray(t.items_queue)),
          current_item_title: t.current_item_title || void 0,
          error_message: t.error_message,
          created_at: t.created_at.toISOString(),
          updated_at: t.updated_at.toISOString(),
          logs: parseJsonArray(t.logs)
        };
      } catch {
        if (attempt < 2) await this.sleep(150 * (attempt + 1));
      }
    }
    return null;
  }
  /** Lee items_queue CRUDO desde DB (con marcador de descubrimiento). Uso interno/resume. */
  async getRawQueueItems(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t = await prisma.crawlTask.findUnique({ where: { id }, select: { items_queue: true } });
        return parseJsonArray(t?.items_queue);
      } catch {
        if (attempt < 2) await this.sleep(150 * (attempt + 1));
      }
    }
    return [];
  }
  async createJob(options) {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetUrl = options.target_url.trim();
    const scope = options.scope || "catalog_pages";
    const maxPages = options.max_pages ?? (scope === "full_catalog" ? 0 : 1);
    const delay = options.delay_ms && options.delay_ms >= 500 ? options.delay_ms : this.settings.default_delay_ms;
    let domainName = "Sitio Web";
    try {
      if (targetUrl.startsWith("http")) {
        domainName = new URL(targetUrl).hostname.replace(/^www\./, "");
      } else {
        domainName = targetUrl.slice(0, 30);
      }
    } catch {
      domainName = targetUrl.slice(0, 30);
    }
    const jobName = options.name || `Importaci\xF3n de ${domainName} (${scope === "full_catalog" ? "Cat\xE1logo Completo" : `${options.max_pages || 1} p\xE1g`})`;
    const initialLog = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level: "info",
      message: scope === "full_catalog" ? `Tarea de BARRIDO COMPLETO creada para ${targetUrl}. Se recorrer\xE1 todo el cat\xE1logo autom\xE1ticamente (delay cort\xE9s de ${delay}ms).` : `Tarea creada para ${targetUrl}. En cola de ejecuci\xF3n del worker con delay cort\xE9s de ${delay}ms.`
    };
    const taskRecord = await prisma.crawlTask.create({
      data: {
        id,
        name: jobName,
        target_url: targetUrl,
        status: "pending",
        scope,
        max_pages: maxPages,
        current_page: 0,
        total_discovered: 0,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: delay,
        items_queue: "[]",
        error_message: null,
        logs: JSON.stringify([initialLog])
      }
    });
    return {
      id: taskRecord.id,
      name: taskRecord.name,
      target_url: taskRecord.target_url,
      status: "pending",
      scope: taskRecord.scope,
      max_pages: taskRecord.max_pages,
      current_page: 0,
      total_discovered: 0,
      shows_imported: 0,
      episodes_imported: 0,
      rate_limit_delay_ms: delay,
      items_queue: [],
      error_message: null,
      created_at: taskRecord.created_at.toISOString(),
      updated_at: taskRecord.updated_at.toISOString(),
      logs: [initialLog]
    };
  }
  async pauseJob(id) {
    const job = await this.getJob(id);
    if (!job) return false;
    if (job.status === "running" || job.status === "pending") {
      for (let i = 0; i < 3; i++) {
        try {
          await prisma.crawlTask.update({ where: { id }, data: { status: "paused" } });
          break;
        } catch (e) {
          if (e?.code !== "P1008" || i === 2) break;
          await new Promise((r) => setTimeout(r, 1e3 * (i + 1)));
        }
      }
      await this.addLog(id, "warn", "Tarea pausada por el usuario.");
      return true;
    }
    return false;
  }
  async resumeJob(id) {
    const job = await this.getJob(id);
    if (!job) return false;
    if (job.status === "paused") {
      for (let i = 0; i < 3; i++) {
        try {
          await prisma.crawlTask.update({ where: { id }, data: { status: "pending" } });
          break;
        } catch (e) {
          if (e?.code !== "P1008" || i === 2) break;
          await new Promise((r) => setTimeout(r, 1e3 * (i + 1)));
        }
      }
      await this.addLog(id, "info", "Tarea reanudada y puesta en cola.");
      return true;
    }
    return false;
  }
  async cancelJob(id) {
    const job = await this.getJob(id);
    if (!job) return false;
    for (let i = 0; i < 3; i++) {
      try {
        await prisma.crawlTask.update({ where: { id }, data: { status: "cancelled" } });
        break;
      } catch (e) {
        if (e?.code !== "P1008" || i === 2) break;
        await new Promise((r) => setTimeout(r, 1e3 * (i + 1)));
      }
    }
    await this.addLog(id, "warn", "Tarea cancelada.");
    return true;
  }
  async deleteJob(id) {
    try {
      const existing = await prisma.crawlTask.findUnique({ where: { id } });
      if (!existing) return false;
      if (existing.status === "running" || this.activeJobIds.has(id)) {
        await prisma.crawlTask.update({ where: { id }, data: { status: "cancelled" } });
        const deadline = Date.now() + 3e3;
        while (this.activeJobIds.has(id) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      await prisma.crawlTask.delete({ where: { id } });
      this.activeJobIds.delete(id);
      return true;
    } catch {
      return false;
    }
  }
  async clearFinishedJobs() {
    try {
      await prisma.crawlTask.deleteMany({
        where: {
          status: { in: ["completed", "failed", "cancelled"] }
        }
      });
    } catch (e) {
      console.error("Error limpiando tareas terminadas:", e);
    }
  }
  /**
   * Reclama atómicamente un job pendiente (por id) y lo ejecuta INMEDIATAMENTE
   * en este proceso, sin esperar el tick de 1s de la cola. Devuelve false si
   * otro proceso/worker ya lo reclamó o si no estaba pendiente.
   */
  async runJobNow(id) {
    const claimed = await prisma.crawlTask.updateMany({
      where: { id, status: "pending" },
      data: { status: "running" }
    });
    if (claimed.count !== 1) return false;
    const job = await this.getJob(id);
    if (!job) return false;
    this.activeJobIds.add(id);
    try {
      await this.executeJob(job);
      return true;
    } catch (e) {
      console.error(`[Worker] Fallo ejecutando job ${id}:`, e);
      await this.addLog(job.id, "error", `Fallo ejecutando tarea: ${e?.message || e}`);
      await this.updateJobState(job.id, { status: "failed", error_message: String(e?.message || e) });
      return false;
    } finally {
      this.activeJobIds.delete(id);
    }
  }
  /** Logs en memoria por job: flush al DB cada N segundos o al finalizar. */
  logBuffers = /* @__PURE__ */ new Map();
  lastLogFlush = 0;
  // Bajo presión de BD un flush puede tardar más que la generación de eventos.
  // Mantener una ventana acotada evita que un barrido grande convierta sus
  // mensajes de progreso en una segunda cola ilimitada dentro del proceso.
  static MAX_LOG_BUFFER_PER_JOB = 250;
  async addLog(id, level, message) {
    if (!this.logBuffers.has(id)) this.logBuffers.set(id, []);
    const buffer = this.logBuffers.get(id);
    buffer.push({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), level, message });
    if (buffer.length > _BackgroundCrawlerWorker.MAX_LOG_BUFFER_PER_JOB) {
      buffer.splice(0, buffer.length - _BackgroundCrawlerWorker.MAX_LOG_BUFFER_PER_JOB);
    }
    const now = Date.now();
    if (now - this.lastLogFlush > 5e3) {
      this.lastLogFlush = now;
      await this.flushLogs(id);
    }
  }
  async flushLogs(id) {
    const buf = this.logBuffers.get(id);
    if (!buf || buf.length === 0) return;
    try {
      const task = await prisma.crawlTask.findUnique({ where: { id }, select: { logs: true } });
      if (!task) {
        this.logBuffers.delete(id);
        return;
      }
      const logs = parseJsonArray(task.logs);
      logs.push(...buf);
      while (logs.length > 150) logs.shift();
      this.logBuffers.delete(id);
      enqueueWrite({ kind: "crawlTask.update", id, data: { logs: JSON.stringify(logs) } });
    } catch {
    }
  }
  async flushAllLogs() {
    for (const id of this.logBuffers.keys()) {
      await this.flushLogs(id);
    }
  }
  async updateJobState(id, data) {
    try {
      const payload = {};
      if (data.status) payload.status = data.status;
      if (typeof data.current_page === "number") payload.current_page = data.current_page;
      if (typeof data.total_discovered === "number") payload.total_discovered = data.total_discovered;
      if (typeof data.shows_imported === "number") payload.shows_imported = data.shows_imported;
      if (typeof data.episodes_imported === "number") payload.episodes_imported = data.episodes_imported;
      if (data.items_queue !== void 0) {
        payload.items_queue = typeof data.items_queue === "string" ? data.items_queue : JSON.stringify(data.items_queue);
      }
      if (data.current_item_title !== void 0) payload.current_item_title = data.current_item_title;
      if (data.error_message !== void 0) payload.error_message = data.error_message;
      if (data.logs !== void 0) {
        payload.logs = typeof data.logs === "string" ? data.logs : JSON.stringify(data.logs);
      }
      enqueueWrite({ kind: "crawlTask.update", id, data: payload });
    } catch (e) {
      console.error("Error encolando job state:", e);
    }
  }
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * Auto-throttle anti-bot: si el host acumula ≥3 señales en 10 min activa/sube
   * un override de delay SOLO para ese dominio (x2 → x4 máx, expira con la
   * ventana). Nunca modifica los settings globales.
   */
  syncHostThrottle(host) {
    const now = Date.now();
    const current = this.antiBotThrottle.get(host);
    if (current && current.until <= now) {
      this.antiBotThrottle.delete(host);
    }
    const recentHits = countRecentAntiBotHits(host, ANTIBOT_HIT_WINDOW_MS);
    if (recentHits < ANTIBOT_HITS_TO_THROTTLE) return;
    if (this.antiBotThrottle.has(host)) return;
    const factor = Math.min((current?.factor ?? 1) * 2, ANTIBOT_MAX_THROTTLE_FACTOR);
    this.antiBotThrottle.set(host, { factor, until: now + ANTIBOT_HIT_WINDOW_MS });
    console.warn(
      `[AntiBot] Auto-throttle ${host}: ${recentHits} se\xF1ales en 10 min \u2192 delay x${factor} temporal para ese dominio.`
    );
  }
  /**
   * Registra señales anti-bot observadas por el PROPIO worker (errores que los
   * adapters propagan como texto en discoverCatalogPages/guardado de items).
   * La vía principal de detección vive en BaseAdapter.fetchHtml; esta es la
   * red de seguridad para errores que llegan como string.
   */
  notePossibleAntiBot(jobId, url, errMsg) {
    if (!errMsg) return;
    const status = Number((/\b(403|429|503)\b/.exec(errMsg) || [])[1] || 0);
    const looksLikeChallenge = /cloudflare|just a moment|challenge-platform|_cf_chl|cf-browser-verification|attention required/i.test(errMsg);
    if (!status && !looksLikeChallenge) return;
    let verdict = detectAntiBot(status, {}, errMsg.slice(0, 800), siteOf(url));
    if (!verdict.blocked && status > 0) {
      verdict = { blocked: true, kind: "generic", evidence: `status ${status} en fallo del adapter` };
    }
    if (!verdict.blocked) return;
    const host = siteOf(url);
    recordAntiBotHit(host, verdict);
    console.warn(`[AntiBot] ${host}: ${verdict.kind} (${verdict.evidence}) [taskWorker]`);
    void this.addLog(
      jobId,
      "warn",
      `[AntiBot] El sitio ${host} muestra se\xF1ales anti-bot (${verdict.kind}: ${verdict.evidence}). Si se repite, el worker elevar\xE1 el delay solo para ese dominio.`
    );
  }
  async applyPoliteRateLimit(job) {
    const host = (() => {
      try {
        return new URL(job.target_url).hostname.replace(/^www\./, "");
      } catch {
        return "unknown";
      }
    })();
    this.syncHostThrottle(host);
    const baseDelay = Math.max(0, job.rate_limit_delay_ms ?? 500);
    const throttle = this.antiBotThrottle.get(host);
    let delay = baseDelay * (throttle && throttle.until > Date.now() ? throttle.factor : 1);
    if (this.settings.jitter_enabled) {
      delay += delay > 0 ? Math.round(Math.random() * delay * 0.4) : Math.floor(Math.random() * 121);
    }
    for (; ; ) {
      const now = Date.now();
      const last = this.lastSiteHitByHost.get(host) ?? 0;
      const earliest = last + delay;
      if (now >= earliest) {
        this.lastSiteHitByHost.set(host, now);
        return;
      }
      await this.sleep(earliest - now);
    }
  }
  async processNextInQueue() {
    if (this.isClaiming) return;
    this.isClaiming = true;
    try {
      const activeRecovery = await prisma.crawlTask.count({
        where: {
          scope: "source_recovery",
          status: { in: ["recovery_pending", "recovery_running"] }
        }
      });
      if (activeRecovery > 0) return;
      while (this.activeJobIds.size < clampConcurrency(this.settings.max_concurrent_jobs, DEFAULT_SETTINGS.max_concurrent_jobs)) {
        const pendingTask = await prisma.crawlTask.findFirst({
          where: { status: "pending" },
          orderBy: { created_at: "asc" }
        });
        if (!pendingTask) return;
        if (this.activeJobIds.has(pendingTask.id)) return;
        const claimed = await prisma.crawlTask.updateMany({
          where: { id: pendingTask.id, status: "pending" },
          data: { status: "running" }
        });
        if (claimed.count !== 1) continue;
        this.activeJobIds.add(pendingTask.id);
        void (async () => {
          try {
            const currentJob = await this.getJob(pendingTask.id);
            if (currentJob) {
              try {
                await this.executeJob(currentJob);
              } catch (err) {
                console.error(`[Worker] Job ${pendingTask.id} fall\xF3 con excepci\xF3n:`, err);
                await this.addLog(pendingTask.id, "error", `La tarea fall\xF3 con excepci\xF3n: ${err?.message || err}. Reanudable desde su progreso guardado.`);
                await this.updateJobState(pendingTask.id, { status: "failed", error_message: String(err?.message || err) });
              }
            }
          } catch (err) {
            console.error(`[Worker] Job ${pendingTask.id} error de infraestructura:`, err?.message || err);
          } finally {
            this.activeJobIds.delete(pendingTask.id);
          }
        })();
      }
    } catch (err) {
      console.error("Error en processNextInQueue:", err);
    } finally {
      this.isClaiming = false;
    }
  }
  async executeJob(job) {
    await this.addLog(job.id, "info", `Iniciando rastreador en segundo plano para: ${job.target_url}`);
    const rawQueue = await this.getRawQueueItems(job.id);
    const discoveryComplete = rawQueue.some(isDiscoveryMarker);
    const queue = stripDiscoveryMarkers(rawQueue);
    let discoveryDone = discoveryComplete;
    let stopped = false;
    let isCatalogFlow = false;
    if (!discoveryComplete) {
      if (queue.length === 0 && job.current_page < 1) {
        await this.addLog(job.id, "info", `Analizando estructura inicial y paginaci\xF3n...`);
        await this.applyPoliteRateLimit(job);
        const checkJob = await this.getJob(job.id);
        if (checkJob?.status !== "running") return;
        let analysis = null;
        let analysisError = null;
        try {
          analysis = await analyzeUniversalUrl(job.target_url);
        } catch (err) {
          analysisError = String(err?.message || err);
          await this.addLog(job.id, "warn", `No se pudo analizar la p\xE1gina inicial: ${analysisError}.`);
        }
        if (analysis && analysis.page_type === "catalog" && analysis.catalog_items.length > 0) {
          isCatalogFlow = true;
          const seen = new Set(queue.map((q) => canonicalCatalogUrl(q.url)));
          for (const item of dedupeCatalogItems(analysis.catalog_items)) {
            const itemKey = canonicalCatalogUrl(item?.url);
            if (item?.url && itemKey && !seen.has(itemKey)) {
              seen.add(itemKey);
              queue.push({ title: item.title, url: item.url, status: "pending" });
            }
          }
          job.total_discovered = queue.length;
          job.current_page = 1;
          await this.updateJobState(job.id, {
            items_queue: queue,
            total_discovered: job.total_discovered,
            current_page: 1
          });
          await this.addLog(job.id, "info", `P\xE1gina 1: ${queue.length} obras. Importaci\xF3n arranca YA en paralelo con el descubrimiento de p\xE1ginas siguientes.`);
        } else if (job.scope === "single" && analysis && analysis.page_type !== "catalog") {
          await this.addLog(job.id, "info", `Ficha individual detectada: '${analysis.title}'.`);
          queue.push({ title: analysis.title || job.target_url, url: job.target_url, status: "pending" });
          job.total_discovered = 1;
          job.current_page = 1;
          await this.updateJobState(job.id, {
            items_queue: queue,
            total_discovered: 1,
            current_page: 1
          });
        } else {
          const reason = analysisError || "el adaptador no devolvi\xF3 elementos de cat\xE1logo";
          await this.addLog(job.id, "error", `Importaci\xF3n detenida sin escribir una obra ficticia: ${reason}`);
          await this.updateJobState(job.id, { status: "failed", error_message: reason });
          return;
        }
      } else {
        isCatalogFlow = job.scope === "full_catalog" || queue.length > 1 || job.total_discovered > 1;
        await this.addLog(
          job.id,
          "info",
          `Reanudando barrido: progreso previo en p\xE1gina ${job.current_page} con ${queue.length} obras en cola. Continuando desde la p\xE1gina ${job.current_page + 1}...`
        );
      }
    } else {
      await this.addLog(
        job.id,
        "info",
        `Reanudando: descubrimiento ya completado anteriormente (${queue.length} obras en cola). Saltando directo a la indexaci\xF3n...`
      );
    }
    if (!discoveryComplete && !isCatalogFlow) {
      discoveryDone = true;
    }
    const concurrency = clampConcurrency(this.settings.item_concurrency, DEFAULT_SETTINGS.item_concurrency);
    let cursor = 0;
    const claimNext = () => {
      while (cursor < queue.length) {
        const idx = cursor++;
        const it = queue[idx];
        if (it.status !== "done") {
          return { index: idx, item: it, position: idx + 1 };
        }
      }
      return null;
    };
    const worker = async (workerId) => {
      for (; ; ) {
        if (stopped) return;
        const liveJob = await this.getJob(job.id);
        if (liveJob?.status !== "running") {
          stopped = true;
          return;
        }
        const claimed = claimNext();
        if (!claimed) {
          if (discoveryDone) return;
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const { item, position } = claimed;
        item.status = "processing";
        if (workerId === 0) {
          await this.updateJobState(job.id, { current_item_title: item.title });
        }
        await this.addLog(
          job.id,
          "info",
          `[${position}/${queue.length}] Extrayendo '${item.title}'...`
        );
        await this.applyPoliteRateLimit(job);
        if (stopped) return;
        try {
          const titleKey2 = normalizeTitleKey(item.title || "");
          if (titleKey2.length >= 2) {
            const knownCandidates = await prisma.show.findMany({
              where: { OR: [{ base_normalized_title: titleKey2 }, { normalized_title: titleKey2 }] },
              select: { id: true, title: true, year: true, category: true },
              orderBy: { created_at: "asc" },
              take: 20
            });
            const kindHint = kindHintFromCatalogUrl(job.target_url);
            const sameKindCandidates = kindHint ? knownCandidates.filter((show) => show.category === kindHint) : [];
            const candidates = sameKindCandidates.length > 0 ? sameKindCandidates : knownCandidates.length === 1 ? knownCandidates : [];
            const itemYear = isPlausibleYear(item.year) ? item.year : null;
            const knownShow = itemYear ? candidates.find((show) => show.year === itemYear) ?? candidates.find((show) => !isPlausibleYear(show.year)) ?? null : candidates[0] ?? null;
            if (knownShow) {
              const itemAnalysis2 = await analyzeUniversalUrl(item.url || item.title, "detail");
              const eps = normalizeExtractedEpisodes(
                itemAnalysis2.episodes,
                siteOf(item.url || job.target_url)
              );
              const { added } = await quickSyncKnownShow(knownShow.id, {
                title: itemAnalysis2.title || item.title,
                // Algunos adaptadores quitan el sufijo de temporada del
                // título normalizado; conservarlo desde título+slug evita
                // mezclar fuentes de S2/S3 dentro de T1.
                season: parseTitleQuery(`${item.title} ${item.url || ""}`).season,
                episodes: eps,
                source_site: siteOf(item.url || job.target_url)
              });
              item.status = "done";
              job.shows_imported++;
              job.episodes_imported += added;
              await this.addLog(
                job.id,
                "info",
                `[${position}/${queue.length}] Conocida '${knownShow.title}': re-escaneo ligero, +${added} episodio(s) nuevo(s).`
              );
              if (position % 5 === 0 || position === queue.length) {
                await this.persistQueueThrottled(job.id, queue, position === queue.length);
              }
              await this.updateJobState(job.id, {
                shows_imported: job.shows_imported,
                episodes_imported: job.episodes_imported
              });
              continue;
            }
          }
          const itemAnalysis = await analyzeUniversalUrl(item.url || item.title);
          const parsedItemTitle = parseTitleQuery(itemAnalysis.title || item.title);
          const sourceSite = siteOf(item.url || job.target_url);
          const result = await saveShowWithDeduplication({
            title: itemAnalysis.title || parsedItemTitle.baseTitle || item.title,
            season: parsedItemTitle.season,
            japanese_title: itemAnalysis.japanese_title,
            english_title: itemAnalysis.english_title,
            description: itemAnalysis.description,
            poster_url: itemAnalysis.poster_url,
            banner_url: itemAnalysis.banner_url,
            content_type: itemAnalysis.content_type,
            rating: itemAnalysis.rating,
            year: itemAnalysis.year ?? parsedItemTitle.year ?? void 0,
            status: itemAnalysis.status,
            genres: itemAnalysis.genres,
            source_site: sourceSite,
            episodes: itemAnalysis.episodes,
            detected_streams: itemAnalysis.detected_streams,
            original_title: itemAnalysis.original_title,
            tmdb_id: itemAnalysis.tmdb_id,
            ...(() => {
              const extra = itemAnalysis;
              return extra.poster_path || extra.backdrop_path ? { poster_path: extra.poster_path, backdrop_path: extra.backdrop_path } : {};
            })()
          });
          item.status = "done";
          job.shows_imported++;
          job.episodes_imported += result.episodesAdded;
          if (position % 5 === 0 || position === queue.length) {
            await this.persistQueueThrottled(job.id, queue, position === queue.length);
          }
          await this.updateJobState(job.id, {
            shows_imported: job.shows_imported,
            episodes_imported: job.episodes_imported
          });
          if (result.isDuplicate) {
            await this.addLog(
              job.id,
              "info",
              `\u2139 Duplicado detectado para '${result.show.title}'. Se fusionaron ${result.episodesAdded} episodio(s) nuevos.`
            );
          } else {
            await this.addLog(
              job.id,
              "success",
              `\u2713 Guardada nueva obra: '${result.show.title}' (${result.episodesAdded} ep/fuentes).`
            );
          }
        } catch (err) {
          item.status = "error";
          item.error = err?.message || String(err);
          this.notePossibleAntiBot(job.id, item.url || job.target_url, item.error);
          await this.updateJobState(job.id, { items_queue: queue });
          await this.addLog(job.id, "warn", `Error en '${item.title}': ${item.error}. Continuando con el siguiente...`);
        }
      }
    };
    const saversRunning = Promise.all(
      Array.from({ length: concurrency }, (_, w) => worker(w))
    );
    if (!discoveryDone) {
      const startPage = Math.max(2, job.current_page + 1);
      const endPageExclusive = job.scope === "full_catalog" ? FULL_CATALOG_HARD_PAGE_CAP + 1 : Math.max(2, job.max_pages + 1);
      const reason = await this.discoverCatalogPages(job, queue, startPage, endPageExclusive);
      if (reason === "stopped") stopped = true;
      discoveryDone = true;
      if (!stopped && queue.length > 0) {
        queue.push({ title: "", url: DISCOVERY_MARKER_URL, status: "done" });
        await this.updateJobState(job.id, { items_queue: queue });
      }
    }
    await saversRunning;
    if (stopped) {
      await this.updateJobState(job.id, { items_queue: queue });
      await this.addLog(job.id, "warn", "Procesamiento pausado o detenido. El progreso qued\xF3 guardado y es reanudable.");
      await this.updateJobState(job.id, { status: "paused" });
      return;
    }
    if (queue.length === 0) {
      await this.addLog(job.id, "warn", "No se descubri\xF3 ninguna obra (cat\xE1logo vac\xEDo o sitio inaccesible). Tarea finalizada.");
      await this.flushAllLogs();
      await this.updateJobState(job.id, { items_queue: [], status: "completed", error_message: null });
      return;
    }
    await this.flushAllLogs();
    await this.updateJobState(job.id, {
      items_queue: queue,
      status: "completed",
      current_item_title: void 0
    });
    await this.addLog(
      job.id,
      "success",
      `\xA1Barrido completado! P\xE1ginas recorridas: ${job.current_page}. Total: ${job.shows_imported} obras procesadas y ${job.episodes_imported} episodios/streams guardados en base de datos.`
    );
  }
  /**
   * Paginación AUTO-DESCUBIERTA: pide páginas en lotes de page_concurrency
   * (el token-bucket por host espacia las peticiones con cortesía aunque se
   * pidan en paralelo) y AVANZA HASTA AGOTAR EL CATÁLOGO:
   *  - página vacía → fin natural;
   *  - páginas consecutivas sin obras nuevas → fin (el sitio repite la última);
   *  - MAX_CONSECUTIVE_PAGE_ERRORS fallos seguidos → fin defensivo;
   *  - nunca supera endPageExclusive (fusible anti-bucle en full_catalog).
   * Un fallo de UNA página jamás aborta el barrido. Persiste current_page tras
   * cada página exitosa para poder REANUDAR sin saltar ni repetir páginas.
   */
  async discoverCatalogPages(job, queue, startPage, endPageExclusive) {
    const pageConcurrency = clampConcurrency(this.settings.page_concurrency, DEFAULT_SETTINGS.page_concurrency);
    const seen = new Set(queue.map((q) => canonicalCatalogUrl(q.url)));
    let consecutiveErrors = 0;
    let consecutiveNoNew = 0;
    let previousPageFingerprint;
    let page = startPage;
    await this.addLog(
      job.id,
      "info",
      job.scope === "full_catalog" ? `BARRIDO COMPLETO activado: se recorrer\xE1n TODAS las p\xE1ginas hasta agotar el cat\xE1logo (aut\xF3nomo, sin supervisi\xF3n). Concurrencia de p\xE1ginas=${pageConcurrency}.` : `Paginando hasta la p\xE1gina ${endPageExclusive - 1} con concurrencia=${pageConcurrency}.`
    );
    while (page < endPageExclusive) {
      const liveJob = await this.getJob(job.id);
      if (liveJob?.status !== "running") return "stopped";
      const batchPages = [];
      for (let p = page; p < Math.min(endPageExclusive, page + pageConcurrency); p++) batchPages.push(p);
      const batchUrls = batchPages.map((p) => ({ page: p, url: this.buildPageUrl(job.target_url, p) }));
      const results = await extractCatalogListingsBatch(
        batchUrls.map((b) => b.url),
        {
          concurrency: pageConcurrency,
          beforeRequest: () => this.applyPoliteRateLimit(job)
        }
      );
      for (let i = 0; i < results.length; i++) {
        const pageNo = batchUrls[i].page;
        const r = results[i];
        if (r.error) {
          consecutiveErrors++;
          this.notePossibleAntiBot(job.id, batchUrls[i].page_url || batchUrls[i].url, r.error);
          await this.addLog(job.id, "warn", `Aviso en p\xE1gina ${pageNo}: ${r.error}. El barrido contin\xFAa con las siguientes.`);
          if (consecutiveErrors >= MAX_CONSECUTIVE_PAGE_ERRORS) {
            await this.addLog(
              job.id,
              "error",
              `${MAX_CONSECUTIVE_PAGE_ERRORS} p\xE1ginas consecutivas fallaron: se detiene el descubrimiento por seguridad y se indexa lo ya descubierto (${queue.length} obras).`
            );
            return "completed";
          }
          continue;
        }
        consecutiveErrors = 0;
        if (r.items.length === 0) {
          await this.addLog(job.id, "info", `P\xE1gina ${pageNo} vac\xEDa: FIN del cat\xE1logo alcanzado de forma aut\xF3noma.`);
          return "completed";
        }
        const repeatedPage = isRepeatedCatalogPage(r.items, previousPageFingerprint);
        const currentPageFingerprint = catalogPageFingerprint(r.items);
        let newAdded = 0;
        for (const item of r.items) {
          const itemKey = canonicalCatalogUrl(item?.url);
          if (item?.url && itemKey && !seen.has(itemKey)) {
            seen.add(itemKey);
            queue.push({ title: item.title, url: item.url, status: "pending" });
            newAdded++;
          }
        }
        previousPageFingerprint = currentPageFingerprint || previousPageFingerprint;
        if (newAdded === 0) {
          consecutiveNoNew++;
          await this.addLog(
            job.id,
            "warn",
            repeatedPage ? `P\xE1gina ${pageNo} repite exactamente la anterior (${consecutiveNoNew}/${NO_NEW_ITEM_PAGES_BEFORE_STOP}): se detendr\xE1 solo tras confirmar la repetici\xF3n.` : `P\xE1gina ${pageNo} sin obras nuevas (${consecutiveNoNew}/${NO_NEW_ITEM_PAGES_BEFORE_STOP}): posible fin del cat\xE1logo o solapamiento.`
          );
          if (consecutiveNoNew >= NO_NEW_ITEM_PAGES_BEFORE_STOP) {
            await this.addLog(job.id, "info", `El sitio dej\xF3 de aportar contenido nuevo: FIN del cat\xE1logo alcanzado.`);
            return "completed";
          }
          continue;
        }
        consecutiveNoNew = 0;
        job.current_page = pageNo;
        job.total_discovered = queue.length;
        await this.updateJobState(job.id, {
          items_queue: queue,
          current_page: pageNo,
          total_discovered: job.total_discovered
        });
        console.log(`[Worker] '${job.name}': p\xE1gina ${pageNo} barrida (+${newAdded} obras, total ${queue.length}).`);
        await this.addLog(job.id, "info", `P\xE1gina ${pageNo}: +${newAdded} obras agregadas a la cola (total ${queue.length}).`);
      }
      page += batchPages.length;
    }
    await this.addLog(job.id, "info", `Se alcanz\xF3 el l\xEDmite de seguridad de ${endPageExclusive - 1} p\xE1ginas sin agotar el cat\xE1logo.`);
    return "completed";
  }
  /**
   * Construye la URL de la página N de un catálogo.
   *
   * 1) Reutiliza el patrón que YA trae la URL base (?page=, ?p=, ?pag=, /page/N/).
   * 2) Tabla de patrones verificados por sitio (2026-08-24):
   *      animeflv.net        → /browse?page=N
   *      animeflv.or.at / animeflv.or.am (+mirrors) → /anime/page/N/
   *      tioplus.app         → /peliculas/N
   *      latanime.org        → /animes?p=N
   *      tioanime.com        → /directorio?p=N
   *      veranimes.net       → /animes?pag=N
   *      cinecalidad.am      → /page/N/
   * 3) Genérico: ?page=N (si el sitio usa otro esquema, el detector de
   *    "páginas consecutivas sin obras nuevas" corta el barrido solo).
   */
  buildPageUrl(baseUrl, pageNumber) {
    return buildCatalogPageUrl(baseUrl, pageNumber);
  }
};
function kindHintFromCatalogUrl(url) {
  const value = String(url || "").toLowerCase();
  if (/animeflv|tioanime|latanime|hianimes|\/animes?\b/.test(value)) return "anime";
  if (/\/series?\b|tvshows?|doramas/.test(value)) return "series";
  if (/\/pel[ií]culas?\b|\/movies?\b|cinecalidad/.test(value)) return "movie";
  return null;
}
var taskWorker = new BackgroundCrawlerWorker();

// server/sourceRecoveryWorker.ts
init_universalScraper();
init_resolutionMetadata();

// server/sourceEvidence.ts
var SOURCE_EVIDENCE_STATUS = {
  DISCOVERED: "discovered",
  IDENTITY_MATCHED: "identity_matched",
  EXTRACTED: "extracted",
  MEDIA_CHECKED: "media_checked",
  PLAYER_VERIFIED: "player_verified",
  REFRESH_CHECKED: "refresh_checked",
  FAILED: "failed"
};
var ORDER = [
  SOURCE_EVIDENCE_STATUS.DISCOVERED,
  SOURCE_EVIDENCE_STATUS.IDENTITY_MATCHED,
  SOURCE_EVIDENCE_STATUS.EXTRACTED,
  SOURCE_EVIDENCE_STATUS.MEDIA_CHECKED,
  SOURCE_EVIDENCE_STATUS.PLAYER_VERIFIED,
  SOURCE_EVIDENCE_STATUS.REFRESH_CHECKED
];
function normalizeSourceEvidenceStatus(value) {
  if (typeof value !== "string") return SOURCE_EVIDENCE_STATUS.DISCOVERED;
  return ORDER.includes(value) ? value : value === SOURCE_EVIDENCE_STATUS.FAILED ? SOURCE_EVIDENCE_STATUS.FAILED : SOURCE_EVIDENCE_STATUS.DISCOVERED;
}
function isPlayerEligible(status) {
  return status === SOURCE_EVIDENCE_STATUS.MEDIA_CHECKED || status === SOURCE_EVIDENCE_STATUS.PLAYER_VERIFIED || status === SOURCE_EVIDENCE_STATUS.REFRESH_CHECKED;
}
function mergeSourceEvidenceStatus(previous, next) {
  const old = normalizeSourceEvidenceStatus(previous);
  if (old === SOURCE_EVIDENCE_STATUS.FAILED) return next;
  if (next === SOURCE_EVIDENCE_STATUS.FAILED) return old;
  return ORDER.indexOf(next) >= ORDER.indexOf(old) ? next : old;
}

// server/sourceRecoveryWorker.ts
var RECOVERY_SCOPE = "source_recovery";
var EXCLUDED_SITES = /* @__PURE__ */ new Set(["tubepelis.com", "www.tubepelis.com", "tubepelis"]);
var SEARCH_ADAPTERS = {
  animeflv: "animeflv",
  "animeflv.net": "animeflv",
  jkanime: "animeflv",
  tioanime: "tioanime",
  "tioanime.com": "tioanime",
  tioplus: "tioplus",
  "tioplus.app": "tioplus",
  cinecalidad: "cinecalidad",
  "cinecalidad.am": "cinecalidad",
  "cinecalidad.mx": "cinecalidad",
  "cinecalidad.im": "cinecalidad"
};
var DEFAULT_DELAY_MS = 800;
var MIN_DELAY_MS = 300;
var MAX_DELAY_MS = 1e4;
var FETCH_TIMEOUT_MS5 = 15e3;
var RECOVERY_ITEM_TIMEOUT_MS = 6e4;
var PERSIST_EVERY = 25;
function cleanSite(site) {
  const value = (site || "").trim().toLowerCase();
  if (value.startsWith("www.")) return value.slice(4);
  return value;
}
function isExcludedRecoverySite(siteOrUrl) {
  const value = (siteOrUrl || "").trim();
  const site = value.includes("://") ? siteFromUrl(value) : cleanSite(value);
  return EXCLUDED_SITES.has(site);
}
function siteFromUrl(rawUrl) {
  try {
    return cleanSite(new URL(rawUrl).hostname);
  } catch {
    return "unknown";
  }
}
function isSignedQuery(rawUrl) {
  return /[?&](?:s|e|exp|expires|expiry|token|jwt|h|hdnts|sig|signature|auth)=/i.test(rawUrl);
}
function isExpiredDirectUrl(rawUrl, now = Date.now()) {
  if (!rawUrl) return false;
  const parsed = parseStreamExpiry(rawUrl);
  if (parsed.expiresAt !== void 0) return parsed.expiresAt <= now;
  return hasSignedQuery(rawUrl) || isSignedQuery(rawUrl);
}
function isCatalogNavigationUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path7 = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (/\/page\/\d+$/.test(path7)) return true;
    for (const key of ["page", "p", "pag", "paged"]) {
      const value = url.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return true;
    }
    if (["/", "/peliculas", "/series", "/animes", "/browse", "/directorio", "/genero", "/year"].includes(path7)) return true;
    return false;
  } catch {
    return true;
  }
}
function isCanonicalLocator(rawUrl) {
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  if (isCatalogNavigationUrl(rawUrl)) return false;
  const kind = classifySourceKind(rawUrl);
  return kind === "page" || kind === "embed";
}
function uniqueUrls(values) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const value of values) {
    if (!isCanonicalLocator(value)) continue;
    const clean = value.trim();
    if (!seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}
function uniqueRecoveryUrls(values) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const value of values) {
    const clean = typeof value === "string" ? value.trim() : "";
    if (!clean || !isCanonicalLocator(clean) && classifySourceKind(clean) !== "stable_direct") continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}
function canonicalSourceLink(link) {
  return (link.link_type === "page" || link.link_type === "embed") && isCanonicalLocator(link.url);
}
function clampDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DELAY_MS;
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(n)));
}
function clampLimit(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(5e4, Math.round(n)) : void 0;
}
function parseQueue(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function titleKey(title) {
  return normalizeBaseTitle(title || "");
}
function candidateMatchesTitle(candidateTitle, targetTitle) {
  const left = titleKey(candidateTitle);
  const right = titleKey(targetTitle);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function mapLegacyCandidates(shows, target) {
  const targetKey = titleKey(target.title);
  const urls = [];
  for (const show of shows) {
    const showMatches = titleKey(show.title) === targetKey || titleKey(show.normalized_title) === targetKey || titleKey(show.base_normalized_title || "") === targetKey;
    if (!showMatches) continue;
    if (target.year !== null && show.year && Math.abs(show.year - target.year) > 1) continue;
    for (const episode of show.episodes) {
      if (Number(episode.episode_number) === Number(target.episode_number)) urls.push(episode.source_url);
    }
  }
  return uniqueUrls(urls);
}
function extractEpisodeUrl(analysis, targetEpisode) {
  const found = (analysis.episodes || []).find((episode) => Number(episode.number) === Number(targetEpisode) && isCanonicalLocator(episode.url));
  return found?.url;
}
function jobFromRecord(record) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    target_url: record.target_url,
    scope: RECOVERY_SCOPE,
    total_discovered: Number(record.total_discovered || 0),
    current_page: Number(record.current_page || 0),
    episodes_imported: Number(record.episodes_imported || 0),
    rate_limit_delay_ms: Number(record.rate_limit_delay_ms || DEFAULT_DELAY_MS),
    items_queue: parseQueue(record.items_queue),
    error_message: record.error_message || null,
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString()
  };
}
var SourceRecoveryWorker = class {
  activeJobId = null;
  pollTimer;
  startupReconciled = false;
  constructor() {
    this.pollTimer = setInterval(() => {
      void this.processNext().catch((error) => console.error("[SourceRecovery] poller:", error));
    }, 2e3);
    const timer = this.pollTimer;
    timer.unref?.();
  }
  async getJobs(limit = 20) {
    const rows = await prisma.crawlTask.findMany({
      where: { scope: RECOVERY_SCOPE },
      orderBy: { updated_at: "desc" },
      take: Math.min(100, Math.max(1, limit))
    });
    return rows.map(jobFromRecord);
  }
  async getJob(id) {
    const row = await prisma.crawlTask.findUnique({ where: { id } });
    return row && row.scope === RECOVERY_SCOPE ? jobFromRecord(row) : null;
  }
  /** Construye una cola DB-only; todavía no hace peticiones a proveedores. */
  async createJob(options = {}) {
    const mode = options.mode ?? "expired";
    const providerFilter = new Set((options.providers || []).map(cleanSite).filter(Boolean));
    const linkSelect = {
      media_episode_id: true,
      source_site: true,
      url: true,
      link_type: true,
      canonical_locator: true,
      media_episode: {
        select: {
          id: true,
          season_number: true,
          episode_number: true,
          media_item: { select: { id: true, title: true, kind: true, year: true } }
        }
      }
    };
    const directLinks = await prisma.sourceLink.findMany({
      where: mode === "all" ? { link_type: { in: ["direct", "page", "embed"] } } : { link_type: "direct" },
      select: linkSelect
    });
    const grouped = /* @__PURE__ */ new Map();
    const addGroupedLink = (link, provider) => {
      const sourceEpisode = link.media_episode;
      if (!sourceEpisode?.id || !sourceEpisode.media_item) return;
      const key = sourceEpisode.id;
      const current = grouped.get(key) || {
        episode: {
          id: sourceEpisode.id,
          season_number: sourceEpisode.season_number,
          episode_number: sourceEpisode.episode_number,
          media_item: sourceEpisode.media_item,
          links: []
        },
        providers: /* @__PURE__ */ new Set()
      };
      if (!current.episode.links.some((candidate) => candidate.url === link.url && candidate.source_site === link.source_site)) {
        current.episode.links.push({
          url: link.url,
          source_site: link.source_site,
          link_type: link.link_type,
          canonical_locator: link.canonical_locator
        });
      }
      current.providers.add(provider);
      grouped.set(key, current);
    };
    for (const link of directLinks) {
      const provider = cleanSite(link.source_site);
      if (isExcludedRecoverySite(provider) || providerFilter.size > 0 && !providerFilter.has(provider)) continue;
      const expired = isExpiredDirectUrl(link.url);
      if (mode !== "all" && !expired) continue;
      if (mode === "all" && link.link_type === "direct" && classifySourceKind(link.url) !== "stable_direct" && !isCanonicalLocator(link.canonical_locator || "")) continue;
      addGroupedLink(link, provider);
    }
    const invalidCatalogs = await prisma.sourceLink.findMany({
      where: { url: { contains: "/page/" } },
      select: linkSelect
    });
    for (const link of invalidCatalogs) {
      const provider = cleanSite(link.source_site);
      if (isExcludedRecoverySite(provider) || providerFilter.size > 0 && !providerFilter.has(provider)) continue;
      addGroupedLink(link, provider);
    }
    if (mode !== "all" && grouped.size > 0) {
      const allLinks = await prisma.sourceLink.findMany({
        where: { media_episode_id: { in: [...grouped.keys()] } },
        select: {
          media_episode_id: true,
          source_site: true,
          url: true,
          link_type: true,
          canonical_locator: true
        }
      });
      for (const link of allLinks) {
        const current = grouped.get(link.media_episode_id);
        if (!current) continue;
        if (!current.episode.links.some((candidate) => candidate.url === link.url && candidate.source_site === link.source_site)) {
          current.episode.links.push(link);
        }
        const provider = cleanSite(link.source_site);
        if (provider && !isExcludedRecoverySite(provider)) current.providers.add(provider);
      }
    }
    const targets = [...grouped.values()];
    const targetKeys = [...new Set(targets.map((entry) => titleKey(entry.episode.media_item.title)).filter(Boolean))];
    const legacyShows = targetKeys.length > 0 && targetKeys.length <= 1e3 ? await prisma.show.findMany({
      where: { OR: targetKeys.flatMap((key) => [{ normalized_title: key }, { base_normalized_title: key }]) },
      select: {
        title: true,
        normalized_title: true,
        base_normalized_title: true,
        year: true,
        episodes: { select: { episode_number: true, source_url: true } }
      }
    }) : [];
    if (targetKeys.length > 1e3) {
      console.log(`[SourceRecovery] ${targetKeys.length} t\xEDtulos: se omite fallback legacy masivo para mantener memoria acotada.`);
    }
    const queueRows = await prisma.crawlTask.findMany({
      where: { scope: { not: RECOVERY_SCOPE } },
      select: { target_url: true, items_queue: true }
    });
    const queueIndex = /* @__PURE__ */ new Map();
    for (const row2 of queueRows) {
      const targetSite = siteFromUrl(row2.target_url);
      if (isExcludedRecoverySite(targetSite)) continue;
      for (const item of parseQueue(row2.items_queue)) {
        if (!item.url || !item.title || !isCanonicalLocator(item.url)) continue;
        const key = titleKey(item.title);
        if (!key) continue;
        const list = queueIndex.get(key) || [];
        const itemSite = siteFromUrl(item.url) || targetSite;
        if (isExcludedRecoverySite(itemSite)) continue;
        list.push({ site: itemSite, url: item.url });
        queueIndex.set(key, list);
      }
    }
    let queue = targets.map(({ episode, providers }) => {
      const title = episode.media_item.title;
      const existingCanonical = episode.links.flatMap((link) => {
        if (link.canonical_locator && isCanonicalLocator(link.canonical_locator)) return [link.canonical_locator];
        return canonicalSourceLink(link) ? [link.url] : [];
      });
      const existingStableDirect = mode === "all" ? episode.links.filter((link) => classifySourceKind(link.url) === "stable_direct").map((link) => link.url) : [];
      const legacy = mapLegacyCandidates(legacyShows, {
        title,
        year: episode.media_item.year,
        episode_number: episode.episode_number
      });
      const indexed = queueIndex.get(titleKey(title)) || [];
      const sameProvider = indexed.filter((entry) => providers.has(entry.site)).map((entry) => entry.url);
      const anyProvider = indexed.map((entry) => entry.url);
      const candidateUrls = uniqueRecoveryUrls([...existingCanonical, ...existingStableDirect, ...legacy, ...sameProvider, ...anyProvider]).slice(0, 8);
      return {
        media_episode_id: episode.id,
        media_item_id: episode.media_item.id,
        title,
        kind: episode.media_item.kind,
        year: episode.media_item.year ?? null,
        season_number: episode.season_number,
        episode_number: episode.episode_number,
        provider_sites: [...providers],
        candidate_urls: candidateUrls,
        // Incluso las fichas ya almacenadas se vuelven a comprobar; que una
        // URL tenga forma canónica no garantiza que siga viva en el proveedor.
        status: "pending"
      };
    });
    queue.sort((a, b) => a.title.localeCompare(b.title) || a.episode_number - b.episode_number);
    const limit = clampLimit(options.limit);
    if (limit) queue = queue.slice(0, limit);
    const id = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const delay = clampDelay(options.delay_ms);
    const row = await prisma.crawlTask.create({
      data: {
        id,
        name: options.name || "Recuperaci\xF3n can\xF3nica de fuentes",
        target_url: mode === "all" ? "source-recovery://all-sources" : "source-recovery://expired-directs",
        status: "recovery_pending",
        scope: RECOVERY_SCOPE,
        max_pages: 0,
        current_page: 0,
        total_discovered: queue.length,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: delay,
        items_queue: JSON.stringify(queue),
        error_message: null,
        logs: JSON.stringify([{ timestamp: (/* @__PURE__ */ new Date()).toISOString(), level: "info", message: `Cola creada con ${queue.length} episodios (modo ${mode}).` }])
      }
    });
    return jobFromRecord(row);
  }
  async pauseJob(id) {
    const result = await prisma.crawlTask.updateMany({ where: { id, scope: RECOVERY_SCOPE, status: { in: ["recovery_pending", "recovery_running"] } }, data: { status: "recovery_paused" } });
    return result.count === 1;
  }
  async resumeJob(id) {
    const result = await prisma.crawlTask.updateMany({ where: { id, scope: RECOVERY_SCOPE, status: "recovery_paused" }, data: { status: "recovery_pending", error_message: null } });
    return result.count === 1;
  }
  async processNext() {
    if (this.activeJobId) return;
    if (!this.startupReconciled) {
      await prisma.crawlTask.updateMany({
        where: { scope: RECOVERY_SCOPE, status: "recovery_running" },
        data: { status: "recovery_pending", error_message: null }
      });
      this.startupReconciled = true;
    }
    const pending = await prisma.crawlTask.findFirst({ where: { scope: RECOVERY_SCOPE, status: "recovery_pending" }, orderBy: { created_at: "asc" } });
    if (!pending) return;
    const claimed = await prisma.crawlTask.updateMany({ where: { id: pending.id, scope: RECOVERY_SCOPE, status: "recovery_pending" }, data: { status: "recovery_running" } });
    if (claimed.count !== 1) return;
    this.activeJobId = pending.id;
    try {
      await this.execute(pending.id);
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      await prisma.crawlTask.updateMany({
        where: { id: pending.id, scope: RECOVERY_SCOPE, status: "recovery_running" },
        data: { status: "failed", error_message: message }
      });
      console.error(`[SourceRecovery] job ${pending.id} failed:`, message);
    } finally {
      this.activeJobId = null;
    }
  }
  async execute(id) {
    const record = await prisma.crawlTask.findUnique({ where: { id } });
    if (!record) return;
    const queue = parseQueue(record.items_queue);
    let recovered = Number(record.episodes_imported || 0);
    let errors = 0;
    for (let index = 0; index < queue.length; index++) {
      const live = await prisma.crawlTask.findUnique({ where: { id }, select: { status: true, rate_limit_delay_ms: true } });
      if (!live || live.status === "recovery_paused") return;
      if (live.status !== "recovery_running") return;
      const item = queue[index];
      if (item.status === "already_canonical" || item.status === "done") continue;
      item.status = "processing";
      await this.persist(id, queue, index);
      try {
        const canonical = await withTimeout(this.recoverItem(item), RECOVERY_ITEM_TIMEOUT_MS);
        if (canonical) {
          item.status = "done";
          item.canonical_url = canonical;
          recovered++;
        } else {
          item.status = "skipped";
        }
      } catch (error) {
        item.status = "error";
        item.error = String(error?.message || error).slice(0, 500);
        errors++;
      }
      await this.persist(id, queue, index, recovered, errors);
      const needsExternalSearch = item.candidate_urls.length === 0 || item.candidate_urls.some(
        (url) => !isCanonicalLocator(url) && classifySourceKind(url) !== "stable_direct"
      );
      if (needsExternalSearch) {
        await new Promise((resolve) => setTimeout(resolve, clampDelay(live.rate_limit_delay_ms)));
      }
    }
    await prisma.crawlTask.update({ where: { id }, data: { status: "completed", items_queue: JSON.stringify(queue), episodes_imported: recovered, error_message: errors ? `${errors} elementos no pudieron verificarse` : null } });
  }
  async persist(id, queue, index, recovered, errors) {
    if (index % PERSIST_EVERY !== 0 && index !== queue.length - 1) return;
    const done = queue.filter((item) => item.status === "done" || item.status === "already_canonical").length;
    await prisma.crawlTask.update({
      where: { id },
      data: {
        items_queue: JSON.stringify(queue),
        current_page: index + 1,
        episodes_imported: recovered ?? done,
        error_message: errors ? `${errors} errores parciales` : null
      }
    });
  }
  async recoverItem(item) {
    let candidates = [...item.candidate_urls];
    if (candidates.length === 0) {
      for (const provider of item.provider_sites) {
        const adapterId = SEARCH_ADAPTERS[cleanSite(provider)];
        if (!adapterId) continue;
        try {
          const analysis = await withTimeout(analyzeUniversalUrl(item.title, "auto", adapterId), FETCH_TIMEOUT_MS5);
          const exact = (analysis.catalog_items || []).filter(
            (entry) => candidateMatchesTitle(entry.title, item.title) && (!entry.year || !item.year || entry.year === item.year) && isCanonicalLocator(entry.url)
          );
          candidates.push(...exact.map((entry) => entry.url));
        } catch {
        }
      }
      candidates = uniqueUrls(candidates);
    }
    let firstRecovered;
    for (const candidate of candidates) {
      try {
        const directCandidate = classifySourceKind(candidate) === "stable_direct";
        let analysis;
        const canonicalCandidate = isCanonicalLocator(candidate);
        if (!canonicalCandidate && !directCandidate) {
          analysis = await withTimeout(analyzeUniversalUrl(candidate, "detail"), FETCH_TIMEOUT_MS5);
          if (analysis.page_type === "catalog") continue;
        }
        const episodeUrl = directCandidate || canonicalCandidate || item.kind === "movie" ? candidate : extractEpisodeUrl(analysis, item.episode_number);
        const locator = episodeUrl && (isCanonicalLocator(episodeUrl) || classifySourceKind(episodeUrl) === "stable_direct") ? episodeUrl : item.kind === "movie" && directCandidate ? candidate : void 0;
        if (!locator) continue;
        const sourceSite = siteFromUrl(locator);
        const locatorKind = classifySourceKind(locator);
        const linkType = locatorKind === "embed" ? "embed" : locatorKind === "stable_direct" ? "direct" : "page";
        const where = { media_episode_id_source_site_url: { media_episode_id: item.media_episode_id, source_site: sourceSite, url: locator } };
        const existing = typeof prisma.sourceLink.findUnique === "function" ? await prisma.sourceLink.findUnique({ where, select: { source_status: true, failure_reason: true } }) : null;
        const priorPlayerEvidence = isPlayerEligible(existing?.source_status);
        const nextStatus = mergeSourceEvidenceStatus(existing?.source_status, SOURCE_EVIDENCE_STATUS.DISCOVERED);
        const checkedAt = /* @__PURE__ */ new Date();
        await prisma.sourceLink.upsert({
          where,
          create: {
            media_episode_id: item.media_episode_id,
            source_site: sourceSite,
            url: locator,
            link_type: linkType,
            host: sourceSite,
            is_verified: false,
            source_status: nextStatus,
            canonical_locator: locator,
            extraction_method: "source_recovery_jit",
            resolver_version: "source-recovery-v2",
            failure_reason: priorPlayerEvidence ? void 0 : null,
            last_checked: checkedAt,
            last_success: null,
            last_failure: null
          },
          update: {
            link_type: linkType,
            host: sourceSite,
            is_verified: false,
            source_status: nextStatus,
            canonical_locator: locator,
            extraction_method: "source_recovery_jit",
            resolver_version: "source-recovery-v2",
            failure_reason: priorPlayerEvidence ? void 0 : null,
            last_checked: checkedAt,
            last_success: void 0,
            last_failure: void 0
          }
        });
        firstRecovered ||= locator;
      } catch {
      }
    }
    return firstRecovered;
  }
};
var sourceRecoveryWorker = new SourceRecoveryWorker();

// server/legacyCanonicalBridge.ts
function keyOf(value, normalize) {
  return typeof value === "string" ? normalize(value) : "";
}
function sameEpisode(a, b) {
  if (a == null || b == null) return true;
  return Number(a) === Number(b);
}
function selectCanonicalPlaybackCandidate(legacyShow, legacyEpisode, candidates, normalizeTitle2, normalizeBaseTitle2, isCanonicalLocator2) {
  const legacyTitle = legacyShow.title || legacyShow.normalized_title || "";
  const legacyTitleKey = keyOf(legacyTitle, normalizeTitle2);
  const legacyBaseKey = keyOf(legacyShow.base_normalized_title || legacyTitle, normalizeBaseTitle2);
  const legacyTmdb = legacyShow.tmdb_id ?? null;
  const legacyYear = legacyShow.year ?? null;
  const legacyEpisodeNumber = legacyEpisode?.episode_number ?? legacyShow.episode_number ?? 1;
  const legacyKind = (legacyShow.category || "").toLowerCase();
  const scored = candidates.map((candidate) => {
    const item = candidate.media_item;
    const itemTitleKey = keyOf(item.normalized_title || item.title, normalizeTitle2);
    const itemBaseKey = keyOf(item.base_normalized_title || item.title, normalizeBaseTitle2);
    const tmdbMatch = legacyTmdb != null && item.tmdb_id != null && legacyTmdb === item.tmdb_id;
    const titleMatch = Boolean(legacyTitleKey && (legacyTitleKey === itemTitleKey || legacyTitleKey === keyOf(item.title, normalizeTitle2)));
    const baseMatch = Boolean(legacyBaseKey && legacyBaseKey === itemBaseKey);
    const yearDiff = legacyYear != null && item.year != null ? Math.abs(legacyYear - item.year) : null;
    const yearMatch = yearDiff == null || yearDiff <= 1;
    const kindMatch = !legacyKind || !item.kind || legacyKind === item.kind.toLowerCase();
    const episodeMatch = sameEpisode(legacyEpisodeNumber, candidate.episode_number);
    const canonicalLinks = candidate.links.filter(
      (link) => (link.link_type === "page" || link.link_type === "embed") && isCanonicalLocator2(link.url)
    );
    if (!tmdbMatch && !titleMatch && !baseMatch || !episodeMatch || !yearMatch || !kindMatch || canonicalLinks.length === 0) {
      return null;
    }
    let score = canonicalLinks.length * 2;
    if (tmdbMatch) score += 100;
    if (titleMatch) score += 60;
    if (baseMatch) score += 40;
    if (yearDiff === 0) score += 15;
    else if (yearDiff == null || yearDiff <= 1) score += 5;
    if (kindMatch) score += 3;
    return { candidate, score };
  }).filter((entry) => entry !== null).sort((a, b) => b.score - a.score);
  return scored[0]?.candidate || null;
}

// server.ts
init_resolvers();

// server/serverPriorities.ts
var import_fs4 = __toESM(require("fs"), 1);
var import_path4 = __toESM(require("path"), 1);
var PRIORITIES_PATH = import_path4.default.join(process.cwd(), "data", "server-priorities.json");
function ensureDir2() {
  const dir = import_path4.default.dirname(PRIORITIES_PATH);
  if (!import_fs4.default.existsSync(dir)) import_fs4.default.mkdirSync(dir, { recursive: true });
}
function loadAll() {
  try {
    if (!import_fs4.default.existsSync(PRIORITIES_PATH)) return {};
    return JSON.parse(import_fs4.default.readFileSync(PRIORITIES_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveAll(map) {
  ensureDir2();
  const tmp = PRIORITIES_PATH + ".tmp";
  import_fs4.default.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
  import_fs4.default.renameSync(tmp, PRIORITIES_PATH);
}
function familyOf(hostOrUrl) {
  const h = String(hostOrUrl || "").toLowerCase();
  const host = h.includes("://") ? hostOfUrl(h) : h.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : host;
}
function hostOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(url || "").slice(0, 40).toLowerCase();
  }
}
function getServerPriorities(platform) {
  return loadAll()[cleanPlatform(platform)] || {};
}
function setServerOrder(platform, orderedHosts) {
  const all = loadAll();
  const key = cleanPlatform(platform);
  const ranks = {};
  orderedHosts.forEach((host, i) => {
    if (host) ranks[familyOf(host)] = i + 1;
  });
  all[key] = ranks;
  saveAll(all);
}
function moveServerPriority(platform, host, dir) {
  const all = loadAll();
  const key = cleanPlatform(platform);
  const current = all[key] || {};
  const ordered = Object.entries(current).sort((a, b) => a[1] - b[1]).map(([h2]) => h2);
  const h = familyOf(host);
  const idx = ordered.indexOf(h);
  if (idx === -1) {
    if (dir === -1) ordered.unshift(h);
    else ordered.push(h);
  } else {
    const swap = idx + dir;
    if (swap < 0 || swap >= ordered.length) return;
    const tmp = ordered[idx];
    ordered[idx] = ordered[swap];
    ordered[swap] = tmp;
  }
  const ranks = {};
  ordered.forEach((x, i) => {
    ranks[x] = i + 1;
  });
  all[key] = ranks;
  saveAll(all);
}
function cleanPlatform(p) {
  return String(p || "").toLowerCase().trim();
}

// server/siteRatingService.ts
var CACHE_TTL_MS = 6e4;
var DEFAULT_RATING = 5;
var cache = /* @__PURE__ */ new Map();
function siteFromDomain(host) {
  const h = String(host || "").toLowerCase().trim();
  if (!h) return "";
  const withoutWww = h.replace(/^www\./, "");
  return withoutWww.split(".")[0] || "";
}
function normalizeSite(site) {
  return site.includes(".") ? siteFromDomain(site) : site.toLowerCase().trim();
}
async function getSiteRating(site) {
  const key = normalizeSite(site);
  if (!key) return DEFAULT_RATING;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.enabled ? hit.rating : DEFAULT_RATING;
  }
  try {
    const row = await prisma.siteRating.findUnique({ where: { site: key } });
    if (row) {
      cache.set(key, {
        rating: row.rating,
        enabled: row.enabled,
        expiresAt: Date.now() + CACHE_TTL_MS
      });
      return row.enabled ? row.rating : DEFAULT_RATING;
    }
    cache.set(key, { rating: DEFAULT_RATING, enabled: true, expiresAt: Date.now() + CACHE_TTL_MS });
    return DEFAULT_RATING;
  } catch {
    return DEFAULT_RATING;
  }
}
async function getAllSiteRatings() {
  const rows = await prisma.siteRating.findMany({ orderBy: [{ rating: "desc" }, { site: "asc" }] });
  return rows.map((r) => ({ site: r.site, rating: r.rating, enabled: r.enabled, notes: r.notes }));
}
async function upsertSiteRating(site, rating, enabled, notes) {
  const key = normalizeSite(site);
  if (!key) throw new Error("site requerido");
  const data = {};
  if (typeof rating === "number" && Number.isFinite(rating)) {
    data.rating = Math.max(0, Math.min(10, rating));
  }
  if (typeof enabled === "boolean") data.enabled = enabled;
  if (notes !== void 0) data.notes = notes;
  const row = await prisma.siteRating.upsert({
    where: { site: key },
    update: data,
    create: { site: key, rating: data.rating ?? DEFAULT_RATING, enabled: data.enabled ?? true, notes: data.notes ?? null }
  });
  cache.delete(key);
  return { site: row.site, rating: row.rating, enabled: row.enabled, notes: row.notes };
}

// server/playbackSessions.ts
var crypto4 = __toESM(require("crypto"), 1);
var import_node_stream = require("node:stream");
var import_promises = require("node:stream/promises");
init_resolvers();
init_hostProfiles();
init_resolutionMetadata();
var PlaybackSessionStore = class {
  sessions = /* @__PURE__ */ new Map();
  refreshing = /* @__PURE__ */ new Map();
  resolver;
  now;
  sessionTtlMs;
  maxSessions;
  maxResourcesPerSession;
  constructor(options = {}) {
    this.resolver = options.resolver ?? ((url) => EmbedResolvers.resolveWithMeta(url));
    this.now = options.now ?? (() => Date.now());
    this.sessionTtlMs = Math.max(1, options.sessionTtlMs ?? 45 * 60 * 1e3);
    this.maxSessions = Math.max(1, options.maxSessions ?? 64);
    this.maxResourcesPerSession = Math.max(1, options.maxResourcesPerSession ?? 300);
  }
  async create(originalUrl) {
    const current = await this.resolver(originalUrl);
    return this.createFromResolved(originalUrl, current);
  }
  /**
   * Opens a session from an already-resolved response (for example `/resolve-embed`)
   * so the caller does not pay for a second resolver pass.
   */
  createFromResolved(originalUrl, current) {
    const requestedOriginal = (originalUrl || "").trim();
    if (!requestedOriginal) throw new Error("Falta el origen de reproducci\xF3n");
    if (!current.resolved || !current.url) throw new Error("No se pudo resolver un stream reproducible");
    if (current.is_proxyable === false) throw new Error("El stream no admite entrega proxy");
    const hasCompleteTiming = Boolean(
      current.resolution_id?.trim() && Number.isFinite(current.resolved_at) && Number.isFinite(current.refresh_after) && Number.isFinite(current.expires_at)
    );
    const normalized = hasCompleteTiming ? current : {
      ...current,
      ...createResolutionTiming({
        originalUrl: current.original_url || requestedOriginal,
        upstreamUrl: current.url,
        provider: current.provider,
        now: this.now(),
        resolutionId: current.resolution_id
      })
    };
    const now = this.now();
    if (Number.isFinite(normalized.expires_at) && now >= normalized.expires_at) {
      throw new Error("El stream firmado ya expir\xF3");
    }
    this.pruneSessions(now, 1);
    const session = {
      id: crypto4.randomUUID(),
      original_url: normalized.canonical_locator || requestedOriginal,
      current: normalized,
      created_at: now,
      last_accessed_at: now,
      resources: /* @__PURE__ */ new Map()
    };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) return void 0;
    if (this.now() - session.last_accessed_at > this.sessionTtlMs) {
      this.sessions.delete(id);
      return void 0;
    }
    session.last_accessed_at = this.now();
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }
  /** Cheap operational counters; no signed URLs or resource data are exposed. */
  stats() {
    this.pruneSessions(this.now());
    let resources = 0;
    for (const session of this.sessions.values()) resources += session.resources.size;
    return { sessions: this.sessions.size, refreshing: this.refreshing.size, resources };
  }
  async upstream(id) {
    const session = this.require(id);
    const now = this.now();
    if (Number.isFinite(session.current.expires_at) && now >= session.current.expires_at) {
      if (session.current.is_refreshable && session.current.canonical_locator) return this.refresh(id, true);
      throw new Error("La sesi\xF3n firmada expir\xF3 y no tiene localizador renovable");
    }
    if (session.current.is_refreshable && session.current.canonical_locator && Number.isFinite(session.current.refresh_after) && now >= session.current.refresh_after) return this.refresh(id);
    return session.current;
  }
  async refresh(id, force = false) {
    const session = this.require(id);
    if (!session.current.is_refreshable || !session.current.canonical_locator) {
      throw new Error("La sesi\xF3n no tiene un localizador renovable");
    }
    if (!force && this.now() < session.current.refresh_after) return session.current;
    const inFlight = this.refreshing.get(id);
    if (inFlight) return inFlight;
    const work = this.resolver(session.original_url).then((next) => {
      if (!next.resolved || !next.url || next.is_proxyable === false) {
        throw new Error("No se pudo renovar la sesi\xF3n de reproducci\xF3n");
      }
      session.current = next;
      return next;
    }).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, work);
    return work;
  }
  /** Retry trigger for proxies after the upstream rejects an expired token. */
  async refreshForUpstreamStatus(id, status) {
    if (status !== 401 && status !== 403) return void 0;
    const session = this.require(id);
    if (!session.current.is_refreshable || !session.current.canonical_locator) return void 0;
    return this.refresh(id, true);
  }
  registerResource(id, resource) {
    const session = this.require(id);
    const key = crypto4.createHash("sha256").update(JSON.stringify(resource)).digest("base64url").slice(0, 24);
    if (session.resources.has(key)) {
      session.resources.delete(key);
    } else if (session.resources.size >= this.maxResourcesPerSession) {
      const oldest = session.resources.keys().next().value;
      if (oldest) session.resources.delete(oldest);
    }
    session.resources.set(key, resource);
    return key;
  }
  resourceUrl(id, key) {
    const session = this.get(id);
    const resource = session?.resources.get(key);
    if (!session || !resource) return void 0;
    session.resources.delete(key);
    session.resources.set(key, resource);
    return this.resolveResourceUrl(session, key, /* @__PURE__ */ new Set());
  }
  rewriteManifest(id, manifest, parentUrl, pathPrefix = "/api/v1/playback", parentResourceId) {
    return manifest.split(/\r?\n/).map((line) => {
      const value = line.trim();
      if (!value) return line;
      if (value.startsWith("#")) {
        return line.replace(/URI=("([^"]*)"|([^,\s]*))/gi, (match, quoted, quotedValue, bareValue) => {
          const opaque = this.toOpaqueResource(id, quotedValue ?? bareValue, parentUrl, pathPrefix, parentResourceId);
          return opaque ? `URI=${quoted ? `"${opaque}"` : opaque}` : match;
        });
      }
      return this.toOpaqueResource(id, value, parentUrl, pathPrefix, parentResourceId) ?? line;
    }).join("\n");
  }
  toOpaqueResource(id, value, parentUrl, pathPrefix, parentResourceId) {
    if (!value) return void 0;
    try {
      const absolute = new URL(value, parentUrl).toString();
      const generation = this.require(id).current.generation;
      const key = this.registerResource(id, {
        upstreamUrl: absolute,
        registeredGeneration: generation,
        registeredBaseUrl: parentUrl,
        ...parentResourceId ? { parentResourceId, parentRelative: value } : { rootRelative: value }
      });
      return `${pathPrefix}/${encodeURIComponent(id)}/resource/${encodeURIComponent(key)}`;
    } catch {
      return void 0;
    }
  }
  resolveResourceUrl(session, key, seen) {
    if (seen.has(key)) return void 0;
    seen.add(key);
    const resource = session.resources.get(key);
    if (!resource) return void 0;
    if (resource.rootRelative) {
      if (/^https?:\/\//i.test(resource.rootRelative) && resource.registeredGeneration === session.current.generation) {
        return resource.upstreamUrl;
      }
      return this.rebaseResource(resource.rootRelative, session.current.url, resource.registeredBaseUrl);
    }
    if (resource.parentResourceId && resource.parentRelative) {
      if (/^https?:\/\//i.test(resource.parentRelative) && resource.registeredGeneration === session.current.generation) {
        return resource.upstreamUrl;
      }
      const parent = this.resolveResourceUrl(session, resource.parentResourceId, seen);
      return parent ? this.rebaseResource(resource.parentRelative, parent, resource.registeredBaseUrl) : void 0;
    }
    return resource.upstreamUrl;
  }
  rebaseResource(locator, refreshedBase, registeredBase) {
    if (!/^https?:\/\//i.test(locator)) return new URL(locator, refreshedBase).toString();
    const oldResource = new URL(locator);
    const renewedBase = new URL(refreshedBase);
    const oldBase = registeredBase ? new URL(registeredBase) : void 0;
    const oldDirectory = oldBase ? oldBase.pathname.replace(/[^/]*$/, "") : "";
    const renewedDirectory = renewedBase.pathname.replace(/[^/]*$/, "");
    renewedBase.pathname = oldDirectory && oldResource.pathname.startsWith(oldDirectory) ? `${renewedDirectory}${oldResource.pathname.slice(oldDirectory.length)}` : oldResource.pathname;
    renewedBase.hash = oldResource.hash;
    return renewedBase.toString();
  }
  require(id) {
    const session = this.get(id);
    if (!session) throw new Error("Sesi\xF3n de reproducci\xF3n no encontrada o expirada");
    return session;
  }
  pruneSessions(now, reserveSlots = 0) {
    for (const [id, session] of this.sessions) {
      if (now - session.last_accessed_at > this.sessionTtlMs) this.sessions.delete(id);
    }
    const targetSize = Math.max(0, this.maxSessions - reserveSlots);
    while (this.sessions.size > targetSize) {
      const oldestId = this.sessions.keys().next().value;
      if (!oldestId) break;
      this.sessions.delete(oldestId);
    }
  }
};
function isManifest(response, url) {
  return /mpegurl/i.test(response.headers.get("content-type") || "") || /\.m3u8(?:\?|$)/i.test(url);
}
async function readManifestLimited(response, maxBytes = 2 * 1024 * 1024) {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel().catch(() => void 0);
    throw new Error("Manifiesto HLS demasiado grande");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Manifiesto HLS demasiado grande");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (bytes > maxBytes) await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}
function createPlaybackSessionHandlers(store, pathPrefix = "/api/v1/playback", hooks = {}) {
  const proxy = (root) => async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const context = {
      sessionId: String(req.params.sessionId || ""),
      kind: root ? "manifest" : "resource"
    };
    let status;
    let relayError;
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) abort();
    });
    try {
      hooks.onRelayStart?.(context);
    } catch {
    }
    try {
      const sessionId = context.sessionId;
      const resourceId = String(req.params.resourceId || "");
      const url = root ? (await store.upstream(sessionId)).url : store.resourceUrl(sessionId, resourceId);
      if (!url) {
        res.sendStatus(404);
        return;
      }
      const session = store.get(sessionId);
      if (!session) {
        res.sendStatus(404);
        return;
      }
      const fetchUpstream = async (target) => {
        const range = req.header("range");
        const profiled = buildProxyHeaders(target, session.original_url, range || void 0);
        const headers = new Headers(profiled.headers);
        for (const [name, value] of Object.entries(session.current.requiredHeaders || {})) {
          headers.set(name, value);
        }
        return fetch(target, { headers, signal: controller.signal });
      };
      let upstream = await fetchUpstream(url);
      if (upstream.status === 401 || upstream.status === 403) {
        const refreshed = await store.refreshForUpstreamStatus(sessionId, upstream.status);
        if (refreshed) {
          await upstream.body?.cancel();
          const renewed = root ? refreshed.url : store.resourceUrl(sessionId, resourceId);
          if (renewed) upstream = await fetchUpstream(renewed);
        }
      }
      status = upstream.status;
      for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (isManifest(upstream, upstream.url || url)) {
        const body = await readManifestLimited(upstream);
        res.removeHeader("content-length");
        res.removeHeader("content-range");
        res.status(upstream.status).type("application/vnd.apple.mpegurl").send(store.rewriteManifest(sessionId, body, upstream.url || url, pathPrefix, root ? void 0 : resourceId));
        return;
      }
      if (!upstream.body) {
        res.status(upstream.status).end();
        return;
      }
      res.status(upstream.status);
      await (0, import_promises.pipeline)(import_node_stream.Readable.fromWeb(upstream.body), res);
    } catch (error) {
      relayError = error;
      if (!controller.signal.aborted && !res.headersSent) next(error);
    } finally {
      req.removeListener("aborted", abort);
      try {
        hooks.onRelayEnd?.({ ...context, status, ...relayError === void 0 ? {} : { error: relayError } });
      } catch {
      }
    }
  };
  return { masterManifest: proxy(true), resource: proxy(false) };
}

// server/streamHealthService.ts
init_hostHealth();

// server/runtimeBudget.ts
var MIB = 1024 * 1024;
var asFiniteNonNegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
var RuntimeBudget = class {
  thresholds;
  now;
  readMemory;
  clearIntervalFn;
  timer;
  expectedTickAt = 0;
  activeRelays = 0;
  activeResolutions = 0;
  eventLoopLagMs = 0;
  careLagStreak = 0;
  saturatedLagStreak = 0;
  lastMemory = { rssBytes: 0, heapUsedBytes: 0 };
  sampledAt = 0;
  constructor(options = {}) {
    const careRssBytes = options.careRssBytes ?? 450 * MIB;
    const saturatedRssBytes = options.saturatedRssBytes ?? 600 * MIB;
    const careHeapBytes = options.careHeapBytes ?? 256 * MIB;
    const saturatedHeapBytes = options.saturatedHeapBytes ?? 384 * MIB;
    const careRelays = options.careRelays ?? 3;
    const saturatedRelays = options.saturatedRelays ?? 6;
    const careResolutions = options.careResolutions ?? 2;
    const saturatedResolutions = options.saturatedResolutions ?? 4;
    this.thresholds = {
      careRssBytes,
      saturatedRssBytes: Math.max(saturatedRssBytes, careRssBytes),
      careHeapBytes,
      saturatedHeapBytes: Math.max(saturatedHeapBytes, careHeapBytes),
      careEventLoopLagMs: options.careEventLoopLagMs ?? 75,
      saturatedEventLoopLagMs: Math.max(
        options.saturatedEventLoopLagMs ?? 250,
        options.careEventLoopLagMs ?? 75
      ),
      sustainedLagSamples: Math.max(1, Math.floor(options.sustainedLagSamples ?? 2)),
      careRelays,
      saturatedRelays: Math.max(saturatedRelays, careRelays),
      careResolutions,
      saturatedResolutions: Math.max(saturatedResolutions, careResolutions),
      sampleIntervalMs: Math.max(100, options.sampleIntervalMs ?? 1e3)
    };
    this.now = options.now ?? Date.now;
    this.readMemory = options.readMemory ?? (() => {
      const usage = process.memoryUsage();
      return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
    });
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.sample();
    if (options.autoStart !== false) {
      const schedule = options.setIntervalFn ?? setInterval;
      this.expectedTickAt = this.now() + this.thresholds.sampleIntervalMs;
      this.timer = schedule(() => this.onTimer(), this.thresholds.sampleIntervalMs);
      this.timer.unref?.();
    }
  }
  /** Refreshes memory data. Optional metrics make unit tests and diagnostics deterministic. */
  sample(metrics = this.readMemory()) {
    this.lastMemory = {
      rssBytes: asFiniteNonNegative(metrics.rssBytes, this.lastMemory.rssBytes),
      heapUsedBytes: asFiniteNonNegative(metrics.heapUsedBytes, this.lastMemory.heapUsedBytes)
    };
    this.sampledAt = this.now();
    return this.currentSnapshot();
  }
  /** Records observed timer drift. Pressure requires consecutive bad samples. */
  recordEventLoopLag(lagMs) {
    this.eventLoopLagMs = asFiniteNonNegative(lagMs, 0);
    this.careLagStreak = this.eventLoopLagMs >= this.thresholds.careEventLoopLagMs ? this.careLagStreak + 1 : 0;
    this.saturatedLagStreak = this.eventLoopLagMs >= this.thresholds.saturatedEventLoopLagMs ? this.saturatedLagStreak + 1 : 0;
    return this.currentSnapshot();
  }
  beginRelay() {
    this.activeRelays += 1;
    return this.lease(() => this.endRelay());
  }
  tryBeginRelay() {
    if (this.shouldFallback()) return null;
    return this.beginRelay();
  }
  endRelay() {
    this.activeRelays = Math.max(0, this.activeRelays - 1);
  }
  beginResolution() {
    this.activeResolutions += 1;
    return this.lease(() => this.endResolution());
  }
  tryBeginResolution(options = {}) {
    if (this.shouldFallback() && !(options.interactive && this.activeResolutions === 0)) return null;
    return this.beginResolution();
  }
  endResolution() {
    this.activeResolutions = Math.max(0, this.activeResolutions - 1);
  }
  snapshot(options = {}) {
    return options.refreshMemory === false ? this.currentSnapshot() : this.sample();
  }
  shouldFallback() {
    return this.mode() === "saturated";
  }
  suggestedFallback() {
    return this.shouldFallback() ? "embed" : null;
  }
  dispose() {
    if (this.timer !== void 0) {
      this.clearIntervalFn(this.timer);
      this.timer = void 0;
    }
  }
  lease(onRelease) {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        onRelease();
      }
    };
  }
  onTimer() {
    const current = this.now();
    this.recordEventLoopLag(Math.max(0, current - this.expectedTickAt));
    this.expectedTickAt = current + this.thresholds.sampleIntervalMs;
    this.sample();
  }
  mode() {
    const sustained = this.thresholds.sustainedLagSamples;
    if (this.lastMemory.rssBytes >= this.thresholds.saturatedRssBytes || this.lastMemory.heapUsedBytes >= this.thresholds.saturatedHeapBytes || this.saturatedLagStreak >= sustained || this.activeRelays >= this.thresholds.saturatedRelays || this.activeResolutions >= this.thresholds.saturatedResolutions) return "saturated";
    if (this.lastMemory.rssBytes >= this.thresholds.careRssBytes || this.lastMemory.heapUsedBytes >= this.thresholds.careHeapBytes || this.careLagStreak >= sustained || this.activeRelays >= this.thresholds.careRelays || this.activeResolutions >= this.thresholds.careResolutions) return "care";
    return "normal";
  }
  currentSnapshot() {
    const mode = this.mode();
    return {
      mode,
      ...this.lastMemory,
      eventLoopLagMs: this.eventLoopLagMs,
      activeRelays: this.activeRelays,
      activeResolutions: this.activeResolutions,
      allowSpeculativeWork: mode === "normal",
      suggestedFallback: mode === "saturated" ? "embed" : null,
      sampledAt: this.sampledAt
    };
  }
};
var runtimeBudget = new RuntimeBudget();

// server/streamHealthService.ts
var DEFAULT_CACHE_TTL_MS = 6e4;
var DEFAULT_STALE_TTL_MS = 10 * 6e4;
function unknownResult(url) {
  return { url, ok: false, state: "unknown" };
}
var StreamHealthService = class {
  cache = /* @__PURE__ */ new Map();
  refreshes = /* @__PURE__ */ new Map();
  cacheTtlMs;
  staleTtlMs;
  now;
  probe;
  allowRefresh;
  constructor(options = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.staleTtlMs = Math.max(this.cacheTtlMs, options.staleTtlMs ?? DEFAULT_STALE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.probe = options.probe ?? probeStream;
    this.allowRefresh = options.allowRefresh ?? (() => true);
  }
  /** Gets a snapshot synchronously in practice (wrapped for route ergonomics). */
  async getSnapshot(urls, opts = {}) {
    const now = this.now();
    const refreshUrls = [];
    let stale = false;
    const results = urls.map((url) => {
      const entry = this.cache.get(url);
      if (!entry) {
        refreshUrls.push(url);
        return unknownResult(url);
      }
      const age = Math.max(0, now - entry.storedAt);
      if (age <= this.cacheTtlMs) return { ...entry.result, fromCache: true, cacheStale: false };
      if (age <= this.staleTtlMs) {
        stale = true;
        refreshUrls.push(url);
        return { ...entry.result, fromCache: true, cacheStale: true };
      }
      refreshUrls.push(url);
      return unknownResult(url);
    });
    if (refreshUrls.length > 0 && this.allowRefresh()) {
      void this.refresh(refreshUrls, opts).catch(() => void 0);
    }
    return { generatedAt: now, stale, results };
  }
  /** Performs and stores probes, deduplicating concurrent refreshes per URL. */
  async refresh(urls, opts = {}) {
    const uniqueUrls2 = [...new Set(urls)];
    const promises = uniqueUrls2.map((url) => this.refreshOne(url, opts));
    return Promise.all(promises);
  }
  refreshOne(url, opts) {
    const existing = this.refreshes.get(url);
    if (existing) return existing;
    const promise = this.probe(url, opts).catch((error) => ({
      url,
      ok: false,
      state: "degraded",
      reason: "network_error",
      error: error instanceof Error ? error.message : String(error)
    })).then((result) => {
      this.cache.set(url, { result, storedAt: this.now() });
      return result;
    }).finally(() => this.refreshes.delete(url));
    this.refreshes.set(url, promise);
    return promise;
  }
  clear(urls) {
    if (!urls) {
      this.cache.clear();
      return;
    }
    for (const url of urls) this.cache.delete(url);
  }
  getCached(url) {
    return this.cache.get(url)?.result;
  }
};
var streamHealthService = new StreamHealthService({
  allowRefresh: () => runtimeBudget.snapshot({ refreshMemory: false }).allowSpeculativeWork
});

// server.ts
init_hostHealth();

// server/urlSafety.ts
var import_node_dns = require("node:dns");
var import_node_net = require("node:net");
var UnsafeUrlError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "UnsafeUrlError";
    this.code = code;
  }
};
var defaultLookup = async (hostname, options) => import_node_dns.promises.lookup(hostname, options);
var ipv4Number = (address) => {
  if ((0, import_node_net.isIP)(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return (octets[0] << 24 >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3] >>> 0;
};
var inV4Range = (value, base, prefix) => {
  const mask = prefix === 0 ? 0 : 4294967295 << 32 - prefix >>> 0;
  return (value & mask) === (base & mask);
};
var NON_PUBLIC_V4 = [
  [0, 8],
  // unspecified/current network
  [167772160, 8],
  // RFC 1918
  [1681915904, 10],
  // carrier-grade NAT
  [2130706432, 8],
  // loopback
  [2851995648, 16],
  // link-local
  [2886729728, 12],
  // RFC 1918
  [3221225472, 24],
  // IETF protocol assignments
  [3221225984, 24],
  // documentation
  [3227017984, 24],
  // deprecated 6to4 relay anycast
  [3232235520, 16],
  // RFC 1918
  [3323068416, 15],
  // benchmark tests
  [3325256704, 24],
  // documentation
  [3405803776, 24],
  // documentation
  [3758096384, 4],
  // multicast
  [4026531840, 4]
  // reserved/broadcast
];
var isPublicIpv4 = (address) => {
  const value = ipv4Number(address);
  return value !== null && !NON_PUBLIC_V4.some(([base, prefix]) => inV4Range(value, base, prefix));
};
var parseIpv6 = (address) => {
  let input = address.toLowerCase().split("%")[0];
  if ((0, import_node_net.isIP)(input) !== 6) return null;
  const ipv4Match = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = ipv4Number(ipv4Match[1]);
    if (ipv4 === null) return null;
    input = input.slice(0, -ipv4Match[1].length) + `${(ipv4 >>> 16 & 65535).toString(16)}:${(ipv4 & 65535).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0 || missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => value << 16n | BigInt(parseInt(part, 16)), 0n);
};
var inV6Range = (value, base, prefix) => prefix === 0 || value >> BigInt(128 - prefix) === base >> BigInt(128 - prefix);
var isPublicIpv6 = (address) => {
  const value = parseIpv6(address);
  if (value === null) return false;
  if (inV6Range(value, 0xffffn << 32n, 96)) {
    const mapped = Number(value & 0xffffffffn);
    const dotted = `${mapped >>> 24}.${mapped >>> 16 & 255}.${mapped >>> 8 & 255}.${mapped & 255}`;
    return isPublicIpv4(dotted);
  }
  const blocked = [
    [0n, 128],
    // unspecified
    [1n, 128],
    // loopback
    [0n, 96],
    // IPv4-compatible/deprecated forms
    [0x64ff9b00000000000000000000n, 96],
    // NAT64 well-known prefix
    [0x10000000000000000000000000000000n, 64],
    // discard-only
    [0x20010db8000000000000000000000000n, 32],
    // documentation
    [0xfc000000000000000000000000000000n, 7],
    // unique-local
    [0xfe800000000000000000000000000000n, 10],
    // link-local
    [0xff000000000000000000000000000000n, 8]
    // multicast
  ];
  return !blocked.some(([base, prefix]) => inV6Range(value, base, prefix));
};
var assertPublicAddress = (address) => {
  const family = (0, import_node_net.isIP)(address);
  if (family === 0) throw new UnsafeUrlError("invalid_ip", `DNS returned an invalid IP address: ${address}`);
  const isPublic = family === 4 ? isPublicIpv4(address) : isPublicIpv6(address);
  if (!isPublic) throw new UnsafeUrlError("non_public_ip", "URL resolves to a non-public network address");
};
var isValidHostname = (hostname) => {
  if (!hostname || hostname.length > 253) return false;
  if ((0, import_node_net.isIP)(hostname) !== 0) return true;
  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return normalized.length > 0 && normalized.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
};
async function assertSafePublicHttpUrl(input, options = {}) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (cause) {
    throw new UnsafeUrlError("invalid_url", "Invalid URL", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("unsupported_protocol", "Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials_not_allowed", "URL credentials are not allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isValidHostname(hostname)) {
    throw new UnsafeUrlError("invalid_hostname", "URL hostname is invalid");
  }
  let addresses;
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new UnsafeUrlError("dns_failed", "Unable to resolve URL hostname", { cause });
  }
  if (addresses.length === 0) throw new UnsafeUrlError("no_dns_results", "URL hostname has no addresses");
  for (const result of addresses) assertPublicAddress(result.address);
  return url;
}

// server.ts
init_deliveryPlanner();
init_resolutionMetadata();
var import_impit_client = require("@crawlee/impit-client");
var import_promises4 = require("node:stream/promises");
var import_undici2 = require("undici");
init_hostProfiles();

// app.config.ts
var APP_CONFIG = {
  /** Host local donde escucha el backend y se sirve la SPA en desarrollo. */
  host: "127.0.0.1",
  /** Puerto del backend. Ningún otro valor de puerto existe en el código. */
  port: 3010
};
function localAllowedOrigins() {
  return [
    `http://localhost:${APP_CONFIG.port}`,
    `http://${APP_CONFIG.host}:${APP_CONFIG.port}`,
    "http://localhost:3010",
    "http://127.0.0.1:3010",
    "http://localhost:3011",
    "http://127.0.0.1:3011",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://classifieds-discounts-father-barrier.trycloudflare.com",
    "https://bookstore-britain-lows-locked.trycloudflare.com",
    "https://fabrics-merit-shut-tone.trycloudflare.com",
    "https://prehensile-hyperactively-zara.ngrok-free.dev",
    "http://prehensile-hyperactively-zara.ngrok-free.dev"
  ];
}

// server/reconcileCatalog.ts
init_titleNormalizer();
init_metadataEngine();
function detectSeason(title, kind) {
  const raw = parseRawTitle(title);
  if (raw.season && raw.season > 1) return raw.season;
  const parsed = parseTitleQuery(raw.canonical);
  if (parsed.season && parsed.season > 1) return parsed.season;
  if (kind !== "movie") {
    const bare = raw.canonical.match(/(?:^|\s)(\d{1,2})$/);
    const value = bare ? Number(bare[1]) : 0;
    if (value > 1 && value <= 20) return value;
  }
  return 0;
}
function tokensOf(title) {
  const norm = parseRawTitle(title).canonical.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/(.)\1+/g, "$1").replace(/[^a-z0-9 ]/g, " ");
  const raw = norm.split(/\s+/).filter((t) => t.length > 1);
  const out = /* @__PURE__ */ new Set();
  for (const t of raw) out.add(t.replace(/s$/, ""));
  return out;
}
function similarity(a, b) {
  const A = tokensOf(a);
  const B = tokensOf(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function shouldAutoMerge(titleA, titleB, kind, sequelTitle, aliasesA = [], aliasesB = []) {
  const pairs = [[titleA, titleB], ...aliasesA.flatMap((a) => aliasesB.map((b) => [a, b]))];
  const sim = Math.max(...pairs.map(([a, b]) => similarity(a, b)), 0);
  const hasMarker = detectSeason(sequelTitle, kind) > 1;
  const minSim = kind === "movie" ? 0.5 : hasMarker ? 0.3 : 0.5;
  if (sim < minSim) {
    return { ok: false, reason: `similitud baja (${sim.toFixed(2)} < ${minSim})`, similarity: sim };
  }
  return { ok: true, reason: `similitud ${sim.toFixed(2)}${hasMarker ? " + marcador de temporada" : ""}`, similarity: sim };
}
function sameTmdbNamespace(left, right) {
  const tvKinds = /* @__PURE__ */ new Set(["anime", "series"]);
  const leftTv = tvKinds.has(left || "anime");
  const rightTv = tvKinds.has(right || "anime");
  return leftTv === rightTv && (leftTv || left === right);
}
async function copySourceLink(link, targetMediaEpisodeId) {
  await prisma.sourceLink.create({
    data: {
      media_episode_id: targetMediaEpisodeId,
      source_site: link.source_site,
      url: link.url,
      link_type: link.link_type,
      language: link.language,
      audio_language: link.audio_language,
      subtitle_language: link.subtitle_language,
      subtitles: link.subtitles ?? void 0,
      host: link.host,
      priority_tier: link.priority_tier,
      is_verified: link.is_verified,
      last_checked: link.last_checked,
      source_status: link.source_status,
      canonical_locator: link.canonical_locator,
      external_id: link.external_id,
      extraction_method: link.extraction_method,
      resolver_version: link.resolver_version,
      failure_reason: link.failure_reason,
      last_success: link.last_success,
      last_failure: link.last_failure,
      retry_after: link.retry_after
    }
  }).catch((error) => {
    if (error?.code !== "P2002") throw error;
  });
}
async function reconcileSequelsByTmdb(opts = {}) {
  const dry = opts.dryRun !== false;
  const summary = {
    groups_checked: 0,
    merges_done: 0,
    episodes_moved: 0,
    shows_deleted: 0,
    dry_run: dry,
    details: [],
    skipped: []
  };
  const dupGroups = await prisma.show.groupBy({
    by: ["tmdb_id"],
    where: { tmdb_id: { not: null } },
    _count: { _all: true },
    having: { tmdb_id: { _count: { gt: 1 } } }
  });
  summary.groups_checked = dupGroups.length;
  for (const g of dupGroups) {
    const shows = await prisma.show.findMany({
      where: { tmdb_id: g.tmdb_id },
      orderBy: { created_at: "asc" }
    });
    if (shows.length < 2) continue;
    const canonical = shows[0];
    const kind = canonical.category || "anime";
    const cBase = canonical.base_normalized_title || canonical.normalized_title;
    let canonicalItem = await prisma.mediaItem.findFirst({
      where: { tmdb_id: g.tmdb_id, kind },
      orderBy: { created_at: "asc" }
    });
    if (!canonicalItem) {
      canonicalItem = await prisma.mediaItem.findFirst({
        where: { tmdb_id: g.tmdb_id },
        orderBy: { created_at: "asc" }
      });
    }
    if (!canonicalItem) {
      canonicalItem = await prisma.mediaItem.findFirst({
        where: { OR: [{ base_normalized_title: cBase, kind }, { normalized_title: canonical.normalized_title, kind }] },
        orderBy: { created_at: "asc" }
      });
    }
    for (const sequel of shows.slice(1)) {
      if (!sameTmdbNamespace(sequel.category || "anime", canonical.category || "anime")) {
        summary.skipped.push({
          canonical: canonical.title,
          merged: sequel.title,
          reason: `namespace distinto (${sequel.category || "anime"} \u2260 ${canonical.category || "anime"})`
        });
        continue;
      }
      const sBase = sequel.base_normalized_title || sequel.normalized_title;
      const sameBase = sBase === cBase;
      const guard = shouldAutoMerge(
        canonical.title,
        sequel.title,
        kind,
        sequel.title,
        [canonical.original_title, canonical.english_title, canonical.japanese_title].filter(Boolean),
        [sequel.original_title, sequel.english_title, sequel.japanese_title].filter(Boolean)
      );
      if (!guard.ok) {
        summary.skipped.push({ canonical: canonical.title, merged: sequel.title, reason: guard.reason });
        console.log(`[Reconcile]${dry ? " (dry)" : ""} SKIP "${sequel.title}" \u2260 "${canonical.title}" (${guard.reason}).`);
        continue;
      }
      const detected = detectSeason(sequel.title, kind);
      let maxSeason = 0;
      if (canonicalItem) {
        const agg = await prisma.mediaEpisode.aggregate({
          where: { media_item_id: canonicalItem.id },
          _max: { season_number: true }
        });
        maxSeason = agg._max?.season_number ?? 0;
      }
      const sameIdentity = sameBase || guard.similarity >= 0.5;
      const season = kind === "movie" ? 1 : detected > 1 ? detected : sameIdentity ? 1 : Math.max(1, maxSeason + 1);
      const lastEp = await prisma.episode.findFirst({
        where: { show_id: canonical.id },
        orderBy: { episode_number: "desc" },
        take: 1
      });
      let nextNumber = (lastEp?.episode_number ?? 0) + 1;
      const sequelEps = await prisma.episode.findMany({
        where: { show_id: sequel.id },
        orderBy: { episode_number: "asc" }
      });
      let moved = 0;
      for (const ep of sequelEps) {
        if (!dry) {
          const dupe = ep.source_url ? await prisma.episode.findFirst({ where: { show_id: canonical.id, source_url: ep.source_url } }) : null;
          if (!dupe) {
            await prisma.episode.create({
              data: { show_id: canonical.id, episode_number: nextNumber, title: ep.title, source_url: ep.source_url }
            });
          }
          nextNumber++;
        } else {
          nextNumber++;
        }
        moved++;
      }
      if (!dry && !canonicalItem) {
        canonicalItem = await prisma.mediaItem.create({
          data: {
            normalized_title: canonical.normalized_title,
            base_normalized_title: canonical.base_normalized_title || canonical.normalized_title,
            title: canonical.title,
            tmdb_id: canonical.tmdb_id,
            kind,
            year: canonical.year,
            poster_url: canonical.poster_url
          }
        });
      }
      if (!dry && canonicalItem) {
        const sequelItem = await prisma.mediaItem.findFirst({
          where: {
            id: { not: canonicalItem.id },
            OR: [
              ...sequel.tmdb_id ? [{ tmdb_id: sequel.tmdb_id }] : [],
              { base_normalized_title: sBase, kind },
              { normalized_title: sequel.normalized_title, kind }
            ]
          }
        });
        if (sequelItem) {
          const seqMediaEps = await prisma.mediaEpisode.findMany({
            where: { media_item_id: sequelItem.id },
            include: { links: true }
          });
          for (const me of seqMediaEps) {
            const target = await prisma.mediaEpisode.upsert({
              where: {
                media_item_id_season_number_episode_number: {
                  media_item_id: canonicalItem.id,
                  season_number: season,
                  episode_number: me.episode_number
                }
              },
              create: { media_item_id: canonicalItem.id, season_number: season, episode_number: me.episode_number },
              update: {}
            });
            for (const link of me.links) await copySourceLink(link, target.id);
          }
        }
      }
      if (!dry) {
        const sequelItem = await prisma.mediaItem.findFirst({
          where: {
            ...canonicalItem ? { id: { not: canonicalItem.id } } : {},
            OR: [
              ...sequel.tmdb_id ? [{ tmdb_id: sequel.tmdb_id }] : [],
              { base_normalized_title: sBase, kind },
              { normalized_title: sequel.normalized_title, kind }
            ]
          }
        });
        if (sequelItem && !canonicalItem) {
          summary.skipped.push({ canonical: canonical.title, merged: sequel.title, reason: "sin MediaItem can\xF3nico seguro" });
          continue;
        }
        if (sequelItem) await prisma.mediaItem.delete({ where: { id: sequelItem.id } });
        await prisma.show.delete({ where: { id: sequel.id } });
        summary.shows_deleted++;
      }
      summary.merges_done++;
      summary.episodes_moved += moved;
      summary.details.push({
        canonical: canonical.title,
        merged: sequel.title,
        season,
        episodes_moved: moved
      });
      console.log(
        `[Reconcile]${dry ? " (dry)" : ""} "${sequel.title}" \u2192 "${canonical.title}" como T${season} (${moved} eps).`
      );
    }
  }
  return summary;
}
async function mergeTwoShows(keepId, mergeId, opts = {}) {
  const dry = opts.dryRun !== false;
  if (keepId === mergeId) return { ok: false, detail: "No puedes fusionar una obra consigo misma." };
  const keep = await prisma.show.findUnique({ where: { id: keepId } });
  const merge = await prisma.show.findUnique({ where: { id: mergeId } });
  if (!keep || !merge) return { ok: false, detail: "Alguna de las dos obras no existe." };
  const kind = keep.category || "anime";
  const cBase = keep.base_normalized_title || keep.normalized_title;
  const detected = detectSeason(merge.title, kind);
  let canonicalItem = await prisma.mediaItem.findFirst({
    where: { OR: [{ base_normalized_title: cBase, kind }, { normalized_title: keep.normalized_title, kind }] },
    orderBy: { created_at: "asc" }
  });
  let maxSeason = 0;
  if (canonicalItem) {
    const agg = await prisma.mediaEpisode.aggregate({
      where: { media_item_id: canonicalItem.id },
      _max: { season_number: true }
    });
    maxSeason = agg._max?.season_number ?? 0;
  }
  const season = kind === "movie" ? 1 : detected > 1 ? detected : Math.max(1, maxSeason + 1);
  const lastEp = await prisma.episode.findFirst({
    where: { show_id: keep.id },
    orderBy: { episode_number: "desc" },
    take: 1
  });
  let nextNumber = (lastEp?.episode_number ?? 0) + 1;
  const mergeEps = await prisma.episode.findMany({ where: { show_id: merge.id }, orderBy: { episode_number: "asc" } });
  let moved = 0;
  for (const ep of mergeEps) {
    if (!dry) {
      const dupe = ep.source_url ? await prisma.episode.findFirst({ where: { show_id: keep.id, source_url: ep.source_url } }) : null;
      if (!dupe) {
        await prisma.episode.create({
          data: { show_id: keep.id, episode_number: nextNumber, title: ep.title, source_url: ep.source_url }
        });
      }
      nextNumber++;
    } else {
      nextNumber++;
    }
    moved++;
  }
  if (!dry) {
    const mBase = merge.base_normalized_title || merge.normalized_title;
    const mergeItem = await prisma.mediaItem.findFirst({
      where: { OR: [{ base_normalized_title: mBase, kind }, { normalized_title: merge.normalized_title, kind }] }
    });
    if (canonicalItem && mergeItem) {
      const seqMediaEps = await prisma.mediaEpisode.findMany({
        where: { media_item_id: mergeItem.id },
        include: { links: true }
      });
      for (const me of seqMediaEps) {
        const target = await prisma.mediaEpisode.upsert({
          where: {
            media_item_id_season_number_episode_number: {
              media_item_id: canonicalItem.id,
              season_number: season,
              episode_number: me.episode_number
            }
          },
          create: { media_item_id: canonicalItem.id, season_number: season, episode_number: me.episode_number },
          update: {}
        });
        for (const link of me.links) await copySourceLink(link, target.id);
      }
      await prisma.mediaItem.delete({ where: { id: mergeItem.id } });
    }
    await prisma.show.delete({ where: { id: merge.id } });
    console.log(`[Reconcile] FUSI\xD3N MANUAL: "${merge.title}" \u2192 "${keep.title}" como T${season} (${moved} eps).`);
  }
  return { ok: true, detail: dry ? `DRY: '${merge.title}' \u2192 '${keep.title}' como T${season} (${moved} eps).` : `Fusionado: '${merge.title}' \u2192 '${keep.title}' como T${season} (${moved} eps).`, season, episodes_moved: moved };
}

// server/verificationWorker.ts
var import_fs5 = __toESM(require("fs"), 1);
var import_path5 = __toESM(require("path"), 1);
init_universalScraper();
init_metadataEngine();
init_titleNormalizer();

// server/utils/pageUrlBuilder.ts
var cheerio14 = __toESM(require("cheerio"), 1);
function buildPageUrl(baseUrl, pageNumber) {
  if (pageNumber <= 1) return baseUrl;
  try {
    const url = new URL(baseUrl);
    const queryKeys = ["page", "p", "pag", "pagina", "paged", "pg", "pgnum", "start", "offset"];
    for (const key of queryKeys) {
      if (url.searchParams.has(key)) {
        if (key === "offset" || key === "start") {
          const limit = Number(url.searchParams.get("limit") || url.searchParams.get("postsPerPage") || 24);
          url.searchParams.set(key, String((pageNumber - 1) * limit));
        } else {
          url.searchParams.set(key, String(pageNumber));
        }
        return url.toString();
      }
    }
    if (/\/page\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/page\/\d+/i, `/page/${pageNumber}`);
      return url.toString();
    }
    if (/\/pagina\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/pagina\/\d+/i, `/pagina/${pageNumber}`);
      return url.toString();
    }
    if (/\/p\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/p\/\d+/i, `/p/${pageNumber}`);
      return url.toString();
    }
    const host = url.hostname.toLowerCase();
    const path7 = url.pathname.replace(/\/+$/, "");
    const origin = url.origin;
    if (/(^|\.)animeflv\.(or\.(?:at|am)|la|cc|pe|iu|se)$/.test(host)) {
      return `${origin}${path7}/page/${pageNumber}/`;
    }
    if (/(^|\.)tioplus\.app$/.test(host)) {
      return `${origin}${path7}/${pageNumber}`;
    }
    if (/(^|\.)latanime\.org$/.test(host)) {
      return `${origin}${path7 || "/animes"}?p=${pageNumber}`;
    }
    if (/(^|\.)tioanime\.com$/.test(host)) {
      return `${origin}${path7 || "/directorio"}?p=${pageNumber}`;
    }
    if (/(^|\.)veranimes\.(net|com)$/.test(host)) {
      return `${origin}${path7 || "/animes"}?pag=${pageNumber}`;
    }
    if (/(^|\.)cinecalidad\.[a-z.]+$/.test(host)) {
      return `${origin}${path7}/page/${pageNumber}/`;
    }
    if (/(^|\.)doramasflix\.[a-z.]+$/.test(host)) {
      return `${origin}${path7}/page/${pageNumber}`;
    }
    if (/(^|\.)tubepelis\.[a-z.]+$/.test(host)) {
      if (path7.includes("peliculas")) {
        return `${origin}/peliculas_${pageNumber}.html`;
      }
      return `${origin}${path7}/page/${pageNumber}`;
    }
    if (/(^|\.)lamovie\.org$/.test(host) && url.pathname.includes("/wp-api/")) {
      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    }
    if (/(^|\.)animeflv\.net$/.test(host)) {
      return `${origin}${path7 || "/browse"}?page=${pageNumber}`;
    }
    if (url.search) {
      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    }
    if (/(?:\/browse|\/directorio|\/catalogo|\/catalogue|\/peliculas|\/movies|\/series|\/animes|\/doramas)$/i.test(path7)) {
      return `${origin}${path7}?page=${pageNumber}`;
    }
    url.searchParams.set("page", String(pageNumber));
    return url.toString();
  } catch {
    if (baseUrl.includes("?")) {
      return `${baseUrl}&page=${pageNumber}`;
    }
    return `${baseUrl}?page=${pageNumber}`;
  }
}

// server/verificationWorker.ts
var DEFAULT_CATALOG_URLS = {
  animeflv: "https://www3.animeflv.net/browse",
  tioanime: "https://tioanime.com/directorio",
  latanime: "https://latanime.org/animes",
  cinecalidad: "https://www.cinecalidad.am/",
  tioplus: "https://tioplus.app/peliculas",
  doramasflix: "https://doramasflix.io/doramas",
  doramasflix_peliculas: "https://doramasflix.io/peliculas",
  doramasflix_variedades: "https://doramasflix.io/variedades",
  lamovie_movies: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24",
  lamovie_series: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24",
  lamovie_animes: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24"
};
var CONFIG_DIR = import_path5.default.join(process.cwd(), "data");
var CONFIG_PATH = import_path5.default.join(CONFIG_DIR, "verification.config.json");
var MIN_INTERVAL_MINUTES = 5;
var MAX_INTERVAL_MINUTES = 525600;
var SCOPE_MODES = ["all", "platforms", "category"];
var SUPPORTED_CATEGORIES = ["anime", "movie", "movies", "series"];
var CATEGORY_PLATFORM_MAP = {
  anime: ["animeflv", "tioanime", "latanime", "lamovie_animes"],
  movie: ["cinecalidad", "tioplus", "lamovie_movies", "doramasflix_peliculas"],
  movies: ["cinecalidad", "tioplus", "lamovie_movies", "doramasflix_peliculas"],
  series: ["lamovie_series", "doramasflix", "doramasflix_variedades"]
};
function defaultConfig() {
  return {
    enabled: true,
    interval_minutes: 1440,
    scope_mode: "all",
    platforms: [],
    category: void 0,
    catalog_urls_by_platform: { ...DEFAULT_CATALOG_URLS },
    metadata_only: false,
    sync_known_episodes: true,
    catalog_pages_per_platform: 0
    // 0 = sin límite / hasta agotar
  };
}
function loadConfigFromDisk() {
  const base = defaultConfig();
  try {
    if (!import_fs5.default.existsSync(CONFIG_PATH)) return base;
    const raw = JSON.parse(import_fs5.default.readFileSync(CONFIG_PATH, "utf-8"));
    if (typeof raw?.enabled === "boolean") base.enabled = raw.enabled;
    if (Number.isFinite(raw?.interval_minutes)) {
      base.interval_minutes = clampInterval(raw.interval_minutes);
    }
    if (SCOPE_MODES.includes(raw?.scope_mode)) base.scope_mode = raw.scope_mode;
    if (Array.isArray(raw?.platforms)) {
      base.platforms = raw.platforms.map(cleanPlatform2).filter(Boolean);
    }
    if (typeof raw?.category === "string" && raw.category.trim()) base.category = raw.category.trim().toLowerCase();
    if (raw?.catalog_urls_by_platform && typeof raw.catalog_urls_by_platform === "object") {
      for (const [k, v] of Object.entries(raw.catalog_urls_by_platform)) {
        if (typeof v === "string") base.catalog_urls_by_platform[cleanPlatform2(k)] = v.trim();
      }
    }
    if (typeof raw?.metadata_only === "boolean") base.metadata_only = raw.metadata_only;
    if (typeof raw?.sync_known_episodes === "boolean") base.sync_known_episodes = raw.sync_known_episodes;
    if (raw?.catalog_pages_per_platform !== void 0 && Number.isFinite(Number(raw.catalog_pages_per_platform))) {
      base.catalog_pages_per_platform = Math.max(0, Math.round(Number(raw.catalog_pages_per_platform)));
    }
  } catch (e) {
    console.error("[verificationWorker] config corrupta, usando defaults:", e);
  }
  return base;
}
function persistConfig(config) {
  if (!import_fs5.default.existsSync(CONFIG_DIR)) import_fs5.default.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  import_fs5.default.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  import_fs5.default.renameSync(tmp, CONFIG_PATH);
}
function clampInterval(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return defaultConfig().interval_minutes;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, n));
}
function cleanPlatform2(p) {
  return String(p ?? "").trim().toLowerCase();
}
function isValidUrlOrEmpty(u) {
  if (!u) return true;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
var state2 = {
  config: loadConfigFromDisk(),
  timer: null,
  running: false,
  paused: false,
  stopped: false,
  isMetadataOnlyRun: false,
  phase: "idle",
  currentItem: null,
  startedAt: null,
  lastRunAt: null,
  nextRunAt: null,
  progress: {
    total: 0,
    done: 0,
    percent: 0,
    new_works: 0,
    new_sources: 0,
    known: 0,
    known_without_episodes: 0,
    new_episodes: 0,
    updated_metadata: 0,
    errors: 0,
    works_merged: 0,
    sources_added: 0
  },
  lastReport: null,
  recent: []
};
var runCounters = {
  metaTotal: 0,
  metaDone: 0,
  metaUpdated: 0,
  metaErrors: 0,
  catalogTotal: 0,
  catalogDone: 0,
  finalMetaTotal: 0,
  finalMetaDone: 0
};
function resetRunCounters() {
  runCounters.metaTotal = 0;
  runCounters.metaDone = 0;
  runCounters.metaUpdated = 0;
  runCounters.metaErrors = 0;
  runCounters.catalogTotal = 0;
  runCounters.catalogDone = 0;
  runCounters.finalMetaTotal = 0;
  runCounters.finalMetaDone = 0;
}
function log(level, message) {
  state2.recent.unshift({ at: (/* @__PURE__ */ new Date()).toISOString(), level, message });
  state2.recent = state2.recent.slice(0, 30);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function clearTimer() {
  if (state2.timer) clearInterval(state2.timer);
  state2.timer = null;
}
function scheduleTimer() {
  clearTimer();
  if (!state2.config.enabled) {
    state2.nextRunAt = null;
    return;
  }
  const ms = clampInterval(state2.config.interval_minutes) * 6e4;
  const next = /* @__PURE__ */ new Date();
  next.setMinutes(next.getMinutes() + state2.config.interval_minutes);
  state2.nextRunAt = next.toISOString();
  state2.timer = setInterval(() => {
    const nextTick = /* @__PURE__ */ new Date();
    nextTick.setMinutes(nextTick.getMinutes() + state2.config.interval_minutes);
    state2.nextRunAt = nextTick.toISOString();
    if (state2.running) return;
    runVerification({ trigger: "timer" });
  }, ms);
  state2.timer?.unref?.();
}
function getVerificationConfig() {
  return JSON.parse(JSON.stringify(state2.config));
}
async function updateVerificationConfig(patch) {
  const next = getVerificationConfig();
  if (patch.enabled !== void 0) {
    if (typeof patch.enabled !== "boolean") throw new Error("'enabled' debe ser boolean");
    next.enabled = patch.enabled;
  }
  if (patch.interval_minutes !== void 0) {
    if (!Number.isFinite(Number(patch.interval_minutes))) throw new Error("'interval_minutes' debe ser num\xE9rico");
    next.interval_minutes = clampInterval(patch.interval_minutes);
  }
  if (patch.scope_mode !== void 0) {
    if (!SCOPE_MODES.includes(patch.scope_mode)) {
      throw new Error(`'scope_mode' inv\xE1lido (${String(patch.scope_mode)}); use: ${SCOPE_MODES.join(" | ")}`);
    }
    next.scope_mode = patch.scope_mode;
  }
  if (patch.catalog_urls_by_platform !== void 0) {
    if (!patch.catalog_urls_by_platform || typeof patch.catalog_urls_by_platform !== "object" || Array.isArray(patch.catalog_urls_by_platform)) {
      throw new Error("'catalog_urls_by_platform' debe ser un objeto { plataforma: url }");
    }
    for (const [k, v] of Object.entries(patch.catalog_urls_by_platform)) {
      const key = cleanPlatform2(k);
      const url = String(v ?? "").trim();
      if (!key) continue;
      if (!isValidUrlOrEmpty(url)) throw new Error(`URL inv\xE1lida para '${key}': ${url}`);
      next.catalog_urls_by_platform[key] = url;
    }
  }
  if (patch.platforms !== void 0) {
    if (!Array.isArray(patch.platforms)) throw new Error("'platforms' debe ser un array de strings");
    const cleaned = [...new Set(patch.platforms.map(cleanPlatform2).filter(Boolean))];
    for (const p of cleaned) {
      const url = next.catalog_urls_by_platform[p];
      if (!url || typeof url !== "string" || !url.trim() || !isValidUrlOrEmpty(url)) {
        throw new Error(`Plataforma '${p}' no tiene una URL de cat\xE1logo v\xE1lida configurada`);
      }
    }
    next.platforms = cleaned;
  }
  if (patch.category !== void 0) {
    if (patch.category === null || patch.category === "") {
      next.category = void 0;
    } else if (typeof patch.category === "string") {
      const c = patch.category.trim().toLowerCase();
      if (!SUPPORTED_CATEGORIES.includes(c)) {
        throw new Error(`Categor\xEDa inv\xE1lida '${patch.category}'. Categor\xEDas soportadas: ${SUPPORTED_CATEGORIES.join(", ")}`);
      }
      next.category = c;
    } else {
      throw new Error("'category' debe ser string o null");
    }
  }
  if (patch.metadata_only !== void 0) {
    if (typeof patch.metadata_only !== "boolean") throw new Error("'metadata_only' debe ser boolean");
    next.metadata_only = patch.metadata_only;
  }
  if (patch.sync_known_episodes !== void 0) {
    if (typeof patch.sync_known_episodes !== "boolean") throw new Error("'sync_known_episodes' debe ser boolean");
    next.sync_known_episodes = patch.sync_known_episodes;
  }
  if (patch.catalog_pages_per_platform !== void 0) {
    if (Number.isFinite(Number(patch.catalog_pages_per_platform))) {
      next.catalog_pages_per_platform = Math.max(0, Math.round(Number(patch.catalog_pages_per_platform)));
    }
  }
  if (next.scope_mode === "platforms" && next.platforms.length === 0) {
    throw new Error("'platforms' requiere al menos una plataforma cuando scope_mode es 'platforms'");
  }
  if (next.scope_mode === "category" && !next.category) {
    throw new Error("'category' es requerida cuando scope_mode es 'category'");
  }
  state2.config = next;
  persistConfig(next);
  scheduleTimer();
  log("info", `Config actualizada (enabled=${next.enabled}, intervalo=${next.interval_minutes}min, scope=${next.scope_mode}, paginaci\xF3n=${next.catalog_pages_per_platform === 0 ? "sin l\xEDmite" : next.catalog_pages_per_platform}).`);
  return getVerificationConfig();
}
function runVerification(options) {
  if (state2.running) {
    return { started: false, reason: "already_running", status: getVerificationStatus() };
  }
  state2.running = true;
  state2.paused = false;
  state2.stopped = false;
  state2.phase = "metadata";
  state2.currentItem = null;
  state2.startedAt = (/* @__PURE__ */ new Date()).toISOString();
  state2.isMetadataOnlyRun = options?.mode === "metadata" ? true : options?.mode === "full" ? false : state2.config.metadata_only;
  state2.progress = {
    total: 0,
    done: 0,
    percent: 0,
    new_works: 0,
    new_sources: 0,
    known: 0,
    known_without_episodes: 0,
    new_episodes: 0,
    updated_metadata: 0,
    errors: 0,
    works_merged: 0,
    sources_added: 0
  };
  resetRunCounters();
  log("info", `Pasada ${options?.trigger || "manual"} iniciada (Pipeline de 3 fases: Metadatos -> Cat\xE1logo -> Normalizaci\xF3n final).`);
  void runPass(options || {}).finally(() => {
    state2.running = false;
    state2.paused = false;
    state2.stopped = false;
    state2.phase = "idle";
    state2.currentItem = null;
    state2.lastRunAt = (/* @__PURE__ */ new Date()).toISOString();
    if (state2.config.enabled && !state2.nextRunAt) scheduleTimer();
  });
  return { started: true, status: getVerificationStatus() };
}
function pauseVerification() {
  if (!state2.running) {
    return { ok: false, message: "No hay ninguna verificaci\xF3n en ejecuci\xF3n.", status: getVerificationStatus() };
  }
  if (state2.paused) {
    return { ok: true, message: "La verificaci\xF3n ya se encuentra pausada.", status: getVerificationStatus() };
  }
  state2.paused = true;
  log("warn", "Verificaci\xF3n pausada por el usuario.");
  return { ok: true, message: "Verificaci\xF3n pausada.", status: getVerificationStatus() };
}
function resumeVerification() {
  if (!state2.running) {
    return { ok: false, message: "No hay ninguna verificaci\xF3n para reanudar.", status: getVerificationStatus() };
  }
  if (!state2.paused) {
    return { ok: true, message: "La verificaci\xF3n ya est\xE1 en ejecuci\xF3n activa.", status: getVerificationStatus() };
  }
  state2.paused = false;
  log("info", "Verificaci\xF3n reanudada por el usuario.");
  return { ok: true, message: "Verificaci\xF3n reanudada.", status: getVerificationStatus() };
}
function stopVerification() {
  if (!state2.running) {
    return { ok: false, message: "No hay ninguna verificaci\xF3n en ejecuci\xF3n.", status: getVerificationStatus() };
  }
  state2.stopped = true;
  state2.paused = false;
  log("warn", "Deteniendo la verificaci\xF3n...");
  return { ok: true, message: "Deteniendo verificaci\xF3n...", status: getVerificationStatus() };
}
function getVerificationStatus() {
  const c = state2.config;
  const p = state2.progress;
  let computedPercent = 0;
  if (state2.running) {
    if (state2.isMetadataOnlyRun) {
      computedPercent = runCounters.metaTotal > 0 ? Math.min(100, Math.round(runCounters.metaDone / runCounters.metaTotal * 100)) : 0;
    } else {
      const metaFraction = runCounters.metaTotal > 0 ? Math.min(1, runCounters.metaDone / runCounters.metaTotal) : 0;
      const catalogFraction = state2.progress.total > 0 ? Math.min(1, state2.progress.done / state2.progress.total) : 0;
      const finalMetaFraction = runCounters.finalMetaTotal > 0 ? Math.min(1, runCounters.finalMetaDone / runCounters.finalMetaTotal) : 0;
      if (state2.phase === "metadata") {
        computedPercent = Math.min(25, Math.round(metaFraction * 25));
      } else if (state2.phase === "catalog") {
        computedPercent = Math.min(85, Math.round(25 + catalogFraction * 60));
      } else if (state2.phase === "finalizing") {
        computedPercent = Math.min(99, Math.round(85 + finalMetaFraction * 14));
      }
    }
  } else if (state2.lastReport) {
    computedPercent = 100;
  }
  const phaseName = state2.paused ? "paused" : state2.phase;
  return {
    enabled: c.enabled,
    interval_minutes: c.interval_minutes,
    scope_mode: c.scope_mode,
    platforms: [...c.platforms],
    category: c.category ?? null,
    metadata_only: c.metadata_only,
    sync_known_episodes: c.sync_known_episodes !== false,
    running: state2.running,
    paused: state2.paused,
    phase: phaseName,
    current_item: state2.currentItem,
    progress: {
      ...p,
      percent: computedPercent,
      metadata_updated: p.updated_metadata,
      works_created: p.new_works,
      episodes_added: p.new_episodes,
      works_merged: p.works_merged || 0,
      sources_added: p.sources_added || 0
    },
    last_run_at: state2.lastRunAt,
    next_run_at: state2.nextRunAt,
    last_report: state2.lastReport,
    recent: [...state2.recent],
    config: getVerificationConfig()
  };
}
function resolveCatalogPlatforms(cfg, overridePlatforms) {
  if (overridePlatforms && overridePlatforms.length > 0) {
    return overridePlatforms.map(cleanPlatform2).filter((p) => Boolean(p && cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p])));
  }
  if (cfg.scope_mode === "platforms") {
    return cfg.platforms.map(cleanPlatform2).filter((p) => Boolean(p && cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p])));
  }
  if (cfg.scope_mode === "category") {
    const cat = String(cfg.category || "").toLowerCase().trim();
    const mapped = CATEGORY_PLATFORM_MAP[cat];
    if (!mapped || mapped.length === 0) return [];
    return mapped.filter((p) => Boolean(cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p])));
  }
  if (cfg.scope_mode === "all") {
    return Object.keys(cfg.catalog_urls_by_platform).filter(
      (p) => Boolean(cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p]))
    );
  }
  return [];
}
async function resolveMetadataShowIds(cfg, overridePlatforms) {
  if (overridePlatforms && overridePlatforms.length > 0) {
    return showsLinkedToPlatforms(overridePlatforms.filter((p) => Boolean(cfg.catalog_urls_by_platform[cleanPlatform2(p)])));
  }
  if (cfg.scope_mode === "category") {
    const cat = String(cfg.category || "").toLowerCase().trim();
    if (!SUPPORTED_CATEGORIES.includes(cat)) return [];
    const rows = await prisma.show.findMany({
      where: { category: { contains: cat } },
      select: { id: true },
      orderBy: { created_at: "asc" }
    });
    return rows.map((r) => r.id);
  }
  if (cfg.scope_mode === "platforms") {
    return showsLinkedToPlatforms(cfg.platforms.filter((p) => Boolean(cfg.catalog_urls_by_platform[cleanPlatform2(p)])));
  }
  if (cfg.scope_mode === "all") {
    const rows = await prisma.show.findMany({ select: { id: true }, orderBy: { created_at: "asc" } });
    return rows.map((r) => r.id);
  }
  return [];
}
async function showsLinkedToPlatforms(platforms) {
  const clean = platforms.map(cleanPlatform2).filter(Boolean);
  if (clean.length === 0) return [];
  const links = await prisma.sourceLink.findMany({
    where: { OR: clean.map((p) => ({ source_site: { contains: p } })) },
    select: {
      media_episode: {
        select: { media_item: { select: { normalized_title: true, base_normalized_title: true } } }
      }
    }
  });
  const keys = /* @__PURE__ */ new Set();
  for (const link of links) {
    const mi = link.media_episode?.media_item;
    if (!mi) continue;
    if (mi.normalized_title) keys.add(mi.normalized_title);
    if (mi.base_normalized_title) keys.add(mi.base_normalized_title);
  }
  if (keys.size === 0) return [];
  const ids = /* @__PURE__ */ new Set();
  const keyList = [...keys];
  const CHUNK = 400;
  for (let i = 0; i < keyList.length; i += CHUNK) {
    const group = keyList.slice(i, i + CHUNK);
    const rows = await prisma.show.findMany({
      where: { OR: [{ normalized_title: { in: group } }, { base_normalized_title: { in: group } }] },
      select: { id: true }
    });
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}
async function metadataPhase(cfg, opts, stage = "initial") {
  state2.phase = stage === "initial" ? "metadata" : "finalizing";
  const showIds = await resolveMetadataShowIds(cfg, opts.platforms);
  const limited = opts.limit && opts.limit > 0 ? showIds.slice(0, opts.limit) : showIds;
  if (stage === "initial") {
    runCounters.metaTotal = limited.length;
    state2.progress.total = limited.length;
    log("info", `Fase 1/3 (Metadatos existentes): ${limited.length} obra(s) en cola (scope=${cfg.scope_mode}).`);
  } else {
    runCounters.finalMetaTotal = limited.length;
    log("info", `Fase 3/3 (Normalizaci\xF3n y pulido final): verificando ${limited.length} obra(s)...`);
  }
  const CONCURRENCY = 15;
  let cursor = 0;
  const worker = async () => {
    for (; ; ) {
      if (state2.stopped) return;
      while (state2.paused && !state2.stopped) {
        await sleep(400);
      }
      if (state2.stopped) return;
      const idx = cursor++;
      if (idx >= limited.length) return;
      const showId = limited[idx];
      try {
        const row = await prisma.show.findUnique({
          where: { id: showId },
          select: { id: true, title: true, description: true, poster_url: true, banner_url: true, genres: true, year: true, tmdb_id: true }
        });
        state2.currentItem = row?.title || showId;
        if (row && showNeedsBackfill(row)) {
          const result = await backfillShow(showId);
          if (result.changed.length > 0) {
            runCounters.metaUpdated++;
            state2.progress.updated_metadata = runCounters.metaUpdated;
            log("info", `Metadatos completados en '${result.title}': ${result.changed.join(", ")}`);
          }
          await sleep(20 + Math.random() * 20);
        }
      } catch (e) {
        if (stage === "initial") {
          runCounters.metaErrors++;
        }
        state2.progress.errors++;
        log("warn", `Error en backfill de obra ${showId}: ${e?.message || e}`);
      }
      if (stage === "initial") {
        runCounters.metaDone++;
        state2.progress.done = runCounters.metaDone;
      } else {
        runCounters.finalMetaDone++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, limited.length || 1) }, () => worker()));
}
function inferKindForPlatform(platformKey, itemKind) {
  if (itemKind) return itemKind;
  const k = platformKey.toLowerCase();
  if (k.includes("anime")) return "anime";
  if (k.includes("serie") || k.includes("tvshow")) return "series";
  return "movie";
}
async function findKnownWork(titleKey2, year, kind, tmdbId) {
  if (tmdbId && tmdbId > 0) {
    const byTmdb = await prisma.show.findFirst({
      where: { tmdb_id: tmdbId, ...kind ? { category: kind } : {} },
      orderBy: { created_at: "asc" },
      select: { id: true, title: true, category: true, _count: { select: { episodes: true } } }
    });
    if (byTmdb) return { id: byTmdb.id, title: byTmdb.title, category: byTmdb.category, episodeCount: byTmdb._count.episodes };
  }
  if (!titleKey2) return null;
  const showCandidates = await prisma.show.findMany({
    where: {
      OR: [{ base_normalized_title: titleKey2 }, { normalized_title: titleKey2 }],
      ...kind ? { category: kind } : {}
    },
    orderBy: { created_at: "asc" },
    select: { id: true, title: true, category: true, year: true, _count: { select: { episodes: true } } },
    take: 20
  });
  const requestedYear = isPlausibleYear(year) ? year : null;
  const show = requestedYear ? showCandidates.find((candidate) => candidate.year === requestedYear) ?? showCandidates.find((candidate) => !isPlausibleYear(candidate.year)) ?? null : showCandidates[0] ?? null;
  if (show) {
    return { id: show.id, title: show.title, category: show.category, episodeCount: show._count.episodes };
  }
  return null;
}
function buildEpisodesFromAnalysis(analysis, platform, kind) {
  if (!analysis) return [];
  const sourceSite = analysis.source_domain || platform;
  const detectedStreams = Array.isArray(analysis.detected_streams) ? analysis.detected_streams.filter((s) => typeof s === "string" && s.trim()) : [];
  const rawEpisodes = Array.isArray(analysis.episodes) ? analysis.episodes : [];
  const isMovie = kind === "movie" || analysis.content_type === "movie";
  if (isMovie) {
    const firstEp = rawEpisodes[0] || null;
    const primaryUrl = firstEp?.url || detectedStreams[0] || "";
    const streamSources = [];
    const seen = /* @__PURE__ */ new Set();
    if (primaryUrl) {
      streamSources.push({ url: primaryUrl, source_site: sourceSite });
      seen.add(primaryUrl);
    }
    for (const st of detectedStreams) {
      if (st && !seen.has(st)) {
        streamSources.push({ url: st, source_site: sourceSite });
        seen.add(st);
      }
    }
    if (firstEp && Array.isArray(firstEp.sources)) {
      for (const s of firstEp.sources) {
        const u = typeof s === "string" ? s : s?.url;
        if (u && !seen.has(u)) {
          streamSources.push({
            url: u,
            source_site: typeof s === "object" && s.source_site ? s.source_site : sourceSite,
            link_type: typeof s === "object" ? s.link_type : void 0,
            host: typeof s === "object" ? s.host : void 0,
            language: typeof s === "object" ? s.language : void 0,
            audio_language: typeof s === "object" ? s.audio_language : void 0,
            subtitle_language: typeof s === "object" ? s.subtitle_language : void 0,
            subtitles: typeof s === "object" ? s.subtitles : void 0
          });
          seen.add(u);
        }
      }
    }
    if (primaryUrl || streamSources.length > 0) {
      return [{
        number: 1,
        title: firstEp?.title || "Pel\xEDcula Completa",
        url: primaryUrl,
        sources: streamSources
      }];
    }
    return [];
  }
  return rawEpisodes.map((e, idx) => {
    const epNum = Number.isFinite(Number(e.number)) ? Number(e.number) : idx + 1;
    const primaryUrl = String(e.url || "");
    const epSources = [];
    const seen = /* @__PURE__ */ new Set();
    if (primaryUrl) {
      epSources.push({ url: primaryUrl, source_site: sourceSite });
      seen.add(primaryUrl);
    }
    if (Array.isArray(e.sources)) {
      for (const s of e.sources) {
        const u = typeof s === "string" ? s : s?.url;
        if (u && !seen.has(u)) {
          epSources.push({
            url: u,
            source_site: typeof s === "object" && s.source_site ? s.source_site : sourceSite,
            link_type: typeof s === "object" ? s.link_type : void 0,
            host: typeof s === "object" ? s.host : void 0,
            language: typeof s === "object" ? s.language : void 0,
            audio_language: typeof s === "object" ? s.audio_language : void 0,
            subtitle_language: typeof s === "object" ? s.subtitle_language : void 0,
            subtitles: typeof s === "object" ? s.subtitles : void 0
          });
          seen.add(u);
        }
      }
    }
    return {
      number: epNum,
      title: String(e.title || `Episodio ${epNum}`),
      url: primaryUrl,
      sources: epSources
    };
  });
}
async function catalogPhase(cfg, opts) {
  state2.phase = "catalog";
  const platforms = resolveCatalogPlatforms(cfg, opts.platforms);
  const configuredPages = opts.pages_per_platform !== void 0 ? opts.pages_per_platform : cfg.catalog_pages_per_platform !== void 0 ? cfg.catalog_pages_per_platform : 0;
  const maxPages = configuredPages > 0 ? configuredPages : 5e3;
  const isUnlimited = configuredPages === 0;
  log(
    "info",
    `Fase 2/3 (Cat\xE1logo): ${platforms.length} plataforma(s) en cola (${isUnlimited ? "recorrido aut\xF3nomo hasta agotar" : `m\xE1ximo ${maxPages} p\xE1ginas c/u`}).`
  );
  let itemsSeen = 0;
  let known = 0;
  let newDetected = 0;
  let imported = 0;
  let mergedByDedup = 0;
  const withoutEpisodes = [];
  const checked = [];
  const noUrl = [];
  const catalogErrors = [];
  const analyzedUrls = /* @__PURE__ */ new Set();
  state2.progress.total = runCounters.metaTotal;
  for (const platform of platforms) {
    if (state2.stopped) return;
    while (state2.paused && !state2.stopped) {
      await sleep(400);
    }
    if (state2.stopped) return;
    const baseCatalogUrl = cfg.catalog_urls_by_platform[platform];
    if (!baseCatalogUrl) {
      noUrl.push(platform);
      log("warn", `[${platform}] Sin URL de cat\xE1logo configurada, saltando.`);
      continue;
    }
    checked.push(platform);
    let consecutiveEmptyPages = 0;
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (state2.stopped) return;
      while (state2.paused && !state2.stopped) {
        await sleep(400);
      }
      if (state2.stopped) return;
      const pageUrl = buildPageUrl(baseCatalogUrl, pageNum);
      state2.currentItem = `[${platform}] P\xE1g. ${pageNum} - ${pageUrl}`;
      let items = [];
      try {
        const extracted = await extractCatalogListing(pageUrl);
        items = opts.limit && opts.limit > 0 ? extracted.slice(0, opts.limit) : extracted;
      } catch (e) {
        const msg = `[${platform}] Error al extraer p\xE1gina ${pageNum} (${pageUrl}): ${e?.message || e}`;
        catalogErrors.push(msg);
        log("error", msg);
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 3) break;
        continue;
      }
      if (!items || items.length === 0) {
        consecutiveEmptyPages++;
        if (pageNum > 1) {
          log("info", `[${platform}] Fin del cat\xE1logo alcanzado en p\xE1gina ${pageNum}.`);
          break;
        }
        continue;
      }
      if (pageNum > 1 && items.every((it) => it.url && analyzedUrls.has(it.url))) {
        log("info", `[${platform}] P\xE1gina ${pageNum} sin items nuevos, cat\xE1logo al d\xEDa. Pasando a siguiente plataforma.`);
        break;
      }
      state2.progress.total += items.length;
      consecutiveEmptyPages = 0;
      const pageTitleKeys = items.map((it) => normalizeTitleKey(it.title)).filter(Boolean);
      let knownShowsInBatch = [];
      try {
        knownShowsInBatch = await prisma.show.findMany({
          where: {
            OR: [
              { normalized_title: { in: pageTitleKeys } },
              { base_normalized_title: { in: pageTitleKeys } }
            ]
          },
          select: {
            id: true,
            title: true,
            year: true,
            category: true,
            normalized_title: true,
            base_normalized_title: true,
            _count: { select: { episodes: true } }
          }
        });
      } catch {
      }
      const knownMap = /* @__PURE__ */ new Map();
      for (const s of knownShowsInBatch) {
        if (s.normalized_title) knownMap.set(s.normalized_title, s);
        if (s.base_normalized_title) knownMap.set(s.base_normalized_title, s);
      }
      for (const item of items) {
        if (state2.stopped) return;
        while (state2.paused && !state2.stopped) {
          await sleep(400);
        }
        if (state2.stopped) return;
        itemsSeen++;
        runCounters.catalogDone++;
        state2.progress.done = runCounters.metaDone + runCounters.catalogDone;
        if (!item.title) continue;
        if (item.url && analyzedUrls.has(item.url)) {
          continue;
        }
        if (item.url) analyzedUrls.add(item.url);
        state2.currentItem = `[${platform}] ${item.title}`;
        const key = normalizeTitleKey(item.title);
        const itemKind = inferKindForPlatform(platform, item.kind);
        const batchMatch = knownMap.get(key);
        const existing = batchMatch ? { id: batchMatch.id, title: batchMatch.title, category: batchMatch.category, episodeCount: batchMatch._count.episodes } : await findKnownWork(key, item.year, itemKind);
        if (existing) {
          known++;
          state2.progress.known++;
          if (existing.episodeCount === 0) withoutEpisodes.push(existing.title);
          const skipDetailFetch = state2.config.sync_known_episodes === false || !item.url;
          if (skipDetailFetch) {
            continue;
          }
          if (state2.config.sync_known_episodes !== false && item.url) {
            try {
              const analysis = await analyzeUniversalUrl(item.url);
              const eps = buildEpisodesFromAnalysis(analysis, platform, itemKind);
              const syncResult = await quickSyncKnownShow(existing.id, {
                title: analysis?.title || item.title,
                season: parseTitleQuery(`${item.title} ${item.url || ""}`).season,
                episodes: eps,
                source_site: analysis?.source_domain || platform
              });
              if (syncResult.added > 0) {
                state2.progress.new_episodes += syncResult.added;
                log("info", `[${platform}] '${existing.title}': +${syncResult.added} episodio(s) nuevo(s) detectado(s).`);
              }
              if (syncResult.sourcesAdded && syncResult.sourcesAdded > 0) {
                state2.progress.sources_added += syncResult.sourcesAdded;
              }
            } catch (e) {
              log("warn", `[${platform}] Re-escaneo de '${existing.title}': ${e?.message || e}`);
            }
          }
          continue;
        }
        newDetected++;
        state2.progress.new_sources++;
        try {
          let analysis = null;
          let tmdbIdToUse = null;
          if (item.url) {
            try {
              analysis = await analyzeUniversalUrl(item.url);
              if (analysis.tmdb_id && analysis.tmdb_id > 0) {
                tmdbIdToUse = analysis.tmdb_id;
              }
              await sleep(30 + Math.random() * 30);
            } catch (e) {
              log("warn", `[${platform}] An\xE1lisis fall\xF3 para '${item.title}': ${e?.message || e}`);
            }
          }
          const kind = itemKind;
          const eps = buildEpisodesFromAnalysis(analysis, platform, kind);
          const detectedStreams = Array.isArray(analysis?.detected_streams) ? analysis.detected_streams : [];
          const candidateTitle = analysis?.title && isPlausibleTitle(analysis.title) ? analysis.title : item.title && isPlausibleTitle(item.title) ? item.title : cleanSlugToWords(analysis?.title || item.title);
          const result = await saveShowWithDeduplication({
            title: candidateTitle,
            original_title: analysis?.original_title || void 0,
            tmdb_id: tmdbIdToUse || void 0,
            poster_url: analysis?.poster_url || item.image_url || void 0,
            banner_url: analysis?.banner_url || void 0,
            year: analysis?.year || (item.year && Number.isFinite(item.year) && item.year > 1900 ? item.year : void 0),
            rating: analysis?.rating || (item.rating && Number.isFinite(item.rating) ? item.rating : void 0),
            genres: analysis?.genres || (Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : void 0),
            content_type: kind,
            source_site: analysis?.source_domain || platform,
            source: platform,
            description: analysis?.description || void 0,
            detected_streams: detectedStreams,
            episodes: eps
          });
          if (result.isDuplicate) {
            mergedByDedup++;
            state2.progress.works_merged++;
            log("info", `[${platform}] '${result.show.title}' fusionada con obra existente por deduplicaci\xF3n.`);
          } else {
            imported++;
            state2.progress.new_works++;
            log("info", `[${platform}] Nueva obra importada: '${result.show.title}'.`);
          }
          if (result.episodesAdded > 0) {
            state2.progress.new_episodes += result.episodesAdded;
          }
          if (result.sourcesAdded && result.sourcesAdded > 0) {
            state2.progress.sources_added += result.sourcesAdded;
          }
          await sleep(50 + Math.random() * 50);
        } catch (e) {
          state2.progress.errors++;
          const msg = `[${platform}] Item '${item.title}': ${e?.message || e}`;
          catalogErrors.push(msg);
          log("error", msg);
        }
      }
    }
  }
  const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
  state2.lastReport = {
    started_at: state2.startedAt || finishedAt,
    finished_at: finishedAt,
    duration_ms: state2.startedAt ? Date.now() - new Date(state2.startedAt).getTime() : 0,
    trigger: opts.trigger || "manual",
    scope: {
      mode: cfg.scope_mode,
      platforms: opts.platforms?.length ? opts.platforms : cfg.scope_mode === "platforms" ? cfg.platforms : [],
      category: cfg.category ?? null
    },
    metadata_phase: {
      works_total: runCounters.metaTotal,
      works_done: runCounters.metaDone,
      updated_metadata: runCounters.metaUpdated,
      errors: runCounters.metaErrors
    },
    catalog_phase: {
      skipped: false,
      platforms_checked: checked,
      platforms_skipped_no_url: noUrl,
      items_seen: itemsSeen,
      known,
      known_without_episodes: withoutEpisodes,
      new_detected: newDetected,
      imported,
      merged_by_dedup: mergedByDedup,
      errors: catalogErrors,
      works_merged: state2.progress.works_merged || 0,
      sources_added: state2.progress.sources_added || 0
    }
  };
}
async function runPass(opts) {
  const cfg = getVerificationConfig();
  const metadataOnly = opts.mode === "metadata" ? true : opts.mode === "full" ? false : cfg.metadata_only;
  try {
    await metadataPhase(cfg, opts, "initial");
    if (!metadataOnly && !state2.stopped) {
      await catalogPhase(cfg, opts);
      if (!state2.stopped) {
        await metadataPhase(cfg, opts, "final");
      }
      log(
        "info",
        `Pasada completa finalizada: ${state2.progress.new_works} nueva(s) importada(s), ${state2.progress.known} conocida(s), ${state2.progress.updated_metadata} obra(s) con metadatos normalizados/reparados.`
      );
    } else if (metadataOnly) {
      const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      state2.lastReport = {
        started_at: state2.startedAt || finishedAt,
        finished_at: finishedAt,
        duration_ms: state2.startedAt ? Date.now() - new Date(state2.startedAt).getTime() : 0,
        trigger: opts.trigger || "manual",
        scope: {
          mode: cfg.scope_mode,
          platforms: opts.platforms?.length ? opts.platforms : cfg.scope_mode === "platforms" ? cfg.platforms : [],
          category: cfg.category ?? null
        },
        metadata_phase: {
          works_total: runCounters.metaTotal,
          works_done: runCounters.metaDone,
          updated_metadata: runCounters.metaUpdated,
          errors: runCounters.metaErrors
        },
        catalog_phase: {
          skipped: true,
          platforms_checked: [],
          platforms_skipped_no_url: [],
          items_seen: 0,
          known: 0,
          known_without_episodes: [],
          new_detected: 0,
          imported: 0,
          merged_by_dedup: 0,
          errors: [],
          works_merged: 0,
          sources_added: 0
        }
      };
      log("info", `Pasada (solo metadatos) finalizada: ${state2.progress.updated_metadata} obra(s) reparada(s).`);
    }
  } catch (e) {
    state2.progress.errors++;
    log("error", `Pasada abortada: ${e?.message || e}`);
    const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    state2.lastReport = {
      started_at: state2.startedAt || finishedAt,
      finished_at: finishedAt,
      duration_ms: state2.startedAt ? Date.now() - new Date(state2.startedAt).getTime() : 0,
      trigger: opts.trigger || "manual",
      scope: {
        mode: cfg.scope_mode,
        platforms: opts.platforms?.length ? opts.platforms : cfg.scope_mode === "platforms" ? cfg.platforms : [],
        category: cfg.category ?? null
      },
      metadata_phase: {
        works_total: runCounters.metaTotal,
        works_done: runCounters.metaDone,
        updated_metadata: runCounters.metaUpdated,
        errors: runCounters.metaErrors + 1
      },
      catalog_phase: {
        skipped: true,
        platforms_checked: [],
        platforms_skipped_no_url: [],
        items_seen: 0,
        known: 0,
        known_without_episodes: [],
        new_detected: 0,
        imported: 0,
        merged_by_dedup: 0,
        errors: [String(e?.message || e).slice(0, 500)],
        works_merged: 0,
        sources_added: 0
      }
    };
  }
}
scheduleTimer();

// server/resolvers/megaStream.ts
var import_promises2 = require("node:stream/promises");
var import_megajs = require("megajs");
init_megaResolver();
init_networkLogger();
var MAX_CONNECTIONS_PER_RANGE = 2;
var META_CACHE_TTL_MS = 10 * 60 * 1e3;
var ETOOMANY_RETRY_DELAYS_MS = [2e3, 4e3];
function isEtooMany(err) {
  return err?.code === -6 || /ETOOMANY|too many concurrent/i.test(String(err?.message ?? ""));
}
var metaCache = /* @__PURE__ */ new Map();
function guessMimeFromName(name) {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext === "mkv") return "video/x-matroska";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  if (ext === "avi") return "video/x-msvideo";
  return "video/mp4";
}
async function getMegaFileMeta(megaUrl) {
  const cached = metaCache.get(megaUrl);
  if (cached && Date.now() - cached.loadedAt < META_CACHE_TTL_MS) return cached;
  let file = null;
  for (let attempt = 0; ; attempt++) {
    try {
      file = import_megajs.File.fromURL(megaUrl);
      await file.loadAttributes();
      break;
    } catch (err) {
      if (attempt >= ETOOMANY_RETRY_DELAYS_MS.length || !isEtooMany(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, ETOOMANY_RETRY_DELAYS_MS[attempt]));
    }
  }
  if (!file) throw new Error("MEGA: no se pudo cargar metadata tras reintentos");
  const meta = {
    name: file.name || "video.mp4",
    size: Number(file.size) || 0,
    mime: guessMimeFromName(file.name || ""),
    loadedAt: Date.now()
  };
  if (!meta.size) throw new Error("MEGA no report\xF3 tama\xF1o del archivo");
  metaCache.set(megaUrl, meta);
  return meta;
}
function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || !match[1] && !match[2]) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  }
  return { start, end };
}
async function handleMegaStream(req, res) {
  const megaUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const _startMs = Date.now();
  if (!isMegaUrl(megaUrl)) {
    res.status(400).json({ error: "URL de MEGA inv\xE1lida" });
    return;
  }
  const parsed = parseMegaUrl(megaUrl);
  if (!parsed || parsed.kind !== "file") {
    res.status(400).json({ error: "Solo se soportan enlaces p\xFAblicos /file/{ID}#{KEY}" });
    return;
  }
  try {
    const meta = await getMegaFileMeta(parsed.canonicalUrl);
    if (req.method === "HEAD") {
      res.status(200);
      res.setHeader("Content-Type", meta.mime);
      res.setHeader("Content-Length", String(meta.size));
      res.setHeader("Accept-Ranges", "bytes");
      logProxyRequest({
        targetUrl: parsed.canonicalUrl,
        upstreamStatus: 200,
        durationMs: Date.now() - _startMs,
        bytesReceived: 0,
        client: "mega"
      });
      res.end();
      return;
    }
    const range = parseByteRange(
      typeof req.headers.range === "string" ? req.headers.range : void 0,
      meta.size
    );
    const start = range?.start ?? 0;
    const end = range?.end ?? meta.size - 1;
    const contentLength = end - start + 1;
    if (range && (start >= meta.size || end < start)) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${meta.size}`);
      res.end();
      return;
    }
    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(contentLength));
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${meta.size}`);
    res.setHeader("Cache-Control", "no-store");
    const clientAborted = new Promise((resolve) => {
      res.on("close", () => {
        if (!res.writableEnded) resolve();
      });
    });
    const file = import_megajs.File.fromURL(parsed.canonicalUrl);
    const openStream = () => file.download({
      start,
      end,
      maxConnections: MAX_CONNECTIONS_PER_RANGE,
      forceHttps: true
    });
    let stream;
    try {
      stream = openStream();
    } catch (err) {
      if (!isEtooMany(err)) throw err;
      for (let attempt = 0; attempt < ETOOMANY_RETRY_DELAYS_MS.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, ETOOMANY_RETRY_DELAYS_MS[attempt]));
        try {
          stream = openStream();
          break;
        } catch (retryErr) {
          if (attempt === ETOOMANY_RETRY_DELAYS_MS.length - 1 || !isEtooMany(retryErr)) throw retryErr;
        }
      }
      if (!stream) throw err;
    }
    await Promise.race([
      (0, import_promises2.pipeline)(stream, res),
      clientAborted
    ]);
    logProxyRequest({
      targetUrl: parsed.canonicalUrl,
      upstreamStatus: range ? 206 : 200,
      durationMs: Date.now() - _startMs,
      bytesReceived: contentLength,
      client: "mega"
    });
  } catch (err) {
    console.error("[stream/mega] Error:", err?.message || err);
    const isEtoo = isEtooMany(err);
    const quotaExceeded = err?.code === -9 || isEtoo || /quota|ETEMPUNAVAIL|ETOOMANY|too many concurrent/i.test(String(err?.message));
    const status = quotaExceeded ? 429 : 502;
    const errorMsg = isEtoo ? "MEGA ETOOMANY (-6): Demasiadas IPs concurrentes en este enlace" : quotaExceeded ? "Cuota de transferencia de MEGA excedida" : err?.message || "Error MEGA";
    logProxyRequest({
      targetUrl: parsed.canonicalUrl || megaUrl,
      upstreamStatus: status,
      durationMs: Date.now() - _startMs,
      bytesReceived: 0,
      error: errorMsg,
      client: "mega"
    });
    if (!res.headersSent) {
      res.status(status).json({
        error: quotaExceeded ? "Cuota de transferencia de MEGA excedida; usar modo embed como fallback." : `Error transmitiendo desde MEGA: ${err?.message}`,
        fallback_embed: true
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

// server/mp4SizeCache.ts
var MP4_SIZE_CACHE_TTL_MS = 30 * 60 * 1e3;
var MP4_SIZE_CACHE_MAX_ENTRIES = 500;
var mp4SizeCache = /* @__PURE__ */ new Map();
function mp4SizeCacheKey(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return targetUrl;
  }
}
function getMp4SizeCacheEntry(targetUrl) {
  return mp4SizeCache.get(mp4SizeCacheKey(targetUrl));
}
function setMp4SizeCacheEntry(targetUrl, entry, now = Date.now()) {
  if (mp4SizeCache.size >= MP4_SIZE_CACHE_MAX_ENTRIES) {
    pruneMp4SizeCache(now);
  }
  mp4SizeCache.set(mp4SizeCacheKey(targetUrl), {
    size: entry.size,
    loadedAt: now,
    finalUrl: entry.finalUrl
  });
}
function pruneMp4SizeCache(now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of mp4SizeCache) {
    if (now - entry.loadedAt > MP4_SIZE_CACHE_TTL_MS) {
      mp4SizeCache.delete(key);
      removed++;
    }
  }
  return removed;
}

// server.ts
init_networkLogger();

// server/auth.ts
var import_express = require("express");
var import_bcryptjs = __toESM(require("bcryptjs"), 1);
var import_jsonwebtoken = __toESM(require("jsonwebtoken"), 1);
var JWT_SECRET = process.env.JWT_SECRET || "nitiflix-secret-jwt-key-2026";
var authRouter = (0, import_express.Router)();
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado. Token no proporcionado." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = import_jsonwebtoken.default.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Token inv\xE1lido o expirado." });
  }
}
function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = import_jsonwebtoken.default.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch {
    }
  }
  next();
}
authRouter.post("/register", async (req, res) => {
  try {
    const { username, password, avatar } = req.body;
    if (!username || typeof username !== "string" || username.trim().length < 3) {
      return res.status(400).json({ error: "El nombre de usuario debe tener al menos 3 caracteres." });
    }
    if (!password || typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "La contrase\xF1a debe tener al menos 4 caracteres." });
    }
    const cleanUsername = username.trim().toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { username: cleanUsername }
    });
    if (existing) {
      return res.status(409).json({ error: "Ese nombre de usuario ya est\xE1 registrado." });
    }
    const salt = await import_bcryptjs.default.genSalt(10);
    const password_hash = await import_bcryptjs.default.hash(password, salt);
    const newUser = await prisma.user.create({
      data: {
        username: cleanUsername,
        password_hash,
        avatar: avatar || "amber"
      },
      select: {
        id: true,
        username: true,
        avatar: true,
        created_at: true
      }
    });
    const token = import_jsonwebtoken.default.sign(
      { id: newUser.id, username: newUser.username },
      JWT_SECRET,
      { expiresIn: "30d" }
    );
    return res.status(201).json({
      message: "Usuario creado exitosamente",
      user: newUser,
      token
    });
  } catch (error) {
    console.error("Error en registro:", error);
    return res.status(500).json({ error: "Error al registrar usuario: " + (error?.message || error) });
  }
});
authRouter.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contrase\xF1a son requeridos." });
    }
    const cleanUsername = username.trim().toLowerCase();
    const user = await prisma.user.findUnique({
      where: { username: cleanUsername }
    });
    if (!user) {
      return res.status(401).json({ error: "Usuario o contrase\xF1a incorrectos." });
    }
    const isMatch = await import_bcryptjs.default.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Usuario o contrase\xF1a incorrectos." });
    }
    const token = import_jsonwebtoken.default.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: "30d" }
    );
    return res.json({
      message: "Sesi\xF3n iniciada correctamente",
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        created_at: user.created_at
      },
      token
    });
  } catch (error) {
    console.error("Error en login:", error);
    return res.status(500).json({ error: "Error al iniciar sesi\xF3n: " + (error?.message || error) });
  }
});
authRouter.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        avatar: true,
        created_at: true
      }
    });
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    return res.json({ user });
  } catch (error) {
    console.error("Error al obtener usuario:", error);
    return res.status(500).json({ error: "Error al obtener perfil." });
  }
});
authRouter.patch("/avatar", requireAuth, async (req, res) => {
  try {
    const { avatar } = req.body;
    if (!avatar || typeof avatar !== "string") {
      return res.status(400).json({ error: "Avatar no v\xE1lido." });
    }
    const updated = await prisma.user.update({
      where: { id: req.user.id },
      data: { avatar },
      select: {
        id: true,
        username: true,
        avatar: true,
        created_at: true
      }
    });
    return res.json({ user: updated });
  } catch (error) {
    return res.status(500).json({ error: "Error al actualizar avatar." });
  }
});

// server/progress.ts
var import_express2 = require("express");
var progressRouter = (0, import_express2.Router)();
progressRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const items = await prisma.watchProgress.findMany({
      where: { user_id: userId },
      orderBy: { last_watched_at: "desc" },
      take: 50
    });
    const formatted = items.map((item) => ({
      showId: item.show_id,
      showTitle: item.show_title,
      showPoster: item.show_poster || void 0,
      episodeId: item.episode_id,
      episodeNumber: item.episode_number,
      episodeTitle: item.episode_title,
      progressPercent: Math.round(item.progress_percent),
      currentTime: item.current_time || 0,
      duration: item.duration || 0,
      lastWatchedAt: item.last_watched_at.getTime()
    }));
    return res.json({ items: formatted });
  } catch (error) {
    console.error("Error al obtener progreso de reproducci\xF3n:", error);
    return res.status(500).json({ error: "Error al obtener progreso: " + (error?.message || error) });
  }
});
progressRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      showId,
      showTitle,
      showPoster,
      episodeId,
      episodeNumber,
      episodeTitle,
      progressPercent,
      currentTime,
      duration
    } = req.body;
    if (!showId || !episodeId) {
      return res.status(400).json({ error: "showId y episodeId son requeridos." });
    }
    const safeNumber = typeof episodeNumber === "number" ? episodeNumber : parseFloat(episodeNumber) || 1;
    const safePercent = typeof progressPercent === "number" ? progressPercent : parseFloat(progressPercent) || 0;
    const safeTime = typeof currentTime === "number" ? currentTime : parseFloat(currentTime) || 0;
    const safeDuration = typeof duration === "number" ? duration : parseFloat(duration) || 0;
    const record = await prisma.watchProgress.upsert({
      where: {
        user_id_show_id_episode_id: {
          user_id: userId,
          show_id: String(showId),
          episode_id: String(episodeId)
        }
      },
      update: {
        show_title: showTitle || "Contenido",
        show_poster: showPoster || null,
        episode_number: safeNumber,
        episode_title: episodeTitle || `Episodio ${safeNumber}`,
        progress_percent: Math.min(100, Math.max(0, safePercent)),
        current_time: safeTime,
        duration: safeDuration,
        last_watched_at: /* @__PURE__ */ new Date()
      },
      create: {
        user_id: userId,
        show_id: String(showId),
        show_title: showTitle || "Contenido",
        show_poster: showPoster || null,
        episode_id: String(episodeId),
        episode_number: safeNumber,
        episode_title: episodeTitle || `Episodio ${safeNumber}`,
        progress_percent: Math.min(100, Math.max(0, safePercent)),
        current_time: safeTime,
        duration: safeDuration,
        last_watched_at: /* @__PURE__ */ new Date()
      }
    });
    return res.json({ success: true, item: record });
  } catch (error) {
    console.error("Error al guardar progreso:", error);
    return res.status(500).json({ error: "Error al guardar progreso: " + (error?.message || error) });
  }
});
progressRouter.delete("/:episodeId", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { episodeId } = req.params;
    await prisma.watchProgress.deleteMany({
      where: {
        user_id: userId,
        episode_id: episodeId
      }
    });
    return res.json({ success: true, message: "Elemento eliminado de Seguir Viendo" });
  } catch (error) {
    console.error("Error al eliminar progreso:", error);
    return res.status(500).json({ error: "Error al eliminar progreso." });
  }
});
progressRouter.delete("/show/:showId", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { showId } = req.params;
    await prisma.watchProgress.deleteMany({
      where: {
        user_id: userId,
        show_id: showId
      }
    });
    return res.json({ success: true, message: "Serie eliminada de Seguir Viendo" });
  } catch (error) {
    return res.status(500).json({ error: "Error al limpiar serie del progreso." });
  }
});

// server/recommendations.ts
var import_express3 = require("express");
var recommendationsRouter = (0, import_express3.Router)();
recommendationsRouter.get("/", optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      const guestData = await getGuestRecommendations();
      return res.json(guestData);
    }
    const watchHistory = await prisma.watchProgress.findMany({
      where: { user_id: userId },
      orderBy: { last_watched_at: "desc" },
      take: 40
    });
    if (watchHistory.length === 0) {
      const guestData = await getGuestRecommendations();
      return res.json(guestData);
    }
    const watchedShowIds = Array.from(new Set(watchHistory.map((w) => w.show_id)));
    const watchedShows = await prisma.show.findMany({
      where: { id: { in: watchedShowIds } },
      select: { id: true, title: true, genres: true, category: true, rating: true }
    });
    const watchedShowMap = new Map(watchedShows.map((s) => [s.id, s]));
    const genreScores = {};
    const categoryScores = {};
    watchHistory.forEach((item, index) => {
      const show = watchedShowMap.get(item.show_id);
      if (!show) return;
      const recencyWeight = Math.max(0.2, 1 - index * 0.03);
      const progressWeight = Math.max(0.5, (item.progress_percent || 50) / 100);
      const itemWeight = recencyWeight * progressWeight;
      if (show.category) {
        const cat = show.category.toLowerCase();
        categoryScores[cat] = (categoryScores[cat] || 0) + itemWeight * 2;
      }
      if (show.genres) {
        const genres = show.genres.split(/[,/|•]+/).map((g) => g.trim()).filter(Boolean);
        genres.forEach((g) => {
          if (g.length > 2 && !/multimedia|general/i.test(g)) {
            const cleanGenre = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
            genreScores[cleanGenre] = (genreScores[cleanGenre] || 0) + itemWeight;
          }
        });
      }
    });
    const topGenres = Object.entries(genreScores).sort((a, b) => b[1] - a[1]).map(([genre]) => genre);
    const lastWatchedItem = watchHistory[0];
    const lastWatchedShow = lastWatchedItem ? watchedShowMap.get(lastWatchedItem.show_id) : null;
    const primaryGenre = topGenres[0] || "Acci\xF3n";
    const secondaryGenre = topGenres[1] || "Aventura";
    const thirdGenre = topGenres[2] || "Comedia";
    const personalizedShows = await prisma.show.findMany({
      where: {
        id: { notIn: watchedShowIds },
        OR: [
          { genres: { contains: primaryGenre, mode: "insensitive" } },
          { genres: { contains: secondaryGenre, mode: "insensitive" } }
        ]
      },
      orderBy: [{ rating: "desc" }, { year: "desc" }],
      take: 24
    });
    let becauseYouWatchedShows = [];
    if (lastWatchedShow && lastWatchedShow.genres) {
      const lastGenres = lastWatchedShow.genres.split(/[,/|•]+/).map((g) => g.trim()).filter((g) => g.length > 2);
      const matchGenre = lastGenres[0] || primaryGenre;
      becauseYouWatchedShows = await prisma.show.findMany({
        where: {
          id: { notIn: [...watchedShowIds, lastWatchedShow.id] },
          genres: { contains: matchGenre, mode: "insensitive" }
        },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 20
      });
    }
    const topRatedGenreShows = await prisma.show.findMany({
      where: {
        id: { notIn: watchedShowIds },
        rating: { gte: 8 },
        OR: [
          { genres: { contains: primaryGenre, mode: "insensitive" } },
          { genres: { contains: secondaryGenre, mode: "insensitive" } },
          { genres: { contains: thirdGenre, mode: "insensitive" } }
        ]
      },
      orderBy: { rating: "desc" },
      take: 20
    });
    const discoveryShows = await prisma.show.findMany({
      where: {
        id: { notIn: watchedShowIds },
        rating: { gte: 7.8 },
        NOT: {
          genres: {
            contains: primaryGenre,
            mode: "insensitive"
          }
        }
      },
      orderBy: { year: "desc" },
      take: 20
    });
    const rails = [];
    if (personalizedShows.length > 0) {
      rails.push({
        id: "for-you",
        title: "Recomendados para ti",
        reason: "top_affinity",
        shows: shuffle(personalizedShows).slice(0, 16)
      });
    }
    if (lastWatchedShow && becauseYouWatchedShows.length > 0) {
      rails.push({
        id: `because-${lastWatchedShow.id}`,
        title: `Porque viste ${lastWatchedShow.title}`,
        reason: "because_watched",
        shows: becauseYouWatchedShows.slice(0, 16)
      });
    }
    if (topRatedGenreShows.length > 0) {
      rails.push({
        id: "top-rated-genre",
        title: `Lo mejor de ${primaryGenre}`,
        reason: "high_rating",
        shows: topRatedGenreShows.slice(0, 16)
      });
    }
    if (discoveryShows.length > 0) {
      rails.push({
        id: "discovery",
        title: "Descubre algo nuevo",
        reason: "discovery",
        shows: shuffle(discoveryShows).slice(0, 16)
      });
    }
    let heroCandidate = personalizedShows.find(
      (s) => s.backdrop_path || s.banner_url || (s.rating || 0) >= 8.2 && s.description && s.description.length > 50
    );
    if (!heroCandidate && personalizedShows.length > 0) {
      heroCandidate = personalizedShows[0];
    }
    if (!heroCandidate && topRatedGenreShows.length > 0) {
      heroCandidate = topRatedGenreShows[0];
    }
    return res.json({ hero: heroCandidate || null, rails });
  } catch (error) {
    console.error("Error al calcular recomendaciones:", error);
    return res.status(500).json({ error: "Error al generar recomendaciones: " + (error?.message || error) });
  }
});
async function getGuestRecommendations() {
  try {
    const [topHeroPicks, popularAnime, topMoviesSeries, trendingAll] = await Promise.all([
      prisma.show.findMany({
        where: {
          rating: { gte: 8.2 },
          OR: [
            { backdrop_path: { not: null } },
            { banner_url: { not: null } }
          ]
        },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 10
      }),
      prisma.show.findMany({
        where: { category: "anime", rating: { gte: 7.5 } },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 16
      }),
      prisma.show.findMany({
        where: {
          category: { in: ["movie", "series", "pelicula", "peliculas", "serie"] },
          rating: { gte: 7.5 }
        },
        orderBy: [{ rating: "desc" }, { year: "desc" }],
        take: 16
      }),
      prisma.show.findMany({
        orderBy: [{ year: "desc" }, { rating: "desc" }],
        take: 16
      })
    ]);
    const heroPick = topHeroPicks.length > 0 ? topHeroPicks[Math.floor(Math.random() * Math.min(5, topHeroPicks.length))] : trendingAll[0] || null;
    return {
      hero: heroPick,
      rails: [
        {
          id: "trending-guest",
          title: "Tendencias",
          shows: trendingAll
        },
        {
          id: "anime-guest",
          title: "Anime Destacado",
          shows: popularAnime
        },
        {
          id: "movies-guest",
          title: "Pel\xEDculas y Series Populares",
          shows: topMoviesSeries
        }
      ]
    };
  } catch {
    return { hero: null, rails: [] };
  }
}
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// server/adminAuth.ts
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_jsonwebtoken2 = __toESM(require("jsonwebtoken"), 1);
var ADMIN_SESSION_COOKIE = "meristream_admin_session";
var ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
function adminConfig() {
  const user = process.env.ADMIN_USER?.trim() || "";
  const password = process.env.ADMIN_PASS || "";
  const secret = process.env.ADMIN_SESSION_SECRET || "";
  return { user, password, secret };
}
function isAdminConfigured() {
  const { user, password, secret } = adminConfig();
  return Boolean(user && password && secret);
}
function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  };
}
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
function safeEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && import_node_crypto.default.timingSafeEqual(leftBuffer, rightBuffer);
}
function verifyAdminCredentials(user, password) {
  if (!isAdminConfigured() || typeof user !== "string" || typeof password !== "string") return false;
  const configured = adminConfig();
  return safeEquals(user, configured.user) && safeEquals(password, configured.password);
}
function issueAdminSession() {
  const { secret } = adminConfig();
  if (!secret) throw new Error("Admin session is not configured");
  return import_jsonwebtoken2.default.sign({ role: "admin" }, secret, { expiresIn: ADMIN_SESSION_TTL_SECONDS });
}
function hasValidAdminSession(req) {
  if (!isAdminConfigured()) return false;
  const token = readCookie(req, ADMIN_SESSION_COOKIE);
  if (!token) return false;
  try {
    const payload = import_jsonwebtoken2.default.verify(token, adminConfig().secret);
    return payload.role === "admin";
  } catch {
    return false;
  }
}
function unavailable(res) {
  return res.status(503).json({ error: "Administraci\xF3n no configurada." });
}
function requireAdmin(req, res, next) {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  if (!hasValidAdminSession(req)) {
    res.status(401).json({ error: "Sesi\xF3n administrativa requerida." });
    return;
  }
  next();
}
function isAdminControlPlaneRequest(path7, method) {
  const normalizedPath = (path7 || "/").replace(/\/+$/, "") || "/";
  const normalizedMethod = method.toUpperCase();
  const protectedPrefixes = [
    "/verification",
    "/worker",
    "/tasks",
    "/source-recovery",
    "/write-buffer",
    "/metadata/backfill",
    "/scraper/presets",
    "/sites/ratings",
    "/platforms"
  ];
  if (protectedPrefixes.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return true;
  }
  if (normalizedPath.startsWith("/network/") && normalizedPath !== "/network/player-event") return true;
  if (normalizedPath === "/discover") return true;
  if (/^\/catalog\/(analyze|import-show|batch-import|crawl|reset-sample|merge-works|reconcile-sequels)$/.test(normalizedPath)) {
    return true;
  }
  if (/^\/shows\/[^/]+$/.test(normalizedPath) && ["PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    return true;
  }
  return normalizedMethod === "POST" && /^\/shows\/[^/]+\/(refresh-streams|force-metadata)$/.test(normalizedPath);
}
function requireAdminForControlPlane(req, res, next) {
  if (!isAdminControlPlaneRequest(req.path, req.method)) {
    next();
    return;
  }
  requireAdmin(req, res, next);
}
function adminLogin(req, res) {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  if (!verifyAdminCredentials(req.body?.user, req.body?.password)) {
    res.status(401).json({ ok: false, detail: "Credenciales incorrectas" });
    return;
  }
  res.cookie(ADMIN_SESSION_COOKIE, issueAdminSession(), {
    ...cookieOptions(),
    maxAge: ADMIN_SESSION_TTL_SECONDS * 1e3
  });
  res.json({ ok: true });
}
function adminSession(req, res) {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  if (!hasValidAdminSession(req)) {
    res.status(401).json({ ok: false, authenticated: false });
    return;
  }
  res.json({ ok: true, authenticated: true });
}
function adminLogout(_req, res) {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  res.clearCookie(ADMIN_SESSION_COOKIE, cookieOptions());
  res.status(204).end();
}

// server.ts
var stealthClient = new import_impit_client.ImpitHttpClient({
  browser: import_impit_client.Browser.Chrome,
  http3: false,
  ignoreTlsErrors: true
});
var deliveryPlanner = new DeliveryPlanner();
var resolutionCoordinator = new ResolutionCoordinator(
  (url) => EmbedResolvers.resolveWithMeta(url),
  { maxEntries: 128 }
);
var playbackSessions = new PlaybackSessionStore({
  resolver: (url) => resolutionCoordinator.resolve(url),
  // A 2-hour VOD has ~800 ten-second segments per quality. The class default
  // (300) evicts the first segment ids while rewriting the level playlist,
  // producing browser-visible 404s. Keep enough opaque locators for one active
  // user while bounding abandoned sessions for the low-memory ASUS host.
  maxSessions: 8,
  maxResourcesPerSession: 2e3
});
var playbackSessionHandlers = createPlaybackSessionHandlers(
  playbackSessions,
  "/api/v1/playback",
  {
    // Existing relays are never rejected: the budget only uses these balanced
    // counters to stop admitting new sessions and speculative work under pressure.
    onRelayStart: () => {
      runtimeBudget.beginRelay();
    },
    onRelayEnd: () => {
      runtimeBudget.endRelay();
    }
  }
);
var CHUNK_SIZE_BYTES = 5 * 1024 * 1024;
var MAX_NETWORK_RETRIES = 3;
var MAX_PROXY_REDIRECTS = 5;
function rankStreams(streams, hostPriority) {
  const seen = /* @__PURE__ */ new Set();
  const entries = streams.filter((u) => {
    if (!u || seen.has(u)) return false;
    if (!isValidProvider(u) || isBlacklistedHost(u)) return false;
    seen.add(u);
    return true;
  });
  return sortStreamsByPriority(
    entries.map((url) => ({
      url,
      type: /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url) ? "direct" : "embed",
      tier: getStreamTier(url),
      host: (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })()
    })),
    hostPriority
  );
}
function isInvalidCatalogSource(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (/\/page\/\d+(?:\/|$)/i.test(pathname)) return true;
    for (const key of ["page", "paged"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return true;
    }
    const host = parsed.hostname.toLowerCase();
    if ((host.includes("cinecalidad.") || host.includes("lamovie.") || host.includes("tioplus.")) && (/^\/$/.test(pathname) || /\/(?:catalogo|peliculas|series|estrenos|genero|category|categoria)\/?$/i.test(pathname))) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
async function buildMultiSourceCascade(sourceLinks, options = { maxPerSite: 2, maxTotal: 8 }) {
  const rawSiteByUrl = /* @__PURE__ */ new Map();
  const priorityTierByUrl = /* @__PURE__ */ new Map();
  const failureReasonByUrl = /* @__PURE__ */ new Map();
  const canonicalLocatorByUrl = /* @__PURE__ */ new Map();
  const sourceStatusByUrl = /* @__PURE__ */ new Map();
  const renditionByUrl = /* @__PURE__ */ new Map();
  for (const link of sourceLinks) {
    if (link?.url) {
      const cleanUrl2 = link.url.trim();
      rawSiteByUrl.set(cleanUrl2, link.source_site || "");
      if (link.priority_tier != null) {
        priorityTierByUrl.set(cleanUrl2, link.priority_tier);
      }
      if (link.failure_reason != null) {
        failureReasonByUrl.set(cleanUrl2, link.failure_reason);
      }
      const canonicalLocator = typeof link.canonical_locator === "string" ? link.canonical_locator.trim() : "";
      if (canonicalLocator) canonicalLocatorByUrl.set(cleanUrl2, canonicalLocator);
      if (link.source_status) sourceStatusByUrl.set(cleanUrl2, link.source_status);
      renditionByUrl.set(cleanUrl2, {
        ...renditionByUrl.get(cleanUrl2) || {},
        ...link.link_type ? { link_type: link.link_type } : {},
        ...link.language ? { language: link.language } : {},
        ...link.audio_language ? { audio_language: link.audio_language } : {},
        ...link.subtitle_language ? { subtitle_language: link.subtitle_language } : {},
        ...link.subtitles !== void 0 ? { subtitles: link.subtitles } : {}
      });
    }
  }
  const normalizeSite2 = (rawSite) => {
    if (!rawSite) return "unknown";
    const domainSite = siteFromDomain(rawSite);
    return domainSite || rawSite.toLowerCase().trim() || "unknown";
  };
  const sites0 = Array.from(new Set(sourceLinks.map((s) => s.source_site).filter(Boolean)));
  const hostPriority = {};
  for (const s of sites0) Object.assign(hostPriority, getServerPriorities(s));
  const validUrls = Array.from(
    new Set(
      sourceLinks.map((s) => s?.url?.trim()).filter((url) => Boolean(url) && !isInvalidCatalogSource(url))
    )
  );
  const ranked = rankStreams(validUrls, hostPriority);
  const sites = Array.from(new Set(ranked.map((r) => normalizeSite2(rawSiteByUrl.get(r.url)))));
  const ratings = await Promise.all(sites.map(async (site) => ({ site, rating: await getSiteRating(site) })));
  const ratingBySite = new Map(ratings.map((r) => [r.site, r.rating]));
  const mapped = ranked.map((entry) => {
    const rawSite = rawSiteByUrl.get(entry.url) || "";
    const site = normalizeSite2(rawSite);
    const sourceKind = classifySourceKind(entry.url);
    const parsedExpiry = parseStreamExpiry(entry.url).expiresAt;
    const persistedLocator = canonicalLocatorByUrl.get(entry.url);
    const canonicalLocator = persistedLocator || (sourceKind === "ephemeral_direct" ? void 0 : entry.url);
    const expiresAt = sourceKind === "ephemeral_direct" ? parsedExpiry : void 0;
    const explicitlyExpired = parsedExpiry !== void 0 && parsedExpiry <= Date.now() || expiresAt !== void 0 && expiresAt <= Date.now();
    if (explicitlyExpired && !canonicalLocator) {
      return null;
    }
    const explicitTier = priorityTierByUrl.get(entry.url);
    const tier = explicitTier ?? entry.tier;
    const renewable = Boolean(canonicalLocator);
    const failureReason = failureReasonByUrl.get(entry.url) ?? (explicitlyExpired && !canonicalLocator ? "expired_without_locator" : void 0);
    const proxyable = entry.type === "direct" && !explicitlyExpired;
    const rendition = renditionByUrl.get(entry.url) || {};
    const sourceStatus = sourceStatusByUrl.get(entry.url);
    return {
      ...entry,
      tier,
      original_url: entry.url,
      canonical_locator: canonicalLocator,
      is_proxyable: proxyable,
      is_refreshable: renewable,
      // Un directo vencido con localizador canónico sigue siendo un intento
      // nativo JIT (no un iframe): el frontend renovará el manifiesto antes
      // de conectarlo y solo entonces decidirá si necesita proxy.
      delivery_mode: entry.type === "direct" && (proxyable || Boolean(canonicalLocator)) ? "direct_trial" : "embed",
      ...expiresAt !== void 0 ? { expires_at: expiresAt } : {},
      ...failureReason !== void 0 ? { failure_reason: failureReason } : {},
      ...sourceStatus ? { source_status: sourceStatus } : {},
      source_site: site,
      rating: ratingBySite.get(site) ?? 5,
      ...rendition
    };
  }).filter((item) => item !== null).sort((a, b) => {
    if (b.rating !== a.rating) return b.rating - a.rating;
    const pa = hostPriority[familyKeyOfStreamUrl(a.url)];
    const pb = hostPriority[familyKeyOfStreamUrl(b.url)];
    if (pa !== void 0 || pb !== void 0) {
      const na = pa ?? Number.MAX_SAFE_INTEGER;
      const nb = pb ?? Number.MAX_SAFE_INTEGER;
      if (na !== nb) return na - nb;
    }
    return a.tier - b.tier;
  });
  const maxPerSite = options?.maxPerSite ?? 2;
  const maxTotal = options?.maxTotal ?? 8;
  const perSiteCount = /* @__PURE__ */ new Map();
  const bounded = [];
  for (const candidate of mapped) {
    const s = candidate.source_site;
    const count = perSiteCount.get(s) || 0;
    if (count >= maxPerSite) {
      continue;
    }
    perSiteCount.set(s, count + 1);
    bounded.push(candidate);
    if (bounded.length >= maxTotal) {
      break;
    }
  }
  return bounded;
}
function keepCanonicalCandidatesFirst(ranked, sourceLinks) {
  const canonicalSites = new Set(
    sourceLinks.filter((link) => {
      const kind = classifySourceKind(link.url);
      return (link.link_type === "page" || link.link_type === "embed" || kind === "page" || kind === "embed") && isCanonicalLocator(link.url);
    }).map((link) => siteFromDomain(link.source_site) || link.source_site.toLowerCase().trim()).filter(Boolean)
  );
  if (canonicalSites.size === 0) return ranked;
  const rank = (entry) => {
    const kind = classifySourceKind(entry.url);
    if ((kind === "page" || kind === "embed") && isCanonicalLocator(entry.url)) return 0;
    if (kind === "stable_direct") return 1;
    if (kind === "ephemeral_direct") return 2;
    return 1;
  };
  return ranked.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry);
}
async function resolveCrossPlatformStreams(primaryEpisode, primaryShow, primarySite, maxExtraPlatforms = 3, timeoutMs = 8e3) {
  const result = /* @__PURE__ */ new Map();
  if (!primaryShow?.title) return result;
  try {
    const epNum = primaryEpisode.episode_number ?? primaryEpisode.number ?? 1;
    const season = parseTitleQuery(primaryShow.title).season ?? 1;
    const kind = primaryShow.category || "anime";
    const platformMap = /* @__PURE__ */ new Map();
    const mediaItems = await prisma.mediaItem.findMany({
      where: primaryShow.tmdb_id ? { tmdb_id: primaryShow.tmdb_id, kind } : {
        kind,
        OR: [
          { base_normalized_title: primaryShow.base_normalized_title || primaryShow.normalized_title },
          { normalized_title: primaryShow.normalized_title }
        ]
      },
      select: { id: true },
      orderBy: { created_at: "asc" }
    });
    if (mediaItems.length > 0) {
      const sourceLinks = await prisma.sourceLink.findMany({
        where: {
          media_episode: {
            media_item_id: { in: mediaItems.map((item) => item.id) },
            season_number: season,
            episode_number: epNum
          }
        },
        select: { url: true, source_site: true },
        orderBy: [{ priority_tier: "asc" }, { last_checked: "desc" }]
      });
      for (const link of sourceLinks) {
        const site = siteFromDomain(link.source_site) || siteFromDomain(hostOfStreamUrl(link.url));
        if (!site || site === primarySite) continue;
        const current = platformMap.get(site);
        const isOriginPage = siteFromDomain(hostOfStreamUrl(link.url)) === site;
        const currentIsOriginPage = current ? siteFromDomain(hostOfStreamUrl(current)) === site : false;
        if (!current || isOriginPage && !currentIsOriginPage) platformMap.set(site, link.url);
      }
    }
    const sameTitleEpisodes = await prisma.episode.findMany({
      where: {
        show: primaryShow.tmdb_id ? { tmdb_id: primaryShow.tmdb_id } : { title: primaryShow.title },
        episode_number: epNum,
        id: { not: primaryEpisode.id },
        source_url: { not: "" }
      },
      take: 30
    });
    for (const ep of sameTitleEpisodes) {
      const site = siteFromDomain(hostOfStreamUrl(ep.source_url || ""));
      if (site && site !== primarySite && !platformMap.has(site)) {
        platformMap.set(site, ep.source_url);
      }
    }
    const entries = Array.from(platformMap.entries());
    const rated = await Promise.all(
      entries.map(async ([site, url]) => ({
        site,
        url,
        rating: await getSiteRating(site)
      }))
    );
    rated.sort((a, b) => b.rating - a.rating);
    const topPlatforms = rated.slice(0, maxExtraPlatforms);
    const resolutions = await Promise.allSettled(
      topPlatforms.map(async ({ site, url }) => {
        let timer;
        try {
          const extracted = await Promise.race([
            extractStreamFromUrl(url),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            })
          ]);
          const streams = Array.from(
            new Set([extracted.stream_url, ...extracted.all_available_streams || []].filter(Boolean))
          );
          const ranked = rankStreams(streams, getServerPriorities(site));
          return { site, ranked };
        } catch {
          return { site, ranked: [] };
        } finally {
          if (timer) clearTimeout(timer);
        }
      })
    );
    for (const r of resolutions) {
      if (r.status === "fulfilled" && r.value.ranked.length > 0) {
        result.set(r.value.site, r.value.ranked);
      }
    }
  } catch (e) {
  }
  return result;
}
async function findCanonicalMediaEpisodeForLegacy(foundEpisode, targetShow) {
  if (!targetShow || !targetShow.title && targetShow.tmdb_id == null) return null;
  const title = String(targetShow.title || targetShow.normalized_title || "").trim();
  const normalized = normalizeTitle(title || String(targetShow.normalized_title || ""));
  const baseNormalized = normalizeBaseTitle(title || String(targetShow.base_normalized_title || ""));
  const where = [];
  if (targetShow.tmdb_id != null) where.push({ tmdb_id: targetShow.tmdb_id });
  if (normalized) where.push({ normalized_title: normalized });
  if (baseNormalized) where.push({ base_normalized_title: baseNormalized });
  if (where.length === 0) return null;
  const category = String(targetShow.category || "").toLowerCase();
  const kindFilter = category === "movie" ? { kind: "movie" } : category === "anime" || category === "series" ? { kind: { in: ["anime", "series"] } } : {};
  const rawEpisodeNumber = Number(foundEpisode?.episode_number ?? 1);
  const episodeNumber = Number.isFinite(rawEpisodeNumber) ? rawEpisodeNumber : 1;
  const parsedSeason = parseTitleQuery(title).season;
  const requestedSeason = Number(targetShow.season_number ?? parsedSeason ?? 1);
  const seasonNumber = Number.isFinite(requestedSeason) && requestedSeason > 0 ? requestedSeason : 1;
  try {
    const mediaItems = await prisma.mediaItem.findMany({
      where: { OR: where, ...kindFilter },
      include: {
        episodes: {
          where: { season_number: seasonNumber, episode_number: episodeNumber },
          include: { links: true }
        }
      },
      take: 50
    });
    const candidates = mediaItems.flatMap((item) => item.episodes.map((episode) => ({
      id: episode.id,
      season_number: episode.season_number,
      episode_number: episode.episode_number,
      media_item: {
        title: item.title,
        normalized_title: item.normalized_title,
        base_normalized_title: item.base_normalized_title,
        tmdb_id: item.tmdb_id,
        year: item.year,
        // Category names in the legacy schema are not stable (anime/tv/series),
        // so the pure matcher intentionally does not use this field as a gate.
        kind: null
      },
      links: episode.links.map((link) => ({ url: link.url, link_type: link.link_type }))
    })));
    const selected = selectCanonicalPlaybackCandidate(
      {
        title: targetShow.title,
        normalized_title: targetShow.normalized_title,
        base_normalized_title: targetShow.base_normalized_title,
        tmdb_id: targetShow.tmdb_id,
        year: targetShow.year,
        episode_number: episodeNumber
      },
      foundEpisode ? { episode_number: episodeNumber } : void 0,
      candidates,
      normalizeTitle,
      normalizeBaseTitle,
      isCanonicalLocator
    );
    if (!selected) return null;
    const selectedEpisode = mediaItems.flatMap((item) => item.episodes).find((episode) => episode.id === selected.id);
    if (!selectedEpisode) return null;
    const rankedRaw = await buildMultiSourceCascade(selectedEpisode.links, { maxPerSite: 2, maxTotal: 8 });
    const ranked = keepCanonicalCandidatesFirst(rankedRaw, selectedEpisode.links);
    return ranked.length > 0 ? { mediaEpisode: selectedEpisode, ranked } : null;
  } catch (error) {
    console.warn("[Playback] puente can\xF3nico legacy omitido:", error?.message || error);
    return null;
  }
}
async function findLegacyEpisodeForMediaEpisode(mediaEpisode) {
  const item = mediaEpisode?.media_item;
  if (!item) return null;
  const title = String(item.title || "").trim();
  const normalized = normalizeTitle(title);
  const baseNormalized = normalizeBaseTitle(title);
  const where = [];
  if (item.tmdb_id != null) where.push({ tmdb_id: item.tmdb_id });
  if (normalized) where.push({ normalized_title: normalized });
  if (baseNormalized && baseNormalized !== normalized) where.push({ base_normalized_title: baseNormalized });
  if (where.length === 0) return null;
  try {
    const shows = await prisma.show.findMany({
      where: { OR: where },
      include: { episodes: true },
      orderBy: { created_at: "asc" },
      take: 50
    });
    const targetYear = Number(item.year);
    const ordered = [...shows].sort((a, b) => {
      const aExact = item.tmdb_id != null && a.tmdb_id === item.tmdb_id ? 1 : 0;
      const bExact = item.tmdb_id != null && b.tmdb_id === item.tmdb_id ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aYear = Number.isFinite(targetYear) && targetYear > 0 && a.year === targetYear ? 1 : 0;
      const bYear = Number.isFinite(targetYear) && targetYear > 0 && b.year === targetYear ? 1 : 0;
      return bYear - aYear;
    });
    const itemKind = String(item.kind || "").toLowerCase();
    const isCompatibleShow = (show) => {
      const showCategory = String(show.category || "").toLowerCase();
      if (!showCategory || !itemKind) return true;
      if (itemKind === "movie") return showCategory === "movie";
      return showCategory === "anime" || showCategory === "series";
    };
    const season = Number(mediaEpisode.season_number) || 1;
    const episodeNumber = Number(mediaEpisode.episode_number);
    for (const show of ordered) {
      if (!isCompatibleShow(show)) continue;
      const episode = (show.episodes || []).find(
        (candidate) => Number(candidate.episode_number) === episodeNumber && (!season || Number(candidate.season_number ?? 1) === season)
      );
      if (episode) return { episode, show };
    }
  } catch (error) {
    console.warn("[Playback] b\xFAsqueda legacy para MediaEpisode omitida:", error?.message || error);
  }
  return null;
}
async function handlePlayEpisode(req, res) {
  const targetId = req.params.episode_id;
  const _playResolveStart = Date.now();
  let foundEpisode = null;
  let targetShow = null;
  try {
    const mediaEpisode = await prisma.mediaEpisode.findUnique({
      where: { id: targetId },
      include: { media_item: true, links: true }
    });
    if (mediaEpisode && mediaEpisode.links?.length > 0) {
      const title2 = `${mediaEpisode.media_item?.title || "Reproducci\xF3n"} - Episodio ${mediaEpisode.episode_number}`;
      const rankedRaw = await buildMultiSourceCascade(mediaEpisode.links, { maxPerSite: 2, maxTotal: 8 });
      const ranked2 = keepCanonicalCandidatesFirst(rankedRaw, mediaEpisode.links);
      const allMergedStreams2 = ranked2.map((entry) => entry.url);
      const streamUrl2 = ranked2[0]?.url || "";
      return res.json({
        episode_id: mediaEpisode.id,
        stream_url: streamUrl2,
        title: title2,
        all_available_streams: allMergedStreams2.length > 0 ? allMergedStreams2 : streamUrl2 ? [streamUrl2] : [],
        ranked_streams: ranked2
      });
    }
    if (mediaEpisode) {
      const legacy = await findLegacyEpisodeForMediaEpisode(mediaEpisode);
      if (legacy) {
        foundEpisode = legacy.episode;
        targetShow = legacy.show;
      } else {
        return res.status(404).json({
          detail: "La obra existe, pero todav\xEDa no tiene una fuente can\xF3nica recuperable.",
          episode_id: mediaEpisode.id,
          ranked_streams: [],
          all_available_streams: []
        });
      }
    }
    if (!foundEpisode) {
      foundEpisode = await prisma.episode.findUnique({
        where: { id: targetId },
        include: { show: true }
      });
      targetShow = foundEpisode?.show || null;
    }
    if (!foundEpisode) {
      const foundShow = await prisma.show.findUnique({
        where: { id: targetId },
        include: { episodes: true }
      });
      if (foundShow) {
        targetShow = foundShow;
        if (foundShow.episodes && foundShow.episodes.length > 0) {
          foundEpisode = { ...foundShow.episodes[0], show: foundShow };
        }
      }
    }
    const canonicalBridge = await findCanonicalMediaEpisodeForLegacy(foundEpisode, targetShow);
    if (canonicalBridge) {
      const title2 = foundEpisode?.title ? `${targetShow?.title || canonicalBridge.mediaEpisode.media_item?.title || ""} - ${foundEpisode.title}` : targetShow?.title || canonicalBridge.mediaEpisode.media_item?.title || "Reproducci\xF3n";
      const allCanonicalStreams = canonicalBridge.ranked.map((entry) => entry.url);
      return res.json({
        episode_id: foundEpisode?.id || targetShow?.id || targetId,
        stream_url: canonicalBridge.ranked[0]?.url || "",
        title: title2,
        all_available_streams: allCanonicalStreams,
        ranked_streams: canonicalBridge.ranked,
        media_episode_id: canonicalBridge.mediaEpisode.id
      });
    }
    const sourceUrl = foundEpisode?.source_url || targetShow?.source_url || targetShow?.url || "";
    if (!sourceUrl && !foundEpisode) {
      return res.status(404).json({ detail: "Episodio u obra no encontrada en la base de datos." });
    }
    const extracted = await extractStreamFromUrl(sourceUrl);
    const allStreams = Array.from(
      new Set([extracted.stream_url, ...extracted.all_available_streams || []].filter(Boolean))
    );
    const title = foundEpisode?.title ? `${targetShow?.title || ""} - ${foundEpisode.title}` : targetShow?.title || extracted.title || "Reproducci\xF3n";
    const platformSite = siteFromDomain(hostOfStreamUrl(sourceUrl));
    const primaryRanked = rankStreams(allStreams, getServerPriorities(platformSite)).map((r) => ({
      ...r,
      source_site: platformSite || void 0
    }));
    const crossPlatform = await resolveCrossPlatformStreams(
      foundEpisode,
      targetShow,
      platformSite,
      3,
      8e3
    );
    const extraEntries = Array.from(crossPlatform.entries());
    const extraRanked = [];
    if (extraEntries.length > 0) {
      const extraRated = await Promise.all(
        extraEntries.map(async ([site, streams]) => ({
          site,
          streams: streams.map((r) => ({ ...r, source_site: site })),
          rating: await getSiteRating(site)
        }))
      );
      extraRated.sort((a, b) => b.rating - a.rating);
      for (const group of extraRated) {
        extraRanked.push(...group.streams);
      }
    }
    const combinedRanked = [...primaryRanked, ...extraRanked];
    const rankedSites = Array.from(
      new Set(combinedRanked.map((entry) => entry.source_site).filter(Boolean))
    );
    const rankedRatings = new Map(
      await Promise.all(
        rankedSites.map(async (site) => [site, await getSiteRating(site)])
      )
    );
    const seenRankedUrls = /* @__PURE__ */ new Set();
    const ranked = combinedRanked.sort((a, b) => {
      const ratingDiff = (rankedRatings.get(b.source_site || "") ?? 5) - (rankedRatings.get(a.source_site || "") ?? 5);
      if (ratingDiff !== 0) return ratingDiff;
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.type !== b.type) return a.type === "direct" ? -1 : 1;
      return 0;
    }).filter((entry) => {
      if (seenRankedUrls.has(entry.url)) return false;
      seenRankedUrls.add(entry.url);
      return true;
    });
    const allMergedStreams = Array.from(
      new Set([
        ...ranked.map((r) => r.url)
      ].filter(Boolean))
    );
    const streamUrl = ranked.find((r) => r.url === extracted.stream_url)?.url || ranked[0]?.url || sourceUrl;
    res.json({
      episode_id: foundEpisode?.id || targetShow?.id || targetId,
      stream_url: streamUrl,
      title,
      all_available_streams: allMergedStreams.length > 0 ? allMergedStreams : [sourceUrl],
      ranked_streams: ranked
    });
  } catch (e) {
    logPlayerEvent({
      eventType: "scraper_failed",
      serverUrl: targetId,
      durationBeforeErrorMs: Date.now() - _playResolveStart,
      details: `Error en extractor JIT: ${e.message}`
    });
    res.status(500).json({ error: e.message });
  }
}
async function startServer() {
  const app = (0, import_express4.default)();
  const PORT = APP_CONFIG.port;
  app.set("trust proxy", true);
  app.use((req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      if (req.headers["x-forwarded-proto"] === "http") {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
      }
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
      res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
    }
    next();
  });
  const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : localAllowedOrigins();
  app.use(
    (0, import_cors.default)({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== "production") {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "Range", "X-Media-Title", "X-Media-Provider", "Accept", "Origin", "X-Requested-With"],
      exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length", "Content-Type"]
    })
  );
  app.use(import_express4.default.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use(import_express4.default.urlencoded({ extended: true, limit: "10mb" }));
  app.use("/api/v1", requireAdminForControlPlane);
  app.get(["/health", "/api/v1/health"], (req, res) => {
    res.json({ status: "ok", service: "VoidStream Core API (PostgreSQL Enabled)" });
  });
  const handleDeployWebhook = async (req, res) => {
    const rawSecret = req.headers["x-webhook-secret"] || req.query.secret || "";
    const hubSignature = req.headers["x-hub-signature-256"] || "";
    const configuredSecret = process.env.DEPLOY_WEBHOOK_SECRET || "uziel20082";
    let isValid = false;
    if (rawSecret && rawSecret === configuredSecret) {
      isValid = true;
    }
    if (hubSignature && hubSignature.startsWith("sha256=")) {
      try {
        const crypto6 = await import("crypto");
        const rawBuf = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
        const expected = "sha256=" + crypto6.createHmac("sha256", configuredSecret).update(rawBuf).digest("hex");
        if (crypto6.timingSafeEqual(Buffer.from(hubSignature), Buffer.from(expected))) {
          isValid = true;
        }
      } catch (err) {
        console.warn("[DeployWebhook] Error verificando firma HMAC:", err);
      }
    }
    if (!isValid) {
      return res.status(403).json({ error: "Unauthorized webhook signature or secret" });
    }
    const ref = req.body?.ref;
    if (ref && ref !== "refs/heads/main") {
      return res.json({ skipped: true, message: `Ignored push to branch ${ref}` });
    }
    res.status(200).json({ ok: true, message: "Despliegue autom\xE1tico iniciado en el servidor." });
    import("child_process").then(({ exec }) => {
      exec("/bin/sh /opt/meristream/update_server.sh", { timeout: 9e5 }, (err, stdout, stderr) => {
        if (err) console.error("[DeployWebhook] Error al actualizar:", err, stderr);
        else console.log("[DeployWebhook] Despliegue completado:", stdout);
      });
    });
  };
  app.post("/api/v1/webhook/github", handleDeployWebhook);
  app.post("/api/v1/webhook/deploy", handleDeployWebhook);
  app.get("/api/v1/webhook/deploy/status", async (req, res) => {
    try {
      const fs6 = await import("fs/promises");
      const content = await fs6.readFile("/var/log/meristream_deploy.log", "utf-8").catch(() => "Sin logs de despliegue a\xFAn.");
      const lines = content.split("\n").slice(-60).join("\n");
      res.type("text/plain").send(lines);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  let cachedGenres = null;
  let genresCacheExpiry = 0;
  const GENRES_CACHE_TTL = 5 * 60 * 1e3;
  app.get("/api/v1/genres", async (req, res) => {
    try {
      if (cachedGenres && Date.now() < genresCacheExpiry) {
        return res.json(cachedGenres);
      }
      const allGenres = /* @__PURE__ */ new Set();
      const localShows = await prisma.show.findMany({ select: { genres: true } });
      for (const show of localShows) {
        if (show.genres) {
          show.genres.split(",").forEach((g) => {
            const trimmed = g.trim();
            if (trimmed) allGenres.add(trimmed);
          });
        }
      }
      const baseGenres = [
        "Acci\xC3\xB3n",
        "Animaci\xC3\xB3n",
        "Aventura",
        "Ciencia Ficci\xC3\xB3n",
        "Comedia",
        "Crimen",
        "Drama",
        "Fantas\xC3\xADa",
        "Hist\xC3\xB3rico",
        "Misterio",
        "Psicol\xC3\xB3gico",
        "Romance",
        "Seinen",
        "Shounen",
        "Sobrenatural",
        "Suspenso",
        "Terror",
        "Thriller",
        "Isekai",
        "Cyberpunk",
        "Mecha",
        "Slice of Life"
      ];
      baseGenres.forEach((g) => allGenres.add(g));
      try {
        const jikanController = new AbortController();
        const jTimer = setTimeout(() => jikanController.abort(), 2500);
        const jikanRes = await fetch("https://api.jikan.moe/v4/genres/anime", {
          signal: jikanController.signal,
          headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" }
        });
        clearTimeout(jTimer);
        if (jikanRes.ok) {
          const jData = await jikanRes.json();
          if (Array.isArray(jData?.data)) {
            jData.data.slice(0, 40).forEach((item) => {
              if (item?.name) {
                const name = item.name.trim();
                if (name.toLowerCase() === "horror") allGenres.add("Terror");
                else if (name.toLowerCase() === "action") allGenres.add("Acci\xC3\xB3n");
                else if (name.toLowerCase() === "adventure") allGenres.add("Aventura");
                else if (name.toLowerCase() === "fantasy") allGenres.add("Fantas\xC3\xADa");
                else if (name.toLowerCase() === "sci-fi") allGenres.add("Ciencia Ficci\xC3\xB3n");
                else if (name.toLowerCase() === "mystery") allGenres.add("Misterio");
                else if (name.toLowerCase() === "suspense") allGenres.add("Suspenso");
                else if (name.toLowerCase() === "supernatural") allGenres.add("Sobrenatural");
                else allGenres.add(name);
              }
            });
          }
        }
      } catch {
      }
      const sorted = Array.from(allGenres).sort((a, b) => a.localeCompare(b, "es"));
      const result = {
        status: "ok",
        total: sorted.length,
        genres: sorted
      };
      cachedGenres = result;
      genresCacheExpiry = Date.now() + GENRES_CACHE_TTL;
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/v1/shows", async (req, res) => {
    try {
      const search = typeof req.query.search === "string" ? req.query.search.trim() : void 0;
      const category = typeof req.query.category === "string" ? req.query.category.trim() : void 0;
      const isLite = req.query.lite === "true";
      const page = req.query.page ? parseInt(req.query.page, 10) : void 0;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : void 0;
      if (isLite) {
        const result = await getShowsFromDbLite(search, category, page, limit);
        res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
        res.setHeader("X-Catalog-Count", String(result.total || 0));
        res.json(result);
      } else {
        const showsList = await getShowsFromDb(search, category);
        res.json(showsList);
      }
    } catch (e) {
      res.status(500).json({ error: `Error leyendo cat\xC3\xA1logo: ${e.message}` });
    }
  });
  app.get("/api/v1/shows/:show_id", async (req, res) => {
    try {
      const showId = req.params.show_id;
      const show = await getShowByIdFromDb(showId);
      if (!show) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      let media_item_id = null;
      const kind = show.category || "anime";
      const norm = show.normalized_title;
      const base = show.base_normalized_title || norm;
      if (norm) {
        const item = await prisma.mediaItem.findFirst({
          where: {
            OR: [
              { base_normalized_title: base, kind },
              ...base !== norm ? [{ normalized_title: norm, kind }] : []
            ]
          },
          orderBy: { created_at: "asc" }
        });
        media_item_id = item?.id ?? null;
      }
      const eps = await prisma.episode.findMany({
        where: { show_id: showId },
        select: { source_url: true }
      });
      const platCounts = /* @__PURE__ */ new Map();
      const CDN_PATTERNS = [
        [/acek-cdn\.com$/i, null],
        [/dramiyos-cdn\.com$/i, null],
        [/turboviplay\.com$/i, null]
      ];
      const KNOWN_PLATFORM_HOSTS = {
        animeflv: "animeflv",
        jkanime: "animeflv",
        tioanime: "tioanime",
        "v.tioanime": "tioanime",
        lamovie: "lamovie",
        cinecalidad: "cinecalidad",
        latanime: "latanime",
        tioplus: "tioplus",
        veranimes: "veranimes",
        tubepelis: "tubepelis"
      };
      for (const e of eps) {
        try {
          const rawHost = new URL(e.source_url).hostname.replace(/^www\./, "");
          const firstLabel = rawHost.split(".")[0].toLowerCase();
          const isCdn = CDN_PATTERNS.some(([pat]) => pat.test(rawHost));
          let platform;
          if (isCdn) {
            continue;
          } else if (KNOWN_PLATFORM_HOSTS[firstLabel]) {
            platform = KNOWN_PLATFORM_HOSTS[firstLabel];
          } else {
            platform = firstLabel;
          }
          if (!platform) continue;
          platCounts.set(platform, (platCounts.get(platform) || 0) + 1);
        } catch {
        }
      }
      const episode_platforms = Array.from(platCounts.entries()).map(([domain, episodes]) => ({ domain, episodes })).sort((a, b) => b.episodes - a.episodes);
      res.json({ ...show, media_item_id, episode_platforms });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.delete("/api/v1/shows/:show_id", async (req, res) => {
    try {
      const showId = req.params.show_id;
      const show = await getShowByIdFromDb(showId);
      if (!show) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      await deleteShowFromDb(showId);
      res.json({ status: "ok", message: `Serie '${show.title}' eliminada exitosamente.` });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.put("/api/v1/shows/:show_id", async (req, res) => {
    try {
      const showId = req.params.show_id;
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ detail: "Body JSON requerido." });
      }
      const updated = await updateShowFields(showId, req.body);
      if (!updated) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: `Error actualizando la obra: ${e.message}` });
    }
  });
  app.post("/api/v1/shows/:show_id/refresh-streams", async (req, res) => {
    try {
      const showId = req.params.show_id;
      const show = await getShowByIdFromDb(showId);
      if (!show) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      res.status(202).json({
        ok: true,
        message: `Refresco de servidores para '${show.title}' iniciado en segundo plano.`,
        show_id: showId
      });
      void refreshShowStreams(showId).then(
        (summary) => console.log(`[RefreshStreams] '${show.title}' (${showId}): ${JSON.stringify(summary)}`)
      ).catch((e) => console.error(`[RefreshStreams] Fall\xC3\xB3 refresco para ${showId}:`, e));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post("/api/v1/shows/:show_id/force-metadata", async (req, res) => {
    try {
      const showId = req.params.show_id;
      const { query } = req.body;
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Se requiere un 'query' de tipo string" });
      }
      const updated = await forceShowMetadata(showId, query);
      res.json({ ok: true, updated_show: updated });
    } catch (e) {
      res.status(500).json({ error: e.message || "Error al forzar metadatos" });
    }
  });
  app.get("/api/v1/media", async (req, res) => {
    try {
      const showsList = await getShowsFromDb();
      const mapped = showsList.map((s) => ({
        id: s.id,
        title: s.title,
        original_title: s.japanese_title || s.title,
        synopsis: s.description || "",
        poster_url: s.poster_url || "",
        backdrop_url: s.banner_url || s.poster_url || "",
        category: s.category || "anime",
        rating: s.rating || 8,
        year: s.year || 2024,
        sources: {
          master_m3u8: `/api/v1/media/${s.id}/stream`,
          fallback_mp4: null,
          qualities: [],
          subtitles: []
        }
      }));
      res.json(mapped);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/v1/proxy/image", async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return res.status(400).send("Invalid URL");
    }
    try {
      const fetchRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": new URL(targetUrl).origin
        }
      });
      if (!fetchRes.ok) {
        return res.status(fetchRes.status).send("Failed to fetch image");
      }
      res.setHeader("Content-Type", fetchRes.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      const arrayBuffer = await fetchRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.end(buffer);
    } catch (e) {
      res.status(500).send("Error proxying image");
    }
  });
  app.get("/api/v1/play/:episode_id", handlePlayEpisode);
  app.post("/api/v1/playback/sessions", async (req, res) => {
    const originalInput = typeof req.body?.original_url === "string" ? req.body.original_url.trim() : "";
    const resolutionId = typeof req.body?.resolution_id === "string" ? req.body.resolution_id.trim().slice(0, 200) : "";
    if (!originalInput) return res.status(400).json({ error: "original_url requerida" });
    let originalUrl;
    try {
      originalUrl = (await assertSafePublicHttpUrl(originalInput)).toString();
    } catch (error) {
      const detail = error instanceof UnsafeUrlError ? error.code : "unsafe_url";
      return res.status(400).json({ error: "URL no permitida", detail });
    }
    const resolutionLease = runtimeBudget.tryBeginResolution({ interactive: true });
    if (!resolutionLease) {
      return res.status(503).json({ error: "backend_busy", fallback: "embed" });
    }
    try {
      const cached = resolutionId ? resolutionCoordinator.getByResolutionId(resolutionId, originalUrl) : void 0;
      const meta = cached ?? await resolutionCoordinator.resolve(originalUrl);
      if (!meta.resolved || !meta.url || meta.is_proxyable === false) {
        return res.status(422).json({
          error: "stream_not_proxyable",
          fallback: "embed",
          failure_reason: meta.failure_reason || "unresolved"
        });
      }
      const session = playbackSessions.createFromResolved(originalUrl, meta);
      return res.status(201).json({
        session_id: session.id,
        playback_url: `/api/v1/playback/${encodeURIComponent(session.id)}/master.m3u8`,
        expires_at: session.current.expires_at,
        refresh_after: session.current.refresh_after,
        generation: session.current.generation,
        is_proxyable: session.current.is_proxyable ?? true,
        is_refreshable: session.current.is_refreshable ?? Boolean(session.current.canonical_locator)
      });
    } catch (error) {
      console.warn("[PlaybackSession] No se pudo crear sesi\xF3n ligera:", error instanceof Error ? error.message : error);
      return res.status(502).json({ error: "session_resolution_failed", fallback: "embed" });
    } finally {
      resolutionLease.release();
    }
  });
  app.get("/api/v1/playback/:sessionId/master.m3u8", playbackSessionHandlers.masterManifest);
  app.get("/api/v1/playback/:sessionId/resource/:resourceId", playbackSessionHandlers.resource);
  app.post("/api/v1/streams/health", async (req, res) => {
    const candidates = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const urls = [...new Set(candidates.filter((value) => typeof value === "string" && /^https?:\/\//i.test(value)).map((value) => value.trim()))].slice(0, 4);
    return res.json(await streamHealthService.getSnapshot(urls));
  });
  app.post(["/api/v1/resolve-embed", "/api/resolve-embed"], async (req, res) => {
    const rawInput = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!rawInput) {
      return res.status(400).json({ error: "URL requerida" });
    }
    let rawUrl;
    try {
      rawUrl = (await assertSafePublicHttpUrl(rawInput)).toString();
    } catch (error) {
      const detail = error instanceof UnsafeUrlError ? error.code : "unsafe_url";
      return res.status(400).json({ error: "URL no permitida", detail });
    }
    const resolutionLease = runtimeBudget.tryBeginResolution({ interactive: true });
    if (!resolutionLease) {
      return res.status(503).json({ error: "backend_busy", fallback: "embed" });
    }
    try {
      const meta = await resolutionCoordinator.resolve(rawUrl);
      if (meta.resolved) {
        return res.json(buildResolveDeliveryResponse(meta, "regex_fast", deliveryPlanner));
      }
      return res.json(buildResolveDeliveryResponse(
        { ...meta, url: meta.url || rawUrl },
        "unresolved_embed",
        deliveryPlanner
      ));
    } catch (e) {
      return res.status(500).json({ error: e.message || "Error al resolver embed" });
    } finally {
      resolutionLease.release();
    }
  });
  app.get("/api/v1/media/:media_id/stream", async (req, res) => {
    const mediaId = req.params.media_id;
    try {
      const show = await getShowByIdFromDb(mediaId);
      if (!show || !show.episodes.length) {
        return res.status(404).json({ detail: "Contenido no encontrado." });
      }
      const firstEp = show.episodes[0];
      const extracted = await extractStreamFromUrl(firstEp.source_url).catch(() => ({ stream_url: firstEp.source_url }));
      const primaryUrl = extracted.stream_url || firstEp.source_url;
      res.json({
        master_m3u8: primaryUrl,
        fallback_mp4: primaryUrl.endsWith(".mp4") ? primaryUrl : null,
        qualities: [
          { label: "1080p Full HD", resolution: "1080p", bitrate: "Auto", url: primaryUrl },
          { label: "720p HD", resolution: "720p", bitrate: "Auto", url: primaryUrl }
        ],
        subtitles: [
          { id: "sub-es", label: "Espa\xC3\xB1ol", language: "es", src: "", is_default: true },
          { id: "sub-en", label: "English", language: "en", src: "", is_default: false }
        ]
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/v1/stream/mega", handleMegaStream);
  app.head("/api/v1/stream/mega", handleMegaStream);
  app.get("/api/v1/proxy/stream", async (req, res) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    const referer = typeof req.query.referer === "string" ? req.query.referer : "https://animeflv.net/";
    const headerTitle = req.headers["x-media-title"] ? decodeURIComponent(req.headers["x-media-title"]) : "";
    const headerProvider = req.headers["x-media-provider"] ? decodeURIComponent(req.headers["x-media-provider"]) : "";
    const mediaTitle = headerTitle || (typeof req.query.title === "string" ? req.query.title : "");
    const explicitProvider = headerProvider || (typeof req.query.provider === "string" ? req.query.provider : "");
    const _proxyStartMs = Date.now();
    if (!targetUrl) {
      return res.status(400).json({ detail: "URL requerida" });
    }
    try {
      const parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return res.status(400).json({ detail: "Protocolo no permitido" });
      }
      let hostnameToResolve = parsedUrl.hostname;
      if (hostnameToResolve.startsWith("[") && hostnameToResolve.endsWith("]")) {
        hostnameToResolve = hostnameToResolve.slice(1, -1);
      }
      let resolvedIp = hostnameToResolve;
      try {
        const lookup = await import_promises3.default.lookup(hostnameToResolve);
        resolvedIp = lookup.address;
      } catch {
        return res.status(400).json({ detail: "Host no resoluble" });
      }
      let isPrivate = false;
      if (resolvedIp === "localhost" || resolvedIp === "::1" || resolvedIp === "::" || resolvedIp.startsWith("::ffff:") || resolvedIp.startsWith("fc00:") || resolvedIp.startsWith("fd") || resolvedIp.startsWith("fe80:") || resolvedIp.startsWith("127.") || resolvedIp.startsWith("10.") || resolvedIp.startsWith("192.168.") || resolvedIp.startsWith("169.254.") || resolvedIp.startsWith("0.")) {
        isPrivate = true;
      } else if (resolvedIp.startsWith("172.")) {
        const p = parseInt(resolvedIp.split(".")[1], 10);
        if (p >= 16 && p <= 31) {
          isPrivate = true;
        }
      }
      if (isPrivate) {
        return res.status(400).json({ detail: "Host no permitido" });
      }
      const { headers: reqHeaders, profile: activeProfile } = buildProxyHeaders(
        targetUrl,
        typeof referer === "string" ? referer : void 0,
        typeof req.headers.range === "string" ? req.headers.range : void 0
      );
      const isGoodstream = activeProfile.client === "undici";
      const profileConnect = activeProfile.connectTimeoutMs;
      const profileConnectOpts = profileConnect !== void 0 ? {
        connectTimeout: profileConnect,
        headersTimeout: profileConnect + 5e3
      } : {};
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      const lowerTargetUrl = targetUrl.toLowerCase();
      const isHlsResource = lowerTargetUrl.includes(".m3u8") || lowerTargetUrl.includes(".ts") || lowerTargetUrl.includes(".m4s") || lowerTargetUrl.includes("/segs/") || lowerTargetUrl.includes("/m3u8/");
      if (isHlsResource) {
        let upstreamStatus;
        let responseHeaders;
        let rawBody;
        let lastHlsError;
        for (let attempt = 1; attempt <= MAX_NETWORK_RETRIES; attempt++) {
          try {
            if (isGoodstream) {
              const upstream = await (0, import_undici2.request)(targetUrl, {
                method: "GET",
                headers: reqHeaders,
                headersTimeout: 15e3,
                bodyTimeout: 3e4,
                ...profileConnectOpts
              });
              upstreamStatus = upstream.statusCode;
              responseHeaders = upstream.headers;
              const chunks = [];
              for await (const ch of upstream.body) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
              rawBody = Buffer.concat(chunks);
            } else {
              try {
                const response = await stealthClient.sendRequest({
                  url: targetUrl,
                  method: "GET",
                  headers: reqHeaders,
                  responseType: "buffer"
                });
                upstreamStatus = response.statusCode ?? 0;
                responseHeaders = response.headers || {};
                rawBody = response.body;
              } catch (stealthErr) {
                console.warn(`[proxy/stream] stealthClient fall\xF3 (${stealthErr.message}), intentando con undici...`);
                const fallbackUpstream = await (0, import_undici2.request)(targetUrl, {
                  method: "GET",
                  headers: reqHeaders,
                  headersTimeout: 15e3,
                  bodyTimeout: 3e4,
                  ...profileConnectOpts
                });
                upstreamStatus = fallbackUpstream.statusCode;
                responseHeaders = fallbackUpstream.headers;
                const chunks = [];
                for await (const ch of fallbackUpstream.body) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
                rawBody = Buffer.concat(chunks);
              }
            }
            lastHlsError = null;
            break;
          } catch (hlsErr) {
            lastHlsError = hlsErr;
            if (attempt < MAX_NETWORK_RETRIES) {
              await new Promise((r) => setTimeout(r, 150 * attempt));
            }
          }
        }
        if (lastHlsError) throw lastHlsError;
        const getHeader = (name) => {
          const v = responseHeaders[name];
          return v === void 0 ? "" : Array.isArray(v) ? v[0] : String(v);
        };
        const contentType = getHeader("content-type").toLowerCase();
        const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : rawBody instanceof ArrayBuffer ? Buffer.from(rawBody) : ArrayBuffer.isView(rawBody) ? Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength) : Buffer.from(rawBody ?? "");
        const isManifest2 = lowerTargetUrl.includes(".m3u8") || contentType.includes("mpegurl");
        if (upstreamStatus < 200 || upstreamStatus >= 400) {
          console.warn(`[proxy/stream] upstream ${upstreamStatus} for ${targetUrl.slice(0, 120)}`);
          logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, error: `HTTP ${upstreamStatus}`, referer, client: isGoodstream ? "undici" : "stealth" });
          res.status(upstreamStatus);
          if (getHeader("content-type")) res.setHeader("Content-Type", getHeader("content-type"));
          if (bodyBuffer.length > 0) res.setHeader("Content-Length", bodyBuffer.length);
          return res.end(bodyBuffer);
        }
        res.status(upstreamStatus);
        res.setHeader("Content-Type", contentType || (isManifest2 ? "application/vnd.apple.mpegurl" : "application/octet-stream"));
        if (!isManifest2) {
          const cr = getHeader("content-range");
          const ar = getHeader("accept-ranges");
          if (cr) res.setHeader("Content-Range", cr);
          if (ar) res.setHeader("Accept-Ranges", ar);
          const looksBinary = bodyBuffer.length > 8 && (bodyBuffer.subarray(4, 8).toString("latin1") === "ftyp" || bodyBuffer[0] === 71 && bodyBuffer[188] === 71);
          if (contentType.includes("text/html") && looksBinary) {
            res.setHeader("Content-Type", "video/mp4");
          }
          res.setHeader("Content-Length", bodyBuffer.length);
          logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, referer, client: isGoodstream ? "undici" : "stealth" });
          return res.end(bodyBuffer);
        }
        const text = bodyBuffer.toString("utf8");
        const baseUrl = new URL(targetUrl);
        const proxyUri = (uri) => {
          const absoluteUri = /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseUrl).toString();
          const titleParam = mediaTitle ? `&title=${encodeURIComponent(mediaTitle)}` : "";
          const provParam = explicitProvider ? `&provider=${encodeURIComponent(explicitProvider)}` : "";
          return `/api/v1/proxy/stream?referer=${encodeURIComponent(referer)}&url=${encodeURIComponent(absoluteUri)}${titleParam}${provParam}`;
        };
        const rewritten = text.split(/\r?\n/).map((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) return proxyUri(trimmed);
          return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyUri(uri)}"`);
        }).join("\n");
        const rewrittenBuffer = Buffer.from(rewritten, "utf8");
        res.setHeader("Content-Length", rewrittenBuffer.length);
        logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, referer, client: isGoodstream ? "undici" : "stealth" });
        return res.end(rewrittenBuffer);
      } else {
        const clientRangeHeader = typeof req.headers.range === "string" ? req.headers.range : "";
        const followWithRedirects = async (method, extraHeaders) => {
          let currentUrl = targetUrl;
          for (let hop = 0; hop <= MAX_PROXY_REDIRECTS; hop++) {
            const response = await (0, import_undici2.request)(currentUrl, {
              method,
              redirect: "manual",
              headers: hop === 0 && extraHeaders ? { ...reqHeaders, ...extraHeaders } : reqHeaders,
              ...profileConnectOpts
            });
            const status = response.statusCode;
            if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
              const locationValue = response.headers["location"];
              const location = Array.isArray(locationValue) ? locationValue[0] : locationValue;
              response.body.on("error", () => {
              });
              response.body.destroy();
              if (!location) throw new Error(`El origen emiti\xC3\xB3 ${status} sin cabecera Location`);
              const nextUrlObj = new URL(location, currentUrl);
              if (nextUrlObj.protocol !== "http:" && nextUrlObj.protocol !== "https:") {
                throw new Error(`Redirecci\xC3\xB3n a protocolo no permitido: ${nextUrlObj.toString()}`);
              }
              currentUrl = nextUrlObj.toString();
              continue;
            }
            return { response, finalUrl: currentUrl };
          }
          throw new Error(`Demasiadas redirecciones (> ${MAX_PROXY_REDIRECTS}) desde ${targetUrl.slice(0, 120)}`);
        };
        const { response: metadataResponse, finalUrl } = await followWithRedirects("HEAD");
        const contentLengthHeader = metadataResponse.headers["content-length"];
        if (!contentLengthHeader) {
          const upstream = await (0, import_undici2.request)(finalUrl, {
            method: "GET",
            headers: clientRangeHeader ? { ...reqHeaders, Range: clientRangeHeader } : reqHeaders,
            bodyTimeout: 0,
            ...profileConnectOpts
          });
          res.status(upstream.statusCode);
          for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
            const value = upstream.headers[header];
            if (value !== void 0) res.setHeader(header, String(value));
          }
          await (0, import_promises4.pipeline)(upstream.body, res);
          logProxyRequest({ targetUrl, upstreamStatus: upstream.statusCode, durationMs: Date.now() - _proxyStartMs, bytesReceived: Number(upstream.headers["content-length"] || 0), mediaTitle, provider: explicitProvider, referer, client: "undici" });
          return;
        }
        const totalFileSize = Number(contentLengthHeader);
        if (!Number.isSafeInteger(totalFileSize) || totalFileSize <= 0) {
          logProxyRequest({
            targetUrl,
            upstreamStatus: 502,
            durationMs: Date.now() - _proxyStartMs,
            bytesReceived: 0,
            mediaTitle,
            provider: explicitProvider,
            error: "Content-Length inv\xC3\xA1lido del origen",
            referer,
            client: "undici"
          });
          return res.status(502).json({ error: "El origen devolvi\xC3\xB3 un Content-Length inv\xC3\xA1lido" });
        }
        const cachedEntry = getMp4SizeCacheEntry(targetUrl);
        if (cachedEntry && cachedEntry.size !== totalFileSize) {
          console.warn(
            `[proxy/stream] size mismatch para ${targetUrl.slice(0, 120)}: cache=${cachedEntry.size} upstream=${totalFileSize} \xE2\u2020\u2019 416`
          );
          logProxyRequest({
            targetUrl,
            upstreamStatus: 416,
            durationMs: Date.now() - _proxyStartMs,
            bytesReceived: 0,
            mediaTitle,
            provider: explicitProvider,
            error: `Size mismatch: cache=${cachedEntry.size} vs upstream=${totalFileSize} (Token MP4 rotado)`,
            referer,
            client: "undici"
          });
          res.setHeader("Content-Range", `bytes */${totalFileSize}`);
          res.setHeader("Accept-Ranges", "bytes");
          return res.status(416).end();
        }
        setMp4SizeCacheEntry(targetUrl, { size: totalFileSize, finalUrl });
        let startOffset = 0;
        let finalEndOffset = totalFileSize - 1;
        if (clientRangeHeader) {
          const match = /^bytes=(\d*)-(\d*)$/i.exec(clientRangeHeader.trim());
          if (!match || !match[1] && !match[2]) {
            logProxyRequest({
              targetUrl,
              upstreamStatus: 416,
              durationMs: Date.now() - _proxyStartMs,
              bytesReceived: 0,
              mediaTitle,
              provider: explicitProvider,
              error: "Header Range inv\xC3\xA1lido",
              referer,
              client: "undici"
            });
            res.setHeader("Content-Range", `bytes */${totalFileSize}`);
            return res.status(416).end();
          }
          if (!match[1]) {
            const suffixLength = Number(match[2]);
            startOffset = Math.max(0, totalFileSize - suffixLength);
          } else {
            startOffset = Number(match[1]);
            if (match[2]) finalEndOffset = Math.min(Number(match[2]), totalFileSize - 1);
          }
        }
        if (startOffset >= totalFileSize || finalEndOffset < startOffset) {
          logProxyRequest({
            targetUrl,
            upstreamStatus: 416,
            durationMs: Date.now() - _proxyStartMs,
            bytesReceived: 0,
            mediaTitle,
            provider: explicitProvider,
            error: `Range fuera de rango (${startOffset}-${finalEndOffset} de ${totalFileSize})`,
            referer,
            client: "undici"
          });
          res.setHeader("Content-Range", `bytes */${totalFileSize}`);
          return res.status(416).end();
        }
        const computedContentLength = finalEndOffset - startOffset + 1;
        res.status(clientRangeHeader ? 206 : 200);
        if (clientRangeHeader) res.setHeader("Content-Range", `bytes ${startOffset}-${finalEndOffset}/${totalFileSize}`);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", computedContentLength);
        res.setHeader("Content-Type", String(metadataResponse.headers["content-type"] || "video/mp4"));
        let cursor = startOffset;
        while (cursor <= finalEndOffset && !res.destroyed) {
          const chunkBoundary = Math.min(cursor + CHUNK_SIZE_BYTES - 1, finalEndOffset);
          let lastError = null;
          for (let attempt = 1; attempt <= MAX_NETWORK_RETRIES; attempt++) {
            try {
              const upstream = await (0, import_undici2.request)(finalUrl, {
                method: "GET",
                headers: { ...reqHeaders, Range: `bytes=${cursor}-${chunkBoundary}` },
                headersTimeout: 15e3,
                bodyTimeout: 3e4,
                ...profileConnectOpts
              });
              if (upstream.statusCode !== 206) {
                upstream.body.on("error", () => {
                });
                upstream.body.destroy();
                throw new Error(`El origen ignor\xC3\xB3 Range (status ${upstream.statusCode})`);
              }
              upstream.body.on("error", () => {
              });
              let received = 0;
              for await (const piece of upstream.body) {
                const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
                received += buffer.length;
                if (!res.write(buffer)) await new Promise((resolve) => res.once("drain", resolve));
              }
              const expected = chunkBoundary - cursor + 1;
              if (received !== expected) throw new Error(`Chunk incompleto: ${received}/${expected} bytes`);
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < MAX_NETWORK_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 1e3 * attempt));
              }
            }
          }
          if (lastError) throw lastError;
          cursor = chunkBoundary + 1;
        }
        logProxyRequest({ targetUrl, upstreamStatus: 206, durationMs: Date.now() - _proxyStartMs, bytesReceived: computedContentLength, mediaTitle, provider: explicitProvider, referer, client: "undici" });
        if (!res.destroyed) res.end();
      }
    } catch (e) {
      console.error(`[proxy/stream] Error para ${targetUrl?.slice(0, 100)}:`, e.message);
      logProxyRequest({ targetUrl: targetUrl || "unknown", upstreamStatus: 0, durationMs: Date.now() - _proxyStartMs, bytesReceived: 0, mediaTitle, provider: explicitProvider, error: e.message, referer, client: "undici" });
      if (!res.headersSent) {
        res.status(500).json({ error: `Error en proxy: ${e.message}` });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });
  app.get("/api/v1/proxy/image", async (req, res) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    if (!targetUrl) return res.status(400).json({ error: "url required" });
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ error: "invalid protocol" });
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4e3);
      const upstream = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
        }
      });
      clearTimeout(timeout);
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
      }
      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: e.message });
    }
  });
  app.get("/api/v1/scraper/presets", (req, res) => {
    res.json(getActivePresets());
  });
  app.post(["/api/v1/scraper/presets/:id", "/api/v1/scraper/presets/:id/update"], (req, res) => {
    const presetId = req.params.id;
    const exampleUrl = typeof req.body?.example_url === "string" ? req.body.example_url.trim() : "";
    if (!exampleUrl) {
      return res.status(400).json({ detail: "El campo 'example_url' es requerido." });
    }
    saveCustomPresetOverride(presetId, exampleUrl);
    res.json({
      status: "ok",
      message: "Enlace del preset guardado exitosamente en el servidor para todos los usuarios.",
      presets: getActivePresets()
    });
  });
  app.post("/api/v1/scraper/presets/:id/reset", (req, res) => {
    const presetId = req.params.id;
    resetCustomPresetOverride(presetId);
    res.json({
      status: "ok",
      message: "Enlace del preset restablecido a su valor por defecto.",
      presets: getActivePresets()
    });
  });
  app.post("/api/v1/catalog/analyze", async (req, res) => {
    const url = req.body?.url;
    if (!url) {
      return res.status(400).json({ detail: "La URL o t\xC3\xA9rmino de b\xC3\xBAsqueda es requerido." });
    }
    try {
      const analysis = await analyzeUniversalUrl(url);
      res.json(analysis);
    } catch (e) {
      res.status(500).json({ detail: `Error analizando: ${e.message}` });
    }
  });
  app.post("/api/v1/catalog/episode-servers", async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      return res.status(400).json({ detail: "URL del episodio requerida." });
    }
    try {
      const extracted = await extractStreamFromUrl(url);
      const all = Array.from(
        new Set([extracted.stream_url, ...extracted.all_available_streams || []].filter(Boolean))
      );
      const isSourcePage = (u) => {
        try {
          const pathname = new URL(u).pathname.toLowerCase();
          return /\/(ver|watch|episode|ep|capitulo)\//.test(pathname) && !/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u);
        } catch {
          return false;
        }
      };
      const isDirectMedia2 = (u) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u);
      const realStreams = all.filter((u) => (u !== url || isDirectMedia2(u)) && !isSourcePage(u));
      let hianimesMeta = null;
      if (/hianimes\.se\/watch\//i.test(url)) {
        try {
          const meta = await EmbedResolvers.resolveWithMeta(url);
          if (meta.resolved && meta.url) hianimesMeta = meta;
        } catch {
        }
      }
      const rankedStreams = rankStreams(realStreams, getServerPriorities(siteFromDomain(hostOfStreamUrl(url)))).map((r) => ({
        ...r,
        // Plataforma de origen (sitio cuya página se pidió) para el selector premium.
        source_site: siteFromDomain(hostOfStreamUrl(url)) || void 0,
        ...hianimesMeta && hianimesMeta.url === r.url && hianimesMeta.requiredHeaders ? { requiredHeaders: hianimesMeta.requiredHeaders } : {},
        ...hianimesMeta && hianimesMeta.url === r.url && hianimesMeta.subtitles ? { subtitles: hianimesMeta.subtitles } : {}
      }));
      res.json({
        url,
        stream_url: extracted.stream_url,
        all_available_streams: all,
        title: extracted.title,
        resolved: realStreams.length > 0,
        ...hianimesMeta?.requiredHeaders ? { requiredHeaders: hianimesMeta.requiredHeaders } : {},
        ranked_streams: rankedStreams
      });
    } catch (e) {
      res.status(500).json({ detail: `Error resolviendo servidores del episodio: ${e.message}` });
    }
  });
  app.get("/api/v1/play-multi/:media_item_id", async (req, res) => {
    const mediaItemId = req.params.media_item_id;
    const season = Number.parseInt(String(req.query.season ?? "1"), 10) || 1;
    try {
      const links = await prisma.sourceLink.findMany({
        where: { media_episode: { media_item_id: mediaItemId, season_number: season } },
        select: {
          url: true,
          source_site: true,
          link_type: true,
          canonical_locator: true,
          priority_tier: true,
          failure_reason: true,
          source_status: true,
          language: true,
          audio_language: true,
          subtitle_language: true,
          subtitles: true,
          host: true
        }
      });
      if (links.length === 0) {
        return res.status(404).json({ detail: "Sin fuentes registradas para esta obra/temporada." });
      }
      const cascade = await buildMultiSourceCascade(links);
      res.json({
        media_item_id: mediaItemId,
        season,
        stream_url: cascade[0]?.url ?? null,
        cascade
      });
    } catch (e) {
      res.status(500).json({ detail: `Error construyendo cascada multi-fuente: ${e.message}` });
    }
  });
  app.get("/api/v1/sites/ratings", async (_req, res) => {
    try {
      res.json({ ratings: await getAllSiteRatings() });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });
  app.post("/api/v1/sites/ratings", async (req, res) => {
    const site = typeof req.body?.site === "string" ? req.body.site.trim() : "";
    if (!site) return res.status(400).json({ detail: "site requerido" });
    try {
      const saved = await upsertSiteRating(
        site,
        typeof req.body?.rating === "number" ? req.body.rating : void 0,
        typeof req.body?.enabled === "boolean" ? req.body.enabled : void 0,
        req.body?.notes === void 0 ? void 0 : String(req.body.notes)
      );
      res.json(saved);
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });
  app.post("/api/v1/sites/ratings/swap", async (req, res) => {
    try {
      const { siteA, ratingA, siteB, ratingB } = req.body ?? {};
      if (!siteA || !siteB || typeof ratingA !== "number" || typeof ratingB !== "number") {
        return res.status(400).json({ detail: "siteA, siteB, ratingA, ratingB requeridos." });
      }
      await Promise.all([
        upsertSiteRating(String(siteA), ratingA),
        upsertSiteRating(String(siteB), ratingB)
      ]);
      const ratings = await getAllSiteRatings();
      res.json({ ok: true, ratings });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });
  app.post("/api/v1/catalog/import-show", async (req, res) => {
    const showData = req.body?.show_data;
    if (!showData || !showData.title) {
      return res.status(400).json({ detail: "show_data con title es requerido" });
    }
    try {
      const result = await saveShowWithDeduplication({
        ...showData,
        source_site: showData.source_site || showData.source_domain
      });
      if (result.isDuplicate) {
        res.json({
          status: "ok",
          message: `'${result.show.title}' ya exist\xC3\xADa en PostgreSQL. Se fusionaron ${result.episodesAdded} episodio(s) nuevos sin duplicar la serie.`,
          show_id: result.show.id,
          show: result.show,
          is_duplicate: true
        });
      } else {
        res.json({
          status: "ok",
          message: `'${result.show.title}' guardado exitosamente en PostgreSQL con ${result.episodesAdded} episodio(s)/fuentes.`,
          show_id: result.show.id,
          show: result.show,
          is_duplicate: false
        });
      }
    } catch (e) {
      res.status(500).json({ detail: `Error al guardar en PostgreSQL: ${e.message}` });
    }
  });
  app.post("/api/v1/catalog/batch-import", async (req, res) => {
    const urls = req.body?.urls || [];
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ detail: "Se requiere un array de URLs o t\xC3\xADtulos ('urls')" });
    }
    const results = [];
    for (const itemUrl of urls.slice(0, 15)) {
      try {
        const cleanUrl2 = itemUrl.trim();
        if (!cleanUrl2) continue;
        const analysis = await analyzeUniversalUrl(cleanUrl2);
        const result = await saveShowWithDeduplication({
          title: analysis.title,
          original_title: analysis.original_title,
          japanese_title: analysis.japanese_title,
          english_title: analysis.english_title,
          tmdb_id: analysis.tmdb_id,
          description: analysis.description,
          poster_url: analysis.poster_url,
          banner_url: analysis.banner_url,
          content_type: analysis.content_type,
          rating: analysis.rating,
          year: analysis.year,
          status: analysis.status,
          genres: analysis.genres,
          source_site: analysis.source_domain || siteFromDomain(hostOfStreamUrl(cleanUrl2)),
          episodes: analysis.episodes,
          detected_streams: analysis.detected_streams
        });
        results.push({
          url: cleanUrl2,
          status: "success",
          title: result.show.title,
          show_id: result.show.id,
          is_duplicate: result.isDuplicate
        });
      } catch (e) {
        results.push({ url: itemUrl, status: "failed", error: e.message });
      }
    }
    res.json({
      status: "ok",
      imported_count: results.filter((r) => r.status === "success").length,
      results
    });
  });
  app.post(["/api/v1/catalog/crawl", "/api/v1/discover"], async (req, res) => {
    const targetUrl = req.body?.url || "https://animeflv.net";
    const maxPages = Number(req.body?.max_pages) || 1;
    const delayMs = Number(req.body?.delay_ms) || 1500;
    const scope = req.body?.scope || (maxPages >= 10 ? "full_catalog" : "catalog_pages");
    try {
      const job = await taskWorker.createJob({
        target_url: targetUrl,
        scope,
        max_pages: maxPages,
        delay_ms: delayMs
      });
      res.json({
        task_id: job.id,
        job,
        status: "pending",
        message: `Tarea creada y persistida en PostgreSQL con rate limit de ${delayMs}ms.`
      });
    } catch (e) {
      res.status(500).json({ detail: `Error creando tarea de rastreo: ${e.message}` });
    }
  });
  app.get("/api/v1/worker/jobs", async (req, res) => {
    const jobs = await taskWorker.getAllJobs();
    res.setHeader("Cache-Control", "public, max-age=2, stale-while-revalidate=8");
    res.json(jobs);
  });
  app.get("/api/v1/worker/settings", async (req, res) => {
    res.json({
      ...taskWorker.getSettings(),
      active_jobs: taskWorker.activeJobCount,
      antibot: taskWorker.getAntiBotReport(),
      recommended: {
        max_concurrent_jobs: 3,
        delay_ms: 300,
        page_concurrency: 8,
        item_concurrency: 16
      }
    });
  });
  app.post("/api/v1/worker/settings", async (req, res) => {
    const newSettings = req.body || {};
    await taskWorker.updateSettings(newSettings);
    res.json({
      status: "ok",
      settings: {
        ...taskWorker.getSettings(),
        active_jobs: taskWorker.activeJobCount,
        antibot: taskWorker.getAntiBotReport(),
        recommended: {
          max_concurrent_jobs: 3,
          delay_ms: 800,
          page_concurrency: 4,
          item_concurrency: 5
        }
      }
    });
  });
  app.post("/api/v1/worker/jobs/:job_id/pause", async (req, res) => {
    const success = await taskWorker.pauseJob(req.params.job_id);
    if (!success) return res.status(400).json({ detail: "No se pudo pausar la tarea" });
    res.json({ status: "ok", message: "Tarea pausada" });
  });
  app.post("/api/v1/worker/jobs/:job_id/resume", async (req, res) => {
    const success = await taskWorker.resumeJob(req.params.job_id);
    if (!success) return res.status(400).json({ detail: "No se pudo reanudar la tarea" });
    res.json({ status: "ok", message: "Tarea reanudada" });
  });
  app.post("/api/v1/worker/jobs/:job_id/cancel", async (req, res) => {
    const success = await taskWorker.cancelJob(req.params.job_id);
    if (!success) return res.status(400).json({ detail: "No se pudo cancelar la tarea" });
    res.json({ status: "ok", message: "Tarea cancelada" });
  });
  app.post("/api/v1/worker/jobs/:job_id/start", async (req, res) => {
    void taskWorker.runJobNow(req.params.job_id).then((ok) => {
      if (!ok) console.log(`[Worker] No se pudo iniciar el job ${req.params.job_id} (no estaba pendiente)`);
    }).catch((e) => {
      console.error(`[Worker] runJobNow ${req.params.job_id} fall\xC3\xB3:`, e?.message || e);
    });
    res.json({ status: "ok", message: "Tarea enviada para inicio inmediato" });
  });
  app.delete("/api/v1/worker/jobs/:job_id", async (req, res) => {
    const success = await taskWorker.deleteJob(req.params.job_id);
    if (!success) return res.status(404).json({ detail: "Tarea no encontrada" });
    res.json({ status: "ok", message: "Tarea eliminada" });
  });
  app.post("/api/v1/source-recovery/start", async (req, res) => {
    const rawBody = req.body;
    if (rawBody !== void 0 && (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody))) {
      return res.status(400).json({ ok: false, detail: "El cuerpo debe ser un objeto JSON" });
    }
    const body = rawBody || {};
    let providers;
    if (body.providers !== void 0) {
      if (!Array.isArray(body.providers) || body.providers.length > 16 || !body.providers.every((provider) => typeof provider === "string" && provider.trim().length > 0 && provider.trim().length <= 80)) {
        return res.status(400).json({ ok: false, detail: "providers debe ser un array de hasta 16 nombres v\xE1lidos" });
      }
      providers = body.providers.map((provider) => provider.trim());
    }
    let limit;
    if (body.limit !== void 0) {
      const value = typeof body.limit === "number" ? body.limit : typeof body.limit === "string" ? Number(body.limit.trim()) : NaN;
      if (!Number.isInteger(value) || value < 1 || value > 5e4) {
        return res.status(400).json({ ok: false, detail: "limit debe ser un entero entre 1 y 50000" });
      }
      limit = value;
    }
    let delayMs;
    if (body.delay_ms !== void 0) {
      const value = typeof body.delay_ms === "number" ? body.delay_ms : typeof body.delay_ms === "string" ? Number(body.delay_ms.trim()) : NaN;
      if (!Number.isInteger(value) || value < 300 || value > 1e4) {
        return res.status(400).json({ ok: false, detail: "delay_ms debe ser un entero entre 300 y 10000" });
      }
      delayMs = value;
    }
    let name;
    if (body.name !== void 0) {
      if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > 120) {
        return res.status(400).json({ ok: false, detail: "name debe ser texto no vac\xEDo de m\xE1ximo 120 caracteres" });
      }
      name = body.name.trim();
    }
    let mode = "expired";
    if (body.mode !== void 0) {
      if (body.mode !== "expired" && body.mode !== "all") {
        return res.status(400).json({ ok: false, detail: "mode debe ser 'expired' o 'all'" });
      }
      mode = body.mode;
    }
    try {
      const job = await sourceRecoveryWorker.createJob({ providers, limit, delay_ms: delayMs, name, mode });
      return res.status(202).json({ ok: true, job });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error creando recuperaci\xF3n de fuentes: ${detail}` });
    }
  });
  app.get("/api/v1/source-recovery/jobs", async (req, res) => {
    const rawLimit = req.query.limit;
    let limit = 20;
    if (rawLimit !== void 0) {
      if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) {
        return res.status(400).json({ ok: false, detail: "limit debe ser un entero" });
      }
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ ok: false, detail: "limit debe estar entre 1 y 100" });
      }
    }
    try {
      const jobs = await sourceRecoveryWorker.getJobs(limit);
      res.setHeader("Cache-Control", "private, max-age=1, stale-while-revalidate=4");
      return res.json({ ok: true, jobs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error consultando recuperaciones: ${detail}` });
    }
  });
  app.get("/api/v1/source-recovery/jobs/:job_id", async (req, res) => {
    try {
      const job = await sourceRecoveryWorker.getJob(req.params.job_id);
      if (!job) return res.status(404).json({ ok: false, detail: "Recuperaci\xF3n no encontrada" });
      return res.json({ ok: true, job });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error consultando recuperaci\xF3n: ${detail}` });
    }
  });
  app.post("/api/v1/source-recovery/jobs/:job_id/pause", async (req, res) => {
    try {
      const success = await sourceRecoveryWorker.pauseJob(req.params.job_id);
      if (!success) return res.status(400).json({ ok: false, detail: "No se pudo pausar la recuperaci\xF3n" });
      return res.json({ ok: true, status: "recovery_paused" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error pausando recuperaci\xF3n: ${detail}` });
    }
  });
  app.post("/api/v1/source-recovery/jobs/:job_id/resume", async (req, res) => {
    try {
      const success = await sourceRecoveryWorker.resumeJob(req.params.job_id);
      if (!success) return res.status(400).json({ ok: false, detail: "No se pudo reanudar la recuperaci\xF3n" });
      return res.json({ ok: true, status: "recovery_pending" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error reanudando recuperaci\xF3n: ${detail}` });
    }
  });
  app.post("/api/v1/metadata/backfill", async (req, res) => {
    try {
      const limit = typeof req.body?.limit === "number" ? req.body.limit : parseInt(req.body?.limit, 10) || 100;
      const result = await backfillMissingMetadata(limit);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ detail: `Error encolando backfill: ${e.message}` });
    }
  });
  app.get("/api/v1/metadata/backfill", async (_req, res) => {
    res.json(getBackfillStatus());
  });
  app.get("/api/v1/verification", (_req, res) => {
    res.json(getVerificationStatus());
  });
  app.post("/api/v1/verification/config", async (req, res) => {
    try {
      if (req.body?.platforms !== void 0) {
        if (!Array.isArray(req.body.platforms) || !req.body.platforms.every((p) => typeof p === "string")) {
          return res.status(400).json({ ok: false, detail: "platforms must be an array of strings" });
        }
      }
      const config = await updateVerificationConfig(req.body || {});
      res.json({ ok: true, config, status: getVerificationStatus() });
    } catch (e) {
      res.status(400).json({ ok: false, detail: String(e?.message || e) });
    }
  });
  app.post("/api/v1/verification/run", async (req, res) => {
    const body = req.body || {};
    if (body.mode !== void 0 && body.mode !== "metadata" && body.mode !== "full") {
      return res.status(400).json({ ok: false, detail: "mode must be 'metadata' or 'full'" });
    }
    if (body.platforms !== void 0 && (!Array.isArray(body.platforms) || !body.platforms.every((p) => typeof p === "string"))) {
      return res.status(400).json({ ok: false, detail: "platforms must be an array of strings" });
    }
    if (body.limit !== void 0 && (!Number.isFinite(Number(body.limit)) || Number(body.limit) <= 0)) {
      return res.status(400).json({ ok: false, detail: "limit must be a positive number" });
    }
    if (body.pages_per_platform !== void 0 && (!Number.isFinite(Number(body.pages_per_platform)) || Number(body.pages_per_platform) <= 0)) {
      return res.status(400).json({ ok: false, detail: "pages_per_platform must be a positive number" });
    }
    const result = runVerification({
      mode: body.mode,
      platforms: Array.isArray(body.platforms) ? body.platforms : void 0,
      limit: body.limit ? Math.round(Number(body.limit)) : void 0,
      pages_per_platform: body.pages_per_platform ? Math.round(Number(body.pages_per_platform)) : void 0
    });
    if (!result.started) {
      return res.status(409).json({ ok: false, started: false, reason: result.reason, status: getVerificationStatus() });
    }
    res.status(202).json({ ok: true, started: true, status: getVerificationStatus() });
  });
  app.post("/api/v1/verification/pause", (_req, res) => {
    const result = pauseVerification();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });
  app.post("/api/v1/verification/resume", (_req, res) => {
    const result = resumeVerification();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });
  app.post("/api/v1/verification/stop", (_req, res) => {
    const result = stopVerification();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });
  app.post("/api/v1/worker/clear-finished", async (req, res) => {
    await taskWorker.clearFinishedJobs();
    res.json({ status: "ok", message: "Tareas completadas limpiadas" });
  });
  app.get("/api/v1/tasks/:task_id", async (req, res) => {
    const taskId = req.params.task_id;
    const job = await taskWorker.getJob(taskId);
    if (job) {
      return res.json({
        task_id: job.id,
        name: job.name,
        status: job.status,
        pages_crawled: job.current_page,
        shows_imported: job.shows_imported,
        episodes_imported: job.episodes_imported,
        total_discovered: job.total_discovered,
        current_item_title: job.current_item_title,
        items_queue: job.items_queue,
        rate_limit_delay_ms: job.rate_limit_delay_ms,
        error_message: job.error_message,
        created_at: job.created_at,
        updated_at: job.updated_at,
        logs: job.logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`),
        detailed_logs: job.logs
      });
    }
    return res.status(404).json({ detail: "Tarea no encontrada" });
  });
  app.post("/api/v1/extract", async (req, res) => {
    const url = req.body?.url || "";
    if (!url) {
      return res.status(400).json({ detail: "URL requerida para extracci\xC3\xB3n" });
    }
    try {
      const extracted = await extractStreamFromUrl(url);
      const analysis = await analyzeUniversalUrl(url).catch(() => null);
      const streams = Array.from(
        new Set(
          [
            extracted.stream_url,
            ...extracted.all_available_streams || [],
            ...analysis?.detected_streams || [],
            ...(analysis?.episodes || []).map((e) => e.url),
            url
          ].filter(Boolean)
        )
      );
      res.json({
        title: extracted.title || analysis?.title || "Stream Extra\xC3\xADdo",
        description: `Estrategia: Universal Live Extractor (${(analysis?.content_type || "video").toUpperCase()})`,
        detected_type: analysis?.content_type || "video",
        stream_url: streams[0] || url,
        all_streams: streams,
        poster_url: analysis?.poster_url || "",
        subtitles: []
      });
    } catch (e) {
      res.status(500).json({ detail: `Error extrayendo stream: ${e.message}` });
    }
  });
  app.post("/api/v1/catalog/reset-sample", async (req, res) => {
    try {
      await clearAllShowsFromDb();
      res.json({ status: "ok", message: "Base de datos PostgreSQL vaciada completamente." });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/v1/network/stats", (_req, res) => {
    res.json({
      logFiles: getLogFilePaths(),
      hosts: getHostStats(),
      playerHealth: getProviderHealthStats()
    });
  });
  app.post("/api/v1/network/player-event", (req, res) => {
    const { eventType, provider, serverUrl, mediaTitle, episodeTitle, durationBeforeErrorMs, details } = req.body || {};
    if (!eventType || !serverUrl) {
      return res.status(400).json({ error: "eventType y serverUrl son requeridos" });
    }
    const entry = logPlayerEvent({
      eventType,
      provider,
      serverUrl,
      mediaTitle,
      episodeTitle,
      durationBeforeErrorMs,
      details
    });
    if (eventType === "playback_started") {
      reportPlaybackSignal(serverUrl, { ok: true, latencyMs: durationBeforeErrorMs });
    } else if (eventType === "playback_error" || eventType === "black_screen_stalled") {
      reportPlaybackSignal(serverUrl, {
        ok: false,
        reason: eventType === "black_screen_stalled" ? "playback_timeout" : "playback_error",
        latencyMs: durationBeforeErrorMs
      });
    }
    res.json({ status: "ok", entry });
  });
  app.get("/api/v1/network/logs", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 5e3);
    res.json({
      network: getRecentLogs(limit),
      playerEvents: getRecentPlayerEvents(limit)
    });
  });
  app.delete("/api/v1/network/logs", (_req, res) => {
    clearLogs();
    res.json({ status: "ok", message: "Logs de red y reproductor limpiados." });
  });
  app.post("/api/v1/catalog/merge-works", async (req, res) => {
    try {
      const { keep_id, merge_id, dry_run } = req.body ?? {};
      if (!keep_id || !merge_id) return res.status(400).json({ detail: "keep_id y merge_id son requeridos." });
      const result = await mergeTwoShows(String(keep_id), String(merge_id), { dryRun: dry_run !== false });
      if (!result.ok) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ detail: `Error en fusi\xC3\xB3n manual: ${e.message}` });
    }
  });
  app.post("/api/v1/catalog/reconcile-sequels", async (req, res) => {
    try {
      const dryRun = req.body?.dry_run !== false;
      const summary = await reconcileSequelsByTmdb({ dryRun });
      res.json({ ok: true, ...summary });
    } catch (e) {
      res.status(500).json({ detail: `Error en reconciliaci\xC3\xB3n: ${e.message}` });
    }
  });
  app.get("/api/v1/write-buffer", async (_req, res) => {
    const status = await drainWriteBuffer();
    res.json({ ok: true, ...status });
  });
  app.get("/api/v1/platforms/:platform/works", async (req, res) => {
    try {
      const platform = String(req.params.platform || "").toLowerCase();
      const eps = await prisma.episode.findMany({
        where: { source_url: { contains: platform } },
        include: { show: { select: { id: true, title: true, category: true, poster_url: true } } },
        take: 400,
        orderBy: { updated_at: "desc" }
      });
      const seen = /* @__PURE__ */ new Set();
      const works = [];
      for (const e of eps) {
        if (e.show && !seen.has(e.show.id)) {
          seen.add(e.show.id);
          works.push(e.show);
        }
        if (works.length >= 60) break;
      }
      res.json({ ok: true, works });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });
  app.post("/api/v1/platforms/:platform/test-servers", async (req, res) => {
    try {
      const platform = String(req.params.platform || "").toLowerCase();
      const showId = String(req.body?.show_id || "");
      const show = await prisma.show.findUnique({ where: { id: showId }, include: { episodes: true } });
      if (!show) return res.status(404).json({ detail: "Obra no encontrada." });
      const candidates = show.episodes.filter((e) => e.source_url);
      const episode = candidates.find((e) => e.source_url.toLowerCase().includes(platform)) || candidates[0];
      if (!episode) return res.status(404).json({ detail: "La obra no tiene episodios con fuente." });
      const extracted = await extractStreamFromUrl(episode.source_url);
      const seen = /* @__PURE__ */ new Set();
      const streams = [extracted.stream_url, ...extracted.all_available_streams || []].filter(Boolean).filter((u) => {
        if (seen.has(u) || isBlacklistedHost(u)) return false;
        seen.add(u);
        return true;
      }).slice(0, 12);
      const priorities = getServerPriorities(platform);
      const origin = `http://127.0.0.1:${APP_CONFIG.port}`;
      const tests = await Promise.all(
        streams.map(async (url) => {
          const host = hostOfUrl(url);
          const started = Date.now();
          let status = 0;
          try {
            const r = await fetch(`${origin}/api/v1/proxy/stream?url=${encodeURIComponent(url)}`, {
              headers: { Range: "bytes=0-100", "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(9e3)
            });
            status = r.status;
            try {
              await r.body?.cancel();
            } catch {
            }
          } catch {
            status = 0;
          }
          return {
            url,
            host,
            hostFamily: familyKeyOfStreamUrl(url),
            status,
            ok: status === 200 || status === 206,
            latency_ms: Date.now() - started,
            priority: priorities[familyKeyOfStreamUrl(url)] ?? void 0
          };
        })
      );
      tests.sort((a, b) => {
        const na = a.priority ?? Number.MAX_SAFE_INTEGER;
        const nb = b.priority ?? Number.MAX_SAFE_INTEGER;
        if (na !== nb) return na - nb;
        return a.latency_ms - b.latency_ms;
      });
      res.json({
        ok: true,
        platform,
        episode_url: episode.source_url,
        results: tests,
        priorities
      });
    } catch (e) {
      res.status(500).json({ detail: `Error probando servidores: ${e.message}` });
    }
  });
  app.get("/api/v1/platforms/:platform/server-priorities", async (req, res) => {
    res.json({ ok: true, priorities: getServerPriorities(req.params.platform) });
  });
  app.post("/api/v1/platforms/:platform/server-priorities", async (req, res) => {
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order.map((h) => String(h)) : [];
      if (order.length === 0) return res.status(400).json({ detail: "order requerido (lista de hosts)." });
      setServerOrder(req.params.platform, order);
      res.json({ ok: true, priorities: getServerPriorities(req.params.platform) });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });
  app.post("/api/v1/platforms/:platform/server-priorities/move", async (req, res) => {
    try {
      const { host, dir } = req.body ?? {};
      if (!host || dir !== -1 && dir !== 1) return res.status(400).json({ detail: "host y dir (-1|1) requeridos." });
      moveServerPriority(req.params.platform, String(host), dir === -1 ? -1 : 1);
      res.json({ ok: true, priorities: getServerPriorities(req.params.platform) });
    } catch (e) {
      res.status(500).json({ detail: e.message });
    }
  });
  app.post("/api/v1/admin/login", adminLogin);
  app.get("/api/v1/admin/session", adminSession);
  app.post("/api/v1/admin/logout", adminLogout);
  app.use("/api/auth", authRouter);
  app.use("/api/progress", progressRouter);
  app.use("/api/recommendations", recommendationsRouter);
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "0.0.0.0", port: PORT },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = import_path6.default.join(process.cwd(), "dist");
    app.use(import_express4.default.static(distPath));
    app.use((req, res) => {
      res.sendFile(import_path6.default.join(distPath, "index.html"));
    });
  }
  process.on("unhandledRejection", (reason) => {
    console.error("[Proceso] Promesa rechazada sin catch (servidor se mantiene vivo):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[Proceso] Excepci\xC3\xB3n no capturada (servidor se mantiene vivo):", err);
  });
  try {
    await prisma.$queryRawUnsafe("SELECT 1 as alive");
    console.log("[DB] PostgreSQL connection OK");
  } catch (e) {
    console.warn("[DB] PostgreSQL connection failed:", e?.message || e);
  }
  startWriteBufferDrainer();
  taskWorker.init();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VoidStream] Servidor PostgreSQL ejecut\xC3\xA1ndose en http://0.0.0.0:${PORT}`);
  });
}
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  startServer();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildMultiSourceCascade,
  handlePlayEpisode
});
//# sourceMappingURL=server.cjs.map
