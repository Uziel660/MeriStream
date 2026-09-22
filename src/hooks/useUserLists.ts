// src/hooks/useUserLists.ts
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../contexts/AuthContext";
import { getAuthToken } from "../api/client";

export interface UserListItemData {
  id: string;
  list_id: string;
  show_id: string;
  tmdb_id?: number | null;
  title: string;
  poster_url?: string | null;
  backdrop_url?: string | null;
  kind?: string;
  year?: number | null;
  rating?: number | null;
  genres?: string | null;
  added_at: string;
}

export interface UserListData {
  id: string;
  user_id?: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  system_type?: "favorites" | "watchlist" | null;
  icon?: string | null;
  is_public?: boolean;
  created_at?: string;
  updated_at?: string;
  _count?: { items: number };
  items?: UserListItemData[];
}

const GUEST_LISTS_STORAGE_KEY = "meristream_guest_lists_v1";
export const USER_LISTS_UPDATED_EVENT = "meristream_user_lists_updated";

function getDefaultGuestLists(): UserListData[] {
  return [
    {
      id: "guest-favorites",
      name: "Favoritos",
      description: "Tus películas, series y animes preferidos",
      is_system: true,
      system_type: "favorites",
      icon: "heart",
      items: [],
      _count: { items: 0 },
    },
    {
      id: "guest-watchlist",
      name: "Ver más tarde",
      description: "Títulos guardados para ver próximamente",
      is_system: true,
      system_type: "watchlist",
      icon: "clock",
      items: [],
      _count: { items: 0 },
    },
  ];
}

function readGuestLists(): UserListData[] {
  try {
    const raw = localStorage.getItem(GUEST_LISTS_STORAGE_KEY);
    if (!raw) return getDefaultGuestLists();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return getDefaultGuestLists();
    return parsed;
  } catch {
    return getDefaultGuestLists();
  }
}

function saveGuestLists(lists: UserListData[]) {
  try {
    localStorage.setItem(GUEST_LISTS_STORAGE_KEY, JSON.stringify(lists));
  } catch (_) {}
}

export function notifyListsUpdated() {
  window.dispatchEvent(new CustomEvent(USER_LISTS_UPDATED_EVENT));
}

export function clearGuestLists() {
  try {
    localStorage.removeItem(GUEST_LISTS_STORAGE_KEY);
  } catch (_) {}
  notifyListsUpdated();
}

function matchesShow(item: UserListItemData, target: any): boolean {
  if (!item || !target) return false;
  let targetId = '';
  let targetTmdbId: number | null = null;
  if (typeof target === 'object' && target !== null) {
    targetId = String(target.id || '');
    const num = Number(target.tmdb_id);
    if (Number.isInteger(num) && num > 0) targetTmdbId = num;
  } else {
    targetId = String(target);
  }

  if (!targetTmdbId) {
    const match = /^tmdb-(?:movie|series|anime)-(d+)$/.exec(targetId);
    if (match) targetTmdbId = Number(match[1]);
    else if (/^\d+$/.test(targetId)) targetTmdbId = Number(targetId);
  }

  if (targetId && String(item.show_id) === targetId) return true;
  if (targetTmdbId && item.tmdb_id && Number(item.tmdb_id) === targetTmdbId) return true;
  if (targetTmdbId && String(item.show_id).endsWith(`-${targetTmdbId}`)) return true;
  return false;
}

