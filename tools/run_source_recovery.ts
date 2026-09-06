import { prisma } from "../server/db";
import { sourceRecoveryWorker } from "../server/sourceRecoveryWorker";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const providersRaw = valueAfter("--providers");
const providers = providersRaw
  ? providersRaw.split(",").map((value) => value.trim()).filter(Boolean)
  : undefined;
const limit = positiveInt(valueAfter("--limit"));
const delayMs = positiveInt(valueAfter("--delay-ms"));
const modeRaw = valueAfter("--mode");
const mode = modeRaw === "all" ? "all" : "expired";

const job = await sourceRecoveryWorker.createJob({ providers, limit, delay_ms: delayMs, mode });
console.log(`[SourceRecovery] ${job.id}: ${job.total_discovered} episodios en cola (modo ${mode}); proveedores configurados incluidos.`);

let lastProgress = "";
for (;;) {
  const current = await sourceRecoveryWorker.getJob(job.id);
  if (!current) throw new Error(`La recuperación ${job.id} desapareció de la base de datos.`);
  const queue = current.items_queue;
  const done = queue.filter((item) => item.status === "done" || item.status === "already_canonical").length;
  const progress = `${current.status} ${done}/${current.total_discovered} recuperados=${current.episodes_imported}`;
  if (progress !== lastProgress) {
    console.log(`[SourceRecovery] ${progress}`);
    lastProgress = progress;
  }
  if (current.status === "completed" || current.status === "failed") {
    const counts = queue.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    console.log(`[SourceRecovery] finalizado: ${JSON.stringify(counts)}${current.error_message ? `; ${current.error_message}` : ""}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

await prisma.$disconnect();
