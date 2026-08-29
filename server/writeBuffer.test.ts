import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

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

import {
  drainWriteBuffer,
  enqueueWrite,
  flushRamToJsonl,
  loadJsonlToRam,
  resetWriteBufferForTesting,
  setWriteBufferPathForTesting,
} from "./writeBuffer";

describe("writeBuffer sourceLink.create", () => {
  beforeEach(() => {
    setWriteBufferPathForTesting(path.join(os.tmpdir(), `meristream-write-buffer-${process.pid}.jsonl`));
    resetWriteBufferForTesting();
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

  it("recupera operaciones de JSONL, reconstruye pendingSourceLinkKeys y bloquea duplicados", async () => {
    const op = {
      kind: "sourceLink.create" as const,
      episodeRef: { media_item_id: "media-item-recovery", season_number: 1, episode_number: 1 },
      data: { source_site: "cinecalidad", url: "https://cdn.example/recovery.mp4", link_type: "direct" },
    };

    // 1. Encolar y volcar a JSONL
    expect(enqueueWrite(op)).toBe(true);
    flushRamToJsonl();

    // 2. Cargar de JSONL a RAM
    loadJsonlToRam();

    // 3. Debe bloquear un nuevo enqueueWrite idéntico porque pendingSourceLinkKeys fue reconstruido
    expect(enqueueWrite(op)).toBe(false);

    // 4. Drenar buffer
    const drainResult = await drainWriteBuffer();
    expect(drainResult.applied).toBe(1);

    // 5. Tras el drain, la clave queda liberada
    expect(enqueueWrite(op)).toBe(true);
    await drainWriteBuffer();
  });

  it("conserva trabajo persistido mientras otro writer espera SQLite", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    mocks.mediaEpisodeUpsert
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstWrite = resolve; }))
      .mockResolvedValue({ id: "media-episode-1" });
    const first = {
      kind: "sourceLink.create" as const,
      episodeRef: { media_item_id: "media-item-race", season_number: 1, episode_number: 1 },
      data: { source_site: "cinecalidad", url: "https://cdn.example/first.mp4", link_type: "direct" },
    };
    const persistedDuringWrite = {
      ...first,
      data: { ...first.data, url: "https://cdn.example/persisted.mp4" },
    };

    expect(enqueueWrite(first)).toBe(true);
    const firstDrain = drainWriteBuffer();
    await Promise.resolve();

    expect(enqueueWrite(persistedDuringWrite)).toBe(true);
    flushRamToJsonl();
    releaseFirstWrite?.();
    await firstDrain;

    const recoveredDrain = await drainWriteBuffer();
    expect(recoveredDrain).toMatchObject({ applied: 1, pending: 0 });
  });
});
