import { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import "dotenv/config";

const prisma = new PrismaClient();
const BATCH_SIZE = 500;

type SnapshotManifest = {
  format: "meristream-prisma-ndjson-v1";
  created_at: string;
  schema: "prisma/schema.prisma";
  database_size_bytes: number | null;
  tables: Record<string, number>;
  snapshot_file: string;
  snapshot_size_bytes: number;
  sha256: string;
  contains_sensitive_data: true;
};

async function writeWithBackpressure(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function exportModel(
  tx: Prisma.TransactionClient,
  modelName: string,
  findPage: (cursor?: string) => Promise<Array<{ id: string }>>,
  gzip: NodeJS.WritableStream,
): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  while (true) {
    const rows = await findPage(cursor);
    if (rows.length === 0) break;
    for (const row of rows) await writeWithBackpressure(gzip, { table: modelName, data: row });
    count += rows.length;
    cursor = rows.at(-1)!.id;
  }
  return count;
}

async function sha256Of(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(filePath);
  input.on("data", (chunk) => hash.update(chunk));
  await once(input, "end");
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const requested = process.argv[2] || `database/snapshots/meristream-${stamp}.ndjson.gz`;
  const outputPath = path.resolve(requested);
  const workspace = path.resolve(process.cwd());
  if (outputPath !== workspace && !outputPath.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("El snapshot debe escribirse dentro del repositorio");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const partialPath = `${outputPath}.partial`;
  const gzip = createGzip({ level: 9 });
  const destination = createWriteStream(partialPath, { flags: "wx" });
  const compression = pipeline(gzip, destination);
  const tableCounts: Record<string, number> = {};
  const createdAt = new Date().toISOString();

  try {
    await writeWithBackpressure(gzip, {
      type: "metadata",
      format: "meristream-prisma-ndjson-v1",
      created_at: createdAt,
      schema: "prisma/schema.prisma",
    });

    await prisma.$transaction(async (tx) => {
      const page = { take: BATCH_SIZE, orderBy: { id: "asc" as const } };
      tableCounts.Show = await exportModel(tx, "Show", (cursor) => tx.show.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.Episode = await exportModel(tx, "Episode", (cursor) => tx.episode.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.CrawlTask = await exportModel(tx, "CrawlTask", (cursor) => tx.crawlTask.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.WorkerSettingsStore = await exportModel(tx, "WorkerSettingsStore", (cursor) => tx.workerSettingsStore.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.MediaItem = await exportModel(tx, "MediaItem", (cursor) => tx.mediaItem.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.SiteRating = await exportModel(tx, "SiteRating", (cursor) => tx.siteRating.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.MediaEpisode = await exportModel(tx, "MediaEpisode", (cursor) => tx.mediaEpisode.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.SourceLink = await exportModel(tx, "SourceLink", (cursor) => tx.sourceLink.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.User = await exportModel(tx, "User", (cursor) => tx.user.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
      tableCounts.WatchProgress = await exportModel(tx, "WatchProgress", (cursor) => tx.watchProgress.findMany({
        ...page, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      }), gzip);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10 * 60 * 1000 });

    await writeWithBackpressure(gzip, { type: "summary", tables: tableCounts });
    gzip.end();
    await compression;
    await fs.rename(partialPath, outputPath);

    const stats = await fs.stat(outputPath);
    const sizeRows = await prisma.$queryRaw<Array<{ bytes: bigint }>>`
      SELECT pg_database_size(current_database()) AS bytes
    `.catch(() => []);
    const databaseSize = sizeRows[0]?.bytes !== undefined ? Number(sizeRows[0].bytes) : null;
    const manifest: SnapshotManifest = {
      format: "meristream-prisma-ndjson-v1",
      created_at: createdAt,
      schema: "prisma/schema.prisma",
      database_size_bytes: databaseSize,
      tables: tableCounts,
      snapshot_file: path.basename(outputPath),
      snapshot_size_bytes: stats.size,
      sha256: await sha256Of(outputPath),
      contains_sensitive_data: true,
    };
    await fs.writeFile(`${outputPath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ output: outputPath, manifest }, null, 2));
  } catch (error) {
    gzip.destroy();
    await compression.catch(() => undefined);
    await fs.rm(partialPath, { force: true });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
