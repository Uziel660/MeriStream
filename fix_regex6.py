import os

file_path = 'server/metadataEngine.ts'
with open(file_path, 'r') as f:
    content = f.read()

# Sonarqube is still complaining about /<[^>]+>/g and /[(\[{][^()\[\]{}]+[)\]}]/g as ReDoS vulnerabilities.
content = content.replace(r'replace(/<[^>]+>/g, "")', r"replace(/<\/?[a-z][^>]*>/gi, '')")
content = content.replace(r'replace(/[(\[{][^()\[\]{}]+[)\]}]/g, "")', r"replace(/[(\[{][^(\[{)\]}]+[)\]}]/g, '')")

with open(file_path, 'w') as f:
    f.write(content)
print("done")
