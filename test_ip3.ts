import { isIP } from "net";
import dns from "node:dns/promises";

async function run() {
  const lookup = await dns.lookup("google.com", { all: true });
  console.log(lookup);
}
run();
