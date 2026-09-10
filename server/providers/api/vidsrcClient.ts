import * as cheerio from "cheerio";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AudioTrack, DirectStreamProvider, PlayableSource, ProviderRequest, SubtitleTrack } from "./types";
import { playableUrl } from "./types";
import { normalizeLanguageCode } from "../../utils/languageDetector";

const DEFAULT_DOMAINS = [
  "https://vidsrc.me",
  "https://vidsrc.sbs",
  "https://vidsrc.ir",
  "https://vidsrc2.ru",
  "https://vidsrcme.ru",
  "https://vidsrcme.su",
  "https://vidsrc-me.ru",
  "https://vidsrc-me.su",
  "https://vidsrc-embed.ru",
  "https://vidsrc-embed.su",
  "https://vsrc.su",
];

const DEFAULT_TIMEOUT_MS = 6500;
const MIRROR_BATCH_SIZE = 4;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const NXSHA_API_ORIGIN = "https://web.nxsha.app";
// The SBS/Pro Multi player exposes this public client-side key in its bundle.
// It is only used to decode the track catalog that the player itself requests.
const NXSHA_DATA_KEY = "S8x!Jk4ZP1uG8$my";

type FetchLike = typeof fetch;

export type VidSrcResolutionStatus =
  | "direct"
  | "embed_only"
  | "unavailable"
  | "blocked"
  | "error";

export interface VidSrcProbeResult {
  status: VidSrcResolutionStatus;
  embedUrl: string;
  playerOrigin?: string;
  hlsUrl?: string;
  audioTracks?: AudioTrack[];
  subtitles?: SubtitleTrack[];
  requiredHeaders?: Record<string, string>;
  reason?: string;
  detectedLanguage?: string | null;
  detectedLabel?: string | null;
}

type VidSrcMediaRef = {
  tmdbId: number;
  type: "movie" | "tv";
  season?: number;
  episode?: number;
};


function extractNxshaLabelTags(label: string): string[] {
  const tags: string[] = [];
  const bracketMatches = label.match(/\[([^\]]+)\]/g);
  if (bracketMatches) {
    for (const match of bracketMatches) {
      tags.push(match.replace(/^\[/, "").replace(/\]$/, "").trim());
    }
  }
  const parenMatches = label.match(/\(([^)]+)\)/g);
  if (parenMatches) {
    for (const match of parenMatches) {
      tags.push(match.replace(/^\(/, "").replace(/\)$/, "").trim());
    }
  }
  return tags;
}

const NXSHA_LANGUAGE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:spanish|espanol|español|spa|esp)\b/i, "es"],
  [/\b(?:english|ingles|inglés|eng)\b/i, "en"],
  [/\b(?:japanese|japones|japonés|jpn|日本語)\b/i, "ja"],
  [/\b(?:korean|coreano|kor|한국어)\b/i, "ko"],
  [/\b(?:chinese|chino|zho|chi|中文)\b/i, "zh"],
  [/\b(?:portuguese|portugues|português|por)\b/i, "pt"],
  [/\b(?:french|frances|francés|fra|fre)\b/i, "fr"],
  [/\b(?:german|aleman|alemán|deu|ger)\b/i, "de"],
  [/\b(?:italian|italiano|ita)\b/i, "it"],
  [/\b(?:russian|ruso|rus)\b/i, "ru"],
  [/\b(?:arabic|arabe|árabe|ara)\b/i, "ar"],
  [/\b(?:hindi|hin)\b/i, "hi"],
  [/\b(?:tamil|tam)\b/i, "ta"],
  [/\b(?:telugu|tel)\b/i, "te"],
  [/\b(?:malayalam|mal)\b/i, "ml"],
  [/\b(?:bengali|bangla|ben)\b/i, "bn"],
  [/\b(?:marathi|mar)\b/i, "mr"],
  [/\b(?:punjabi|pan)\b/i, "pa"],
  [/\b(?:kannada|kan)\b/i, "kn"],
  [/\b(?:gujarati|guj)\b/i, "gu"],
  [/\b(?:urdu|urd)\b/i, "ur"],
  [/\b(?:turkish|turco|tur)\b/i, "tr"],
];

function normalizePreferredLanguages(values: readonly string[] | undefined): string[] {
  return [...new Set((values || [])
    .map((value) => normalizeLanguageCode(value))
    .filter((value): value is string => Boolean(value)))];
}

/** Detect every concrete language advertised by an NXSHA source label. */
export function detectNxshaLanguages(label: string): string[] {
  const raw = String(label || "").trim();
  if (!raw) return [];
  const detected: string[] = [];
  const add = (value: string | undefined) => {
    if (value && value !== "multi" && !detected.includes(value)) detected.push(value);
  };

  for (const tag of extractNxshaLabelTags(raw)) add(normalizeLanguageCode(tag));
  for (const [pattern, language] of NXSHA_LANGUAGE_PATTERNS) {
    if (pattern.test(raw)) add(language);
  }

  // Some upstream labels contain only a BCP-47 code, for example `[en]` or
  // `[hi-IN]`, which is intentionally not covered by the human-name regexes.
  for (const token of raw.split(/[|,;/·\-()[\]{}]+/).map((value) => value.trim()).filter(Boolean)) {
    add(normalizeLanguageCode(token));
  }
  return detected;
}

