import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

(async () => {
  const shows = await p.show.count();
  const episodes = await p.episode.count();
  const mediaItems = await p.mediaItem.count();
  const sourceLinks = await p.sourceLink.count();
  console.log(`Shows: ${shows}`);
  console.log(`Episodes: ${episodes}`);
  console.log(`MediaItems: ${mediaItems}`);
  console.log(`SourceLinks: ${sourceLinks}`);
  await p.$disconnect();
})();
