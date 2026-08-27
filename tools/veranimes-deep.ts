// Investigar qué servidores devuelve VerAnimes realmente (fluxo /process)
import { VerAnimesAdapter } from "../server/scrapers/adapters/VerAnimesAdapter";

const a = new VerAnimesAdapter();

async function hexToAscii(hex: string) {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
}

(async () => {
  const url = "https://wwv.veranimes.net/ver/kuroneko-to-majo-no-kyoushitsu-1";
  console.log("URL:", url);

  const html = await (a as any).fetchHtml(url, 15000);
  console.log("HTML length:", html?.length || 0);

  // Ver data-encrypt
  const encMatches = html.match(/data-encrypt="([^"]+)"/gi) || [];
  console.log("\ndata-encrypt encontrados:", encMatches.length);
  encMatches.forEach((m) => console.log("  ", m));

  // Ver <ul opt> con data-encrypt
  const opt = html.match(/<ul[^>]+class="opt"[^>]*data-encrypt="([^"]+)"/i);
  console.log("\n<ul class=opt data-encrypt>: ", opt ? opt[1] : "NO");

  // Decodificar
  if (opt) {
    const idHex = opt[1];
    console.log("  idHex:", idHex, "→ ascii:", hexToAscii(idHex));
  }

  // Llamar resolveServerButtons
  const buttons = await a.resolveServerButtons(url);
  console.log("\nresolveServerButtons devolvió", buttons.length, "URLs:");
  buttons.forEach((b) => console.log("  ", b.slice(0, 120)));

  // extractStream final
  const r = await a.extractStream(url);
  console.log("\nextractStream:");
  console.log("  stream_url:", r.stream_url);
  console.log("  todos:", r.all_available_streams.length);
  r.all_available_streams.forEach((s) => console.log("    ", s.slice(0, 120)));
})();