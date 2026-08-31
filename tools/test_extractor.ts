import { extractStreamFromUrl } from '../server/universalScraper';
import { prisma } from '../server/db';

async function run() {
  const url = process.argv[2] || "https://animeflv.net/ver/yozakurasan-chi-no-daisakusen-2nd-season-1";
  console.log(`Extracting: ${url}`);
  try {
    const r1 = await extractStreamFromUrl(url);
    console.log(r1);
  } catch (e) {
    console.error(e);
  }
}

run().finally(() => prisma.$disconnect());
