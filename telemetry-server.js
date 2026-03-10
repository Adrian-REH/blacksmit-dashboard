/**
 * ============================================================
 *  telemetry-server.js — Servidor WebSocket de Telemetría
 * ============================================================
 *
 *  FLUJO DE SESIÓN (rooms):
 *    1. Unity conecta a  ws://host/telemetry
 *       → El servidor genera un código único (ej. "ABC-1234")
 *       → Lo envía de vuelta: { type: "welcome", code: "ABC-1234", ... }
 *    2. Dashboard conecta a  ws://host/dashboard?code=ABC-1234
 *       → El servidor lo une a la sala correspondiente
 *       → Solo recibe los snapshots de ESA partida
 *
 *  Varias partidas pueden correr en paralelo con códigos distintos.
 *
 *  INSTALAR:
 *    npm install ws
 *
 *  EJECUTAR:
 *    node telemetry-server.js
 *    node telemetry-server.js --port 9000
 *
 *  ENDPOINTS HTTP:
 *    GET /health          → estado global
 *    GET /rooms           → salas activas y sus clientes
 *    GET /history?code=XX → últimos 100 snapshots de una sala
 *
 *  COMANDOS consumer → producer (misma sala):
 *    { "cmd": "SET_SEND_INTERVAL", "value": 10 }
 *    { "cmd": "SET_BATCH_WAIT_MS", "value": 3000 }
 *    { "cmd": "FORCE_FLUSH" }
 */

'use strict';

const WebSocket = require('ws');
const http      = require('http');
const url       = require('url');
const fs        = require('fs');
const path      = require('path');

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const PORT = (() => {
  const i = args.indexOf('--port');
  return i !== -1 ? parseInt(args[i + 1], 10) : 8080;
})();

const STATIC_DIR  = __dirname;
const MAX_HISTORY = 100;

const ROLE = { PRODUCER: 'producer', CONSUMER: 'consumer' };

// ──────────────────────────────────────────────────────────────────────────────
// ESTADO: SALAS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Room
 * @property {string}         code
 * @property {WebSocket|null} producerWs
 * @property {Set<WebSocket>} consumers
 * @property {Array}          history      - ring buffer de MAX_HISTORY snapshots
 * @property {number}         createdAt
 * @property {number}         totalSnapshots
 */

/** @type {Map<string, Room>} code → Room */
const rooms = new Map();

/** @type {Map<WebSocket, { id: string, role: string, code: string, connectedAt: number, msgRx: number, msgTx: number }>} */
const clients = new Map();

let clientIdCounter = 0;

const stats = {
  totalSnapshots:   0,
  totalBroadcasts:  0,
  totalParseErrors: 0,
  serverStartedAt:  Date.now(),
};

// ──────────────────────────────────────────────────────────────────────────────
// GENERADOR DE CÓDIGO DE SALA
// ──────────────────────────────────────────────────────────────────────────────

function generateRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I, O para evitar confusión visual
  const digits  = '0123456789';
  let code;
  do {
    const prefix = Array.from({ length: 3 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    const suffix = Array.from({ length: 4 }, () => digits[Math.floor(Math.random() * digits.length)]).join('');
    code = `${prefix}-${suffix}`;
  } while (rooms.has(code));
  return code;
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP SERVER
// ──────────────────────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── API ───────────────────────────────────────────────────────────────────

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:         'ok',
      uptime:         process.uptime(),
      activeRooms:    rooms.size,
      totalClients:   clients.size,
      totalSnapshots: stats.totalSnapshots,
      parseErrors:    stats.totalParseErrors,
    }));
    return;
  }

  if (pathname === '/rooms') {
    const list = [];
    rooms.forEach((room) => {
      list.push({
        code:          room.code,
        producerAlive: room.producerWs?.readyState === WebSocket.OPEN,
        consumers:     room.consumers.size,
        snapshots:     room.totalSnapshots,
        ageSecs:       ((Date.now() - room.createdAt) / 1000).toFixed(0),
      });
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  if (pathname === '/history') {
    const code = parsed.query.code;
    const room = rooms.get(code);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Room "${code}" not found` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(room.history));
    return;
  }

  // ── Ficheros estáticos ────────────────────────────────────────────────────

  let filePath;
  if (pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard.html') {
    filePath = path.join(STATIC_DIR, 'dashboard.html');
  } else if (pathname === '/presentacion' || pathname === '/presentacion.html' || pathname === '/Presentacion.html') {
    filePath = path.join(STATIC_DIR, 'Presentacion.html');
  } else {
    filePath = path.join(STATIC_DIR, pathname);
  }

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`404 — No encontrado: ${pathname}\n\nRutas:\n  /              → dashboard.html\n  /presentacion  → Presentacion.html\n  /health        → estado\n  /rooms         → salas activas\n  /history?code= → historial de sala`);
      return;
    }
    const ext      = path.extname(filePath).toLowerCase();
    const mimeType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// WEBSOCKET SERVER
// ──────────────────────────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const id       = `client_${++clientIdCounter}`;
  const addr     = req.socket.remoteAddress;

  // ── PRODUCER (/telemetry) ─────────────────────────────────────────────────
  if (pathname === '/telemetry') {
    const code = generateRoomCode();

    /** @type {Room} */
    const room = {
      code,
      producerWs:     ws,
      consumers:      new Set(),
      history:        [],
      createdAt:      Date.now(),
      totalSnapshots: 0,
    };
    rooms.set(code, room);
    clients.set(ws, { id, role: ROLE.PRODUCER, code, connectedAt: Date.now(), msgRx: 0, msgTx: 0 });

    log('CONNECT', `${id} [producer] → sala "${code}" creada. Addr: ${addr}`);

    sendToClient(ws, {
      type:    'welcome',
      role:    'producer',
      id,
      code,
      message: `Sala "${code}" lista. Comparte este código con el dashboard.`,
    });

    ws.on('message', (data) => onProducerMessage(ws, data));
    ws.on('close',   ()     => onProducerClose(ws, code, id));
    ws.on('error',   (err)  => log('WS_ERROR', `${id}: ${err.message}`));
    return;
  }

  // ── CONSUMER (/dashboard?code=XXX) ───────────────────────────────────────
  if (pathname === '/dashboard') {
    const code = parsed.query.code;

    if (!code) {
      sendRaw(ws, { type: 'error', code: 'NO_CODE', message: 'Falta el código de sala. Usa ?code=XXX-0000 en la URL.' });
      ws.close(1008, 'Missing room code');
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      sendRaw(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: `La sala "${code}" no existe. Comprueba el código.` });
      ws.close(1008, 'Room not found');
      return;
    }

    room.consumers.add(ws);
    clients.set(ws, { id, role: ROLE.CONSUMER, code, connectedAt: Date.now(), msgRx: 0, msgTx: 0 });

    log('CONNECT', `${id} [consumer] → sala "${code}" (${room.consumers.size} consumers). Addr: ${addr}`);

    sendToClient(ws, {
      type:         'welcome',
      role:         'consumer',
      id,
      code,
      lastSnapshot: room.history.length > 0 ? room.history[room.history.length - 1] : null,
    });

    ws.on('message', (data) => onConsumerMessage(ws, data));
    ws.on('close',   ()     => onConsumerClose(ws, code, id));
    ws.on('error',   (err)  => log('WS_ERROR', `${id}: ${err.message}`));
    return;
  }

  // Ruta desconocida
  sendRaw(ws, { type: 'error', code: 'UNKNOWN_PATH', message: `Ruta "${pathname}" no válida. Usa /telemetry o /dashboard?code=XXX-0000` });
  ws.close(1008, 'Unknown path');
});

// ──────────────────────────────────────────────────────────────────────────────
// HANDLERS
// ──────────────────────────────────────────────────────────────────────────────

function onProducerMessage(ws, data) {
  const meta = clients.get(ws);
  if (!meta) return;
  meta.msgRx++;

  let parsed;
  try {
    parsed = JSON.parse(data.toString());
  } catch (err) {
    stats.totalParseErrors++;
    log('PARSE_ERROR', `${meta.id}: ${err.message}`);
    sendToClient(ws, { type: 'error', code: 'INVALID_JSON', message: err.message });
    return;
  }

  const room = rooms.get(meta.code);
  if (!room) return;

  stats.totalSnapshots++;
  room.totalSnapshots++;

  const envelope = {
    type:       'snapshot',
    from:       meta.id,
    receivedAt: Date.now(),
    seqNumber:  room.totalSnapshots,
    payload:    parsed,
  };

  // Ring buffer por sala
  room.history.push(envelope);
  if (room.history.length > MAX_HISTORY) room.history.shift();

  // Log resumido
  const gameTime = parsed?.meta?.gameTime?.toFixed(1) ?? '?';
  const ev       = parsed?.evaluation;
  const J = ev?.junior?.score?.toFixed(2) ?? '-';
  const M = ev?.middle?.score?.toFixed(2) ?? '-';
  const S = ev?.senior?.score?.toFixed(2) ?? '-';
  log('SNAPSHOT', `[${meta.code}] #${room.totalSnapshots} t=${gameTime}s | J:${J} M:${M} S:${S} | consumers:${room.consumers.size}`);

  broadcastToRoom(room, envelope);

  sendToClient(ws, { type: 'ack', seqNumber: room.totalSnapshots, timestamp: Date.now() });
}

function onProducerClose(ws, code, id) {
  clients.delete(ws);
  const room = rooms.get(code);
  if (!room) return;

  log('DISCONNECT', `${id} [producer] sala "${code}". Notificando a ${room.consumers.size} consumers.`);

  room.consumers.forEach((consumerWs) => {
    sendToClient(consumerWs, {
      type:    'producer_disconnected',
      code,
      message: 'El juego se ha desconectado.',
    });
  });

  room.producerWs = null;

  // Eliminar sala tras 5 minutos si no reconecta
  setTimeout(() => {
    const r = rooms.get(code);
    if (r && !r.producerWs) {
      rooms.delete(code);
      log('ROOM', `Sala "${code}" eliminada por inactividad.`);
    }
  }, 5 * 60 * 1000);
}

function onConsumerMessage(ws, data) {
  const meta = clients.get(ws);
  if (!meta) return;
  meta.msgRx++;

  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (!msg.cmd) return;

  const room = rooms.get(meta.code);
  if (!room?.producerWs) return;

  log('CMD', `Consumer ${meta.id} [${meta.code}] → cmd "${msg.cmd}"`);
  sendToClient(room.producerWs, { cmd: msg.cmd, value: msg.value });
  sendToClient(ws, { type: 'cmd_result', cmd: msg.cmd, sent: true });
}

function onConsumerClose(ws, code, id) {
  clients.delete(ws);
  const room = rooms.get(code);
  if (room) room.consumers.delete(ws);
  log('DISCONNECT', `${id} [consumer] sala "${code}". Consumers restantes: ${room?.consumers.size ?? 0}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// BROADCAST POR SALA
// ──────────────────────────────────────────────────────────────────────────────

function broadcastToRoom(room, message) {
  const json  = JSON.stringify(message);
  const bytes = Buffer.byteLength(json, 'utf8');
  let   count = 0;

  room.consumers.forEach((consumerWs) => {
    if (consumerWs.readyState !== WebSocket.OPEN) return;
    consumerWs.send(json, (err) => {
      if (err) log('BROADCAST_ERR', err.message);
    });
    const m = clients.get(consumerWs);
    if (m) m.msgTx++;
    count++;
  });

  stats.totalBroadcasts++;
  if (count > 0) log('BROADCAST', `[${room.code}] #${room.totalSnapshots} → ${count} consumers. ${bytes}B`);
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────

function sendToClient(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
  const m = clients.get(ws);
  if (m) m.msgTx++;
}

function sendRaw(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag.padEnd(14)}] ${msg}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// HEARTBEAT
// ──────────────────────────────────────────────────────────────────────────────

setInterval(() => {
  clients.forEach((meta, ws) => {
    if (ws.readyState !== WebSocket.OPEN) { clients.delete(ws); return; }
    ws.ping();
  });
}, 30_000);

// ──────────────────────────────────────────────────────────────────────────────
// STATS LOG
// ──────────────────────────────────────────────────────────────────────────────

setInterval(() => {
  log('STATS', [
    `uptime=${process.uptime().toFixed(0)}s`,
    `rooms=${rooms.size}`,
    `clients=${clients.size}`,
    `snapshots=${stats.totalSnapshots}`,
    `memMB=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}`,
  ].join(' | '));
}, 60_000);

// ──────────────────────────────────────────────────────────────────────────────
// ARRANQUE
// ──────────────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  log('SERVER', `Telemetry server escuchando en puerto ${PORT}`);
  log('SERVER', `Dashboard        → http://localhost:${PORT}/`);
  log('SERVER', `Presentación     → http://localhost:${PORT}/presentacion`);
  log('SERVER', `WS juego         → ws://localhost:${PORT}/telemetry`);
  log('SERVER', `WS dashboard     → ws://localhost:${PORT}/dashboard?code=XXX-0000`);
  log('SERVER', `HTTP health      → http://localhost:${PORT}/health`);
  log('SERVER', `HTTP rooms       → http://localhost:${PORT}/rooms`);
  log('SERVER', `HTTP history     → http://localhost:${PORT}/history?code=XXX-0000`);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

function shutdown() {
  log('SERVER', 'Apagando servidor...');
  clients.forEach((_, ws) => ws.close(1001, 'Server shutting down'));
  httpServer.close(() => { log('SERVER', 'Servidor cerrado.'); process.exit(0); });
}