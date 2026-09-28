import { afterEach, describe, expect, it, vi } from "vitest";
import { GnulaAdapter } from "./GnulaAdapter";

function pack(value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const key = [103, 78, 55, 100];
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= key[i % key.length];
  return bytes.toString("base64");
}

describe("GnulaAdapter player endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats the public home as a catalog route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <html><head><title>Gnula</title></head><body>
        <a class="gnrd-card" href="https://ww3.gnulahd.nu/ver/coyote-vs-acme/" title="Coyote vs. Acme">
          <span class="gnrd-card-title">Coyote vs. Acme</span>
          <img src="https://image.example/coyote.jpg">
        </a>
      </body></html>`, { status: 200 })));

    const result = await new GnulaAdapter().analyze("https://ww3.gnulahd.nu/", "auto");
    expect(result.page_type).toBe("catalog");
    expect(result.catalog_items.map((item) => item.title)).toContain("Coyote vs. Acme");
  });

  it("desempaqueta y devuelve los iframes reales de la ficha", async () => {
    const pageUrl = "https://ww3.gnulahd.nu/ver/batman-knightfall-part-1-knightfall/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === pageUrl) {
        return new Response('<script>var _gnrdPid=212707,_gnrdTok="token-1";</script>', { status: 200 });
      }
      expect(url).toContain("/wp-json/gnrd/v1/player?id=212707&t=token-1");
      return new Response(JSON.stringify({
        p: pack({
          t: "Batman: Knightfall Part 1: Knightfall",
          langs: [{ servers: [
            { src: "https://vidara.to/e/server-1" },
            { src: "https://bysevepoin.com/e/server-2" },
          ] }],
        }),
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GnulaAdapter().extractStream(pageUrl);
    expect(result).toEqual({
      stream_url: "https://vidara.to/e/server-1",
      all_available_streams: [
        "https://vidara.to/e/server-1",
        "https://bysevepoin.com/e/server-2",
      ],
      title: "Batman: Knightfall Part 1: Knightfall",
    });
  });

  it("acepta el payload actual indexado por idioma", async () => {
    const pageUrl = "https://ww3.gnulahd.nu/linternas-1x02/";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === pageUrl) {
        return new Response('<script>var _gnrdPid=212462,_gnrdTok="token-2";</script>', { status: 200 });
      }
      return new Response(JSON.stringify({
        p: pack({
          t: "Linternas 1×02",
          langs: {
            lat: { servers: [{ src: "https://bysevepoin.com/e/latino" }] },
            sub: { servers: [{ src: "https://voe.sx/e/sub" }] },
          },
        }),
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GnulaAdapter().extractStream(pageUrl);
    expect(result.stream_url).toBe("https://bysevepoin.com/e/latino");
    expect(result.all_available_streams).toEqual([
      "https://bysevepoin.com/e/latino",
      "https://voe.sx/e/sub",
    ]);
  });

  it("integra gnula.life como espejo verificado y conserva una identidad gnula", async () => {
    const adapter = new GnulaAdapter();
    expect(adapter.canHandle("https://gnula.life/movies/unabomber")).toBe(true);
    expect(adapter.canHandle("https://gnula.la/movies/unabomber")).toBe(false);

    const catalogData = {
      props: { pageProps: {
        currentPage: 2,
        results: { pages: 2, data: [{ titles: { name: "UNABOMBER" }, TMDbId: "1492640", releaseDate: "2026-09-25T00:00:00.000Z", images: { poster: "https://image.tmdb.org/t/p/original/poster.jpg" }, slug: { name: "unabomber" } }] },
      } },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/archives/movies/page/2")) {
        return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(catalogData)}</script>`, { status: 200 });
      }
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: {
          post: {
            TMDbId: "1492640",
            titles: { name: "UNABOMBER" },
            overview: "A verified GNULA movie.",
            images: { poster: "https://image.tmdb.org/t/p/original/poster.jpg" },
            genres: [{ name: "Crimen" }],
            releaseDate: "2026-09-25T00:00:00.000Z",
            rate: { average: 7.08 },
            players: {
              latino: [{ cyberlocker: "streamwish", result: "https://player.gnula.life/player.php?h=latino" }],
              english: [{ cyberlocker: "doodstream", result: "https://player.gnula.life/player.php?h=english" }],
            },
          },
        } },
      })}</script>`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await adapter.analyze("https://gnula.life/archives/movies/page/2", "catalog");
    expect(catalog.page_type).toBe("catalog");
    expect(catalog.catalog_items[0]).toMatchObject({ title: "UNABOMBER", kind: "movie", year: 2026 });
    expect(catalog.next_page_url).toBeNull();

    const detail = await adapter.analyze("https://gnula.life/movies/unabomber", "auto");
    expect(detail.tmdb_id).toBe(1492640);
    expect(detail.episodes[0].url).toBe("https://gnula.life/movies/unabomber");
    expect(detail.episodes[0].sources).toHaveLength(2);
    expect(detail.episodes[0].sources?.[0]).toMatchObject({ source_site: "gnula", audio_language: "es-419", link_type: "dub" });

    const streams = await adapter.extractStream("https://gnula.life/movies/unabomber");
    expect(streams.all_available_streams).toEqual([
      "https://player.gnula.life/player.php?h=latino",
      "https://player.gnula.life/player.php?h=english",
    ]);
  });

  it("convierte temporadas de gnula.life en localizadores de episodio estables", async () => {
    const fixture = {
      props: { pageProps: { post: {
        TMDbId: "1399",
        titles: { name: "One Piece" },
        overview: "Serie verificada.",
        images: { poster: "https://image.tmdb.org/t/p/original/one-piece.jpg" },
        releaseDate: "1999-10-20T00:00:00.000Z",
        rate: { average: 8.8 },
        seasons: [{ number: 1, episodes: [{ title: "One Piece 1x1", number: 1, slug: { name: "one-piece" } }] }],
      } } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(fixture)}</script>`, { status: 200 })));

    const result = await new GnulaAdapter().analyze("https://gnula.life/series/one-piece", "detail");
    expect(result.content_type).toBe("series");
    expect(result.episodes).toEqual([{ number: 1, season: 1, title: "One Piece 1x1", url: "https://gnula.life/series/one-piece/seasons/1/episodes/1" }]);
  });
});
