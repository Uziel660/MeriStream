#!/usr/bin/env node
// tools/network-report.cjs
//
// Monitor de Red, Experiencia de Reproducción y Diagnóstico por Anime & Servidor.
// Cada ejecución crea automáticamente un archivo de sesión con fecha y hora en ./logs/sessions/
//
// Modos:
//   node tools/network-report.cjs            → Reporte organizado por Anime y Proveedor
//   node tools/network-report.cjs --watch    → Modo TIEMPO REAL (crea archivo de sesión timestamped)
//   node tools/network-report.cjs --sessions → Listar todas las sesiones guardadas por fecha/hora
//   node tools/network-report.cjs --session <nombre> → Analizar una sesión específica
//   node tools/network-report.cjs --errors   → Solo servidores con fallos o pantallas negras
//   node tools/network-report.cjs --clear    → Limpiar historial de pruebas

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const SESSIONS_DIR = path.join(LOG_DIR, "sessions");
const PROXY_LOG_FILE = path.join(LOG_DIR, "proxy-network.jsonl");
const PLAYER_LOG_FILE = path.join(LOG_DIR, "player-events.jsonl");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function formatTimestampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}

// ── Mapeo Robusto de CDNs a Proveedores Registrados ──

function resolveProvider(targetUrl = "", referer = "", explicitProvider = "") {
  if (explicitProvider && explicitProvider !== "Servidor" && !explicitProvider.includes("http")) {
    return explicitProvider;
  }
  const u = (targetUrl || "").toLowerCase();
  const ref = (referer || "").toLowerCase();

  if (u.includes("mega.nz") || u.includes("mega.co") || u.includes("/stream/mega")) return "MEGA Cloud";
  if (u.includes("ducvomes") || u.includes("playmudos") || u.includes("animeflv") || ref.includes("animeflv")) return "AnimeFLV (HLS)";
  if (u.includes("streamwish") || u.includes("dramiyos") || u.includes("premilky") || u.includes("prem") || u.includes("wishembed") || u.includes("strwish") || u.includes("wish")) return "Streamwish";
  if (u.includes("voe") || u.includes("byselapuix") || u.includes("yodabox") || u.includes("tuktukbox") || u.includes("launchprotective")) return "VOE (HighSpeed)";
  if (u.includes("goodstream")) return "Goodstream HD";
  if (u.includes("zilla-networks") || u.includes("zilla")) return "Zilla Networks";
  if (u.includes("mp4upload")) return "MP4Upload";
  if (u.includes("filemoon") || u.includes("moonplayer")) return "Filemoon HD";
  if (u.includes("mixdrop")) return "Mixdrop";
  if (u.includes("dood") || u.includes("ds2play")) return "Doodstream";
  if (u.includes("turboviplay") || u.includes("turbosplayer") || ref.includes("tioplus")) return "TurboViPlay (TioPlus)";
  if (u.includes("yourupload")) return "YourUpload";
  if (u.includes("vidmoly")) return "Vidmoly";
  if (u.includes("archive.org")) return "Archive.org";
  if (u.includes("googleapis.com") || u.includes("mux.dev")) return "Google Fast Direct";

  try {
    if (targetUrl.startsWith("http")) return new URL(targetUrl).hostname;
    return targetUrl.split("/")[0] || "Desconocido";
  } catch {
    return "Desconocido";
  }
}

// ── Parse args ──
const args = process.argv.slice(2);
const flags = {
  watch: args.includes("--watch") || args.includes("-w"),
  errors: args.includes("--errors") || args.includes("-e"),
  full: args.includes("--full") || args.includes("-f"),
  json: args.includes("--json"),
  clear: args.includes("--clear"),
  listSessions: args.includes("--sessions") || args.includes("--list"),
  session: null,
  anime: null,
  host: null,
};

const sessionIdx = args.indexOf("--session");
if (sessionIdx !== -1 && args[sessionIdx + 1]) {
  flags.session = args[sessionIdx + 1];
}

