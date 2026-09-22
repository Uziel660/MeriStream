// server/scrapers/utils/jsUnpacker.ts
// Utilidad pura en TypeScript para desofuscar código JavaScript empaquetado (Dean Edwards, Base64, Hexadecimal)

const PACKED_ENCODE_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const encodeBase = (num: number, rad: number): string => {
  let res = "";
  do {
    res = PACKED_ENCODE_CHARS[num % rad] + res;
    num = Math.floor(num / rad);
  } while (num > 0);
  return res || "0";
};

// Variante robusta (portada de unpackPackedScript en LaMovieAdapter): el payload
// puede traer comillas escapadas (\') y paréntesis internos (caso vimeos.net),
// así que anclar al cierre .split('<q>|<q>') con backreference de comillas fuerza
// el backtracking hasta el payload completo en vez de truncarlo.
const PACKED_ANCHORED_RE =
  /eval\(function\(p,a,c,k,e,[rd]\)\s*\{[\s\S]*?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\1([\s\S]*?)\1\.split\(\1\|\1\)/;

// Fallback clásico: captura todos los argumentos hasta el cierre )) y los parsea aparte
const PACKED_ARGS_RE = /eval\(function\(p,a,c,k,e,[rd]\)\s*\{.+?return p\}\s*\(([\s\S]+?)\)\s*\)/;
const PACKED_ARGS_PAYLOAD_RE = /^['"]([\s\S]+?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\(['"]\|['"]\)/;

const substituteKeywords = (
  payload: string,
  radixRaw: string,
  countRaw: string,
  keywords: string[]
): string => {
  const radix = parseInt(radixRaw, 10) || 10;
  const count = parseInt(countRaw, 10) || 0;

  const dict: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const key = encodeBase(i, radix);
    dict[key] = keywords[i] || key;
  }

  return payload.replace(/\b\w+\b/g, (w) => {
    return Object.prototype.hasOwnProperty.call(dict, w) && dict[w] ? dict[w] : w;
  });
};

/**
 * Desempaqueta scripts ofuscados con Dean Edwards Packer: eval(function(p,a,c,k,e,...)
 * Devuelve el código desempaquetado, o la entrada original si no hay match o algo falla.
 */
export function unpackDeanEdwards(packed: string): string {
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

/**
 * Alias público del desempaquetador robusto, con el mismo contrato que la copia
 * local de LaMovieAdapter.unpackPackedScript, para que los adaptadores migren sin cambios.
 */
export function unpackPackedScript(code: string): string {
  return unpackDeanEdwards(code);
}

/**
 * Desofusca cadenas codificadas en Base64 o Hex
 */
export function unpackGeneric(code: string): string {
  if (!code) return "";
  let result = code;

  // 1. Dean Edwards unpack
  if (result.includes("eval(function(p,a,c,k,e,")) {
    result = unpackDeanEdwards(result);
  }

  // 2. Base64 atob(...)
  if (result.includes("atob(")) {
    result = result.replace(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g, (_, b64) => {
      try {
        return Buffer.from(b64, 'base64').toString('utf-8');
      } catch {
        return b64;
      }
    });
  }

  // 3. Hex escape sequences (\x68\x74\x74\x70)
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

/**
 * Extrae URLs directas .m3u8 o .mp4 de un bloque de código
 */
export function extractMediaUrlsFromCode(code: string): string[] {
  if (!code) return [];
  const cleanCode = unpackGeneric(code);

  const urls: string[] = [];
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
