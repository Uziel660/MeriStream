import { describe, expect, it, vi } from "vitest";
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
});
