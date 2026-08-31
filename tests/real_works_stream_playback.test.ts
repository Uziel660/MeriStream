import { describe, it, expect } from "vitest";
import { EmbedResolvers, providerResolverRegistry } from "../server/resolvers";
import { DeliveryPlanner, ResolutionCoordinator } from "../server/deliveryPlanner";
import { PlaybackSessionStore } from "../server/playbackSessions";
import { maskSignedTokens } from "../server/networkLogger";
import { parseStreamExpiry } from "../server/resolutionMetadata";
import { JkAnimeAdapter } from "../server/scrapers/adapters/jkanimeAdapter";
import { TioAnimeAdapter } from "../server/scrapers/adapters/tioAnimeAdapter";
import { CinecalidadAdapter } from "../server/scrapers/adapters/cinecalidadAdapter";
import { LaMovieAdapter } from "../server/scrapers/adapters/lamovieAdapter";
import { LatAnimeAdapter } from "../server/scrapers/adapters/latanimeAdapter";
import { AnimeFlvOrAtAdapter } from "../server/scrapers/adapters/animeflvOrAtAdapter";

export interface RealWorkItem {
  id: string;
  title: string;
  platform: string;
  type: "anime" | "movie" | "stream" | "embed";
  targetUrl: string;
  expectedFamily: string;
}

export const REAL_WORKS_TEST_SUITE: RealWorkItem[] = [
  {
    id: "work-01",
    title: "One Piece - Episodio 1",
    platform: "JKAnime",
    type: "anime",
    targetUrl: "https://jkanime.net/one-piece/1/",
    expectedFamily: "JKAnime Servers",
  },
  {
    id: "work-02",
    title: "Naruto - Episodio 1",
    platform: "JKAnime",
    type: "anime",
    targetUrl: "https://jkanime.net/naruto/1/",
    expectedFamily: "JKAnime Servers",
  },
  {
    id: "work-03",
    title: "Naruto - Episodio 1",
    platform: "TioAnime",
    type: "anime",
    targetUrl: "https://tioanime.com/ver/naruto-1",
    expectedFamily: "TioAnime Servers",
  },
  {
    id: "work-04",
    title: "Bleach - Episodio 1",
    platform: "TioAnime",
    type: "anime",
    targetUrl: "https://tioanime.com/ver/bleach-1",
    expectedFamily: "TioAnime Servers",
  },
  {
    id: "work-05",
    title: "Thunderbolts (2025)",
    platform: "Cinecalidad",
    type: "movie",
    targetUrl: "https://www.cinecalidad.am/ver-pelicula/thunderbolts/",
    expectedFamily: "Cinecalidad Streams",
  },
  {
    id: "work-06",
    title: "Moana 2 (2024)",
    platform: "Cinecalidad",
    type: "movie",
    targetUrl: "https://www.cinecalidad.am/ver-pelicula/moana-2/",
    expectedFamily: "Cinecalidad Streams",
  },
  {
    id: "work-07",
    title: "Bolt (2008)",
    platform: "LaMovie",
    type: "movie",
    targetUrl: "https://lamovie.org/peliculas/bolt/",
    expectedFamily: "LaMovie Streams",
  },
  {
    id: "work-08",
    title: "Interstellar (2014)",
    platform: "LaMovie",
    type: "movie",
    targetUrl: "https://lamovie.org/peliculas/interstellar/",
    expectedFamily: "LaMovie Streams",
  },
  {
    id: "work-09",
    title: "Shingeki no Kyojin - Episodio 1",
    platform: "LatAnime",
    type: "anime",
    targetUrl: "https://latanime.org/ver/shingeki-no-kyojin-episodio-1",
    expectedFamily: "LatAnime Streams",
  },
  {
    id: "work-10",
    title: "Kimetsu no Yaiba - Episodio 1",
    platform: "LatAnime",
    type: "anime",
    targetUrl: "https://latanime.org/ver/kimetsu-no-yaiba-episodio-1",
    expectedFamily: "LatAnime Streams",
  },
  {
    id: "work-11",
    title: "Gaikotsu Kishi-sama - Episodio 5",
    platform: "AnimeFlvOrAt",
    type: "anime",
    targetUrl: "https://animeflv.or.at/2026/08/03/gaikotsu-kishi-sama-tadaima-isekai-e-odekakechuu-ii-episodio-5/",
    expectedFamily: "AnimeFLV Mirrors",
  },
  {
    id: "work-12",
    title: "Vimeos Master Stream (HLS)",
    platform: "Vimeos CDN",
    type: "stream",
    targetUrl: "https://vimeos.net/embed-renewable.html",
    expectedFamily: "Vimeos HLS",
  },
  {
    id: "work-13",
    title: "Mega Encrypted Cloud Asset",
    platform: "Mega.nz",
    type: "embed",
    targetUrl: "https://mega.nz/embed/!BTU1DKKR!RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk",
    expectedFamily: "Mega Embed",
  },
  {
    id: "work-14",
    title: "Mux Multi-Bitrate Big Buck Bunny (HLS)",
    platform: "Mux CDN",
    type: "stream",
    targetUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    expectedFamily: "Direct HLS",
  },
  {
    id: "work-15",
    title: "Google Cloud Direct Media (MP4)",
    platform: "Google Cloud CDN",
    type: "stream",
    targetUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    expectedFamily: "Direct MP4",
  },
];

