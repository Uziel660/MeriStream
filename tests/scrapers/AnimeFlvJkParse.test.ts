import { describe, it, expect } from "vitest";
import { AnimeFlvAdapter } from "../../server/scrapers/adapters/AnimeFlvAdapter";

/**
 * Fixture inline mínimo y realista de https://jkanime.net/.../1/
 * Cubre:
 *  - var servers base64 (8 entradas)
 *  - wrappers jkplayer um / umv
 *  - plantilla vacía jkplayer/c1?u= (debe ignorarse)
 *  - hosts muertos (streamtape, d-s.io) presentes en base64 pero filtrados en resolveCandidates
 *
 * La plantilla vacía aparece tanto en iframe DOM como en strings JS y como URL suelta;
 * parseJkanimeServers debe descartarla con los filtros `?u=$` / `&u=$`.
 * No depende de archivo en Temp ni estado externo.
 */
const JK_EPISODE_HTML = `<!DOCTYPE html>
<html><head>
<meta property="og:title" content="Sousou no Frieren 1">
</head><body>
<div id="player"></div>
<script>
var servers = [
  {"remote":"aHR0cHM6Ly9tZWdhLm56L2VtYmVkL1E3VVNSRGlU","server":"mega"},
  {"remote":"aHR0cHM6Ly9zZmFzdHdpc2guY29tL2UvcHBnb3NnNTZpeWlw","server":"sfastwish"},
  {"remote":"aHR0cHM6Ly92b2Uuc3gvZS9tM2ppZGtzamFxNXk=","server":"voe"},
  {"remote":"aHR0cHM6Ly92aWRoaWRldmlwLmNvbS9lbWJlZC9scTRrdGpsM3N4bmI=","server":"vidhidevip"},
  {"remote":"aHR0cHM6Ly9tZHk0OHRuOTcuY29tL2UvenAzbm9vdmxoOTRrNnc=","server":"mdy"},
  {"remote":"aHR0cHM6Ly93d3cubXA0dXBsb2FkLmNvbS9lbWJlZC11Y3pndjRibm1waHcuaHRtbA==","server":"mp4upload"},
  {"remote":"aHR0cHM6Ly9zdHJlYW10YXBlLmNvbS9lL1dYa1IwSm9heVBVYmpQaw==","server":"streamtape"},
  {"remote":"aHR0cHM6Ly9kLXMuaW8vZS94aXVidXFueGswMGQ=","server":"d-s"}
];
var episode = 1;
</script>
<div class="player-frame">
  <iframe src="https://jkanime.net/jkplayer/um?e=um_dom_abc123"></iframe>
  <iframe src="https://jkanime.net/jkplayer/umv?e=umv_dom_def456"></iframe>
  <iframe src="https://jkanime.net/jkplayer/c1?u="></iframe>
</div>
<script>
  var video = [];
  video[0] = '<iframe src="https://jkanime.net/jkplayer/um?token=xyz_js">';
  video[1] = '<iframe src="https://jkanime.net/jkplayer/umv?token=uvw_js">';
  video[2] = '<iframe src="https://jkanime.net/jkplayer/c1?u=">';
  var directUm = "https://jkanime.net/jkplayer/um?direct=1";
  var directUmv = "https://jkanime.net/jkplayer/umv?direct=2";
  var plantillaSuelta = "https://jkanime.net/jkplayer/c1?u=";
  var concatPlantilla = 'https://jkanime.net/jkplayer/c1?u='+val.remote+'&s='+val.server;
</script>
</body></html>`;

