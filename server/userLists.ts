import { Router, Response } from "express";
import { prisma } from "./db";
import { requireAuth, optionalAuth, AuthRequest } from "./auth";

const userListsRouter = Router();

async function ensureDefaultLists(userId: string) {
  const existing = await prisma.userList.findMany({
    where: { user_id: userId, is_system: true },
  });

  const hasFavorites = existing.some((l) => l.system_type === "favorites");
  const hasWatchlist = existing.some((l) => l.system_type === "watchlist");

  const toCreate = [];
  if (!hasFavorites) {
    toCreate.push(
      prisma.userList.create({
        data: {
          user_id: userId,
          name: "Favoritos",
          description: "Tus películas, series y animes preferidos",
          is_system: true,
          system_type: "favorites",
          icon: "heart",
        },
      })
    );
  }
  if (!hasWatchlist) {
    toCreate.push(
      prisma.userList.create({
        data: {
          user_id: userId,
          name: "Ver más tarde",
          description: "Títulos guardados para ver próximamente",
          is_system: true,
          system_type: "watchlist",
          icon: "clock",
        },
      })
    );
  }

  if (toCreate.length > 0) {
    await Promise.all(toCreate);
  }
}

/**
 * GET /api/lists
 * Obtiene todas las listas del usuario con resumen de items
 */
userListsRouter.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureDefaultLists(userId);

    const lists = await prisma.userList.findMany({
      where: { user_id: userId },
      orderBy: [{ is_system: "desc" }, { created_at: "asc" }],
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: { added_at: "desc" },
          select: {
            id: true,
            list_id: true,
            show_id: true,
            tmdb_id: true,
            title: true,
            poster_url: true,
            backdrop_url: true,
            kind: true,
            year: true,
            rating: true,
            genres: true,
            added_at: true,
          },
        },
      },
    });

    return res.json(lists);
  } catch (error: any) {
    console.error("Error al obtener listas:", error);
    return res.status(500).json({ error: "Error al obtener listas: " + (error?.message || error) });
  }
});

/**
 * POST /api/lists
 * Crea una nueva lista personalizada
 */
userListsRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, description, icon } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "El nombre de la lista es obligatorio." });
    }

    const cleanName = name.trim().slice(0, 80);

    const existing = await prisma.userList.findFirst({
      where: { user_id: userId, name: { equals: cleanName, mode: "insensitive" } },
    });

    if (existing) {
      return res.status(400).json({ error: "Ya tienes una lista con ese nombre." });
    }

    const newList = await prisma.userList.create({
      data: {
        user_id: userId,
        name: cleanName,
        description: typeof description === "string" ? description.trim().slice(0, 300) : "",
        icon: typeof icon === "string" ? icon.trim().slice(0, 30) : "list",
        is_system: false,
      },
      include: {
        _count: { select: { items: true } },
        items: true,
      },
    });

    return res.status(201).json(newList);
  } catch (error: any) {
    console.error("Error al crear lista:", error);
    return res.status(500).json({ error: "Error al crear lista: " + (error?.message || error) });
  }
});

/**
 * GET /api/lists/item-status/:showId
 * Consulta en qué listas se encuentra una obra
 */
