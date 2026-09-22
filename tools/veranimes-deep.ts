import { VerAnimesAdapter } from "../server/scrapers/adapters/VerAnimesAdapter";

const a = new VerAnimesAdapter();

(async () => {
  console.log("=== START VERANIMES TEST ===");

  console.log("\n[1] BÚSQUEDA ('naruto')");
  const searchRes = await a.search("naruto");
  console.log(`Encontrados: ${searchRes.length}`);
  for (const item of searchRes.slice(0, 5)) {
    console.log(`  - [${item.title}] (${item.url}) img: ${item.image_url}`);
  }

  console.log("\n[2] CATÁLOGO (/animes)");
  const catRes = await a.analyze("https://wwv.veranimes.net/animes", "catalog");
  console.log(`Items en catálogo: ${catRes.catalog_items.length}`);
  for (const item of catRes.catalog_items.slice(0, 3)) {
    console.log(`  - [${item.title}] (${item.url}) img: ${item.image_url}`);
  }

  const testDetailUrls = [
    "https://wwv.veranimes.net/anime/naruto-shippuden",
    "https://wwv.veranimes.net/anime/one-piece",
    "https://wwv.veranimes.net/anime/dragon-ball-super",
    "https://wwv.veranimes.net/anime/solo-leveling"
  ];

  for (const dUrl of testDetailUrls) {
    console.log(`\n[3] DETALLE (${dUrl})`);
    const detailRes = await a.analyze(dUrl, "detail");
    console.log(`  Título: "${detailRes.title}"`);
    console.log(`  Status: ${detailRes.status}`);
    console.log(`  Episodios: ${detailRes.episodes.length}`);
    if (detailRes.episodes.length > 0) {
      console.log(`    Ep 1: ${detailRes.episodes[0].title} -> ${detailRes.episodes[0].url}`);
      console.log(`    Ep Ultimo: ${detailRes.episodes[detailRes.episodes.length - 1].title} -> ${detailRes.episodes[detailRes.episodes.length - 1].url}`);
      
      console.log(`  [4] STREAM para primer episodio: ${detailRes.episodes[0].url}`);
      const st = await a.extractStream(detailRes.episodes[0].url);
      console.log(`    stream_url: ${st.stream_url}`);
      console.log(`    all streams (${st.all_available_streams.length}):`);
      st.all_available_streams.forEach(s => console.log(`      * ${s}`));
    }
  }

  console.log("\n=== END VERANIMES TEST ===");
})();
