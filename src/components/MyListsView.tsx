// src/components/MyListsView.tsx
import React, { useEffect, useState, useMemo } from "react";
import {
  Heart,
  Clock,
  FolderPlus,
  Plus,
  Trash2,
  Edit2,
  Film,
  Sparkles,
  Check,
  X,
  Layers,
  ArrowRight,
} from "lucide-react";
import { useUserLists, type UserListData } from "../hooks/useUserLists";
import { MediaCard } from "./MediaCard";
import type { Show } from "../types";
import { isNativeShell, nativeHaptic } from "../utils/runtime";

interface MyListsViewProps {
  onSelectMedia: (show: Show) => void;
  onExploreCatalog?: () => void;
}

export const MyListsView: React.FC<MyListsViewProps> = ({ onSelectMedia, onExploreCatalog }) => {
  const {
    lists,
    favorites,
    removeShowFromList,
    createList,
    updateList,
    deleteList,
  } = useUserLists();
  const nativeShell = isNativeShell();

  const pushListOverlay = (overlay: 'list-create' | 'list-edit') => {
    if (!nativeShell) return;
    window.history.pushState({ ...(window.history.state || {}), meristream_native_overlay: overlay }, '');
  };

  const closeListOverlay = (overlay: 'list-create' | 'list-edit', close: () => void) => {
    nativeHaptic(4);
    if (nativeShell && window.history.state?.meristream_native_overlay === overlay && window.history.length > 1) {
      window.history.back();
      return;
    }
    close();
  };

  const [activeListId, setActiveListId] = useState<string>(() => {
    return favorites?.id || "guest-favorites";
  });

  const [isCreatingModal, setIsCreatingModal] = useState<boolean>(false);
  const [newListName, setNewListName] = useState<string>("");
  const [newListDesc, setNewListDesc] = useState<string>("");

  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editName, setEditName] = useState<string>("");
  const [editDesc, setEditDesc] = useState<string>("");

  // Lista activa
  const currentList = useMemo(() => {
    return lists.find((l) => l.id === activeListId) || favorites || lists[0] || null;
  }, [lists, activeListId, favorites]);

  const itemsAsShows = useMemo((): Show[] => {
    if (!currentList?.items) return [];
    return currentList.items.map((item) => ({
      id: item.show_id,
      title: item.title,
      tmdb_id: item.tmdb_id || undefined,
      poster_url: item.poster_url || "",
      banner_url: item.backdrop_url || item.poster_url || "",
      backdrop_url: item.backdrop_url || item.poster_url || "",
      category: item.kind || "movie",
      kind: (item.kind as any) || "movie",
      year: item.year || undefined,
      rating: item.rating || 0,
      genres: item.genres || "General",
      description: "",
      normalized_title: item.title.toLowerCase(),
      status: "Finalizado",
      sources: { master_m3u8: "", fallback_mp4: null, qualities: [], subtitles: [] },
    }));
  }, [currentList]);

  const handleCreateList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListName.trim()) return;
    const created = await createList(newListName.trim(), newListDesc.trim());
    if (created) {
      setActiveListId(created.id);
      closeListOverlay('list-create', () => setIsCreatingModal(false));
      setNewListName("");
      setNewListDesc("");
    }
  };

  const handleStartEdit = (list: UserListData) => {
    nativeHaptic();
    setEditingListId(list.id);
    setEditName(list.name);
    setEditDesc(list.description || "");
    pushListOverlay('list-edit');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingListId || !editName.trim()) return;
    await updateList(editingListId, editName.trim(), editDesc.trim());
    closeListOverlay('list-edit', () => setEditingListId(null));
  };

  useEffect(() => {
    if (!nativeShell) return;
    const onPopState = () => {
      setIsCreatingModal(false);
      setEditingListId(null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [nativeShell]);

  const handleDeleteList = async (listId: string) => {
    if (window.confirm("¿Seguro que deseas eliminar esta lista personalizada?")) {
      await deleteList(listId);
      setActiveListId(favorites?.id || "guest-favorites");
    }
  };

  return (
    <section className="space-y-8 animate-in fade-in duration-300">
      {/* CABECERA PRINCIPAL */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
        <div>
          <p className="section-kicker flex items-center gap-1.5 text-amber-400">
            <Layers size={14} />
            <span>Colecciones personales</span>
          </p>
          <h2 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Mis Listas y Favoritos
          </h2>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Organiza tus historias preferidas, listas para maratonear y títulos para ver más tarde.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            nativeHaptic();
            setIsCreatingModal(true);
            pushListOverlay('list-create');
          }}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition shadow-sm"
        >
          <Plus size={15} />
          <span>Nueva Lista</span>
        </button>
      </div>

      {/* TABS DE SELECCIÓN DE LISTAS */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
        {lists.map((list) => {
          const isFav = list.system_type === "favorites";
          const isWatch = list.system_type === "watchlist";
          const isActive = currentList?.id === list.id;
          const count = list._count?.items || list.items?.length || 0;

          return (
            <button
              key={list.id}
              type="button"
              onClick={() => setActiveListId(list.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition border ${
                isActive
                  ? isFav
                    ? "bg-rose-500/20 border-rose-500/60 text-rose-300 shadow-md shadow-rose-500/10"
                    : isWatch
                    ? "bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-md shadow-amber-500/10"
                    : "bg-purple-500/20 border-purple-500/60 text-purple-300 shadow-md shadow-purple-500/10"
                  : "bg-zinc-900/80 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 hover:border-zinc-700"
              }`}
            >
              {isFav ? (
                <Heart size={14} className={isActive ? "fill-current text-rose-400" : "text-rose-400"} />
              ) : isWatch ? (
                <Clock size={14} className="text-amber-400" />
              ) : (
                <FolderPlus size={14} className="text-purple-400" />
              )}
              <span>{list.name}</span>
              <span
                className={`px-1.5 py-0.5 rounded-md text-[10px] font-mono ${
                  isActive ? "bg-white/15 text-white" : "bg-zinc-800 text-zinc-500"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* CONTENIDO DE LA LISTA ACTIVA */}
      {currentList && (
        <div className="space-y-6">
          {/* DETALLES DE LA LISTA ACTIVA */}
          <div className="flex flex-wrap items-center justify-between gap-4 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 sm:p-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5">
                <h3 className="text-lg sm:text-xl font-bold text-white">{currentList.name}</h3>
                <span className="text-xs text-zinc-500 font-mono">
                  ({itemsAsShows.length} {itemsAsShows.length === 1 ? "título" : "títulos"})
                </span>
              </div>
              {currentList.description && (
                <p className="text-xs sm:text-sm text-zinc-400">{currentList.description}</p>
              )}
            </div>

            {!currentList.is_system && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleStartEdit(currentList)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium border border-zinc-700 transition"
                >
                  <Edit2 size={13} />
                  <span>Editar</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteList(currentList.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-medium border border-rose-500/20 transition"
                >
                  <Trash2 size={13} />
                  <span>Eliminar lista</span>
                </button>
              </div>
            )}
          </div>

          {/* GRID DE ELEMENTOS */}
          {itemsAsShows.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
              {itemsAsShows.map((show) => (
                <div key={show.id} className="relative group">
                  <MediaCard media={show} onSelectMedia={onSelectMedia} />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeShowFromList(currentList.id, show.id);
                    }}
                    title="Quitar de esta lista"
                    data-list-remove
                    className="absolute top-2 right-2 z-20 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-full bg-black/80 hover:bg-rose-600 text-zinc-300 hover:text-white backdrop-blur-md shadow-lg"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center space-y-4 bg-zinc-950/40 border border-zinc-900 rounded-2xl p-8">
              <div className="w-14 h-14 rounded-2xl bg-zinc-900 flex items-center justify-center mx-auto text-zinc-600">
                <Film size={28} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-zinc-300">
                  Aún no hay títulos en "{currentList.name}"
                </p>
                <p className="text-xs text-zinc-500 max-w-md mx-auto">
                  Explora películas, series o animes y pulsa el botón de Guardar o Favoritos para
                  agregarlos aquí.
                </p>
              </div>
              {onExploreCatalog && (
                <button
                  type="button"
                  onClick={onExploreCatalog}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-200 border border-zinc-700 transition"
                >
                  <span>Explorar catálogo</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* MODAL CREAR NUEVA LISTA */}
      {isCreatingModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="native-list-modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          onClick={() => closeListOverlay('list-create', () => setIsCreatingModal(false))}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="native-list-modal-panel w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-5"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center">
                  <FolderPlus size={18} />
                </div>
                <h3 className="text-base font-bold text-white">Crear Nueva Lista</h3>
              </div>
              <button
                type="button"
                onClick={() => closeListOverlay('list-create', () => setIsCreatingModal(false))}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateList} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Nombre de la lista
                </label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  placeholder="Ej. Clásicos del cine, Animes favoritos..."
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  autoFocus
                  className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-400 focus:outline-none rounded-xl px-3.5 py-2 text-xs text-white placeholder-zinc-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Descripción (opcional)
                </label>
                <textarea
                  maxLength={300}
                  rows={3}
                  placeholder="Describe de qué trata esta lista..."
                  value={newListDesc}
                  onChange={(e) => setNewListDesc(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-400 focus:outline-none rounded-xl p-3 text-xs text-white placeholder-zinc-500 resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => closeListOverlay('list-create', () => setIsCreatingModal(false))}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!newListName.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition disabled:opacity-50"
                >
                  <Sparkles size={14} />
                  <span>Crear Lista</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL EDITAR LISTA */}
      {editingListId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          onClick={() => closeListOverlay('list-edit', () => setEditingListId(null))}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="native-list-modal-panel w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-5"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="text-base font-bold text-white">Editar Lista</h3>
              <button
                type="button"
                onClick={() => closeListOverlay('list-edit', () => setEditingListId(null))}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Nombre</label>
                <input
                  type="text"
                  required
                  maxLength={80}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-400 focus:outline-none rounded-xl px-3.5 py-2 text-xs text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Descripción</label>
                <textarea
                  maxLength={300}
                  rows={3}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-400 focus:outline-none rounded-xl p-3 text-xs text-white resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => closeListOverlay('list-edit', () => setEditingListId(null))}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!editName.trim()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition disabled:opacity-50"
                >
                  <Check size={14} />
                  <span>Guardar cambios</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
};
