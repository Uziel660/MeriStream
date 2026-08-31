// server/playwrightResolver.ts
import type { Browser, BrowserContext } from "playwright";
import { createResolutionTiming, isResolutionFresh } from "./resolutionMetadata";
import type { ResolvedStreamMeta } from "./resolvers";

export class PlaywrightResolver {
  private browser: Browser | null = null;
  private isLaunching = false;
  private activeJobs = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private cache = new Map<string, ResolvedStreamMeta>();
  private negativeCache = new Map<string, number>();
  private inFlight = new Map<string, Promise<ResolvedStreamMeta | null>>();
  private readonly NEGATIVE_CACHE_TTL_MS = 20 * 1000;
  private readonly MAX_CONCURRENT = 2;
  private queue: Array<() => void> = [];

  /**
   * Obtiene o inicia el navegador de forma perezosa (Lazy)
   */
  private async getBrowser(): Promise<Browser | null> {
    if (this.browser && this.browser.isConnected()) {
      this.resetIdleTimer();
      return this.browser;
    }

    if (this.isLaunching) {
      while (this.isLaunching) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.browser && this.browser.isConnected()) return this.browser;
    }

    this.isLaunching = true;
    try {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-gpu",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--mute-audio",
          "--no-first-run",
        ],
      });
      this.resetIdleTimer();
      return this.browser;
    } catch (err) {
      console.warn("[PlaywrightResolver] No se pudo inicializar Chromium:", (err as Error)?.message);
      return null;
    } finally {
      this.isLaunching = false;
    }
  }

  /**
   * Cierra el navegador tras 3 minutos de inactividad para liberar el 100% de la RAM
   */
  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(async () => {
      if (this.activeJobs === 0 && this.browser) {
        try {
          await this.browser.close();
        } catch {}
        this.browser = null;
      }
    }, 3 * 60 * 1000);
  }

  /**
   * Semáforo para controlar concurrencia máxima y evitar sobrecargar la CPU
   */
  private async acquireSlot(): Promise<void> {
    if (this.activeJobs < this.MAX_CONCURRENT) {
      this.activeJobs++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeJobs++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeJobs = Math.max(0, this.activeJobs - 1);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.resetIdleTimer();
    }
  }

  /**
   * Resuelve una URL de embed a su stream directo (.m3u8 / .mp4) usando Chromium headless optimizado.
   */
  public async resolve(embedUrl: string): Promise<string | null> {
    const rawUrl = (embedUrl || "").trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;
    return (await this.resolveWithMeta(rawUrl))?.url ?? null;
  }

  /**
   * Dynamic, single-flight resolver. Its cache is bounded by refresh_after, not a
   * fixed thirty-minute value, because stream URLs are often signed.
   */
  public async resolveWithMeta(embedUrl: string): Promise<ResolvedStreamMeta | null> {
    const rawUrl = (embedUrl || "").trim();
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return null;

    const cached = this.cache.get(rawUrl);
    if (cached && isResolutionFresh(cached)) return cached;
    const negativeUntil = this.negativeCache.get(rawUrl);
    if (negativeUntil && negativeUntil > Date.now()) return null;
    if (negativeUntil) this.negativeCache.delete(rawUrl);

    const existing = this.inFlight.get(rawUrl);
    if (existing) return existing;
    const work = this.resolveUncached(rawUrl).finally(() => this.inFlight.delete(rawUrl));
    this.inFlight.set(rawUrl, work);
    return work;
  }

  private async resolveUncached(rawUrl: string): Promise<ResolvedStreamMeta | null> {

    await this.acquireSlot();

    let context: BrowserContext | null = null;
    try {
      // Another request could have completed while this one waited in the semaphore.
      const cachedAfterWait = this.cache.get(rawUrl);
      if (cachedAfterWait && isResolutionFresh(cachedAfterWait)) return cachedAfterWait;
      const browser = await this.getBrowser();
      if (!browser) return this.cacheNegative(rawUrl);

      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 720 },
      });

      const page = await context.newPage();

      let detectedStreamUrl: string | null = null;

      // 2. Bloquear recursos pesados (imágenes, fuentes, css innecesario, trackers)
      await page.route("**/*", (route) => {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url().toLowerCase();

        // Bloquear trackers y anuncios
        if (
          url.includes("google-analytics") ||
          url.includes("doubleclick") ||
          url.includes("popads") ||
          url.includes("adnetwork") ||
          url.includes("histats")
        ) {
          return route.abort();
        }

        // Bloquear assets que no aportan a la resolución de video
        if (["image", "font", "stylesheet"].includes(type)) {
          return route.abort();
        }

        return route.continue();
      });

      // 3. Sniffer de red en tiempo real para capturar .m3u8 o .mp4 al instante
      page.on("response", (res) => {
        if (detectedStreamUrl) return;
        const resUrl = res.url();
        const contentType = res.headers()["content-type"] || "";

        const isDirectStream =
          /\.(m3u8|mp4|webm)(\?|$)/i.test(resUrl) ||
          contentType.includes("application/vnd.apple.mpegurl") ||
          contentType.includes("application/x-mpegurl") ||
          contentType.includes("video/mp4");

        if (isDirectStream && !resUrl.includes("capblank") && !resUrl.includes("blank.mp4")) {
          detectedStreamUrl = resUrl;
        }
      });

      // 4. Navegar a la página con timeout estricto de 7.5 segundos
      try {
        await page.goto(rawUrl, {
          waitUntil: "domcontentloaded",
          timeout: 7500,
        });
      } catch {}

      // 5. Esperar hasta 2.5s si aún no se ha detectado el stream
      if (!detectedStreamUrl) {
        for (let i = 0; i < 10; i++) {
          if (detectedStreamUrl) break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      // 6. Fallback: Buscar en el DOM (video / source tags o variables JS)
      if (!detectedStreamUrl) {
        try {
          const domUrl = await page.evaluate(() => {
            const video = document.querySelector("video source, video") as HTMLVideoElement | HTMLSourceElement;
            if (video?.src && /\.(m3u8|mp4|webm)/i.test(video.src)) {
              return video.src;
            }
            // Buscar en scripts globales
            const html = document.documentElement.innerHTML;
            const match = html.match(/['"](https?:\/\/[^'"]+\.(?:m3u8|mp4)[^'"]*)['"]/i);
            return match ? match[1] : null;
          });
          if (domUrl) detectedStreamUrl = domUrl;
        } catch {}
      }

      // 7. Guardar en caché si se resolvió exitosamente
      if (detectedStreamUrl) {
        const provider = this.providerName(rawUrl);
        const meta: ResolvedStreamMeta = {
          url: detectedStreamUrl,
          original_url: rawUrl,
          canonical_locator: rawUrl,
          is_refreshable: true,
          resolved: true,
          type: "direct",
          provider,
          ...createResolutionTiming({ originalUrl: rawUrl, upstreamUrl: detectedStreamUrl, provider }),
        };
        this.cache.set(rawUrl, meta);
        return meta;
      }
      return this.cacheNegative(rawUrl);
    } catch (err) {
      console.warn("[PlaywrightResolver] Error al resolver embed:", (err as Error)?.message);
      return this.cacheNegative(rawUrl);
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      this.releaseSlot();
    }
  }

  /** Visible for focused tests and operational diagnostics; returns no stale URLs. */
  public getCachedResolution(embedUrl: string): ResolvedStreamMeta | null {
    const cached = this.cache.get((embedUrl || "").trim());
    return cached && isResolutionFresh(cached) ? cached : null;
  }

  private cacheNegative(rawUrl: string): null {
    this.negativeCache.set(rawUrl, Date.now() + this.NEGATIVE_CACHE_TTL_MS);
    return null;
  }

  private providerName(url: string): string {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("vimeos")) return "Vimeos";
    return host;
  }
}

export const playwrightResolver = new PlaywrightResolver();
