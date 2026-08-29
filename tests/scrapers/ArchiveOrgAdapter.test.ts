import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArchiveOrgAdapter, extractYearFromText } from "../../server/scrapers/adapters/ArchiveOrgAdapter";

const CORS_BASE = "https://cors.archive.org/cors";

describe("ArchiveOrgAdapter - regla CORS + filtro MP4 generalizable", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("canHandle reconoce archive.org/details", () => {
    const a = new ArchiveOrgAdapter();
    expect(a.canHandle("https://archive.org/details/BigBuckBunny_328")).toBe(true);
    expect(a.canHandle("https://archive.org/download/BigBuckBunny_328/file.mp4")).toBe(false);
    expect(a.canHandle("https://jkanime.net/one-piece/")).toBe(false);
  });

  it("extractYearFromText extrae año y soporta arrays", () => {
    expect(extractYearFromText("1940 comedy")).toBe(1940);
    expect(extractYearFromText(["1968", "Parte 2"])).toBe(1968);
    expect(extractYearFromText(null)).toBeNull();
  });

  it("analyze BigBuckBunny_328: elige MP4 CORS, excluye OGV y genera URL reproducible", async () => {
    const mockMetadata = {
      metadata: { title: "Big Buck Bunny", description: "Big Buck Bunny in DivX 720p.", year: "2009" },
      files: [
        { name: "BigBuckBunny.avi", source: "original", format: "Cinepack", size: "400455228", height: "720", width: "1280" },
        { name: "BigBuckBunny.ogv", source: "derivative", format: "Ogg Video", size: "48721561", height: "304", width: "544" },
        { name: "BigBuckBunny_512kb.mp4", source: "derivative", format: "512Kb MPEG4", size: "43315070", height: "240", width: "427" },
        { name: "__ia_thumb.jpg", source: "original", format: "Item Tile", size: "9692" },
        { name: "BigBuckBunny_328.thumbs/BigBuckBunny_000030.jpg", source: "derivative", format: "Thumbnail", size: "8968" },
      ],
    };

    const fetchMock = vi.fn(async (url: any, _opts?: any) => {
      const u = String(url);
      if (u.includes("/metadata/BigBuckBunny_328")) {
        return { ok: true, json: async () => mockMetadata } as any;
      }
      // No debe pedir HEAD porque ya hay streams
      return { ok: false, status: 404 } as any;
    });
    globalThis.fetch = fetchMock as any;

    const adapter = new ArchiveOrgAdapter();
    const res = await adapter.analyze("https://archive.org/details/BigBuckBunny_328");

    // Debe poblar detected_streams con CORS
    expect(res.detected_streams.length).toBe(1);
    const first = res.detected_streams[0];
    expect(first).toBe(`${CORS_BASE}/BigBuckBunny_328/BigBuckBunny_512kb.mp4`);
    // No OGV, no AVI, no HTML
    expect(first.endsWith(".ogv")).toBe(false);
    expect(first.includes("cors.archive.org/cors")).toBe(true);
    expect(first.endsWith(".mp4")).toBe(true);
    // Episodio apunta al mismo stream
    expect(res.episodes[0].url).toBe(first);
    expect(res.title).toContain("Big Buck Bunny");
    // extractStream replica la misma lógica
    const ext = await adapter.extractStream("https://archive.org/details/BigBuckBunny_328");
    expect(ext.stream_url).toBe(first);
    expect(ext.all_available_streams[0]).toBe(first);
  });

  it("prioriza h.264 sobre 512Kb MPEG4 y excluye OGV (generaliza a ElephantsDream)", async () => {
    const mockMetadata = {
      metadata: { title: "Elephants Dream", description: "Blender 2006", year: "2006" },
      files: [
        { name: "ed_1024.avi", source: "original", format: "DivX", size: "445866736" },
        { name: "ed_1024.mp4", source: "derivative", format: "h.264", size: "67835590", height: "360", width: "640" },
        { name: "ed_1024_512kb.mp4", source: "derivative", format: "512Kb MPEG4", size: "47065346", height: "240" },
        { name: "ed_hd.mp4", source: "derivative", format: "h.264", size: "67801890", height: "360" },
        { name: "ed_hd_512kb.mp4", source: "derivative", format: "512Kb MPEG4", size: "47311688", height: "240" },
        { name: "ed_1024.ogv", source: "derivative", format: "Ogg Video", size: "45617852" },
      ],
    };
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).includes("/metadata/ElephantsDream")) {
        return { ok: true, json: async () => mockMetadata } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    globalThis.fetch = fetchMock as any;

    const adapter = new ArchiveOrgAdapter();
    const res = await adapter.analyze("https://archive.org/details/ElephantsDream");
    // Solo 4 mp4s, ogv y avi excluidos
    expect(res.detected_streams.length).toBe(4);
    // Primero debe ser h.264 (no 512kb), con CORS
    const first = res.detected_streams[0];
    expect(first.includes("cors.archive.org/cors/ElephantsDream/")).toBe(true);
    expect(first.endsWith(".mp4")).toBe(true);
    expect(first.includes(".ogv")).toBe(false);
    // Verificar que los dos primeros son los h264, los dos últimos los 512kb
    const isH264 = (url: string) => url.includes("ed_1024.mp4") || url.includes("ed_hd.mp4");
    const is512 = (url: string) => url.includes("512kb.mp4");
    expect(isH264(res.detected_streams[0])).toBe(true);
    expect(isH264(res.detected_streams[1])).toBe(true);
    expect(is512(res.detected_streams[2])).toBe(true);
    expect(is512(res.detected_streams[3])).toBe(true);
    // No OGV en lista
    expect(res.detected_streams.some((u) => u.endsWith(".ogv"))).toBe(false);
  });

  it("codifica nombres con espacios y evita hardcode BBB (encodeURIComponent por segmento)", async () => {
    const mockMetadata = {
      metadata: { title: "Test Movie", description: "Test" },
      files: [{ name: "my video file 2024.mp4", source: "derivative", format: "h.264", size: "12345" }],
    };
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes("/metadata/Test123")) {
        return { ok: true, json: async () => mockMetadata } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any;

    const adapter = new ArchiveOrgAdapter();
    const res = await adapter.analyze("https://archive.org/details/Test123");
    expect(res.detected_streams[0]).toBe(`${CORS_BASE}/Test123/my%20video%20file%202024.mp4`);
  });

  it("fallback HEAD con CORS cuando no hay mp4 en metadata (Defecto #23)", async () => {
    const mockMetadata = {
      metadata: { title: "NoVideo", description: "no files video" },
      files: [{ name: "readme.txt", source: "original", format: "Text", size: "10" }],
    };
    const fetchMock = vi.fn(async (url: any, opts?: any) => {
      const u = String(url);
      const method = (opts as any)?.method;
      if (u.includes("/metadata/EmptyItem")) {
        return { ok: true, json: async () => mockMetadata } as any;
      }
      // HEAD del guessed CORS
      if (u === `${CORS_BASE}/EmptyItem/EmptyItem.mp4` && method === "HEAD") {
        return { ok: true, status: 200, headers: new Headers({ "content-type": "video/mp4" }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    globalThis.fetch = fetchMock as any;

    const adapter = new ArchiveOrgAdapter();
    const res = await adapter.analyze("https://archive.org/details/EmptyItem");
    expect(res.detected_streams).toEqual([`${CORS_BASE}/EmptyItem/EmptyItem.mp4`]);
  });
});
