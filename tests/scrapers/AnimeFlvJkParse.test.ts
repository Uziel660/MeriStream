import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { AnimeFlvAdapter } from "../../server/scrapers/adapters/AnimeFlvAdapter";

/**
 * Fixture offline: HTML real de https://jkanime.net/sousou-no-frieren/1/ capturado el
 * 2026-08-22. Valida parseJkanimeServers sin red: 9 servidores reales y NINGÚN
 * artefacto de plantilla (jkplayer/c1?u= con parámetro vacío).
 */
const FIXTURE = "C:/Users/Uziel/AppData/Local/Temp/jk_ep.html";

describe("AnimeFlvAdapter.parseJkanimeServers (fixture jkanime ep1 Frieren)", () => {
  const adapter = new AnimeFlvAdapter();
  const parse = (html: string) => (adapter as any).parseJkanimeServers(html);

  it("extrae los 9 servidores base64 + wrappers um/umv", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const streams = parse(html);
    console.log(`streams=${streams.length}`);
    for (const s of streams) console.log(" *", s);

    expect(streams.length).toBeGreaterThanOrEqual(9);

    const expected = [
      "mega.nz/embed/Q7USRDiT",
      "sfastwish.com/e/ppgosg56iyip",
      "voe.sx/e/m3jidksjaq5y",
      "vidhidevip.com/embed/lq4ktjl3sxnb",
      "mdy48tn97.com/e/zp3noovlh94k6w",
      "www.mp4upload.com/embed-uczgv4bnmphw.html",
      "streamtape.com/e/WXkR0JoayPUbjPk",
      "d-s.io/e/xiubuqnxk00d",
    ];
    for (const host of expected) {
      expect(streams.some((u: string) => u.includes(host))).toBe(true);
    }
    // Los wrappers internos jkplayer (um/umv) deben estar presentes
    expect(streams.some((u: string) => /jkanime\.net\/jkplayer\/um\?/.test(u))).toBe(true);
    expect(streams.some((u: string) => /jkanime\.net\/jkplayer\/umv\?/.test(u))).toBe(true);
  });

  it("NO incluye la plantilla jkplayer/c1?u= (parámetro vacío)", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const streams = parse(html);
    expect(streams.some((u: string) => u.includes("/jkplayer/c1"))).toBe(false);
    expect(streams.some((u: string) => /[?&]u=$/.test(u))).toBe(false);
  });

  it("extractStream descarta hosts caídos/bloqueados como streamtape de la lista final", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const streams = parse(html);
    const { directStreams, embedStreams } = await (adapter as any).resolveCandidates(streams);

    const stFake = streams.find((u: string) => u.includes("streamtape.com"));
    expect(stFake).toBeTruthy();
    // streamtape y d-s.io ahora son descartados por DEAD_OR_BLOCKED_HOST_PATTERNS
    expect(embedStreams).not.toContain(stFake);
    expect(directStreams).not.toContain(stFake);

    // Los streams funcionales (mega, sfastwish, vidhide, etc.) se mantienen
    expect(directStreams.length + embedStreams.length).toBeGreaterThan(0);
  }, 60000);
});