describe("AnimeFlvAdapter.parseJkanimeServers (fixture inline jkanime ep1)", () => {
  const adapter = new AnimeFlvAdapter();
  const parse = (html: string) => (adapter as any).parseJkanimeServers(html) as string[];
  const resolve = (streams: string[]) => (adapter as any).resolveCandidates(streams) as Promise<{ directStreams: string[]; embedStreams: string[] }>;

  it("extrae base64 + wrappers um/umv y excluye plantilla vacía", () => {
    const streams = parse(JK_EPISODE_HTML);
    // console logs para diagnóstico verificable
    console.log(`streams=${streams.length}`);
    for (const s of streams) console.log(" *", s);

    // Base64 debe decodificar 8 hosts (incluidos streamtape/d-s que luego se filtran en resolveCandidates, no en parse)
    const expectedBase64Hosts = [
      "mega.nz/embed/Q7USRDiT",
      "sfastwish.com/e/ppgosg56iyip",
      "voe.sx/e/m3jidksjaq5y",
      "vidhidevip.com/embed/lq4ktjl3sxnb",
      "mdy48tn97.com/e/zp3noovlh94k6w",
      "www.mp4upload.com/embed-uczgv4bnmphw.html",
      "streamtape.com/e/WXkR0JoayPUbjPk",
      "d-s.io/e/xiubuqnxk00d",
    ];
    for (const host of expectedBase64Hosts) {
      expect(streams.some((u) => u.includes(host)), `debe incluir base64 ${host}`).toBe(true);
    }

    // Wrappers internos jkplayer um/umv deben estar presentes (dom + js)
    expect(streams.some((u) => /jkanime\.net\/jkplayer\/um\?/.test(u)), "debe incluir jkplayer/um").toBe(true);
    expect(streams.some((u) => /jkanime\.net\/jkplayer\/umv\?/.test(u)), "debe incluir jkplayer/umv").toBe(true);

    // Plantilla vacía c1?u= no debe aparecer (ni como iframe ni como URL suelta)
    expect(streams.some((u) => u.includes("/jkplayer/c1")), "no debe incluir plantilla /jkplayer/c1").toBe(false);
    expect(streams.some((u) => /[?&]u=$/.test(u)), "no debe incluir parámetro u vacío").toBe(false);

    // Total mínimo: 8 base64 + 2 wrappers únicos (um/umv deduplicados) >= 9 (con duplicados filtrados puede ser 10)
    expect(streams.length).toBeGreaterThanOrEqual(9);
  });

  it("NO incluye la plantilla jkplayer/c1?u= aunque aparezca en múltiples formas", () => {
    const streams = parse(JK_EPISODE_HTML);
    expect(streams.some((u) => u.includes("/jkplayer/c1"))).toBe(false);
    expect(streams.some((u) => /[?&]u=$/.test(u))).toBe(false);
  });

  it("resolveCandidates descarta hosts muertos/bloqueados (streamtape, d-s.io) y conserva funcionales", async () => {
    const streams = parse(JK_EPISODE_HTML);

    const stFake = streams.find((u) => u.includes("streamtape.com"));
    const dsFake = streams.find((u) => u.includes("d-s.io"));
    expect(stFake, "fixture debe contener streamtape en parse").toBeTruthy();
    expect(dsFake, "fixture debe contener d-s.io en parse").toBeTruthy();

    const { directStreams, embedStreams } = await resolve(streams);

    // Ambos hosts muertos deben haber sido filtrados (DEAD_OR_BLOCKED_HOST_PATTERNS)
    expect(embedStreams).not.toContain(stFake);
    expect(directStreams).not.toContain(stFake);
    expect(embedStreams).not.toContain(dsFake);
    expect(directStreams).not.toContain(dsFake);

    // Los streams funcionales se mantienen (mega, sfastwish, vidhide, mp4upload, voe, etc.)
    expect(directStreams.length + embedStreams.length).toBeGreaterThan(0);
    const hasFunctional = [...directStreams, ...embedStreams].some((u) =>
      /mega\.nz|sfastwish|vidhidevip|mp4upload|voe\.sx|jkanime\.net\/jkplayer\/um/i.test(u)
    );
    expect(hasFunctional, "al menos un host funcional debe permanecer").toBe(true);
  }, 60000);
});
