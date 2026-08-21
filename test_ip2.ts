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
        return true;
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
  console.log("google.com", await isPrivateUrl("http://google.com"));
  console.log("example.com", await isPrivateUrl("http://example.com"));
}
run();
