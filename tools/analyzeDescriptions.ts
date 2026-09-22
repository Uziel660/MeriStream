import { prisma } from "../server/db";
import { isAnomalousDescription } from "../server/utils/textCleaner";

async function main() {
  const shows = await prisma.show.findMany({
    select: { title: true, description: true },
    where: { description: { not: "" } }
  });

  const patterns = new Map<string, number>();
  const anomalous = [];

  for (const s of shows) {
    const d = s.description || "";
    
    // Check if it's considered anomalous by current logic
    if (isAnomalousDescription(d, s.title)) {
      anomalous.push(s);
    }
    
    // Extract potential scraper patterns (n-grams at the end or beginning)
    const lower = d.toLowerCase();
    if (lower.includes("ver ") && (lower.includes("online") || lower.includes("latino") || lower.includes("español"))) {
      anomalous.push(s);
    }
  }

  // Deduplicate
  const uniqueAnomalous = Array.from(new Set(anomalous)).slice(0, 30);

  console.log(`Encontradas ${anomalous.length} descripciones sospechosas de un total de ${shows.length}. Muestra:`);
  for (const s of uniqueAnomalous) {
    console.log(`\n[${s.title}]`);
    console.log(`${s.description}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
