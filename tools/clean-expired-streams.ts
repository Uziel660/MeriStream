import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

// Marcos streams .m3u8 con token caducado guardados como source_url/link.
// Patr�n de token expirado: query `e=` (expiry seconds) o `s=` (timestamp firmado)
// en CDNs que rotan firmas (acek-cdn, dramiyos-cdn, etc).
async function main() {
  // 1. Episode.source_url con m3u8+tokens
  const eps = await p.episode.findMany({
    where: { source_url: { contains: ".m3u8" } },
    select: { id: true, source_url: true },
  });
  let epExpired = 0, epDirect = 0;
  const epIdsToClear: string[] = [];
  for (const e of eps) {
    if (/([?&](e|s|t)=)/i.test(e.source_url) || /acek-cdn|dramiyos-cdn|tnmr\.org/i.test(e.source_url)) {
      epIdsToClear.push(e.id);
      epExpired++;
    } else {
      epDirect++;
    }
  }
  console.log(`Episode.source_url con .m3u8: total=${eps.length}, con token/cdn-caducable=${epExpired}, directo=${epDirect}`);

  // 2. SourceLink.url con m3u8+tokens
  const links = await p.sourceLink.findMany({
    select: { id: true, url: true, source_site: true },
  });
  const linkIdsToClear: string[] = [];
  let linkExpired = 0;
  for (const l of links) {
    if (/\.m3u8/i.test(l.url) && /([?&](e|s|t)=)/i.test(l.url)) {
      linkIdsToClear.push(l.id);
      linkExpired++;
    }
  }
  console.log(`SourceLink con .m3u8+token: ${linkExpired}`);

  console.log("\n=== PLAN DE LIMPIEZA ===");
  console.log(`  Episodes a limpiar source_url: ${epIdsToClear.length}`);
  console.log(`  SourceLinks a eliminar: ${linkIdsToClear.length}`);

  if (epIdsToClear.length > 0 || linkIdsToClear.length > 0) {
    console.log("\nEjecutando limpieza...");
    if (epIdsToClear.length > 0) {
      for (let i = 0; i < epIdsToClear.length; i += 500) {
        const chunk = epIdsToClear.slice(i, i + 500);
        await p.episode.updateMany({ where: { id: { in: chunk } }, data: { source_url: "" } });
      }
      console.log(`  ✓ ${epIdsToClear.length} episodes source_url limpiados (re-extracci�n JIT)`);
    }
    if (linkIdsToClear.length > 0) {
      for (let i = 0; i < linkIdsToClear.length; i += 500) {
        const chunk = linkIdsToClear.slice(i, i + 500);
        await p.sourceLink.deleteMany({ where: { id: { in: chunk } } });
      }
      console.log(`  ✓ ${linkIdsToClear.length} SourceLinks expirados eliminados`);
    }
  }
  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });