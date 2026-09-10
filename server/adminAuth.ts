import { type CookieOptions, type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

export const ADMIN_SESSION_COOKIE = "meristream_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

interface AdminSessionPayload {
  role: "admin";
}

function adminConfig() {
  const user = process.env.ADMIN_USER?.trim() || "";
  const password = process.env.ADMIN_PASS || "";
  const secret = process.env.ADMIN_SESSION_SECRET || "";
  return { user, password, secret };
}

export function isAdminConfigured(): boolean {
  const { user, password, secret } = adminConfig();
  return Boolean(user && password && secret);
}

function cookieOptions(req?: Request): CookieOptions {
  // Production is also used through `http://localhost` during local checks.
  // Derive the transport from the actual request so a Secure cookie is only
  // emitted when the browser can send it back. Express trusts the proxy in
  // server.ts, so x-forwarded-proto covers the Cloudflare HTTPS route.
  const forwardedProto = String(req?.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const requestProtocol = forwardedProto || String(req?.protocol || "").toLowerCase();
  const hasRequestProtocol = Boolean(requestProtocol);
  const secure = hasRequestProtocol
    ? Boolean(req?.secure || requestProtocol === "https")
    : process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
  };
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyAdminCredentials(user: unknown, password: unknown): boolean {
  if (!isAdminConfigured() || typeof user !== "string" || typeof password !== "string") return false;
  const configured = adminConfig();
  return safeEquals(user, configured.user) && safeEquals(password, configured.password);
}

export function issueAdminSession(): string {
  const { secret } = adminConfig();
  if (!secret) throw new Error("Admin session is not configured");
  return jwt.sign({ role: "admin" } satisfies AdminSessionPayload, secret, { expiresIn: ADMIN_SESSION_TTL_SECONDS });
}

export function hasValidAdminSession(req: Request): boolean {
  if (!isAdminConfigured()) return false;
  const token = readCookie(req, ADMIN_SESSION_COOKIE);
  if (!token) return false;
  try {
    const payload = jwt.verify(token, adminConfig().secret) as Partial<AdminSessionPayload>;
    return payload.role === "admin";
  } catch {
    return false;
  }
}

function unavailable(res: Response) {
  return res.status(503).json({ error: "Administración no configurada." });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  if (!hasValidAdminSession(req)) {
    res.status(401).json({ error: "Sesión administrativa requerida." });
    return;
  }
  next();
}

/** Rutas de control; las rutas de reproducción y catálogo público no entran aquí. */
export function isAdminControlPlaneRequest(path: string, method: string): boolean {
  const normalizedPath = (path || "/").replace(/\/+$/, "") || "/";
  const normalizedMethod = method.toUpperCase();
  const protectedPrefixes = [
    "/admin/catalog",
    "/admin/reports",
    "/admin/media-items",
    "/admin/source-links",
    "/admin/shows",
    "/admin/identity-repair",
    "/verification",
    "/worker",
    "/tasks",
    "/source-recovery",
    "/write-buffer",
    "/metadata/backfill",
    "/scraper/presets",
    "/sites/ratings",
    "/platforms",
  ];
  if (protectedPrefixes.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) {
    return true;
  }

  if (normalizedPath.startsWith("/network/") && normalizedPath !== "/network/player-event") return true;
  if (normalizedPath === "/admin/overview") return true;
  if (normalizedPath === "/discover") return true;
  if (/^\/catalog\/(analyze|import-show|batch-import|crawl|reset-sample|merge-works|reconcile-sequels)$/.test(normalizedPath)) {
    return true;
  }
  if (/^\/shows\/[^/]+$/.test(normalizedPath) && ["PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    return true;
  }
  return normalizedMethod === "POST" && /^\/shows\/[^/]+\/(refresh-streams|force-metadata)$/.test(normalizedPath);
}

/** Middleware para montar bajo /api/v1. */
export function requireAdminForControlPlane(req: Request, res: Response, next: NextFunction): void {
  if (!isAdminControlPlaneRequest(req.path, req.method)) {
    next();
    return;
  }
  requireAdmin(req, res, next);
}

export function adminLogin(req: Request, res: Response): void {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  if (!verifyAdminCredentials(req.body?.user, req.body?.password)) {
    res.status(401).json({ ok: false, detail: "Credenciales incorrectas" });
    return;
  }
  res.cookie(ADMIN_SESSION_COOKIE, issueAdminSession(), {
    ...cookieOptions(req),
    maxAge: ADMIN_SESSION_TTL_SECONDS * 1000,
  });
  res.json({ ok: true });
}

export function adminSession(req: Request, res: Response): void {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  if (!hasValidAdminSession(req)) {
    res.status(401).json({ ok: false, authenticated: false });
    return;
  }
  res.json({ ok: true, authenticated: true });
}

export function adminLogout(req: Request, res: Response): void {
  if (!isAdminConfigured()) {
    unavailable(res);
    return;
  }
  res.clearCookie(ADMIN_SESSION_COOKIE, cookieOptions(req));
  res.status(204).end();
}
