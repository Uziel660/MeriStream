import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import { resolveZokoAnime } from "./zokoanimeResolver";

function token(payload: Record<string, unknown>): string {
  const text = Buffer.from(JSON.stringify(payload));
  const key = "otaku-embed-v1";
  for (let i = 0; i < text.length; i += 1) text[i] ^= key.charCodeAt(i % key.length);
  return text.toString("base64");
}

function megaPayload(payload: Record<string, unknown>): string {
  const key = Buffer.alloc(32);
  Buffer.from("i?LMTAx0Q6,:}50U").copy(key);
  const iv = Buffer.from("W0;27ToaUpl_P%'c");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return encrypted.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("zokoanimeResolver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes the player payload and preserves the CDN referer", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Referer).toBe("https://zokoanime.video/");
      return new Response(`<script>window.__P = "${token({ src: "https://hls2.aniwatchtv.uk/v/test/master.m3u8", subtitles: [{ src: "https://subs.example/es.vtt", lang: "es" }] })}"</script>`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveZokoAnime("https://zokoanime.video/stream/mal/32281/1/sub");
    expect(result.url).toContain("master.m3u8");
    expect(result.subtitles[0]?.lang).toBe("es");
    expect(result.requiredHeaders.Referer).toBe("https://zokoanime.video/");
  });

  it("fails closed when the provider payload is absent or unsafe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>challenge</html>", { status: 200 })));
    const result = await resolveZokoAnime("https://zokoanime.video/stream/mal/1/1/sub");
    expect(result.url).toBe("");

    const invalid = await resolveZokoAnime("https://example.com/player");
    expect(invalid.url).toBe("");
  });

  it("infers the track language from the label when Zoko reports every track as en", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<script>window.__P = "${token({ src: "https://hls2.aniwatchtv.uk/v/test/master.m3u8", subtitles: [{ src: "https://hls2.aniwatchtv.uk/v/test/es.vtt", lang: "en", label: "Español" }] })}"</script>`, { status: 200 })));
    const result = await resolveZokoAnime("https://zokoanime.video/stream/mal/32281/1/sub");
    expect(result.subtitles[0]?.lang).toBe("es");
  });

  it("falls back to MegaPlay and decrypts its JIT CDN source", async () => {
    vi.setSystemTime(new Date("2026-09-28T19:00:00.000Z"));
    const source = "https://fetch.nexabloom.top/anime/0123456789abcdef0123456789abcdef/abcdef0123456789abcdef0123456789/master.m3u8";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://zokoanime.video/")) return new Response("blocked", { status: 403 });
      if (url.includes("megaplay.buzz/stream/mal/32281/1/sub")) {
        return new Response('<div id="megaplay-player" data-id="41551"></div>', { status: 200 });
      }
      if (url.includes("megaplay.buzz/stream/getSources?id=41551")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
        expect(headers.Referer).toContain("megaplay.buzz/stream/mal/32281/1/sub");
        return new Response(JSON.stringify({ enc: megaPayload({ file: source }) }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveZokoAnime("https://zokoanime.video/stream/mal/32281/1/sub");

    expect(result.url).toContain(source);
    expect(result.url).toContain("token=");
    expect(result.requiredHeaders.Referer).toBe("https://megaplay.buzz/");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
