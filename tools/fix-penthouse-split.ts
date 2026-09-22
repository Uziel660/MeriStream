import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("[fix-penthouse-split] Iniciando corrección de 'The Penthouse'...");

  // 1. Localizar la fila actual de la película que tiene los episodios mezclados
  const movieShow = await prisma.show.findUnique({
    where: { id: "mtu67v58mtqjy78v" },
    include: { episodes: true }
  });

  if (!movieShow) {
    console.error("No se encontró la película con ID mtu67v58mtqjy78v");
    process.exit(1);
  }

  console.log(`Película encontrada: ${movieShow.title} (${movieShow.year}) - TMDB ${movieShow.tmdb_id}, episodios: ${movieShow.episodes.length}`);

  // 2. Crear o buscar la ficha correcta de la serie de TV "The Penthouse: Guerra en la vida" (TMDB 99489)
  let seriesShow = await prisma.show.findFirst({
    where: { tmdb_id: 99489 }
  });

  if (!seriesShow) {
    console.log("Creando la serie de TV canónica para 'Penthouse: Guerra en la vida' (TMDB: 99489)...");
    seriesShow = await prisma.show.create({
      data: {
        title: "Penthouse: Guerra en la vida",
        original_title: "펜트하우스",
        english_title: "The Penthouse: War in Life",
        normalized_title: "penthouse guerra en la vida",
        base_normalized_title: "penthouse",
        description: "Una mujer adinerada nacida en la alta sociedad y una mujer que sueña con entrar en ella compiten ferozmente en el Hera Palace, un ático de 100 pisos en Gangnam.",
        category: "series",
        year: 2020,
        status: "Finalizado",
        genres: "Drama, Misterio, Crimen",
        rating: 8.5,
        source: "doramasflix",
        tmdb_id: 99489,
        imdb_id: "tt13067118",
        poster_url: "https://image.tmdb.org/t/p/w500/z0T0oYq9n6e6r2p9uU5q9d9a.jpg",
        backdrop_path: "/6UH52FANNj28szJq9tPcmxG7eYn.jpg",
        poster_path: "/z0T0oYq9n6e6r2p9uU5q9d9a.jpg",
      }
    });
    console.log(`Serie creada con ID: ${seriesShow.id}`);
  }

  // 3. Crear el episodio 1x1 si no existe en la serie
  const ep1Series = await prisma.episode.findFirst({
    where: { show_id: seriesShow.id, episode_number: 1 }
  });

  if (!ep1Series) {
    console.log("Creando episodio 1x1 de Doramasflix para la serie...");
    await prisma.episode.create({
      data: {
        show_id: seriesShow.id,
        title: "Penthouse: Guerra en la vida 1x1",
        episode_number: 1,
        source_url: "https://doramasflix.io/capitulos/penthouse-1x1",
      }
    });
  }

  // 4. Mover los episodios 2..8 de Doramasflix a la serie de TV
  const doramasEpisodes = movieShow.episodes.filter(ep => ep.source_url.includes("doramasflix.io"));
  console.log(`Moviendo ${doramasEpisodes.length} episodios de Doramasflix a la serie...`);

  for (const ep of doramasEpisodes) {
    await prisma.episode.update({
      where: { id: ep.id },
      data: { show_id: seriesShow.id }
    });
  }

  // 5. Dejar en la película únicamente el episodio 1 de la película
  const remainingMovieEps = await prisma.episode.findMany({
    where: { show_id: movieShow.id }
  });

  console.log(`Episodios restantes en la película ${movieShow.id}: ${remainingMovieEps.length}`);
  for (const ep of remainingMovieEps) {
    console.log(` - Ep ${ep.episode_number}: ${ep.title} (${ep.source_url})`);
  }

  console.log("\n[fix-penthouse-split] ¡Separación completada con éxito!");
  await prisma.$disconnect();
}

main().catch(console.error);
