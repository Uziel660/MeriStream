import re
import os

with open('server/metadataEngine.ts', 'r') as f:
    lines = f.readlines()

for i in range(len(lines)):
    if ".replace(/" in lines[i] and "?[a-z][a-z0-9]" in lines[i]:
        # Very aggressive replacement
        lines[i] = re.sub(r'\.replace\(/<\/\?\[a-z\]\[a-z0-9\].*?\/gi,\s*""\)', '.replace(/<[^>]+>/g, "")', lines[i])

with open('server/metadataEngine.ts', 'w') as f:
    f.writelines(lines)
