import { gunzipSync, unzipSync } from "fflate";
import * as chardet from "chardet";
import iconv from "iconv-lite";
import { compile } from "ass-compiler";
import { parseSync, stringifySync } from "subtitle";
import { randomUUID } from "node:crypto";
import { SubtitleCache } from "./SubtitleCache";
import type { SubtitleCandidate } from "./types";

const MAX_BYTES = Math.max(256 * 1024, Number(process.env.SUBTITLE_PROXY_MAX_BYTES || 12 * 1024 * 1024));
const MAX_REDIRECTS = 4;
const CACHE_TTL_MS = Math.max(60 * 60_000, Number(process.env.SUBTITLE_PROXY_CACHE_TTL_MS || 7 * 24 * 60 * 60_000));

const ALLOWED_HOSTS: Record<string, string[]> = {
  "opensubtitles-v3": ["opensubtitles-v3.strem.io", "opensubtitles.stremio.homes", "opensubtitles.strem.io", "subs5.strem.io", "dl.opensubtitles.org"],
  yify: ["www.yifysubtitles.ch", "yifysubtitles.ch", "yts-subs.com", "www.yts-subs.com"],
  tvsubtitles: ["www.tvsubtitles.net", "tvsubtitles.net"],
  subtitlecat: ["subtitlecat.com", "www.subtitlecat.com"],
  // Zoko publishes sidecar VTT files from the same Aniwatch CDN family as
  // its HLS manifest. Keep this narrow allowlist; arbitrary subtitle hosts
  // are still rejected by the proxy.
  zokoanime: ["hls1.aniwatchtv.uk", "hls2.aniwatchtv.uk", "aniwatchtv.uk"],
};

interface ProxyEntry {
  candidate: SubtitleCandidate;
  expiresAt: number;
}

export interface SubtitleProxyResponse {
  body: Buffer;
  contentType: "text/vtt; charset=utf-8";
  cacheHit: boolean;
  provider: string;
  format: string;
}

export class SubtitleProxy {
  private readonly entries = new Map<string, ProxyEntry>();
  private readonly bodyCache = new SubtitleCache<{ body: Buffer; format: string }>(512);

  constructor(private readonly timeoutMs = Math.max(1_000, Number(process.env.SUBTITLE_PROXY_TIMEOUT_MS || 15_000))) {}

  register(candidate: SubtitleCandidate): string | null {
    if (!this.isAllowed(candidate.provider, candidate.sourceUrl)) return null;
    const id = randomUUID().replace(/-/g, "");
    this.entries.set(id, { candidate: { ...candidate }, expiresAt: Date.now() + CACHE_TTL_MS });
    this.trimEntries();
    return `/api/v1/subtitles/file/${id}.vtt`;
  }

  async serve(token: string): Promise<SubtitleProxyResponse | null> {
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.entries.delete(token);
      return null;
    }
    const cacheKey = `${entry.candidate.provider}:${entry.candidate.sourceUrl}`;
    const cached = this.bodyCache.get(cacheKey);
    if (cached) {
      return { body: cached.body, contentType: "text/vtt; charset=utf-8", cacheHit: true, provider: entry.candidate.provider, format: cached.format };
    }

