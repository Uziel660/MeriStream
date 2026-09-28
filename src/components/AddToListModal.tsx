// src/components/AddToListModal.tsx
import React, { useState, useEffect, useCallback } from "react";
import { X, Plus, Heart, Clock, ListPlus, Check, Sparkles, FolderPlus } from "lucide-react";
import { useUserLists, type UserListData } from "../hooks/useUserLists";
import { isNativeShell, nativeHaptic } from "../utils/runtime";

interface AddToListModalProps {
  isOpen: boolean;
  onClose: () => void;
  show: any;
}

export const AddToListModal: React.FC<AddToListModalProps> = ({ isOpen, onClose, show }) => {
  const { lists, isInList, addShowToList, removeShowFromList, createList } = useUserLists();
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [newListName, setNewListName] = useState<string>("");
  const [newListDesc, setNewListDesc] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const nativeShell = isNativeShell();

  const closeSheet = useCallback(() => {
    if (nativeShell && window.history.state?.meristream_native_overlay === "add-to-list" && window.history.length > 1) {
      window.history.back();
      return;
    }
    onClose();
  }, [nativeShell, onClose]);

  useEffect(() => {
    if (isOpen) {
      setIsCreating(false);
      setNewListName("");
      setNewListDesc("");
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !nativeShell) return;
    if (window.history.state?.meristream_native_overlay !== "add-to-list") {
      window.history.pushState({ ...(window.history.state || {}), meristream_native_overlay: "add-to-list" }, "");
    }
    const onPopState = () => onClose();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isOpen, nativeShell, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) closeSheet();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeSheet]);

  if (!isOpen || !show) return null;

  const showId = String(show.id);

  const handleToggleList = async (list: UserListData) => {
    nativeHaptic(4);
    const active = isInList(list.id, showId);
    if (active) {
      await removeShowFromList(list.id, showId);
    } else {
      await addShowToList(list.id, show);
    }
  };

  const handleCreateNewList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListName.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const created = await createList(newListName.trim(), newListDesc.trim());
      if (created) {
        await addShowToList(created.id, show);
        setIsCreating(false);
        setNewListName("");
        setNewListDesc("");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Añadir a lista"
      className="add-to-list-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={closeSheet}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="add-to-list-panel w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-5 sm:p-6 shadow-2xl text-white space-y-5 animate-in zoom-in-95 duration-200"
      >
        {/* HEADER */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <ListPlus size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">Guardar en listas</h3>
              <p className="text-xs text-zinc-400 truncate max-w-[260px]">{show.title}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeSheet}
            aria-label="Cerrar modal"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* LISTAS EXISTENTES */}
        <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
          {lists.map((list) => {
            const active = isInList(list.id, showId);
            const isFav = list.system_type === "favorites";
            const isWatch = list.system_type === "watchlist";

            return (
              <button
                key={list.id}
                type="button"
                onClick={() => handleToggleList(list)}
                className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition ${
                  active
                    ? isFav
                      ? "bg-rose-500/10 border-rose-500/40 text-rose-300"
                      : isWatch
                      ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                      : "bg-purple-500/10 border-purple-500/40 text-purple-300"
                    : "bg-zinc-950/60 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/50 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                      isFav
                        ? "bg-rose-500/20 text-rose-400"
                        : isWatch
                        ? "bg-amber-500/20 text-amber-400"
                        : "bg-purple-500/20 text-purple-400"
                    }`}
                  >
                    {isFav ? <Heart size={14} className={active ? "fill-current" : ""} /> : isWatch ? <Clock size={14} /> : <FolderPlus size={14} />}
                  </div>
                  <div>
                    <p className="text-xs sm:text-sm font-semibold text-zinc-100">{list.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      {list._count?.items || list.items?.length || 0} títulos
                    </p>
                  </div>
                </div>

                <div
                  className={`w-5 h-5 rounded-md border flex items-center justify-center transition ${
                    active
                      ? isFav
                        ? "bg-rose-500 border-rose-500 text-white"
                        : isWatch
                        ? "bg-amber-500 border-amber-500 text-black font-bold"
                        : "bg-purple-500 border-purple-500 text-white"
                      : "border-zinc-700 bg-zinc-900"
                  }`}
                >
                  {active && <Check size={13} strokeWidth={3} />}
                </div>
              </button>
            );
          })}
        </div>

        {/* CREAR NUEVA LISTA INLINE */}
        {!isCreating ? (
          <button
            type="button"
            onClick={() => { nativeHaptic(4); setIsCreating(true); }}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-dashed border-zinc-700 hover:border-amber-400/60 bg-zinc-950/40 hover:bg-amber-500/5 text-xs font-semibold text-zinc-300 hover:text-amber-300 transition"
          >
            <Plus size={15} />
            <span>Crear nueva lista</span>
          </button>
        ) : (
          <form onSubmit={handleCreateNewList} className="space-y-3 pt-2 border-t border-zinc-800/80">
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Nombre de la lista
              </label>
              <input
                type="text"
                required
                maxLength={80}
                placeholder="Ej. Maratón de fin de semana, Animes de los 90s..."
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                autoFocus
                className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-400 focus:outline-none rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                Descripción (opcional)
              </label>
              <input
                type="text"
                maxLength={300}
                placeholder="Breve descripción..."
                value={newListDesc}
                onChange={(e) => setNewListDesc(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 focus:border-amber-400 focus:outline-none rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!newListName.trim() || isSubmitting}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition disabled:opacity-50"
              >
                <Sparkles size={13} />
                <span>Crear y añadir</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
