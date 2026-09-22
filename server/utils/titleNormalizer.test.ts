import { describe, expect, it } from "vitest";
import { isPlausibleTitle, normalizeTitleKey, parseRawTitle } from "./titleNormalizer";

describe("parseRawTitle", () => {
  it("limpia ruido de cola con idioma y calidad", () => {
    const parsed = parseRawTitle("Toy Story 5 Latino Español HD");
    expect(parsed.canonical).toBe("Toy Story 5");
    expect(parsed.language).toBe("latino");
    expect(parsed.quality).toBe("hd");
    expect(parsed.year).toBeNull();
  });

  it("elimina etiquetas de audio que no pertenecen a la identidad", () => {
    expect(parseRawTitle("The Daily Life of the Immortal King S3 Japonés").canonical)
      .toBe("The Daily Life of the Immortal King S3");
    expect(parseRawTitle("Code Geass Redoblaje").canonical).toBe("Code Geass");
  });

  it("extrae año aunque NO esté al final y descarta 'Ver' en cola", () => {
    const parsed = parseRawTitle("La Bestia 2026 Ver");
    expect(parsed.canonical).toBe("La Bestia");
    expect(parsed.year).toBe(2026);
  });

  it("elimina prefijo 'Ver' y ruido online/gratis/sub", () => {
    const parsed = parseRawTitle("Ver Dandelion Online Gratis Sub Español");
    expect(parsed.canonical).toBe("Dandelion");
    // "Sub Español" significa subtitulado, no castellano.
    expect(parsed.language).toBe("subtitulado");
  });

  it("NO recorta nombres de temporada legítimos en inglés", () => {
    const parsed = parseRawTitle("Jujutsu Kaisen 2nd Season");
    expect(parsed.canonical).toBe("Jujutsu Kaisen 2nd Season");
    expect(parsed.year).toBeNull();
    // FIX temporadas: se DETECTA la temporada sin recortar el canonical.
    expect(parsed.season).toBe(2);
  });

  it("no vacía títulos cortos ('Up')", () => {
    const parsed = parseRawTitle("Up");
    expect(parsed.canonical).toBe("Up");
  });

  it("extrae año entre paréntesis", () => {
    const parsed = parseRawTitle("Her (2013)");
    expect(parsed.canonical).toBe("Her");
    expect(parsed.year).toBe(2013);
  });

  it("recorta guiones/pipes de cola sin dañar el interior", () => {
    const parsed = parseRawTitle("Coco - Latino | HD");
    expect(parsed.canonical).toBe("Coco");
    expect(parsed.language).toBe("latino");
    expect(parsed.quality).toBe("hd");

    const parsed2 = parseRawTitle("Spider-Man: Across the Spider-Verse - Latino HD 1080p");
    expect(parsed2.canonical).toBe("Spider-Man: Across the Spider-Verse");
    expect(parsed2.quality).toBe("1080p");
  });

  it("corte estructural: tras 'Capitulo N' todo es ruido", () => {
    const parsed = parseRawTitle("Naruto Shippuden Capitulo 220 Sub Español");
    expect(parsed.canonical).toBe("Naruto Shippuden");
    expect(parsed.language).toBe("subtitulado");
  });

  it("'Temporada N' se recorta del nombre base (la temporada la maneja parseTitleQuery)", () => {
    const parsed = parseRawTitle("Attack on Titan Temporada 2");
    expect(parsed.canonical).toBe("Attack on Titan");
  });

  it("colapsa formas multi-palabra de calidad ('Full HD')", () => {
    const parsed = parseRawTitle("Superman Full HD");
    expect(parsed.canonical).toBe("Superman");
    expect(parsed.quality).toBe("fullhd");
  });

  it("convierte slugs con underscores en espacios", () => {
    const parsed = parseRawTitle("Toy_Story_5_Latino_HD");
    expect(parsed.canonical).toBe("Toy Story 5");
    expect(parsed.language).toBe("latino");
  });

  it("año como título completo no se extrae ('1917', película de 2019)", () => {
    const parsed = parseRawTitle("1917");
    expect(parsed.canonical).toBe("1917");
    expect(parsed.year).toBeNull();
  });

  it("año comercial forma parte del nombre cuando hay más palabras después… o no", () => {
    // Consistente con parseTitleQuery: un año suelto SIEMPRE se extrae si queda nombre.
    const parsed = parseRawTitle("Blade Runner 2049");
    expect(parsed.canonical).toBe("Blade Runner");
    expect(parsed.year).toBe(2049);

    // Con dos años gana el último ("1917 (2019)" → estreno 2019).
    const parsed2 = parseRawTitle("1917 (2019)");
    expect(parsed2.canonical).toBe("1917");
    expect(parsed2.year).toBe(2019);
  });

  it("título compuesto solo de ruido cae al original sin romperse", () => {
    const parsed = parseRawTitle("HD Latino Online");
    expect(parsed.canonical.length).toBeGreaterThan(0);
    expect(parsed.canonical).toBe("HD Latino Online");
  });

  it("entrada vacía devuelve canonical vacío sin lanzar", () => {
    expect(parseRawTitle("").canonical).toBe("");
    expect(parseRawTitle("   ").canonical).toBe("");
    expect(parseRawTitle(null as unknown as string).canonical).toBe("");
  });

  it("es idempotente sobre salida limpia", () => {
    const once = parseRawTitle("Toy Story 5");
    const twice = parseRawTitle(once.canonical);
    expect(twice.canonical).toBe("Toy Story 5");
    expect(twice.year).toBeNull();
  });
});

describe("parseRawTitle - detección de temporada (FIX formatos)", () => {
  it("'Nth Season' se detecta sin recortar el canonical", () => {
    const parsed = parseRawTitle("Jujutsu Kaisen 2nd Season");
    expect(parsed.canonical).toBe("Jujutsu Kaisen 2nd Season");
    expect(parsed.season).toBe(2);
  });

  it("'3rd Season' y 'Season N'", () => {
    expect(parseRawTitle("Tokyo Revengers 3rd Season").season).toBe(3);
    expect(parseRawTitle("The Boys Season 4").season).toBe(4);
  });

  it("ordinal en palabra ('Second Season')", () => {
    const parsed = parseRawTitle("Oshi no Ko Second Season");
    expect(parsed.season).toBe(2);
    expect(parsed.canonical).toBe("Oshi no Ko Second Season");
  });

  it("'Temporada N' se detecta aunque el corte estructural la recorte del canonical", () => {
    const parsed = parseRawTitle("Attack on Titan Temporada 2");
    expect(parsed.canonical).toBe("Attack on Titan");
    expect(parsed.season).toBe(2);
  });

  it("'Part 2' / 'Part II'", () => {
    expect(parseRawTitle("Legend of the Galactic Heroes Part 2").season).toBe(2);
    expect(parseRawTitle("JoJo's Bizarre Adventure Part II").season).toBe(2);
  });

  it("'S02' como token suelto", () => {
    const parsed = parseRawTitle("Shingeki no Kyojin S02");
    expect(parsed.season).toBe(2);
    expect(parsed.canonical).toBe("Shingeki no Kyojin S02");
  });

  it("número romano final ('Rocky II', 'Final Fantasy VII')", () => {
    expect(parseRawTitle("Rocky II").season).toBe(2);
    expect(parseRawTitle("Final Fantasy VII").season).toBe(7);
  });

  it("'Final Season' se reconoce sin asignar número", () => {
    const parsed = parseRawTitle("Attack on Titan Final Season");
    expect(parsed.canonical).toBe("Attack on Titan Final Season");
    expect(parsed.season).toBeNull();
  });

  it("sin falsos positivos: 'Boss 2', 'Mister X', 'Rápidos y Furiosos 9'", () => {
    expect(parseRawTitle("Boss 2").season).toBeNull();
    expect(parseRawTitle("Mister X").season).toBeNull();
    expect(parseRawTitle("Rápidos y Furiosos 9").season).toBeNull();
  });
});

