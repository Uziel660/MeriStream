import os

files_to_fix = ['server/metadataEngine.ts']

for file_path in files_to_fix:
    with open(file_path, 'r') as f:
        content = f.read()

    # Fix ReDoS regexes - HTML Tags
    content = content.replace(r'/<[^>]+>/g', r'/<(?:(?:"[^"]*"[\'"]*|\'[^\']*\'[\'"]*|[^>\'"])+)>/g')

    with open(file_path, 'w') as f:
        f.write(content)
print("done")
