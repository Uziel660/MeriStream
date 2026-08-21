import { execSync } from "child_process";

try {
  execSync('git add server.ts');
  execSync('git commit -m "🔒 Fix SSRF vulnerability in Proxy Endpoint"');
  console.log("Committed");
} catch (e) {
  console.error(e.message);
}
