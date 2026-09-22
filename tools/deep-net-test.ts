// Diagnóstico: qué devuelven los sitios reales. Salida ASCII pura.
import { COMMON_HEADERS } from "../server/scrapers/BaseAdapter";

async function fetchRaw(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: COMMON_HEADERS, redirect: "follow" });
    clearTimeout(timer);
    const text = await res.text();
    return { status: res.status, finalUrl: res.url, len: text.length, text };
  } catch (e: any) {
    clearTimeout(timer);
    return { status: -1, error: String(e.message), len: 0, text: "" };
  }
}

const results: string[] = [];

(async () => {
  const TUBEPELIS = [
    "https://www.tubepelis.com/pelicula/4491/supergirl-woman-of-tomorrow.html",
    "https://tubepelis.com/pelicula/4491/supergirl-woman-of-tomorrow.html",
    "https://www.tubepelis.com/",
  ];
  const VERANIMES = [
    "https://wwv.veranimes.net/ver/kuroneko-to-majo-no-kyoushitsu-1",
    "https://wwv.veranimes.net/",
  ];

  for (const url of TUBEPELIS) {
    results.push(`\n=== TUBEPELIS: ${url}`);
    const r = await fetchRaw(url, 15000);
    results.push(`  status=${r.status} finalUrl=${r.finalUrl} len=${r.len}`);
    if (r.error) { results.push(`  ERROR: ${r.error}`); continue; }
    const tm = r.text.match(/<title[^>]*>([^<]*)<\/title>/i);
    results.push(`  <title>: ${tm ? tm[1].slice(0, 90) : "(sin title)"}`);
    const embed = r.text.match(/reproductor\.php[^"'\s]*/i);
    results.push(`  reproductor.php: ${embed ? embed[0].slice(0, 100) : "NO"}`);
    const iframe = r.text.match(/<iframe[^>]*src=["']([^"']+)["']/i);
    results.push(`  iframe src: ${iframe ? iframe[1].slice(0, 100) : "NO"}`);
    const dataSrc = r.text.match(/data-src=["']([^"']+)["']/i);
    results.push(`  data-src: ${dataSrc ? dataSrc[1].slice(0, 100) : "NO"}`);
  }

  for (const url of VERANIMES) {
    results.push(`\n=== VERANIMES: ${url}`);
    const r = await fetchRaw(url, 15000);
    results.push(`  status=${r.status} finalUrl=${r.finalUrl} len=${r.len}`);
    if (r.error) { results.push(`  ERROR: ${r.error}`); continue; }
    const tm = r.text.match(/<title[^>]*>([^<]*)<\/title>/i);
    results.push(`  <title>: ${tm ? tm[1].slice(0, 90) : "(sin title)"}`);
    const eps = r.text.match(/var\s+eps?\s*=\s*\[/);
    results.push(`  var eps: ${eps ? "SI" : "NO"}`);
    const dataSl = r.text.match(/data-sl=("[^"]*"|'[^']*')/);
    results.push(`  data-sl: ${dataSl ? dataSl[0].slice(0, 100) : "NO"}`);
    const encrypt = r.text.match(/(?:encrypt|data-encrypt|data-video)["']?[=:\s]["']?([^"'\s]+)/i);
    results.push(`  encrypt/data-video: ${encrypt ? encrypt[1].slice(0, 100) : "NO"}`);
    const iframe = r.text.match(/<iframe[^>]*>/i);
    results.push(`  <iframe>: ${iframe ? "SI" : "NO"}`);
  }

  const fs = await import("fs");
  fs.writeFileSync("nettest.txt", results.join("\n"));
  console.log("RESULTADO ESCRITO A nettest.txt");
})();