/** Convierte SRT a WebVTT para el elemento HTML <track>. */
export function subtitleTextToWebVtt(input: string): string {
  const normalized = String(input || "")
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
