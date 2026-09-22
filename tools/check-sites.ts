import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  const ratings = await p.siteRating.findMany();
  console.log("SiteRatings:", ratings.length);
  for (const r of ratings) {
    console.log(`  ${r.site}: enabled=${r.enabled} rating=${r.rating}`);
  }
  console.log("\nSites presentes en source de Show:");
  const sites = await p.show.groupBy({ by: ["source"], _count: { source: true } });
  sites.sort((a, b) => (b._count.source || 0) - (a._count.source || 0));
  for (const s of sites.slice(0, 30)) {
    console.log(`  ${s.source}: ${s._count.source}`);
  }
  await p.$disconnect();
})();