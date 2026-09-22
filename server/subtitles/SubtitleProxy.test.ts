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

  it("prefers UTF-8 and strips markup/entities instead of exposing them", async () => {
    const proxy = new SubtitleProxy();
    const source = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n[Alba] <i>Acción &amp; reacción</i>\n", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { status: 200 })));
    const url = proxy.register({ id: "utf8", provider: "tvsubtitles", language: "es", label: "Español", sourceUrl: "https://www.tvsubtitles.net/files/demo.srt", format: "srt" });
    const result = await proxy.serve(url!.split("/").pop()!.replace(".vtt", ""));
    expect(result?.body.toString("utf8")).toContain("[Alba] Acción & reacción");
    expect(result?.body.toString("utf8")).not.toContain("<i>");
  });

  it("repairs a UTF-8 subtitle that arrived already mojibaked", async () => {
    const proxy = new SubtitleProxy();
    const source = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nAcciÃ³n española\n", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { status: 200 })));
    const url = proxy.register({ id: "mojibake", provider: "tvsubtitles", language: "es", label: "Español", sourceUrl: "https://www.tvsubtitles.net/files/mojibake.srt", format: "srt" });
    const result = await proxy.serve(url!.split("/").pop()!.replace(".vtt", ""));
    expect(result?.body.toString("utf8")).toContain("Acción española");
  });

  it("removes ASS alignment tags from an otherwise valid SRT cue", async () => {
    const proxy = new SubtitleProxy();
    const source = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\n{an8}En ese lugar\\Nhabitado\n", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { status: 200 })));
    const url = proxy.register({ id: "ass-tag", provider: "tvsubtitles", language: "es", label: "Español", sourceUrl: "https://www.tvsubtitles.net/files/ass-tag.srt", format: "srt" });
    const result = await proxy.serve(url!.split("/").pop()!.replace(".vtt", ""));
    const body = result?.body.toString("utf8") || "";
    expect(body).toContain("En ese lugar");
    expect(body).toContain("habitado");
    expect(body).not.toContain("{an8}");
  });

  it("rejects untrusted remote hosts", () => {
    const proxy = new SubtitleProxy();
    expect(proxy.register({ id: "bad", provider: "yify", language: "en", label: "English", sourceUrl: "https://evil.example/sub.srt" })).toBeNull();
  });
});
