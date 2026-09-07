import { describe, expect, it } from "vitest";
import { fallbackChain, getProviderDefinition, listProvidersForKind } from "./providerRegistry";

describe("provider registry", () => {
  it("exposes discovery, resolver and host metadata from the policy", () => {
    expect(getProviderDefinition("https://www.cinecalidad.am/ver-pelicula/bolt/")).toMatchObject({
      id: "cinecalidad",
      discovery: "page",
      resolver: "cinecalidad",
      hosts: expect.arrayContaining(["vimeos.zip", "goodstream.one"]),
      fallbackProvider: "gnula",
    });
  });

  it("orders only active providers for each content kind", () => {
    const anime = listProvidersForKind("anime").map((entry) => entry.id);
    expect(anime.slice(0, 3)).toEqual(["direct", "latanime", "zokoanime"]);
    expect(anime).toContain("zokoanime");
    expect(anime).not.toContain("animeflv");
    expect(anime).not.toContain("tioanime");
  });

  it("models Cinecalidad to Gnula and ZokoAnime to TioAnime fallback chains", () => {
    expect(fallbackChain("cinecalidad", "movie").map((entry) => entry.id)).toEqual(["cinecalidad", "gnula"]);
    expect(fallbackChain("zokoanime", "anime").map((entry) => entry.id)).toEqual(["zokoanime", "tioanime"]);
  });
});
