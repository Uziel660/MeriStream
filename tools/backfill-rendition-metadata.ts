import "dotenv/config";
import { prisma } from "../server/db";

/**
 * Fills the preferred rendition labels for links imported before the provider
 * policy carried explicit audio metadata. It never rewrites locators or health
 * evidence; provider payloads may still override these defaults on reimport.
 */
async function main(): Promise<void> {
  const updates: Array<Record<string, unknown>> = [];
  for (const sourceSite of ["cinecalidad", "gnula", "latanime"]) {
    const result = await prisma.sourceLink.updateMany({
      where: { source_site: sourceSite, audio_language: null },
      data: { audio_language: "es" },
    });
    updates.push({ sourceSite, audioUpdated: result.count });
  }

  // Existing Zoko rows already carry the provider's sub/dub labels in most
  // cases. Preserve those values and only fill a missing subtitle hint for a
  // `/sub` locator when the import did not persist one.
  const zokoSubtitles = await prisma.sourceLink.updateMany({
    where: {
      source_site: "zokoanime.video",
      url: { contains: "/sub" },
      subtitle_language: null,
    },
    data: { subtitle_language: "en" },
  });
  updates.push({ sourceSite: "zokoanime.video", subtitleUpdated: zokoSubtitles.count });

  console.log(JSON.stringify(updates));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
