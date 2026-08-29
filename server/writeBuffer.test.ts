import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mediaEpisodeUpsert: vi.fn(),
  sourceLinkCreate: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    mediaEpisode: { upsert: mocks.mediaEpisodeUpsert },
    sourceLink: { create: mocks.sourceLinkCreate },
  },
}));

import { drainWriteBuffer, enqueueWrite } from "./writeBuffer";

describe("writeBuffer sourceLink.create", () => {
  beforeEach(() => {
    mocks.mediaEpisodeUpsert.mockReset();
    mocks.sourceLinkCreate.mockReset();
    mocks.mediaEpisodeUpsert.mockResolvedValue({ id: "media-episode-1" });
    mocks.sourceLinkCreate.mockResolvedValue({ id: "source-1" });
  });

  it("resuelve el episodio exacto sin enviar campos internos a Prisma", async () => {
    enqueueWrite({
      kind: "sourceLink.create",
      episodeRef: {
        media_item_id: "media-item-1",
        season_number: 2,
        episode_number: 7,
      },
      data: {
        source_site: "cinecalidad.am",
        url: "https://cinecalidad.am/ver-pelicula/example/",
        link_type: "embed",
      },
    });

    const result = await drainWriteBuffer();

    expect(result).toMatchObject({ applied: 1, pending: 0 });
    expect(mocks.mediaEpisodeUpsert).toHaveBeenCalledWith({
      where: {
        media_item_id_season_number_episode_number: {
          media_item_id: "media-item-1",
          season_number: 2,
          episode_number: 7,
        },
      },
      create: {
        media_item_id: "media-item-1",
        season_number: 2,
        episode_number: 7,
      },
      update: {},
    });
    expect(mocks.sourceLinkCreate).toHaveBeenCalledWith({
      data: {
        source_site: "cinecalidad.am",
        url: "https://cinecalidad.am/ver-pelicula/example/",
        link_type: "embed",
        media_episode_id: "media-episode-1",
      },
    });
  });

  it("deduplica enlaces pendientes y libera la clave después del drain", async () => {
    const op = {
      kind: "sourceLink.create" as const,
      episodeRef: { media_item_id: "media-item-2", season_number: 1, episode_number: 1 },
      data: { source_site: "lamovie", url: "https://cdn.example/video.mp4", link_type: "direct" },
    };

    expect(enqueueWrite(op)).toBe(true);
    expect(enqueueWrite(op)).toBe(false);
    await drainWriteBuffer();

    // Después del drain la clave pendiente se libera. La BD conserva la
    // deduplicación persistente; esta cola solo evita duplicados en vuelo.
    expect(enqueueWrite(op)).toBe(true);
    await drainWriteBuffer();
  });

  it("libera la clave cuando una operación agota sus reintentos", async () => {
    mocks.sourceLinkCreate.mockRejectedValue(new Error("temporal failure"));
    const op = {
      kind: "sourceLink.create" as const,
      episodeRef: { media_item_id: "media-item-3", season_number: 1, episode_number: 1 },
      data: { source_site: "cinecalidad", url: "https://cdn.example/retry.mp4", link_type: "direct" },
    };

    expect(enqueueWrite(op)).toBe(true);
    const result = await drainWriteBuffer();
    expect(result).toMatchObject({ pending: 0, failed: 1 });
    expect(enqueueWrite(op)).toBe(true);
    await drainWriteBuffer();
  });
});
