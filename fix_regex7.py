import os

file_path = 'server/metadataEngine.ts'
with open(file_path, 'r') as f:
    content = f.read()

content = "import sanitizeHtml from 'sanitize-html';\n" + content

# Real library is the safest for SonarQube
content = content.replace(r".replace(/<\/?[a-z][^>]*>/gi, '')", "")
content = content.replace("attr.synopsis ? attr.synopsis", "attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] })")
content = content.replace("item.synopsis ? item.synopsis", "item.synopsis ? sanitizeHtml(item.synopsis, { allowedTags: [] })")
content = content.replace("(show.summary || \"\")", "sanitizeHtml((show.summary || \"\"), { allowedTags: [] })")
content = content.replace("doc.description ? doc.description", "doc.description ? sanitizeHtml(doc.description, { allowedTags: [] })")
content = content.replace("media.description\n", "sanitizeHtml(media.description, { allowedTags: [] })\n")

with open(file_path, 'w') as f:
    f.write(content)
print("done")
