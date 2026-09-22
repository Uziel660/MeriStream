import { prisma } from "./db";

export const CATALOG_REPORT_TYPES = [
  "inappropriate",
  "wrong_classification",
  "incorrect_title_or_content",
  "wrong_metadata",
  "missing_or_wrong_subtitles",
  "wrong_language",
  "source_not_working",
  "other",
] as const;

export const CATALOG_REPORT_STATUSES = ["open", "in_review", "resolved", "dismissed"] as const;

export type CatalogReportType = (typeof CATALOG_REPORT_TYPES)[number];
export type CatalogReportStatus = (typeof CATALOG_REPORT_STATUSES)[number];

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeKind(value: unknown): string | undefined {
  const clean = cleanText(value, 20)?.toLowerCase();
  return clean && ["movie", "series", "anime"].includes(clean) ? clean : undefined;
}

export interface CreateCatalogReportInput {
  showId?: unknown;
  tmdbId?: unknown;
  kind?: unknown;
  title: unknown;
  episodeId?: unknown;
  episodeNumber?: unknown;
  reportType: unknown;
  details?: unknown;
  sourceProvider?: unknown;
  sourceUrl?: unknown;
}

export async function createCatalogReport(input: CreateCatalogReportInput) {
  const reportType = cleanText(input.reportType, 64);
  if (!reportType || !(CATALOG_REPORT_TYPES as readonly string[]).includes(reportType)) {
    throw new Error("Tipo de reporte no válido.");
  }
  const title = cleanText(input.title, 240);
  if (!title) throw new Error("El título de la obra es obligatorio.");

  return prisma.catalogReport.create({
    data: {
      show_id: cleanText(input.showId, 128),
      tmdb_id: positiveInt(input.tmdbId),
      kind: normalizeKind(input.kind),
      title,
      episode_id: cleanText(input.episodeId, 128),
      episode_number: finiteNumber(input.episodeNumber),
      report_type: reportType,
      details: cleanText(input.details, 2000),
      source_provider: cleanText(input.sourceProvider, 120),
      source_url: cleanText(input.sourceUrl, 2000),
    },
  });
}

async function findMatchedShow(report: { show_id: string | null; tmdb_id: number | null; kind: string | null }) {
  if (report.show_id) {
    const byId = await prisma.show.findUnique({
      where: { id: report.show_id },
      select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true },
    });
    if (byId) return byId;
  }
  if (!report.tmdb_id) return null;
  const tvCategories = ["anime", "series"];
  return prisma.show.findFirst({
    where: {
      tmdb_id: report.tmdb_id,
      ...(report.kind === "movie"
        ? { category: "movie" }
        : report.kind === "anime" || report.kind === "series"
          ? { category: { in: tvCategories } }
          : {}),
    },
    orderBy: { updated_at: "desc" },
    select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true },
  });
}

export async function listCatalogReports(options: {
  status?: unknown;
  limit?: unknown;
  offset?: unknown;
} = {}) {
  const requestedStatus = cleanText(options.status, 32);
  const status = requestedStatus && (CATALOG_REPORT_STATUSES as readonly string[]).includes(requestedStatus)
    ? requestedStatus
    : undefined;
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 50)));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const where = status ? { status } : {};
  const [reports, total, openCount] = await Promise.all([
    prisma.catalogReport.findMany({ where, orderBy: { created_at: "desc" }, skip: offset, take: limit }),
    prisma.catalogReport.count({ where }),
    prisma.catalogReport.count({ where: { status: { in: ["open", "in_review"] } } }),
  ]);
  const enriched = await Promise.all(reports.map(async (report) => ({
    ...report,
    matched_show: await findMatchedShow(report),
  })));
  return { reports: enriched, total, open_count: openCount, limit, offset };
}

export async function getCatalogReportSummary() {
  const [open, inReview, resolved, dismissed] = await Promise.all(
    CATALOG_REPORT_STATUSES.map((status) => prisma.catalogReport.count({ where: { status } })),
  );
  return { open, in_review: inReview, resolved, dismissed, actionable: open + inReview };
}

export async function updateCatalogReport(id: string, patch: {
  status?: unknown;
  adminNote?: unknown;
  resolutionAction?: unknown;
}) {
  const status = cleanText(patch.status, 32);
  if (status && !(CATALOG_REPORT_STATUSES as readonly string[]).includes(status)) {
    throw new Error("Estado de reporte no válido.");
  }
  const adminNote = patch.adminNote === null ? null : cleanText(patch.adminNote, 2000);
  const resolutionAction = patch.resolutionAction === null ? null : cleanText(patch.resolutionAction, 120);
  return prisma.catalogReport.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      ...(patch.adminNote !== undefined ? { admin_note: adminNote } : {}),
      ...(patch.resolutionAction !== undefined ? { resolution_action: resolutionAction } : {}),
      ...(status === "resolved" || status === "dismissed" ? { resolved_at: new Date() } : status ? { resolved_at: null } : {}),
    },
  });
}