const animeIdx = args.indexOf("--anime");
if (animeIdx !== -1 && args[animeIdx + 1]) {
  flags.anime = args[animeIdx + 1].toLowerCase();
}

const hostIdx = args.indexOf("--host");
if (hostIdx !== -1 && args[hostIdx + 1]) {
  flags.host = args[hostIdx + 1].toLowerCase();
}

// ── Estilos de Consola ──
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bgRed: "\x1b[41m\x1b[37m",
  bgGreen: "\x1b[42m\x1b[30m",
  bgYellow: "\x1b[43m\x1b[30m",
  bgMagenta: "\x1b[45m\x1b[37m",
  bgCyan: "\x1b[46m\x1b[30m",
};

function pad(str, len) {
  const s = String(str ?? "");
  return s.length > len ? s.slice(0, len - 1) + "…" : s.padEnd(len);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ── Acción: Listar Sesiones Guardadas ──
if (flags.listSessions) {
  console.log(`\n${c.bold}${c.cyan}📁 SESIONES DE PRUEBA GUARDADAS (${SESSIONS_DIR}):${c.reset}\n`);
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.log(`  ${c.dim}No hay sesiones guardadas todavía.${c.reset}\n`);
    process.exit(0);
  }
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".jsonl") || f.endsWith(".log") || f.endsWith(".txt")).sort().reverse();
  if (files.length === 0) {
    console.log(`  ${c.dim}No hay sesiones guardadas todavía.${c.reset}\n`);
    process.exit(0);
  }

  for (const f of files) {
    const fullPath = path.join(SESSIONS_DIR, f);
    const stat = fs.statSync(fullPath);
    const size = formatBytes(stat.size);
    const dateStr = stat.mtime.toLocaleString();
    console.log(`  📄 ${c.bold}${pad(f, 38)}${c.reset} │ ${pad(size, 10)} │ Modificado: ${dateStr}`);
  }
  console.log(`\n${c.cyan}💡 Para analizar una sesión específica ejecuta:${c.reset}`);
  console.log(`   node tools/network-report.cjs --session ${files[0]}\n`);
  process.exit(0);
}

// ── Acción: Limpiar Logs ──
if (flags.clear) {
  if (fs.existsSync(PROXY_LOG_FILE)) fs.writeFileSync(PROXY_LOG_FILE, "");
  if (fs.existsSync(PLAYER_LOG_FILE)) fs.writeFileSync(PLAYER_LOG_FILE, "");
  console.log("🧹 Logs de red y reproductor limpiados exitosamente.");
  process.exit(0);
}

