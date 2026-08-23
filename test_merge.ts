import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('server/metadataEngine.ts', 'utf-8');

// Agregar cleanAndTranslateDescription al final del archivo si no existe,
// o reemplazar el return "Sin descripción disponible."
if (!content.includes('cleanAndTranslateDescription')) {
    content += `
async function cleanAndTranslateDescription(text: string): Promise<string> {
  if (!text || text.trim() === "") return "Sin descripción disponible.";

  let cleaned = text
    .replace(/<[^>]*>?/gm, "")
    .replace(/\n\s*\n/g, "\\n")
    .replace(/\\(Source:[^)]+\\)/gi, "")
    .replace(/\\[Written by[^\\]]+\\]/gi, "")
    .replace(/Source:[^\\n]+/gi, "")
    .trim();

  if (cleaned.length === 0) return "Sin descripción disponible.";

  try {
    const res = await fetch(\`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=\${encodeURIComponent(cleaned.substring(0, 1500))}\`);
    if (res.ok) {
      const json: any = await res.json();
      if (json && json[0]) {
        cleaned = json[0].map((x: any) => x[0]).join("");
      }
    }
  } catch (e) {
    // ignore
  }
  return cleaned;
}
`;
}

// Reemplazar la limpieza básica con la nueva función asíncrona.
content = content.replace(/const overview = \(bestResult\.overview \|\| ""\)\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\)\.trim\(\) \|\| "Sin descripción disponible\.";/g,
  'const overview = await cleanAndTranslateDescription(bestResult.overview || "");');

content = content.replace(/const cleanDesc = \(media\.description \|\| ""\)\s*\n\s*\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\)\s*\n\s*\.replace\(\/\\n\\s\*\\n\/g, "\\n"\)\s*\n\s*\.trim\(\);/gm,
  'const cleanDesc = await cleanAndTranslateDescription(media.description || "");');

content = content.replace(/description: attr\.synopsis \? sanitizeHtml\(attr\.synopsis, \{ allowedTags: \[\] \}\)\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\)\.trim\(\) : "Sin descripción disponible\.",/g,
  'description: await cleanAndTranslateDescription(attr.synopsis || ""),');

content = content.replace(/description: item\.synopsis \? sanitizeHtml\(item\.synopsis, \{ allowedTags: \[\] \}\)\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\)\.trim\(\) : "Sin descripción disponible\.",/g,
  'description: await cleanAndTranslateDescription(item.synopsis || ""),');

content = content.replace(/const cleanSummary = sanitizeHtml\(\(show\.summary \|\| ""\), \{ allowedTags: \[\] \}\)\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\)\.trim\(\);/g,
  'const cleanSummary = await cleanAndTranslateDescription(show.summary || "");');

content = content.replace(/description: doc\.description \? sanitizeHtml\(doc\.description, \{ allowedTags: \[\] \}\)\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\)\.slice\(0, 400\) : "Película u obra audiovisual de libre acceso en Internet Archive\.",/g,
  'description: await cleanAndTranslateDescription(doc.description || "Película u obra audiovisual de libre acceso en Internet Archive."),');

content = content.replace(/description: typeof page\.extract === "string" \? page\.extract\.replace\(\/<\[\^>\]\*\>\?\/gm, ""\) : page\.extract,/g,
  'description: await cleanAndTranslateDescription(typeof page.extract === "string" ? page.extract : (page.extract ? String(page.extract) : "")),');

// Kitsu also has another place
content = content.replace(/description: attr\.synopsis \? sanitizeHtml\(attr\.synopsis, \{ allowedTags: \[\] \}\)\.trim\(\) : "Sin descripción disponible\.",/g,
  'description: await cleanAndTranslateDescription(attr.synopsis || ""),');

writeFileSync('server/metadataEngine.ts', content, 'utf-8');
