import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

/**
 * Domain mapping: maps source domain patterns to their full base URLs.
 * AnimeFlv domains are the most common source of relative /thumbs/ paths.
 */
const DOMAIN_MAP: Record<string, string> = {
  animeflv: "https://animeflv.net",
  jkanime: "https://jkanime.net",
  cuevana: "https://cuevana3.io",
  pelisplus: "https://pelisplus.to",
  gnula: "https://gnula.nu",
};

function getBaseUrl(category: string, title: string): string {
  const lowerCat = category.toLowerCase();
  const lowerTitle = title.toLowerCase();
  for (const [key, domain] of Object.entries(DOMAIN_MAP)) {
    if (lowerCat.includes(key) || lowerTitle.includes(key)) return domain;
  }
  // Default: if category is anime, use animeflv
  if (lowerCat.includes("anime")) return "https://animeflv.net";
  return "https://animeflv.net";
}

function fixUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${baseUrl}${url}`;
  return url;
}

async function main() {
  console.log("=== Fix Poster URLs Migration ===\n");

  // 1. Find all shows with relative poster_url (starts with '/')
  const brokenShows = await p.show.findMany({
    where: {
      poster_url: { startsWith: "/" },
    },
    select: {
      id: true,
      title: true,
      poster_url: true,
      category: true,
      normalized_title: true,
    },
  });

  console.log(`Found ${brokenShows.length} shows with relative poster URLs.\n`);

  if (brokenShows.length === 0) {
    console.log("Nothing to fix. All poster URLs are already absolute.");
    await p.$disconnect();
    return;
  }

  // 2. Fix each one
  let fixed = 0;
  let errors = 0;

  for (const show of brokenShows) {
    try {
      const baseUrl = getBaseUrl(show.category || "", show.title);
      const newUrl = fixUrl(show.poster_url!, baseUrl);

      await p.show.update({
        where: { id: show.id },
        data: { poster_url: newUrl },
      });

      console.log(`  [FIXED] ${show.title}`);
      console.log(`    Old: ${show.poster_url}`);
      console.log(`    New: ${newUrl}`);
      fixed++;
    } catch (err: any) {
      console.error(`  [ERROR] ${show.title}: ${err.message}`);
      errors++;
    }
  }

  // 3. Also check MediaItem table
  const brokenMedia = await p.mediaItem.findMany({
    where: {
      poster_url: { startsWith: "/" },
    },
    select: {
      id: true,
      title: true,
      poster_url: true,
      kind: true,
    },
  });

  console.log(`\nFound ${brokenMedia.length} MediaItems with relative poster URLs.\n`);

  let mediaFixed = 0;
  for (const item of brokenMedia) {
    try {
      const baseUrl = item.kind === "anime" ? "https://animeflv.net" : "https://animeflv.net";
      const newUrl = fixUrl(item.poster_url!, baseUrl);

      await p.mediaItem.update({
        where: { id: item.id },
        data: { poster_url: newUrl },
      });

      console.log(`  [FIXED] ${item.title}`);
      console.log(`    Old: ${item.poster_url}`);
      console.log(`    New: ${newUrl}`);
      mediaFixed++;
    } catch (err: any) {
      console.error(`  [ERROR] ${item.title}: ${err.message}`);
      errors++;
    }
  }

  // 4. Summary
  console.log("\n=== Summary ===");
  console.log(`Shows fixed:     ${fixed}`);
  console.log(`MediaItems fixed: ${mediaFixed}`);
  console.log(`Errors:          ${errors}`);
  console.log(`Total fixed:     ${fixed + mediaFixed}`);

  // 5. Verify no more relative URLs remain
  const remaining = await p.show.count({
    where: { poster_url: { startsWith: "/" } },
  });
  const remainingMedia = await p.mediaItem.count({
    where: { poster_url: { startsWith: "/" } },
  });

  console.log(`\n=== Verification ===`);
  console.log(`Remaining relative poster_urls in Show:     ${remaining}`);
  console.log(`Remaining relative poster_urls in MediaItem: ${remainingMedia}`);

  if (remaining === 0 && remainingMedia === 0) {
    console.log("\nAll relative poster URLs have been fixed!");
  } else {
    console.log("\nSome relative URLs remain. Manual review may be needed.");
  }

  await p.$disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
