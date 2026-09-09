// src/components/AdminPanel.tsx
import React, { useState, useEffect } from 'react';
import {
  X,
  Search,
  Layers,
  Film,
  Tv,
  Check,
  Loader2,
  AlertCircle,
  Play,
  Database,
  Trash2,
  RefreshCw,
  Plus,
  Activity,
  Globe,
  Terminal,
  ShieldCheck,
  FileVideo,
  Edit3,
  Sliders,
  Pause,
  Settings,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Star,
  ListFilter
} from 'lucide-react';
import type { Show, ScraperPreset, UniversalAnalysisResult, BackgroundWorkerJob, WorkerSettings } from '../types';
import WorkerSettingsCard from './WorkerSettingsCard';
import ShowEditModal from './ShowEditModal';
import VerificationPanel from './VerificationPanel';
import ServerTesterCard from './ServerTesterCard';
import { GenresManager } from './GenresManager';
import AdminOverview, { type AdminTab } from './AdminOverview';

export interface AdminPlayStreamResult {
  title?: string;
  stream_url?: string;
  all_streams?: string[];
  [key: string]: any;
}

interface AdminPanelProps {
  isOpen?: boolean;
  onClose?: () => void;
  onPlayDirect?: (streamResult: AdminPlayStreamResult | UniversalAnalysisResult) => void;
  onPlay?: (streamResult: AdminPlayStreamResult | UniversalAnalysisResult) => void;
  onPlayStream?: (streamResult: AdminPlayStreamResult | UniversalAnalysisResult) => void;
  [key: string]: any;
}

