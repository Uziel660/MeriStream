import { PrismaClient } from "@prisma/client";
import "dotenv/config";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:./dev.db";
}

const prisma = new PrismaClient();

export { prisma };

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
