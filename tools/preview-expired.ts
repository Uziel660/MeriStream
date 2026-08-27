import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

async function main() {
  const eps = await p.episode.findMany({
    where: { source_url: { contains: ".m3u8" } },
    select: { source_url: true },
  });
  console.log(`Episode con .m3u8: ${eps.length}`);
  const hosts: Record<string, number> = {};
  for (const e of eps) {
    try {
      const h = new URL(e.source_url).hostname;
      hosts[h] = (hosts[h] || 0) + 1;
    } catch {}
  }
  for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${h}: ${n}`);
  }

  // Mostrar 5 ejemplos con token
  console.log("\nEjemplos con token de expiración (e=/s=/t=):");
  let shown = 0;
  for (const e of eps) {
    if (/([?&](e|s|t)=)/i.test(e.source_url) && shown < 5) {
      console.log(`  ${e.source_url.slice(0, 140)}`);
      shown++;
    }
  }
  await p.$disconnect();
}
main();