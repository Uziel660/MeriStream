import { describe, expect, it } from "vitest";
import {
  SOURCE_EVIDENCE_STATUS,
  deriveSourceEvidenceStatus,
  isJitCandidate,
  isPlayerEligible,
  mergeSourceEvidenceStatus,
  normalizeSourceEvidenceStatus,
} from "./sourceEvidence";

describe("source evidence contract", () => {
  it("does not promote a saved page or URL-looking value to playable", () => {
    expect(deriveSourceEvidenceStatus({ identityMatched: true })).toBe("identity_matched");
    expect(deriveSourceEvidenceStatus({ extractedUrl: "https://cdn.test/master.m3u8" })).toBe("extracted");
    expect(isPlayerEligible("extracted")).toBe(false);
  });

  it("requires extraction, media check and player proof for the strongest states", () => {
    expect(deriveSourceEvidenceStatus({ extractedUrl: "https://cdn.test/master.m3u8", mediaChecked: true })).toBe("media_checked");
    expect(deriveSourceEvidenceStatus({ extractedUrl: "https://cdn.test/master.m3u8", mediaChecked: true, playerVerified: true })).toBe("player_verified");
    expect(deriveSourceEvidenceStatus({ extractedUrl: "https://cdn.test/master.m3u8", mediaChecked: true, playerVerified: true, refreshChecked: true })).toBe("refresh_checked");
    expect(isPlayerEligible("player_verified")).toBe(true);
  });

  it("keeps failed sources out while allowing pending canonical locators to be retried", () => {
    expect(deriveSourceEvidenceStatus({ failureReason: "drm_or_captcha" })).toBe("failed");
    expect(isJitCandidate("failed")).toBe(false);
    expect(isJitCandidate("discovered")).toBe(true);
  });

  it("normalizes old or unknown states and never downgrades stronger evidence", () => {
    expect(normalizeSourceEvidenceStatus("is_verified")).toBe(SOURCE_EVIDENCE_STATUS.DISCOVERED);
    expect(mergeSourceEvidenceStatus("player_verified", "discovered")).toBe("player_verified");
    expect(mergeSourceEvidenceStatus("failed", "extracted")).toBe("extracted");
  });
});