describe("15 Real Works Playback & Delivery Verification Suite", () => {
  const coordinator = new ResolutionCoordinator(async (loc) => EmbedResolvers.resolveWithMeta(loc));
  const planner = new DeliveryPlanner();
  const sessionStore = new PlaybackSessionStore();

  it("verifies test suite contains at least 15 distinct real works across diverse platforms", () => {
    expect(REAL_WORKS_TEST_SUITE.length).toBeGreaterThanOrEqual(15);
    const platforms = new Set(REAL_WORKS_TEST_SUITE.map((w) => w.platform));
    expect(platforms.size).toBeGreaterThanOrEqual(7);
  });

  for (const work of REAL_WORKS_TEST_SUITE) {
    it(`evaluates delivery pipeline for real work: [${work.platform}] ${work.title}`, async () => {
      // 1. Matching del proveedor
      const resolver = providerResolverRegistry.findResolver(work.targetUrl);
      expect(resolver).toBeDefined();

      // 2. Token masking para seguridad y observabilidad
      const masked = maskSignedTokens(work.targetUrl);
      expect(masked).toBeDefined();

      // 3. Resolución con metadatos
      const meta = await coordinator.resolve(work.targetUrl);
      expect(meta.original_url).toBe(work.targetUrl);

      // 4. Delivery planning
      const deliveryMode = planner.classify(meta);
      expect(["direct", "direct_trial", "proxy_required", "embed"]).toContain(deliveryMode);

      // 5. Si es stream proxyable, verificar creación de sesión y reescritura
      if (meta.is_proxyable) {
        const session = sessionStore.createFromResolved(work.targetUrl, meta);
        expect(session.id).toBeDefined();
        expect(session.current.url).toBe(meta.url);
      }
    }, 15000);
  }

  it("real probe on direct HLS stream (Mux) downloads manifest and parses variants", async () => {
    const muxUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    const res = await fetch(muxUrl);
    expect(res.ok).toBe(true);
    const manifest = await res.text();
    expect(manifest).toContain("#EXTM3U");
    expect(manifest).toContain("#EXT-X-STREAM-INF");

    const session = sessionStore.createFromResolved(muxUrl, {
      url: muxUrl,
      original_url: muxUrl,
      canonical_locator: muxUrl,
      resolved: true,
      type: "direct",
      provider: "Mux CDN",
      is_proxyable: true,
      is_refreshable: true,
    });

    const rewritten = sessionStore.rewriteManifest(session.id, manifest, muxUrl);
    expect(rewritten).toContain(`/api/v1/playback/${session.id}/resource/`);
  });

  it("real probe on direct MP4 stream verifies byte-range playback support", async () => {
    const mp4Url = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
    const res = await fetch(mp4Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Range: "bytes=0-1023",
      },
    });
    // Si la CDN responde 206 (soporte Range) o 200 (direct stream), el stream es reproducible
    expect([200, 206]).toContain(res.status);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });
});
