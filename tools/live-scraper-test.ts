// Prueba LIVE de los adaptadores contra sitios reales.
// Usa URLs reales extraídas de la BD. Mide fetch + extractStream + analyze.
import { ScraperManager } from "../server/scrapers/ScraperManager";

const TEST_URLS: Array<{ label: string; urls: string[] }> = [
  {
    label: "TubePelis (películas)",
    urls: [
      "https://www.tubepelis.com/pelicula/4491/supergirl-woman-of-tomorrow.html",
      "https://www.tubepelis.com/pelicula/4566/golden-kamuy-el-asalto-a-la-prision-de-abashiri.html",
      "https://www.tubepelis.com/pelicula/4642/posesion-infernal-en-llamas.html",
      "https://www.tubepelis.com/pelicula/4667/el-final-de-oak-street.html",
    ],
  },
  {
    label: "VerAnimes (anime)",
    urls: [
      "https://wwv.veranimes.net/ver/kuroneko-to-majo-no-kyoushitsu-1",
      "https://wwv.veranimes.net/ver/otome-game-sekai-wa-mob-ni-kibishii-sekai-desu-2-1",
      "https://wwv.veranimes.net/ver/tai-ari-deshita-ojousama-wa-kakutou-game-nante-shinai-8",
    ],
  },
];

async function main() {
  const mgr = ScraperManager.getInstance();
  console.log("=== PRUEBA LIVE DE ADAPTADORES ===\n");

  for (const group of TEST_URLS) {
    console.log(`\n════════ ${group.label} ════════`);
    for (const url of group.urls) {
      const adapter = mgr.getAdapter(url);
      console.log(`\n→ ${url}`);
      if (!adapter) {
        console.log(`   ✗ Sin adaptador específico (usa GenericAdapter)`);
        continue;
      }
      console.log(`   Adaptador: ${adapter.name} (${adapter.id})`);

      // 1. extractStream (Just-In-Time)
      const t0 = Date.now();
      try {
        const r = await adapter.extractStream(url);
        const ms = Date.now() - t0;
        const ok = r.stream_url && r.stream_url !== url;
        console.log(`   extractStream (${ms}ms): ${ok ? "✓" : "✗ devolvió la misma URL (sin resolver)"} → ${(r.stream_url || "").slice(0, 90)}`);
        console.log(`   streams alternativos: ${r.all_available_streams?.length ?? 0}`);
      } catch (e: any) {
        console.log(`   extractStream: EXCEPCIÓN → ${e.message}`);
      }

      // 2. analyze (metadatos + streams)
      const t1 = Date.now();
      try {
        const a = await adapter.analyze(url);
        const ms = Date.now() - t1;
        console.log(`   analyze (${ms}ms): title="${a.title}" kind=${a.contentType ?? "?"} streams=${a.streams?.length ?? 0} desc_len=${(a.description || "").length}`);
        if (a.streams?.length) {
          console.log(`     stream[0]: ${a.streams[0].slice(0, 90)}`);
        }
      } catch (e: any) {
        console.log(`   analyze: EXCEPCIÓN → ${e.message}`);
      }
    }
  }
  console.log("\n=== FIN ===");
}

main().catch(console.error);