import { describe, expect, it } from "vitest";
import { cleanQueryTitle } from "./metadataEngine";

describe("cleanQueryTitle", () => {
  it("should return the title unchanged if no tags are present", () => {
    expect(cleanQueryTitle("Naruto")).toBe("Naruto");
    expect(cleanQueryTitle("Breaking Bad")).toBe("Breaking Bad");
    expect(cleanQueryTitle("The Lord of the Rings")).toBe("The Lord of the Rings");
  });

  it("should strip prefixes", () => {
    expect(cleanQueryTitle("Ver Naruto")).toBe("Naruto");
    expect(cleanQueryTitle("Ver Online Breaking Bad")).toBe("Breaking Bad");
    expect(cleanQueryTitle("Pelicula Inception")).toBe("Inception");
    expect(cleanQueryTitle("Película The Matrix")).toBe("The Matrix");
    expect(cleanQueryTitle("Serie Friends")).toBe("Friends");
    expect(cleanQueryTitle("Anime One Piece")).toBe("One Piece");
    expect(cleanQueryTitle("Ova Hellsing")).toBe("Hellsing");
    expect(cleanQueryTitle("Donghua Soul Land")).toBe("Soul Land");
    expect(cleanQueryTitle("Watch Spider-Man")).toBe("Spider-Man");
    expect(cleanQueryTitle("Full Movie Avengers")).toBe("Avengers");
    // Case insensitivity
    expect(cleanQueryTitle("vEr onLine bleach")).toBe("bleach");
  });

  it("should strip suffixes and everything after them", () => {
    expect(cleanQueryTitle("Naruto Sub Español")).toBe("Naruto");
    expect(cleanQueryTitle("Bleach Audio Latino")).toBe("Bleach");
    expect(cleanQueryTitle("Dragon Ball Latino")).toBe("Dragon Ball");
    expect(cleanQueryTitle("Simpsons Castellano")).toBe("Simpsons");
    expect(cleanQueryTitle("Inception Dual")).toBe("Inception");
    expect(cleanQueryTitle("Avatar 1080p Bluray")).toBe("Avatar");
    expect(cleanQueryTitle("Interstellar 720p RIP")).toBe("Interstellar");
    expect(cleanQueryTitle("Joker 4K UHD")).toBe("Joker");
    expect(cleanQueryTitle("Batman HD")).toBe("Batman");
    expect(cleanQueryTitle("Superman Full HD")).toBe("Superman");
    expect(cleanQueryTitle("Movie Online Free")).toBe("Movie");
    expect(cleanQueryTitle("Show Gratis")).toBe("Show");
    expect(cleanQueryTitle("Show Free Download")).toBe("Show");
    expect(cleanQueryTitle("Show Episodio 12")).toBe("Show");
    expect(cleanQueryTitle("Show Capitulo 10")).toBe("Show");
    expect(cleanQueryTitle("Show Cap 5")).toBe("Show");
    expect(cleanQueryTitle("Show S01E02")).toBe("Show");
    // Case insensitivity
    expect(cleanQueryTitle("Naruto sUB esPañol")).toBe("Naruto");
  });

  it("should strip (TV) anywhere", () => {
    expect(cleanQueryTitle("Title (TV)")).toBe("Title");
    // Wait, the replace is /\s*\(TV\)/i which just replaces it with "".
    // And if it's in the middle?
    // Title (TV) becomes Title, Title (TV) Part 2 becomes Title Part 2
    expect(cleanQueryTitle("Title (TV) Part 2")).toBe("Title Part 2");
  });

  it("should strip text inside brackets, parentheses, and braces", () => {
    expect(cleanQueryTitle("Naruto (2002)")).toBe("Naruto");
    expect(cleanQueryTitle("Bleach [HD]")).toBe("Bleach");
    expect(cleanQueryTitle("One Piece {Sub}")).toBe("One Piece");
    expect(cleanQueryTitle("Attack on Titan (Final Season) [1080p] {x264}")).toBe("Attack on Titan");
    expect(cleanQueryTitle("K-On! (Movie)")).toBe("K-On!");
  });

  it("should split at hyphens, em-dashes, and pipes, keeping the first part", () => {
    expect(cleanQueryTitle("Naruto - Episode 1")).toBe("Naruto");
    expect(cleanQueryTitle("Bleach | Season 2")).toBe("Bleach");
    expect(cleanQueryTitle("One Piece — Wano Arc")).toBe("One Piece");
    // Only with spaces around them
    expect(cleanQueryTitle("Spider-Man")).toBe("Spider-Man");
    expect(cleanQueryTitle("Spider-Man - No Way Home")).toBe("Spider-Man");
  });

  it("should handle a combination of tags, prefixes, and suffixes", () => {
    expect(cleanQueryTitle("Ver Online Attack on Titan (Final Season) - Episodio 12 1080p [Sub Español]")).toBe("Attack on Titan");
    expect(cleanQueryTitle("Anime My Hero Academia | Cap 5 (TV) Audio Latino")).toBe("My Hero Academia");
    expect(cleanQueryTitle("Película Spider-Man: Into the Spider-Verse — Full HD Dual")).toBe("Spider-Man: Into the Spider-Verse");
  });
});
