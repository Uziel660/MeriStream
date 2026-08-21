import { isIP } from "net";
import dns from "node:dns/promises";

async function isPrivateUrl(targetUrl: string): Promise<boolean> {
  try {
    const parsedUrl = new URL(targetUrl);
    const hostname = parsedUrl.hostname.toLowerCase();

    // Quick check for obvious local hostnames
    if (hostname === "localhost" || hostname.endsWith(".local")) {
      return true;
    }

    let resolvedIps: string[] = [];

    if (isIP(hostname)) {
      resolvedIps = [hostname];
    } else {
      try {
        const lookup = await dns.lookup(hostname, { all: true });
        resolvedIps = lookup.map(res => res.address);
      } catch (e) {
        // If we can't resolve it, fail closed or open? Let's say we just throw or return false.
        // Actually, if we can't resolve it, fetch won't be able to either.
        return true; // safer to reject
      }
    }

    for (const ip of resolvedIps) {
      if (
        ip === "::1" ||
        ip.includes("::") ||
        ip.startsWith("127.") ||
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        ip.startsWith("169.254.") ||
        ip.startsWith("0.") ||
        (ip.startsWith("172.") && (() => { const p = parseInt(ip.split(".")[1], 10); return p >= 16 && p <= 31; })())
      ) {
        return true;
      }
    }

    return false;
  } catch (err) {
    return true; // Invalid URL
  }
}

async function run() {
  console.log(await isPrivateUrl("http://localhost"));
  console.log(await isPrivateUrl("http://127.0.0.1"));
  console.log(await isPrivateUrl("http://localtest.me"));
  console.log(await isPrivateUrl("http://google.com"));
  console.log(await isPrivateUrl("http://10.0.0.1"));
  console.log(await isPrivateUrl("http://192.168.1.1"));
  console.log(await isPrivateUrl("http://172.16.0.1"));
  console.log(await isPrivateUrl("http://[::1]"));
}
run();