userListsRouter.get("/item-status/:showId", optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const showId = req.params.showId;

    if (!userId) {
      return res.json({ isFavorite: false, isWatchlist: false, inLists: [] });
    }

    const memberships = await prisma.userListItem.findMany({
      where: {
        show_id: showId,
        list: { user_id: userId },
      },
      include: {
        list: { select: { id: true, name: true, is_system: true, system_type: true } },
      },
    });

    const inLists = memberships.map((m) => m.list);
    const isFavorite = inLists.some((l) => l.system_type === "favorites");
    const isWatchlist = inLists.some((l) => l.system_type === "watchlist");

    return res.json({ isFavorite, isWatchlist, inLists });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * POST /api/lists/toggle
 * Añade o elimina una obra de Favoritos o Ver más tarde con 1 clic
 */
userListsRouter.post("/toggle", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { systemType, show } = req.body;

    if (!systemType || !["favorites", "watchlist"].includes(systemType)) {
      return res.status(400).json({ error: "Tipo de sistema no válido ('favorites' | 'watchlist')." });
    }

    if (!show || !show.id || !show.title) {
      return res.status(400).json({ error: "Datos del título inválidos." });
    }

    await ensureDefaultLists(userId);

    const list = await prisma.userList.findFirst({
      where: { user_id: userId, system_type: systemType },
    });

    if (!list) {
      return res.status(404).json({ error: "Lista no encontrada." });
    }

    const showIdStr = String(show.id);
    const tmdbIdNum = Number(show.tmdb_id);
    const validTmdb = Number.isInteger(tmdbIdNum) && tmdbIdNum > 0 ? tmdbIdNum : null;

    const existingItem = await prisma.userListItem.findFirst({
      where: {
        list_id: list.id,
        OR: [
          { show_id: showIdStr },
          ...(validTmdb ? [{ tmdb_id: validTmdb }, { show_id: { endsWith: `-${validTmdb}` } }] : []),
        ],
      },
    });

    if (existingItem) {
      await prisma.userListItem.delete({
        where: { id: existingItem.id },
      });
      return res.json({ active: false, listId: list.id, systemType });
    } else {
      const year = Number(show.year);
      const rating = Number(show.rating);
      const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");

      await prisma.userListItem.create({
        data: {
          list_id: list.id,
          show_id: showIdStr,
          tmdb_id: validTmdb,
          title: String(show.title).trim(),
          poster_url: show.poster_url || show.poster_path || null,
          backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
          kind: show.kind || show.category || "movie",
          year: Number.isInteger(year) && year > 0 ? year : null,
          rating: Number.isFinite(rating) && rating > 0 ? rating : null,
          genres: genresStr || null,
        },
      });
      return res.json({ active: true, listId: list.id, systemType });
    }
  } catch (error: any) {
    console.error("Error al togglear en lista:", error);
    return res.status(500).json({ error: "Error en toggle: " + (error?.message || error) });
  }
});

/**
 * GET /api/lists/:id
 * Obtiene el detalle de una lista y todos sus títulos
 */
userListsRouter.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const listId = req.params.id;

    const list = await prisma.userList.findFirst({
      where: { id: listId, user_id: userId },
      include: {
        _count: { select: { items: true } },
        items: {
          orderBy: { added_at: "desc" },
        },
      },
    });

    if (!list) {
      return res.status(404).json({ error: "Lista no encontrada." });
    }

    return res.json(list);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * PUT /api/lists/:id
 * Actualiza nombre o descripción de una lista personalizada
 */
