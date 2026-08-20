import os

# 8. Do not log user-controlled data in showService.ts
with open('server/showService.ts', 'r') as f:
    content = f.read()
content = content.replace("console.log(`[Deduplication] Nueva obra verificada sin duplicados: '${showData.title}'. Guardando en PostgreSQL...`);", "console.log(`[Deduplication] Nueva obra verificada sin duplicados. Guardando en PostgreSQL...`);")
with open('server/showService.ts', 'w') as f:
    f.write(content)

# 9. If statement should not be the only statement in else block in router.ts line 88
with open('server/router.ts', 'r') as f:
    content = f.read()
content = content.replace("""        } else {
          if (!["recaptcha", "google", "analytics", "adservice"].some((bad) => lowered.includes(bad))) {
            genericTargets.push(srcClean);
          }
        }""", """        } else if (!["recaptcha", "google", "analytics", "adservice"].some((bad) => lowered.includes(bad))) {
          genericTargets.push(srcClean);
        }""")
with open('server/router.ts', 'w') as f:
    f.write(content)

print("done")
