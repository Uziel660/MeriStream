import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";

const p = new PrismaClient();

interface Finding {
  id: string;
  title: string;
  description_preview: string;
  detail: string;
}

interface CategoryReport {
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  count: number;
  samples: Finding[];
}

(async () => {
  await p.$connect();

  const total = (await p.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*)::int as count FROM "Show"`
  ))[0].count;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  AUDITORÍA DE DESCRIPCIONES — ${total} shows`);
  console.log(`${"=".repeat(70)}\n`);

  const allShows = await p.$queryRawUnsafe<
    { id: string; title: string; description: string; category: string }[]
  >(`SELECT id, title, description, category FROM "Show" ORDER BY title`);

  const categories: CategoryReport[] = [];

  // ─────────────────────────────────────────────
  // 1. PLACEHOLDER DESCRIPTIONS
  // ─────────────────────────────────────────────
  const placeholderPatterns = /^(?:$|sinopsis no disponible|n\/a|descripci[oó]n no disponible|no description available|obra multimedia indexada|importado de|contenido indexado|placeholder|sin descripci|descipcion no disponible|synopsis not available|no synopsis|sinopsis pendiente|pendiente de descripci|enrichpendiente)$/i;
  const placeholderFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (placeholderPatterns.test(d)) {
      placeholderFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d || "(vacía)",
        detail: `Placeholder detectado: "${d || "(vacía)"}"`,
      });
    }
  }
  categories.push({
    category: "1. Placeholder / vacía",
    severity: "CRITICAL",
    count: placeholderFindings.length,
    samples: placeholderFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 2. HTML ENTITIES
  // ─────────────────────────────────────────────
  const htmlEntityRegex = /&(?:[a-z]{2,8}|#\d+|#x[0-9a-f]+);/i;
  const htmlTagRegex = /<[a-z][\s\S]*>/i;
  const htmlFindings: Finding[] = [];
  for (const s of allShows) {
    const d = s.description || "";
    if (!d) continue;
    const reasons: string[] = [];
    if (htmlEntityRegex.test(d)) reasons.push("entidades HTML (&amp;, &nbsp;, etc.)");
    if (htmlTagRegex.test(d)) reasons.push("tags HTML (<p>, <div>, etc.)");
    if (reasons.length > 0) {
      htmlFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(0, 120),
        detail: reasons.join(" + "),
      });
    }
  }
  categories.push({
    category: "2. HTML entities / tags",
    severity: "HIGH",
    count: htmlFindings.length,
    samples: htmlFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 3. MOJIBAKE / ENCODING ISSUES
  // ─────────────────────────────────────────────
  const mojibakeRegex = /Ã[¡éíóúñÁÉÍÓÚÑ\s]|â[€“—œ ˜™]/i;
  const mojibakeFindings: Finding[] = [];
  for (const s of allShows) {
    const d = s.description || "";
    if (mojibakeRegex.test(d)) {
      mojibakeFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(0, 120),
        detail: "Mojibake / double-encoding UTF-8 detectado",
      });
    }
  }
  categories.push({
    category: "3. Mojibake / encoding",
    severity: "HIGH",
    count: mojibakeFindings.length,
    samples: mojibakeFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 4. TITLE DUPLICATED AT START OF DESCRIPTION
  // ─────────────────────────────────────────────
  const titleDupFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (d.length < 10) continue;
    const t = s.title.trim();
    if (t.length < 3) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped}\\s*[-:–—]?\\s*`, "i");
    if (regex.test(d)) {
      titleDupFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(0, 120),
        detail: `Título duplicado al inicio de la descripción`,
      });
    }
  }
  categories.push({
    category: "4. Título duplicado al inicio",
    severity: "HIGH",
    count: titleDupFindings.length,
    samples: titleDupFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 5. DESCRIPTION IS JUST THE TITLE REPEATED
  // ─────────────────────────────────────────────
  const titleOnlyFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (!d) continue;
    const t = s.title.trim().toLowerCase();
    if (t.length < 3) continue;
    const descLower = d.toLowerCase();
    if (descLower === t || descLower === `${t}.` || descLower === `${t}...`) {
      titleOnlyFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d,
        detail: `La descripción es solo el título repetido`,
      });
    }
  }
  categories.push({
    category: "5. Descripción = solo el título",
    severity: "HIGH",
    count: titleOnlyFindings.length,
    samples: titleOnlyFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 6. SCRAPING ARTIFACTS
  // ─────────────────────────────────────────────
  const scrapingRegex = /ver\s+(?:online|anime|pelicula|serie|capitulo|episodio)|latino\s*(?:hd|720p|1080p)|sub\s*(?:español|espanol|latin)|audio\s*(?:español|espanol|latin)|ver\s+en\s+(?:linea|hd|audio)|download|streaming\s+gratis|cinecalidad|pelisplus|gnula|repelis|cuevana|tubitv|animeflv|jkanime|veranimes/i;
  const scrapingFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (!d) continue;
    if (scrapingRegex.test(d)) {
      const matches = d.match(scrapingRegex);
      scrapingFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(0, 120),
        detail: `Artefacto de scraping: "${matches?.[0] || "?"}"`,
      });
    }
  }
  categories.push({
    category: "6. Artefactos de scraping",
    severity: "MEDIUM",
    count: scrapingFindings.length,
    samples: scrapingFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 7. TRUNCATED DESCRIPTIONS
  // ─────────────────────────────────────────────
  const truncatedFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (d.length < 10) continue;
    const endsWithEllipsis = /\.{2,}$/.test(d);
    const endsWithIncompleteWord = /\S\.\.\.\s*$/.test(d);
    const endsWithHyphenOrDash = /[-–—]\s*$/.test(d);
    const endsWithQuoteButNoPeriod = /["""]\s*$/.test(d);
    const endsWithParenthesis = /\([^)]*$/;
    const cutMidSentence = /\s\w{1,3}\s*$/.test(d) && d.length > 100;
    if (endsWithEllipsis || endsWithIncompleteWord || endsWithHyphenOrDash || (endsWithQuoteButNoPeriod && !/\.\s*["""]\s*$/.test(d)) || (endsWithParenthesis.test(d) && !d.includes(")"))) {
      truncatedFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(d.length - 80),
        detail: `Posiblemente truncada (${d.length} chars)`,
      });
    }
  }
  categories.push({
    category: "7. Truncadas / cortadas",
    severity: "MEDIUM",
    count: truncatedFindings.length,
    samples: truncatedFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 8. TOO SHORT (<50 chars, not empty)
  // ─────────────────────────────────────────────
  const shortFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (d.length > 0 && d.length < 50) {
      shortFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d,
        detail: `Descripción muy corta: ${d.length} caracteres`,
      });
    }
  }
  categories.push({
    category: "8. Muy corta (<50 chars)",
    severity: "MEDIUM",
    count: shortFindings.length,
    samples: shortFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 9. TOO LONG (>5000 chars)
  // ─────────────────────────────────────────────
  const longFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (d.length > 5000) {
      longFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(0, 120) + "...",
        detail: `Descripción sospechosamente larga: ${d.length} caracteres`,
      });
    }
  }
  categories.push({
    category: "9. Excesivamente larga (>5000 chars)",
    severity: "LOW",
    count: longFindings.length,
    samples: longFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 10. WRONG LANGUAGE (Japanese/Chinese in a Spanish platform)
  // ─────────────────────────────────────────────
  const jpRegex = /[\u3040-\u309f\u30a0-\u30ff]{3,}/;
  const cnRegex = /[\u4e00-\u9fff]{3,}/;
  const langFindings: Finding[] = [];
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (d.length < 10) continue;
    const reasons: string[] = [];
    if (jpRegex.test(d)) reasons.push("japonés");
    if (cnRegex.test(d)) reasons.push("chino");
    if (reasons.length > 0) {
      langFindings.push({
        id: s.id,
        title: s.title,
        description_preview: d.substring(0, 120),
        detail: `Contenido en ${reasons.join(" y ")} (debería ser español)`,
      });
    }
  }
  categories.push({
    category: "10. Idioma incorrecto (JP/CN)",
    severity: "HIGH",
    count: langFindings.length,
    samples: langFindings.slice(0, 20),
  });

  // ─────────────────────────────────────────────
  // 11. DUPLICATE DESCRIPTIONS (exact match)
  // ─────────────────────────────────────────────
  const descMap = new Map<string, Array<{ id: string; title: string }>>();
  for (const s of allShows) {
    const d = (s.description || "").trim();
    if (d.length < 30) continue;
    if (!descMap.has(d)) descMap.set(d, []);
    descMap.get(d)!.push({ id: s.id, title: s.title });
  }
  const duplicateGroups: Array<{
    description_preview: string;
    count: number;
    shows: Array<{ id: string; title: string }>;
  }> = [];
  for (const [desc, shows] of descMap) {
    if (shows.length > 1) {
      duplicateGroups.push({
        description_preview: desc.substring(0, 120),
        count: shows.length,
        shows: shows,
      });
    }
  }
  duplicateGroups.sort((a, b) => b.count - a.count);
  const totalDuplicateShows = duplicateGroups.reduce((sum, g) => sum + g.count, 0);
  const duplicateFindings: Finding[] = [];
  for (const group of duplicateGroups.slice(0, 30)) {
    for (const show of group.shows) {
      duplicateFindings.push({
        id: show.id,
        title: show.title,
        description_preview: group.description_preview,
        detail: `Compartida con ${group.count} shows`,
      });
    }
  }
  categories.push({
    category: "11. Descripciones duplicadas (exactas)",
    severity: "MEDIUM",
    count: totalDuplicateShows,
    samples: duplicateFindings.slice(0, 40),
  });

  // ─────────────────────────────────────────────
  // PRINT REPORT
  // ─────────────────────────────────────────────
  let totalAffected = new Set<string>();

  for (const cat of categories) {
    const severityIcon =
      cat.severity === "CRITICAL" ? "🔴" :
      cat.severity === "HIGH" ? "🟠" :
      cat.severity === "MEDIUM" ? "🟡" : "🟢";

    console.log(`\n${"─".repeat(70)}`);
    console.log(`${severityIcon} ${cat.category} [${cat.severity}] — ${cat.count} shows`);
    console.log(`${"─".repeat(70)}`);

    for (const f of cat.samples) {
      totalAffected.add(f.id);
      console.log(`  • [${f.id}] "${f.title}"`);
      console.log(`    → ${f.detail}`);
      console.log(`    preview: "${f.description_preview}"`);
    }

    if (cat.count > cat.samples.length) {
      console.log(`  ... y ${cat.count - cat.samples.length} más`);
    }
  }

  // ─────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log("  RESUMEN");
  console.log(`${"=".repeat(70)}`);
  console.log(`  Total shows en la base:            ${total}`);
  console.log(`  Shows únicos afectados:            ${totalAffected.size} (${Math.round(totalAffected.size / total * 100)}%)`);
  console.log(`  Categorías detectadas:             ${categories.length}`);
  console.log("");
  for (const cat of categories) {
    const pct = Math.round(cat.count / total * 100);
    console.log(`  ${cat.severity.padEnd(9)} ${cat.category.padEnd(45)} ${String(cat.count).padStart(5)}  (${pct}%)`);
  }

  // ─────────────────────────────────────────────
  // DUPLICATE DETAILS
  // ─────────────────────────────────────────────
  if (duplicateGroups.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`  DETALLE DE GRUPOS DE DESCRIPCIONES DUPLICADAS`);
    console.log(`${"─".repeat(70)}`);
    for (const group of duplicateGroups.slice(0, 15)) {
      console.log(`\n  [${group.count} shows] "${group.description_preview}"`);
      for (const show of group.shows) {
        console.log(`    - ${show.title} (${show.id})`);
      }
    }
    if (duplicateGroups.length > 15) {
      console.log(`\n  ... y ${duplicateGroups.length - 15} grupos más`);
    }
  }

  // ─────────────────────────────────────────────
  // SAVE JSON REPORT
  // ─────────────────────────────────────────────
  mkdirSync("data", { recursive: true });

  const report = {
    scan_date: new Date().toISOString(),
    total_shows: total,
    total_affected: totalAffected.size,
    affected_percentage: Math.round(totalAffected.size / total * 100),
    categories: categories.map((c) => ({
      category: c.category,
      severity: c.severity,
      count: c.count,
      percentage: Math.round(c.count / total * 100),
      samples: c.samples,
    })),
    duplicate_groups: duplicateGroups.map((g) => ({
      description_preview: g.description_preview,
      count: g.count,
      shows: g.shows,
    })),
  };

  writeFileSync("data/audit-descriptions.json", JSON.stringify(report, null, 2));
  console.log(`\n✅ Reporte completo guardado en data/audit-descriptions.json`);

  await p.$disconnect();
})().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});
