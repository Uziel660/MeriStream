// Standalone, sin imports del server. Headers hardcodeados.
import fs from "fs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

async function fetchRaw(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: HEADERS, redirect: "follow" });
    clearTimeout(timer);
    const text = await res.text();
    return { status: res.status, finalUrl: res.url, len: text.length, text };
  } catch (e: any) {
    clearTimeout(timer);
    return { status: -1, error: String(e && e.message || e), len: 0, text: "" };
  }
}

(async () => {
  const urls = [
    ["tubepelis", "https://www.tubepelis.com/pelicula/4491/supergirl-woman-of-tomorrow.html"],
    ["tubepelis-home", "https://www.tubepelis.com/"],
    ["veranimes", "https://wwv.veranimes.net/ver/kuroneko-to-majo-no-kyoushitsu-1"],
    ["veranimes-home", "https://wwv.veranimes.net/"],
  ];
  const out: string[] = [];
  for (const [label, url] of urls) {
    out.push(`\n=== ${label}: ${url}`);
    const r = await fetchRaw(url, 16000);
    out.push(`  status=${r.status} len=${r.len} final=${r.finalUrl}`);
    if (r.error) { out.push(`  ERROR: ${r.error}`); continue; }
    const tm = r.text.match(/<title[^>]*>([^<]*)<\/title>/i);
    out.push(`  title=${tm ? tm[1].slice(0,90) : "sin-title"}`);
    const h1 = r.text.match(/<h1[^>]*>([^<]*?<[^>]*>[^<]*|[^<]*)<\/h1>/i);
    if (h1) out.push(`  h1=${h1[1].replace(/<[^>]+>/g,"").trim().slice(0,90)}`);
    const ifr = r.text.match(/<iframe[^>]*src=["']([^"']+)["']/i);
    out.push(`  iframe=${ifr ? ifr[1].slice(0,100) : "no"}`);
    const repro = r.text.match(/reproductor\.php[^"'\s]*/i);
    out.push(`  reproductor.php=${repro ? repro[0].slice(0,100) : "no"}`);
    const encrypt = r.text.match(/(?:data-)?encrypt[=:\s]["']?([^"'\s]+)/i);
    out.push(`  encrypt=${encrypt ? encrypt[1].slice(0,100) : "no"}`);
    const dataVideo = r.text.match(/data-video[=:\s]["']?([^"'\s]+)/i);
    out.push(`  data-video=${dataVideo ? dataVideo[1].slice(0,100) : "no"}`);
    const dataSl = r.text.match(/data-sl[=:\s]["']?([^"'\s]+)/i);
    out.push(`  data-sl=${dataSl ? dataSl[1].slice(0,100) : "no"}`);
  }
  fs.writeFileSync("nettest.txt", out.join("\n"));
  console.log("done");
})();