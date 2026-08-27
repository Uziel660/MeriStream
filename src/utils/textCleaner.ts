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

/**
 * Limpia y normaliza una descripción en tiempo de visualización
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

  // 3. Eliminar tags HTML
  text = text.replace(/<[^>]*>/g, " ");

  // 4. Arreglar mojibake común
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

  // 5. Quitar prefijos comunes de scrapers ("Sinopsis:", "Ver online:", "Descripción:", etc.)
  text = text.replace(/^(?:sinopsis|descripci[oó]n|resumen|overview|summary)\s*:\s*/i, "");

  // 6. Si el título está duplicado al principio ("The Sneak Over Es el verano..."), removerlo limpiamente
  if (title) {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length >= 3) {
      const escapedTitle = trimmedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const titlePrefixRegex = new RegExp(`^${escapedTitle}\\s*[-:–—]?\\s*`, "i");
      text = text.replace(titlePrefixRegex, "");
    }
  }

  // 7. Normalizar espacios en blanco
  text = text.replace(/\s+/g, " ").trim();

  return text;
}
