const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// permissive CORS for local prototyping — tighten before any real deployment
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-device-token');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 4790;
const OFFLINE_AFTER_MS = 90 * 1000;
const HISTORY_LEN = 40;
const DATA_FILE = path.join(__dirname, 'data.json');

const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ENROLL_KEY = process.env.ENROLL_KEY || '';

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.log('[auth] ADMIN_USER/ADMIN_PASSWORD non impostati — dashboard e API SENZA login (solo per sviluppo locale).');
}
if (!ENROLL_KEY) {
  console.log('[auth] ENROLL_KEY non impostata — chiunque conosca il server puo registrare dispositivi falsi (solo per sviluppo locale).');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireLogin(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASSWORD) return next(); // login disattivato (dev locale)
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep === -1 ? decoded : decoded.slice(0, sep);
    const pass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (timingSafeEqualStr(user, ADMIN_USER) && timingSafeEqualStr(pass, ADMIN_PASSWORD)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Lab Informatica"');
  res.status(401).send('Accesso richiesto');
}

// device store, persistito su file — sopravvive ai riavvii del processo.
// NB: su hosting con filesystem effimero (es. un nuovo deploy) il file
// viene perso comunque; per uso reale su piu' istanze serve un database vero.
// devices: Map<deviceId, { id, token, clientName, deviceName, createdAt, lastSeen, latest, history }>
const devices = new Map();

function loadDevices() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const arr = JSON.parse(raw);
    arr.forEach((d) => devices.set(d.id, d));
    console.log(`[store] caricati ${devices.size} dispositivi da ${DATA_FILE}`);
  } catch {
    console.log('[store] nessun dato precedente trovato, si parte da zero');
  }
}

let saveTimer = null;
function saveDevicesDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify([...devices.values()]), (err) => {
      if (err) console.error('[store] errore salvataggio:', err.message);
    });
  }, 2000);
}

loadDevices();

function publicDevice(d) {
  const online = !!d.lastSeen && (Date.now() - d.lastSeen) < OFFLINE_AFTER_MS;
  return {
    id: d.id,
    clientName: d.clientName,
    deviceName: d.deviceName,
    online,
    lastSeen: d.lastSeen,
    latest: d.latest,
    history: d.history
  };
}

app.post('/api/enroll', (req, res) => {
  if (ENROLL_KEY && !timingSafeEqualStr(req.headers['x-enroll-key'] || '', ENROLL_KEY)) {
    return res.status(401).json({ error: 'chiave di iscrizione mancante o non valida' });
  }
  const { clientName, deviceName } = req.body || {};
  if (!clientName || !deviceName) {
    return res.status(400).json({ error: 'clientName e deviceName sono obbligatori' });
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  devices.set(id, {
    id, token, clientName, deviceName,
    createdAt: Date.now(), lastSeen: null, latest: null,
    history: { diskUsed: [], cpuUsage: [], cpuTemp: [], ram: [] }
  });
  console.log(`[enroll] nuovo dispositivo "${deviceName}" (${clientName}) -> id=${id}`);
  saveDevicesDebounced();
  res.json({ deviceId: id, token });
});

function requireDevice(req, res, next) {
  const token = req.headers['x-device-token'];
  if (!token) return res.status(401).json({ error: 'token mancante' });
  const device = [...devices.values()].find(d => d.token === token);
  if (!device) return res.status(401).json({ error: 'token non valido' });
  req.device = device;
  next();
}

function pushCap(arr, val) {
  arr.push(val);
  if (arr.length > HISTORY_LEN) arr.shift();
}

app.post('/api/telemetry', requireDevice, (req, res) => {
  const d = req.device;
  const body = req.body || {};
  d.lastSeen = Date.now();
  d.latest = {
    diskUsedPct: body.diskUsedPct ?? null,
    diskHealth: body.diskHealth ?? 'unknown',
    logicalDisks: body.logicalDisks ?? [],
    physicalDisks: body.physicalDisks ?? [],
    cpuUsagePct: body.cpuUsagePct ?? null,
    cpuTempC: body.cpuTempC ?? null,
    gpuTempC: body.gpuTempC ?? null,
    ramUsedPct: body.ramUsedPct ?? null,
    batteryPct: body.batteryPct ?? null,
    hardwareErrorCount30d: body.hardwareErrorCount30d ?? 0,
    hardwareErrorLevelCount30d: body.hardwareErrorLevelCount30d ?? 0,
    lastHardwareErrorAt: body.lastHardwareErrorAt ?? null,
    at: d.lastSeen
  };
  pushCap(d.history.diskUsed, body.diskUsedPct ?? null);
  pushCap(d.history.cpuUsage, body.cpuUsagePct ?? null);
  pushCap(d.history.cpuTemp, body.cpuTempC ?? null);
  pushCap(d.history.ram, body.ramUsedPct ?? null);
  console.log(`[telemetry] ${d.deviceName} (${d.clientName}) — disco ${body.diskUsedPct}% (${body.diskHealth}), cpu ${body.cpuUsagePct}% temp ${body.cpuTempC ?? 'n/d'}, ram ${body.ramUsedPct}%`);
  saveDevicesDebounced();
  res.json({ ok: true });
});

app.delete('/api/devices/:id', requireLogin, (req, res) => {
  const existed = devices.delete(req.params.id);
  if (!existed) return res.status(404).json({ error: 'dispositivo non trovato' });
  console.log(`[devices] rimosso dispositivo id=${req.params.id}`);
  saveDevicesDebounced();
  res.json({ ok: true });
});

app.get('/api/devices', requireLogin, (req, res) => {
  res.json([...devices.values()].map(publicDevice));
});

app.get('/api/health', (req, res) => res.json({ ok: true, devices: devices.size }));

app.use(requireLogin, express.static(path.join(__dirname, 'public')));

app.get('/', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`Lab Informatica server in ascolto su http://localhost:${PORT}`);
});
