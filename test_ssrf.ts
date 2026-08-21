import dns from "node:dns/promises";

async function checkHost(targetUrl: string) {
  try {
    const parsedUrl = new URL(targetUrl);
    const hostname = parsedUrl.hostname.toLowerCase();

    let resolvedIp = hostname;
    try {
      const lookupResult = await dns.lookup(hostname);
      resolvedIp = lookupResult.address;
    } catch (err) {
      console.log(`${targetUrl} - Failed to resolve`);
      return;
    }

    const checkIp = resolvedIp;

    const isPrivate =
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      checkIp.includes("::") ||
      checkIp.startsWith("127.") ||
      checkIp.startsWith("10.") ||
      checkIp.startsWith("192.168.") ||
      checkIp.startsWith("169.254.") ||
      checkIp.startsWith("0.") ||
      (checkIp.startsWith("172.") && (() => { const p = parseInt(checkIp.split(".")[1], 10); return p >= 16 && p <= 31; })());

    console.log(`${targetUrl} -> IP: ${checkIp} -> isPrivate: ${isPrivate}`);
  } catch (err) {
    console.error(err);
  }
}

async function run() {
  await checkHost("http://localhost");
  await checkHost("http://127.0.0.1");
  await checkHost("http://10.0.0.1");
  await checkHost("http://localtest.me");
  await checkHost("http://google.com");
}
run();