// ── MODO TIEMPO REAL (--watch) ──
if (flags.watch) {
  const sessionStamp = formatTimestampForFile();
  const sessionLogFile = path.join(SESSIONS_DIR, `tracker_${sessionStamp}.txt`);
  const sessionStream = fs.createWriteStream(sessionLogFile, { flags: "a" });

  console.log(`\n${c.bold}${c.cyan}🔴 NITIFLIX MONITOR — TIEMPO REAL (ANIME + PROVEEDOR + SERVIDOR)${c.reset}`);
  console.log(`${c.green}📁 Archivo de sesión individual creado para este inicio:${c.reset}`);
  console.log(`   👉 ${c.bold}${sessionLogFile}${c.reset}`);
  console.log(`${c.dim}Presiona Ctrl+C para detener y guardar.${c.reset}\n`);

  sessionStream.write(`=== SESIÓN DE TELEMETRÍA NITIFLIX: ${sessionStamp} ===\n\n`);

  let lastProxySize = fs.existsSync(PROXY_LOG_FILE) ? fs.statSync(PROXY_LOG_FILE).size : 0;
  let lastPlayerSize = fs.existsSync(PLAYER_LOG_FILE) ? fs.statSync(PLAYER_LOG_FILE).size : 0;
  let lastSeenAnime = "";

  function tailFile(filePath, lastSize, onLine) {
    if (!fs.existsSync(filePath)) return lastSize;
    const stat = fs.statSync(filePath);
    if (stat.size < lastSize) return stat.size;
    if (stat.size === lastSize) return lastSize;

    const stream = fs.createReadStream(filePath, {
      start: lastSize,
      end: stat.size,
      encoding: "utf-8",
    });

    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) onLine(line.trim());
      }
    });

    return stat.size;
  }

  function handleProxyLine(line) {
    try {
      const e = JSON.parse(line);
      const time = e.ts.split("T")[1]?.slice(0, 8) || "";
      
      const animeName = e.mediaTitle || lastSeenAnime || "General";
      const providerName = resolveProvider(e.targetUrl, e.referer, e.providerName);
      const host = `(${pad(e.host, 18)})`;
      const type = pad(`[${e.resourceType}]`, 9);
      const latency = pad(`${e.durationMs}ms`, 8);
      const size = pad(formatBytes(e.bytesReceived), 9);
      
      let statusStr = "";
      let rawStatus = "";
      if (e.upstreamStatus === 416) {
        statusStr = `${c.bgYellow} 416 TOKEN ROTADO ${c.reset}`;
        rawStatus = "416 TOKEN ROTADO";
      } else if (e.upstreamStatus === 429) {
        statusStr = `${c.bgRed} 429 CUOTA / ETOOMANY ${c.reset}`;
        rawStatus = "429 CUOTA / ETOOMANY";
      } else if (e.ok) {
        statusStr = `${c.green}${e.upstreamStatus || 200} OK${c.reset}`;
        rawStatus = `${e.upstreamStatus || 200} OK`;
      } else {
        statusStr = `${c.bgRed} ${e.upstreamStatus || "ERR"} FAIL ${c.reset}`;
        rawStatus = `${e.upstreamStatus || "ERR"} FAIL`;
      }

      const errDetail = e.error ? ` ⚠️ ${e.error}` : "";
      const coloredLog = `[${time}] 🌐 ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.dim}${host}${c.reset} ${c.magenta}${type}${c.reset} ${statusStr} ${latency} ${size}${e.error ? `${c.red}${errDetail}${c.reset}` : ""}`;
      const plainLog = `[${time}] 🌐 [${animeName}] ${providerName} ${host} ${type} ${rawStatus} ${latency} ${size}${errDetail}\n`;

      console.log(coloredLog);
      sessionStream.write(plainLog);
    } catch {}
  }

  function handlePlayerLine(line) {
    try {
      const p = JSON.parse(line);
      const time = p.ts.split("T")[1]?.slice(0, 8) || "";
      if (p.mediaTitle) lastSeenAnime = p.mediaTitle;
      
      const animeName = p.mediaTitle || lastSeenAnime || "General";
      const providerName = resolveProvider(p.serverUrl, "", p.provider);

      let msgColored = "";
      let msgPlain = "";

      if (p.eventType === "playback_started") {
        msgColored = `[${time}] ${c.bgGreen} PLAY FLUIDO ${c.reset} ▶️  ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.green}Reproduciendo OK (${p.durationBeforeErrorMs || 0}ms)${c.reset}`;
        msgPlain = `[${time}] PLAY FLUIDO ▶️  [${animeName}] ${providerName} Reproduciendo OK (${p.durationBeforeErrorMs || 0}ms)\n`;
      } else if (p.eventType === "embed_opened") {
        msgColored = `[${time}] ${c.bgMagenta} EMBED ABIERTO ${c.reset} 🪟 ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.magenta}Cargando iframe (anuncios/popups)${c.reset}`;
        msgPlain = `[${time}] EMBED ABIERTO 🪟 [${animeName}] ${providerName} Cargando iframe (anuncios/popups)\n`;
      } else if (p.eventType === "playback_buffering") {
        msgColored = `[${time}] ${c.bgYellow} PAUSA / BUFFER ${c.reset} ⏳ ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.yellow}${p.details || 'Pausado por CDN lenta'}${c.reset}`;
        msgPlain = `[${time}] PAUSA / BUFFER ⏳ [${animeName}] ${providerName} ${p.details || 'Pausado por CDN lenta'}\n`;
      } else if (p.eventType === "black_screen_stalled") {
        msgColored = `[${time}] ${c.bgRed} PANTALLA NEGRA ${c.reset} ⬛ ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.red}¡Servidor nunca cargó / pantalla negra! (${p.durationBeforeErrorMs}ms)${c.reset}`;
        msgPlain = `[${time}] PANTALLA NEGRA ⬛ [${animeName}] ${providerName} ¡Servidor nunca cargó / pantalla negra! (${p.durationBeforeErrorMs}ms)\n`;
      } else if (p.eventType === "playback_error") {
        msgColored = `[${time}] ${c.bgRed} ERROR FATAL ${c.reset} ❌ ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.red}Fallo: ${p.details || 'Error de video'}${c.reset}`;
        msgPlain = `[${time}] ERROR FATAL ❌ [${animeName}] ${providerName} Fallo: ${p.details || 'Error de video'}\n`;
      } else if (p.eventType === "failover_auto") {
        msgColored = `[${time}] ${c.bgYellow} AUTO-FAILOVER ${c.reset} 🔄 ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.yellow}Saltando a servidor de respaldo...${c.reset}`;
        msgPlain = `[${time}] AUTO-FAILOVER 🔄 [${animeName}] ${providerName} Saltando a servidor de respaldo...\n`;
      } else if (p.eventType === "quota_fallback") {
        msgColored = `[${time}] ${c.bgYellow} CUOTA EXCEDIDA ${c.reset} 📦 ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.bold}${pad(providerName, 18)}${c.reset} ${c.yellow}Cuota MEGA agotada -> Fallback a Embed${c.reset}`;
        msgPlain = `[${time}] CUOTA EXCEDIDA 📦 [${animeName}] ${providerName} Cuota MEGA agotada -> Fallback a Embed\n`;
      } else if (p.eventType === "scraper_resolution") {
        msgColored = `[${time}] ${c.bgCyan} SCRAPER RESUELTO ${c.reset} 🔍 ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.cyan}${p.details}${c.reset}`;
        msgPlain = `[${time}] SCRAPER RESUELTO 🔍 [${animeName}] ${p.details}\n`;
      } else if (p.eventType === "scraper_failed") {
        msgColored = `[${time}] ${c.bgRed} SCRAPER FALLÓ ${c.reset} ❌ ${c.cyan}[${pad(animeName, 20)}]${c.reset} ${c.red}${p.details}${c.reset}`;
        msgPlain = `[${time}] SCRAPER FALLÓ ❌ [${animeName}] ${p.details}\n`;
      }

      if (msgColored) console.log(msgColored);
      if (msgPlain) sessionStream.write(msgPlain);
    } catch {}
  }

  setInterval(() => {
    lastProxySize = tailFile(PROXY_LOG_FILE, lastProxySize, handleProxyLine);
    lastPlayerSize = tailFile(PLAYER_LOG_FILE, lastPlayerSize, handlePlayerLine);
  }, 250);

  return;
}

