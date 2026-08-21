import fs from "fs";

let code = fs.readFileSync("server.ts", "utf-8");

const handleProxyFunction = `async function handleProxyStream(req: Request, res: Response) {
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



      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: referer,
        },
      });`;

const replacedFunction = `async function handleProxyStream(req: Request, res: Response) {
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

    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: referer,
      },
    });`;

code = code.replace(handleProxyFunction, replacedFunction);
fs.writeFileSync("server.ts", code);
