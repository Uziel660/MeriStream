import { PrismaClient } from "@prisma/client";
import { cleanDescription, isAnomalousDescription } from "../server/utils/textCleaner";

const p = new PrismaClient();

// Patrones de artefactos de scraping que contaminan descripciones
const SCRAPING_ARTIFACTS: RegExp[] = [
  /ver\s+pel[ií]cula[s]?\s*(online)?(\s*gratis)?/gi,
  /ver\s+online\s*(gratis)?/gi,
  /cinecalidad(\.\w+)?/gi,
  /veranimes(\.\w+)?(\.net)?/gi,
  /VERANIMES\.NET/gi,
  /tubepelis(\.\w+)?/gi,
  /latanime(\.\w+)?/gi,
  /animeflv(\.\w+)?/gi,
  /tioanime(\.\w+)?/gi,
  /lamovie(\.\w+)?/gi,
  /descargar\s+(gratis|por\s+mega|torrent)/gi,
  /hd\s*720p?|1080p|4k/gi,
  /latino\s*hd/gi,
  /espa[ñn]ol\s+latino/gi,
  /sub\s*espa[ñn]ol/gi,
  /castellano/gi,
  /calidad\s*(hd|ts|cam)/gi,
];

const PLACEHOLDER_PATTERNS = [
  /^contenido indexado en voidstream/i,
  /^obra multimedia indexada/i,
  /^a[uú]n no hemos a[ñn]adido/i,
  /^sinopsis no disponible/i,
  /^no description available/i,
  /^descripci[oó]n no disponible/i,
  /^importado de/i,
];

function containsCJK(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿가-힯]/.test(text);
}

function cleanArtifacts(text: string): string {
  let t = text;
  for (const re of SCRAPING_ARTIFACTS) {
    t = t.replace(re, " ");
  }
  return t.replace(/\s+/g, " ").replace(/^[.,;:\s\-–—]+/, "").trim();
}

(async () => {
  await p.$connect();
  console.log("=== REPARACIÓN MASIVA DE DESCRIPCIONES ===\n");

  const shows = await p.show.findMany({
    select: { id: true, title: true, description: true },
  });
  console.log(`Total shows: ${shows.length}`);

  let placeholderCleared = 0;
  let artifactsCleaned = 0;
  let anomaliesFixed = 0;
  let cjkCleared = 0;
  let sqlBatches = 0;

  const updates: Array<{ id: string; description: string }> = [];

  for (const s of shows) {
    const raw = (s.description || "").trim();

    // 1. Placeholders → vaciar (el backfill re-enriquece después)
    if (raw === "" || PLACEHOLDER_PATTERNS.some((re) => re.test(raw))) {
      if (raw !== "") {
        updates.push({ id: s.id, description: "" });
        placeholderCleared++;
      }
      continue;
    }

    // 2. Idioma CJK → vaciar
    if (containsCJK(raw)) {
      updates.push({ id: s.id, description: "" });
      cjkCleared++;
      continue;
    }

    let cleaned = raw;

    // 3. Limpiar entidades HTML, tags, mojibake, título duplicado
    if (isAnomalousDescription(cleaned, s.title)) {
      cleaned = cleanDescription(cleaned, s.title);
    }

    // 4. Limpiar artefactos de scraping (nombres de sitios, calidades)
    const artifactCleaned = cleanArtifacts(cleaned);
    const hadArtifacts = artifactCleaned !== cleaned;
    cleaned = artifactCleaned;

    if (cleaned !== raw) {
      // Si la limpieza destruyó casi todo, vaciar para re-enriquecer
      if (cleaned.length < 40) {
        updates.push({ id: s.id, description: "" });
        if (hadArtifacts) artifactsCleaned++;
        else anomaliesFixed++;
      } else {
        updates.push({ id: s.id, description: cleaned });
        if (hadArtifacts) artifactsCleaned++;
        else anomaliesFixed++;
      }
    }
  }

  console.log(`Por actualizar: ${updates.length}`);
  console.log(`  - Placeholders vaciados: ${placeholderCleared}`);
  console.log(`  - Artefactos de scraping limpiados: ${artifactsCleaned}`);
  console.log(`  - Anomalías (HTML/mojibake/título dup): ${anomaliesFixed}`);
  console.log(`  - CJK vaciados: ${cjkCleared}`);

  // Batch updates con SQL crudo por performance
  for (let i = 0; i < updates.length; i += 250) {
    const chunk = updates.slice(i, i + 250);
    await p.$transaction(
      chunk.map((u) =>
        p.show.update({ where: { id: u.id }, data: { description: u.description } })
      )
    );
    sqlBatches++;
    if (sqlBatches % 4 === 0) {
      console.log(`  Progreso: ${Math.min(i + 250, updates.length)}/${updates.length}`);
    }
  }

  console.log(`\nHecho. ${updates.length} descripciones reparadas.`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
