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
  ListPlus,
  Terminal,
  ShieldCheck,
  FileVideo,
  Edit3,
  Sliders,
  Pause,
  Clock,
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

  const [activeTab, setActiveTab] = useState<'smart' | 'batch' | 'worker_tasks' | 'stream_tester' | 'sources' | 'library' | 'verification' | 'genres'>('smart');
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

  // --- Ingesta en Lote (Batch Ingestion) ---
  const [batchMode, setBatchMode] = useState<'urls' | 'crawler'>('urls');
  const [batchUrlsText, setBatchUrlsText] = useState('');
  const [isBatchImporting, setIsBatchImporting] = useState(false);
  const [batchResults, setBatchResults] = useState<any[] | null>(null);

  // --- Crawler & Monitor de Tarea en Vivo ---
  const [crawlerUrl, setCrawlerUrl] = useState('https://animeflv.net');
  const [crawlerPages, setCrawlerPages] = useState<number>(3);
  const [crawlerScope, setCrawlerScope] = useState<'catalog_pages' | 'full_catalog'>('catalog_pages');
  const [rateLimitDelay, setRateLimitDelay] = useState<number>(300);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isStartingCrawler, setIsStartingCrawler] = useState(false);

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

  // --- Probador de Stream & Anti-CORS ---
  const [testStreamUrl, setTestStreamUrl] = useState('');
  const [testReferer, setTestReferer] = useState('https://animeflv.net/');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<any | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);

  // --- Biblioteca & Catálogo ---
  const [libraryShows, setLibraryShows] = useState<Show[]>([]);
  const [librarySearch, setLibrarySearch] = useState('');
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [libraryPage, setLibraryPage] = useState(1);
  const LIBRARY_PAGE_SIZE = 100;
  // const [isImporting, setIsImporting] = useState(false);

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

  // Polling continuo de la lista de tareas del Worker (independiente de cerrar la pestaña)
  useEffect(() => {
    const fetchWorkerJobs = async () => {
      try {
        const res = await fetch('/api/v1/worker/jobs');
        if (res.ok) {
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
    const interval = setInterval(fetchWorkerJobs, 1500);
    return () => clearInterval(interval);
  }, [activeTaskId]);

  // Polling detallado de la tarea seleccionada / activa
  useEffect(() => {
    const targetId = selectedJobId || activeTaskId;
    if (!targetId) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/tasks/${targetId}`);
        if (res.ok) {
          const data = await res.json();
          setWorkerJobs((prev) =>
            prev.map((job) => (job.id === targetId ? { ...job, ...data } : job))
          );
          if (data.status === 'completed') {
            loadLibrary();
          }
        }
      } catch (e) {
        console.error(e);
      }
    }, 1200);

    return () => clearInterval(interval);
  }, [activeTaskId, selectedJobId]);

  const loadLibrary = async () => {
    try {
      setIsLoadingLibrary(true);
      const res = await fetch('/api/v1/shows?lite=true&limit=25000');
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.shows || [];
        setLibraryShows(list);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'library') loadLibrary();
  }, [activeTab]);

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
        japanese_title: data.japanese_title || '',
        english_title: data.english_title || '',
        description: data.description,
        poster_url: data.poster_url || '',
        banner_url: data.banner_url || data.poster_url || '',
        content_type: data.content_type || 'anime',
        rating: data.rating || 8.0,
        year: data.year || new Date().getFullYear(),
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

  // 4. INGESTA EN LOTE DE MÚLTIPLES URLs
  const handleBatchImport = async () => {
    const urls = batchUrlsText
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);

    if (urls.length === 0) return;

    setIsBatchImporting(true);
    setBatchResults(null);

    try {
      const res = await fetch('/api/v1/catalog/batch-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });

      if (!res.ok) throw new Error('Error en ingesta en lote');
      const data = await res.json();
      setBatchResults(data.results || []);
      loadLibrary();
    } catch (err: any) {
      setAnalysisError(err.message || 'Error en ingesta en lote');
    } finally {
      setIsBatchImporting(false);
    }
  };

  // 5. INICIAR CRAWLER MASIVO EN EL WORKER DE SEGUNDO PLANO
  const handleStartCrawler = async (
    e?: React.FormEvent,
    overrides?: { url?: string; scope?: 'catalog_pages' | 'full_catalog' }
  ) => {
    if (e) e.preventDefault();
    // overrides: valores explícitos para llamadas programáticas (el setState de React
    // NO alcanza a aplicarse antes de esta llamada dentro del mismo tick — bug del
    // job default de animeflv al rastrear desde el Extractor Universal).
    const targetUrl = (overrides?.url ?? crawlerUrl).trim();
    const targetScope = overrides?.scope ?? crawlerScope;
    if (!targetUrl) return;

    setIsStartingCrawler(true);
    setAnalysisError(null);

    try {
      const res = await fetch('/api/v1/catalog/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          delay_ms: rateLimitDelay,
          scope: targetScope,
          // full_catalog: SIN max_pages — el worker auto-descubre páginas hasta el fin del catálogo
          ...(targetScope === 'full_catalog' ? {} : { max_pages: crawlerPages }),
        }),
      });

      if (!res.ok) throw new Error('Error iniciando el rastreador');
      const data = await res.json();
      setActiveTaskId(data.task_id);
      setSelectedJobId(data.task_id);
      setImportMessage(`Tarea enviada al worker en segundo plano (Rate limit: ${rateLimitDelay}ms).`);
      setActiveTab('worker_tasks');
    } catch (err: any) {
      setAnalysisError(err.message || 'Error al iniciar crawler');
    } finally {
      setIsStartingCrawler(false);
    }
  };

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
  const handleExtractStream = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testStreamUrl.trim()) return;

    setIsExtracting(true);
    setExtractError(null);
    setExtractResult(null);

    try {
      const res = await fetch('/api/v1/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: testStreamUrl.trim() }),
      });

      if (!res.ok) throw new Error('No se pudo resolver el stream');
      const data = await res.json();
      setExtractResult(data);
    } catch (err: any) {
      setExtractError(err.message || 'Error al extraer el video');
    } finally {
      setIsExtracting(false);
    }
  };

  // 7. ELIMINAR SERIE DE LA BIBLIOTECA
  const handleDeleteShow = async (showId: string) => {
    setDeletingId(showId);
    try {
      const res = await fetch(`/api/v1/shows/${showId}`, { method: 'DELETE' });
      if (res.ok) {
        setLibraryShows((prev) => prev.filter((s) => s.id !== showId));
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
        await loadLibrary();
        setImportMessage('Catálogo de muestra restaurado correctamente.');
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsResetting(false);
    }
  };

  // Filtro de biblioteca
  const filteredLibrary = libraryShows.filter((s) => {
    const q = librarySearch.toLowerCase();
    const genresStr = Array.isArray(s.genres) ? s.genres.join(", ") : (s.genres || "");
    return (
      s.title.toLowerCase().includes(q) ||
      (s.japanese_title || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) ||
      genresStr.toLowerCase().includes(q)
    );
  });

  const paginatedLibrary = filteredLibrary.slice(0, libraryPage * LIBRARY_PAGE_SIZE);
  const hasMoreLibrary = filteredLibrary.length > paginatedLibrary.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 sm:p-6 animate-in fade-in duration-200">
      <div className="relative flex flex-col w-full max-w-5xl h-[90vh] bg-zinc-950 border border-zinc-800/90 rounded-2xl shadow-2xl overflow-hidden">
        {/* Cabecera del Panel */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200">
              <Globe size={16} />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-white">
                Centro de Ingesta & Scraper Universal
              </h2>
              <p className="text-xs text-zinc-400">
                Extracción automática para Anime, Películas, Series de TV, Archivos Abiertos y Streams HLS.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Barra de Pestañas */}
        <div className="flex items-center gap-1.5 px-6 py-2 border-b border-zinc-800 bg-zinc-900/30 text-xs overflow-x-auto">
          <button
            onClick={() => setActiveTab('smart')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
              activeTab === 'smart'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <Search size={14} />
            Extractor Universal & Ficha
          </button>

          <button
            onClick={() => setActiveTab('batch')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
              activeTab === 'batch'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <ListPlus size={14} />
            Ingesta en Lote & Crawler
          </button>

          <button
            onClick={() => setActiveTab('worker_tasks')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors relative ${
              activeTab === 'worker_tasks'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <Activity size={14} />
            Cola de Tareas & Worker
            {workerJobs.filter((j) => j.status === 'running' || j.status === 'pending').length > 0 && (
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
            )}
            {workerJobs.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-zinc-800 text-zinc-300 font-mono">
                {workerJobs.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('stream_tester')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
              activeTab === 'stream_tester'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <FileVideo size={14} />
            Probador de Streams & Proxy
          </button>

          <button
            onClick={() => setActiveTab('verification')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
              activeTab === 'verification'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <ShieldCheck size={14} />
            Verificación
          </button>

          <button
            onClick={() => setActiveTab('sources')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
              activeTab === 'sources'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <Star size={14} />
            Fuentes
          </button>

          <button
            onClick={() => setActiveTab('library')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ml-auto ${
              activeTab === 'library'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <Database size={14} />
            Catálogo ({libraryShows.length})
          </button>

          <button
            onClick={() => setActiveTab('genres')}
            type="button"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
              activeTab === 'genres'
                ? 'bg-zinc-800 text-white border border-zinc-700'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850'
            }`}
          >
            <ListFilter size={14} />
            Géneros
          </button>
        </div>

        {/* Mensaje global de éxito / feedback */}
        {importMessage && (
          <div className="mx-6 mt-3 px-4 py-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center justify-between animate-in fade-in">
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
                            onChange={(e) => setEditedShow({ ...editedShow, year: parseInt(e.target.value, 10) || 2024 })}
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
                              setCrawlerUrl(smartUrl);
                              setCrawlerScope('catalog_pages');
                              setActiveTab('batch');
                              setBatchMode('crawler');
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
          {activeTab === 'batch' && (
            <div className="space-y-6">
              {/* Selector de Modo */}
              <div className="flex items-center gap-1.5 p-1 rounded-xl bg-zinc-900 border border-zinc-800 w-fit text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setBatchMode('urls')}
                  className={`px-3.5 py-1.5 rounded-lg transition-colors ${
                    batchMode === 'urls'
                      ? 'bg-zinc-800 text-white font-semibold border border-zinc-700'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Lista de URLs / Títulos en Bloque
                </button>
                <button
                  type="button"
                  onClick={() => setBatchMode('crawler')}
                  className={`px-3.5 py-1.5 rounded-lg transition-colors ${
                    batchMode === 'crawler'
                      ? 'bg-zinc-800 text-white font-semibold border border-zinc-700'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Rastreador Web Automático (Crawler)
                </button>
              </div>

              {/* MODO 1: Pegar Múltiples URLs */}
              {batchMode === 'urls' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-zinc-200">
                      Pega una lista de URLs o títulos (uno por línea):
                    </label>
                    <p className="text-xs text-zinc-500">
                      El motor procesará cada enlace, enriquecerá los metadatos y los añadirá a la biblioteca automáticamente.
                    </p>
                  </div>

                  <textarea
                    rows={6}
                    value={batchUrlsText}
                    onChange={(e) => setBatchUrlsText(e.target.value)}
                    placeholder={`https://animeflv.net/anime/jujutsu-kaisen-tv&#10;https://cuevana.biz/pelicula/interstellar&#10;https://www.tvmaze.com/shows/82/game-of-thrones&#10;https://archive.org/details/night_of_the_living_dead&#10;Chainsaw Man`}
                    className="w-full p-3.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-zinc-600 transition-colors"
                  />

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-zinc-500">
                      Líneas detectadas: {batchUrlsText.split('\n').filter((l) => l.trim()).length}
                    </span>
                    <button
                      type="button"
                      disabled={isBatchImporting || !batchUrlsText.trim()}
                      onClick={handleBatchImport}
                      className="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs transition-colors disabled:opacity-40 flex items-center gap-2"
                    >
                      {isBatchImporting ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Procesando lote...
                        </>
                      ) : (
                        <>
                          <ListPlus size={15} />
                          Iniciar Ingesta en Bloque
                        </>
                      )}
                    </button>
                  </div>

                  {/* Resultados del lote */}
                  {batchResults && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
                      <h4 className="text-xs font-bold text-white flex items-center gap-2">
                        <Check size={15} className="text-emerald-400" />
                        Resultados de la Ingesta ({batchResults.filter((r) => r.status === 'success').length}/{batchResults.length} exitosos)
                      </h4>

                      <div className="space-y-1.5 max-h-48 overflow-y-auto font-mono text-xs">
                        {batchResults.map((res, i) => (
                          <div
                            key={i}
                            className={`p-2 rounded-lg flex items-center justify-between ${
                              res.status === 'success'
                                ? 'bg-emerald-950/20 text-emerald-300 border border-emerald-500/20'
                                : 'bg-red-950/20 text-red-300 border border-red-500/20'
                            }`}
                          >
                            <span className="truncate">{res.title || res.url}</span>
                            <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-black/40">
                              {res.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* MODO 2: Crawler Automático con Logs en Vivo */}
              {batchMode === 'crawler' && (
                <div className="space-y-4">
                  <form onSubmit={handleStartCrawler} className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-4">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                      <div>
                        <h4 className="text-xs font-bold text-white flex items-center gap-2">
                          <Globe size={15} className="text-zinc-300" />
                          Configuración del Rastreador y Descubrimiento
                        </h4>
                        <p className="text-[11px] text-zinc-400 mt-0.5">
                          El worker en el backend rastreará la web, descubrirá enlaces e importará obras con protección de IP.
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold">
                        <ShieldCheck size={14} />
                        Anti-Baneo Activo
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                      <div className="sm:col-span-12">
                        <label className="text-xs font-semibold text-zinc-300 block mb-1">
                          URL Raíz del Directorio / Catálogo:
                        </label>
                        <input
                          type="text"
                          value={crawlerUrl}
                          onChange={(e) => setCrawlerUrl(e.target.value)}
                          placeholder="https://animeflv.net/browse o cualquier web de cine..."
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"
                        />
                      </div>

                      <div className="sm:col-span-4">
                        <label className="text-xs font-semibold text-zinc-300 block mb-1">
                          Alcance del Rastreo:
                        </label>
                        <select
                          value={crawlerScope}
                          onChange={(e: any) => setCrawlerScope(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"
                        >
                          <option value="catalog_pages">Páginas Especificadas</option>
                          <option value="full_catalog">Todo el Catálogo Web (Profundo)</option>
                        </select>
                      </div>

                      {crawlerScope === 'full_catalog' ? (
                        <div className="sm:col-span-4">
                          <label className="text-xs font-semibold text-zinc-300 block mb-1">
                            Alcance:
                          </label>
                          <div className="px-3.5 py-2 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-xs text-emerald-300">
                            Barrido completo autónomo: avanza página a página hasta el final del catálogo, sin límite. Reanuda solo si se interrumpe.
                          </div>
                        </div>
                      ) : (
                        <div className="sm:col-span-4">
                          <label className="text-xs font-semibold text-zinc-300 block mb-1">
                            Páginas a rastrear:
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={crawlerPages}
                            onChange={(e) => setCrawlerPages(parseInt(e.target.value, 10) || 1)}
                            className="w-full px-3.5 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs text-white focus:outline-none focus:border-zinc-600"
                          />
                        </div>
                      )}

                      <div className="sm:col-span-4">
                        <label className="text-xs font-semibold text-zinc-300 block mb-1 flex items-center justify-between">
                          <span>Delay / Rate Limit:</span>
                          <span className="text-zinc-400 font-mono">{rateLimitDelay}ms</span>
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={5000}
                          step={100}
                          value={rateLimitDelay}
                          onChange={(e) => setRateLimitDelay(parseInt(e.target.value, 10))}
                          className="w-full accent-zinc-200 mt-2"
                        />
                        <p className="text-[10px] text-zinc-500 mt-1">0ms = velocidad máxima (8 páginas + 8 obras en paralelo). Súbelo solo si el sitio se queja.</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                        <Clock size={13} className="text-zinc-400" />
                        Incluso si cierras esta pestaña, el worker continuará en el backend.
                      </p>
                      <button
                        type="submit"
                        disabled={isStartingCrawler || !crawlerUrl.trim()}
                        className="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs transition-colors disabled:opacity-40 flex items-center gap-2 shadow"
                      >
                        {isStartingCrawler ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            Iniciando worker...
                          </>
                        ) : (
                          <>
                            <Activity size={15} />
                            Rastrear e Importar al Catálogo
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          )}

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
                    onClick={() => setActiveTab('batch')}
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
                        job.items_queue.length > 0
                          ? Math.round(
                              (job.items_queue.filter((q) => q.status === 'done').length /
                                job.items_queue.length) *
                                100
                            )
                          : job.status === 'completed'
                          ? 100
                          : job.status === 'running'
                          ? 25
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
                                {job.shows_imported} guardadas / {job.items_queue.length || job.total_discovered} descubiertas ({progressPct}%)
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
          {activeTab === 'stream_tester' && (
            <div className="space-y-6">
              <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-300 flex items-start gap-3">
                <ShieldCheck size={18} className="shrink-0 mt-0.5 text-zinc-400" />
                <div>
                  <p className="font-semibold text-white">Proxy Anti-CORS y Bypass de Referer</p>
                  <p className="text-zinc-400 mt-0.5">
                    Permite reproducir cualquier stream de video HLS (m3u8) o MP4 alojado en servidores externos sin bloqueos de navegador.
                  </p>
                </div>
              </div>

              <form onSubmit={handleExtractStream} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-zinc-300 block mb-1">
                    URL del Stream Directo o Página Embebida:
                  </label>
                  <input
                    type="text"
                    value={testStreamUrl}
                    onChange={(e) => setTestStreamUrl(e.target.value)}
                    placeholder="https://.../master.m3u8 o URL de reproductor"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-zinc-600"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-zinc-300 block mb-1">
                    Cabecera Referer Anti-Hotlink (opcional):
                  </label>
                  <input
                    type="text"
                    value={testReferer}
                    onChange={(e) => setTestReferer(e.target.value)}
                    placeholder="https://animeflv.net/"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white font-mono focus:outline-none focus:border-zinc-600"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isExtracting || !testStreamUrl.trim()}
                  className="px-4 py-2 rounded-xl bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs transition-colors flex items-center gap-2"
                >
                  {isExtracting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Resolviendo...
                    </>
                  ) : (
                    <>
                      <Play size={14} />
                      Extraer y Resolver Stream
                    </>
                  )}
                </button>
              </form>

              {extractError && (
                <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/20 text-xs text-red-400 flex items-center gap-2">
                  <AlertCircle size={15} />
                  <span>{extractError}</span>
                </div>
              )}

              {extractResult && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                    <div>
                      <h4 className="text-xs font-bold text-white">{extractResult.title}</h4>
                      <p className="text-[10px] text-zinc-400">{extractResult.description}</p>
                    </div>
                    {onPlayHandler && (
                      <button
                        type="button"
                        onClick={() =>
                          onPlayHandler({
                            title: extractResult.title,
                            stream_url: extractResult.stream_url,
                            all_available_streams: extractResult.all_streams,
                          })
                        }
                        className="px-3.5 py-1.5 rounded-lg bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                      >
                        <Play size={13} />
                        Reproducir en HLS Player
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <span className="text-[11px] font-bold text-zinc-300">Fuentes y Variantes Detectadas:</span>
                    <div className="space-y-1.5 font-mono text-xs max-h-40 overflow-y-auto">
                      {(extractResult.all_streams || [extractResult.stream_url]).map((s: string, idx: number) => (
                        <div
                          key={idx}
                          className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between text-zinc-300"
                        >
                          <span className="truncate pr-2">{s}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-amber-400 font-bold shrink-0">
                            {s.includes('.m3u8') ? 'HLS' : 'MP4'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

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
                <div className="relative flex-1 max-w-sm">
                  <Search size={14} className="absolute left-3 top-2.5 text-zinc-500" />
                  <input
                    type="text"
                    value={librarySearch}
                    onChange={(e) => { setLibrarySearch(e.target.value); setLibraryPage(1); }}
                    placeholder="Filtrar por título, categoría o género..."
                    className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white focus:outline-none focus:border-amber-500/60"
                  />
                </div>

                <div className="flex items-center gap-2">
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
                    onClick={loadLibrary}
                    className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition-colors"
                    title="Recargar catálogo"
                  >
                    <RefreshCw size={14} className={isLoadingLibrary ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>

              {/* Lista de series */}
              <div className="space-y-2">
                {filteredLibrary.length === 0 ? (
                  <div className="p-8 text-center text-xs text-zinc-500 rounded-xl border border-zinc-900 bg-zinc-950/40">
                    No se encontraron obras que coincidan con la búsqueda.
                  </div>
                ) : (
                  <>
                    {paginatedLibrary.map((show) => (
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
                          onClick={() => setLibraryPage(prev => prev + 1)}
                          className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 border border-zinc-700 transition-colors"
                        >
                          Cargar más ({filteredLibrary.length - paginatedLibrary.length} restantes)
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
                    loadLibrary();
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
      </div>
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
