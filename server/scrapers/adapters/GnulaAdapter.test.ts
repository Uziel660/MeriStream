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
});
