import fs from "fs";

let code = fs.readFileSync("server.ts", "utf-8");

// Fix 1: Cognitive complexity in line 250 -> Refactor into a separate function
const functionToExtract = `app.get("/api/v1/proxy/stream", async (req: Request, res: Response) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    const referer = typeof req.query.referer === "string" ? req.query.referer : "https://animeflv.net/";

    if (!targetUrl) {
      return res.status(400).json({ detail: "URL requerida" });
    }

    try {
      const parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return res.status(400).json({ detail: "Protocolo no permitido" });
      }

      const hostname = parsedUrl.hostname.toLowerCase();
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
          const isLocalIPv6 = ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd00:");
          const isLocalIPv4 = ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.") || ip.startsWith("0.");

          let isLocal172 = false;
          if (ip.startsWith("172.")) {
            const parts = ip.split(".");
            if (parts.length > 1) {
              const p = parseInt(parts[1], 10);
              isLocal172 = p >= 16 && p <= 31;
            }
          }

          if (isLocalIPv6 || isLocalIPv4 || isLocal172) {
            isPrivate = true;
            break;
          }
        }
      }

      if (isPrivate) {
        return res.status(400).json({ detail: "Host no permitido" });
      }`;

const newExtractedFunction = `
async function isPrivateIP(hostname: string): Promise<{ isPrivate: boolean, error?: string }> {
  let isPrivate = hostname === "localhost" || hostname.endsWith(".local");
  if (isPrivate) return { isPrivate: true };

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
    } catch (e: any) {
      return { isPrivate: true, error: "Host no resuelto o invalido" };
    }
  }

  for (const ip of resolvedIps) {
    const isLocalIPv6 = ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd00:");
    const isLocalIPv4 = ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("169.254.") || ip.startsWith("0.");

    let isLocal172 = false;
    if (ip.startsWith("172.")) {
      const parts = ip.split(".");
      if (parts.length > 1) {
        const p = parseInt(parts[1], 10);
        isLocal172 = p >= 16 && p <= 31;
      }
    }

    if (isLocalIPv6 || isLocalIPv4 || isLocal172) {
      isPrivate = true;
      break;
    }
  }
  return { isPrivate };
}

async function handleProxyStream(req: Request, res: Response) {
  const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
  const referer = typeof req.query.referer === "string" ? req.query.referer : "https://animeflv.net/";

  if (!targetUrl) {
    return res.status(400).json({ detail: "URL requerida" });
  }

  try {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return res.status(400).json({ detail: "Protocolo no permitido" });
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const { isPrivate, error } = await isPrivateIP(hostname);
    if (error) {
      return res.status(400).json({ detail: error });
    }

    if (isPrivate) {
      return res.status(400).json({ detail: "Host no permitido" });
    }
`;

const proxyRoute = `app.get("/api/v1/proxy/stream", handleProxyStream);`;

const finalReplace = proxyRoute + "\n" + newExtractedFunction;

code = code.replace(functionToExtract, newExtractedFunction + "\n      ");
code = code.replace(`app.get("/api/v1/proxy/stream", async (req: Request, res: Response) => {`, proxyRoute + `\n\nasync function handleProxyStream(req: Request, res: Response) {`);

fs.writeFileSync("server.ts", code);
