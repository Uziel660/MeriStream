import { describe, expect, it } from "vitest";
import { isEmbedUrl } from "./streamOptimizer";

describe("Zilla stream classification", () => {
  it("treats Zilla HLS routes as native media", () => {
    expect(isEmbedUrl("https://player.zilla-networks.com/m3u8/0123456789abcdef0123456789abcdef")).toBe(false);
    expect(isEmbedUrl("https://player.zilla-networks.com/m3u8/master.m3u8")).toBe(false);
  });
  it("still treats Zilla player pages as embeds", () => {
    expect(isEmbedUrl("https://player.zilla-networks.com/play/0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isEmbedUrl("https://player.zilla-networks.com/video/123")).toBe(true);
  });
});
