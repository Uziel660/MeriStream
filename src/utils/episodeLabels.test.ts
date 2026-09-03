import { describe, expect, it } from "vitest";
import { displayEpisodeTitle } from "./episodeLabels";

describe("displayEpisodeTitle", () => {
  it("oculta artefactos de capítulo/temporada/fecha", () => {
    expect(displayEpisodeTitle("Capitulo 1S1.E117 de Mayo del 2026", 1)).toBe("Episodio 1");
    expect(displayEpisodeTitle("Capitulo 7S1.E7", 7)).toBe("Episodio 7");
    expect(displayEpisodeTitle("Capitulo 29", 29)).toBe("Episodio 29");
  });

  it("conserva títulos editoriales válidos", () => {
    expect(displayEpisodeTitle("Capítulo 1: La llegada", 1)).toBe("Capítulo 1: La llegada");
    expect(displayEpisodeTitle("When the Buckwheat Flowers Bloom", 1)).toBe("When the Buckwheat Flowers Bloom");
  });

  it("usa un fallback seguro para valores vacíos", () => {
    expect(displayEpisodeTitle(undefined, 3)).toBe("Episodio 3");
    expect(displayEpisodeTitle("undefined", undefined)).toBe("Episodio");
  });
});
