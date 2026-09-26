import { afterEach, describe, expect, it, vi } from "vitest";
import { DoramasYTAdapter } from "./DoramasYTAdapter";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";
import { ScraperManager } from "../ScraperManager";

const fixture = (body: string) => `<html><head><title>Fixture</title><meta property="og:image" content="/poster.jpg"></head><body>${body}</body></html>`;

describe("DoramasYTAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles only the real DoramasYT host", () => {
    const adapter = new DoramasYTAdapter();
    expect(adapter.canHandle("https://www.doramasyt.com/dorama/demo")).toBe(true);
    expect(adapter.canHandle("https://sub.doramasyt.com/ver/demo-episodio-1")).toBe(true);
    expect(adapter.canHandle("https://doramasyt.com.evil.example/ver/demo-episodio-1")).toBe(false);
    expect(adapter.canHandle("not a url")).toBe(false);
  });

  it("extracts catalog cards and ignores site navigation", async () => {
    const adapter = new DoramasYTAdapter();
    vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(fixture(`
      <nav><a href="/">Inicio</a><a href="/doramas">Doramas</a></nav>
      <article><a href="/dorama/our-sticky-love-sub-espanol"><img src="/posters/sticky.jpg" alt="Our Sticky Love"><h2>Our Sticky Love</h2></a><span>2024</span></article>
      <article><a href="/dorama/peach-girl-dorama-sub-espanol"><img src="/posters/peach.jpg" alt="Peach Girl Dorama"></a><span>2017</span></article>
    `));

    const result = await adapter.analyze("https://www.doramasyt.com/doramas", "catalog");
    expect(result.page_type).toBe("catalog");
    expect(result.catalog_items).toHaveLength(2);
    expect(result.catalog_items[0]).toMatchObject({ title: "Our Sticky Love", kind: "series", year: 2024 });
    expect(result.catalog_items[0]?.image_url).toContain("/posters/sticky.jpg");
  });

  it("extracts episode numbers from detail links", async () => {
    const adapter = new DoramasYTAdapter();
    vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(fixture(`
      <meta property="og:title" content="Our Sticky Love Online en Español - DoramasYT">
      <h1>Our Sticky Love</h1>
      <a href="/ver/our-sticky-love-episodio-2">Capítulo 2</a>
      <a href="/ver/our-sticky-love-episodio-1">Capítulo 1</a>
    `));

    const result = await adapter.analyze("https://www.doramasyt.com/dorama/our-sticky-love-sub-espanol", "detail");
    expect(result.title).toBe("Our Sticky Love Online en Español");
    expect(result.episodes.map((episode) => episode.number)).toEqual([1, 2]);
  });

  it("resolves Mega and Pixeldrain while discarding posters and download-only links", async () => {
    const adapter = new DoramasYTAdapter();
    const mega = "https://mega.nz/file/abc123#key123";
    const pixeldrain = "https://pixeldrain.com/u/uEbawZhQ";
    const downloadOnly = "https://1fichier.com/?file123";
    vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(fixture(`
      <a class="server" href="${mega}">Mega</a>
      <a class="server" href="${pixeldrain}">Pixeldrain</a>
      <a class="download" href="${downloadOnly}">Descargar</a>
      <img src="https://cdn.example/poster.jpg">
      <button data-player="eyJpdiI6ImVuY3J5cHRlZCJ9">Filemoon</button>
    `));
    vi.spyOn(EmbedResolvers, "resolveWithMeta").mockResolvedValue({
      url: "/api/v1/stream/mega?url=https%3A%2F%2Fmega.nz%2Ffile%2Fabc123%23key123",
      original_url: mega,
      resolved: true,
      type: "direct",
      provider: "Mega",
      is_proxyable: true,
      is_refreshable: false,
    });
    vi.spyOn(MediaValidator, "validateUrls").mockImplementation(async (urls) => urls);

    const result = await adapter.extractStream("https://www.doramasyt.com/ver/demo-episodio-1");
    expect(result.stream_url).toContain("/api/v1/stream/mega");
    expect(result.all_available_streams).toContain("https://pixeldrain.com/api/file/uEbawZhQ");
    expect(result.all_available_streams.some((url) => url.includes("poster.jpg"))).toBe(false);
    expect(result.all_available_streams.some((url) => url.includes("1fichier"))).toBe(false);
    expect(result.all_available_streams.some((url) => url.includes("enc"+"rypted"))).toBe(false);
  });

  it("is registered before the generic fallback", () => {
    const adapter = ScraperManager.getInstance().getAdapter("https://www.doramasyt.com/ver/demo-episodio-1");
    expect(adapter.id).toBe("doramasyt");
  });
});
