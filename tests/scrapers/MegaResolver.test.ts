import { describe, it, expect } from "vitest";
import { isMegaUrl, parseMegaUrl, toEmbedUrl } from "../../server/resolvers/megaResolver";

describe("megaResolver.parseMegaUrl", () => {
  it("parsea formato nuevo /file/{ID}#{KEY}", () => {
    const parsed = parseMegaUrl("https://mega.nz/file/Q7USRDiT#C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("file");
    expect(parsed!.fileId).toBe("Q7USRDiT");
    expect(parsed!.fileKey).toBe("C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
    expect(parsed!.canonicalUrl).toContain("mega.nz/file/Q7USRDiT#");
    expect(parsed!.embedUrl).toContain("mega.nz/embed/Q7USRDiT#");
  });

  it("parsea formato legacy /#!{ID}!{KEY}", () => {
    const parsed = parseMegaUrl("https://mega.nz/#!Q7USRDiT!C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("file");
    expect(parsed!.fileId).toBe("Q7USRDiT");
    expect(parsed!.fileKey).toBe("C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
  });

  it("parsea URLs ya convertidas a /embed/", () => {
    const parsed = parseMegaUrl("https://mega.nz/embed/Q7USRDiT#C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("file");
    expect(parsed!.embedUrl).toBe("https://mega.nz/embed/Q7USRDiT#C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
  });

  it("detecta carpetas como kind=folder (no streamable directo)", () => {
    const parsed = parseMegaUrl("https://mega.nz/folder/AbCdEfGh#IjKlMnOpQrStUvWxYz0123456789abcdefghijk");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("folder");
  });

  it("acepta variante con ?key= en query", () => {
    const parsed = parseMegaUrl("https://mega.nz/file/Q7USRDiT?key=C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
    expect(parsed).not.toBeNull();
    expect(parsed!.fileKey).toBe("C9yqOvGk3Dc5FzX1mN2pRbWtLhAeJ8sUvYwKxZnM0oI");
  });

  it("rechaza URLs que no son de Mega", () => {
    expect(parseMegaUrl("https://voe.sx/e/m3jidksjaq5y")).toBeNull();
    expect(parseMegaUrl("https://example.com/file/abc#def")).toBeNull();
    expect(parseMegaUrl("")).toBeNull();
  });

  it("isMegaUrl funciona con y sin protocolo", () => {
    expect(isMegaUrl("https://mega.nz/file/abc#def")).toBe(true);
    expect(isMegaUrl("mega.nz/file/abc#def")).toBe(true);
    expect(isMegaUrl("https://mega.io/embed/abc#def")).toBe(true);
    expect(isMegaUrl("https://voe.sx/e/abc")).toBe(false);
  });

  it("toEmbedUrl convierte cualquier variante a /embed/", () => {
    expect(toEmbedUrl("https://mega.nz/file/Q7USRDiT#KEY123")).toBe("https://mega.nz/embed/Q7USRDiT#KEY123");
    expect(toEmbedUrl("https://voe.sx/e/abc")).toBeNull();
  });
});