export function useUserLists() {
  const { isAuthenticated, user } = useAuth();
  const [lists, setLists] = useState<UserListData[]>(() => {
    return readGuestLists();
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Cargar listas desde servidor si autenticado, o localStorage si invitado
  const fetchLists = useCallback(async () => {
    const currentToken = getAuthToken();
    if (isAuthenticated && currentToken) {
      setIsLoading(true);
      try {
        const res = await fetch("/api/lists", {
          headers: {
            Authorization: `Bearer ${currentToken}`,
            Accept: "application/json",
          },
        });
        if (res.ok) {
          const data = await res.json();
          setLists(data);
          return;
        }
      } catch (err) {
        console.warn("[Lists] Error cargando listas del servidor:", err);
      } finally {
        setIsLoading(false);
      }
    }
    // Fallback invitado
    setLists(readGuestLists());
  }, [isAuthenticated, user?.id]);

  useEffect(() => {
    fetchLists();
  }, [fetchLists]);

  // Escuchar eventos globales de sincronización
  useEffect(() => {
    const handleUpdate = () => {
      fetchLists();
    };
    window.addEventListener(USER_LISTS_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(USER_LISTS_UPDATED_EVENT, handleUpdate);
  }, [fetchLists]);

  // Migrar listas locales cuando el usuario inicia sesión
  useEffect(() => {
    const currentToken = getAuthToken();
    if (isAuthenticated && currentToken) {
      const local = readGuestLists();
      const hasLocalItems = local.some((l) => (l.items && l.items.length > 0) || !l.is_system);
      if (hasLocalItems) {
        fetch("/api/lists/sync-guest", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${currentToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ localLists: local }),
        })
          .then((res) => {
            if (res.ok) {
              localStorage.removeItem(GUEST_LISTS_STORAGE_KEY);
              fetchLists();
            }
          })
          .catch(() => {});
      }
    }
  }, [isAuthenticated, user?.id, fetchLists]);

  const favorites = useMemo(
    () => lists.find((l) => l.system_type === "favorites") || null,
    [lists]
  );
  const watchlist = useMemo(
    () => lists.find((l) => l.system_type === "watchlist") || null,
    [lists]
  );
  const customLists = useMemo(
    () => lists.filter((l) => !l.is_system),
    [lists]
  );

  const isFavorite = useCallback(
    (showOrId: any): boolean => {
      if (!favorites?.items || !showOrId) return false;
      return favorites.items.some((item) => matchesShow(item, showOrId));
    },
    [favorites]
  );

  const isWatchlist = useCallback(
    (showOrId: any): boolean => {
      if (!watchlist?.items || !showOrId) return false;
      return watchlist.items.some((item) => matchesShow(item, showOrId));
    },
    [watchlist]
  );

  const isInList = useCallback(
    (listId: string, showOrId: any): boolean => {
      const target = lists.find((l) => l.id === listId);
      if (!target?.items || !showOrId) return false;
      return target.items.some((item) => matchesShow(item, showOrId));
    },
    [lists]
  );

  const getListsForShow = useCallback(
    (showOrId: any): UserListData[] => {
      if (!showOrId) return [];
      return lists.filter((l) => l.items?.some((item) => matchesShow(item, showOrId)));
    },
    [lists]
  );

  // Toggle Favorito con Optimistic UI Update
  const toggleFavorite = useCallback(
    async (show: any): Promise<boolean> => {
      if (!show) return false;
      const showId = String(show.id || (show.tmdb_id ? `tmdb-${show.kind || show.category || 'movie'}-${show.tmdb_id}` : ''));
      if (!showId) return false;

      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        const wasFav = isFavorite(show);
        const nextFav = !wasFav;

        // Actualización optimista inmediata
        setLists((prevLists) => {
          return prevLists.map((l) => {
            if (l.system_type !== "favorites") return l;
            const items = l.items ? [...l.items] : [];
            if (wasFav) {
              const filtered = items.filter((it) => !matchesShow(it, show));
              return { ...l, items: filtered, _count: { items: filtered.length } };
            } else {
              const tmdbId = Number(show.tmdb_id);
              const year = Number(show.year);
              const rating = Number(show.rating);
              const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");
              const newItem: UserListItemData = {
                id: `opt-${Date.now()}`,
                list_id: l.id,
                show_id: showId,
                tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
                title: String(show.title || "").trim(),
                poster_url: show.poster_url || show.poster_path || null,
                backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
                kind: show.kind || show.category || "movie",
                year: Number.isInteger(year) && year > 0 ? year : null,
                rating: Number.isFinite(rating) && rating > 0 ? rating : null,
                genres: genresStr || null,
                added_at: new Date().toISOString(),
              };
              return { ...l, items: [newItem, ...items], _count: { items: items.length + 1 } };
            }
          });
        });

        try {
          const res = await fetch("/api/lists/toggle", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ systemType: "favorites", show }),
          });
          if (res.ok) {
            const data = await res.json();
            notifyListsUpdated();
            return data.active;
          }
        } catch (err) {
          console.error("[Lists] Error toggle favorito:", err);
          fetchLists();
        }
        return nextFav;
      }

      // Modo invitado
      const current = readGuestLists();
      let favList = current.find((l) => l.system_type === "favorites");
      if (!favList) {
        favList = {
          id: "guest-favorites",
          name: "Favoritos",
          description: "Tus películas, series y animes preferidos",
          is_system: true,
          system_type: "favorites",
          icon: "heart",
          items: [],
          _count: { items: 0 },
        };
        current.unshift(favList);
      }
      favList.items = favList.items || [];
      const existsIdx = favList.items.findIndex((item) => matchesShow(item, show));
      let active = false;

      if (existsIdx >= 0) {
        favList.items.splice(existsIdx, 1);
        active = false;
      } else {
        const tmdbId = Number(show.tmdb_id);
        const year = Number(show.year);
        const rating = Number(show.rating);
        const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");
        favList.items.unshift({
          id: `item-${Date.now()}`,
          list_id: favList.id,
          show_id: showId,
          tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
          title: String(show.title || "").trim(),
          poster_url: show.poster_url || show.poster_path || null,
          backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
          kind: show.kind || show.category || "movie",
          year: Number.isInteger(year) && year > 0 ? year : null,
          rating: Number.isFinite(rating) && rating > 0 ? rating : null,
          genres: genresStr || null,
          added_at: new Date().toISOString(),
        });
        active = true;
      }

      favList._count = { items: favList.items.length };
      saveGuestLists(current);
      setLists([...current]);
      notifyListsUpdated();
      return active;
    },
    [isAuthenticated, isFavorite, fetchLists]
  );

  // Toggle Ver más tarde con Optimistic UI Update
  const toggleWatchlist = useCallback(
    async (show: any): Promise<boolean> => {
      if (!show) return false;
      const showId = String(show.id || (show.tmdb_id ? `tmdb-${show.kind || show.category || 'movie'}-${show.tmdb_id}` : ''));
      if (!showId) return false;

      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        const wasWatch = isWatchlist(show);
        const nextWatch = !wasWatch;

        // Actualización optimista inmediata
        setLists((prevLists) => {
          return prevLists.map((l) => {
            if (l.system_type !== "watchlist") return l;
            const items = l.items ? [...l.items] : [];
            if (wasWatch) {
              const filtered = items.filter((it) => !matchesShow(it, show));
              return { ...l, items: filtered, _count: { items: filtered.length } };
            } else {
              const tmdbId = Number(show.tmdb_id);
              const year = Number(show.year);
              const rating = Number(show.rating);
              const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");
              const newItem: UserListItemData = {
                id: `opt-${Date.now()}`,
                list_id: l.id,
                show_id: showId,
                tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
                title: String(show.title || "").trim(),
                poster_url: show.poster_url || show.poster_path || null,
                backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
                kind: show.kind || show.category || "movie",
                year: Number.isInteger(year) && year > 0 ? year : null,
                rating: Number.isFinite(rating) && rating > 0 ? rating : null,
                genres: genresStr || null,
                added_at: new Date().toISOString(),
              };
              return { ...l, items: [newItem, ...items], _count: { items: items.length + 1 } };
            }
          });
        });

        try {
          const res = await fetch("/api/lists/toggle", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ systemType: "watchlist", show }),
          });
          if (res.ok) {
            const data = await res.json();
            notifyListsUpdated();
            return data.active;
          }
        } catch (err) {
          console.error("[Lists] Error toggle watchlist:", err);
          fetchLists();
        }
        return nextWatch;
      }

      // Modo invitado
      const current = readGuestLists();
      let wList = current.find((l) => l.system_type === "watchlist");
      if (!wList) {
        wList = {
          id: "guest-watchlist",
          name: "Ver más tarde",
          description: "Títulos guardados para ver próximamente",
          is_system: true,
          system_type: "watchlist",
          icon: "clock",
          items: [],
          _count: { items: 0 },
        };
        current.unshift(wList);
      }
      wList.items = wList.items || [];
      const existsIdx = wList.items.findIndex((item) => matchesShow(item, show));
      let active = false;

      if (existsIdx >= 0) {
        wList.items.splice(existsIdx, 1);
        active = false;
      } else {
        const tmdbId = Number(show.tmdb_id);
        const year = Number(show.year);
        const rating = Number(show.rating);
        const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");
        wList.items.unshift({
          id: `item-${Date.now()}`,
          list_id: wList.id,
          show_id: showId,
          tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
          title: String(show.title || "").trim(),
          poster_url: show.poster_url || show.poster_path || null,
          backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
          kind: show.kind || show.category || "movie",
          year: Number.isInteger(year) && year > 0 ? year : null,
          rating: Number.isFinite(rating) && rating > 0 ? rating : null,
          genres: genresStr || null,
          added_at: new Date().toISOString(),
        });
        active = true;
      }

      wList._count = { items: wList.items.length };
      saveGuestLists(current);
      setLists([...current]);
      notifyListsUpdated();
      return active;
    },
    [isAuthenticated, isWatchlist, fetchLists]
  );

  // Añadir show a lista específica
  const addShowToList = useCallback(
    async (listId: string, show: any): Promise<boolean> => {
      if (!show) return false;
      const showId = String(show.id || (show.tmdb_id ? `tmdb-${show.kind || show.category || 'movie'}-${show.tmdb_id}` : ''));
      if (!showId) return false;

      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        try {
          const res = await fetch(`/api/lists/${listId}/items`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ show }),
          });
          if (res.ok) {
            notifyListsUpdated();
            return true;
          }
        } catch (err) {
          console.error("[Lists] Error añadiendo a lista:", err);
        }
        return false;
      }

      // Modo invitado
      const current = readGuestLists();
      const list = current.find((l) => l.id === listId);
      if (!list) return false;
      list.items = list.items || [];
      if (list.items.some((item) => matchesShow(item, show))) return true;

      const tmdbId = Number(show.tmdb_id);
      const year = Number(show.year);
      const rating = Number(show.rating);
      const genresStr = Array.isArray(show.genres) ? show.genres.join(", ") : String(show.genres || "");
      list.items.unshift({
        id: `item-${Date.now()}`,
        list_id: list.id,
        show_id: showId,
        tmdb_id: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
        title: String(show.title || "").trim(),
        poster_url: show.poster_url || show.poster_path || null,
        backdrop_url: show.backdrop_url || show.backdrop_path || show.banner_url || null,
        kind: show.kind || show.category || "movie",
        year: Number.isInteger(year) && year > 0 ? year : null,
        rating: Number.isFinite(rating) && rating > 0 ? rating : null,
        genres: genresStr || null,
        added_at: new Date().toISOString(),
      });
      list._count = { items: list.items.length };
      saveGuestLists(current);
      setLists([...current]);
      notifyListsUpdated();
      return true;
    },
    [isAuthenticated]
  );

  // Quitar show de lista específica
  const removeShowFromList = useCallback(
    async (listId: string, showOrId: any): Promise<boolean> => {
      const showId = typeof showOrId === 'object' && showOrId !== null ? String(showOrId.id || '') : String(showOrId || '');
      if (!showId) return false;

      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        // Optimistic
        setLists((prev) =>
          prev.map((l) => {
            if (l.id !== listId) return l;
            const filtered = (l.items || []).filter((it) => !matchesShow(it, showOrId));
            return { ...l, items: filtered, _count: { items: filtered.length } };
          })
        );

        try {
          const res = await fetch(`/api/lists/${listId}/items/${encodeURIComponent(showId)}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              Accept: "application/json",
            },
          });
          if (res.ok) {
            notifyListsUpdated();
            return true;
          }
        } catch (err) {
          console.error("[Lists] Error eliminando de lista:", err);
          fetchLists();
        }
        return false;
      }

      // Modo invitado
      const current = readGuestLists();
      const list = current.find((l) => l.id === listId);
      if (!list || !list.items) return false;
      const prevLen = list.items.length;
      list.items = list.items.filter((item) => !matchesShow(item, showOrId));
      if (list.items.length !== prevLen) {
        list._count = { items: list.items.length };
        saveGuestLists(current);
        setLists([...current]);
        notifyListsUpdated();
        return true;
      }
      return false;
    },
    [isAuthenticated, fetchLists]
  );

  // Crear nueva lista
  const createList = useCallback(
    async (name: string, description?: string, icon?: string): Promise<UserListData | null> => {
      if (!name.trim()) return null;
      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        try {
          const res = await fetch("/api/lists", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name, description, icon }),
          });
          if (res.ok) {
            const created = await res.json();
            notifyListsUpdated();
            return created;
          }
        } catch (err) {
          console.error("[Lists] Error creando lista:", err);
        }
        return null;
      }

      // Modo invitado
      const current = readGuestLists();
      const newList: UserListData = {
        id: `guest-list-${Date.now()}`,
        name: name.trim().slice(0, 80),
        description: description?.trim().slice(0, 300) || "",
        icon: icon || "list",
        is_system: false,
        created_at: new Date().toISOString(),
        items: [],
        _count: { items: 0 },
      };
      current.push(newList);
      saveGuestLists(current);
      setLists([...current]);
      notifyListsUpdated();
      return newList;
    },
    [isAuthenticated]
  );

  // Actualizar lista
  const updateList = useCallback(
    async (id: string, name: string, description?: string, icon?: string): Promise<boolean> => {
      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        try {
          const res = await fetch(`/api/lists/${id}`, {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${currentToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name, description, icon }),
          });
          if (res.ok) {
            notifyListsUpdated();
            return true;
          }
        } catch (err) {
          console.error("[Lists] Error actualizando lista:", err);
        }
        return false;
      }

      // Modo invitado
      const current = readGuestLists();
      const list = current.find((l) => l.id === id);
      if (!list || list.is_system) return false;
      list.name = name.trim().slice(0, 80);
      if (description !== undefined) list.description = description.trim().slice(0, 300);
      if (icon !== undefined) list.icon = icon;
      saveGuestLists(current);
      setLists([...current]);
      notifyListsUpdated();
      return true;
    },
    [isAuthenticated]
  );

  // Eliminar lista
  const deleteList = useCallback(
    async (id: string): Promise<boolean> => {
      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        try {
          const res = await fetch(`/api/lists/${id}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${currentToken}`,
            },
          });
          if (res.ok) {
            notifyListsUpdated();
            return true;
          }
        } catch (err) {
          console.error("[Lists] Error eliminando lista:", err);
        }
        return false;
      }

      // Modo invitado
      const current = readGuestLists();
      const next = current.filter((l) => l.id !== id || l.is_system);
      saveGuestLists(next);
      setLists(next);
      notifyListsUpdated();
      return true;
    },
    [isAuthenticated]
  );

  // Obtener detalle de lista
  const fetchListDetails = useCallback(
    async (id: string): Promise<UserListData | null> => {
      const currentToken = getAuthToken();
      if (isAuthenticated && currentToken) {
        try {
          const res = await fetch(`/api/lists/${id}`, {
            headers: {
              Authorization: `Bearer ${currentToken}`,
              Accept: "application/json",
            },
          });
          if (res.ok) {
            return await res.json();
          }
        } catch (err) {
          console.error("[Lists] Error detalle lista:", err);
        }
      }

      // Modo invitado o fallback
      const current = readGuestLists();
      return current.find((l) => l.id === id) || null;
    },
    [isAuthenticated]
  );

  return {
    lists,
    favorites,
    watchlist,
    customLists,
    isLoading,
    isFavorite,
    isWatchlist,
    isInList,
    getListsForShow,
    toggleFavorite,
    toggleWatchlist,
    addShowToList,
    removeShowFromList,
    createList,
    updateList,
    deleteList,
    fetchListDetails,
    refreshLists: fetchLists,
  };
}
