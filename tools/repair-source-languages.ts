#!/usr/bin/env node
/**
 * Normaliza metadata de idioma ya persistida en SourceLink.
 *
 * No toca URLs, providers, canonical locators, tiers ni estado de playback.
 * Por defecto es dry-run. --apply escribe únicamente campos de metadata.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { detectDoramasytLanguageHints, detectLanguageHints, normalizeLanguageCode } from "../server/utils/languageDetector";

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const limitRaw = Number(value("--limit"));
  return {
    apply: args.includes("--apply"),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
    reportFile: value("--report"),
  };
}

function clean(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function normalizeSubtitleTracks(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false };
  let changed = false;
  const tracks = value.map((track) => {
    if (!track || typeof track !== "object" || Array.isArray(track)) return track;
    const current = track as Record<string, unknown>;
    const raw = clean(current.language) || clean(current.lang) || clean(current.label);
    const normalized = normalizeLanguageCode(raw);
    if (!normalized) return track;
    const next = { ...current };
    if (clean(current.language) !== normalized) {
      next.language = normalized;
      changed = true;
    }
    if ("lang" in current && clean(current.lang) !== normalized) {
      next.lang = normalized;
      changed = true;
    }
    return next;
  });
  return { value: tracks, changed };
}

async function writeReport(target: string | undefined, payload: unknown): Promise<void> {
  if (!target) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const absolute = path.resolve(target);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, JSON.stringify(payload, null, 2), "utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const prisma = new PrismaClient();
  const changedRows: Array<Record<string, unknown>> = [];
  let scanned = 0;
  let changed = 0;
  let applied = 0;

  try {
    const links = await prisma.sourceLink.findMany({
      orderBy: { id: "asc" },
      take: opts.limit,
      select: {
        id: true,
        source_site: true,
        url: true,
        link_type: true,
        language: true,
        audio_language: true,
        subtitle_language: true,
        subtitles: true,
      },
    });

    for (const link of links) {
      scanned++;
      const currentRendition = clean(link.language);
      const explicitLanguageAsAudio = currentRendition && !/^(?:sub|dub)$/i.test(currentRendition)
        ? normalizeLanguageCode(currentRendition)
        : undefined;
      const normalizedAudio = normalizeLanguageCode(link.audio_language) || explicitLanguageAsAudio;
      const normalizedSubtitle = normalizeLanguageCode(link.subtitle_language);
      const tracks = normalizeSubtitleTracks(link.subtitles);
      const doramasytHints = link.source_site.toLowerCase() === "doramasyt"
        ? detectDoramasytLanguageHints(link.url)
        : undefined;
      const hints = doramasytHints || detectLanguageHints({
          title: `${link.source_site} ${link.url}`,
          url: link.url,
          link_type: link.link_type,
          language: /^(?:sub|dub)$/i.test(currentRendition || "") ? currentRendition : undefined,
          audio_language: normalizedAudio,
          subtitle_language: normalizedSubtitle,
          subtitles: tracks.value,
        });

      const nextLanguage = hints.language || (/^(?:sub|dub)$/i.test(currentRendition || "") ? currentRendition!.toLowerCase() : null);
      const nextAudio = hints.audio_language || normalizedAudio || null;
      const nextSubtitle = hints.subtitle_language || normalizedSubtitle || null;
      const fieldChanged =
        clean(link.language) !== nextLanguage ||
        clean(link.audio_language) !== nextAudio ||
        clean(link.subtitle_language) !== nextSubtitle ||
        tracks.changed;
      if (!fieldChanged) continue;

      changed++;
      changedRows.push({
        id: link.id,
        source_site: link.source_site,
        before: { language: link.language, audio_language: link.audio_language, subtitle_language: link.subtitle_language },
        after: { language: nextLanguage, audio_language: nextAudio, subtitle_language: nextSubtitle },
        subtitle_tracks_normalized: tracks.changed,
      });

      if (opts.apply) {
        const data: Record<string, any> = {
          language: nextLanguage,
          audio_language: nextAudio,
          subtitle_language: nextSubtitle,
        };
        if (tracks.changed) data.subtitles = tracks.value;
        await prisma.sourceLink.update({ where: { id: link.id }, data });
        applied++;
      }
    }

    const summary = { dryRun: !opts.apply, scanned, changed, applied };
    await writeReport(opts.reportFile, { generatedAt: new Date().toISOString(), summary, changes: changedRows });
    console.log(JSON.stringify(summary, null, 2));
    if (!opts.apply) console.log("Dry-run: usa --apply para normalizar únicamente metadata de idioma.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
