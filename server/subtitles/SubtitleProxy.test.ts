import { zipSync } from "fflate";
import { describe, expect, it, afterEach, vi } from "vitest";
import iconv from "iconv-lite";
import { SubtitleProxy } from "./SubtitleProxy";

afterEach(() => vi.unstubAllGlobals());

describe("SubtitleProxy", () => {
  it("converts Windows-1252 SRT to UTF-8 WebVTT", async () => {
    const proxy = new SubtitleProxy();
    const source = iconv.encode("1\r\n00:00:01,000 --> 00:00:02,000\r\nAcción española\r\n", "windows-1252");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { status: 200, headers: { "content-type": "application/x-subrip" } })));
    const url = proxy.register({ id: "srt", provider: "tvsubtitles", language: "es", label: "Español", sourceUrl: "https://www.tvsubtitles.net/files/demo.zip", format: "srt" });
    const token = url!.split("/").pop()!.replace(".vtt", "");
    const result = await proxy.serve(token);
    expect(result?.contentType).toContain("text/vtt");
    expect(result?.body.toString("utf8")).toContain("Acción española");
  });

  it("extracts a ZIP subtitle and returns WebVTT", async () => {
    const proxy = new SubtitleProxy();
    const zip = Buffer.from(zipSync({ "movie.srt": Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHola\n") }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(zip, { status: 200, headers: { "content-type": "application/zip" } })));
    const url = proxy.register({ id: "zip", provider: "yify", language: "es", label: "Español", sourceUrl: "https://www.yifysubtitles.ch/subtitle/movie.zip", format: "srt" });
    const result = await proxy.serve(url!.split("/").pop()!.replace(".vtt", ""));
    expect(result?.body.toString("utf8")).toContain("WEBVTT");
    expect(result?.body.toString("utf8")).toContain("Hola");
  });

  it("rejects untrusted remote hosts", () => {
    const proxy = new SubtitleProxy();
    expect(proxy.register({ id: "bad", provider: "yify", language: "en", label: "English", sourceUrl: "https://evil.example/sub.srt" })).toBeNull();
  });
});
