import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DoramasflixAdapter } from "../../server/scrapers/adapters/DoramasflixAdapter";
import { ScraperManager } from "../../server/scrapers/ScraperManager";
import { EmbedResolvers } from "../../server/resolvers";
import { MediaValidator } from "../../server/validator";
import * as cheerio from "cheerio";

describe("DoramasflixAdapter", () => {
  const adapter = new DoramasflixAdapter();

  it("identifica correctamente los dominios soportados", () => {
    expect(adapter.canHandle("https://doramasflix.io/doramas")).toBe(true);
    expect(adapter.canHandle("https://doramasflix.co/peliculas")).toBe(true);
    expect(adapter.canHandle("https://doramasflix.net/variedades")).toBe(true);
    expect(adapter.canHandle("https://otro-sitio.com")).toBe(false);
    expect(adapter.canHandle("https://doramasflix.io.evil.example/doramas")).toBe(false);
  });

  it("lee episodios y la identidad nativa desde JSON-LD/React Flight", () => {
    const source = `<script type="application/ld+json">{"@type":"TVSeries","name":"Título romanizado","alternateName":"ชื่อไทย","description":"Descripción","image":"https://img.test/poster.jpg","datePublished":"2026-01-01","genre":["Drama"]}</script>
      <script>initialEpisodes":[{"id":"6a9f5303d5181060190ba7bf","slug":"titulo-1x1","episode_number":1,"season_number":1,"title":"ชื่อไทย 1x1","href":"/capitulos/titulo-1x1"},{"id":"6a9f5303d5181060190ba7c8","slug":"titulo-1x2","episode_number":2,"season_number":1,"title":"ชื่อไทย 1x2","href":"/capitulos/titulo-1x2"}]</script>`;
    const parsed = (adapter as any).extractInitialEpisodes(source);
    expect(parsed).toEqual([
      { number: 1, season: 1, title: "ชื่อไทย 1x1", url: "/capitulos/titulo-1x1" },
      { number: 2, season: 1, title: "ชื่อไทย 1x2", url: "/capitulos/titulo-1x2" },
    ]);
    const ld = (adapter as any).extractJsonLdMetadata(cheerio.load(source));
    expect(ld).toMatchObject({ title: "Título romanizado", originalTitle: "ชื่อไทย", year: 2026, genres: ["Drama"] });
  });

  it("se registra correctamente en ScraperManager", () => {
    const manager = ScraperManager.getInstance();
    const resolvedAdapter = manager.getAdapter("https://doramasflix.io/doramas");
    expect(resolvedAdapter.id).toBe("doramasflix");
  });

  it("desencripta correctamente enlaces de embedshortener.co JWT", () => {
    const validJwtUrl =
      "https://embedshortener.co/e/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsaW5rIjoiYUhSMGNITTZMeTl3Y21sdFpXeHZZV1F1WTI4dlpXMWlaV1F2V1V0WE5USklaM1JKUkVNMCIsInNlcnZlciI6IjQ3MjEiLCJhcHAiOiJjb20uYXNpYXBwLmRvcmFtYXNnbyIsImlhdCI6MTc4Nzg1NTQwOCwiZXhwIjoxNzg4MDI4MjA4fQ.QwqlrzoS2F8QLP0TZY0WLTrxpHKuBpCrcRa9FzeEyZk";
    const decoded = (adapter as any).decodeEmbedShortenerLink(validJwtUrl);
    expect(decoded).toBe("https://primeload.co/embed/YKW52HgtIDC4");
  });

  describe("extracción robusta de episode_id (HTML escapado / React Flight)", () => {
    it("extrae episode_id en HTML con escape \\\" (React Flight)", () => {
      const escapedHtml = `self.__next_f.push([1,"0:{\\\\\\"episode\\\\\\":{\\\\\\"_id\\\\\\":\\\\\\"6a91ee5924356d46eff28f0b\\\\\\"}}"])`;
      const id = (adapter as any).extractEpisodeId(escapedHtml);
      expect(id).toBe("6a91ee5924356d46eff28f0b");
    });

    it("extrae episode_id en HTML con \\u0022 (unicode escape)", () => {
      const fixture = '{"episode":{\\u0022_id\\u0022:\\u002226a921f0224356d46eff2a335\\u00222}}';
      const id = (adapter as any).extractEpisodeId(fixture);
      expect(id).toBe("6a921f0224356d46eff2a335");
    });

    it("extrae episode_id normal sin escape", () => {
      const html = `{"episode":{"_id":"6a921ede24356d46eff2a2f5","name":"Mousetrap"}}`;
      const id = (adapter as any).extractEpisodeId(html);
      expect(id).toBe("6a921ede24356d46eff2a2f5");
    });

    it("extrae episode_id desde payload Flight inline", () => {
      const flight = `self.__next_f.push([1,"{\\\\\\"episode\\\\\\":{\\\\\\"_id\\\\\\":\\\\\\"6a91ee5924356d46eff28f0b\\\\\\",\\\\\\"name\\\\\\":\\\\\\"Love With Benefits 1x1\\\\\\"}}"])`;
      const id = (adapter as any).extractEpisodeId(flight);
      expect(id).toBe("6a91ee5924356d46eff28f0b");
    });
  });

  describe("parseo resiliente de respuesta Next-Action (no asumir solo 1:)", () => {
    it("parsea payload en línea 1: (formato clásico)", () => {
      const servers = [{ link: "https://embedshortener.co/e/JWT" }, { link: "https://embedshortener.co/e/JWT2" }];
      const actionText = `0:{"a":"$@1"}\n1:${JSON.stringify(servers)}\n2:[]`;
      const parsed = (adapter as any).parseActionServers(actionText);
      expect(parsed).toEqual(servers);
    });

    it("parsea payload en línea 2: cuando el válido usa otra línea", () => {
      const servers = [{ link: "https://embedshortener.co/e/ABC", server: "4721" }];
      const actionText = `0:{"a":"$@1","f":"","q":""}\n2:${JSON.stringify(servers)}\n3:[]`;
      const parsed = (adapter as any).parseActionServers(actionText);
      expect(parsed).toEqual(servers);
    });

    it("encuentra servers en fallback con embedshortener", () => {
      const fallbackText = `0:{"a":"$@1"}\n1:[{"link":"https://embedshortener.co/e/FOUND"}]\n`;
      const parsed = (adapter as any).parseActionServers(fallbackText);
      expect(parsed[0].link).toBe("https://embedshortener.co/e/FOUND");
    });

    it("retorna null si no hay link", () => {
      const actionText = `0:{"a":"$@1"}\n1:[]\n2:{"no":"servers"}`;
      const parsed = (adapter as any).parseActionServers(actionText);
      expect(parsed).toBeNull();
    });
  });

  describe("extractStream con mocks (no devuelve URL de página ni embed sin resolver)", () => {
    let fetchSpy: any;
    let resolveSpy: any;
    let validateSpy: any;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
      resolveSpy = vi.spyOn(EmbedResolvers, "resolve");
      validateSpy = vi.spyOn(MediaValidator, "validateUrls");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("resuelve a media directa usando mocks y no acepta URL de página", async () => {
      const htmlFixture = `self.__next_f.push([1,"episode\\":{\\"_id\\":\\"6a921f0224356d46eff2a335\\"}"]) <script>/_next/static/chunks/0.nnic9fo0go8.js</script>`;
      vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(htmlFixture);
      vi.spyOn(adapter as any, "discoverNextActionId").mockResolvedValue("406bdec544eeb53cbefa09322cbda67963eb850496");
      vi.spyOn(adapter as any, "buildNextRouterStateTree").mockReturnValue("mock-tree");
      vi.spyOn(adapter as any, "isDirectReachable").mockResolvedValue(true);

      const jwtLink = "https://embedshortener.co/e/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsaW5rIjoiYUhSMGNITTZMeTltYkdGemQybHphQzVqYjIwdlpTODRhM0ZqYkRsamMzY3pkWGc9Iiwic2VydmVyIjoiMzg1ODUiLCJhcHAiOiJjb20uYXNpYXBwLmRvcmFtYXNnbyIsImlhdCI6MTc4ODAyNjA3NCwiZXhwIjoxNzg4MTk4ODc0fQ.vYTi9nQed1PzDoc4CPKmcmugQCglJVTKOIcwGeihFqU";
      const decodedEmbed = "https://g0v.example/decode-38585";
      const directM3u8 = "https://prime.example/master.m3u8";

      vi.spyOn(adapter as any, "decodeEmbedShortenerLink").mockReturnValue(decodedEmbed);

      const serversPayload = [{ link: jwtLink, server: "38585" }];
      const actionText = `0:{"a":"$@1"}\n2:${JSON.stringify(serversPayload)}\n`;
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => actionText,
      } as any);

      resolveSpy.mockResolvedValue(directM3u8);
      validateSpy.mockResolvedValue([directM3u8]);

      const result = await adapter.extractStream("https://doramasflix.io/capitulos/mousetrap-1x1");

      expect(fetchSpy).toHaveBeenCalled();
      const fetchCall = fetchSpy.mock.calls[0];
      expect(fetchCall[1].headers["Next-Action"]).toBe("406bdec544eeb53cbefa09322cbda67963eb850496");
      expect(fetchCall[1].headers["Next-Router-State-Tree"]).toBe("mock-tree");
      expect(fetchCall[1].headers["Referer"]).toBe("https://doramasflix.io/capitulos/mousetrap-1x1");

      expect(resolveSpy).toHaveBeenCalledWith(decodedEmbed);
      expect(validateSpy).toHaveBeenCalled();

      expect(result.stream_url).toBe(directM3u8);
      expect(result.all_available_streams).toContain(directM3u8);
      expect(result.stream_url).not.toBe("https://doramasflix.io/capitulos/mousetrap-1x1");
      expect(result.stream_url).not.toContain("embedshortener");
    });

    it("no maquilla embed: si solo hay embed, falla a pageURL (E2E debe fallar)", async () => {
      const htmlFixture = `{"episode":{"_id":"6a921f0224356d46eff2a335"}}`;
      vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(htmlFixture);
      vi.spyOn(adapter as any, "discoverNextActionId").mockResolvedValue("406bdec544eeb53cbefa09322cbda67963eb850496");
      vi.spyOn(adapter as any, "buildNextRouterStateTree").mockReturnValue("t");
      vi.spyOn(adapter as any, "decodeEmbedShortenerLink").mockReturnValue("https://example.com/embed/123");

      const serversPayload = [{ link: "https://embedshortener.co/e/JWT" }];
      const actionText = `1:${JSON.stringify(serversPayload)}`;
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => actionText } as any);
      resolveSpy.mockResolvedValue("https://example.com/embed/123");
      validateSpy.mockResolvedValue(["https://example.com/embed/123"]);
      vi.spyOn(adapter as any, "isDirectReachable").mockResolvedValue(false);

      const result = await adapter.extractStream("https://doramasflix.io/capitulos/mousetrap-1x1");
      expect(result.stream_url).toBe("");
      expect(result.all_available_streams).toEqual([]);
    });

    it("limpia timers en finally incluso cuando fetch aborta", async () => {
      const htmlFixture = `{"episode":{"_id":"6a921f0224356d46eff2a335"}}`;
      vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(htmlFixture);
      vi.spyOn(adapter as any, "discoverNextActionId").mockResolvedValue("406bdec544eeb53cbefa09322cbda67963eb850496");
      vi.spyOn(adapter as any, "buildNextRouterStateTree").mockReturnValue("t");
      fetchSpy.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("abort")), 10)));

      const result = await adapter.extractStream("https://doramasflix.io/capitulos/mousetrap-1x1");
      expect(result.stream_url).toBe("");
      expect(result.all_available_streams).toEqual([]);
    });

    it("fallback a constante anterior si descubrimiento falla", async () => {
      const htmlFixture = `{"episode":{"_id":"6a921f0224356d46eff2a335"}} <script>/_next/static/chunks/0.nnic9fo0go8.js</script>`;
      vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(htmlFixture);
      vi.spyOn(adapter as any, "discoverNextActionId").mockResolvedValue("40c3671ad750012fd1bcbcb050c7894f427d37a8b1");
      vi.spyOn(adapter as any, "buildNextRouterStateTree").mockReturnValue("t");
      vi.spyOn(adapter as any, "decodeEmbedShortenerLink").mockReturnValue("https://primeload.co/embed/ABC");
      vi.spyOn(adapter as any, "isDirectReachable").mockResolvedValue(true);

      const serversPayload = [{ link: "https://embedshortener.co/e/JWT" }];
      const actionText = `1:${JSON.stringify(serversPayload)}`;
      fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => actionText } as any);
      resolveSpy.mockResolvedValue("https://cdn.example/video.m3u8");
      validateSpy.mockResolvedValue(["https://cdn.example/video.m3u8"]);

      const result = await adapter.extractStream("https://doramasflix.io/capitulos/mousetrap-1x1");
      expect(result.stream_url).toBe("https://cdn.example/video.m3u8");
    });
  });
});
