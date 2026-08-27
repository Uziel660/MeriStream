#!/usr/bin/env node
// tools/watchdog-runner.ts
// Standalone watchdog: corre periódicamente, escanea anomalías, auto-repara
// y escribe reportes en data/watchdog-reports.json.
//
// Uso:
//   npx tsx tools/watchdog-runner.ts          (loop continuo)
//   npx tsx tools/watchdog-runner.ts --once   (una sola pasada)
//
// Si hay errores críticos, invoca `opencode run` automáticamente
// para abrir una sesión con el contexto del error.

import { execSync } from "child_process";
import { runWatchdogNow, getWatchdogReports, checkWatchdogAlert } from "../server/watchdog";

function invokeOpencodeWithAlert(alert: ReturnType<typeof checkWatchdogAlert>) {
  if (!alert || alert.critical_count === 0) return;

  const errorSummary = alert.summary
    .map((s) => `- [${s.category}] ${s.entity}: ${s.detail}`)
    .join("\n");

  const prompt = [
    "URGENTE: El watchdog detectó anomalías críticas en la base de datos.",
    "",
    `${alert.critical_count} anomalía(s) crítica(s) encontrada(s):`,
    errorSummary,
    "",
    "Revisa data/watchdog-reports.json para el reporte completo.",
    "Acción requerida: analiza y repara las anomalías detectadas.",
    "Después de reparar, ejecuta POST /api/v1/watchdog/alert/clear para limpiar la alerta.",
  ].join("\n");

  console.log("\n[Watchdog Runner] 🚨 Invocando opencode con alerta crítica...\n");

  try {
    // opencode run acepta un mensaje como argumento
    execSync(`opencode run "${prompt.replace(/"/g, '\\"')}"`, {
      cwd: process.cwd(),
      stdio: "inherit",
      timeout: 120_000, // 2 min máximo
    });
  } catch (e: any) {
    // Si opencode run falla (timeout, no instalado, etc.), fallback a log
    console.error("[Watchdog Runner] No se pudo invocar opencode:", e?.message);
    console.log("\n📋 Copia este prompt y pégalo en opencode manualmente:\n");
    console.log(prompt);
  }
}

async function main() {
  const once = process.argv.includes("--once");

  console.log("[Watchdog Runner] Iniciado", once ? "(modo una pasada)" : "(loop continuo)");

  if (once) {
    const result = await runWatchdogNow();
    if (result.report) {
      const r = result.report;
      console.log(`\n═══ Reporte Watchdog ═══`);
      console.log(`Duración: ${r.duration_ms}ms`);
      console.log(`Hallazgos: ${r.findings.length}`);
      console.log(`  - Títulos basura: ${r.scans.titles}`);
      console.log(`  - Metadatos incompletos: ${r.scans.metadata}`);
      console.log(`  - Huérfanos: ${r.scans.orphans}`);
      console.log(`  - Jobs stuck: ${r.scans.jobs}`);
      console.log(`  - Obras vacías: ${r.scans.empty_shows}`);
      console.log(`  - Duplicados: ${r.scans.duplicates}`);
      console.log(`Auto-reparados: ${r.fixes_applied}`);
      console.log(`Requieren atención: ${r.anomalies_remaining}`);

      if (r.findings.length > 0) {
        console.log(`\n── Hallazgos ──`);
        for (const f of r.findings.slice(0, 20)) {
          const icon = f.fixed ? "✓" : f.severity === "error" ? "✗" : "⚠";
          console.log(`  ${icon} [${f.category}] ${f.detail}`);
          if (f.fix_action) console.log(`    → ${f.fix_action}`);
        }
      }

      // Si hay errores críticos, invocar opencode
      const critical = r.findings.filter((f) => !f.fixed && (f.severity === "critical" || f.severity === "error"));
      if (critical.length > 0) {
        const alert = checkWatchdogAlert();
        invokeOpencodeWithAlert(alert);
      }
    }
    process.exit(0);
  }

  // Loop continuo: escanea cada 10 minutos
  const INTERVAL = 10 * 60 * 1000;
  while (true) {
    const result = await runWatchdogNow();
    if (result.report) {
      const r = result.report;
      const critical = r.findings.filter((f) => f.severity === "critical" || f.severity === "error");
      console.log(
        `[${new Date().toISOString()}] Watchdog: ${r.findings.length} hallazgos, ${r.fixes_applied} reparados, ${critical.length} críticos`
      );

      if (critical.length > 0) {
        const alert = checkWatchdogAlert();
        invokeOpencodeWithAlert(alert);
      }
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => {
  console.error("[Watchdog Runner] Fatal:", e);
  process.exit(1);
});