export const AdminPanel: React.FC<AdminPanelProps> = (props) => {
  const { isOpen = true, onClose } = props;
  const onPlayHandler = props.onPlayDirect || props.onPlay || props.onPlayStream;

  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [editingShow, setEditingShow] = useState<any>(null);

  // --- Fuentes: ratings de sitios + toggle del selector de servidores ---
  const [siteRatings, setSiteRatings] = useState<Array<{ site: string; rating: number; enabled: boolean; notes: string | null }>>([]);
  const [showSelectorAlways, setShowSelectorAlways] = useState<boolean>(() => {
    try {
      return localStorage.getItem('voidstream_show_server_selector') === 'true';
    } catch {
      return false;
    }
  });

  const loadSiteRatings = async () => {
    try {
      const res = await fetch('/api/v1/sites/ratings');
      if (res.ok) {
        const data = await res.json();
        setSiteRatings(Array.isArray(data.ratings) ? data.ratings : []);
      }
    } catch (e) {
      console.error('Error cargando ratings de sitios:', e);
    }
  };

  const handleSaveSiteRating = async (site: string, patch: { rating?: number; enabled?: boolean }) => {
    try {
      await fetch('/api/v1/sites/ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, ...patch }),
      });
      await loadSiteRatings();
    } catch (e) {
      console.error('Error guardando rating:', e);
    }
  };

  // Reordenar prioridad premium de plataformas: intercambia el rating con el
  // vecino en la lista ordenada (rating DESC = prioridad). Empates: empuja 0.5.
  // Usa endpoint batch /swap para evitar race condition entre dos saves separados.
  const moveSitePriority = async (site: string, dir: -1 | 1) => {
    const sorted = [...siteRatings].sort((a, b) => b.rating - a.rating || a.site.localeCompare(b.site));
    const idx = sorted.findIndex((s) => s.site === site);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[swapIdx];
    try {
      let newA: number, newB: number;
      if (a.rating === b.rating) {
        newA = Math.min(10, Math.max(0, a.rating + (dir === -1 ? 0.5 : -0.5)));
        newB = b.rating;
      } else {
        newA = b.rating;
        newB = a.rating;
      }
      const res = await fetch('/api/v1/sites/ratings/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteA: a.site, ratingA: newA, siteB: b.site, ratingB: newB }),
      });
      if (res.ok) {
        const data = await res.json();
        setSiteRatings(Array.isArray(data.ratings) ? data.ratings : []);
      }
    } catch (e) {
      console.error('Error moviendo prioridad:', e);
    }
  };

  const handleToggleSelectorAlways = (enabled: boolean) => {
    setShowSelectorAlways(enabled);
    try {
      localStorage.setItem('voidstream_show_server_selector', String(enabled));
      // El reproductor (HLSPlayerModal) escucha este evento para reflejar el
      // toggle al instante; 'storage' solo se dispara entre pestañas distintas.
      window.dispatchEvent(new CustomEvent('voidstream:server-selector-changed'));
    } catch {
      // almacenamiento no disponible: el toggle solo vive en esta sesión
    }
  };

  // --- Presets ---
  const [presets, setPresets] = useState<ScraperPreset[]>([]);
  const [editingPreset, setEditingPreset] = useState<ScraperPreset | null>(null);
  const [editingUrlInput, setEditingUrlInput] = useState('');
  const [isSavingPreset, setIsSavingPreset] = useState(false);

  const loadPresets = async () => {
    try {
      const res = await fetch('/api/v1/scraper/presets');
      if (res.ok) {
        const data: ScraperPreset[] = await res.json();
        setPresets(data);
      }
    } catch (e) {
      console.error('Error cargando presets:', e);
    }
  };

  const handleSaveCustomPresetUrl = async (presetId: string, newUrl: string) => {
    const trimmed = newUrl.trim();
    if (!trimmed) return;
    setIsSavingPreset(true);
    try {
      const res = await fetch(`/api/v1/scraper/presets/${presetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ example_url: trimmed }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.presets) {
          setPresets(data.presets);
        } else {
          await loadPresets();
        }
        setImportMessage('Enlace guardado globalmente en el servidor para todos los usuarios.');
        setEditingPreset(null);
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Error al guardar en el servidor');
      }
    } catch (e: any) {
      setAnalysisError(e.message || 'Error al guardar el preset');
    } finally {
      setIsSavingPreset(false);
    }
  };

  const handleResetCustomPresetUrl = async (presetId: string) => {
    setIsSavingPreset(true);
    try {
      const res = await fetch(`/api/v1/scraper/presets/${presetId}/reset`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.presets) {
          setPresets(data.presets);
          const found = data.presets.find((p: ScraperPreset) => p.id === presetId);
          if (found) setEditingUrlInput(found.example_url);
        } else {
          await loadPresets();
        }
        setImportMessage('Enlace restablecido al valor original en el servidor.');
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Error al restablecer preset en el servidor');
      }
    } catch (e: any) {
      setAnalysisError(e.message || 'Error al restablecer preset');
    } finally {
      setIsSavingPreset(false);
    }
  };

  // --- Explorador Inteligente & Analizador Universal ---
  const [smartUrl, setSmartUrl] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<UniversalAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isEditingMetadata, setIsEditingMetadata] = useState(false);
  const [editedShow, setEditedShow] = useState<any | null>(null);
  const [importingCardUrl, setImportingCardUrl] = useState<string | null>(null);
  const [importedCardUrls, setImportedCardUrls] = useState<string[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  // --- Ingesta en Lote (Batch Ingestion) ---// removed unused state// removed unused state// removed unused state// removed unused state

  // --- Crawler & Monitor de Tarea en Vivo ---// removed unused state// removed unused state// removed unused state// removed unused state
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);// removed unused state

  // --- Background Worker Tasks & Queue State ---
  const [workerJobs, setWorkerJobs] = useState<BackgroundWorkerJob[]>([]);
  const [workerSettings, setWorkerSettings] = useState<WorkerSettings>({
    default_delay_ms: 1500,
    jitter_enabled: true,
    max_concurrent_jobs: 1,
    user_agent_rotation: true,
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // --- Biblioteca & Catálogo ---
  const [libraryShows, setLibraryShows] = useState<Show[]>([]);
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryTotal, setLibraryTotal] = useState(0);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [libraryPage, setLibraryPage] = useState(1);
  const LIBRARY_PAGE_SIZE = 50;

  // Cargar presets y settings de worker al montar
  useEffect(() => {
    loadPresets();
    loadSiteRatings();

    fetch('/api/v1/worker/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setWorkerSettings(data);
      })
      .catch(() => {});
  }, []);

  // Polling eficiente de la lista de tareas del Worker
  useEffect(() => {
    let isMounted = true;
    const fetchWorkerJobs = async () => {
      try {
        const res = await fetch('/api/v1/worker/jobs');
        if (res.ok && isMounted) {
          const jobs: BackgroundWorkerJob[] = await res.json();
          setWorkerJobs(jobs);

          // Si hay una tarea activa en ejecución y no hay seleccionada, fijar su progreso
          const running = jobs.find((j) => j.status === 'running' || j.status === 'pending');
          if (running && !activeTaskId) {
            setActiveTaskId(running.id);
          }
        }
      } catch (e) {
        console.error(e);
      }
    };

    fetchWorkerJobs();
    // Ritmo inteligente: 2.5s en la pestaña del worker; 15s en otras pestañas
    const pollIntervalMs = activeTab === 'worker_tasks' ? 2500 : 15000;
    const interval = setInterval(fetchWorkerJobs, pollIntervalMs);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeTaskId, activeTab]);

  // Polling detallado de la tarea seleccionada / activa (solo si está activa y no finalizada)
  useEffect(() => {
    if (activeTab !== 'worker_tasks') return;
    const targetId = selectedJobId || activeTaskId;
    if (!targetId) return;

    const current = workerJobs.find((j) => j.id === targetId);
    if (current && (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled')) {
      return;
    }

    let isMounted = true;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/tasks/${targetId}`);
        if (res.ok && isMounted) {
          const data = await res.json();
          setWorkerJobs((prev) =>
            prev.map((job) => (job.id === targetId ? { ...job, ...data } : job))
          );
          if (data.status === 'completed') {
            loadLibrary(librarySearch, 1, false);
          }
        }
      } catch (e) {
        console.error(e);
      }
    }, 2000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeTaskId, selectedJobId, activeTab, workerJobs, librarySearch]);

  const loadLibrary = async (searchQuery = librarySearch, page = 1, append = false) => {
    try {
      setIsLoadingLibrary(true);
      const q = searchQuery.trim();
      const searchParam = q ? `&search=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/v1/shows?lite=true&include_legacy=true${searchParam}&page=${page}&limit=${LIBRARY_PAGE_SIZE}`);
      if (res.ok) {
        const data = await res.json();
        const list: Show[] = Array.isArray(data) ? data : data.shows || [];
        const total = typeof data.total === 'number' ? data.total : list.length;
        setLibraryShows((prev) => (append ? [...prev, ...list] : list));
        setLibraryTotal(total);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'library' || activeTab === 'genres') {
      const timer = setTimeout(() => {
        setLibraryPage(1);
        loadLibrary(librarySearch, 1, false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [activeTab, librarySearch]);

  if (isOpen === false) return null;

  // 1. ANALIZAR CUALQUIER URL / CONSULTA UNIVERSAL
  const handleAnalyzeUrl = async (targetUrl?: string) => {
    const urlToAnalyze = (targetUrl || smartUrl).trim();
    if (!urlToAnalyze) return;

    if (targetUrl) setSmartUrl(targetUrl);
    setIsAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);
    setImportMessage(null);
    setIsEditingMetadata(false);

    try {
      const res = await fetch('/api/v1/catalog/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlToAnalyze }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Error HTTP ${res.status}`);
      }

      const data: UniversalAnalysisResult = await res.json();
      setAnalysisResult(data);
      setEditedShow({
        title: data.title,
        original_title: data.original_title || '',
        japanese_title: data.japanese_title || '',
        english_title: data.english_title || '',
        tmdb_id: data.tmdb_id || null,
        source_domain: data.source_domain,
        description: data.description,
        poster_url: data.poster_url || '',
        banner_url: data.banner_url || data.poster_url || '',
        content_type: data.content_type || 'anime',
        rating: data.rating || 8.0,
        year: data.year || 0,
        status: data.status || 'Finalizado',
        genres: data.genres || ['Multimedia'],
        episodes: (data.episodes || []).map((e) => ({ ...e })),
        detected_streams: data.detected_streams || [],
      });
    } catch (err: any) {
      setAnalysisError(err.message || 'Error analizando la URL');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 2. GUARDAR OBRA INDIVIDUAL EN EL CATÁLOGO
  const handleSaveToCatalog = async () => {
    if (!editedShow || !editedShow.title) return;
    setImportingCardUrl('saving');
    setImportMessage(null);

    try {
      const res = await fetch('/api/v1/catalog/import-show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_data: editedShow }),
      });

      if (!res.ok) throw new Error('Error al guardar en la base de datos');
      const data = await res.json();
      setImportMessage(data.message || '¡Guardado con éxito!');
      loadLibrary();
    } catch (err: any) {
      setAnalysisError(err.message || 'Error al importar');
    } finally {
      setImportingCardUrl(null);
    }
  };

  // 3. IMPORTAR TARJETA DE CATÁLOGO DETECTADA
  const handleImportCardItem = async (cardItem: any) => {
    const cardKey = cardItem.url || cardItem.title;
    setImportingCardUrl(cardKey);
    setImportMessage(null);

    try {
      const analyzeRes = await fetch('/api/v1/catalog/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cardItem.url || cardItem.title }),
      });

      if (!analyzeRes.ok) throw new Error('Error al analizar la obra');
      const itemData = await analyzeRes.json();

      const saveRes = await fetch('/api/v1/catalog/import-show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_data: itemData }),
      });

      if (!saveRes.ok) throw new Error('Error guardando en el catálogo');
      const resData = await saveRes.json();
      setImportMessage(resData.message || `¡'${cardItem.title}' guardado!`);
      setImportedCardUrls((prev) => [...prev, cardKey, cardItem.title, cardItem.url]);
      loadLibrary();
    } catch (err: any) {
      setAnalysisError(err.message || 'Error importando');
    } finally {
      setImportingCardUrl(null);
    }
  };

  // 4. INGESTA EN LOTE DE MÚLTIPLES URLs — eliminado (ver git diff)
  // 5. INICIAR CRAWLER MASIVO EN EL WORKER DE SEGUNDO PLANO — eliminado (cuerpo huérfano removido; estado/UI ya borrados)

  // 5.1 CONTROL DE TAREAS DEL WORKER
  const handlePauseJob = async (jobId: string) => {
    try {
      await fetch(`/api/v1/worker/jobs/${jobId}/pause`, { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  };

  const handleResumeJob = async (jobId: string) => {
    try {
      await fetch(`/api/v1/worker/jobs/${jobId}/resume`, { method: 'POST' });
      setActiveTaskId(jobId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/v1/worker/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  };

  // Inicia YA un job pendiente, saltándose la cola (ejecución paralela: puede
  // correr junto a otros jobs hasta max_concurrent_jobs).
  const handleStartNowJob = async (jobId: string) => {
    try {
      await fetch(`/api/v1/worker/jobs/${jobId}/start`, { method: 'POST' });
      setActiveTaskId(jobId);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteJob = async (jobId: string) => {
    try {
      await fetch(`/api/v1/worker/jobs/${jobId}`, { method: 'DELETE' });
      setWorkerJobs((prev) => prev.filter((j) => j.id !== jobId));
      if (selectedJobId === jobId) setSelectedJobId(null);
      if (activeTaskId === jobId) setActiveTaskId(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleClearFinishedJobs = async () => {
    try {
      await fetch('/api/v1/worker/clear-finished', { method: 'POST' });
      setWorkerJobs((prev) => prev.filter((j) => j.status === 'running' || j.status === 'pending' || j.status === 'paused'));
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveWorkerSettings = async () => {
    try {
      setIsSavingSettings(true);
      const res = await fetch('/api/v1/worker/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workerSettings),
      });
      if (res.ok) {
        setImportMessage('Parámetros de protección de IP y límites guardados.');
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsSavingSettings(false);
    }
  };

  // 6. PROBAR EXTRACCIÓN DE STREAM
    // 7. ELIMINAR SERIE DE LA BIBLIOTECA
  const handleDeleteShow = async (showId: string) => {
    setDeletingId(showId);
    try {
      const res = await fetch(`/api/v1/shows/${showId}`, { method: 'DELETE' });
      if (res.ok) {
        setLibraryShows((prev) => prev.filter((s) => s.id !== showId));
        setLibraryTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setDeletingId(null);
    }
  };

  // 8. RESTAURAR CATÁLOGO DE MUESTRA (requiere contraseña admin)
  const handleResetCatalog = async () => {
    const password = window.prompt('Contraseña de administrador para restaurar catálogo:');
    if (!password) return;

    // Verificar contraseña
    try {
      const authRes = await fetch('/api/v1/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: 'uziel', password }),
      });
      const authData = await authRes.json();
      if (!authData.ok) {
        setImportMessage('Contraseña incorrecta. Operación cancelada.');
        return;
      }
    } catch {
      setImportMessage('Error al verificar contraseña.');
      return;
    }

    setIsResetting(true);
    try {
      const res = await fetch('/api/v1/catalog/reset-sample', { method: 'POST' });
      if (res.ok) {
        await loadLibrary(librarySearch, 1, false);
        setImportMessage('Catálogo de muestra restaurado correctamente.');
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsResetting(false);
    }
  };

  const hasMoreLibrary = libraryShows.length < libraryTotal;

  return (
    <div data-admin-root className="admin-shell fixed inset-0 z-50 flex bg-[#090c11] text-zinc-200 animate-in fade-in duration-200">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-[#0b0f14] md:flex">
        <div className="flex h-20 items-center gap-3 border-b border-zinc-800/80 px-5">
          <div className="grid h-9 w-9 place-items-center rounded-lg border border-amber-300/40 bg-amber-300/10 text-amber-300"><Globe size={17} /></div>
          <div><p className="text-sm font-semibold tracking-tight text-white">meristream.</p><p className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-500">Administración</p></div>
        </div>
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5" aria-label="Secciones administrativas">
          <div>
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Control</p>
            <div className="space-y-1">
              {[
                { id: 'overview' as const, label: 'Resumen', icon: Activity, detail: 'Estado general' },
                { id: 'library' as const, label: 'Catálogo', icon: Database, detail: libraryTotal ? `${libraryTotal.toLocaleString()} obras` : 'Gestionar obras' },
                { id: 'sources' as const, label: 'Fuentes', icon: Star, detail: 'Prioridad y salud' },
              ].map((item) => {
                const Icon = item.icon;
                return <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${activeTab === item.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}><Icon size={15} /><span className="min-w-0"><span className="block text-xs font-semibold">{item.label}</span><span className="mt-0.5 block truncate text-[10px] text-zinc-500">{item.detail}</span></span></button>;
              })}
            </div>
          </div>
          <div>
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Operaciones</p>
            <div className="space-y-1">
              {[
                { id: 'verification' as const, label: 'Verificación', icon: ShieldCheck, detail: 'Auditar catálogo' },
                { id: 'worker_tasks' as const, label: 'Cola de tareas', icon: Activity, detail: workerJobs.length ? `${workerJobs.length} tareas` : 'Sin tareas' },
                { id: 'smart' as const, label: 'Importar / analizar', icon: Search, detail: 'Añadir contenido' },
              ].map((item) => {
                const Icon = item.icon;
                return <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${activeTab === item.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}><Icon size={15} /><span className="min-w-0"><span className="block text-xs font-semibold">{item.label}</span><span className="mt-0.5 block truncate text-[10px] text-zinc-500">{item.detail}</span></span>{item.id === 'worker_tasks' && workerJobs.some((job) => job.status === 'running') && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-300" />}</button>;
              })}
            </div>
          </div>
          <div>
            <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">Configuración</p>
            <button type="button" onClick={() => setActiveTab('genres')} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${activeTab === 'genres' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}><ListFilter size={15} /><span><span className="block text-xs font-semibold">Géneros</span><span className="mt-0.5 block text-[10px] text-zinc-500">Visibilidad del catálogo</span></span></button>
          </div>
        </nav>
        <div className="border-t border-zinc-800/80 p-4"><button type="button" onClick={onClose} className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-900 hover:text-white"><X size={14} /> Salir del panel</button></div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-20 items-center justify-between gap-4 border-b border-zinc-800/80 bg-[#0b0f14] px-4 sm:px-7">
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">MeriStream / Admin</p><h2 className="mt-1 truncate text-base font-semibold text-white">{activeTab === 'overview' ? 'Resumen operativo' : activeTab === 'library' ? 'Catálogo' : activeTab === 'sources' ? 'Fuentes y servidores' : activeTab === 'verification' ? 'Verificación' : activeTab === 'worker_tasks' ? 'Cola de tareas' : activeTab === 'genres' ? 'Géneros' : 'Importar contenido'}</h2></div>
          <div className="flex shrink-0 items-center gap-2"><span className="hidden items-center gap-1.5 text-[10px] text-zinc-500 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Sesión protegida</span><button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg border border-zinc-800 text-zinc-400 transition-colors hover:border-zinc-600 hover:text-white md:hidden" aria-label="Salir del panel"><X size={16} /></button></div>
        </header>

        <div className="flex gap-1 overflow-x-auto border-b border-zinc-800/80 bg-[#0b0f14] px-4 py-2 md:hidden">
          {[
            { id: 'overview' as const, label: 'Resumen' }, { id: 'library' as const, label: 'Catálogo' }, { id: 'sources' as const, label: 'Fuentes' }, { id: 'verification' as const, label: 'Verificación' }, { id: 'worker_tasks' as const, label: 'Tareas' }, { id: 'smart' as const, label: 'Importar' }, { id: 'genres' as const, label: 'Géneros' },
          ].map((item) => <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} className={`whitespace-nowrap rounded-md px-3 py-2 text-[11px] font-semibold ${activeTab === item.id ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-200'}`}>{item.label}</button>)}
        </div>

        {/* Mensaje global de éxito / feedback */}
        {importMessage && (
          <div className="mx-4 mt-4 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-400 sm:mx-7">
            <div className="flex items-center gap-2">
              <Check size={15} />
              <span>{importMessage}</span>
            </div>
            <button onClick={() => setImportMessage(null)} className="text-zinc-400 hover:text-white">
              <X size={13} />
            </button>
          </div>
        )}

        {/* Contenido Principal con Scroll */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {activeTab === 'overview' && <AdminOverview onNavigate={setActiveTab} />}

          {/* ========================================================================= */}
          {/* PESTAÑA 1: EXTRACTOR UNIVERSAL Y FICHA INTELIGENTE */}
          {/* ========================================================================= */}
          {activeTab === 'smart' && (
            <div className="space-y-6">
              {/* Presets de 1 Clic */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-400 font-medium">
                  <span>Fuentes adaptadas y presets rápidos de prueba:</span>
                  <span className="text-[11px] text-zinc-500">Haz clic para autocompletar o usa el lápiz para editar el enlace</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {presets.map((preset) => {
                    const isCustom = Boolean(preset.is_custom);
                    let presetDomain = preset.example_url;
                    try {
                      presetDomain = new URL(preset.example_url).hostname.replace(/^www\d?\./, '');
                    } catch {}
                    return (
                      <div
                        key={preset.id}
                        onClick={() => handleAnalyzeUrl(preset.example_url)}
                        title={`${preset.description}\nURL: ${preset.example_url}${isCustom ? ' (Personalizada)' : ''}`}
                        className="relative flex flex-col items-start p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/40 hover:bg-zinc-850 hover:border-zinc-700 transition-all text-left group cursor-pointer"
                      >
                        <div className="flex items-center justify-between w-full">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-200 group-hover:text-white transition-colors truncate">
                            {preset.category === 'anime' && <Tv size={13} className="text-zinc-400 shrink-0" />}
                            {preset.category === 'movies' && <Film size={13} className="text-zinc-400 shrink-0" />}
                            {preset.category === 'series' && <Layers size={13} className="text-zinc-400 shrink-0" />}
                            {preset.category === 'archive' && <Database size={13} className="text-zinc-400 shrink-0" />}
                            {preset.category === 'direct' && <Play size={13} className="text-zinc-400 shrink-0" />}
                            <span className="truncate">{preset.name.split(' ')[0]}</span>
                            {isCustom && (
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="Enlace personalizado por ti" />
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingPreset(preset);
                              setEditingUrlInput(preset.example_url);
                            }}
                            title="Editar enlace por defecto de este preset"
                            className="opacity-60 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-700/80 transition-all ml-1 shrink-0"
                          >
                            <Edit3 size={12} />
                          </button>
                        </div>

                        <span className="text-[10px] text-zinc-500 truncate w-full mt-1 font-mono">
                          {presetDomain}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Modal para Editar Link por Defecto del Preset */}
              {editingPreset && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
                  <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl overflow-hidden p-5 space-y-4">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <Edit3 size={16} />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-white">
                            Editar enlace: {editingPreset.name}
                          </h3>
                          <p className="text-[11px] text-zinc-400">
                            Cambia la URL por defecto en el servidor (aplica para todos los usuarios).
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingPreset(null)}
                        className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition-colors"
                      >
                        <X size={16} />
                      </button>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-medium text-zinc-300 block">
                        URL del Preset
                      </label>
                      <input
                        type="text"
                        value={editingUrlInput}
                        onChange={(e) => setEditingUrlInput(e.target.value)}
                        placeholder="https://..."
                        className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-white focus:outline-none focus:border-amber-500/70 font-mono"
                        autoFocus
                      />
                      {editingPreset.original_url && (
                        <p className="text-[11px] text-zinc-500 truncate font-mono">
                          Original: {editingPreset.original_url}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                      <button
                        type="button"
                        disabled={isSavingPreset}
                        onClick={() => handleResetCustomPresetUrl(editingPreset.id)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 hover:bg-zinc-800 text-zinc-300 text-xs transition-colors disabled:opacity-50"
                      >
                        <RotateCcw size={12} />
                        Restablecer original
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isSavingPreset}
                          onClick={() => setEditingPreset(null)}
                          className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white text-xs transition-colors disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={isSavingPreset || !editingUrlInput.trim()}
                          onClick={() =>
                            handleSaveCustomPresetUrl(editingPreset.id, editingUrlInput)
                          }
                          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50"
                        >
                          {isSavingPreset ? (
                            <>
                              <Loader2 size={13} className="animate-spin" />
                              Guardando en servidor...
                            </>
                          ) : (
                            <>
                              <Check size={13} />
                              Guardar para todos
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Formulario de Entrada */}
              <form onSubmit={(e) => { e.preventDefault(); handleAnalyzeUrl(); }} className="space-y-2">
                <div className="relative flex items-center">
                  <div className="absolute left-3.5 text-zinc-500">
                    <Search size={16} />
                  </div>
                  <input
                    type="text"
                    value={smartUrl}
                    onChange={(e) => setSmartUrl(e.target.value)}
                    placeholder="Pega cualquier URL de anime, película, serie (AnimeFLV, Cuevana, TVMaze, Archive.org, HLS) o busca por título..."
                    className="w-full pl-10 pr-32 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={isAnalyzing || !smartUrl.trim()}
                    className="absolute right-1.5 px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        Analizando...
                      </>
                    ) : (
                      <>
                        <Search size={13} />
                        Analizar
                      </>
                    )}
                  </button>
                </div>
              </form>

              {/* Error de análisis */}
              {analysisError && (
                <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4 text-xs text-red-400 flex items-center gap-2.5">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{analysisError}</span>
                </div>
              )}

              {/* Skeleton de Carga */}
              {isAnalyzing && (
                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-8 flex flex-col items-center justify-center text-center space-y-3">
                  <Loader2 size={32} className="text-amber-400 animate-spin" />
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-white">Inspeccionando DOM y Enriqueciendo Metadata</p>
                    <p className="text-xs text-zinc-500 max-w-md">
                      Buscando OpenGraph tags, JSON-LD schemas, reproductores embebidos y consultando APIs en tiempo real...
                    </p>
                  </div>
                </div>
              )}

              {/* Resultado del Análisis: Ficha Individual o Catálogo */}
              {analysisResult && editedShow && !isAnalyzing && (
                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 overflow-hidden space-y-6">
                  {/* Banner / Poster Hero */}
                  <div className="relative w-full h-44 sm:h-56 bg-zinc-950 overflow-hidden border-b border-zinc-800/80">
                    <img
                      src={editedShow.banner_url || editedShow.poster_url}
                      alt={editedShow.title}
                      className="w-full h-full object-cover opacity-30 blur-sm scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />

                    <div className="absolute inset-x-6 bottom-4 flex items-end justify-between gap-4">
                      <div className="flex items-end gap-4">
                        {editedShow.poster_url && (
                          <img
                            src={editedShow.poster_url}
                            alt={editedShow.title}
                            className="w-20 h-28 sm:w-24 sm:h-36 object-cover rounded-xl border border-zinc-700/80 shadow-2xl shrink-0"
                          />
                        )}
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              {editedShow.content_type || 'Anime'}
                            </span>
                            {analysisResult.source_domain && (
                              <span className="text-[10px] text-zinc-400 font-mono">
                                Fuente: {analysisResult.source_domain}
                              </span>
                            )}
                          </div>
                          <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                            {editedShow.title}
                          </h3>
                          {editedShow.japanese_title && (
                            <p className="text-xs text-zinc-400 font-japanese">
                              {editedShow.japanese_title}
                            </p>
                          )}
                          <div className="flex items-center gap-3 text-xs text-zinc-400 pt-1">
                            <span className="text-amber-400 font-semibold">★ {editedShow.rating}</span>
                            <span>•</span>
                            <span>{editedShow.year}</span>
                            <span>•</span>
                            <span>{editedShow.status}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setIsEditingMetadata(!isEditingMetadata)}
                          className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-xs font-medium text-zinc-200 transition-colors flex items-center gap-1.5"
                        >
                          <Edit3 size={13} />
                          {isEditingMetadata ? 'Ocultar Editor' : 'Editar Ficha'}
                        </button>
                        <button
                          type="button"
                          disabled={importingCardUrl === 'saving'}
                          onClick={handleSaveToCatalog}
                          className="px-4 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs transition-colors flex items-center gap-1.5 shadow-lg shadow-emerald-500/20"
                        >
                          {importingCardUrl === 'saving' ? (
                            <>
                              <Loader2 size={13} className="animate-spin" />
                              Guardando...
                            </>
                          ) : (
                            <>
                              <Check size={14} />
                              Guardar en Catálogo
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Panel de Edición Rápida (si está activo) */}
                  {isEditingMetadata && (
                    <div className="px-6 py-4 mx-6 rounded-xl border border-zinc-800 bg-zinc-950/80 space-y-4">
                      <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                        <Sliders size={14} />
                        Editar Metadatos de la Obra
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                        <div>
                          <label className="text-zinc-400 block mb-1">Título</label>
                          <input
                            type="text"
                            value={editedShow.title}
                            onChange={(e) => setEditedShow({ ...editedShow, title: e.target.value })}
                            className="w-full px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white"
                          />
                        </div>
                        <div>
                          <label className="text-zinc-400 block mb-1">Categoría / Tipo</label>
                          <select
                            value={editedShow.content_type}
                            onChange={(e) => setEditedShow({ ...editedShow, content_type: e.target.value })}
                            className="w-full px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white"
                          >
                            <option value="anime">Anime</option>
                            <option value="movie">Película</option>
                            <option value="series">Serie de TV</option>
                            <option value="open_archive">Dominio Público / Archivo</option>
                            <option value="documentary">Documental</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-zinc-400 block mb-1">Año</label>
                          <input
                            type="number"
                            value={editedShow.year}
                            onChange={(e) => setEditedShow({ ...editedShow, year: parseInt(e.target.value, 10) || 0 })}
                            className="w-full px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white"
                          />
                        </div>
                        <div className="sm:col-span-3">
                          <label className="text-zinc-400 block mb-1">Sinopsis / Descripción</label>
                          <textarea
                            rows={2}
                            value={editedShow.description}
                            onChange={(e) => setEditedShow({ ...editedShow, description: e.target.value })}
                            className="w-full px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-white resize-none"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Sinopsis & Géneros */}
                  <div className="px-6 space-y-3">
                    <p className="text-xs text-zinc-300 leading-relaxed max-w-4xl">
                      {editedShow.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      {Array.isArray(editedShow.genres)
                        ? editedShow.genres.map((g: string, i: number) => (
                            <span key={i} className="text-[11px] px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-300 border border-zinc-700/50">
                              {g}
                            </span>
                          ))
                        : (typeof editedShow.genres === 'string' ? editedShow.genres.split(', ') : []).map((g: string, i: number) => (
                            <span key={i} className="text-[11px] px-2 py-0.5 rounded-md bg-zinc-800 text-zinc-300 border border-zinc-700/50">
                              {g}
                            </span>
                          ))}
                    </div>
                  </div>

                  {/* Lista de Episodios / Fuentes de Video */}
                  <div className="px-6 pb-6 space-y-3">
                    <div className="flex items-center justify-between border-t border-zinc-800/80 pt-4">
                      <h4 className="text-xs font-bold text-white flex items-center gap-2">
                        <FileVideo size={14} className="text-amber-400" />
                        Episodios y Fuentes de Video ({editedShow.episodes?.length || 0})
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          const nextNum = (editedShow.episodes?.length || 0) + 1;
                          setEditedShow({
                            ...editedShow,
                            episodes: [
                              ...(editedShow.episodes || []),
                              {
                                number: nextNum,
                                title: `Episodio ${nextNum}`,
                                url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
                              },
                            ],
                          });
                        }}
                        className="text-[11px] px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center gap-1"
                      >
                        <Plus size={12} />
                        Añadir Episodio / Fuente
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                      {editedShow.episodes?.map((ep: any, idx: number) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-2.5 rounded-xl border border-zinc-800/90 bg-zinc-950/60 hover:border-zinc-700 transition-colors group"
                        >
                          <div className="flex items-center gap-2.5 min-w-0 pr-2">
                            <span className="flex items-center justify-center w-6 h-6 rounded-md bg-zinc-800 text-[11px] font-bold text-zinc-300 shrink-0">
                              {ep.number || idx + 1}
                            </span>
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-zinc-200 truncate">{ep.title}</p>
                              <p className="text-[10px] text-zinc-500 font-mono truncate">{ep.url}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {onPlayHandler && (
                              <button
                                type="button"
                                onClick={() =>
                                  onPlayHandler({
                                    title: `${editedShow.title} - ${ep.title}`,
                                    stream_url: ep.url,
                                    all_available_streams: analysisResult?.detected_streams?.length
                                      ? analysisResult.detected_streams
                                      : [ep.url],
                                  })
                                }
                                className="p-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500 text-amber-400 hover:text-black transition-colors"
                                title="Reproducir este stream"
                              >
                                <Play size={13} />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                const newEps = editedShow.episodes.filter((_: any, i: number) => i !== idx);
                                setEditedShow({ ...editedShow, episodes: newEps });
                              }}
                              className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              title="Eliminar episodio"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Obras adicionales detectadas si fue un catálogo */}
                  {analysisResult.catalog_items && analysisResult.catalog_items.length > 0 && (
                    <div className="px-6 pb-6 space-y-3 border-t border-zinc-800/80 pt-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-white flex items-center gap-2">
                          <Layers size={14} className="text-amber-400" />
                          Obras Adicionales Detectadas en la Página ({analysisResult.catalog_items.length})
                        </h4>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              // Llevar al usuario a la configuración del crawler (Ingesta de Lotes →
                              // Modo 2) con la URL ya precargada; allí elige páginas o catálogo completo.
                              undefined;
                              undefined;
                              setActiveTab('worker_tasks'); // Redirected from batch
                              undefined;
                            }}
                            className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 font-semibold flex items-center gap-1 transition-colors"
                          >
                            <Activity size={12} />
                            Rastrear Catálogo con Worker en Segundo Plano
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-h-60 overflow-y-auto pr-1">
                        {analysisResult.catalog_items.map((card) => {
                          // Clave ESTABLE por contenido (#3): el índice del array
                          // cambia entre renders y desalineaba botón ↔ tarjeta
                          // (el toast anunciaba el título equivocado).
                          const cardKey = `${card.url || 'sin-url'}::${card.title}`;
                          const isAlreadyImported =
                            importedCardUrls.includes(cardKey) ||
                            importedCardUrls.includes(card.title) ||
                            importedCardUrls.includes(card.url) ||
                            libraryShows.some(
                              (s) =>
                                s.title.toLowerCase() === card.title.toLowerCase() ||
                                s.episodes?.some((e) => e.source_url === card.url)
                            );

                          return (
                            <ImportCardItem
                              key={cardKey}
                              card={card}
                              cardKey={cardKey}
                              isAlreadyImported={isAlreadyImported}
                              isImporting={importingCardUrl === cardKey}
                              onImport={() => handleImportCardItem(card)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* PESTAÑA 2: INGESTA EN LOTE & CRAWLER MASIVO */}
          {/* ========================================================================= */}
          {/* ========================================================================= */}
          {/* PESTAÑA 3: COLA DE TAREAS EN TIEMPO REAL & GESTIÓN DEL WORKER */}
          {/* ========================================================================= */}
          {activeTab === 'worker_tasks' && (
            <div className="space-y-6">
              <WorkerSettingsCard />
              {/* Barra de Estadísticas y Acciones Globales */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-zinc-900/60 border border-zinc-800">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    <Activity size={20} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      Monitor de Cola & Tareas del Worker
                      <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300">
                        {workerJobs.length} tareas totales
                      </span>
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Gestiona las descargas continuas de catálogos con protección de IP y límites temporales.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleClearFinishedJobs}
                    className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold transition-colors flex items-center gap-1.5"
                  >
                    <RotateCcw size={13} />
                    Limpiar Finalizadas
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('worker_tasks')}
                    className="px-3 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 text-xs font-semibold transition-colors flex items-center gap-1.5"
                  >
                    <Plus size={14} />
                    Nueva Tarea
                  </button>
                </div>
              </div>

              {/* Ajustes de Rate Limit & Protección Anti-Bloqueo */}
              <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-850 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                    <Settings size={14} className="text-zinc-400" />
                    Parámetros de Seguridad del Worker (Evita bloqueos de IP)
                  </h4>
                  <button
                    type="button"
                    disabled={isSavingSettings}
                    onClick={handleSaveWorkerSettings}
                    className="text-xs font-semibold text-zinc-200 hover:text-white disabled:opacity-50"
                  >
                    {isSavingSettings ? 'Guardando...' : 'Guardar Ajustes'}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div className="p-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800/80">
                    <label className="text-[11px] text-zinc-400 block mb-1">Delay Estándar por Petición (ms):</label>
                    <input
                      type="number"
                      min={500}
                      max={10000}
                      step={250}
                      value={workerSettings.default_delay_ms}
                      onChange={(e) =>
                        setWorkerSettings({
                          ...workerSettings,
                          default_delay_ms: parseInt(e.target.value, 10) || 1500,
                        })
                      }
                      className="w-full px-2.5 py-1.5 rounded-md bg-zinc-950 border border-zinc-700 text-white font-mono text-xs"
                    />
                  </div>

                  <div className="p-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between">
                    <div>
                      <span className="text-[11px] text-zinc-300 block font-semibold">Jitter Anti-Detección</span>
                      <span className="text-[10px] text-zinc-500">Añade 200-700ms aleatorios</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={workerSettings.jitter_enabled}
                      onChange={(e) =>
                        setWorkerSettings({ ...workerSettings, jitter_enabled: e.target.checked })
                      }
                      className="accent-amber-500 w-4 h-4 cursor-pointer"
                    />
                  </div>

                  <div className="p-2.5 rounded-lg bg-zinc-900/80 border border-zinc-800/80 flex items-center justify-between">
                    <div>
                      <span className="text-[11px] text-zinc-300 block font-semibold">Rotación de User-Agent</span>
                      <span className="text-[10px] text-zinc-500">Cabeceras de navegador reales</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={workerSettings.user_agent_rotation}
                      onChange={(e) =>
                        setWorkerSettings({ ...workerSettings, user_agent_rotation: e.target.checked })
                      }
                      className="accent-amber-500 w-4 h-4 cursor-pointer"
                    />
                  </div>
                </div>
              </div>

              {/* Lista de Tareas en la Cola */}
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-zinc-400 font-medium">
                  <span>Tareas Activas e Historial del Worker:</span>
                  <span className="text-[11px] text-zinc-500">
                    {workerJobs.length === 0 ? 'No hay tareas registradas' : 'Selecciona una tarea para inspeccionar su terminal'}
                  </span>
                </div>

                {workerJobs.length === 0 ? (
                  <div className="p-8 rounded-2xl border border-dashed border-zinc-800 text-center space-y-2">
                    <Activity size={32} className="mx-auto text-zinc-600" />
                    <p className="text-xs font-semibold text-zinc-300">No hay tareas en el worker actualmente</p>
                    <p className="text-[11px] text-zinc-500">
                      Dirígete a la pestaña "Ingesta en Lote & Crawler" o "Extractor Universal" para iniciar una importación.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {workerJobs.map((job) => {
                      const isSelected = (selectedJobId || activeTaskId) === job.id;
                      const progressPct =
                        job.status === 'completed'
                          ? 100
                          : Array.isArray(job.items_queue) && job.items_queue.length > 0
                          ? Math.round(
                              (job.items_queue.filter((q) => q.status === 'done').length /
                                job.items_queue.length) *
                                100
                            )
                          : job.status === 'running'
                          ? (job.total_discovered > 0
                              ? Math.min(99, Math.round((job.shows_imported / Math.max(1, job.total_discovered)) * 100))
                              : 25)
                          : 0;

                      return (
                        <div
                          key={job.id}
                          className={`rounded-xl border transition-all p-4 space-y-3 ${
                            isSelected
                              ? 'border-amber-500/60 bg-zinc-900/90 shadow-lg shadow-amber-500/10'
                              : 'border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-900/70 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 ${
                                    job.status === 'running'
                                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse'
                                      : job.status === 'completed'
                                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                      : job.status === 'paused'
                                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                                      : job.status === 'failed'
                                      ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                      : 'bg-zinc-800 text-zinc-400'
                                  }`}
                                >
                                  {job.status === 'running' && <Loader2 size={11} className="animate-spin" />}
                                  {job.status === 'completed' && <CheckCircle2 size={11} />}
                                  {job.status === 'paused' && <Pause size={11} />}
                                  {job.status === 'failed' && <XCircle size={11} />}
                                  {job.status}
                                </span>
                                <h4 className="text-xs font-bold text-white truncate max-w-md">{job.name}</h4>
                              </div>
                              <p className="text-[11px] text-zinc-400 truncate max-w-lg font-mono">
                                {job.target_url}
                              </p>
                            </div>

                            {/* Controles de Acción de la Tarea */}
                            <div className="flex items-center gap-1.5 shrink-0">
                              {job.status === 'running' && (
                                <button
                                  type="button"
                                  onClick={() => handlePauseJob(job.id)}
                                  className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold flex items-center gap-1 transition-colors"
                                  title="Pausar Tarea"
                                >
                                  <Pause size={13} />
                                  <span className="hidden sm:inline text-[11px]">Pausar</span>
                                </button>
                              )}

                              {job.status === 'paused' && (
                                <button
                                  type="button"
                                  onClick={() => handleResumeJob(job.id)}
                                  className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1 transition-colors"
                                  title="Reanudar Tarea"
                                >
                                  <Play size={13} />
                                  <span className="hidden sm:inline text-[11px]">Reanudar</span>
                                </button>
                              )}

                              {job.status === 'pending' && (
                                <button
                                  type="button"
                                  onClick={() => handleStartNowJob(job.id)}
                                  className="p-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1 transition-colors"
                                  title="Iniciar ahora (salta la cola; puede correr en paralelo con otros jobs)"
                                >
                                  <Play size={13} />
                                  <span className="hidden sm:inline text-[11px]">Iniciar ahora</span>
                                </button>
                              )}

                              {(job.status === 'running' || job.status === 'pending' || job.status === 'paused') && (
                                <button
                                  type="button"
                                  onClick={() => handleCancelJob(job.id)}
                                  className="p-1.5 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 text-red-400 text-xs font-semibold flex items-center gap-1 transition-colors"
                                  title="Cancelar Tarea"
                                >
                                  <X size={13} />
                                  <span className="hidden sm:inline text-[11px]">Cancelar</span>
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedJobId(job.id);
                                  setActiveTaskId(job.id);
                                }}
                                className="p-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-semibold flex items-center gap-1 transition-colors"
                                title="Ver Terminal y Logs"
                              >
                                <Terminal size={13} />
                                <span className="text-[11px]">Consola</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleDeleteJob(job.id)}
                                className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                                title="Eliminar registro"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>

                          {/* Barra de Progreso */}
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-zinc-400">
                              <span>
                                {job.current_item_title ? (
                                  <span className="text-amber-400 font-semibold">
                                    Procesando: {job.current_item_title}
                                  </span>
                                ) : (
                                  <span>Progreso de extracción</span>
                                )}
                              </span>
                              <span className="font-mono">
                                {job.shows_imported} guardadas / {job.total_discovered || (Array.isArray(job.items_queue) ? job.items_queue.length : 0)} descubiertas ({progressPct}%)
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
                              <div
                                className={`h-full transition-all duration-300 rounded-full ${
                                  job.status === 'completed'
                                    ? 'bg-emerald-500'
                                    : job.status === 'failed'
                                    ? 'bg-red-500'
                                    : 'bg-amber-500'
                                }`}
                                style={{ width: `${Math.max(progressPct, 4)}%` }}
                              />
                            </div>
                          </div>

                          {/* Estadísticas de la Tarea */}
                          <div className="grid grid-cols-4 gap-2 text-center text-xs">
                            <div className="p-2 rounded-lg bg-zinc-950/60 border border-zinc-850">
                              <span className="text-[10px] text-zinc-500 block">Páginas</span>
                              <span className="font-bold text-white font-mono">{job.current_page || 1} / {job.max_pages}</span>
                            </div>
                            <div className="p-2 rounded-lg bg-zinc-950/60 border border-zinc-850">
                              <span className="text-[10px] text-zinc-500 block">Descubiertas</span>
                              <span className="font-bold text-zinc-200 font-mono">{job.total_discovered}</span>
                            </div>
                            <div className="p-2 rounded-lg bg-zinc-950/60 border border-zinc-850">
                              <span className="text-[10px] text-zinc-500 block">Guardadas</span>
                              <span className="font-bold text-amber-400 font-mono">{job.shows_imported}</span>
                            </div>
                            <div className="p-2 rounded-lg bg-zinc-950/60 border border-zinc-850">
                              <span className="text-[10px] text-zinc-500 block">Episodios</span>
                              <span className="font-bold text-emerald-400 font-mono">{job.episodes_imported}</span>
                            </div>
                          </div>

                          {/* Vista expandida de consola si está seleccionada */}
                          {isSelected && (
                            <div className="pt-2 border-t border-zinc-800/80 space-y-2">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="font-bold text-zinc-300 flex items-center gap-1.5 font-mono">
                                  <Terminal size={12} className="text-amber-400" />
                                  Logs en Tiempo Real del Worker:
                                </span>
                                <span className="text-zinc-500 font-mono text-[10px]">
                                  Delay: {job.rate_limit_delay_ms}ms
                                </span>
                              </div>
                              <div className="p-3 rounded-lg bg-black/90 border border-zinc-900 max-h-48 overflow-y-auto space-y-1 text-[11px] font-mono text-zinc-400">
                                {job.logs && job.logs.length > 0 ? (
                                  job.logs.map((log, idx) => (
                                    <div
                                      key={idx}
                                      className={`flex items-start gap-2 ${
                                        log.level === 'success'
                                          ? 'text-emerald-400'
                                          : log.level === 'warn'
                                          ? 'text-amber-400'
                                          : log.level === 'error'
                                          ? 'text-red-400'
                                          : 'text-zinc-400'
                                      }`}
                                    >
                                      <span className="text-zinc-600 text-[10px]">
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                      </span>
                                      <span className="text-zinc-500">❯</span>
                                      <span className="break-all">{log.message}</span>
                                    </div>
                                  ))
                                ) : (
                                  <span className="text-zinc-600">Sin logs aún...</span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* PESTAÑA 3: PROBADOR DE STREAMS & PROXY ANTI-CORS */}
          {/* ========================================================================= */}
          {/* ========================================================================= */}
          {/* PESTAÑA FUENTES: RATINGS DE SITIOS + REPRODUCTOR */}
          {/* ========================================================================= */}
          {activeTab === 'sources' && (
            <div className="space-y-4">
              <ServerTesterCard />

              <button
                type="button"
                onClick={loadSiteRatings}
                className="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 transition-colors flex items-center gap-1.5"
              >
                <RefreshCw size={13} /> Recargar Ratings
              </button>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-zinc-500 border-b border-zinc-800">
                      <th className="px-3 py-2 font-semibold">Prioridad</th>
                      <th className="px-3 py-2 font-semibold">Sitio</th>
                      <th className="px-3 py-2 font-semibold">Rating (0-10)</th>
                      <th className="px-3 py-2 font-semibold">Activo</th>
                      <th className="px-3 py-2 font-semibold">Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...siteRatings]
                      .sort((a, b) => b.rating - a.rating || a.site.localeCompare(b.site))
                      .map((r, idx, arr) => (
                      <tr key={r.site} className="border-b border-zinc-900 last:border-0">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <span className="w-5 text-center text-[10px] font-mono text-zinc-500">#{idx + 1}</span>
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveSitePriority(r.site, -1)}
                              className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Subir prioridad (mejor posición en el selector premium)"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={idx === arr.length - 1}
                              onClick={() => moveSitePriority(r.site, 1)}
                              className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-amber-400 hover:border-amber-500/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Bajar prioridad"
                            >
                              ↓
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-200">{r.site}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            max={10}
                            step={0.5}
                            defaultValue={r.rating}
                            onBlur={(e) => {
                              const value = Number.parseFloat(e.target.value);
                              if (Number.isFinite(value) && value !== r.rating) handleSaveSiteRating(r.site, { rating: value });
                            }}
                            className="w-16 px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-100 focus:outline-none focus:border-amber-500/60"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            onChange={(e) => handleSaveSiteRating(r.site, { enabled: e.target.checked })}
                            className="h-4 w-4 accent-amber-500"
                          />
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{r.notes || '—'}</td>
                      </tr>
                    ))}
                    {siteRatings.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                          Sin ratings cargados. Pulsa «Recargar Ratings».
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-2">
                <label className="flex items-center gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showSelectorAlways}
                    onChange={(e) => handleToggleSelectorAlways(e.target.checked)}
                    className="h-4 w-4 accent-amber-500"
                  />
                  <span className="text-xs font-semibold text-zinc-200">
                    Mostrar siempre el selector de servidores en el reproductor
                  </span>
                </label>
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  Por defecto está oculto: la reproducción usa la cascada automática (mejor sitio → mejor servidor →
                  siguientes). El selector solo aparece si toda la cascada falla, o siempre que actives esta opción.
                </p>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* PESTAÑA 4: GESTOR DE CATÁLOGO Y BASE DE DATOS */}
          {/* ========================================================================= */}
          {activeTab === 'library' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="relative flex-1 max-w-md">
                  <Search size={14} className="absolute left-3 top-2.5 text-zinc-500" />
                  <input
                    type="text"
                    value={librarySearch}
                    onChange={(e) => {
                      setLibrarySearch(e.target.value);
                      setLibraryPage(1);
                    }}
                    placeholder="Buscar por título, categoría o género en todo el catálogo..."
                    className="w-full pl-9 pr-8 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
                  />
                  {librarySearch && (
                    <button
                      type="button"
                      onClick={() => {
                        setLibrarySearch('');
                        setLibraryPage(1);
                      }}
                      className="absolute right-2.5 top-2 text-zinc-500 hover:text-zinc-300 p-0.5"
                      title="Limpiar búsqueda"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-500 font-mono">
                    {isLoadingLibrary ? (
                      <span className="flex items-center gap-1 text-amber-400">
                        <Loader2 size={11} className="animate-spin" /> Buscando...
                      </span>
                    ) : (
                      `${libraryShows.length} de ${libraryTotal.toLocaleString()} obras`
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={isResetting}
                    onClick={handleResetCatalog}
                    className="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-300 transition-colors flex items-center gap-1.5"
                    title="Restaurar series iniciales por defecto"
                  >
                    {isResetting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                    Restaurar Muestra
                  </button>
                  <button
                    type="button"
                    onClick={() => loadLibrary(librarySearch, 1, false)}
                    className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition-colors"
                    title="Recargar catálogo"
                  >
                    <RefreshCw size={14} className={isLoadingLibrary ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>

              {/* Lista de series */}
              <div className="space-y-2">
                {libraryShows.length === 0 && !isLoadingLibrary ? (
                  <div className="p-8 text-center text-xs text-zinc-500 rounded-xl border border-zinc-900 bg-zinc-950/40">
                    No se encontraron obras que coincidan con la búsqueda.
                  </div>
                ) : (
                  <>
                    {libraryShows.map((show) => (
                      <div
                        key={show.id}
                        className="flex items-center justify-between p-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-900/70 transition-colors group"
                      >
                        <div className="flex items-center gap-3 min-w-0 pr-4">
                          <img
                            src={show.poster_url || show.banner_url || ''}
                            alt={show.title}
                            className="w-10 h-14 object-cover rounded-lg border border-zinc-800 shrink-0"
                            loading="lazy"
                          />
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <h4 className="text-xs font-bold text-white truncate">{show.title}</h4>
                              <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                {show.category || 'Anime'}
                              </span>
                            </div>
                            <p className="text-[11px] text-zinc-400 truncate max-w-lg">
                              {show.genres || 'Sin géneros'}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setEditingShow(show)}
                            className="p-2 rounded-lg text-zinc-500 hover:text-sky-400 hover:bg-sky-500/10 transition-colors"
                            title="Editar obra"
                          >
                            <RefreshCw size={14} />
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === show.id}
                            onClick={() => handleDeleteShow(show.id)}
                            className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Eliminar obra"
                          >
                            {deletingId === show.id ? (
                              <Loader2 size={14} className="animate-spin text-red-400" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        </div>
                      </div>
                    ))}
                    {hasMoreLibrary && (
                      <div className="flex justify-center pt-2">
                        <button
                          type="button"
                          disabled={isLoadingLibrary}
                          onClick={() => {
                            const nextPage = libraryPage + 1;
                            setLibraryPage(nextPage);
                            loadLibrary(librarySearch, nextPage, true);
                          }}
                          className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 transition-colors flex items-center gap-2"
                        >
                          {isLoadingLibrary ? <Loader2 size={12} className="animate-spin" /> : null}
                          Cargar más ({libraryTotal - libraryShows.length} restantes)
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>

              {editingShow && (
                <ShowEditModal
                  show={editingShow}
                  onClose={() => setEditingShow(null)}
                  onSaved={() => {
                    setEditingShow(null);
                    loadLibrary(librarySearch, 1, false);
                  }}
                />
              )}
            </div>
          )}

          {activeTab === 'verification' && <VerificationPanel />}

          {/* ========================================================================= */}
          {/* PESTAÑA: GESTIÓN DE GÉNEROS — MOSTRAR / OCULTAR EN TODA LA PLATAFORMA */}
          {/* ========================================================================= */}
          {activeTab === 'genres' && (
            <GenresManager shows={libraryShows} />
          )}
        </div>
      </main>
    </div>
  );
};

/**
 * Tarjeta de obra detectada en un catálogo (#3): componente aislado y
 * memoizado con key ESTABLE por contenido (url+title). Antes el map usaba el
 * índice del array como key: tras un import, el re-render desalineaba cada
 * botón "Importar" con su tarjeta y el toast anunciaba otro título.
 */
const ImportCardItem = React.memo(function ImportCardItem({
  card,
  cardKey,
  isAlreadyImported,
  isImporting,
  onImport,
}: {
  card: { title: string; url?: string; image_url?: string | null };
  cardKey: string;
  isAlreadyImported: boolean;
  isImporting: boolean;
  onImport: () => void;
}) {
  return (
    <div
      data-card-key={cardKey}
      className={`flex flex-col p-2.5 rounded-xl border space-y-2 transition-all ${
        isAlreadyImported
          ? 'border-emerald-500/40 bg-emerald-950/20 shadow-sm shadow-emerald-500/10'
          : 'border-zinc-800/90 bg-zinc-950/60'
      }`}
    >
      {card.image_url && (
        <img
          src={card.image_url}
          alt={card.title}
          className="w-full h-24 object-cover rounded-lg border border-zinc-800"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-zinc-200 truncate">{card.title}</p>
        <p className="text-[10px] text-zinc-500 truncate">{card.url}</p>
      </div>
      {isAlreadyImported ? (
        <button
          type="button"
          disabled
          className="w-full py-1 rounded-md bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold text-[11px] flex items-center justify-center gap-1 cursor-default"
        >
          <Check size={12} />
          Importado
        </button>
      ) : (
        <button
          type="button"
          disabled={isImporting}
          onClick={onImport}
          className="w-full py-1 rounded-md bg-zinc-800 hover:bg-amber-500 hover:text-black text-zinc-300 font-semibold text-[11px] transition-colors flex items-center justify-center gap-1"
        >
          {isImporting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Plus size={12} />
          )}
          Importar
        </button>
      )}
    </div>
  );
});
