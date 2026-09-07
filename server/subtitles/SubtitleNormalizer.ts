import { normalizeLanguageTag } from "../providers/providerPolicy";
import type { SubtitleCandidate, SubtitleFormat } from "./types";

const LANGUAGE_LABELS: Record<string, string> = {
  "es-419": "Español Latino",
  es: "Español",
  en: "English",
};

export function normalizeSubtitleLanguage(value: unknown): string | null {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return null;
  if (["spa", "spanish", "español", "espanol", "castellano", "es"].includes(raw)) return "es";
  if (["lat", "latam", "latino", "es-la", "es-latam", "es-419", "spanish-latam", "español latino", "espanol latino"].includes(raw)) return "es-419";
  if (["eng", "english", "en"].includes(raw)) return "en";
  return normalizeLanguageTag(raw) || raw;
}

export function subtitleLanguageLabel(language: string, fallback?: string | null): string {
  return LANGUAGE_LABELS[language] || fallback || language.toUpperCase();
}

export function normalizeSubtitleFormat(value: unknown, sourceUrl = ""): SubtitleFormat {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^\./, "");
  if (["srt", "vtt", "ass", "ssa"].includes(raw)) return raw as SubtitleFormat;
  const extension = sourceUrl.toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/)?.[1];
  return extension && ["srt", "vtt", "ass", "ssa"].includes(extension)
    ? extension as SubtitleFormat
    : "unknown";
}

export function normalizeSubtitleCandidate(candidate: SubtitleCandidate): SubtitleCandidate | null {
  const sourceUrl = String(candidate.sourceUrl || "").trim();
  const language = normalizeSubtitleLanguage(candidate.language);
  if (!language || !/^https:\/\//i.test(sourceUrl)) return null;
  const format = normalizeSubtitleFormat(candidate.format, sourceUrl);
  return {
    ...candidate,
    id: String(candidate.id || `${candidate.provider}:${sourceUrl}`),
    provider: String(candidate.provider || "unknown"),
    language,
    label: String(candidate.label || subtitleLanguageLabel(language)),
    sourceUrl,
    format,
    fileName: candidate.fileName ? String(candidate.fileName) : null,
    release: candidate.release ? String(candidate.release) : null,
  };
}

function normalizedText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.(?:srt|vtt|ass|ssa|zip|gz)$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function subtitleDedupeKey(candidate: SubtitleCandidate): string {
  const url = candidate.sourceUrl.toLowerCase().split("?")[0];
  const release = normalizedText(candidate.release);
  const file = normalizedText(candidate.fileName || candidate.label);
  return `${candidate.language}|${release}|${file}|${url}`;
}

export function dedupeSubtitleCandidates(candidates: SubtitleCandidate[]): SubtitleCandidate[] {
  const seen = new Set<string>();
  const result: SubtitleCandidate[] = [];
  for (const raw of candidates) {
    const candidate = normalizeSubtitleCandidate(raw);
    if (!candidate) continue;
    const key = subtitleDedupeKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
