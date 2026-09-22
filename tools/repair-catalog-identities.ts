#!/usr/bin/env node
/**
 * Orquestador repetible del saneamiento de identidades del catálogo.
 *
 * Por defecto audita candidatos que tengan algún campo de identidad faltante.
 * --apply permite escribir únicamente las coincidencias que los reparadores
 * consideran seguras. --only-empty limita la pasada a filas sin ningún ID.
 * Cada lote deja un JSON en --report-dir para poder reanudar o revisar qué
 * quedó pendiente.
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type Phase = "anime" | "shows" | "media";

interface Options {
  apply: boolean;
  batchSize: number;
  concurrency: number;
  maxPasses: number;
  maxBatches: number;
  primaryOnly: boolean;
  onlyEmpty: boolean;
  reportDir: string;
  phases: Phase[];
}

interface BatchSummary {
  considered?: number;
  updated?: number;
  applied?: number;
  inherited?: number;
  unresolved?: number;
  conflicts?: number;
  errors?: number;
  next_after_id?: string | null;
  nextAfterShowId?: string | null;
  nextAfterMediaId?: string | null;
}

interface RepairRuntime {
  startedAt: string;
  considered: number;
  applied: number;
  unresolved: number;
  conflicts: number;
  errors: number;
  batches: number;
}

interface RepairStatusFile extends RepairRuntime {
  state: "running" | "completed" | "failed";
  phase: Phase | null;
  pass: number | null;
  batch: number | null;
  updatedAt: string;
  completedAt?: string | null;
  latestReport?: string | null;
  message: string;
}

function parseOptions(): Options {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const parsed = Number(value(name));
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback;
  };
  const phaseValue = value("--phases");
  const phases = (phaseValue ? phaseValue.split(",") : ["anime", "shows", "media"])
    .map((phase) => phase.trim().toLowerCase())
    .filter((phase): phase is Phase => phase === "anime" || phase === "shows" || phase === "media");
  return {
    apply: argv.includes("--apply"),
    batchSize: number("--batch-size", 500, 1, 5000),
    concurrency: number("--concurrency", 6, 1, 8),
    maxPasses: number("--max-passes", 3, 1, 20),
    maxBatches: number("--max-batches", 1000000, 1, 1000000),
    primaryOnly: argv.includes("--primary-only"),
    onlyEmpty: argv.includes("--only-empty"),
    reportDir: value("--report-dir") || "work/catalog-identity-repair",
    phases: phases.length ? phases : ["anime", "shows", "media"],
  };
}

function toolCommand(): { command: string; prefix: string[] } {
  return { command: process.execPath, prefix: [path.resolve("node_modules/tsx/dist/cli.mjs")] };
}

async function runTool(script: string, args: string[]): Promise<void> {
  const { command, prefix } = toolCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...prefix, script, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script} terminó con código ${code ?? "desconocido"}`)));
  });
}

async function readSummary(file: string): Promise<BatchSummary> {
  return JSON.parse(await readFile(file, "utf8")) as BatchSummary;
}

async function writeRepairStatus(statusPath: string, status: RepairStatusFile): Promise<void> {
  try {
    await writeFile(statusPath, JSON.stringify(status, null, 2), "utf8");
  } catch (error) {
    console.warn(`[repair-catalog-identities] no se pudo actualizar status.json: ${String(error)}`);
  }
}

async function runPhase(
  phase: Phase,
  options: Options,
  statusPath: string,
  runtime: RepairRuntime,
): Promise<{ phase: Phase; considered: number; applied: number; passes: number }> {
  let totalConsidered = 0;
  let totalApplied = 0;
  let passes = 0;
  for (let pass = 1; pass <= options.maxPasses; pass++) {
    passes = pass;
    let cursor: string | undefined;
    let passConsidered = 0;
    let passApplied = 0;
    let batches = 0;
    for (;;) {
      if (batches >= options.maxBatches) break;
      batches++;
      const stamp = `${phase}-${pass}-${totalConsidered + 1}`;
      const report = path.resolve(options.reportDir, `${stamp}.json`);
      await writeRepairStatus(statusPath, {
        state: "running",
        phase,
        pass,
        batch: batches,
        ...runtime,
        updatedAt: new Date().toISOString(),
        latestReport: path.relative(process.cwd(), report).replaceAll("\\", "/"),
        message: `Procesando fase ${phase}, pasada ${pass}, lote ${batches}.`,
      });
      const args = ["--limit", String(options.batchSize), "--concurrency", String(options.concurrency), "--report", report];
      if (options.apply) args.push("--apply");
      if (options.primaryOnly) args.push("--primary-only");
      if (options.onlyEmpty) args.push("--only-none");
      if (phase === "anime") {
        if (cursor) args.push("--after-id", cursor);
        await runTool("tools/repair-anime-identities.ts", args);
      } else {
        args.push(phase === "shows" ? "--shows-only" : "--media-only");
        if (cursor) args.push(phase === "shows" ? "--after-show-id" : "--after-media-id", cursor);
        await runTool("tools/repair-tmdb-identities-safe.ts", args);
      }
      const payload = await readSummary(report);
      const summary = (payload as any).summary || payload;
      const considered = Number(summary.considered || 0);
      const applied = Number(summary.applied ?? summary.updated ?? 0);
      passConsidered += considered;
      passApplied += applied;
      totalConsidered += considered;
      totalApplied += applied;
      runtime.considered += considered;
      runtime.applied += applied;
      runtime.unresolved += Number(summary.unresolved || 0);
      runtime.conflicts += Number(summary.conflicts || 0);
      runtime.errors += Number(summary.errors || 0);
      runtime.batches++;
      await writeRepairStatus(statusPath, {
        state: "running",
        phase,
        pass,
        batch: batches,
        ...runtime,
        updatedAt: new Date().toISOString(),
        latestReport: path.relative(process.cwd(), report).replaceAll("\\", "/"),
        message: `Último lote completado: fase ${phase}, pasada ${pass}.`,
      });
      const next = phase === "anime"
        ? summary.next_after_id
        : phase === "shows" ? summary.nextAfterShowId : summary.nextAfterMediaId;
      if (!next || considered === 0) break;
      cursor = String(next);
    }
    if (!options.apply || passApplied === 0 || passConsidered === 0) break;
  }
  return { phase, considered: totalConsidered, applied: totalApplied, passes };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const reportDir = path.resolve(options.reportDir);
  const statusPath = path.join(reportDir, "status.json");
  const runtime: RepairRuntime = {
    startedAt: new Date().toISOString(),
    considered: 0,
    applied: 0,
    unresolved: 0,
    conflicts: 0,
    errors: 0,
    batches: 0,
  };
  await mkdir(reportDir, { recursive: true });
  await writeRepairStatus(statusPath, {
    state: "running",
    phase: null,
    pass: null,
    batch: null,
    ...runtime,
    updatedAt: new Date().toISOString(),
    latestReport: null,
    message: "Preparando el saneamiento de identidades.",
  });
  try {
    const results = [];
    for (const phase of options.phases) results.push(await runPhase(phase, options, statusPath, runtime));
    const completedAt = new Date().toISOString();
    await writeRepairStatus(statusPath, {
      state: "completed",
      phase: null,
      pass: null,
      batch: null,
      ...runtime,
      updatedAt: completedAt,
      completedAt,
      latestReport: null,
      message: "Saneamiento de identidades completado.",
    });
    console.log(JSON.stringify({ dry_run: !options.apply, report_dir: reportDir, phases: results }, null, 2));
  } catch (error) {
    await writeRepairStatus(statusPath, {
      state: "failed",
      phase: null,
      pass: null,
      batch: null,
      ...runtime,
      updatedAt: new Date().toISOString(),
      completedAt: null,
      latestReport: null,
      message: String(error instanceof Error ? error.message : error),
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(`[repair-catalog-identities] ${String(error)}`);
  process.exitCode = 1;
});
