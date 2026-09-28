import { describe, expect, it } from "vitest";
import { CinecalidadAdapter } from "./CinecalidadAdapter";

describe("CinecalidadAdapter · mirrors WordPress", () => {
  it("resuelve las fichas relativas contra el mirror que entregó el HTML", () => {
    const adapter = new CinecalidadAdapter();
    const items = adapter.extractCatalogItems(
      '<div class="home_post_cont"><a href="/pelicula/bolt-2020/"><img alt="Bolt (2020)" src="https://www.cinecalidad.my/poster.jpg"></a></div>',
      "https://www.cinecalidad.my",
    );
    expect(items[0]).toMatchObject({
      title: "Bolt (2020)",
      url: "https://www.cinecalidad.my/pelicula/bolt-2020/",
      image_url: "https://www.cinecalidad.my/poster.jpg",
    });
  });

  it("convierte ids de servidores del player y descarta Voe/Filemoon", () => {
    const adapter: any = new CinecalidadAdapter();
    const urls = adapter.extractLegacyServerEmbeds(`
      <a class="onlinelink" service="OnlineDoodstream" data="dood123"></a>
      <a class="onlinelink" service="OnlineMega" data="#!id!key"></a>
      <a class="onlinelink" service="OnlineVoe" data="voe123"></a>
      <a class="onlinelink" service="OnlineFilemoon" data="moon123"></a>
    `);
    expect(urls).toEqual([
      "https://doodstream.com/e/dood123",
      "https://mega.nz/embed/#!id!key",
    ]);
  });
});
