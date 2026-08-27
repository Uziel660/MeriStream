import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const dupBanner = await p.$executeRawUnsafe(
    `UPDATE "Show" SET banner_url = NULL WHERE banner_url = poster_url AND banner_url IS NOT NULL`
  );
  console.log("1. banner_url = poster_url duplicates cleared:", dupBanner);

  const veranimesPoster = await p.$executeRawUnsafe(
    `UPDATE "Show" SET poster_url = NULL WHERE poster_url LIKE '%veranimes.net%'`
  );
  console.log("2. poster_url veranimes.net cleared:", veranimesPoster);

  const unsplashPoster = await p.$executeRawUnsafe(
    `UPDATE "Show" SET poster_url = NULL WHERE poster_url LIKE '%unsplash.com%'`
  );
  console.log("3. poster_url unsplash cleared:", unsplashPoster);

  const veranimesBanner = await p.$executeRawUnsafe(
    `UPDATE "Show" SET banner_url = NULL WHERE banner_url LIKE '%veranimes.net%'`
  );
  console.log("4. banner_url veranimes.net cleared:", veranimesBanner);
}

main().finally(() => p.$disconnect());
