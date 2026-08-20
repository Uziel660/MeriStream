import os

# 1. Unused import StrategyRouter in universalScraper.ts
with open('server/universalScraper.ts', 'r') as f:
    content = f.read()
content = content.replace('import { StrategyRouter } from "./router";\n', '')
with open('server/universalScraper.ts', 'w') as f:
    f.write(content)

# 2. Prefer optional chaining in taskWorker.ts lines 366, 396, 459, 482
with open('server/taskWorker.ts', 'r') as f:
    content = f.read()
content = content.replace("if (!checkJob || checkJob.status !== \"running\") return;", "if (checkJob?.status !== \"running\") return;")
content = content.replace("if (!checkLoop || checkLoop.status !== \"running\") return;", "if (checkLoop?.status !== \"running\") return;")
content = content.replace("if (!checkInner || checkInner.status !== \"running\") return;", "if (checkInner?.status !== \"running\") return;")
content = content.replace("if (!checkActive || checkActive.status !== \"running\") return;", "if (checkActive?.status !== \"running\") return;")
with open('server/taskWorker.ts', 'w') as f:
    f.write(content)

# 3. Prefer optional chaining in showService.ts lines 123
with open('server/showService.ts', 'r') as f:
    content = f.read()
content = content.replace("if (ep && ep.url) {", "if (ep?.url) {")
content = content.replace("if (ep && ep.source_url) {", "if (ep?.source_url) {")
with open('server/showService.ts', 'w') as f:
    f.write(content)

# 4. Prefer optional chaining in router.ts line 39
with open('server/router.ts', 'r') as f:
    content = f.read()
content = content.replace("return Boolean(parsed.hostname && parsed.hostname.includes(\".\"));", "return Boolean(parsed.hostname?.includes(\".\"));")
with open('server/router.ts', 'w') as f:
    f.write(content)

print("done")
