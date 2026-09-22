import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  const va = await p.episode.findMany({ where: { source_url: { contains: "veranimes" } }, select: { source_url: true, title: true }, take: 12 });
  console.log("### VERANIMES URLs:");
  const seen = new Set<string>();
  for (const e of va) { if (!seen.has(e.source_url)) { seen.add(e.source_url); console.log("  " + e.source_url); } }

  const tp = await p.episode.findMany({ where: { source_url: { contains: "tubepelis" } }, select: { source_url: true, title: true } });
  console.log("### TUBEPELIS URLs:");
  for (const e of tp) console.log("  " + e.source_url);

  // Shows con tubepelis/veranimes en source
  const st = await p.show.findMany({ where: { source: { contains: "tubepelis" } }, select: { title: true, source: true, id: true }, take: 10 });
  console.log("### SHOWS con source tubepelis:");
  for (const s of st) console.log(`  [${s.title}] ${s.source}`);
  const sv = await p.show.findMany({ where: { source: { contains: "veranimes" } }, select: { title: true, source: true, id: true }, take: 10 });
  console.log("### SHOWS con source veranimes:");
  for (const s of sv) console.log(`  [${s.title}] ${s.source}`);

  await p.$disconnect();
})();