// ── MODO REPORTE CONSOLIDADO ──

let proxyEntries = [];
let playerEntries = [];

if (flags.session) {
  let targetFile = flags.session;
  if (!fs.existsSync(targetFile)) {
    targetFile = path.join(SESSIONS_DIR, flags.session);
  }
  if (!fs.existsSync(targetFile) && !targetFile.endsWith(".jsonl")) {
    targetFile = path.join(SESSIONS_DIR, `${flags.session}.jsonl`);
  }
  if (!fs.existsSync(targetFile)) {
    console.error(`❌ No se encontró el archivo de sesión: ${flags.session}`);
    process.exit(1);
  }
  console.log(`\n📂 Cargando sesión específica: ${c.bold}${targetFile}${c.reset}`);
  const allEntries = readJsonl(targetFile);
  proxyEntries = allEntries.filter(e => e.type === "network" || e.targetUrl);
  playerEntries = allEntries.filter(e => e.type === "player" || e.eventType);
} else {
  proxyEntries = readJsonl(PROXY_LOG_FILE);
  playerEntries = readJsonl(PLAYER_LOG_FILE);
}

if (proxyEntries.length === 0 && playerEntries.length === 0) {
  console.log(`\n⚠️  ${c.yellow}No hay registros todavía.${c.reset}`);
  console.log(`   Archivos de sesiones en: ${SESSIONS_DIR}`);
  console.log(`\n${c.cyan}💡 Tip: Ejecuta 'node tools/network-report.cjs --watch' para iniciar una nueva sesión de prueba con archivo propio.${c.reset}\n`);
  process.exit(0);
}

