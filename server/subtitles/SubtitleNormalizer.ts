import { normalizeLanguageCode } from "../utils/languageDetector";
import type { SubtitleCandidate, SubtitleFormat } from "./types";

const LANGUAGE_LABELS: Record<string, string> = {
  "es-419": "Español Latino",
  "es-ES": "Español (España)",
  es: "Español",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  zh: "中文",
  "zh-Hans": "中文 (简体)",
  "zh-Hant": "中文 (繁體)",
  pt: "Português",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  ru: "Русский",
  ar: "العربية",
  hi: "हिन्दी",
  tr: "Türkçe",
};

export function normalizeSubtitleLanguage(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return normalizeLanguageCode(raw) || raw.toLowerCase().replace(/_/g, "-");
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

function inferAccessibilityFlags(candidate: SubtitleCandidate): Pick<SubtitleCandidate, "hearingImpaired" | "forced"> {
  const text = [candidate.label, candidate.fileName, candidate.release]
    .map((value) => String(value || ""))
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ");

  const hearingImpaired = candidate.hearingImpaired ?? /(?:^|[\s._()[\]-])(?:sdh|cc|hearing[\s._-]*impaired|closed[\s._-]*captions?)(?:$|[\s._()[\]-])/i.test(text);
  const forced = candidate.forced ?? /(?:^|[\s._()[\]-])(?:forced|forzado|forzada|forzados|forzadas)(?:$|[\s._()[\]-])/i.test(text);
  return { hearingImpaired, forced };
}

function enrichLabel(candidate: SubtitleCandidate, language: string, flags: Pick<SubtitleCandidate, "hearingImpaired" | "forced">): string {
  const raw = String(candidate.label || "").trim();
  const base = raw || subtitleLanguageLabel(language);
  const suffixes: string[] = [];
  if (flags.forced && !/(?:forced|forzad)/i.test(base)) suffixes.push("Forzado");
  if (flags.hearingImpaired && !/(?:\bsdh\b|\bcc\b|hearing|closed captions?)/i.test(base)) suffixes.push("SDH");
  return suffixes.length > 0 ? `${base} · ${suffixes.join(" · ")}` : base;
}

export function normalizeSubtitleCandidate(candidate: SubtitleCandidate): SubtitleCandidate | null {
  const sourceUrl = String(candidate.sourceUrl || "").trim();
  const language = normalizeSubtitleLanguage(candidate.language);
  if (!language || !/^https:\/\//i.test(sourceUrl)) return null;
  const format = normalizeSubtitleFormat(candidate.format, sourceUrl);
  const flags = inferAccessibilityFlags(candidate);
  return {
    ...candidate,
    id: String(candidate.id || `${candidate.provider}:${sourceUrl}`),
    provider: String(candidate.provider || "unknown"),
    language,
    label: enrichLabel(candidate, language, flags),
    sourceUrl,
    format,
    fileName: candidate.fileName ? String(candidate.fileName) : null,
    release: candidate.release ? String(candidate.release) : null,
    hearingImpaired: flags.hearingImpaired,
    forced: flags.forced,
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
  const flags = `${candidate.forced ? "forced" : "full"}|${candidate.hearingImpaired ? "sdh" : "standard"}`;
  return `${candidate.language}|${flags}|${release}|${file}|${url}`;
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
