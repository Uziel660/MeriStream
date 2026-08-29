// server/utils/textCleaner.ts
// ══════════════════════════════════════════════════════════════════
// Limpiador centralizado de textos, sinopsis y títulos
// Corrige entidades HTML (&nbsp;, &amp;), tags, mojibake UTF-8 y
// prefijos de título redundantes ("The Sneak Over Es el verano...")
// ══════════════════════════════════════════════════════════════════

const HTML_ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&aacute;": "á",
  "&eacute;": "é",
  "&iacute;": "í",
  "&oacute;": "ó",
  "&uacute;": "ú",
  "&ntilde;": "ñ",
  "&Aacute;": "Á",
  "&Eacute;": "É",
  "&Iacute;": "Í",
  "&Oacute;": "Ó",
  "&Uacute;": "Ú",
  "&Ntilde;": "Ñ",
  "&uuml;": "ü",
  "&Uuml;": "Ü",
  "&iexcl;": "¡",
  "&iquest;": "¿",
  "&ccedil;": "ç",
  "&Ccedil;": "Ç",
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&ldquo;": '"',
  "&rdquo;": '"',
  "&lsquo;": "'",
  "&rsquo;": "'",
  "&bull;": "•",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&euro;": "€",
  "&pound;": "£",
  "&yen;": "¥",
};

// Lista de marcas y dominios de adaptadores/scrapers para limpieza y detección automática
export const SCRAPER_BRAND_REGEX = /\b(veranimes|cinecalidad|tioanime|tioplus|tubepelis|lamovie|animeflv|jkanime|latanime|lat-anime|doramasflix|cuevana\d*|pelisplus|monoschinos|animesonline|tvmaze)\b/i;

/**
 * Limpia y normaliza una descripción de obra o episodio.
 */
export function cleanDescription(rawDescription?: string | null, title?: string | null): string {
  if (!rawDescription) return "";
  let text = String(rawDescription);

  // 1. Decodificar entidades HTML con nombre
  for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
    if (text.toLowerCase().includes(entity.toLowerCase())) {
      const reg = new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      text = text.replace(reg, replacement);
    }
  }

  // 2. Decodificar entidades numéricas (decimales y hexadecimales)
  text = text
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCharCode(Number(code));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return "";
      }
    });

  // 3. Eliminar tags HTML (<p>, <div>, <br>, <span>, etc.)
  text = text.replace(/<[^>]*>/g, " ");

  // 4. Arreglar caracteres con doble codificación UTF-8 típica (mojibake)
  text = text
    .replace(/Ã¡/g, "á")
    .replace(/Ã©/g, "é")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ãº/g, "ú")
    .replace(/Ã±/g, "ñ")
    .replace(/Ã /g, "Á")
    .replace(/Ã‰/g, "É")
    .replace(/Ã /g, "Í")
    .replace(/Ã“/g, "Ó")
    .replace(/Ãš/g, "Ú")
    .replace(/Ã‘/g, "Ñ")
    .replace(/â€“|â€”/g, "—")
    .replace(/â€œ|â€ /g, '"')
    .replace(/â€˜|â€™/g, "'");

  // 5. Quitar frases promocionales de scrapers (ej. "Ver en VerAnimes", "Ver dorama ... online sub español en Doramasflix")
  text = text
    .replace(/^(?:sinopsis|descripci[oó]n|resumen|overview|summary)\s*:\s*/i, "")
    .replace(/(?:ver|mira|disfruta)\s+(?:dorama|pel[ií]cula|anime|serie)?\s*[^.]*?\b(veranimes|cinecalidad|tioanime|tioplus|tubepelis|lamovie|animeflv|jkanime|latanime|doramasflix|cuevana|pelisplus)\b[^.]*?\./gi, "")
    .replace(/ver\s+(?:dorama|anime|pel[ií]cula)?\s+.*?sub\s+español\s+online\s+.*?doramasflix/gi, "")
    .replace(/💖\s*Doramasflix/gi, "")
    .replace(/💓\s*dorama/gi, "");

  // 6. Si el título está duplicado al principio ("The Sneak Over Es el verano..."), removerlo limpiamente
  if (title) {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length >= 3) {
      const escapedTitle = trimmedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const titlePrefixRegex = new RegExp(`^${escapedTitle}\\s*[-:–—]?\\s*`, "i");
      text = text.replace(titlePrefixRegex, "");
    }
  }

  // 7. Normalizar espacios en blanco y trim
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

/**
 * Detecta si una descripción contiene anomalías que requieren limpieza o enriquecimiento
 */
export function isAnomalousDescription(text?: string | null, title?: string | null): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 15) return true;

  // Marcas/Nombres de adaptadores o scrapers presentes en la sinopsis (ej. VerAnimes, Cinecalidad, Doramasflix)
  if (SCRAPER_BRAND_REGEX.test(t)) return true;

  // Frases basura típicas ("ver peliculas", "ver anime", etc.)
  if (/(?:ver pel[ií]culas|ver anime|ver series|online gratis|sub espa[nñ]ol|cap[ií]tulo|audio latino)/i.test(t)) return true;

  // Entidades HTML con nombre o numéricas
  if (/&(?:[a-z]{2,8}|#\d+|#x[0-9a-f]+);/i.test(t)) return true;

  // Tags HTML presentes
  if (/<[a-z][\s\S]*>/i.test(t)) return true;

  // Mojibake
  if (/Ã[¡éíóúñÁÉÍÓÚÑ]|â[€“—œ ˜™]/i.test(t)) return true;

  // Título duplicado al principio de la sinopsis
  if (title && title.trim().length >= 4) {
    const cleanTitle = title.trim().toLowerCase();
    if (t.toLowerCase().startsWith(cleanTitle)) return true;
  }

  // Placeholder
  if (/^(?:sin descripci|contenido indexado|obra multimedia indexada|placeholder|ver anime|ver peliculas)/i.test(t)) return true;

  return false;
}
