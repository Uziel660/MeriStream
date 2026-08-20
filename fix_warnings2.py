import os
import re

# 5. RegExp matching empty string in resolvers.ts line 27
with open('server/resolvers.ts', 'r') as f:
    content = f.read()
# Reemplazar "(?:[^"']*)?" que puede machear vacío por "[^"']*" o hacerlo más seguro
content = content.replace(r'["\'](https?:\/\/[^"\']+\.(?:m3u8|mp4)(?:[^"\']*)?)["\']/i', r'["\'](https?:\/\/[^"\']+\.(?:m3u8|mp4)[^"\']*)["\']/i')
with open('server/resolvers.ts', 'w') as f:
    f.write(content)

# 6. Extract nested ternary operation in universalScraper.ts line 393 and 630
with open('server/universalScraper.ts', 'r') as f:
    content = f.read()
content = content.replace("const catalogPoster = ogImage ? (ogImage.startsWith(\"//\") ? `https:${ogImage}` : ogImage) : firstImage;", "let catalogPoster = firstImage;\n      if (ogImage) {\n        catalogPoster = ogImage.startsWith(\"//\") ? `https:${ogImage}` : ogImage;\n      }")
content = content.replace("const finalPoster = ogImage ? (ogImage.startsWith(\"//\") ? `https:${ogImage}` : ogImage) : undefined;", "let finalPoster = undefined;\n      if (ogImage) {\n        finalPoster = ogImage.startsWith(\"//\") ? `https:${ogImage}` : ogImage;\n      }")
with open('server/universalScraper.ts', 'w') as f:
    f.write(content)

# 7. Use RegExp.exec() in resolvers.ts lines 44 and 62
with open('server/resolvers.ts', 'r') as f:
    content = f.read()
content = content.replace("const match = text.match(pattern);", "const match = pattern.exec(text);")
content = content.replace("const matchA = html.match(this.REGEX_TYPE_A);", "const matchA = this.REGEX_TYPE_A.exec(html);")
with open('server/resolvers.ts', 'w') as f:
    f.write(content)

print("done")
