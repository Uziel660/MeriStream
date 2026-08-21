/**
 * Prueba de integración REAL del adaptador LatAnime.
 * Ejecutar con: npx tsx test_latanime.ts
 */
import { LatAnimeAdapter } from "./server/scrapers/adapters/LatAnimeAdapter";

async function main() {
  const adapter = new LatAnimeAdapter();

  console.log("=== PASO 1: Búsqueda de 'Mushoku Tensei' en latanime.org ===");
  const results = await adapter.search("Mushoku Tensei");
  console.log(`Resultados encontrados: ${results.length}`);
  for (const item of results.slice(0, 5)) {
    console.log(`  - [${item.year ?? "?"}] ${item.title} -> ${item.url}`);
  }

  if (results.length === 0) {
    throw new Error("La búsqueda no devolvió resultados");
  }

  // Preferir el resultado cuyo título contenga "Mushoku Tensei" y sea latino
  const target =
    results.find((r) => /mushoku tensei/i.test(r.title) && /latino/i.test(r.title)) ||
    results[0];

  console.log(`\n=== PASO 2: Análisis de detalles de "${target.title}" ===`);
  const analysis = await adapter.analyze(target.url);
  console.log(`Título:        ${analysis.title}`);
  console.log(`Descripción:   ${(analysis.description || "(sin sinopsis)").slice(0, 120)}...`);
  console.log(`Poster:        ${analysis.poster_url}`);
  console.log(`Año:           ${analysis.year}`);
  console.log(`Tipo:          ${analysis.content_type}`);
  console.log(`Episodios:     ${analysis.episodes.length}`);
  if (analysis.episodes.length > 0) {
    console.log(`  Primer episodio: #${analysis.episodes[0].number} - ${analysis.episodes[0].title}`);
    console.log(`    URL: ${analysis.episodes[0].url}`);
    console.log(`  Último episodio: #${analysis.episodes[analysis.episodes.length - 1].number} - ${analysis.episodes[analysis.episodes.length - 1].title}`);
  }

  if (analysis.episodes.length === 0) {
    throw new Error("No se extrajeron episodios de la página de detalle");
  }

  const firstEpisode = analysis.episodes[0];
  console.log(`\n=== PASO 3: Resolución de video del episodio ${firstEpisode.number} ===`);
  console.log(`Página del episodio: ${firstEpisode.url}`);

  const stream = await adapter.extractStream(firstEpisode.url);
  console.log(`\n--- RESULTADO ---`);
  console.log(`STREAM PRINCIPAL: ${stream.stream_url}`);

  console.log(`\nTodos los streams disponibles (${stream.all_available_streams.length}):`);
  for (const s of stream.all_available_streams) {
    console.log(`  * ${s}`);
  }

  const isDirect = /\.(m3u8|mp4|webm)(\?|$)/i.test(stream.stream_url);
  console.log(`\n¿Stream directo (.m3u8/.mp4)?: ${isDirect ? "SÍ ✔" : "NO (fallback a embed)"}`);

  if (!isDirect) {
    console.warn("\nADVERTENCIA: No se obtuvo un .m3u8/.mp4 directo, se devolvió embed.");
  }
}

main()
  .then(() => {
    console.log("\nTEST COMPLETADO");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nTEST FALLIDO:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
