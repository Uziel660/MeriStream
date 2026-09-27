import { describe, expect, it } from "vitest";
import { normalizeExtractedEpisode, normalizeExtractedEpisodes } from "./catalogFusion";

describe("catalogFusion", () => {
  it("conserva todas las fuentes de un episodio conocido", () => {
    const episode = normalizeExtractedEpisode({
      number: 4,
      title: "Capítulo 4",
      url: "https://animeflv.example/episode/4",
      sources: [
        { url: "https://animeflv.example/episode/4", source_site: "animeflv" },
        { url: "https://cdn.example/episode/4.m3u8", source_site: "cdn", link_type: "direct" },
        { url: "https://embed.example/e/4", source_site: "embed", host: "embed.example" },
      ],
    }, "fallback");

    expect(episode?.url).toBe("https://animeflv.example/episode/4");
    expect(episode?.sources).toHaveLength(3);
    expect(episode?.sources?.map((source) => source.source_site)).toEqual(["animeflv", "cdn", "embed"]);
  });

  it("usa la primera fuente cuando el adaptador no entrega url primaria", () => {
    const episode = normalizeExtractedEpisode({
      episode_number: 2,
      sources: [{ url: "https://provider.example/e2" }],
    }, "provider");

    expect(episode).toMatchObject({ number: 2, url: "https://provider.example/e2" });
    expect(episode?.sources?.[0].source_site).toBe("provider");
  });

  it("descarta entradas vacías sin alterar el orden útil", () => {
    const episodes = normalizeExtractedEpisodes([
      { number: 1, url: "https://one.example/e1" },
      { number: 2, url: "" },
      { number: 3, url: "https://three.example/e3" },
    ], "site");
    expect(episodes.map((episode) => episode.number)).toEqual([1, 3]);
  });

  it("marca las variantes de idioma de DoramasYT sin cambiar sus URLs", () => {
    const episode = normalizeExtractedEpisode({
      number: 1,
      title: "Capítulo 1",
      url: "https://www.doramasyt.com/ver/demo-latino-episodio-1",
      sources: [{
        url: "https://www.doramasyt.com/ver/demo-latino-episodio-1",
        source_site: "doramasyt",
      }],
    }, "doramasyt");

    expect(episode?.url).toBe("https://www.doramasyt.com/ver/demo-latino-episodio-1");
    expect(episode?.sources?.[0]).toMatchObject({
      source_site: "doramasyt",
      language: "dub",
      audio_language: "es-419",
    });
  });
});
