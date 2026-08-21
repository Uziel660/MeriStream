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

    // Using string stripping to handle brackets [::1]
    let cleanHostname = hostname;
    if (cleanHostname.startsWith("[") && cleanHostname.endsWith("]")) {
      cleanHostname = cleanHostname.slice(1, -1);
    }

    if (isIP(cleanHostname)) {
      resolvedIps = [cleanHostname];
    } else {
      try {
        const lookup = await dns.lookup(cleanHostname, { all: true });
        resolvedIps = lookup.map(res => res.address);
      } catch (e) {
        return true;
      }
    }

    for (const ip of resolvedIps) {
      if (
        ip === "::1" ||
        ip.startsWith("fe80:") ||
        ip.startsWith("fc00:") ||
        ip.startsWith("fd00:") ||
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
  console.log("localhost", await isPrivateUrl("http://localhost"));
  console.log("localtest.me", await isPrivateUrl("http://localtest.me"));
  console.log("[::1]", await isPrivateUrl("http://[::1]"));
}
run();
