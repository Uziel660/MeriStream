import { normalizeSubtitleLanguage } from "./SubtitleNormalizer";
import type { SubtitleCandidate } from "./types";

const DEFAULT_LANGUAGES = ["es-419", "es", "en"];

function languageScore(language: string, preferred: string[]): number {
  const index = preferred.indexOf(language);
  return index >= 0 ? 1_000 - index * 100 : 100;
}

function releaseScore(candidate: SubtitleCandidate): number {
  const release = `${candidate.release || ""} ${candidate.label || ""}`.toLowerCase();
  let score = 0;
  if (/web[- .]?dl|webrip/.test(release)) score += 15;
  if (/bluray|blu[- .]?ray/.test(release)) score += 12;
  if (/amzn|amazon|nf|netflix/.test(release)) score += 8;
  if (candidate.hearingImpaired) score -= 2;
  // Forced subtitles normally contain only signs / foreign-language dialogue.
  // Keep them available as an explicit alternative, but do not let a tiny
  // metadata bonus make them the default over a complete track.
  if (candidate.forced) score -= 12;
  if (candidate.fps) score += 1;
  return score;
}

export function rankSubtitleCandidates(
  candidates: SubtitleCandidate[],
  preferredLanguages?: string[],
  maxPerLanguage = 5,
): SubtitleCandidate[] {
  const preferred = (preferredLanguages || DEFAULT_LANGUAGES)
    .map(normalizeSubtitleLanguage)
    .filter((value): value is string => Boolean(value));
  const order = preferred.length > 0 ? preferred : DEFAULT_LANGUAGES;
  const ranked = candidates.filter((candidate) => order.includes(candidate.language)).map((candidate, index) => ({
    candidate: { ...candidate },
    index,
    languageRank: order.indexOf(candidate.language),
    score: languageScore(candidate.language, order) + releaseScore(candidate) + (candidate.score || 0),
  })).sort((a, b) => {
    // Language preference remains authoritative. Within the same language a
    // complete subtitle is always offered before a Forced-only rendition.
    if (a.languageRank !== b.languageRank) return a.languageRank - b.languageRank;
    const forcedDelta = Number(Boolean(a.candidate.forced)) - Number(Boolean(b.candidate.forced));
    if (forcedDelta !== 0) return forcedDelta;
    return b.score - a.score || a.index - b.index;
  });

  const grouped = new Map<string, typeof ranked>();
  for (const item of ranked) {
    const list = grouped.get(item.candidate.language) || [];
    list.push(item);
    grouped.set(item.candidate.language, list);
  }

  const selected: typeof ranked = [];
  for (const language of order) {
    const list = grouped.get(language) || [];
    if (list.length === 0) continue;
    const providers = new Set<string>();
    const diversity: typeof ranked = [];
    for (const item of list) {
      if (providers.has(item.candidate.provider)) continue;
      providers.add(item.candidate.provider);
      diversity.push(item);
      if (diversity.length >= maxPerLanguage) break;
    }
    for (const item of list) {
      if (diversity.length >= maxPerLanguage) break;
      if (!diversity.includes(item)) diversity.push(item);
    }
    selected.push(...diversity);
  }
  return selected.map(({ candidate, score }) => ({ ...candidate, score }));
}
