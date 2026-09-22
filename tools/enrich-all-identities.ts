#!/usr/bin/env node
/**
 * Orquestador completo para garantizar que TODAS las obras del catálogo
 * tengan sus identificadores correspondientes:
 *
 * 1. TMDB -> IMDb / TVDb: Backfill masivo de IMDb (tt...) para todas las obras que ya tienen TMDB.
 * 2. Anime -> MAL / AniList / Kitsu: Mapeo de identidades de anime legacy sin IDs.
 * 3. Obras sin TMDB -> TMDB + IMDb: Búsqueda segura y asignación de TMDB e IMDb para obras huérfanas.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";

interface Options {
  apply: boolean;
  limitPerPhase?: number;
  concurrency: number;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    limitPerPhase: Number(value("--limit")) || undefined,
    concurrency: Math.min(30, Math.max(1, Number(value("--concurrency")) || 15)),
  };
}

function runCommand(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> Ejecutando: npx tsx ${script} ${args.join(" ")}\n`);
    const proc = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), script, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`El script ${script} finalizó con código ${code}`));
    });
    proc.on("error", reject);
  });
}

async function main() {
  const opts = parseArgs();
  console.log("==========================================================");
  console.log("  SANEAMIENTO INTEGRAL DE IDENTIDADES DEL CATÁLOGO        ");
  console.log(`  Modo: ${opts.apply ? "APLICAR CAMBIOS (--apply)" : "SIMULACIÓN (dry-run)"}`);
  console.log(`  Concurrencia: ${opts.concurrency}`);
  console.log("==========================================================");

  // FASE 1: Backfill de IMDb y TVDb para obras con TMDB ID
  console.log("\n[FASE 1/3] Recuperando identificadores IMDb y TVDb para obras con TMDB...");
  const imdbArgs = ["--concurrency", String(opts.concurrency)];
  if (opts.apply) imdbArgs.push("--apply");
  if (opts.limitPerPhase) imdbArgs.push("--limit", String(opts.limitPerPhase));
  await runCommand("tools/backfill-imdb-ids.ts", imdbArgs);

  // FASE 2: Identidades de Anime (MAL, AniList, Kitsu)
  console.log("\n[FASE 2/3] Identificando animes para asignar MAL y AniList...");
  const animeArgs = ["--concurrency", String(Math.min(opts.concurrency, 8))];
  if (opts.apply) animeArgs.push("--apply");
  if (opts.limitPerPhase) animeArgs.push("--limit", String(opts.limitPerPhase));
  await runCommand("tools/repair-anime-identities.ts", animeArgs);

  // FASE 3: Identidades TMDB para obras huérfanas
  console.log("\n[FASE 3/3] Buscando coincidencias TMDB de alta confianza para obras sin ID...");
  const tmdbArgs = ["--concurrency", String(Math.min(opts.concurrency, 8))];
  if (opts.apply) tmdbArgs.push("--apply");
  if (opts.limitPerPhase) tmdbArgs.push("--limit", String(opts.limitPerPhase));
  await runCommand("tools/repair-tmdb-identities-safe.ts", tmdbArgs);

  console.log("\n==========================================================");
  console.log("  SANEAMIENTO INTEGRAL COMPLETADO CON ÉXITO               ");
  console.log("==========================================================");
}

main().catch((err) => {
  console.error("\n[enrich-all-identities] Error durante la ejecución:", err);
  process.exit(1);
});
