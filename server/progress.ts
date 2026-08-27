import { Router, Response } from "express";
import { prisma } from "./db";
import { requireAuth, AuthRequest } from "./auth";

const progressRouter = Router();

/**
 * GET /api/progress
 * Obtiene la lista de contenidos en curso ("Seguir Viendo") del usuario autenticado
 */
progressRouter.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const items = await prisma.watchProgress.findMany({
      where: { user_id: userId },
      orderBy: { last_watched_at: "desc" },
      take: 50,
    });

    // Formato compatible con el componente ContinueWatching del frontend
    const formatted = items.map((item) => ({
      showId: item.show_id,
      showTitle: item.show_title,
      showPoster: item.show_poster || undefined,
      episodeId: item.episode_id,
      episodeNumber: item.episode_number,
      episodeTitle: item.episode_title,
      progressPercent: Math.round(item.progress_percent),
      currentTime: item.current_time || 0,
      duration: item.duration || 0,
      lastWatchedAt: item.last_watched_at.getTime(),
    }));

    return res.json({ items: formatted });
  } catch (error: any) {
    console.error("Error al obtener progreso de reproducción:", error);
    return res.status(500).json({ error: "Error al obtener progreso: " + (error?.message || error) });
  }
});

/**
 * POST /api/progress
 * Guarda o actualiza el progreso de reproducción
 */
progressRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      showId,
      showTitle,
      showPoster,
      episodeId,
      episodeNumber,
      episodeTitle,
      progressPercent,
      currentTime,
      duration,
    } = req.body;

    if (!showId || !episodeId) {
      return res.status(400).json({ error: "showId y episodeId son requeridos." });
    }

    const safeNumber = typeof episodeNumber === "number" ? episodeNumber : parseFloat(episodeNumber) || 1;
    const safePercent = typeof progressPercent === "number" ? progressPercent : parseFloat(progressPercent) || 0;
    const safeTime = typeof currentTime === "number" ? currentTime : parseFloat(currentTime) || 0;
    const safeDuration = typeof duration === "number" ? duration : parseFloat(duration) || 0;

    const record = await prisma.watchProgress.upsert({
      where: {
        user_id_show_id_episode_id: {
          user_id: userId,
          show_id: String(showId),
          episode_id: String(episodeId),
        },
      },
      update: {
        show_title: showTitle || "Contenido",
        show_poster: showPoster || null,
        episode_number: safeNumber,
        episode_title: episodeTitle || `Episodio ${safeNumber}`,
        progress_percent: Math.min(100, Math.max(0, safePercent)),
        current_time: safeTime,
        duration: safeDuration,
        last_watched_at: new Date(),
      },
      create: {
        user_id: userId,
        show_id: String(showId),
        show_title: showTitle || "Contenido",
        show_poster: showPoster || null,
        episode_id: String(episodeId),
        episode_number: safeNumber,
        episode_title: episodeTitle || `Episodio ${safeNumber}`,
        progress_percent: Math.min(100, Math.max(0, safePercent)),
        current_time: safeTime,
        duration: safeDuration,
        last_watched_at: new Date(),
      },
    });

    return res.json({ success: true, item: record });
  } catch (error: any) {
    console.error("Error al guardar progreso:", error);
    return res.status(500).json({ error: "Error al guardar progreso: " + (error?.message || error) });
  }
});

/**
 * DELETE /api/progress/:episodeId
 * Elimina un episodio específico del historial "Seguir Viendo"
 */
progressRouter.delete("/:episodeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { episodeId } = req.params;

    await prisma.watchProgress.deleteMany({
      where: {
        user_id: userId,
        episode_id: episodeId,
      },
    });

    return res.json({ success: true, message: "Elemento eliminado de Seguir Viendo" });
  } catch (error: any) {
    console.error("Error al eliminar progreso:", error);
    return res.status(500).json({ error: "Error al eliminar progreso." });
  }
});

/**
 * DELETE /api/progress/show/:showId
 * Elimina todos los episodios de una serie del historial
 */
progressRouter.delete("/show/:showId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { showId } = req.params;

    await prisma.watchProgress.deleteMany({
      where: {
        user_id: userId,
        show_id: showId,
      },
    });

    return res.json({ success: true, message: "Serie eliminada de Seguir Viendo" });
  } catch (error: any) {
    return res.status(500).json({ error: "Error al limpiar serie del progreso." });
  }
});

export { progressRouter };
