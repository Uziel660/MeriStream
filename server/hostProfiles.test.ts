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

  it("aplica el referer fijo de ZokoAnime a su CDN", () => {
    const target = "https://hls2.aniwatchtv.uk/v/test/master.m3u8";
    const profile = resolveHostProfile(target);
    expect(profile.refererMode).toBe("fixed");
    expect(profile.client).toBe("undici");
    const { headers } = buildProxyHeaders(target, undefined);
    expect(headers.Referer).toBe("https://zokoanime.video/");
  });

  it("resuelve vimeos.zip y vimeos.net con cliente undici, sin referer y con timeout de conexión", () => {
    const targetZip = "https://p4.vimeos.zip/hls2/02/00009/drh2cmxggq49_h/seg-12-v1-a1.ts?t=2Jgs0jtVbjaKNVfSqkn";
    const profileZip = resolveHostProfile(targetZip);

    expect(profileZip.refererMode).toBe("none");
    expect(profileZip.client).toBe("undici");
    expect(profileZip.userAgent).toBe(CHROME_124_UA);
    expect(profileZip.connectTimeoutMs).toBe(15000);

    const { headers: headersZip } = buildProxyHeaders(targetZip, "https://vimeos.net/");
    expect(headersZip["Referer"]).toBeUndefined();
    expect(headersZip["Accept-Encoding"]).toBe("identity");

    const targetNet = "https://s8.vimeos.net/hls2/02/00006/i95917axjpz0_,n,h,.urlset/master.m3u8?t=xyz";
    const profileNet = resolveHostProfile(targetNet);
    expect(profileNet.refererMode).toBe("none");
    expect(profileNet.client).toBe("undici");
  });
});
