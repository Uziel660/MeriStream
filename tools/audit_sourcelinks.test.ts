// tools/audit_sourcelinks.test.ts
import { describe, it, expect } from "vitest";
import {
  classifySourceLink,
  checkUrlExpiry,
  detectCatalogPageUrl,
  sanitizeUrlForReport,
  generateMarkdownReport,
  SourceLinkAuditReport,
} from "./audit_sourcelinks";

describe("Herramientas de Auditoría de SourceLink (tioplus.app, lamovie.org, cinecalidad.am)", () => {
  const fixedNow = new Date("2026-09-01T20:00:00.000Z").getTime();

  describe("1. Detección de URLs de catálogo/paginación (detectCatalogPageUrl)", () => {
    it("debe detectar /page/1/ y /page/N/ como páginas de catálogo inválidas", () => {
      expect(detectCatalogPageUrl("https://www.cinecalidad.am/page/1/")).toBe(true);
      expect(detectCatalogPageUrl("https://www.cinecalidad.am/page/42/")).toBe(true);
      expect(detectCatalogPageUrl("https://lamovie.org/peliculas/page/2/")).toBe(true);
      expect(detectCatalogPageUrl("https://tioplus.app/series/page/10/")).toBe(true);
    });

    it("debe detectar parámetros de paginación ?page=N", () => {
      expect(detectCatalogPageUrl("https://cinecalidad.am/?page=2")).toBe(true);
      expect(detectCatalogPageUrl("https://tioplus.app/catalog?page=5")).toBe(true);
    });

    it("debe detectar URLs de raíz o índices sin medio específico", () => {
      expect(detectCatalogPageUrl("https://www.cinecalidad.am/")).toBe(true);
      expect(detectCatalogPageUrl("https://lamovie.org/peliculas/")).toBe(true);
    });

    it("no debe marcar páginas de detalle específicas como catálogo", () => {
      expect(detectCatalogPageUrl("https://lamovie.org/peliculas/bloodshot-2020/")).toBe(false);
      expect(detectCatalogPageUrl("https://www.cinecalidad.am/ver-pelicula/intriga-internacional/")).toBe(false);
      expect(detectCatalogPageUrl("https://www.cinecalidad.am/ver-el-episodio/bodas-s-a-1x2/")).toBe(false);
      expect(detectCatalogPageUrl("https://tioplus.app/pelicula/inception-2010")).toBe(false);
    });
  });

  describe("2. Detección de URLs firmadas y vencidas con s=<epoch>&e=<ttl> (checkUrlExpiry)", () => {
    it("debe calcular expiración (s + e)*1000 y detectar si está vencida", () => {
      // s = 1787608019 (2026-08-24T21:46:59Z), e = 129600 (36 horas) -> expira 2026-08-26T09:46:59Z
      // fixedNow es 2026-09-01T20:00:00Z -> vencida!
      const expiredAcek =
        "https://yXqC9C2Vqj7VEPBl.acek-cdn.com/hls2/01/08557/vplf3hxobboq_,l,n,h,.urlset/master.m3u8?t=XYZ123&s=1787608019&e=129600&sp=1";

      const res = checkUrlExpiry(expiredAcek, fixedNow);
      expect(res.isSigned).toBe(true);
      expect(res.isExpired).toBe(true);
      expect(res.expiresAt).toBe((1787608019 + 129600) * 1000);
    });

    it("debe detectar como vigente una URL con s+e que expire en el futuro", () => {
      const nowEpochSec = Math.floor(fixedNow / 1000);
      const futureUrl = `https://wt4PjIIVE9AGjPL.dramiyos-cdn.com/hls2/01/08557/oj9g4slz0oo6_,l,n,h,.urlset/master.m3u8?s=${nowEpochSec}&e=86400&token=abc`;

      const res = checkUrlExpiry(futureUrl, fixedNow);
      expect(res.isSigned).toBe(true);
      expect(res.isExpired).toBe(false);
      expect(res.expiresAt).toBe((nowEpochSec + 86400) * 1000);
    });

    it("debe detectar URLs Vimeos y Goodstream con firma s+e vencida", () => {
      const vimeosUrl =
        "https://s1.vimeos.net/hls2/03/00012/myaqf6eoprzq_,n,h,.urlset/master.m3u8?t=-QW1&s=1786000000&e=7200";
      const res = checkUrlExpiry(vimeosUrl, fixedNow);
      expect(res.isSigned).toBe(true);
      expect(res.isExpired).toBe(true);
    });

    it("no debe marcar como firmadas URLs directas sin parámetros de firma o expiración", () => {
      const directClean =
        "https://cdn3.turboviplay.com/data3/6a8fe139a390f/6a8fe139a390f.m3u8";
      const res = checkUrlExpiry(directClean, fixedNow);
      expect(res.isSigned).toBe(false);
      expect(res.isExpired).toBe(false);
    });
  });

  describe("3. Clasificación exacta en las 7 categorías requeridas (classifySourceLink)", () => {
    it("clasifica como invalid_catalog_page", () => {
      const result = classifySourceLink(
        "https://www.cinecalidad.am/page/1/",
        "embed",
        "cinecalidad.am",
        fixedNow
      );
      expect(result.category).toBe("invalid_catalog_page");
      expect(result.isCatalogPage).toBe(true);
    });

    it("clasifica como canonical_page", () => {
      const r1 = classifySourceLink(
        "https://lamovie.org/peliculas/bloodshot-2020/",
        "embed",
        "lamovie.org",
        fixedNow
      );
      expect(r1.category).toBe("canonical_page");

      const r2 = classifySourceLink(
        "https://www.cinecalidad.am/ver-pelicula/intriga-internacional/",
        "embed",
        "cinecalidad.am",
        fixedNow
      );
      expect(r2.category).toBe("canonical_page");

      const r3 = classifySourceLink(
        "https://www.cinecalidad.am/ver-el-episodio/bodas-s-a-1x2/",
        "embed",
        "cinecalidad.am",
        fixedNow
      );
      expect(r3.category).toBe("canonical_page");
    });

    it("clasifica como canonical_embed", () => {
      const r1 = classifySourceLink("https://voe.sx/e/abcdef123", "embed", "lamovie.org", fixedNow);
      expect(r1.category).toBe("canonical_embed");

      const r2 = classifySourceLink("https://doodstream.com/e/x9z1a2b3", "embed", "tioplus.app", fixedNow);
      expect(r2.category).toBe("canonical_embed");

      const r3 = classifySourceLink("https://videoapp.zip/e/movie/1516698", "embed", "cinecalidad.am", fixedNow);
      expect(r3.category).toBe("canonical_embed");

      const r4 = classifySourceLink("https://goodstream.one/embed-pycpj9jk1jfj.html", "embed", "cinecalidad.am", fixedNow);
      expect(r4.category).toBe("canonical_embed");

      const r5 = classifySourceLink("https://vidhideplus.com/v/998877", "embed", "tioplus.app", fixedNow);
      expect(r5.category).toBe("canonical_embed");
    });

    it("clasifica como stable_direct", () => {
      const r1 = classifySourceLink(
        "https://cdn3.turboviplay.com/data3/6a8fe139a390f/6a8fe139a390f.m3u8",
        "direct",
        "tioplus.app",
        fixedNow
      );
      expect(r1.category).toBe("stable_direct");
      expect(r1.isExpired).toBe(false);
    });

    it("clasifica como active_ephemeral_direct una firma sin expiración explícita vencida", () => {
      const active = classifySourceLink(
        "https://edge.acek-cdn.com/hls/master.m3u8?t=opaque-token",
        "direct",
        "tioplus.app",
        fixedNow
      );
      expect(active.category).toBe("active_ephemeral_direct");
      expect(active.isExpired).toBe(false);
      expect(active.expiresAt).toBeUndefined();
    });

    it("clasifica como expired_ephemeral_direct para HLS/MP4 firmados con s+e vencido", () => {
      const r1 = classifySourceLink(
        "https://yXqC9C2Vqj7VEPBl.acek-cdn.com/hls2/01/08557/vplf3hxobboq_,l,n,h,.urlset/master.m3u8?s=1787608019&e=129600&sp=1",
        "direct",
        "tioplus.app",
        fixedNow
      );
      expect(r1.category).toBe("expired_ephemeral_direct");
      expect(r1.isExpired).toBe(true);

      const r2 = classifySourceLink(
        "https://s1.vimeos.net/hls2/03/00012/myaqf6eoprzq_,n,h,.urlset/master.m3u8?t=-QW1&s=1786000000&e=7200",
        "direct",
        "cinecalidad.am",
        fixedNow
      );
      expect(r2.category).toBe("expired_ephemeral_direct");
      expect(r2.isExpired).toBe(true);

      const r3 = classifySourceLink(
        "https://enc11.goodstream.one/hls2/01/00100/pycpj9jk1jfj_,l,n,h,.urlset/master.m3u8?s=1786000000&e=3600",
        "direct",
        "lamovie.org",
        fixedNow
      );
      expect(r3.category).toBe("expired_ephemeral_direct");
      expect(r3.isExpired).toBe(true);
    });

    it("clasifica como unknown para strings vacíos o URLs inválidas", () => {
      expect(classifySourceLink("").category).toBe("unknown");
      expect(classifySourceLink("not-a-url").category).toBe("unknown");
      expect(classifySourceLink("ftp://invalid-domain.xyz").category).toBe("unknown");
    });
  });

  describe("4. Sanitización estricta de credenciales y query strings (sanitizeUrlForReport)", () => {
    it("elimina tokens, firmas s, e y parámetros de consulta", () => {
      const raw =
        "https://acek-cdn.com/hls/master.m3u8?s=1787608019&e=129600&token=SUPER_SECRET_TOKEN_12345&sig=abcde";
      const sanitized = sanitizeUrlForReport(raw);

      expect(sanitized).not.toContain("SUPER_SECRET_TOKEN_12345");
      expect(sanitized).not.toContain("1787608019");
      expect(sanitized).not.toContain("129600");
      expect(sanitized).not.toContain("abcde");
      expect(sanitized).toBe("https://acek-cdn.com/hls/master.m3u8?[QUERY_STRIPPED]");
    });

    it("conserva URLs limpias intactas sin alteración", () => {
      const clean = "https://lamovie.org/peliculas/bloodshot-2020/";
      expect(sanitizeUrlForReport(clean)).toBe(clean);
    });
  });

  describe("5. Generación de reporte Markdown seguro", () => {
    it("genera Markdown con todas las secciones obligatorias sin filtrar credenciales", () => {
      const mockReport: SourceLinkAuditReport = {
        timestamp: "2026-09-01T20:00:00.000Z",
        target_sites: ["tioplus.app", "lamovie.org", "cinecalidad.am"],
        summary: {
          total_links_audited: 6164,
          total_episodes_audited: 5800,
          categories: {
            canonical_page: 5571,
            canonical_embed: 239,
            stable_direct: 24,
            active_ephemeral_direct: 0,
            expired_ephemeral_direct: 329,
            invalid_catalog_page: 1,
            unknown: 0,
          },
          total_requiring_canonical_reconstruction: 330,
        },
        providers: {
          "tioplus.app": {
            provider: "tioplus.app",
            total_links: 348,
            by_category: {
              canonical_page: 0,
              canonical_embed: 61,
              stable_direct: 24,
              active_ephemeral_direct: 0,
              expired_ephemeral_direct: 263,
              invalid_catalog_page: 0,
              unknown: 0,
            },
            invalid_catalog_urls_count: 0,
            expired_ephemeral_direct_count: 263,
            sources_requiring_canonical_reconstruction: 263,
            episodes_with_sister_canonical_page: 0,
            episodes_with_sister_embed: 61,
            episodes_without_any_valid_source: 202,
          },
          "lamovie.org": {
            provider: "lamovie.org",
            total_links: 5456,
            by_category: {
              canonical_page: 5280,
              canonical_embed: 136,
              stable_direct: 0,
              active_ephemeral_direct: 0,
              expired_ephemeral_direct: 40,
              invalid_catalog_page: 0,
              unknown: 0,
            },
            invalid_catalog_urls_count: 0,
            expired_ephemeral_direct_count: 40,
            sources_requiring_canonical_reconstruction: 40,
            episodes_with_sister_canonical_page: 40,
            episodes_with_sister_embed: 0,
            episodes_without_any_valid_source: 0,
          },
          "cinecalidad.am": {
            provider: "cinecalidad.am",
            total_links: 360,
            by_category: {
              canonical_page: 291,
              canonical_embed: 42,
              stable_direct: 0,
              active_ephemeral_direct: 0,
              expired_ephemeral_direct: 26,
              invalid_catalog_page: 1,
              unknown: 0,
            },
            invalid_catalog_urls_count: 1,
            expired_ephemeral_direct_count: 26,
            sources_requiring_canonical_reconstruction: 27,
            episodes_with_sister_canonical_page: 26,
            episodes_with_sister_embed: 0,
            episodes_without_any_valid_source: 1,
          },
        },
        action_plan: [
          {
            id: "PLAN-01",
            provider: "tioplus.app",
            severity: "high",
            action: "Reconstruir catálogo canónico",
            rationale: "Streams efímeros vencidos sin URL de detalle",
            affected_count: 263,
            execution_safety: "manual_approval_required",
            steps: ["Paso 1: Scrapear", "Paso 2: Reimportar"],
          },
        ],
        sanitized_samples: [
          {
            provider: "tioplus.app",
            category: "expired_ephemeral_direct",
            sanitized_url: "https://acek-cdn.com/hls/master.m3u8?[QUERY_STRIPPED]",
            host: "acek-cdn.com",
          },
        ],
      };

      const md = generateMarkdownReport(mockReport);
      expect(md).toContain("# Reporte de Auditoría de SourceLinks — Meristream");
      expect(md).toContain("tioplus.app");
      expect(md).toContain("lamovie.org");
      expect(md).toContain("cinecalidad.am");
      expect(md).toContain("invalid_catalog_page");
      expect(md).toContain("Fuentes que deben reconstruirse desde página canónica");
      expect(md).toContain("[QUERY_STRIPPED]");
      expect(md).not.toContain("token=");
      expect(md).not.toContain("jwt=");
    });
  });
});