describe("isPlausibleTitle / guard anti-basura (FIX título 'pe')", () => {
  it("rechaza basura de longitud <=2 sin forma de título", () => {
    expect(isPlausibleTitle("pe")).toBe(false);
    expect(isPlausibleTitle("Tk")).toBe(false);   // ≤2 sin vocal
    expect(isPlausibleTitle("de")).toBe(false);   // ≤2 minúscula suelta
    expect(isPlausibleTitle("x")).toBe(false);    // minúscula suelta
  });

  it("rechaza fugas de UI con 'Género'", () => {
    expect(isPlausibleTitle("Género: Pe...")).toBe(false);
    expect(isPlausibleTitle("Genero Acción")).toBe(false);
    expect(isPlausibleTitle("Shingeki no Kyojin Género: Acción")).toBe(false);
  });

  it("rechaza URLs pegadas como título y artículos sueltos (hallazgos reales de BD)", () => {
    expect(isPlausibleTitle("http://localhost:59699/ test a")).toBe(false);
    expect(isPlausibleTitle("Un")).toBe(false);
    expect(isPlausibleTitle("Una")).toBe(false);
  });

  it("rechaza placeholders de detalle cuando un scraper no pudo cargar la ficha", () => {
    expect(isPlausibleTitle("Contenido Cinecalidad")).toBe(false);
    expect(isPlausibleTitle("Contenido LaMovie")).toBe(false);
    expect(isPlausibleTitle("Película TubePelis")).toBe(false);
    expect(isPlausibleTitle("Anime TioAnime")).toBe(false);
  });

  it("acepta títulos cortos conocidos y normales", () => {
    expect(isPlausibleTitle("Up")).toBe(true);
    expect(isPlausibleTitle("It")).toBe(true);
    expect(isPlausibleTitle("X")).toBe(true);
    expect(isPlausibleTitle("Us")).toBe(true);
    expect(isPlausibleTitle("21")).toBe(true);      // numérico corto legítimo
    expect(isPlausibleTitle("Toy Story 5")).toBe(true);
    expect(isPlausibleTitle("Jujutsu Kaisen 2nd Season")).toBe(true);
    expect(isPlausibleTitle("SK∞")).toBe(true);
    expect(isPlausibleTitle("C3")).toBe(true);
    expect(isPlausibleTitle("H2")).toBe(true);
    expect(isPlausibleTitle("MM!")).toBe(true);
    expect(isPlausibleTitle("S&X")).toBe(true);
    expect(isPlausibleTitle("Z")).toBe(true);
    expect(isPlausibleTitle("时间之子")).toBe(true);
    expect(isPlausibleTitle("速戰")).toBe(true); // título chino breve válido
    expect(isPlausibleTitle("XX")).toBe(true); // sigla/título íntegramente en mayúsculas
  });

  it("parseRawTitle marca 'plausible: false' en basura", () => {
    expect(parseRawTitle("pe").plausible).toBe(false);
    expect(parseRawTitle("Género: Acción").plausible).toBe(false);
    expect(parseRawTitle("Jujutsu Kaisen").plausible).toBe(true);
  });
});

describe("normalizeTitleKey", () => {
  it("títulos sucios y limpios de la MISMA obra colisionan en una clave", () => {
    expect(normalizeTitleKey("Toy Story 5 Latino Español HD")).toBe(
      normalizeTitleKey("Toy Story 5")
    );
    expect(normalizeTitleKey("La Bestia 2026 Ver")).toBe(normalizeTitleKey("La Bestia"));
    expect(normalizeTitleKey("Ver Dandelion Online Gratis Sub Español")).toBe(
      normalizeTitleKey("Dandelion")
    );
  });

  it("normaliza acentos, puntuación, guiones y pipes", () => {
    expect(normalizeTitleKey("Kaguya-sama: Love is War")).toBe("kaguyasamaloveiswar");
    expect(normalizeTitleKey("kaguya sama | love-is-war")).toBe("kaguyasamaloveiswar");
    expect(normalizeTitleKey("Rápidos y Furiosos")).toBe(normalizeTitleKey("Rapidos Y Furiosos"));
  });

  it("removes year noise so remakes share base key but differ by year", () => {
    expect(normalizeTitleKey("Her (2013)")).toBe("her");
    expect(normalizeTitleKey("Her")).toBe("her");
  });

  it("clave estable e idempotente", () => {
    const key = normalizeTitleKey("Toy Story 5 Latino Español HD");
    expect(normalizeTitleKey(key)).toBe(key);
  });

  it("entrada vacía produce clave vacía", () => {
    expect(normalizeTitleKey("")).toBe("");
    expect(normalizeTitleKey("   ")).toBe("");
  });
});