export function detectNxshaLanguage(label: string): string | undefined {
  const languages = detectNxshaLanguages(label);
  if (languages.length > 0) return languages[0];
  return /multi[\s-]?lang/i.test(String(label || "")) ? "multi" : undefined;
}

function rankCandidateByPreferredAudio(
  detectedLang: string | undefined,
  preferredAudio: readonly string[],
): number {
  if (!detectedLang) return preferredAudio.length > 0 ? 100 : 50;
  if (detectedLang === "multi") return preferredAudio.length > 0 ? 500 : 50;
  if (preferredAudio.length === 0) return 50;
  for (let i = 0; i < preferredAudio.length; i++) {
    const pref = preferredAudio[i];
    if (detectedLang === pref || detectedLang.startsWith(pref + "-") || pref.startsWith(detectedLang + "-")) {
      return 1000 - i * 10;
    }
  }
  return 10;
}

function languageTagsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeLanguageCode(left);
  const normalizedRight = normalizeLanguageCode(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return normalizedLeft.split("-")[0] === normalizedRight.split("-")[0];
}

/**
 * VidSrc labels are only a hint, but an explicit mismatch with TMDB's
 * original language is strong evidence that the upstream scraper returned a
 * different work. Keep a source when its manifest exposes an expected audio
 * track (dubbed/multi-audio), otherwise reject the mismatched candidate before
 * it enters the provider cascade.
 */
export function isVidSrcLanguageCompatible(
  detectedLanguage: string | null | undefined,
  originalLanguage: string | null | undefined,
  preferredAudio: readonly string[] = [],
  audioTracks: readonly AudioTrack[] = [],
): boolean {
  const original = normalizeLanguageCode(originalLanguage);
  if (!original) return true;
  const preferred = normalizePreferredLanguages(preferredAudio);
  const expected = [original, ...preferred];
  const trackLanguages = audioTracks
    .map((track) => normalizeLanguageCode(track.language || track.label))
    .filter((language): language is string => Boolean(language) && language !== "multi");
  if (trackLanguages.length > 0) {
    return trackLanguages.some((language) => expected.some((wanted) => languageTagsMatch(language, wanted)));
  }
  const detected = normalizeLanguageCode(detectedLanguage);
  if (!detected || detected === "multi") return true;
  return expected.some((wanted) => languageTagsMatch(detected, wanted));
}
function parseVidSrcMediaRef(embedUrl: string): VidSrcMediaRef | null {
  try {
    const parts = new URL(embedUrl).pathname.split("/").filter(Boolean);
    const embedIndex = parts.findIndex((part) => part.toLowerCase() === "embed");
    if (embedIndex < 0) return null;
    const kind = parts[embedIndex + 1]?.toLowerCase();
    const tmdbId = Number(parts[embedIndex + 2]);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    if (kind === "movie") return { tmdbId, type: "movie" };
    if (kind !== "tv") return null;
    const season = Number(parts[embedIndex + 3]);
    const episode = Number(parts[embedIndex + 4]);
    return {
      tmdbId,
      type: "tv",
      ...(Number.isInteger(season) && season > 0 ? { season } : {}),
      ...(Number.isInteger(episode) && episode > 0 ? { episode } : {}),
    };
  } catch {
    return null;
  }
}

function deriveOpenSslKey(password: string, salt: Buffer, keyLength: number, ivLength: number): { key: Buffer; iv: Buffer } {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(chunks).length < keyLength + ivLength) {
    previous = createHash("md5")
      .update(Buffer.concat([previous, Buffer.from(password, "utf8"), salt]))
      .digest();
    chunks.push(previous);
  }
  const material = Buffer.concat(chunks);
  return {
    key: material.subarray(0, keyLength),
    iv: material.subarray(keyLength, keyLength + ivLength),
  };
}

function encodeNxshaData(value: Record<string, unknown>): string {
  const enriched = {
    ...value,
    _req_ts: Date.now(),
    _req_salt: Math.random().toString(36).substring(2, 12),
  };
  const salt = randomBytes(8);
  const { key, iv } = deriveOpenSslKey(NXSHA_DATA_KEY, salt, 32, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(enriched), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, encrypted])
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function decodeVidSrcTrackPayload(value: string): Record<string, any> | null {
  try {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const encrypted = Buffer.from(normalized, "base64");
    if (encrypted.subarray(0, 8).toString("ascii") !== "Salted__") return null;
    const salt = encrypted.subarray(8, 16);
    const { key, iv } = deriveOpenSslKey(NXSHA_DATA_KEY, salt, 32, 16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString("utf8");
    const decoded = JSON.parse(plain);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    delete decoded._req_ts;
    delete decoded._req_salt;
    return decoded;
  } catch {
    return null;
  }
}

function parseHlsAttributeList(line: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const list = line.slice(line.indexOf(":") + 1);
  const matcher = /([A-Z0-9-]+)=("(?:[^"]|"")*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(list))) {
    attributes[match[1]] = match[2].replace(/^"|"$/g, "").replace(/""/g, '"');
  }
  return attributes;
}

