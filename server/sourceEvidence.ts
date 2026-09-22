/** Small, shared contract for source evidence.
 *
 * A saved page is evidence of discovery, not evidence of playable media. This
 * module is deliberately pure so import workers, JIT resolution and tests use
 * the same state rules without importing Prisma or a browser.
 */

export const SOURCE_EVIDENCE_STATUS = {
  DISCOVERED: "discovered",
  IDENTITY_MATCHED: "identity_matched",
  EXTRACTED: "extracted",
  MEDIA_CHECKED: "media_checked",
  PLAYER_VERIFIED: "player_verified",
  REFRESH_CHECKED: "refresh_checked",
  FAILED: "failed",
} as const;

export type SourceEvidenceStatus = typeof SOURCE_EVIDENCE_STATUS[keyof typeof SOURCE_EVIDENCE_STATUS];

export interface SourceEvidenceObservation {
  status?: string | null;
  identityMatched?: boolean;
  extractedUrl?: string | null;
  mediaChecked?: boolean;
  playerVerified?: boolean;
  refreshChecked?: boolean;
  failureReason?: string | null;
}

const ORDER: readonly SourceEvidenceStatus[] = [
  SOURCE_EVIDENCE_STATUS.DISCOVERED,
  SOURCE_EVIDENCE_STATUS.IDENTITY_MATCHED,
  SOURCE_EVIDENCE_STATUS.EXTRACTED,
  SOURCE_EVIDENCE_STATUS.MEDIA_CHECKED,
  SOURCE_EVIDENCE_STATUS.PLAYER_VERIFIED,
  SOURCE_EVIDENCE_STATUS.REFRESH_CHECKED,
];

/** Returns the strongest valid evidence; unknown/legacy values are discovery. */
export function normalizeSourceEvidenceStatus(value: unknown): SourceEvidenceStatus {
  if (typeof value !== "string") return SOURCE_EVIDENCE_STATUS.DISCOVERED;
  return (ORDER as readonly string[]).includes(value)
    ? value as SourceEvidenceStatus
    : value === SOURCE_EVIDENCE_STATUS.FAILED
      ? SOURCE_EVIDENCE_STATUS.FAILED
      : SOURCE_EVIDENCE_STATUS.DISCOVERED;
}

/**
 * Evidence can only advance when its prerequisite was actually observed.
 * `playerVerified` is intentionally not inferred from a direct-looking URL.
 */
export function deriveSourceEvidenceStatus(observation: SourceEvidenceObservation): SourceEvidenceStatus {
  if (observation.failureReason) return SOURCE_EVIDENCE_STATUS.FAILED;
  if (observation.refreshChecked && observation.playerVerified) return SOURCE_EVIDENCE_STATUS.REFRESH_CHECKED;
  if (observation.playerVerified && observation.mediaChecked && observation.extractedUrl) {
    return SOURCE_EVIDENCE_STATUS.PLAYER_VERIFIED;
  }
  if (observation.mediaChecked && observation.extractedUrl) return SOURCE_EVIDENCE_STATUS.MEDIA_CHECKED;
  if (observation.extractedUrl) return SOURCE_EVIDENCE_STATUS.EXTRACTED;
  if (observation.identityMatched) return SOURCE_EVIDENCE_STATUS.IDENTITY_MATCHED;
  return SOURCE_EVIDENCE_STATUS.DISCOVERED;
}

/** A source is eligible for our player only after media verification. */
export function isPlayerEligible(status: unknown): boolean {
  return status === SOURCE_EVIDENCE_STATUS.MEDIA_CHECKED ||
    status === SOURCE_EVIDENCE_STATUS.PLAYER_VERIFIED ||
    status === SOURCE_EVIDENCE_STATUS.REFRESH_CHECKED;
}

/** A canonical locator may still be resolved JIT while its media is pending. */
export function isJitCandidate(status: unknown): boolean {
  return normalizeSourceEvidenceStatus(status) !== SOURCE_EVIDENCE_STATUS.FAILED;
}

/** Preserve a stronger prior status when a later scan only rediscovers a page. */
export function mergeSourceEvidenceStatus(previous: unknown, next: SourceEvidenceStatus): SourceEvidenceStatus {
  const old = normalizeSourceEvidenceStatus(previous);
  if (old === SOURCE_EVIDENCE_STATUS.FAILED) return next;
  if (next === SOURCE_EVIDENCE_STATUS.FAILED) return old;
  return ORDER.indexOf(next) >= ORDER.indexOf(old) ? next : old;
}

