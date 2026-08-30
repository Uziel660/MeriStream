import { describe, expect, it } from "vitest";
import { buildProxyHeaders, resolveHostProfile, CHROME_124_UA } from "./hostProfiles";

describe("hostProfiles", () => {
  it("resuelve acek-cdn.com con modo referer none, UA Chrome 124 y cliente undici", () => {
    const target = "https://1hyahuweWHyVWmq.acek-cdn.com/hls2/01/06365/wb9yiqahkzen_,l,n,h,.urlset/master.m3u8?t=xyz";
    const profile = resolveHostProfile(target);

    expect(profile.refererMode).toBe("none");
    expect(profile.client).toBe("undici");
    expect(profile.userAgent).toBe(CHROME_124_UA);

    const { headers } = buildProxyHeaders(target, "https://animeflv.net/");
    expect(headers["Referer"]).toBeUndefined();
    expect(headers["User-Agent"]).toBe(CHROME_124_UA);
    expect(headers["Accept-Encoding"]).toBe("identity");
  });

  it("resuelve sprintcdn con cliente undici y sin referer", () => {
    const target = "https://edge2-waw-sprintcdn.r66nv9ed.com/hls2/06/11734/io763rkfeikn_x/master.m3u8?t=abc";
    const profile = resolveHostProfile(target);

    expect(profile.refererMode).toBe("none");
    expect(profile.client).toBe("undici");

    const { headers } = buildProxyHeaders(target, "https://tubepelis.com/");
    expect(headers["Referer"]).toBeUndefined();
    expect(headers["Accept-Encoding"]).toBe("identity");
  });

  it("mantiene el referer en hosts passthrough como ducvomes", () => {
    const target = "https://nika.playmudos.com/onupiesz/stream.m3u8";
    const { headers } = buildProxyHeaders(target, "https://jkanime.net/");
    expect(headers["Referer"]).toBe("https://jkanime.net/");
  });
});
