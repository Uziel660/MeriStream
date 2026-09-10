const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

/** Limpia markup de reproductores y entidades que no deben llegar a pantalla. */
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
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITY_MAP[name.toLowerCase()] || match);
}

/** Convierte SRT a WebVTT para el elemento HTML <track>. */
export function subtitleTextToWebVtt(input: string): string {
  const normalized = sanitizeSubtitleText(input)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  if (/^WEBVTT(?:\s|$)/i.test(normalized)) return `${normalized}\n`;

  const output = ["WEBVTT", ""];
  let cueNumber = 1;
  const timingPattern = /^\s*\d{1,3}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,3}:\d{2}:\d{2}[,.]\d{3}(?:\s+.*)?\s*$/;
  for (const block of normalized.split(/\n{2,}/)) {
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
