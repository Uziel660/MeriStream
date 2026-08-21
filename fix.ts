import fs from "fs";

let code = fs.readFileSync("server.ts", "utf-8");

// Add imports
code = code.replace(
  'import { prisma } from "./server/db";',
  'import { prisma } from "./server/db";\nimport { isIP } from "net";\nimport dns from "node:dns/promises";'
);

// Replace vulnerable check
const oldCheck = `      const hostname = parsedUrl.hostname.toLowerCase();
      const isPrivate =
        hostname === "localhost" ||
        hostname.endsWith(".local") ||
        hostname.includes("::") ||
        hostname.startsWith("127.") ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        hostname.startsWith("169.254.") ||
        hostname.startsWith("0.") ||
        (hostname.startsWith("172.") && (() => { const p = parseInt(hostname.split(".")[1], 10); return p >= 16 && p <= 31; })());`;

const newCheck = `      const hostname = parsedUrl.hostname.toLowerCase();
      let isPrivate = hostname === "localhost" || hostname.endsWith(".local");

      if (!isPrivate) {
        let resolvedIps: string[] = [];
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
            return res.status(400).json({ detail: "Host no resuelto o invalido" });
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
            isPrivate = true;
            break;
          }
        }
      }`;

code = code.replace(oldCheck, newCheck);
fs.writeFileSync("server.ts", code);