export function parseVidSrcHlsAudioTracks(manifest: string, manifestUrl: string): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  for (const line of String(manifest || "").split(/\r?\n/).map((value) => value.trim())) {
    if (!line.startsWith("#EXT-X-MEDIA:") || parseHlsAttributeList(line).TYPE?.toUpperCase() !== "AUDIO") continue;
    const attributes = parseHlsAttributeList(line);
    const uri = attributes.URI ? toAbsolute(attributes.URI, manifestUrl) : null;
    const groupId = attributes["GROUP-ID"] || null;
    const language = attributes.LANGUAGE || null;
    const label = attributes.NAME || language || null;
    const id = `${groupId || "audio"}:${language || label || tracks.length}`;
    if (tracks.some((track) => track.id === id || (uri && track.url === uri))) continue;
    tracks.push({
      id,
      language,
      label,
      url: uri,
      groupId,
      isDefault: attributes.DEFAULT?.toUpperCase() === "YES",
      autoselect: attributes.AUTOSELECT?.toUpperCase() === "YES",
    });
  }
  return tracks;
}

function normalizeOrigins(raw: string | undefined): string[] {
  const configured = String(raw || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter((value) => /^https?:\/\//i.test(value));
  return configured.length > 0 ? configured : DEFAULT_DOMAINS;
}

/** Returns equivalent embed locators in configured mirror order. */
export function buildVidSrcMirrorUrls(embedUrl: string): string[] {
  try {
    const parsed = new URL(embedUrl);
    const path = `${parsed.pathname}${parsed.search}`;
    const origins = normalizeOrigins(process.env.VIDSRC_ORIGINS);
    const ordered = [parsed.origin, ...origins];
    return [...new Set(ordered.map((origin) => `${origin.replace(/\/$/, "")}${path}`))];
  } catch {
    return [embedUrl];
  }
}

function buildEmbedUrl(origin: string, req: ProviderRequest): string {
  if (req.kind === "movie") return `${origin}/embed/movie/${req.tmdbId}`;
  return `${origin}/embed/tv/${req.tmdbId}/${req.season || 1}/${req.episode || 1}`;
}

function toAbsolute(value: string, base: string): string | null {
  const cleaned = String(value || "").trim().replace(/&amp;/g, "&");
  if (!cleaned) return null;
  try {
    if (cleaned.startsWith("//")) return `https:${cleaned}`;
    return new URL(cleaned, base).toString();
  } catch {
    return null;
  }
}

function extractQuotedPath(html: string, key: "src" | "file"): string | null {
  const patterns = [
    new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`, "i"),
    new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return match.replace(/\\\//g, "/");
  }
  return null;
}

function extractConfigValue(html: string, key: string): string | null {
  html = html.replace(/\\bCFG\\b/g, "CONFIG");
  const match = html.match(new RegExp(`(?:window\\.)?CONFIG\\s*=\\s*\\{[\\s\\S]*?"${key}"\\s*:\s*"([^"]+)"`, "i"))?.[1];
  const generic = html.match(new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, "i"))?.[1]
    || html.match(new RegExp(`["']${key}["']\\s*:\\s*(\\d+)`, "i"))?.[1];
  return (match || generic)?.replace(/\\u0026/g, "&").replace(/&amp;/g, "&").replace(/\\\//g, "/") || null;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function extractApiStreams(
  apiText: string,
  fetcher: FetchLike,
  headers: Record<string, string>,
): Promise<string[]> {
  let payload: any;
  try {
    payload = JSON.parse(apiText);
  } catch {
    return [];
  }
  const raw = payload?.data?.stream_urls;
  if (Array.isArray(raw)) return raw.filter((value: unknown): value is string => typeof value === "string");
  if (typeof raw !== "string" || !payload?.vs?.wasm_url) return [];

  const wasm = await fetcher(payload.vs.wasm_url, { redirect: "follow", headers });
  if (!wasm.ok) return [];
  const bytes = new Uint8Array(await wasm.arrayBuffer());
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as unknown as {
    alloc?: (length: number) => number;
    decrypt?: (pointer: number, length: number) => number;
    memory?: WebAssembly.Memory;
  };
  if (!exports.alloc || !exports.decrypt || !exports.memory) return [];
  const encrypted = decodeBase64(raw);
  const pointer = exports.alloc(encrypted.length);
  new Uint8Array(exports.memory.buffer, pointer, encrypted.length).set(encrypted);
  const outputLength = exports.decrypt(pointer, encrypted.length);
  const output = new Uint8Array(exports.memory.buffer, pointer + 12, outputLength);
  return new TextDecoder().decode(output).split("\n").filter(Boolean);
}

async function fetchText(
  fetcher: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
      finalUrl: response.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function firstMediaLine(text: string): string | undefined {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Checks the same delivery path that the internal player will use. A signed
 * URL is only considered playable when its playlist is valid and its first
 * child resource returns media bytes; Cloudflare/error HTML must never be
 * advertised as a direct VidSrc source.
 */
export async function isVidSrcHlsUsable(
  hlsUrl: string | undefined,
  requiredHeaders: Record<string, string> | undefined,
  fetcher: FetchLike = fetch,
): Promise<boolean> {
  if (!hlsUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  const headers = {
    Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
    ...(requiredHeaders || {}),
  };
  const read = async (url: string, extraHeaders?: Record<string, string>) => {
    const response = await fetcher(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { ...headers, ...(extraHeaders || {}) },
    });
    return { response, text: await response.text() };
  };
  try {
    const master = await read(hlsUrl);
    if (!master.response.ok || !master.text.includes("#EXTM3U")) return false;
    const isMaster = /#EXT-X-STREAM-INF:/i.test(master.text);
    let mediaPlaylist = master.text;
    let mediaPlaylistUrl = master.response.url || hlsUrl;
    if (isMaster) {
      const first = firstMediaLine(master.text);
      if (!first) return true;
      const childUrl = new URL(first, mediaPlaylistUrl).toString();
      const child = await read(childUrl);
      if (!child.response.ok || !child.text.includes("#EXTM3U")) return false;
      mediaPlaylist = child.text;
      mediaPlaylistUrl = child.response.url || childUrl;
    }
    const segment = firstMediaLine(mediaPlaylist);
    if (!segment) return true;

    const segmentResponse = await fetcher(
      new URL(segment, mediaPlaylistUrl).toString(),
      {
        redirect: "follow",
        signal: controller.signal,
        headers: { ...headers, Accept: "*/*", Range: "bytes=0-1023" },
      },
    );
    if (segmentResponse.status < 200 || segmentResponse.status >= 300) return false;
    const bytes = new Uint8Array(await segmentResponse.arrayBuffer()).subarray(0, 32);
    if (bytes.length === 0) return false;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = png.every((value, index) => bytes[index] === value);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const prefix = new TextDecoder().decode(bytes).trimStart().toLowerCase();
    return !isPng && !isJpeg && !prefix.startsWith("<html") && !prefix.startsWith("<!doctype");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVidSrcSubtitles(
  embedUrl: string,
  fetcher: FetchLike,
  referer: string,
  preferredSubtitles: readonly string[] = [],
): Promise<SubtitleTrack[]> {
  const media = parseVidSrcMediaRef(embedUrl);
  if (!media) return [];
  const query = encodeNxshaData({
    tmdbId: media.tmdbId,
    type: media.type,
    ...(media.season ? { season: media.season } : {}),
    ...(media.episode ? { episode: media.episode } : {}),
  });
  const response = await fetchText(fetcher, `${NXSHA_API_ORIGIN}/api/subtitles?q=${encodeURIComponent(query)}`, {
    Accept: "application/json",
    "User-Agent": DEFAULT_UA,
    Referer: referer || `${NXSHA_API_ORIGIN}/`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  });
  if (!response.ok) return [];

  let payload: any;
  try { payload = JSON.parse(response.text); } catch { return []; }
  const decoded = typeof payload?._hash === "string" ? decodeVidSrcTrackPayload(payload._hash) : null;
  const rawTracks = Array.isArray(decoded?.subtitles) ? decoded.subtitles : [];
  const tracks = rawTracks
    .map((track: any, index: number): SubtitleTrack | null => {
      const url = String(track?.uri || track?.url || track?.src || "").trim();
      if (!/^https?:\/\//i.test(url)) return null;
      const rawLanguage = String(track?.language || track?.lang || "").trim();
      return {
        language: normalizeLanguageCode(rawLanguage) || rawLanguage || "und",
        label: String(track?.title || track?.label || rawLanguage || `Subtítulo ${index + 1}`).trim(),
        url,
      };
    })
    .filter((track: SubtitleTrack | null): track is SubtitleTrack => Boolean(track));
  const preferred = normalizePreferredLanguages(preferredSubtitles);
  if (preferred.length === 0) return tracks;
  const rank = (track: SubtitleTrack) => {
    const language = normalizeLanguageCode(track.language) || track.language || "und";
    const index = preferred.findIndex((value) => language === value || language.startsWith(`${value}-`) || value.startsWith(`${language}-`));
    return index < 0 ? preferred.length + 1 : index;
  };
  return tracks
    .map((track, index) => ({ track, index, rank: rank(track) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ track }) => track);
}

async function inspectVidSrcTracks(
  embedUrl: string,
  hlsUrl: string,
  fetcher: FetchLike,
  requiredHeaders: Record<string, string>,
  playerReferer: string,
  preferredSubtitles: readonly string[] = [],
): Promise<{ audioTracks: AudioTrack[]; subtitles: SubtitleTrack[] }> {
  const [manifest, subtitles] = await Promise.all([
    fetchText(fetcher, hlsUrl, {
      Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8",
      ...requiredHeaders,
      "Sec-Fetch-Dest": "empty",
    }).catch(() => null),
    fetchVidSrcSubtitles(embedUrl, fetcher, playerReferer, preferredSubtitles).catch(() => []),
  ]);
  const audioTracks = manifest?.ok ? parseVidSrcHlsAudioTracks(manifest.text, manifest.finalUrl || hlsUrl) : [];
  return { audioTracks, subtitles };
}

async function enrichDirectResult(
  embedUrl: string,
  hlsUrl: string,
  fetcher: FetchLike,
  requiredHeaders: Record<string, string>,
  playerReferer: string,
  preferredSubtitles: readonly string[] = [],
): Promise<Pick<VidSrcProbeResult, "audioTracks" | "subtitles">> {
  const tracks = await inspectVidSrcTracks(embedUrl, hlsUrl, fetcher, requiredHeaders, playerReferer, preferredSubtitles);
  return {
    ...(tracks.audioTracks.length > 0 ? { audioTracks: tracks.audioTracks } : {}),
    ...(tracks.subtitles.length > 0 ? { subtitles: tracks.subtitles } : {}),
  };
}

async function resolveNxshaMultiLang(
  embedUrl: string,
  fetcher: FetchLike,
  preferredAudio: string[] = [],
  preferredSubtitles: readonly string[] = [],
): Promise<VidSrcProbeResult | null> {
  const media = parseVidSrcMediaRef(embedUrl);
  if (!media) return null;
  const playerUrl = `${NXSHA_API_ORIGIN}/embed/${media.type === "movie" ? "movie" : "tv"}/${media.tmdbId}${media.type === "tv" ? `/${media.season || 1}/${media.episode || 1}` : ""}?server=AwsPly-[Multi-Lang]`;
  const apiHeaders = {
    Accept: "application/json",
    "User-Agent": DEFAULT_UA,
    Referer: playerUrl,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };

  try {
    const query = encodeNxshaData({
      tmdbId: media.tmdbId,
      type: media.type,
      ...(media.season ? { season: media.season } : {}),
      ...(media.episode ? { episode: media.episode } : {}),
    });
    const serversResponse = await fetchText(fetcher, `${NXSHA_API_ORIGIN}/api/servers?q=${encodeURIComponent(query)}`, apiHeaders);
    if (!serversResponse.ok) return null;
    const serverPayload = JSON.parse(serversResponse.text);
    const serverData = typeof serverPayload?._hash === "string" ? decodeVidSrcTrackPayload(serverPayload._hash) : null;
    const servers = Array.isArray(serverData?.servers)
      ? serverData.servers.filter((server: any) => server?.web_support !== false && server?.isDisable !== true && typeof server?.scraper === "string")
      : [];
    servers.sort((left: any, right: any) => {
      const rank = (server: any) => {
        const name = String(server?.name || "").toLowerCase();
        return (name.includes("nitro") ? 200 : 0) + (name.includes("multi-lang") ? 100 : 0) + (server?.default ? 20 : 0) + Number(server?.high_priority || 0);
      };
      return rank(right) - rank(left);
    });

    let bestCandidate: {
      playable: { url: string; streamType: "hls" };
      score: number;
      detectedLanguage: string | null;
      detectedLabel: string;
    } | null = null;

    for (const server of servers.slice(0, 12)) {
      const sourceQuery = encodeNxshaData({
        ex_lang: false,
        provider: server.scraper,
        tmdbId: media.tmdbId,
        imdb_id: "",
        type: media.type,
        ...(media.season ? { season: media.season } : {}),
        ...(media.episode ? { episode: media.episode } : {}),
      });
      const sourceResponse = await fetchText(fetcher, `${NXSHA_API_ORIGIN}/api/sources?q=${encodeURIComponent(sourceQuery)}`, apiHeaders);
      if (!sourceResponse.ok) continue;
      let sourcePayload: any;
      try { sourcePayload = JSON.parse(sourceResponse.text); } catch { continue; }
      const sourceData = typeof sourcePayload?._hash === "string" ? decodeVidSrcTrackPayload(sourcePayload._hash) : null;
      const candidates = Array.isArray(sourceData?.sources)
        ? sourceData.sources
          .map((source: any) => ({
            source,
            playable: playableUrl(source?.url, source?.type),
            label: String(source?.label || source?.quality || "").trim(),
          }))
          .filter((candidate: any) => candidate.playable?.streamType === "hls")
        : [];
      candidates.sort((left: any, right: any) => {
        const leftLang = detectNxshaLanguage(left.label || "");
        const rightLang = detectNxshaLanguage(right.label || "");
        const leftScore = rankCandidateByPreferredAudio(leftLang, preferredAudio);
        const rightScore = rankCandidateByPreferredAudio(rightLang, preferredAudio);
        if (rightScore !== leftScore) return rightScore - leftScore;
        const fallback = (candidate: any) => candidate.label.includes("english") ? 20 : candidate.label.includes("multi") ? 10 : 0;
        return fallback(right) - fallback(left);
      });

      for (const candidate of candidates.slice(0, 3)) {
        const playable = candidate.playable;
        if (!playable) continue;
        const detectedLanguages = detectNxshaLanguages(candidate.label || "");
        const detectedLanguage = detectedLanguages[0] || (detectNxshaLanguage(candidate.label || "") === "multi" ? "multi" : null);
        const score = rankCandidateByPreferredAudio(detectedLanguage || undefined, preferredAudio);
        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = {
            playable,
            score,
            detectedLanguage,
            detectedLabel: candidate.label,
          };
        }
      }

      // An exact match is already the best possible outcome. Stop querying
      // later scrapers, keeping the preference-aware path bounded in latency.
      if (bestCandidate?.score >= 1000) break;
    }

    if (bestCandidate) {
      const requiredHeaders = {
        Referer: playerUrl,
        "User-Agent": DEFAULT_UA,
        "Sec-Fetch-Dest": "iframe",
      };
      const tracks = await enrichDirectResult(
        embedUrl,
        bestCandidate.playable.url,
        fetcher,
        requiredHeaders,
        playerUrl,
        preferredSubtitles,
      );
      return {
        status: "direct",
        embedUrl,
        playerOrigin: NXSHA_API_ORIGIN,
        hlsUrl: bestCandidate.playable.url,
        ...tracks,
        requiredHeaders,
        detectedLanguage: bestCandidate.detectedLanguage,
        detectedLabel: bestCandidate.detectedLabel,
      };
    }
  } catch {
    // The SBS player is an optional multilang path. The regular VidSrc mirrors
    // remain the fallback when its API or an upstream scraper is unavailable.
  }
  return null;
}

/**
 * Resolves the public VidSrc embed chain only. It never returns an iframe as
 * playable media: the successful terminal state must be a native HLS URL.
 */
export async function resolveVidSrcEmbed(
  embedUrl: string,
  fetcher: FetchLike = fetch,
  options: {
    preferredAudio?: readonly string[];
    preferredSubtitles?: readonly string[];
  } = {},
): Promise<VidSrcProbeResult> {
  const baseHeaders: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": DEFAULT_UA,
  };

  try {
    const landing = await fetchText(fetcher, embedUrl, baseHeaders);
    if (landing.status === 401 || landing.status === 403 || landing.status === 429) {
      return { status: "blocked", embedUrl, reason: `embed_http_${landing.status}` };
    }
    if (!landing.ok) {
      return { status: landing.status === 404 ? "unavailable" : "error", embedUrl, reason: `embed_http_${landing.status}` };
    }

    const $ = cheerio.load(landing.text);
    const iframe = $("iframe[src], iframe[data-api]").first();
    const iframeSrc = iframe.attr("src") || "";
    const iframeApi = iframe.attr("data-api") || "";
    const playerUrl = toAbsolute(iframeSrc, landing.finalUrl);
    const apiUrl = toAbsolute(iframeApi, landing.finalUrl);
    if (!playerUrl && apiUrl) {
      const apiResponse = await fetchText(fetcher, apiUrl, {
        ...baseHeaders,
        Referer: `${new URL(landing.finalUrl).origin}/`,
        "Sec-Fetch-Dest": "empty",
      });
      if (apiResponse.ok) {
        try {
          const apiPayload = JSON.parse(apiResponse.text);
          const apiPlayer = typeof apiPayload?.src === "string" ? apiPayload.src : "";
          const resolvedApiPlayer = toAbsolute(apiPlayer, apiResponse.finalUrl);
          if (resolvedApiPlayer) {
            const nestedPlayer = await fetchText(fetcher, resolvedApiPlayer, {
              ...baseHeaders,
              Referer: `${new URL(landing.finalUrl).origin}/`,
              "Sec-Fetch-Site": "cross-site",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Dest": "iframe",
            });
            if (nestedPlayer.ok) {
              const nestedStreamPlayer = extractConfigValue(nestedPlayer.text, "playerUrl");
              let streamPlayerText = nestedPlayer.text;
              let streamPlayerFinalUrl = nestedPlayer.finalUrl;
              if (nestedStreamPlayer) {
                const streamPlayerUrl = toAbsolute(nestedStreamPlayer, nestedPlayer.finalUrl);
                if (streamPlayerUrl) {
                  const streamPlayer = await fetchText(fetcher, streamPlayerUrl, {
                    ...baseHeaders,
                    Referer: `${new URL(resolvedApiPlayer).origin}/`,
                    "Sec-Fetch-Site": "same-origin",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Dest": "iframe",
                  });
                  if (streamPlayer.ok) {
                    streamPlayerText = streamPlayer.text;
                    streamPlayerFinalUrl = streamPlayer.finalUrl;
                  }
                }
              }
              const streamApi = extractConfigValue(streamPlayerText, "api") || (() => {
                const streamBase = extractConfigValue(streamPlayerText, "streamBase");
                const season = extractConfigValue(streamPlayerText, "season");
                const episode = extractConfigValue(streamPlayerText, "episode");
                return streamBase && season && episode
                  ? `${streamBase}&season=${encodeURIComponent(season)}&episode=${encodeURIComponent(episode)}&stream_urls`
                  : null;
              })();
              if (streamApi) {
                const streamResponse = await fetchText(fetcher, streamApi, {
                  ...baseHeaders,
                  Accept: "application/json",
                  Referer: `${new URL(streamPlayerFinalUrl).origin}/`,
                  "Sec-Fetch-Dest": "empty",
                });
                const streams = await extractApiStreams(streamResponse.text, fetcher, {
                  ...baseHeaders,
                  Referer: `${new URL(resolvedApiPlayer).origin}/`,
                  "Sec-Fetch-Dest": "empty",
                });
                const stream = streams.map((value) => playableUrl(toAbsolute(value, streamResponse.finalUrl) || value, "hls"))
                  .find((value) => value?.streamType === "hls");
                if (stream) {
                  let signedHlsUrl = stream.url;
                  try {
                    const streamOrigin = new URL(stream.url).origin;
                    const tokenResponse = await fetcher(`${streamOrigin}/generate.php`, {
                      redirect: "follow",
                      headers: {
                        ...baseHeaders,
                        Referer: streamPlayerFinalUrl,
                        "Sec-Fetch-Dest": "empty",
                      },
                    });
                    if (tokenResponse.ok) {
                      const tokenText = (await tokenResponse.text()).trim();
                      let token = tokenText;
                      try {
                        const tokenPayload = JSON.parse(tokenText);
                        token = typeof tokenPayload === "string"
                          ? tokenPayload
                          : String(tokenPayload?.token || tokenPayload?.data || tokenPayload?.result || "");
                      } catch {
                        // Plain-text token.
                      }
                      if (token) signedHlsUrl = `${stream.url}${stream.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
                    }
                  } catch {
                    // The raw stream remains a useful fallback when token minting is unavailable.
                  }
                  const requiredHeaders = {
                    Referer: streamPlayerFinalUrl,
                    "User-Agent": DEFAULT_UA,
                    "Sec-Fetch-Dest": "iframe",
                  };
                  return {
                    status: "direct",
                    embedUrl,
                    playerOrigin: new URL(resolvedApiPlayer).origin,
                    hlsUrl: signedHlsUrl,
                    ...(await enrichDirectResult(embedUrl, signedHlsUrl, fetcher, requiredHeaders, streamPlayerFinalUrl, options.preferredSubtitles)),
                    requiredHeaders,
                  };
                }
              }
            }
          }
        } catch {
          // Fall through to the legacy iframe/server-hash resolver.
        }
      }
    }
    if (!playerUrl) {
      const multiLang = await resolveNxshaMultiLang(
        embedUrl,
        fetcher,
        normalizePreferredLanguages(options.preferredAudio),
        options.preferredSubtitles || [],
      );
      if (multiLang) return multiLang;
      return { status: "embed_only", embedUrl, reason: "player_iframe_not_found" };
    }

    const playerOrigin = new URL(playerUrl).origin;
    const playerHeaders: Record<string, string> = {
      ...baseHeaders,
      Referer: `${playerOrigin}/`,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    };
    const player = await fetchText(fetcher, playerUrl, playerHeaders);
    if (!player.ok) {
      return {
        status: player.status === 401 || player.status === 403 || player.status === 429 ? "blocked" : "embed_only",
        embedUrl,
        playerOrigin,
        reason: `player_http_${player.status}`,
      };
    }

    const player$ = cheerio.load(player.text);
    const serverHashes = player$(".serversList .server[data-hash], .server[data-hash]")
      .map((_, element) => player$(element).attr("data-hash") || "")
      .get()
      .map((value) => value.trim())
      .filter(Boolean);

    // Some layouts expose a terminal source directly in the player HTML.
    const immediate = extractQuotedPath(player.text, "file");
    const immediateUrl = immediate ? toAbsolute(immediate, player.finalUrl) : null;
    const immediatePlayable = immediateUrl ? playableUrl(immediateUrl, "hls") : null;
    if (immediatePlayable) {
      const requiredHeaders = {
        Referer: `${playerOrigin}/`,
        "User-Agent": DEFAULT_UA,
        "Sec-Fetch-Dest": "iframe",
      };
      return {
        status: "direct",
        embedUrl,
        playerOrigin,
        hlsUrl: immediatePlayable.url,
        ...(await enrichDirectResult(embedUrl, immediatePlayable.url, fetcher, requiredHeaders, `${playerOrigin}/`, options.preferredSubtitles)),
        requiredHeaders,
      };
    }

    if (serverHashes.length === 0) {
      return { status: "embed_only", embedUrl, playerOrigin, reason: "server_hashes_not_found" };
    }

    const serverResults = await Promise.allSettled(serverHashes.map(async (hash) => {
      const rcpUrl = new URL(`/rcp/${encodeURIComponent(hash)}`, playerOrigin).toString();
      const rcp = await fetchText(fetcher, rcpUrl, {
        ...playerHeaders,
        "Sec-Fetch-Dest": "empty",
      });
      if (!rcp.ok) return null;

      const sourcePath = extractQuotedPath(rcp.text, "src");
      if (!sourcePath) return null;
      const sourceUrl = toAbsolute(sourcePath, playerOrigin);
      if (!sourceUrl) return null;

      let terminalUrl = sourceUrl;
      if (new URL(sourceUrl).pathname.startsWith("/prorcp/")) {
        const terminal = await fetchText(fetcher, sourceUrl, {
          ...playerHeaders,
          "Sec-Fetch-Dest": "empty",
        });
        if (!terminal.ok) return null;
        const file = extractQuotedPath(terminal.text, "file");
        const absoluteFile = file ? toAbsolute(file, terminal.finalUrl) : null;
        if (!absoluteFile) return null;
        terminalUrl = absoluteFile;
      }

      const playable = playableUrl(terminalUrl, "hls");
      return playable?.streamType === "hls" ? playable.url : null;
    }));

    const hlsUrl = serverResults.find(
      (result): result is PromiseFulfilledResult<string | null> => result.status === "fulfilled" && Boolean(result.value),
    );
    if (!hlsUrl?.value) {
      return { status: "embed_only", embedUrl, playerOrigin, reason: "no_native_hls_from_servers" };
    }

    const requiredHeaders = {
      Referer: `${playerOrigin}/`,
      "User-Agent": DEFAULT_UA,
      "Sec-Fetch-Dest": "iframe",
    };
    return {
      status: "direct",
      embedUrl,
      playerOrigin,
      hlsUrl: hlsUrl.value,
      ...(await enrichDirectResult(embedUrl, hlsUrl.value, fetcher, requiredHeaders, `${playerOrigin}/`, options.preferredSubtitles)),
      requiredHeaders,
    };
  } catch (error) {
    return {
      status: "error",
      embedUrl,
      reason: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

export class VidSrcClient implements DirectStreamProvider {
  readonly id = "vidsrc";
  // Anime titles are TMDB TV works from the gateway's point of view. Keeping
  // this in the direct provider means a public TMDB anime card can resolve
  // without importing a local scraper row first.
  readonly kinds = ["movie", "series", "anime"] as const;

  private readonly origins: string[];
  private readonly fetcher: FetchLike;

  constructor(
    origins = normalizeOrigins(process.env.VIDSRC_ORIGINS),
    fetcher: FetchLike = fetch,
  ) {
    this.origins = origins;
    this.fetcher = fetcher;
  }

  async resolve(req: ProviderRequest): Promise<PlayableSource[]> {
    if (!this.kinds.includes(req.kind as any)) return [];
    const sources: PlayableSource[] = [];

    // Mirrors are queried in bounded batches. The old all-at-once strategy made
    // a blocked shared CDN consume every socket and delayed the UI for a minute;
    // the first healthy batch is enough because mirrors are equivalent locators.
    for (let offset = 0; offset < this.origins.length && sources.length === 0; offset += MIRROR_BATCH_SIZE) {
      const batch = this.origins.slice(offset, offset + MIRROR_BATCH_SIZE);
      const attempts = await Promise.allSettled(
        batch.map(async (origin) => {
          const result = await resolveVidSrcEmbed(buildEmbedUrl(origin, req), this.fetcher, {
            preferredAudio: req.preferredAudio,
            preferredSubtitles: req.preferredSubtitles,
          });
          const usable = result.status === "direct" && Boolean(result.hlsUrl)
            && await isVidSrcHlsUsable(result.hlsUrl, result.requiredHeaders, this.fetcher);
          return { result, usable };
        }),
      );
      const directHosts = new Set<string>();
      for (const attempt of attempts) {
        if (attempt.status !== "fulfilled") continue;
        const result = attempt.value.result;
        if (result.hlsUrl) {
          try { directHosts.add(new URL(result.hlsUrl).hostname); } catch { /* malformed result */ }
        }
        if (!attempt.value.usable) continue;
        if (!isVidSrcLanguageCompatible(
          result.detectedLanguage,
          req.originalLanguage,
          req.preferredAudio,
          result.audioTracks,
        )) continue;
        const playable = playableUrl(result.hlsUrl, "hls");
        if (!playable) continue;
        const preferredAudio = (req.preferredAudio?.length ? req.preferredAudio
          .map((preference) => normalizeLanguageCode(preference))
          .filter((value): value is string => Boolean(value))
          .map((preference) => result.audioTracks?.find((track) => {
            const language = normalizeLanguageCode(track.language);
            return Boolean(language && (language === preference || language.startsWith(`${preference}-`) || preference.startsWith(`${language}-`)));
          }))
          .find(Boolean) : undefined)
          || result.audioTracks?.find((track) => track.isDefault)
          || result.audioTracks?.[0];
        const detectedLang = result.detectedLanguage;
        sources.push({
          provider: this.id,
          providerGroup: "api",
          url: playable.url,
          streamType: playable.streamType,
          audioLanguage: normalizeLanguageCode(preferredAudio?.language) || detectedLang || null,
          audioTracks: result.audioTracks,
          subtitleLanguage: null,
          subtitles: result.subtitles || [],
          requiredHeaders: result.requiredHeaders,
          canonicalLocator: result.embedUrl,
          sourceStatus: "resolved",
          score: 85,
        });
      }
      // Different VidSrc mirrors often point to the same terminal CDN. Once
      // that CDN has failed validation, querying the remaining equivalent
      // locators only adds latency and load without increasing coverage.
      if (sources.length === 0 && directHosts.size === 1) break;
    }

    const deduped = new Map<string, PlayableSource>();
    for (const source of sources) {
      if (!deduped.has(source.url)) deduped.set(source.url, source);
    }
    return [...deduped.values()];
  }
}
