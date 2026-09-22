import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { castMediaCors, isCastMediaPath } from "./castMediaCors";

function responseDouble() {
  const headers = new Map<string, string>();
  const response = {
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
      return response;
    }),
    removeHeader: vi.fn((name: string) => headers.delete(name.toLowerCase())),
    sendStatus: vi.fn(() => response),
  } as unknown as Response;
  return { response, headers };
}

describe("cast media CORS", () => {
  it("only classifies opaque playback and subtitle delivery routes", () => {
    expect(isCastMediaPath("/api/v1/playback/session/master.m3u8")).toBe(true);
    expect(isCastMediaPath("/api/v1/playback/session/resource/segment")).toBe(true);
    expect(isCastMediaPath("/api/v1/subtitles/file/token.vtt")).toBe(true);
    expect(isCastMediaPath("/api/v1/playback/sessions")).toBe(false);
    expect(isCastMediaPath("/api/v1/admin/session")).toBe(false);
  });

  it("allows receiver origins and the headers required by adaptive streaming", () => {
    const { response, headers } = responseDouble();
    const next = vi.fn() as unknown as NextFunction;

    castMediaCors({ method: "GET" } as Request, response, next);

    expect(headers.get("access-control-allow-origin")).toBe("*");
    expect(headers.get("access-control-allow-headers")).toContain("Accept-Encoding");
    expect(headers.get("access-control-allow-headers")).toContain("Range");
    expect(headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(next).toHaveBeenCalledOnce();
  });

  it("answers Chromecast preflights before the SPA fallback", () => {
    const { response } = responseDouble();
    const next = vi.fn() as unknown as NextFunction;

    castMediaCors({ method: "OPTIONS" } as Request, response, next);

    expect(response.sendStatus).toHaveBeenCalledWith(204);
    expect(next).not.toHaveBeenCalled();
  });
});
