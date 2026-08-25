// server/scrapers/utils/obscureResolvers.ts
// Resolvers para hosts "oscuros" usados por latanime.org (hexload.com, bysekoze.com).
// Estrategia 100% fetch + cheerio (sin navegador):
//   1. GET del HTML del embed.
//   2. Buscar .m3u8/.mp4 en texto claro, scripts inline y packs Dean Edwards (jsUnpacker).
// Contrato de fallback inteligente: si la extracción explota o la ofuscación es
// indescifrable, NUNCA se propaga el error; se devuelve
// { type: 'iframe', url: <embed original> } para reproducir embebido.

import * as cheerio from "cheerio";
import { unpackDeanEdwards, extractMediaUrlsFromCode } from "./jsUnpacker";

export interface ObscureResolution {
  /** "direct" = stream .m3u8/.mp4 jugable; "iframe" = fallback al embed original */
  type: "direct" | "iframe";
  url: string;
  provider: string;
}

const FETCH_TIMEOUT_MS = 8000;

const EMBED_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

async function fetchEmbedHtml(embedUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const referer = new URL(embedUrl).origin + "/";
    const res = await fetch(embedUrl, {
      signal: controller.signal,
      headers: { ...EMBED_HEADERS, Referer: referer },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Concatena los <script> inline del documento; los packs Dean Edwards suelen vivir ahí. */
function inlineScriptsText(html: string): string {
  try {
    const $ = cheerio.load(html);
    return $("script")
      .not("[src]")
      .map((_, el) => $(el).html() || "")
      .get()
      .join("\n");
  } catch {
    return "";
  }
}

function firstMediaUrl(urls: string[]): string | null {
  return (
    urls.find((u) => u.includes(".m3u8")) ||
    urls.find((u) => u.includes(".mp4")) ||
    null
  );
}

/**
 * Extrae la primera URL directa (.m3u8 preferido sobre .mp4) probando:
 * texto claro (con unpackGeneric interno) -> pack Dean Edwards explícito ->
 * URLs protocol-relative (//cdn.x/y.m3u8).
 */
function extractDirectMedia(html: string): string | null {
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

    const combined = `${scripts}\n${html}`;
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

/**
 * Núcleo compartido: intenta extraer el stream directo del embed y, ante
 * cualquier excepción (red, parseo, ofuscación indescifrable), degrada a iframe.
 */
async function resolveObscureEmbed(
  originalEmbedUrl: string,
  provider: string
): Promise<ObscureResolution> {
  try {
    const html = await fetchEmbedHtml(originalEmbedUrl);
    if (html) {
      const direct = extractDirectMedia(html);
      if (direct) return { type: "direct", url: direct, provider };
    }
  } catch {
    // Fallback inteligente: nunca fallar, devolver el iframe original.
  }
  return { type: "iframe", url: originalEmbedUrl, provider };
}

/** Hexload (hexload.com): devuelve stream directo o el iframe original. */
export async function resolveHexload(embedUrl: string): Promise<ObscureResolution> {
  return resolveObscureEmbed(embedUrl, "Hexload");
}

/** Bysekoze (bysekoze.com): devuelve stream directo o el iframe original. */
export async function resolveBysekoze(embedUrl: string): Promise<ObscureResolution> {
  return resolveObscureEmbed(embedUrl, "Bysekoze");
}
