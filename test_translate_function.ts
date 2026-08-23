export async function cleanAndTranslateDescription(text: string): Promise<string> {
  if (!text || text.trim() === "") return "Sin descripción disponible.";

  let cleaned = text
    .replace(/<[^>]*>?/gm, "")
    .replace(/\n\s*\n/g, "\n")
    .replace(/\(Source:[^)]+\)/gi, "")
    .replace(/\[Written by[^\]]+\]/gi, "")
    .replace(/Source:[^\n]+/gi, "")
    .trim();

  if (cleaned.length === 0) return "Sin descripción disponible.";

  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(cleaned.substring(0, 1500))}`);
    if (res.ok) {
      const json = await res.json();
      if (json && json[0]) {
        cleaned = json[0].map((x: any) => x[0]).join("");
      }
    }
  } catch (e) {
    console.error("Translate error", e);
  }
  return cleaned;
}

const desc = "This is a great anime. (Source: ANN)\n\n[Written by MAL Rewrite]";
cleanAndTranslateDescription(desc).then(console.log);
