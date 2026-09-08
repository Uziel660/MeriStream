import type { Show } from '../types';

/**
 * Normaliza texto para búsqueda: quita tildes, lowercase, trim.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Normalización estricta: además de quitar tildes, elimina todo lo que
 * no sea letra o número. Así "Spider-Man" y "spiderman" se vuelven iguales.
 */
export function normalizeTextStrict(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Keep non-Latin scripts intact so Japanese, Korean and Chinese titles
    // remain searchable after punctuation/spacing is removed.
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
}

function searchTokens(text: string): string[] {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

/**
 * Distancia de Levenshtein: número mínimo de inserciones/eliminaciones/sustituciones
 * para convertir `a` en `b`. Usada para fuzzy matching.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // eliminación
        matrix[i][j - 1] + 1,      // inserción
        matrix[i - 1][j - 1] + cost // sustitución
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Score fuzzy: compara el query contra un texto normalizado.
 * Si el query es suficientemente corto (<=4 chars), tolera 1 error.
 * Si es más largo, tolera hasta 2 errores o ~30% de la longitud.
 * Devuelve un score de 0-25 o 0 si no es plausible.
 */
function fuzzyMatch(queryNorm: string, targetNorm: string): number {
  if (!queryNorm || !targetNorm) return 0;
  if (queryNorm.length < 3) return 0;

  // Si ya contiene o empieza con, no necesita fuzzy (lo maneja scoreShow)
  if (targetNorm.includes(queryNorm)) return 0;

  // Para títulos largos, buscar subcadenas del query dentro del título
  // Ej: query "shingeki no kyojin" vs título "shingeki" → ya cubierto por includes
  // El fuzzy es para typos: "shinkeki" vs "shingeki"

  const maxDist = queryNorm.length <= 4 ? 1 : Math.min(2, Math.floor(queryNorm.length * 0.3));
  const dist = levenshtein(queryNorm, targetNorm);

  if (dist <= maxDist) {
    // Score proporcional: menos distancia = más alto
    const ratio = 1 - dist / Math.max(queryNorm.length, targetNorm.length);
    return Math.round(15 + ratio * 10); // 15-25
  }

  // Para consultas de varias palabras, comparar cada token por separado. Esto
  // corrige errores como "one pecie" → "One Piece" sin exigir que la cadena
  // completa tenga la misma longitud ni penalizar artículos compartidos.
  const queryTokens = searchTokens(queryNorm);
  const words = searchTokens(targetNorm);
  if (queryTokens.length > 1 && words.length > 0) {
    let matched = 0;
    let scoreSum = 0;
    for (const token of queryTokens) {
      const maxTokenDist = token.length <= 4 ? 1 : Math.min(2, Math.floor(token.length * 0.3));
      let bestToken = 0;
      for (const word of words) {
        if (word === token) {
          bestToken = Math.max(bestToken, 1);
          continue;
        }
        if (word.includes(token) || token.includes(word)) {
          // A short substring inside a much longer word is weaker than a
          // complete token match ("one" in "lioness" must lose to "one").
          bestToken = Math.max(bestToken, Math.min(token.length, word.length) / Math.max(token.length, word.length));
          continue;
        }
        if (Math.abs(word.length - token.length) > 2) continue;
        const distance = levenshtein(token, word);
        if (distance <= maxTokenDist) {
          const ratio = 1 - distance / Math.max(token.length, word.length);
          bestToken = Math.max(bestToken, ratio);
        }
      }
      if (bestToken > 0) {
        matched += 1;
        scoreSum += bestToken;
      }
    }
    const coverage = matched / queryTokens.length;
    if (coverage >= (queryTokens.length > 2 ? 0.66 : 1)) {
      return Math.round(13 + coverage * 8 + (scoreSum / queryTokens.length) * 4);
    }
  }

  // Intentar fuzzy contra palabras individuales del título
  let bestWordScore = 0;
  for (const word of words) {
    if (Math.abs(word.length - queryNorm.length) > 2) continue;
    const wDist = levenshtein(queryNorm, word);
    const wMaxDist = queryNorm.length <= 4 ? 1 : Math.min(2, Math.floor(queryNorm.length * 0.3));
    if (wDist <= wMaxDist) {
      const ratio = 1 - wDist / Math.max(queryNorm.length, word.length);
      bestWordScore = Math.max(bestWordScore, Math.round(12 + ratio * 10));
    }
  }

  return bestWordScore;
}

/**
 * Score de un show contra un query normalizado.
 * 0 = sin coincidencia.
 * Mayor score = mejor coincidencia.
 *
 * Prioridad:
 *   100  título exacto (normal)
 *    95  título exacto (strict, ignora speciales)
 *    90  english_title exacto (normal)
 *    85  english_title exacto (strict)
 *    80  japanese_title exacto
 *    70  original_title exacto
 *    60  título empieza con (normal)
 *    58  título empieza con (strict)
 *    50  english empieza con (normal)
 *    48  english empieza con (strict)
 *    40  contiene en título (normal)
 *    38  contiene en título (strict)
 *    30  contiene en english
 *    20  contiene en japanese
 *    10  contiene en original
 *     5  contiene en genres
 */
export function scoreShow(s: Show, queryNormalized: string): number {
  if (!queryNormalized) return 0;

  const qStrict = normalizeTextStrict(queryNormalized);
  let best = 0;

  // --- TITLE ---
  if (s.title) {
    const t = normalizeText(s.title);
    const ts = normalizeTextStrict(s.title);
    if (t === queryNormalized) return 100;
    if (ts === qStrict) best = Math.max(best, 95);
    // Permite escribir un título junto ("onepiece") aunque la ficha lo
    // guarde separado ("One Piece").
    if (qStrict.length >= 4 && ts.includes(qStrict)) best = Math.max(best, 86);
    if (best >= 95) return best;
    if (t.startsWith(queryNormalized)) best = Math.max(best, 60);
    else if (ts.startsWith(qStrict)) best = Math.max(best, 58);
    if (best === 0 && t.includes(queryNormalized)) best = Math.max(best, 40);
    else if (best < 38 && ts.includes(qStrict)) best = Math.max(best, 38);
    // Fuzzy en título
    if (best === 0) best = Math.max(best, fuzzyMatch(queryNormalized, t));
  }

  // --- ENGLISH TITLE ---
  if (s.english_title) {
    const e = normalizeText(s.english_title);
    const es = normalizeTextStrict(s.english_title);
    if (e === queryNormalized) best = Math.max(best, 90);
    else if (es === qStrict) best = Math.max(best, 85);
    else if (qStrict.length >= 4 && es.includes(qStrict)) best = Math.max(best, 82);
    if (best >= 90) return best;
    if (e.startsWith(queryNormalized)) best = Math.max(best, 50);
    else if (es.startsWith(qStrict)) best = Math.max(best, 48);
    if (best < 30 && e.includes(queryNormalized)) best = Math.max(best, 30);
    else if (best < 30 && es.includes(qStrict)) best = Math.max(best, 30);
    // Fuzzy en english
    if (best === 0) best = Math.max(best, fuzzyMatch(queryNormalized, e));
  }

  // --- JAPANESE TITLE ---
  if (s.japanese_title) {
    const j = normalizeText(s.japanese_title);
    if (j === queryNormalized) best = Math.max(best, 80);
    if (best >= 80) return best;
    if (best < 20 && j.includes(queryNormalized)) best = Math.max(best, 20);
    // Fuzzy en japanese
    if (best === 0) best = Math.max(best, fuzzyMatch(queryNormalized, j));
  }

  // --- ORIGINAL TITLE ---
  if (s.original_title) {
    const o = normalizeText(s.original_title);
    const os = normalizeTextStrict(s.original_title);
    if (o === queryNormalized) best = Math.max(best, 70);
    else if (os === qStrict) best = Math.max(best, 70);
    if (best >= 70) return best;
    if (best < 10 && o.includes(queryNormalized)) best = Math.max(best, 10);
    else if (best < 10 && os.includes(qStrict)) best = Math.max(best, 10);
    // Fuzzy en original
    if (best === 0) best = Math.max(best, fuzzyMatch(queryNormalized, o));
  }

  // El catálogo público puede aportar títulos alternativos en varios idiomas
  // sin que tengamos que duplicar fichas locales. Trátalos con la misma
  // prioridad que el título original antes de caer en géneros.
  if (Array.isArray(s.title_aliases)) {
    for (const alias of s.title_aliases) {
      const a = normalizeText(alias);
      const as = normalizeTextStrict(alias);
      if (a === queryNormalized) best = Math.max(best, 92);
      else if (as === qStrict) best = Math.max(best, 88);
      else if (qStrict.length >= 4 && as.includes(qStrict)) best = Math.max(best, 80);
      if (best < 35 && a.includes(queryNormalized)) best = Math.max(best, 34);
      if (best < 25) best = Math.max(best, fuzzyMatch(queryNormalized, a));
    }
  }

  // --- GENRES (solo si no hubo match en ningún título) ---
  if (best === 0) {
    const genres = Array.isArray(s.genres) ? s.genres.join(' ') : String(s.genres || '');
    if (normalizeText(genres).includes(queryNormalized)) best = Math.max(best, 5);
  }

  return best;
}

/**
 * Filtra y ordena un array de shows por relevancia contra un query raw (sin normalizar).
 * Devuelve solo los que tienen score > 0, ordenados de mayor a menor score.
 */
export function searchShows(shows: Show[], rawQuery: string): Show[] {
  const q = normalizeText(rawQuery);
  if (!q) return shows;

  const scored = shows
    .map((s) => ({ show: s, score: scoreShow(s, q) }))
    .filter((x) => x.score > 0);

  scored.sort((a, b) => b.score - a.score || a.show.title.localeCompare(b.show.title));
  return scored.map((x) => x.show);
}
