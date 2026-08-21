// server/scrapers/utils/jsUnpacker.ts
// Utilidad pura en TypeScript para desofuscar código JavaScript empaquetado (Dean Edwards, Base64, Hexadecimal)

/**
 * Desempaqueta scripts ofuscados con Dean Edwards Packer: eval(function(p,a,c,k,e,d)...)
 */
export function unpackDeanEdwards(packed: string): string {
  if (!packed || !packed.includes('eval(function(p,a,c,k,e,')) {
    return packed;
  }

  try {
    const regex = /eval\(function\(p,a,c,k,e,[rd]\)\s*\{.+?return p\}\s*\(([\s\S]+?)\)\s*\)/;
    const match = packed.match(regex);
    if (!match) return packed;

    // Extraer argumentos pasados a la función empaquetadora
    const argsStr = match[1].trim();

    // Extraer el payload 'p' (primer argumento)
    const payloadMatch = argsStr.match(/^['"]([\s\S]+?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\(['"]\|['"]\)/);
    if (!payloadMatch) return packed;

    let payload = payloadMatch[1];
    const radix = parseInt(payloadMatch[2], 10) || 10;
    const count = parseInt(payloadMatch[3], 10) || 0;
    const keywords = payloadMatch[4].split('|');

    const encodeBase = (num: number, rad: number): string => {
      const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      let res = '';
      do {
        res = chars[num % rad] + res;
        num = Math.floor(num / rad);
      } while (num > 0);
      return res || '0';
    };

    const dict: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const key = encodeBase(i, radix);
      dict[key] = keywords[i] || key;
    }

    // Reemplazar identificadores en el payload
    const unpacked = payload.replace(/\b\w+\b/g, (w) => {
      return Object.prototype.hasOwnProperty.call(dict, w) && dict[w] ? dict[w] : w;
    });

    return unpacked;
  } catch {
    return packed;
  }
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
