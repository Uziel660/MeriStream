import { describe, expect, it, vi } from "vitest";
import {
  assertSafePublicHttpUrl,
  fetchSafePublicHttpUrl,
  isSafePublicHttpUrl,
  type SafeUrlLookup,
  UnsafeUrlError,
} from "./urlSafety";

const lookup = (...addresses: string[]): SafeUrlLookup => vi.fn(async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

describe("public outbound URL safety", () => {
  it("accepts and normalizes HTTP(S) URLs after checking every DNS answer", async () => {
    const resolver = lookup("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946");
    const result = await assertSafePublicHttpUrl("HTTPS://Example.COM:443/video/../master.m3u8", { lookup: resolver });
    expect(result.href).toBe("https://example.com/master.m3u8");
    expect(resolver).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
  });

  it.each(["file:///etc/passwd", "ftp://example.com/a", "data:text/plain,x"])(
    "rejects unsupported protocol %s",
    async (input) => {
      await expect(assertSafePublicHttpUrl(input, { lookup: lookup("93.184.216.34") }))
        .rejects.toMatchObject({ code: "unsupported_protocol" });
    },
  );

  it("rejects credentials and malformed inputs before DNS", async () => {
    const resolver = lookup("93.184.216.34");
    await expect(assertSafePublicHttpUrl("https://user:secret@example.com/a", { lookup: resolver }))
      .rejects.toMatchObject({ code: "credentials_not_allowed" });
    await expect(assertSafePublicHttpUrl("not a url", { lookup: resolver }))
      .rejects.toMatchObject({ code: "invalid_url" });
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["https://bad_host.example/a", "https://-bad.example/a", "https://bad-.example/a"])(
    "rejects invalid hostname syntax in %s",
    async (input) => {
      const resolver = lookup("93.184.216.34");
      await expect(assertSafePublicHttpUrl(input, { lookup: resolver }))
        .rejects.toMatchObject({ code: "invalid_hostname" });
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it.each([
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.2.3",
    "172.16.0.1", "172.31.255.255", "192.168.1.2", "198.18.0.1",
    "192.0.2.1", "198.51.100.2", "203.0.113.4", "224.0.0.1", "255.255.255.255",
  ])("blocks non-public IPv4 %s", async (address) => {
    await expect(assertSafePublicHttpUrl("https://media.example/a", { lookup: lookup(address) }))
      .rejects.toMatchObject({ code: "non_public_ip" });
  });

  it.each([
    "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.2.3.4", "::ffff:c0a8:101",
  ])("blocks non-public IPv6 %s", async (address) => {
    await expect(assertSafePublicHttpUrl("https://media.example/a", { lookup: lookup(address) }))
      .rejects.toMatchObject({ code: "non_public_ip" });
  });

  it("rejects a hostname if any DNS answer is private", async () => {
    const resolver = lookup("93.184.216.34", "10.0.0.7");
    await expect(assertSafePublicHttpUrl("https://mixed.example/a", { lookup: resolver }))
      .rejects.toMatchObject({ code: "non_public_ip" });
  });

  it("handles literal IPv6 hostnames and still resolves them", async () => {
    const resolver = lookup("2606:4700:4700::1111");
    await expect(assertSafePublicHttpUrl("https://[2606:4700:4700::1111]/a", { lookup: resolver }))
      .resolves.toBeInstanceOf(URL);
    expect(resolver).toHaveBeenCalledWith("2606:4700:4700::1111", { all: true, verbatim: true });
  });

  it("returns typed errors for DNS failure, empty answers, and invalid answers", async () => {
    const failed: SafeUrlLookup = vi.fn(async () => { throw new Error("NXDOMAIN"); });
    await expect(assertSafePublicHttpUrl("https://missing.example", { lookup: failed }))
      .rejects.toMatchObject({ name: "UnsafeUrlError", code: "dns_failed" });
    await expect(assertSafePublicHttpUrl("https://empty.example", { lookup: lookup() }))
      .rejects.toMatchObject({ code: "no_dns_results" });
    await expect(assertSafePublicHttpUrl("https://bad.example", { lookup: lookup("garbage") }))
      .rejects.toMatchObject({ code: "invalid_ip" });
  });

  it("offers a boolean helper without leaking validation errors", async () => {
    expect(await isSafePublicHttpUrl("https://example.com/a", { lookup: lookup("1.1.1.1") })).toBe(true);
    expect(await isSafePublicHttpUrl("http://localhost/a", { lookup: lookup("127.0.0.1") })).toBe(false);
    expect(await isSafePublicHttpUrl("bad", { lookup: lookup("1.1.1.1") })).toBe(false);
  });

  it("exposes a stable typed error class", () => {
    const error = new UnsafeUrlError("invalid_url", "bad");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "UnsafeUrlError", code: "invalid_url", message: "bad" });
  });

  it("revalidates every redirect target before following it", async () => {
    const resolver = vi.fn(async (hostname: string) => [{
      address: hostname === "internal.example" ? "10.0.0.8" : "93.184.216.34",
      family: 4,
    }]);
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://internal.example/secret" },
    }));

    await expect(fetchSafePublicHttpUrl("https://public.example/start", {}, {
      lookup: resolver,
      fetch: fetchMock,
    })).rejects.toMatchObject({ code: "non_public_ip" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a bounded public redirect chain using manual redirect mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const response = await fetchSafePublicHttpUrl("https://public.example/start", {}, {
      lookup: lookup("93.184.216.34"),
      fetch: fetchMock,
    });
    expect(await response.text()).toBe("ok");
    expect(fetchMock).toHaveBeenLastCalledWith(
      new URL("https://public.example/final"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
