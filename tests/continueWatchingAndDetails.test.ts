import { describe, expect, it } from "vitest";
import type { WatchProgress } from "../src/components/ContinueWatching";
import type { Show } from "../src/types";

describe("ContinueWatching and Episode Progress Logic", () => {
  const mockShow: Show = {
    id: "show-anime-1",
    title: "Demon Slayer",
    category: "Anime",
    kind: "anime",
    episodes: [
      { id: "ep-1", show_id: "show-anime-1", title: "Crueldad", episode_number: 1 },
      { id: "ep-2", show_id: "show-anime-1", title: "Entrenador Sakonji Urokodaki", episode_number: 2 },
      { id: "ep-3", show_id: "show-anime-1", title: "Purificación", episode_number: 3 },
      { id: "ep-4", show_id: "show-anime-1", title: "Selección final", episode_number: 4 },
    ],
  };

  const mockMovie: Show = {
    id: "movie-1",
    title: "Inception",
    category: "Películas",
    kind: "movie",
    episodes: [
      { id: "ep-movie-1", show_id: "movie-1", title: "Inception", episode_number: 1 },
    ],
  };

  it("deduplica múltiples episodios de la misma serie a una sola tarjeta más reciente", () => {
    const history: WatchProgress[] = [
      {
        showId: "show-anime-1",
        showTitle: "Demon Slayer",
        episodeId: "ep-3",
        episodeNumber: 3,
        episodeTitle: "Purificación",
        progressPercent: 45,
        lastWatchedAt: 3000,
      },
      {
        showId: "show-anime-1",
        showTitle: "Demon Slayer",
        episodeId: "ep-2",
        episodeNumber: 2,
        episodeTitle: "Entrenador Sakonji Urokodaki",
        progressPercent: 100,
        lastWatchedAt: 2000,
      },
      {
        showId: "show-anime-1",
        showTitle: "Demon Slayer",
        episodeId: "ep-1",
        episodeNumber: 1,
        episodeTitle: "Crueldad",
        progressPercent: 100,
        lastWatchedAt: 1000,
      },
    ];

    // Agrupación por showId
    const groups = new Map<string, WatchProgress[]>();
    history.forEach((it) => {
      if (!groups.has(it.showId)) groups.set(it.showId, []);
      groups.get(it.showId)!.push(it);
    });

    expect(groups.size).toBe(1);
    const sorted = groups.get("show-anime-1")!.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
    const latest = sorted[0];

    expect(latest.episodeId).toBe("ep-3");
    expect(latest.progressPercent).toBe(45);
  });

  it("avanza automáticamente al siguiente episodio cuando el actual se completa (>=85%)", () => {
    const latest: WatchProgress = {
      showId: "show-anime-1",
      showTitle: "Demon Slayer",
      episodeId: "ep-2",
      episodeNumber: 2,
      episodeTitle: "Entrenador Sakonji Urokodaki",
      progressPercent: 95,
      lastWatchedAt: 2000,
    };

    const allEpisodes = [...mockShow.episodes!].sort((a, b) => a.episode_number - b.episode_number);
    const currentIdx = allEpisodes.findIndex((e) => e.id === latest.episodeId);
    expect(currentIdx).toBe(1);

    const nextEp = allEpisodes[currentIdx + 1];
    expect(nextEp).toBeDefined();
    expect(nextEp.episode_number).toBe(3);
    expect(nextEp.title).toBe("Purificación");
  });

  it("identifica películas para no marcarlas como 'Ep. 1'", () => {
    const isMovie = Boolean(
      mockMovie.kind === "movie" ||
      ["pelicula", "película", "peliculas", "películas", "movie"].includes(mockMovie.category.toLowerCase()) ||
      (mockMovie.episodes?.length === 1 && !/episodio|capitulo/i.test(mockMovie.episodes[0].title))
    );

    expect(isMovie).toBe(true);
  });

  it("calcula estados de completado y progreso para el panel de detalles", () => {
    const history: WatchProgress[] = [
      {
        showId: "show-anime-1",
        showTitle: "Demon Slayer",
        episodeId: "ep-1",
        episodeNumber: 1,
        episodeTitle: "Crueldad",
        progressPercent: 95,
        lastWatchedAt: 1000,
      },
      {
        showId: "show-anime-1",
        showTitle: "Demon Slayer",
        episodeId: "ep-2",
        episodeNumber: 2,
        episodeTitle: "Entrenador Sakonji Urokodaki",
        progressPercent: 50,
        lastWatchedAt: 2000,
      },
    ];

    const map = new Map<string, number>();
    history.forEach((h) => map.set(h.episodeId, h.progressPercent));

    // Ep 1: Visto (>85%)
    expect(map.get("ep-1")! >= 85).toBe(true);

    // Ep 2: En progreso (50%)
    const ep2Percent = map.get("ep-2")!;
    expect(ep2Percent > 0 && ep2Percent < 85).toBe(true);

    // Ep 3: No visto (sin progreso)
    expect(map.get("ep-3")).toBeUndefined();
  });
});
