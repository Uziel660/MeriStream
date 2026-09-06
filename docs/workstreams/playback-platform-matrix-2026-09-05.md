# Matriz de reproducción y multiplexado — 2026-09-05

Prueba DB-only contra `http://127.0.0.1:3010`; solo lectura, concurrencia máxima 2. No se alteraron catálogos ni SourceLink.

## Una obra por plataforma

| Plataforma | Obra/episodio | Fuente almacenada | Sitios guardados | HTTP | Latencia ms | Candidatos | Sitios devueltos |
|---|---|---|---:|---:|---:|---:|---|
| animeflv | Classroom of the Elite · E1 | www3.animeflv.net | 10 | 200 | 299 | 8 | tioanime, latanime, www3, wwv, ww3, jkanime |
| cinecalidad | Minions Monstruos · E1 | cinecalidad.am | 8 | 200 | 215 | 4 | cinecalidad, ww3 |
| doramasflix | Vampire Hunter D: Bloodlust · E1 | doramasflix.io | 2 | 200 | 14 | 3 | tioanime, doramasflix |
| gnula | ¡Estáis cordialmente invitados! · E1 | player.gnulahd.nu | 3 | 200 | 72 | 2 | ww3 |
| hianimes | OKITSURA: Fell in Love with an Okinawan Girl, but I Just Wish I Know What She's Saying · E1 | hianimes | 9 | 200 | 64 | 7 | tioanime, hianimes, wwv, jkanime, megaplay, www3 |
| jkanime | Thunder 3 · E1 | jkanime | 10 | 200 | 37 | 8 | tioanime, latanime, jkanime, animeflv, ww3, wwv |
| lamovie | Los Simpson: Santa Homero · E1 | lamovie.org | 8 | 200 | 22 | 3 | lamovie, ww3 |
| latanime | JoJo's Bizarre Adventure: Steel Ball Run S6 · E1 | latanime.org | 10 | 200 | 45 | 8 | tioanime, latanime, lamovie, wwv, jkanime |
| tioanime | Kimetsu no Yaiba Movie 1: Mugenjou-hen Akaza Sairai · E1 | tioanime.com | 6 | 200 | 7 | 7 | tioanime, latanime, animeflv, jkanime |
| tioplus | Los 33 (Una Historia De Esperanza) · E1 | tioplus | 6 | 200 | 142 | 5 | cinecalidad, lamovie, tioplus, waaw, ww3 |
| tubepelis | Supergirl: Woman of Tomorrow · E1 | tubepelis.com | 1 | 200 | 123 | 6 | cinecalidad, tioplus, ww3 |
| veranimes | Otome Game Sekai wa Mob ni Kibishii Sekai desu 2 Anime · E3 | wwv.veranimes.net | 1 | 200 | 63 | 1 | wwv |

## Obras multiplexadas

| Obra/episodio | Sitios guardados | Enlaces guardados | HTTP | Latencia ms | Candidatos | Sitios devueltos |
|---|---:|---:|---:|---:|---:|---|
| Boku no Hero Academia: I Am a Hero Too · T1E1 | 14 | 29 | 200 | 22 | 8 | tioanime, lamovie, latanime, jkanime, animeflv, ww3 |
| El día de la revelación · T1E1 | 10 | 41 | 200 | 16 | 7 | cinecalidad, tioplus, lamovie, ww3 |
| La muerte de Robin Hood · T1E1 | 9 | 29 | 200 | 19 | 6 | cinecalidad, tioplus, ww3 |
| Islas · T1E1 | 9 | 24 | 200 | 24 | 5 | tioplus, lamovie, ww3 |
| Wind Breaker S2 · T2E1 | 9 | 22 | 200 | 7 | 8 | tioanime, latanime, wwv, jkanime, megaplay, hianimes |
| Backstabbed in a Backwater Dungeon · T1E1 | 9 | 13 | 200 | 14 | 8 | tioanime, latanime, jkanime, zokoanime, hianimes, megaplay |

Los candidatos son enlaces canónicos ya almacenados. HTTP 200 y candidatos >0 prueban la cascada/ranking; no sustituyen una reproducción visual de cada embed ni una sonda de bytes.
