// server/resolvers/ytdlpResolver.ts
import { spawn } from "child_process";
import { ResolvedStreamMeta } from "./types";
import { parseStreamExpiry } from "../resolutionMetadata";

const PYTHON_BIN = "C:\\Users\\Uziel\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

// Limitador de concurrencia para entorno de 2 GB de RAM: máximo 2 procesos simultáneos
let activeProcesses = 0;
const MAX_CONCURRENT = 2;
const waitQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeProcesses < MAX_CONCURRENT) {
    activeProcesses++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => {
      activeProcesses++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeProcesses--;
  const next = waitQueue.shift();
  if (next) next();
}

/**
 * Extrae stream directo (.m3u8 / .mp4) de un locker o embed usando yt-dlp.
 * Proceso efímero y seguro con límite de tiempo estricto (6 s).
 */
export async function resolveWithYtDlp(embedUrl: string): Promise<ResolvedStreamMeta | null> {
  const cleanUrl = (embedUrl || "").trim();
  if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) return null;

  await acquireSlot();
  try {
    return await new Promise<ResolvedStreamMeta | null>((resolve) => {
      let settled = false;
      const done = (result: ResolvedStreamMeta | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      };

      // Matar el proceso si pasa de 6 segundos
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        done(null);
      }, 6000);

      const args = [
        "-m",
        "yt_dlp",
        "-j",
        "--no-warnings",
        "--no-playlist",
        "--socket-timeout",
        "4",
        cleanUrl,
      ];

      const proc = spawn(PYTHON_BIN, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        // Evitar buffers enormes si el JSON es muy largo
        if (stdout.length > 500_000) {
          try { proc.kill(); } catch {}
        }
      });

      proc.on("error", () => done(null));

      proc.on("close", (code) => {
        if (code !== 0 || !stdout.trim()) {
          return done(null);
        }

        try {
          const info = JSON.parse(stdout.trim());
          const directUrl: string = info.url || "";
          if (!directUrl || directUrl === cleanUrl) return done(null);

          // Verificar si es un stream reproducible directo
          const isDirect = /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(directUrl) || directUrl.includes("/m3u8/");
          if (!isDirect) return done(null);

          const { expiresAt } = parseStreamExpiry(directUrl);
          const requiredHeaders: Record<string, string> = {};
          if (info.http_headers && typeof info.http_headers === "object") {
            for (const [k, v] of Object.entries(info.http_headers)) {
              if (typeof v === "string" && (k.toLowerCase() === "referer" || k.toLowerCase() === "user-agent")) {
                requiredHeaders[k] = v;
              }
            }
          }

          const result: ResolvedStreamMeta = {
            url: directUrl,
            original_url: cleanUrl,
            canonical_locator: cleanUrl,
            resolved: true,
            type: "direct",
            provider: info.extractor_key || info.extractor || "Locker",
            delivery_mode: "direct_trial",
            is_proxyable: true,
            is_refreshable: true,
            ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
            ...(Object.keys(requiredHeaders).length > 0 ? { requiredHeaders } : {}),
          };

          return done(result);
        } catch {
          return done(null);
        }
      });
    });
  } finally {
    releaseSlot();
  }
}
