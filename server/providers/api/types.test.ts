import { describe, expect, it } from "vitest";
import { inferStreamType, playableUrl } from "./types";


describe("direct provider contract", () => {
  it("accepts HLS, DASH and MP4 media URLs", () => {
    expect(playableUrl("https://cdn.example/video/master.m3u8")?.streamType).toBe("hls");
    expect(playableUrl("https://cdn.example/m3u8/abc123")?.streamType).toBe("hls");
    expect(playableUrl("https://cdn.example/manifest.mpd")?.streamType).toBe("dash");
    expect(playableUrl("https://cdn.example/video.mp4?token=x")?.streamType).toBe("mp4");
  });

  it("rejects provider pages and iframe/embed URLs", () => {
    expect(playableUrl("https://provider.example/watch/123")).toBeNull();
    expect(playableUrl("https://provider.example/embed/123")).toBeNull();
    expect(playableUrl("https://provider.example/player/123")).toBeNull();
  });

  it("honors an explicit direct media type when providers omit extensions", () => {
    expect(inferStreamType("https://cdn.example/tokenized/abc", "hls")).toBe("hls");
    expect(inferStreamType("https://cdn.example/tokenized/abc", "application/dash+xml")).toBe("dash");
    expect(inferStreamType("https://cdn.example/tokenized/abc", "video/mp4")).toBe("mp4");
  });
});
