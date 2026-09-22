import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
(async () => {
  await p.$connect();
  const r = await p.$queryRawUnsafe(
    `SELECT COUNT(*)::int as c FROM "Show" 
    WHERE description = '' 
       OR description LIKE 'Obra multimedia indexada%%' 
       OR description = 'Sinopsis no disponible' 
       OR description = 'N/A'
       OR (LENGTH(description) > 0 AND LENGTH(description) < 50)`
  );
  console.log("Shows a reparar:", (r as any[])[0].c);
  await p.$disconnect();
})();
