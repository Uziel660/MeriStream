import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../server/db";

/**
 * Exporta las colas y checkpoints operativos sin recorrer las tablas grandes de
 * catálogo. Es el respaldo rápido para trasladar una reimportación pausada.
 */
async function main(): Promise<void> {
  const target = path.resolve(process.argv[2] || "database/snapshots/crawl-tasks-transfer.json");
  const tasks = await prisma.crawlTask.findMany({ orderBy: { id: "asc" } });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({
    format: "meristream-crawl-task-state-v1",
    created_at: new Date().toISOString(),
    tasks,
  }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output: target, tasks: tasks.length }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
