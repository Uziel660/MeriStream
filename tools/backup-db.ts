import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const p = new PrismaClient();
const backupDir = path.join(process.cwd(), "backups", "pre_audit_20260826");

async function backup() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  console.log("=== BACKUP DE BASE DE DATOS ===\n");

  // Export all tables
  const tables = [
    { name: "Show", fn: () => p.show.findMany() },
    { name: "Episode", fn: () => p.episode.findMany() },
    { name: "MediaItem", fn: () => p.mediaItem.findMany() },
    { name: "MediaEpisode", fn: () => p.mediaEpisode.findMany() },
    { name: "SourceLink", fn: () => p.sourceLink.findMany() },
    { name: "CrawlTask", fn: () => p.crawlTask.findMany() },
  ];

  let totalRecords = 0;
  for (const table of tables) {
    try {
      const data = await table.fn();
      const filePath = path.join(backupDir, `${table.name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`  ${table.name}: ${data.length} registros → ${filePath}`);
      totalRecords += data.length;
    } catch (e: any) {
      console.error(`  ${table.name}: ERROR - ${e.message}`);
    }
  }

  console.log(`\nTotal: ${totalRecords} registros exportados a ${backupDir}`);
  await p.$disconnect();
}

backup().catch(console.error);
