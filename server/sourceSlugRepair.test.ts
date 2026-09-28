import { describe, expect, it } from "vitest";
import { exactRepairTitleMatch } from "./sourceSlugRepair";

describe("source slug repair safeguards", () => {
  it("matches canonical title variants but rejects unrelated titles", () => {
    expect(exactRepairTitleMatch("The Penthouse Latino 2020", "The Penthouse")).toBe(true);
    expect(exactRepairTitleMatch("The Penthouse", "The Penthouse")).toBe(true);
    expect(exactRepairTitleMatch("Penthouse: War in Life", "The Penthouse")).toBe(false);
  });
});