userListsRouter.put("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const listId = req.params.id;
    const { name, description, icon } = req.body;

    const list = await prisma.userList.findFirst({
      where: { id: listId, user_id: userId },
    });

    if (!list) {
      return res.status(404).json({ error: "Lista no encontrada." });
    }

    if (list.is_system) {
      return res.status(400).json({ error: "No puedes renombrar una lista predeterminada del sistema." });
    }

    const cleanName = typeof name === "string" && name.trim().length > 0 ? name.trim().slice(0, 80) : list.name;

    const updated = await prisma.userList.update({
      where: { id: listId },
      data: {
        name: cleanName,
        description: typeof description === "string" ? description.trim().slice(0, 300) : list.description,
        icon: typeof icon === "string" ? icon.trim().slice(0, 30) : list.icon,
      },
      include: {
        _count: { select: { items: true } },
      },
    });

    return res.json(updated);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * DELETE /api/lists/:id
 * Elimina una lista personalizada
 */
userListsRouter.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const listId = req.params.id;

    const list = await prisma.userList.findFirst({
      where: { id: listId, user_id: userId },
    });

    if (!list) {
      return res.status(404).json({ error: "Lista no encontrada." });
    }

    if (list.is_system) {
      return res.status(400).json({ error: "No puedes eliminar una lista predeterminada del sistema." });
    }

    await prisma.userList.delete({
      where: { id: listId },
    });

    return res.json({ success: true, message: "Lista eliminada con éxito." });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * POST /api/lists/:id/items
 * Añade un título a una lista
 */
userListsRouter.post("/:id/items", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const listId = req.params.id;
    const { show } = req.body;

    if (!show || !show.id || !show.title) {
      return res.status(400).json({ error: "Datos de título inválidos." });
    }

    const list = await prisma.userList.findFirst({
      where: { id: listId, user_id: userId },
    });

    if (!list) {
      return res.status(404).json({ error: "Lista no encontrada." });
    }

    const tmdbId = Number(show.tmdb_id);
    const year = Number(show.year);
    const rating = Number(show.rating);
    const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");

    const item = await prisma.userListItem.upsert({
      where: {
        list_id_show_id: {
          list_id: list.id,
          show_id: String(show.id),
        },
      },
      update: {
        title: String(show.title).trim(),
        poster_url: show.poster_url || show.poster_path || null,
        backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
        year: Number.isInteger(year) && year > 0 ? year : null,
        rating: Number.isFinite(rating) && rating > 0 ? rating : null,
      },
      create: {
        list_id: list.id,
        show_id: String(show.id),
        tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
        title: String(show.title).trim(),
        poster_url: show.poster_url || show.poster_path || null,
        backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
        kind: show.kind || show.category || "movie",
        year: Number.isInteger(year) && year > 0 ? year : null,
        rating: Number.isFinite(rating) && rating > 0 ? rating : null,
        genres: genresStr || null,
      },
    });

    return res.status(201).json(item);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * DELETE /api/lists/:id/items/:showId
 * Elimina un título de una lista
 */
userListsRouter.delete("/:id/items/:showId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const listId = req.params.id;
    const showId = req.params.showId;

    const list = await prisma.userList.findFirst({
      where: { id: listId, user_id: userId },
    });

    if (!list) {
      return res.status(404).json({ error: "Lista no encontrada." });
    }

    const showIdStr = String(showId);
    const tmdbIdNum = Number(showIdStr.replace(/\D/g, ''));
    const validTmdb = Number.isInteger(tmdbIdNum) && tmdbIdNum > 0 ? tmdbIdNum : null;

    await prisma.userListItem.deleteMany({
      where: {
        list_id: list.id,
        OR: [
          { show_id: showIdStr },
          ...(validTmdb ? [{ tmdb_id: validTmdb }, { show_id: { endsWith: `-${validTmdb}` } }] : []),
        ],
      },
    });

    return res.json({ success: true, message: "Título eliminado de la lista." });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

/**
 * POST /api/lists/sync-guest
 * Migra las listas locales creadas en modo invitado a la cuenta del usuario
 */
userListsRouter.post("/sync-guest", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { localLists } = req.body;

    if (!Array.isArray(localLists) || localLists.length === 0) {
      return res.json({ success: true, count: 0 });
    }

    await ensureDefaultLists(userId);
    const dbLists = await prisma.userList.findMany({ where: { user_id: userId } });
    const dbListsBySystem = new Map(dbLists.map((l) => [l.system_type, l]));

    let importedCount = 0;

    for (const localList of localLists) {
      let targetList = localList.system_type ? dbListsBySystem.get(localList.system_type) : null;

      if (!targetList && localList.name) {
        targetList = await prisma.userList.findFirst({
          where: { user_id: userId, name: { equals: localList.name, mode: "insensitive" } },
        });

        if (!targetList) {
          targetList = await prisma.userList.create({
            data: {
              user_id: userId,
              name: localList.name.trim().slice(0, 80),
              description: localList.description || "",
              icon: localList.icon || "list",
              is_system: false,
            },
          });
        }
      }

      if (targetList && Array.isArray(localList.items)) {
        for (const show of localList.items) {
          if (!show.id || !show.title) continue;
          const tmdbId = Number(show.tmdb_id);
          const year = Number(show.year);
          const rating = Number(show.rating);
          const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");

          try {
            await prisma.userListItem.upsert({
              where: {
                list_id_show_id: {
                  list_id: targetList.id,
                  show_id: String(show.id),
                },
              },
              update: {},
              create: {
                list_id: targetList.id,
                show_id: String(show.id),
                tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
                title: String(show.title).trim(),
                poster_url: show.poster_url || show.poster_path || null,
                backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
                kind: show.kind || show.category || "movie",
                year: Number.isInteger(year) && year > 0 ? year : null,
                rating: Number.isFinite(rating) && rating > 0 ? rating : null,
                genres: genresStr || null,
              },
            });
            importedCount++;
          } catch (_) {}
        }
      }
    }

    return res.json({ success: true, importedCount });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

export { userListsRouter };
