// src/components/ContinueWatching.tsx
import React, { useState, useEffect } from 'react';
import { Play } from 'lucide-react';
import { extractDominantColor, rgbToRgbaString } from '../utils/colorExtractor';
import type { Episode } from '../types';

export interface WatchProgress {
  showId: string;
  showTitle: string;
  showPoster?: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  progressPercent: number; // e.g. 45 for 45%
  lastWatchedAt: number;
}

interface ContinueWatchingProps {
  items: WatchProgress[];
  onPlayEpisode: (showId: string, episode: Episode, showTitle: string) => void;
  onSelectShow?: (showId: string) => void;
}

export const ContinueWatching: React.FC<ContinueWatchingProps> = ({
  items,
  onPlayEpisode,
  onSelectShow,
}) => {
  if (!items || items.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg sm:text-xl font-bold text-white tracking-tight">
          Seguir Viendo
        </h3>
        <span className="text-xs text-zinc-500 font-mono">
          {items.length} en curso
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {items.map((item) => (
          <ContinueWatchingCard
            key={`${item.showId}-${item.episodeId}`}
            item={item}
            onPlay={() => {
              const ep: Episode = {
                id: item.episodeId,
                show_id: item.showId,
                title: item.episodeTitle,
                episode_number: item.episodeNumber,
                created_at: new Date().toISOString(),
              };
              onPlayEpisode(item.showId, ep, item.showTitle);
            }}
            onOpenDetails={() => onSelectShow && onSelectShow(item.showId)}
          />
        ))}
      </div>
    </section>
  );
};

interface ContinueWatchingCardProps {
  item: WatchProgress;
  onPlay: () => void;
  onOpenDetails: () => void;
}

const ContinueWatchingCard: React.FC<ContinueWatchingCardProps> = ({
  item,
  onPlay,
  onOpenDetails,
}) => {
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>([245, 158, 11]);

  useEffect(() => {
    if (item.showPoster) {
      extractDominantColor(item.showPoster, item.showTitle).then(setAccentRgb);
    }
  }, [item.showPoster, item.showTitle]);

  const accentColor = rgbToRgbaString(accentRgb, 1);

  return (
    <div
      onClick={onPlay}
      className="group/cw relative flex flex-col overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all duration-200 cursor-pointer select-none"
    >
      {/* 16:9 HORIZONTAL THUMBNAIL */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-zinc-950">
        {item.showPoster ? (
          <img
            src={item.showPoster}
            alt={item.showTitle}
            className="h-full w-full object-cover object-center transition-transform duration-300 ease-out group-hover/cw:scale-105"
          />
        ) : (
          <div className="h-full w-full bg-zinc-950 flex items-center justify-center text-zinc-600 text-xs">
            Sin Vista Previa
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/80 via-transparent to-transparent" />

        {/* HOVER PLAY BUTTON */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/cw:opacity-100 transition-opacity duration-200 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-black shadow-xl group-hover/cw:scale-110 transition-transform">
            <Play size={18} className="ml-0.5 fill-black text-black" />
          </span>
        </div>

        {/* EPISODE BADGE */}
        <div className="absolute top-2 left-2">
          <span className="rounded bg-black/80 px-2 py-0.5 text-[10px] font-mono font-semibold text-zinc-200 border border-zinc-800">
            Ep. {item.episodeNumber}
          </span>
        </div>

        {/* 3PX INFERIOR PROGRESS BAR */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800 overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${Math.max(5, Math.min(100, item.progressPercent))}%`,
              backgroundColor: accentColor,
            }}
          />
        </div>
      </div>

      {/* METADATOS INFERIORES */}
      <div className="p-3 space-y-0.5">
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetails();
            }}
            className="font-medium text-zinc-400 hover:text-zinc-200 truncate max-w-[70%] text-[11px] text-left"
          >
            {item.showTitle}
          </button>
          <span className="text-[10px] text-zinc-500 font-mono">
            {item.progressPercent}%
          </span>
        </div>
        <h4 className="font-display text-xs sm:text-sm font-semibold text-zinc-100 group-hover/cw:text-amber-400 truncate transition-colors">
          {item.episodeTitle || `Episodio ${item.episodeNumber}`}
        </h4>
      </div>
    </div>
  );
};