    const downloaded = await this.download(entry.candidate);
    if (!downloaded) return null;
    const converted = convertSubtitleBuffer(downloaded, entry.candidate);
    if (!converted) return null;
    this.bodyCache.set(cacheKey, converted, CACHE_TTL_MS);
    return { body: converted.body, contentType: "text/vtt; charset=utf-8", cacheHit: false, provider: entry.candidate.provider, format: converted.format };
  }

  get size(): number {
    return this.entries.size;
  }

  private async download(candidate: SubtitleCandidate): Promise<Buffer | null> {
    let url = candidate.sourceUrl;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      if (!this.isAllowed(candidate.provider, url)) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          redirect: "manual",
          headers: { Accept: "application/zip, application/gzip, text/vtt, text/plain, */*", "User-Agent": "MeriStream/1.0", ...(candidate.sourceHeaders || {}) },
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirect >= MAX_REDIRECTS) return null;
          url = new URL(location, url).toString();
          continue;
        }
        if (!response.ok) return null;
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_BYTES) return null;
        const data = Buffer.from(await response.arrayBuffer());
        return data.length <= MAX_BYTES ? data : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  private isAllowed(provider: string, rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") return false;
      const host = url.hostname.toLowerCase();
      return (ALLOWED_HOSTS[provider] || []).some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  }

  private trimEntries(): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= Date.now()) this.entries.delete(id);
    }
    while (this.entries.size > 2_048) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

function convertSubtitleBuffer(input: Buffer, candidate: SubtitleCandidate): { body: Buffer; format: string } | null {
  let data = input;
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    try { data = Buffer.from(gunzipSync(data)); } catch { return null; }
  }
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(data); } catch { return null; }
    const entries = Object.entries(files).filter(([name]) => /\.(?:srt|vtt|ass|ssa)$/i.test(name));
    if (entries.length === 0) return null;
    const preferred = candidate.fileName ? entries.find(([name]) => name.toLowerCase().includes(candidate.fileName!.toLowerCase().replace(/\.(?:zip|gz)$/i, ""))) : undefined;
    data = Buffer.from((preferred || entries.find(([name]) => /\.srt$/i.test(name)) || entries[0])[1]);
  }

  const text = decodeSubtitle(data);
  if (!text.trim()) return null;
  const format = detectFormat(text, candidate.format, candidate.fileName);
  try {
    if (format === "ass" || format === "ssa") return { body: Buffer.from(assToVtt(text), "utf8"), format };
    const nodes = parseSync(text);
    if (!nodes.some((node: any) => node?.type === "cue")) return null;
    return { body: Buffer.from(stringifySync(nodes, { format: "WebVTT" }), "utf8"), format };
  } catch {
    return null;
  }
}

function decodeSubtitle(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString("utf8");
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return iconv.decode(data, "utf16-le").replace(/^\uFEFF/, "");
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return iconv.decode(data, "utf16-be").replace(/^\uFEFF/, "");
  const detected = String(chardet.detect(data) || "").toLowerCase();
  const encoding = detected.includes("1252") || detected.includes("latin") || detected.includes("iso-8859-1")
    ? "windows-1252"
    : detected.includes("1251") ? "windows-1251" : "utf8";
  const decoded = iconv.decode(data, encoding);
  return decoded.replace(/^\uFEFF/, "");
}

function detectFormat(text: string, declared?: string, fileName?: string | null): "srt" | "vtt" | "ass" | "ssa" {
  const value = String(declared || fileName || "").toLowerCase();
  if (value.includes("ass") || value.includes("ssa") || /^\s*\[script info\]/i.test(text)) return "ass";
  if (value.includes("vtt") || /^\s*webvtt/i.test(text)) return "vtt";
  return "srt";
}

function assToVtt(source: string): string {
  const parsed = compile(source) as any;
  const cues: string[] = ["WEBVTT", ""];
  let index = 0;
  for (const dialogue of parsed.dialogues || []) {
    const text = (dialogue.slices || []).flatMap((slice: any) => (slice.fragments || []).map((fragment: any) => String(fragment.text || "")))
      .join("")
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\h/g, " ")
      .replace(/\{[^}]*\}/g, "")
      .trim();
    if (!text) continue;
    index += 1;
    cues.push(String(index), `${formatAssTime(dialogue.start)} --> ${formatAssTime(dialogue.end)}`, text, "");
  }
  return `${cues.join("\n")}\n`;
}

function formatAssTime(value: unknown): string {
  const seconds = Math.max(0, Number(value) || 0);
  const totalMs = Math.round(seconds * 1_000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
