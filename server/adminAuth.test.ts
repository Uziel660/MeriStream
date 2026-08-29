import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  ADMIN_SESSION_COOKIE,
  adminLogin,
  adminLogout,
  adminSession,
  hasValidAdminSession,
  isAdminConfigured,
  isAdminControlPlaneRequest,
  issueAdminSession,
  requireAdmin,
  verifyAdminCredentials,
} from "./adminAuth";

const originalEnv = {
  ADMIN_USER: process.env.ADMIN_USER,
  ADMIN_PASS: process.env.ADMIN_PASS,
  ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
  NODE_ENV: process.env.NODE_ENV,
};

function setAdminEnv() {
  process.env.ADMIN_USER = "admin-test";
  process.env.ADMIN_PASS = "correct-password";
  process.env.ADMIN_SESSION_SECRET = "a-long-random-test-secret-with-more-than-thirty-two-bytes";
}

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function mockResponse() {
  const result: { status?: number; body?: unknown } = {};
  const res: any = {};
  res.status = vi.fn((status: number) => {
    result.status = status;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    result.body = body;
    return res;
  });
  res.cookie = vi.fn(() => res);
  res.clearCookie = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return { res: res as Response, result };
}

afterEach(() => restoreEnv());

describe("adminAuth", () => {
  it("bloquea la administración si falta cualquier variable requerida", () => {
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASS;
    delete process.env.ADMIN_SESSION_SECRET;

    const { res, result } = mockResponse();
    const next = vi.fn();
    requireAdmin({ headers: {} } as Request, res, next);

    expect(isAdminConfigured()).toBe(false);
    expect(result.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("rechaza credenciales administrativas incorrectas", () => {
    setAdminEnv();
    expect(verifyAdminCredentials("admin-test", "wrong-password")).toBe(false);

    const { res, result } = mockResponse();
    adminLogin({ headers: {}, body: { user: "admin-test", password: "wrong-password" } } as Request, res);
    expect(result.status).toBe(401);
    expect((res.cookie as any)).not.toHaveBeenCalled();
  });

  it("emite una cookie HttpOnly de sesión al iniciar correctamente", () => {
    setAdminEnv();
    process.env.NODE_ENV = "production";
    const { res, result } = mockResponse();

    adminLogin({ headers: {}, body: { user: "admin-test", password: "correct-password" } } as Request, res);

    expect(result.body).toEqual({ ok: true });
    expect(res.cookie).toHaveBeenCalledWith(
      ADMIN_SESSION_COOKIE,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "strict", secure: true, path: "/" })
    );
  });

  it("valida sesiones, rechaza tokens inválidos y permite el middleware solo con cookie válida", () => {
    setAdminEnv();
    const token = issueAdminSession();
    const validRequest = { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}` } } as Request;
    expect(hasValidAdminSession(validRequest)).toBe(true);

    const { res: validRes } = mockResponse();
    const next = vi.fn();
    requireAdmin(validRequest, validRes, next);
    expect(next).toHaveBeenCalledOnce();

    const { res: invalidRes, result: invalidResult } = mockResponse();
    requireAdmin({ headers: { cookie: `${ADMIN_SESSION_COOKIE}=not-a-token` } } as Request, invalidRes, vi.fn());
    expect(invalidResult.status).toBe(401);
  });

  it("expone estado de sesión y elimina la cookie al cerrar sesión", () => {
    setAdminEnv();
    const token = issueAdminSession();
    const { res: sessionRes, result: sessionResult } = mockResponse();
    adminSession({ headers: { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}` } } as Request, sessionRes);
    expect(sessionResult.body).toEqual({ ok: true, authenticated: true });

    const { res: logoutRes, result: logoutResult } = mockResponse();
    adminLogout({ headers: {} } as Request, logoutRes);
    expect(logoutResult.status).toBe(204);
    expect(logoutRes.clearCookie).toHaveBeenCalledWith(
      ADMIN_SESSION_COOKIE,
      expect.objectContaining({ httpOnly: true, sameSite: "strict", path: "/" })
    );
  });

  it("protege todas las rutas del plano administrativo y deja libres las rutas del reproductor", () => {
    for (const [path, method] of [
      ["/verification", "GET"],
      ["/worker/jobs", "GET"],
      ["/tasks/task-1", "GET"],
      ["/watchdog/run", "POST"],
      ["/write-buffer", "GET"],
      ["/metadata/backfill", "POST"],
      ["/scraper/presets", "GET"],
      ["/sites/ratings", "POST"],
      ["/platforms/animeflv/test-servers", "POST"],
      ["/catalog/import-show", "POST"],
      ["/catalog/crawl", "POST"],
      ["/discover", "POST"],
      ["/catalog/reconcile-sequels", "POST"],
      ["/shows/show-1", "DELETE"],
      ["/shows/show-1/force-metadata", "POST"],
      ["/network/logs", "DELETE"],
    ] as const) {
      expect(isAdminControlPlaneRequest(path, method)).toBe(true);
    }

    for (const [path, method] of [
      ["/shows", "GET"],
      ["/shows/show-1", "GET"],
      ["/play-multi/media-1", "GET"],
      ["/catalog/episode-servers", "POST"],
      ["/extract", "POST"],
      ["/network/player-event", "POST"],
    ] as const) {
      expect(isAdminControlPlaneRequest(path, method)).toBe(false);
    }
  });
});
