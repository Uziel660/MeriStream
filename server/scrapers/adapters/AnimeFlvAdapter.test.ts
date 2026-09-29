import { describe, expect, it, vi } from "vitest";
import * as cheerio from "cheerio";
import { AnimeFlvAdapter } from "./AnimeFlvAdapter";

describe("AnimeFlvAdapter · fallback JKanime", () => {
  it("usa la búsqueda por slug y descarta enlaces de navegación", async () => {
    const adapter: any = new AnimeFlvAdapter();
    const calls: string[] = [];
    vi.spyOn(adapter, "fetchHtml").mockImplementation(async (url: string) => {
      calls.push(url);
      return `<a href="https://jkanime.net/notificaciones/">Avisos</a>
        <a href="https://jkanime.net/yozakura-san-chi-no-daisakusen-2nd-season/">Resultado</a>`;
    });

    const result = await adapter.searchJkanime("yozakura san chi no daisakusen");

    expect(calls[0]).toBe("https://jkanime.net/buscar/yozakura-san-chi-no-daisakusen");
    expect(result).toEqual(["https://jkanime.net/yozakura-san-chi-no-daisakusen-2nd-season/"]);
  });

  it("acepta una consulta por título para recuperar enlaces canónicos", async () => {
    const adapter: any = new AnimeFlvAdapter();
    vi.spyOn(adapter, "searchJkanime").mockResolvedValue([
      "https://jkanime.net/yozakura-san-chi-no-daisakusen-2nd-season/",
    ]);

    const result = await adapter.analyze("Yozakura-san Chi no Daisakusen 2nd Season");

    expect(result.page_type).toBe("catalog");
    expect(result.source_domain).toBe("jkanime.net");
    expect(result.catalog_items[0]).toMatchObject({
      title: "Yozakura-san Chi no Daisakusen",
      url: "https://jkanime.net/yozakura-san-chi-no-daisakusen-2nd-season/",
    });
  });

  it("lee el payload JSON del directorio actual de JKanime", () => {
    const adapter: any = new AnimeFlvAdapter();
    const html = `
      <script>
        var animes = {"data":[
          {"title":"One Piece","url":"https:\\/\\/jkanime.net\\/one-piece\\/","image":"https:\\/\\/cdn.example\\/one.jpg"},
          {"title":"Naruto","url":"https:\\/\\/jkanime.net\\/naruto\\/","image":"https:\\/\\/cdn.example\\/naruto.jpg"}
        ],"last_page":2};
        var mode = 1;
      </script>`;

    expect(adapter.extractJkanimeCatalogItems(html)).toEqual([
      expect.objectContaining({ title: "One Piece", url: "https://jkanime.net/one-piece/", kind: "anime" }),
      expect.objectContaining({ title: "Naruto", url: "https://jkanime.net/naruto/", kind: "anime" }),
    ]);
  });

  it("extrae episodios y el embed Zilla del tema AnimeStream de animeflv.ar", () => {
    const adapter: any = new AnimeFlvAdapter();
    const html = `<h1 class="anime-title">Aishiteru Game wo Owarasetai</h1>
      <div class="eplister"><ul>
        <li><a href="https://animeflv.ar/aishiteru-game-wo-owarasetai-episodio-2-sub-espanol/"><div class="epl-num">2</div><div class="epl-title">Episodio 2 Sub Español</div></a></li>
        <li><a href="https://animeflv.ar/aishiteru-game-wo-owarasetai-episodio-1-sub-espanol/"><div class="epl-num">1</div><div class="epl-title">Episodio 1 Sub Español</div></a></li>
      </ul></div>`;
    const episodes = adapter.extractAnimeflvEpisodes(cheerio.load(html), html, new URL("https://animeflv.ar/anime/aishiteru-game-wo-owarasetai/"));
    expect(episodes).toHaveLength(2);
    expect(episodes.map((episode: any) => episode.number)).toEqual([2, 1]);

    const episodeHtml = `<div id="pembed"><iframe src="https://player.zilla-networks.com/play/example"></iframe></div>`;
    const streams = adapter.extractAnimeflvStreams(cheerio.load(episodeHtml), episodeHtml, "https://animeflv.ar/aishiteru-game-wo-owarasetai-episodio-1-sub-espanol/");
    expect(streams).toEqual(["https://player.zilla-networks.com/play/example"]);
  });
});
