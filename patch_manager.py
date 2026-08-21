import re

with open('server/scrapers/ScraperManager.ts', 'r') as f:
    content = f.read()

# Add import
import_statement = 'import { LaMovieAdapter } from "./adapters/LaMovieAdapter";\n'
content = re.sub(r'(import { GenericAdapter } from "./adapters/GenericAdapter";)', r'\1\n' + import_statement, content)

# Register adapter
register_statement = '    this.registerAdapter(new LaMovieAdapter());\n'
content = re.sub(r'(this\.registerAdapter\(new AnimeFlvAdapter\(\)\);)', r'\1\n' + register_statement, content)

with open('server/scrapers/ScraperManager.ts', 'w') as f:
    f.write(content)