if (flags.json) {
  console.log(JSON.stringify({ proxyEntries, playerEntries }, null, 2));
  process.exit(0);
}

console.log(`\n${c.bold}═══════════════════════════════════════════════════════════════════════════════════════════════════════════════${c.reset}`);
console.log(`${c.bold}${c.cyan}📊 NITIFLIX — REPORTE DE SALUD POR ANIME Y PROVEEDOR DE VIDEO${c.reset}`);
console.log(`${c.dim}Peticiones de Red: ${proxyEntries.length} | Eventos de Reproductor/Scrapers: ${playerEntries.length}${c.reset}`);
console.log(`${c.bold}═══════════════════════════════════════════════════════════════════════════════════════════════════════════════${c.reset}\n`);

// ── 1. DESGLOSE POR ANIME Y SUS SERVIDORES PROBADOS ──
console.log(`${c.bold}📺 1. RESUMEN POR ANIME / PELÍCULA${c.reset}`);

const byAnime = new Map();
for (const pe of playerEntries) {
  const anime = pe.mediaTitle || "General / Sin Título";
  if (!byAnime.has(anime)) byAnime.set(anime, { player: [], proxy: [] });
  byAnime.get(anime).player.push(pe);
}
for (const pr of proxyEntries) {
  const anime = pr.mediaTitle || "General / Sin Título";
  if (!byAnime.has(anime)) byAnime.set(anime, { player: [], proxy: [] });
  byAnime.get(anime).proxy.push(pr);
}

for (const [anime, data] of byAnime) {
  console.log(`\n${c.bold}${c.cyan}🎬 ANIME: ${anime}${c.reset}`);
  
  const provMap = new Map();
  for (const ev of data.player) {
    const key = resolveProvider(ev.serverUrl, "", ev.provider);
    if (!provMap.has(key)) provMap.set(key, { ok: 0, black: 0, buffer: 0, error: 0, failover: 0, isEmbed: false });
    const st = provMap.get(key);
    if (ev.eventType === "playback_started") st.ok++;
    if (ev.eventType === "embed_opened") { st.ok++; st.isEmbed = true; }
    if (ev.eventType === "black_screen_stalled") st.black++;
    if (ev.eventType === "playback_buffering") st.buffer++;
    if (ev.eventType === "playback_error") st.error++;
    if (ev.eventType === "failover_auto" || ev.eventType === "quota_fallback") st.failover++;
  }

  if (provMap.size === 0) {
    console.log(`   ${c.dim}(Solo peticiones de red registradas)${c.reset}`);
  } else {
    for (const [prov, st] of provMap) {
      let tag = `${c.green}⭐ 100% FLUIDO${c.reset}`;
      if (st.black > 0 && st.ok === 0) tag = `${c.bgRed} ⬛ MUERTO (PANTALLA NEGRA) ${c.reset}`;
      else if (st.black > 0) tag = `${c.bgRed} ❌ FALLÓ INICIALMENTE ${c.reset}`;
      else if (st.buffer > 0) tag = `${c.yellow} ⏳ ${st.buffer}x PAUSAS BUFFER ${c.reset}`;
      else if (st.isEmbed) tag = `${c.magenta} 🪟 EMBED (ANUNCIOS) ${c.reset}`;

      console.log(`   ├─ ${pad(prov, 22)} │ ${tag} │ ${st.ok} reproducidos, ${st.buffer} pausas buffer, ${st.error} errores`);
    }
  }

  const reqOk = data.proxy.filter(r => r.ok).length;
  const reqFail = data.proxy.length - reqOk;
  const totalMB = (data.proxy.reduce((s, r) => s + r.bytesReceived, 0) / (1024 * 1024)).toFixed(2);
  if (data.proxy.length > 0) {
    console.log(`   └─ Red: ${data.proxy.length} peticiones (${reqOk} OK, ${reqFail} fallos) | ${totalMB} MB transferidos`);
  }
}

