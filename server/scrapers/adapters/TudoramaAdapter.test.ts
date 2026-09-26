import { afterEach, describe, expect, it, vi } from "vitest";
import { TudoramaAdapter } from "./TudoramaAdapter";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const htmlResponse = (html: string) => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

describe("TudoramaAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts Tudorama hosts and rejects lookalikes", () => {
    const adapter = new TudoramaAdapter();
    expect(adapter.canHandle("https://tudorama.com/genero/series/")).toBe(true);
    expect(adapter.canHandle("https://www.tudorama.com/ver/demo/")).toBe(true);
    expect(adapter.canHandle("https://evil-tudorama.com/ver/demo/")).toBe(false);
  });

  it("extracts canonical cards and follows the category pagination link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse(`
      <html><head><title>Series - Tudorama</title></head><body>
        <article class="item"><a href="/serie/amor-de-mentira/"><h3>Amor de mentira</h3><img src="/poster.jpg"></a></article>
        <article class="item"><a href="https://tudorama.com/serie/amor-de-mentira/"><h3>Duplicado</h3></a></article>
        <nav><a class="next page-numbers" href="/genero/series/page/2/">Siguiente</a></nav>
      </body></html>`));
    const result = await new TudoramaAdapter().analyze("https://tudorama.com/genero/series/", "catalog");
    expect(result.catalog_items).toHaveLength(1);
    expect(result.catalog_items[0]).toMatchObject({ title: "Amor de mentira", url: "https://tudorama.com/serie/amor-de-mentira/", kind: "series" });
    expect(result.next_page_url).toBe("https://tudorama.com/genero/series/page/2/");
  });

  it("paginates WStream episodes through corvus_get_episodes and deduplicates SSR rows", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(htmlResponse(`
        <meta property="og:title" content="Amor de mentira | Tudorama">
        <div class="eps" data-tmdb-id="281011" data-season-number="1" data-nonce="nonce" data-results="2">
          <ul><li class="lep"><a href="/ver/amor-de-mentira-s1x1/">Episodio 1</a></li></ul>
        </div>`))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { results: [
        { permalink: "https://tudorama.com/ver/amor-de-mentira-s1x1/", name: "Episodio 1", episode_number: 1, season_number: 1 },
        { permalink: "https://tudorama.com/ver/amor-de-mentira-s1x2/", name: "Episodio 2", episode_number: 2, season_number: 1 },
      ], hasMore: false } }));
    const result = await new TudoramaAdapter().analyze("https://tudorama.com/serie/amor-de-mentira/", "detail");
    expect(result.episodes.map((episode) => episode.number)).toEqual([1, 2]);
    expect(result.episodes.every((episode) => episode.url.includes("/ver/"))).toBe(true);
  });

  it("requests servers JIT, unwraps the CDN wrapper and reuses the existing embed resolver", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(htmlResponse(`<meta property="og:title" content="Volveré por ti | Tudorama"><div class="ep__dropdown" data-id="8252" data-nonce="nonce"></div>`))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [
        { url: "https://cdn.tudorama.com/stream/server-2.php?id1=abc", name: "Filemoon", lang: "en" },
        { url: "https://cdn.tudorama.com/stream/abyss.php?id1=def", name: "Abyss", lang: "en" },
      ] }))
      .mockResolvedValueOnce(htmlResponse(`<iframe src="https://bysesukior.com/e/abc"></iframe>`))
      .mockResolvedValueOnce(htmlResponse(`<iframe src="https://abyssplayer.com/def"></iframe>`));
    vi.spyOn(EmbedResolvers, "resolveWithMeta").mockResolvedValue({ resolved: true, url: "https://cdn.example/master.m3u8", type: "direct", provider: "Bysesukior", is_proxyable: true, is_refreshable: true });
    vi.spyOn(MediaValidator, "validateUrls").mockResolvedValue(["https://cdn.example/master.m3u8"]);
    const result = await new TudoramaAdapter().extractStream("https://tudorama.com/ver/volvere-por-ti-cap-1-sub-esp/");
    expect(result.stream_url).toBe("https://cdn.example/master.m3u8");
    expect(result.all_available_streams).toEqual(["https://cdn.example/master.m3u8"]);
  });
});
