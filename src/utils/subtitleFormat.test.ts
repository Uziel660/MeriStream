import { describe, expect, it } from "vitest";
import { parseWebVttCues, subtitleTextToWebVtt } from "./subtitleFormat";

describe("subtitleTextToWebVtt", () => {
  it("converts OpenSubtitles SRT timestamps to WebVTT", () => {
    expect(subtitleTextToWebVtt("1\r\n00:00:01,000 --> 00:00:02,500\r\nHola\r\n")).toBe(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHola\n\n",
    );
  });

  it("preserves a valid WebVTT payload", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n";
    expect(subtitleTextToWebVtt(vtt)).toBe(vtt);
  });

  it("extracts cues for native VTTCue playback", () => {
    expect(parseWebVttCues("1\n00:00:01,000 --> 00:00:02,500\nHola")).toEqual([
      { startTime: 1, endTime: 2.5, text: "Hola" },
    ]);
  });
});
