import os

file_path = 'server/metadataEngine.ts'
with open(file_path, 'r') as f:
    content = f.read()

# Fix the regex parse error in typescript
content = content.replace(r'.replace(/<[^>]*>/g, "")', r'.replace(/<[^>]+>/g, "")')
content = content.replace(r'.replace(/</?[a-z][a-z0-9]*(?:[ \t\n]+[a-z0-9-]+[ \t\n]*=[ \t\n]*(?:"[^"]*"|\'[^\']*\'|[^ >]+))*[ \t\n]*/?/?>/gi, "")', r'.replace(/<[^>]+>/g, "")')

with open(file_path, 'w') as f:
    f.write(content)
print("done")