// ── 2. TABLA GLOBAL DE SERVIDORES Y RECOMENDACIÓN DE PRIORIDAD ──
console.log(`\n\n${c.bold}🏆 2. RANKING DE SERVIDORES REGISTRADOS (PARA TUS ADAPTADORES)${c.reset}`);

const globalProvMap = new Map();
for (const pe of playerEntries) {
  const key = resolveProvider(pe.serverUrl, "", pe.provider);
  if (!globalProvMap.has(key)) globalProvMap.set(key, { ok: 0, black: 0, buffer: 0, error: 0, failover: 0, isEmbed: false, host: pe.host });
  const st = globalProvMap.get(key);
  if (pe.eventType === "playback_started") st.ok++;
  if (pe.eventType === "embed_opened") { st.ok++; st.isEmbed = true; }
  if (pe.eventType === "black_screen_stalled") st.black++;
  if (pe.eventType === "playback_buffering") st.buffer++;
  if (pe.eventType === "playback_error") st.error++;
  if (pe.eventType === "failover_auto" || pe.eventType === "quota_fallback") st.failover++;
}

for (const pr of proxyEntries) {
  const key = resolveProvider(pr.targetUrl, pr.referer, pr.providerName);
  if (!globalProvMap.has(key)) globalProvMap.set(key, { ok: 0, black: 0, buffer: 0, error: 0, failover: 0, isEmbed: false, host: pr.host });
}

const gCols = [
  pad("PROVEEDOR REGISTRADO", 24),
  pad("HOST / CDN", 24),
  pad("ESTADO", 12),
  pad("PAUSAS BUFFER", 16),
  pad("PANTALLA NEGRA", 18),
  pad("RECOMENDACIÓN PARA ADAPTADOR", 32),
];
console.log("  " + gCols.join(" │ "));
console.log("  " + "─".repeat(gCols.join(" │ ").length));

for (const [prov, st] of globalProvMap) {
  let statusTag = `${c.green}EXCELENTE${c.reset}`;
  let rec = `${c.green}Prioridad #1 (Rápido y estable)${c.reset}`;

  if (st.black > 0 && st.ok === 0) {
    statusTag = `${c.red}MUERTO${c.reset}`;
    rec = `${c.red}ELIMINAR (Pantalla negra 100%)${c.reset}`;
  } else if (prov.includes("MEGA") && proxyEntries.some(r => r.upstreamStatus === 429)) {
    statusTag = `${c.yellow}CUOTA LIM${c.reset}`;
    rec = `${c.yellow}Mantener con fallback a Embed${c.reset}`;
  } else if (st.buffer >= 3) {
    statusTag = `${c.yellow}LENTO${c.reset}`;
    rec = `${c.yellow}Prioridad #2/#3 (Pausas por buffer)${c.reset}`;
  } else if (st.isEmbed) {
    statusTag = `${c.magenta}EMBED${c.reset}`;
    rec = `${c.magenta}Respaldo final (Anuncios/Popups)${c.reset}`;
  }

  console.log(
    "  " +
    [
      pad(prov, 24),
      pad(st.host || "CDN", 24),
      pad(statusTag, 12),
      pad(st.buffer > 0 ? `${c.yellow}${st.buffer} pausas${c.reset}` : "0", 16),
      pad(st.black > 0 ? `${c.red}${st.black} stalls${c.reset}` : "0", 18),
      pad(rec, 32),
    ].join(" │ ")
  );
}

console.log(`\n${c.cyan}💡 Ejecuta 'node tools/network-report.cjs --sessions' para listar sesiones pasadas.${c.reset}\n`);

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
