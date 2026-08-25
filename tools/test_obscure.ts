// test_obscure.ts — prueba real de los resolvers Hexload y Bysekoze
import { resolveBysekoze, resolveHexload } from "./server/scrapers/utils/obscureResolvers";
import { EmbedResolvers } from "./server/resolvers";

const TARGETS = [
  { name: "Bysekoze", url: "https://bysekoze.com/e/c8k9c70sbcqo", fn: resolveBysekoze },
  { name: "Hexload", url: "https://hexload.com/embed-ljdm74uwp", fn: resolveHexload },
] as const;

async function main() {
  for (const target of TARGETS) {
    console.log(`\n=== ${target.name}: ${target.url} ===`);
    const t0 = Date.now();
    try {
      const result = await target.fn(target.url);
      console.log("obscureResolvers:", JSON.stringify(result, null, 2));
      console.log(`-> obscure: ${result.type.toUpperCase()} | ${Date.now() - t0}ms`);

      // Resolución final por el pipeline oficial (incluye descifrado AES-256-GCM en hosts Byse)
      const t1 = Date.now();
      const resolved = await EmbedResolvers.resolve(target.url);
      const isDirect = resolved !== target.url && /\.(m3u8|mp4|webm)(\?|$)/i.test(resolved);
      console.log(`EmbedResolvers.resolve -> ${isDirect ? "DIRECTO" : "EMBED (fallback)"}`);
      console.log(`   ${resolved}`);
      console.log(`-> pipeline total: ${Date.now() - t1}ms`);
    } catch (err) {
      console.error("!! EXCEPCIÓN ESCAPADA DEL RESOLVER:", err);
    }
  }
}

main().catch((err) => {
  console.error("Fallo fatal del script:", err);
  process.exit(1);
});
