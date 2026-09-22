import { PrismaClient, Prisma } from "@prisma/client";
import { parseTitleQuery } from "./metadataEngine";
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  // CI y las pruebas usan el PostgreSQL efímero configurado por sus workflows.
  if (process.env.CI || process.env.NODE_ENV === "test") {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/meristream_test?schema=public";
  } else {
    process.env.DATABASE_URL = "file:./dev.db";
  }
}

const prisma = new PrismaClient();

export { prisma, Prisma };

/**
 * Normalizes title string for deduplication (removes punctuation, extra spaces, accents, converts to lowercase)
 */
export function normalizeTitle(title: string): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^a-z0-9]/g, ""); // remove non-alphanumeric
}

/**
 * Clave de agrupaci\u00f3n multi-temporada/multi-fuente: normaliza el t\u00edtulo SIN el
 * sufijo de temporada ("Kaguya-sama TP2" y "TP1" \u2192 "kaguyasama").
 */
export function normalizeBaseTitle(title: string): string {
  if (!title) return "";
  return normalizeTitle(parseTitleQuery(title).baseTitle);
}
