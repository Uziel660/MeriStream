import { describe, it, expect } from "vitest";
import { DoramasflixAdapter } from "../../server/scrapers/adapters/DoramasflixAdapter";
import { ScraperManager } from "../../server/scrapers/ScraperManager";

describe("DoramasflixAdapter", () => {
  const adapter = new DoramasflixAdapter();

  it("identifica correctamente los dominios soportados", () => {
    expect(adapter.canHandle("https://doramasflix.io/doramas")).toBe(true);
    expect(adapter.canHandle("https://doramasflix.co/peliculas")).toBe(true);
    expect(adapter.canHandle("https://doramasflix.net/variedades")).toBe(true);
    expect(adapter.canHandle("https://otro-sitio.com")).toBe(false);
  });

  it("se registra correctamente en ScraperManager", () => {
    const manager = ScraperManager.getInstance();
    const resolvedAdapter = manager.getAdapter("https://doramasflix.io/doramas");
    expect(resolvedAdapter.id).toBe("doramasflix");
  });

  it("desencripta correctamente enlaces de embedshortener.co JWT", () => {
    const validJwtUrl = "https://embedshortener.co/e/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJsaW5rIjoiYUhSMGNITTZMeTl3Y21sdFpXeHZZV1F1WTI4dlpXMWlaV1F2V1V0WE5USklaM1JKUkVNMCIsInNlcnZlciI6IjQ3MjEiLCJhcHAiOiJjb20uYXNpYXBwLmRvcmFtYXNnbyIsImlhdCI6MTc4Nzg1NTQwOCwiZXhwIjoxNzg4MDI4MjA4fQ.QwqlrzoS2F8QLP0TZY0WLTrxpHKuBpCrcRa9FzeEyZk";

    const decoded = (adapter as any).decodeEmbedShortenerLink(validJwtUrl);
    expect(decoded).toBe("https://primeload.co/embed/YKW52HgtIDC4");
  });
});
