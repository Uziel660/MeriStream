import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Copy,
  Check,
  Users,
  Send,
  Share2,
  Crown,
  LogOut,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Radio,
} from 'lucide-react';
import { isNativeShell, nativeHaptic } from '../utils/runtime';
import type {
  WatchPartyRoom,
  WatchPartyParticipant,
  WatchPartyChatMessage,
  WatchPartyReaction,
} from '../hooks/useTeleparty';

export interface WatchPartyPanelProps {
  isOpen: boolean;
  onClose: () => void;
  room: WatchPartyRoom | null;
  participants: WatchPartyParticipant[];
  messages: WatchPartyChatMessage[];
  reactions: WatchPartyReaction[];
  isHost: boolean;
  sendMessage: (text: string, isEmoji?: boolean) => void;
  sendReaction: (emoji: string) => void;
  currentUserId?: string | null;
  onLeaveRoom?: () => void;
  disconnect?: () => void;
  hostName?: string;
}

const QUICK_EMOJIS = ['❤️', '😂', '😮', '👏', '🔥', '🎉'];

export function WatchPartyPanel({
  isOpen,
  onClose,
  room,
  participants,
  messages,
  isHost,
  sendMessage,
  sendReaction,
  currentUserId,
  onLeaveRoom,
  disconnect,
  hostName,
}: WatchPartyPanelProps) {
  const nativeShell = isNativeShell();
  const [inputText, setInputText] = useState('');
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth <= 640;
    }
    return false;
  });

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shareCopyTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Resize listener for responsive drawer vs bottom sheet
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth <= 640);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!nativeShell || !isOpen) return;
    const onNativeBack = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    window.addEventListener('meristream:native-back', onNativeBack);
    return () => window.removeEventListener('meristream:native-back', onNativeBack);
  }, [nativeShell, isOpen, onClose]);

  // Autoscroll chat on new messages
  useEffect(() => {
    if (isOpen && chatScrollRef.current) {
      if (typeof chatScrollRef.current.scrollTo === 'function') {
        chatScrollRef.current.scrollTo({
          top: chatScrollRef.current.scrollHeight,
          behavior: 'smooth',
        });
      } else {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
    }
  }, [messages, isOpen]);

  // Clean copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      if (shareCopyTimeoutRef.current) {
        clearTimeout(shareCopyTimeoutRef.current);
      }
    };
  }, []);

  const roomCode = useMemo(() => {
    return room?.roomCode || room?.code || '';
  }, [room]);

  const shareUrl = useMemo(() => {
    if (!roomCode || typeof window === 'undefined') return '';
    const url = new URL(window.location.origin);
    url.searchParams.set('party', roomCode);
    return url.toString();
  }, [roomCode]);

  const hostUsername = useMemo(() => {
    if (hostName) return hostName;
    if (room?.hostUsername) return room.hostUsername;
    const host = participants.find((p) => p.isHost);
    return host?.username || 'Anfitrión';
  }, [hostName, room, participants]);

  const handleCopyCode = useCallback(() => {
    if (!roomCode) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(roomCode);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = roomCode;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // ignore
    }
  }, [roomCode]);

  const handleCopyShareLink = useCallback(() => {
    if (!shareUrl) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(shareUrl);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = shareUrl;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setShareCopied(true);
      if (shareCopyTimeoutRef.current) clearTimeout(shareCopyTimeoutRef.current);
      shareCopyTimeoutRef.current = setTimeout(() => setShareCopied(false), 2200);
    } catch {
      // ignore
    }
  }, [shareUrl]);

  const handleSendMessage = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      const trimmed = inputText.trim();
      if (!trimmed) return;
      sendMessage(trimmed, false);
      setInputText('');
    },
    [inputText, sendMessage]
  );

  const handleQuickReaction = useCallback(
    (emoji: string) => {
      sendReaction(emoji);
    },
    [sendReaction]
  );

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        data-testid="watch-party-panel"
        key="watch-party-panel"
        initial={isMobile ? { y: '100%' } : { x: '100%' }}
        animate={isMobile ? { y: 0 } : { x: 0 }}
        exit={isMobile ? { y: '100%' } : { x: '100%' }}
        transition={nativeShell ? { duration: 0.14 } : { type: 'spring', damping: 28, stiffness: 260 }}
        className={`watch-party-panel fixed z-[9999] flex flex-col bg-zinc-950/98 backdrop-blur-xl shadow-2xl text-zinc-100 select-none overflow-hidden border border-zinc-800 ${
          isMobile
            ? 'bottom-0 inset-x-0 w-full max-w-full max-h-[70vh] h-[65vh] border-t rounded-t-xl overflow-x-hidden'
            : 'right-0 top-0 bottom-0 w-80 md:w-96 max-w-[360px] h-full border-l'
        }`}
      >
        {/* ========================================================================= */}
        {/* ROOM HEADER                                                               */}
        {/* ========================================================================= */}
        <div className="flex flex-col border-b border-zinc-800 bg-zinc-900/60 p-2 sm:p-3 shrink-0">
          {/* Top Row: Title, Room Code, Controls */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-400"></span>
                <span className="text-xs font-bold uppercase tracking-wider text-amber-300">
                  Sala compartida
                </span>
              </div>

              {/* Room Code Badge & Copy */}
              {roomCode && (
                <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700/80 rounded-lg px-2 py-0.5">
                  <span
                    data-testid="room-code-display"
                    className="font-mono text-xs font-bold tracking-wider text-white"
                  >
                    {roomCode}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    data-testid="copy-code-button"
                    aria-label="Copiar código de sala"
                    title={copied ? '¡Copiado!' : 'Copiar código de sala'}
                    className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition flex items-center gap-1"
                  >
                    {copied ? (
                      <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-semibold px-1">
                        <Check size={12} className="text-emerald-400" />
                        <span>¡Copiado!</span>
                      </span>
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Header Actions: Participant Count, Leave, Close */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setShowParticipants((prev) => !prev)}
                data-testid="toggle-participants-button"
                className="flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs text-zinc-300 transition"
                title="Ver participantes"
              >
                <Users size={13} className="text-amber-300" />
                <span data-testid="participant-count">{participants.length}</span>
                {showParticipants ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>

              {(onLeaveRoom || disconnect) && (
                <button
                  type="button"
                  onClick={() => {
                    if (disconnect) disconnect();
                    if (onLeaveRoom) onLeaveRoom();
                  }}
                  data-testid="leave-room-button"
                  className="p-1.5 rounded-lg hover:bg-rose-950/40 text-zinc-400 hover:text-rose-400 border border-transparent hover:border-rose-900/50 transition"
                  title="Salir de la sala"
                >
                  <LogOut size={14} />
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                data-testid="close-panel-button"
                className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white border border-transparent hover:border-zinc-700 transition"
                title="Cerrar panel"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {shareUrl && (
            <div
              data-testid="watch-party-share-link"
              className="mt-2 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 px-2 py-1.5"
            >
              <Share2 size={13} className="shrink-0 text-amber-300" aria-hidden="true" />
              <input
                type="text"
                readOnly
                value={shareUrl}
                aria-label="Enlace para compartir la sala"
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-300 outline-none"
              />
              <button
                type="button"
                onClick={handleCopyShareLink}
                data-testid="copy-share-link-button"
                aria-label={shareCopied ? 'Enlace copiado' : 'Copiar enlace de la sala'}
                title={shareCopied ? '¡Enlace copiado!' : 'Copiar enlace de la sala'}
                className="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold text-amber-300 transition hover:bg-zinc-800 hover:text-amber-200"
              >
                {shareCopied ? 'Copiado' : 'Copiar enlace'}
              </button>
            </div>
          )}

          {/* Viewer Mode Banner */}
          {!isHost && (
            <div
              data-testid="viewer-indicator-banner"
              className="mt-2 flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 text-xs text-amber-100"
            >
              <Radio size={13} className="text-amber-300 shrink-0" />
              <span className="truncate">
                Controlado por el anfitrión:{' '}
                <strong className="text-white font-medium">{hostUsername}</strong>
              </span>
            </div>
          )}

          {/* Expandable Participants Drawer */}
          <AnimatePresence>
            {showParticipants && (
              <motion.div
                data-testid="participants-list"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden mt-2 pt-2 border-t border-zinc-800/60"
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5 flex items-center justify-between">
                  <span>Participantes ({participants.length})</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                  {participants.map((p) => {
                    const isSelf = currentUserId && p.userId === currentUserId;
                    return (
                      <div
                        key={p.userId}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded-md bg-zinc-900/60 text-xs"
                      >
                        <div className="flex items-center gap-2 truncate">
                          {p.avatar ? (
                            <img
                              src={p.avatar}
                              alt={p.username}
                              className="w-5 h-5 rounded-full object-cover shrink-0"
                            />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[10px] font-semibold text-amber-100 flex items-center justify-center shrink-0">
                              {p.username.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span className="truncate text-zinc-200">
                            {p.username} {isSelf && <span className="text-zinc-500">(tú)</span>}
                          </span>
                        </div>
                        {p.isHost && (
                          <span
                            data-testid="host-badge"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0"
                          >
                            <Crown size={10} className="text-amber-400" />
                            <span>👑 Anfitrión</span>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ========================================================================= */}
        {/* INTERACTIVE CHAT FEED                                                     */}
        {/* ========================================================================= */}
        <div
          ref={chatScrollRef}
          data-testid="chat-messages-container"
          className="flex-1 overflow-y-auto min-h-0 p-2 sm:p-3 space-y-2.5 text-xs select-text"
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 text-center py-6">
              <MessageSquare size={28} className="mb-2 text-zinc-600 opacity-60" />
              <p className="text-xs">¡No hay mensajes todavía!</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Escribe en el chat o envía una reacción para animar la sala.
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const isSelf = currentUserId && msg.userId === currentUserId;
              const senderIsHost = participants.find((p) => p.userId === msg.userId)?.isHost;
              const timeStr = new Date(msg.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              });

              if (msg.isEmoji) {
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}
                  >
                    <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-0.5">
                      <span className={senderIsHost ? 'text-amber-300 font-semibold' : ''}>
                        {msg.username}
                      </span>
                      <span>•</span>
                      <span>{timeStr}</span>
                    </div>
                    <div className="text-3xl py-0.5 select-none">{msg.text}</div>
                  </div>
                );
              }

              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}
                >
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500 mb-0.5">
                    <span
                      className={`font-medium ${
                        isSelf
                          ? 'text-amber-300'
                          : senderIsHost
                          ? 'text-amber-300 font-semibold'
                          : 'text-zinc-400'
                      }`}
                    >
                      {msg.username}
                    </span>
                    <span>•</span>
                    <span>{timeStr}</span>
                  </div>
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-1.5 text-xs break-words shadow-sm ${
                      isSelf
                        ? 'bg-amber-500 text-zinc-950 rounded-tr-none'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-none'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ========================================================================= */}
        {/* QUICK EMOJI REACTION PICKER BAR                                           */}
        {/* ========================================================================= */}
        <div
          data-testid="emoji-reaction-bar"
          className="flex flex-wrap items-center justify-around gap-1 px-1 sm:px-2 py-1 bg-zinc-900/80 border-t border-zinc-800/60 shrink-0"
        >
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => { nativeHaptic(4); handleQuickReaction(emoji); }}
              data-testid={`quick-emoji-${emoji}`}
              aria-label={`Reacción ${emoji}`}
              title={`Reaccionar con ${emoji}`}
              className="p-1 sm:p-1.5 rounded-lg hover:bg-zinc-800 hover:scale-125 active:scale-95 transition text-base sm:text-lg select-none"
            >
              {emoji}
            </button>
          ))}
        </div>

        {/* ========================================================================= */}
        {/* TEXT MESSAGE INPUT                                                        */}
        {/* ========================================================================= */}
        <form
          onSubmit={handleSendMessage}
          data-testid="chat-input-form"
          className="flex items-center gap-1.5 p-2 sm:p-3 border-t border-zinc-800/80 bg-zinc-950/90 shrink-0"
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            data-testid="chat-text-input"
            placeholder="Escribe un mensaje..."
            maxLength={300}
            className="flex-1 bg-zinc-900/90 border border-zinc-800 rounded-lg px-3 py-2 text-xs sm:text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-amber-400 transition"
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            data-testid="send-message-button"
            aria-label="Enviar mensaje"
            className="p-2 sm:p-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-950 transition flex items-center justify-center shrink-0"
          >
            <Send size={15} />
          </button>
        </form>
      </motion.div>
    </AnimatePresence>
  );
}
