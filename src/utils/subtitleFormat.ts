const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** Remove presentation markup/entities that should not be visible as text. */
export function sanitizeSubtitleText(input: string): string {
  return String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(Math.min(codePoint, 0x10ffff)) : _match;
    })
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(Math.min(codePoint, 0x10ffff)) : _match;
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITY_MAP[name.toLowerCase()] || match)
    // ASS/SSA alignment and override tags occasionally arrive inside an
    // otherwise valid SRT/WebVTT cue (for example `{an8}Texto`). They are
    // presentation instructions, so never render them as dialogue.
    .replace(/\{\\?(?:an|a)[1-9]\}/gi, '')
    .replace(/\{\\[^}\r\n]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ');
}

/**
 * Browser <track> only consumes WebVTT. VidSrc's subtitle endpoint currently
 * returns OpenSubtitles SRT files with `application/force-download`, so keep
 * the conversion local to the player and preserve already-valid VTT files.
 */
export function subtitleTextToWebVtt(input: string): string {
  const normalized = sanitizeSubtitleText(input)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  if (/^WEBVTT(?:\s|$)/i.test(normalized)) {
    return `${normalized}\n`;
  }

  const output = ["WEBVTT", ""];
  let cueNumber = 1;
  const blocks = normalized.split(/\n{2,}/);
  const timingPattern = /^\s*\d{1,3}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,3}:\d{2}:\d{2}[,.]\d{3}(?:\s+.*)?\s*$/;

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => timingPattern.test(line));
    if (timingIndex < 0) continue;

    const timing = lines[timingIndex].replace(/(\d{1,3}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    const cueLines = lines.slice(timingIndex + 1).filter((line) => line.length > 0);
    if (cueLines.length === 0) continue;

    output.push(String(cueNumber++), timing, ...cueLines, "");
  }

  return `${output.join("\n")}\n`;
}

export interface ParsedSubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
}

function parseTimestamp(value: string): number {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseWebVttCues(input: string): ParsedSubtitleCue[] {
  const vtt = subtitleTextToWebVtt(input);
  const cues: ParsedSubtitleCue[] = [];
  const timingPattern = /^\s*(\d{1,3}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{1,3}:\d{2}:\d{2}\.\d{3})(?:\s+.*)?\s*$/;
  for (const block of vtt.split(/\n{2,}/).slice(1)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => timingPattern.test(line));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(timingPattern);
    if (!timing) continue;
    const startTime = parseTimestamp(timing[1]);
    const endTime = parseTimestamp(timing[2]);
    const text = lines.slice(timingIndex + 1).filter(Boolean).join("\n");
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime && text) {
      cues.push({ startTime, endTime, text });
    }
  }
  return cues;
}
