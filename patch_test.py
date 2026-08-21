import re

with open('server/scrapers/ScraperManager.test.ts', 'r') as f:
    content = f.read()

new_test = """
  it("resolves LaMovieAdapter for lamovie.org URLs", () => {
    const adapter1 = manager.getAdapter("https://lamovie.org/peliculas?page=2");
    expect(adapter1.id).toBe("lamovie");

    const adapter2 = manager.getAdapter("https://lamovie.org/series/ally-mcbeal-1997/");
    expect(adapter2.id).toBe("lamovie");
  });
"""
content = re.sub(r'(it\("resolves GenericAdapter)', new_test + r'\n  \1', content)

# update list assertion length
content = re.sub(r'expect\(adapters\.length\)\.toBeGreaterThanOrEqual\((.*?)\);', r'expect(adapters.length).toBeGreaterThanOrEqual(6);', content)
content = re.sub(r'(expect\(adapters\.some\(\(a\) => a\.id === "animeflv"\)\)\.toBe\(true\);\n)(.*?)(expect\(adapters\.some)', r'\1    expect(adapters.some((a) => a.id === "lamovie")).toBe(true);\n\2\3', content)

with open('server/scrapers/ScraperManager.test.ts', 'w') as f:
    f.write(content)
