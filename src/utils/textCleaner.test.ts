import { describe, it, expect } from "vitest";
import { cleanDescription, cleanDisplayTitle, cleanDisplayGenres } from "./textCleaner";

describe("textCleaner", () => {
  it("clean operations test suite", () => {
    // Description
    expect(cleanDescription(null)).toBe("");
    expect(cleanDescription("Hola&nbsp;Mundo")).toBe("Hola Mundo");
    expect(cleanDescription("&#x3e;")).toBe(">");
    expect(cleanDescription("<b>Bold</b>")).toBe("Bold");
    expect(cleanDescription("CanciÃ³n")).toBe("Canción");
    expect(cleanDescription("Sinopsis: A")).toBe("A");
    expect(cleanDescription("The Matrix - Hacker", "The Matrix")).toBe("Hacker");

    // Title
    expect(cleanDisplayTitle(null)).toBe("");
    expect(cleanDisplayTitle("The Movie online gratis hd")).toBe("The Movie");
    expect(cleanDisplayTitle("The Movie -")).toBe("The Movie");

    // Genres
    expect(cleanDisplayGenres(null)).toEqual([]);
    expect(cleanDisplayGenres("A, B")).toEqual(["A", "B"]);

    const dump = ["Action", "Drama", "DC Comics", "Anime", "Documental", "Real Genre 1", "Real Genre 2"];
    const result = cleanDisplayGenres(dump);
    expect(result.length).toBeLessThanOrEqual(4);
    expect(result).not.toContain("DC Comics");
  });
});
