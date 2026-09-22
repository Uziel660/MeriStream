import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSubtitlesProvider } from "./OpenSubtitlesProvider";
import { TvSubtitlesProvider } from "./TvSubtitlesProvider";
import { YifySubtitlesProvider } from "./YifySubtitlesProvider";
import { SubtitleCatProvider } from "./SubtitleCatProvider";

afterEach(() => vi.unstubAllGlobals());

describe("subtitle providers", () => {
  it("maps the public OpenSubtitles v3 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ subtitles: [
      { id: "1", url: "https://subs5.strem.io/file/1", lang: "spa", SubFormat: "srt", subtitleFileName: "movie.srt", movieReleaseName: "WEB-DL" },
    ] }), { status: 200 })));
    const result = await new OpenSubtitlesProvider(["https://opensubtitles-v3.strem.io"]).search({ tmdbId: 1, kind: "movie", imdbId: "tt1234567" });
    expect(result[0]).toMatchObject({ provider: "opensubtitles-v3", language: "es", format: "srt", sourceUrl: "https://subs5.strem.io/file/1" });
  });

  it("parses YIFY movie subtitle rows and direct ZIP locators", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<table><tbody><tr><td><a href="/subtitles/demo-2020-english-yify-1"><span class="sub-lang">English</span></a></td></tr></tbody></table>`, { status: 200 })));
    const result = await new YifySubtitlesProvider(["https://www.yifysubtitles.ch"]).search({ tmdbId: 1, kind: "movie", imdbId: "tt1234567", preferredLanguages: ["en"] });
    expect(result[0]).toMatchObject({ provider: "yify", language: "en", sourceUrl: "https://www.yifysubtitles.ch/subtitle/demo-2020-english-yify-1.zip" });
  });

  it("resolves TVSubtitles episode pages to a downloadable ZIP", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("v3-cinemeta.strem.io")) return new Response(JSON.stringify({ meta: { name: "Game of Thrones" } }), { status: 200 });
      if (url.endsWith("/search1.php")) return new Response(`<a href="/tvshow-911.html">Game of Thrones (2011-2019)</a>`, { status: 200 });
      if (url.includes("tvshow-911-1.html")) return new Response(`<table><tr><td>1x01</td><td><a href="/episode-32768-en.html"><img src="/flags/en.gif"></a></td></tr></table>`, { status: 200 });
      if (url.includes("episode-32768-en.html")) return new Response(`<a href="/subtitle-172489-en.html">download</a>`, { status: 200 });
      if (url.includes("download-172489.html")) return new Response("var s1='files/'; var s2='Game'; var s3='-en'; var s4='.zip';", { status: 200 });
      throw new Error(`unexpected ${url}`);
    }));
    const result = await new TvSubtitlesProvider().search({ tmdbId: 1, kind: "series", imdbId: "tt1234567", title: "Game of Thrones", season: 1, episode: 1, preferredLanguages: ["en"] });
    expect(result[0]).toMatchObject({ provider: "tvsubtitles", language: "en", sourceUrl: "https://www.tvsubtitles.net/files/Game-en.zip" });
  });

  it("falls back through canonical aliases when TVSubtitles does not index the localized title", async () => {
    const searched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("v3-cinemeta.strem.io")) return new Response(JSON.stringify({ meta: { name: "Money Heist" } }), { status: 200 });
      if (url.endsWith("/search1.php")) {
        const body = String(init?.body || "");
        searched.push(decodeURIComponent(body.replace(/^qs=/, "")));
        if (body.includes("La%20casa%20de%20papel")) return new Response("<div>sin coincidencias</div>", { status: 200 });
        return new Response(`<a href="/tvshow-501.html">Money Heist (2017-2021)</a>`, { status: 200 });
      }
      if (url.includes("tvshow-501-1.html")) return new Response(`<table><tr><td>1x01</td><td><a href="/subtitle-910-en.html"><img src="/flags/en.gif"></a></td></tr></table>`, { status: 200 });
      if (url.includes("download-910.html")) return new Response("var s1='files/'; var s2='MoneyHeist'; var s3='-en'; var s4='.zip';", { status: 200 });
      throw new Error(`unexpected ${url}`);
    }));
    const result = await new TvSubtitlesProvider().search({
      tmdbId: 71446,
      kind: "series",
      imdbId: "tt6468322",
      title: "La casa de papel",
      titleAliases: ["Money Heist"],
      season: 1,
      episode: 1,
      preferredLanguages: ["en"],
    });
    expect(searched.slice(0, 2)).toEqual(["La casa de papel", "Money Heist"]);
    expect(result[0]).toMatchObject({ provider: "tvsubtitles", language: "en", sourceUrl: "https://www.tvsubtitles.net/files/MoneyHeist-en.zip" });
  });

  it("matches SubtitleCat by title and maps direct language files", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("index.php?search=")) {
        return new Response(`<a href="subs/1422/The%20Matrix%20%281999%29.html">The Matrix (1999)</a>`, { status: 200 });
      }
      if (url.includes("/subs/1422/")) {
        return new Response(`<a href="/subs/1422/The%20Matrix%20%281999%29-es-419.srt">Download</a><a href="/subs/1422/The%20Matrix%20%281999%29-en.srt">Download</a>`, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));
    const result = await new SubtitleCatProvider(1_000).search({ tmdbId: 603, kind: "movie", title: "The Matrix", year: 1999, preferredLanguages: ["es-419", "en"] });
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "subtitlecat", language: "es-419", sourceUrl: "https://subtitlecat.com/subs/1422/The%20Matrix%20%281999%29-es-419.srt", format: "srt" }),
      expect.objectContaining({ provider: "subtitlecat", language: "en" }),
    ]));
  });

  it("rejects a SubtitleCat result whose visible year belongs to another work", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("index.php?search=")) {
        return new Response(
          `<a href="subs/1977/Fantasy%20Island%20%281977%29.html">Fantasy Island (1977) Revenge of the Forgotten</a>`,
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    }));

    const result = await new SubtitleCatProvider(1_000).search({
      tmdbId: 1465063,
      kind: "movie",
      title: "La isla olvidada",
      titleAliases: ["Forgotten Island"],
      year: 2026,
      preferredLanguages: ["es", "en"],
    });

    expect(result).toEqual([]);
  });
});
