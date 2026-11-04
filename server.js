// Kindred: anonymous peer-to-peer voice calls between people who are grieving.
//
// The server only does matchmaking and relays WebRTC handshake messages.
// Audio flows directly between the two phones. Nothing is written to disk,
// and there are no names, emails or phone numbers. A person is a random alias
// and a random device token that stays in their browser.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const RING_TIMEOUT_MS = 30_000;
const REPORTS_BEFORE_SUSPEND = 3;
const CALL_LENGTHS = [2, 5]; // minutes the caller can start with
const EXTEND_MINUTES = 5; // added each time both people press "Add time"
const WARNING_MS = 60_000; // operator announcement one minute before the end
const MIN = 60_000 * (Number(process.env.TIME_SCALE) || 1); // TIME_SCALE shortens calls for testing

// ---- Cloudflare TURN relay ----------------------------------------------
// Every call goes through Cloudflare's relay so neither person can see the
// other's IP address (which would reveal roughly where they are), and calls
// connect on strict mobile and Wi-Fi networks. The API token stays here on the
// server; phones only get short-lived credentials for one call.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN;
const CF_TURN_API = process.env.CF_TURN_API || 'https://rtc.live.cloudflare.com/v1';
const TURN_ENABLED = !!(CF_TURN_KEY_ID && CF_TURN_API_TOKEN);
const TURN_TTL_S = 4 * 60 * 60; // longer than any realistic call
const DEV_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

async function getIceServers() {
  const res = await fetch(
    `${CF_TURN_API}/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  // Browsers block port 53, so those URLs only slow the connection down.
  const servers = list
    .filter(Boolean)
    .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length);
  if (!servers.some((s) => s.urls.some((u) => u.startsWith('turn')))) throw new Error('no TURN servers returned');
  return servers;
}

const LOSSES = ['parent', 'grandparent', 'sibling', 'child', 'partner', 'friend', 'other'];
const STAGES = ['new', 'older']; // new = within roughly the first year

const ADJ = ['Quiet', 'Gentle', 'Steady', 'Soft', 'Warm', 'Still', 'Kind', 'Patient', 'Open', 'Calm'];
const NOUN = ['Willow', 'Harbor', 'Lantern', 'River', 'Meadow', 'Sparrow', 'Ember', 'Cedar', 'Tide', 'Moss'];
const alias = () =>
  `${ADJ[crypto.randomInt(ADJ.length)]} ${NOUN[crypto.randomInt(NOUN.length)]}`;

// ---- in-memory state ----------------------------------------------------
/** token -> { ws, alias, losses[], stage, available, peer, ringing } */
const users = new Map();
/** token -> Set of tokens this person never wants to be matched with */
const blocks = new Map();
/** token -> number of reports received */
const reports = new Map();
/** caller token -> { target, tried:Set, filters, timer } */
const pendingCalls = new Map();
/** Anonymous rating tally: stars -> count. No link to who rated or whom. */
const ratings = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
/** token -> shared session { a, b, endsAt, votes:Set, warnTimer, endTimer } (both tokens point to it) */
const sessions = new Map();

// ---- call clock ---------------------------------------------------------
// The server owns the clock so both phones agree. One minute before the end,
// both phones play the operator announcement. If BOTH press "Add time",
// the call gets EXTEND_MINUTES more; otherwise it ends at zero.
function scheduleSession(s) {
  clearTimeout(s.warnTimer); clearTimeout(s.endTimer);
  s.votes.clear();
  const left = s.endsAt - Date.now();
  const warnMs = Math.min(WARNING_MS * (MIN / 60_000), left / 2);
  s.warnTimer = setTimeout(() => {
    for (const t of [s.a, s.b]) send(users.get(t), { type: 'one-minute', remainingMs: s.endsAt - Date.now() });
  }, left - warnMs);
  s.endTimer = setTimeout(() => hangUp(s.a, 'time', true), left);
}

function startSession(a, b, minutes) {
  const s = { a, b, endsAt: Date.now() + minutes * MIN, votes: new Set(), warnTimer: null, endTimer: null };
  sessions.set(a, s); sessions.set(b, s);
  scheduleSession(s);
  return s;
}

function endSession(token) {
  const s = sessions.get(token);
  if (!s) return;
  clearTimeout(s.warnTimer); clearTimeout(s.endTimer);
  sessions.delete(s.a); sessions.delete(s.b);
}

function voteExtend(token) {
  const s = sessions.get(token);
  if (!s || s.votes.has(token)) return;
  s.votes.add(token);
  const other = token === s.a ? s.b : s.a;
  if (s.votes.size < 2) {
    send(users.get(token), { type: 'extend-waiting' });
    send(users.get(other), { type: 'peer-wants-more' });
    return;
  }
  s.endsAt = Math.max(s.endsAt, Date.now()) + EXTEND_MINUTES * MIN;
  scheduleSession(s);
  for (const t of [s.a, s.b]) send(users.get(t), { type: 'extended', remainingMs: s.endsAt - Date.now(), added: EXTEND_MINUTES });
}

const send = (u, msg) => u?.ws.readyState === 1 && u.ws.send(JSON.stringify(msg));
const isBlocked = (a, b) => blocks.get(a)?.has(b) || blocks.get(b)?.has(a);
const suspended = (t) => (reports.get(t) || 0) >= REPORTS_BEFORE_SUSPEND;
const publicProfile = (u) => ({ alias: u.alias, losses: u.losses, stage: u.stage });

function broadcastCounts() {
  let open = 0;
  for (const u of users.values()) if (u.available && !u.peer && !u.ringing) open++;
  for (const u of users.values()) {
    const self = u.available && !u.peer && !u.ringing ? 1 : 0;
    send(u, { type: 'stats', openLines: open - self });
  }
}

function findListener(callerToken, filters, tried) {
  const candidates = [];
  for (const [token, u] of users) {
    if (token === callerToken || tried.has(token)) continue;
    if (!u.available || u.peer || u.ringing || suspended(token)) continue;
    if (isBlocked(callerToken, token)) continue;
    if (filters.loss !== 'any' && !u.losses.includes(filters.loss)) continue;
    if (filters.stage !== 'any' && u.stage !== filters.stage) continue;
    candidates.push(token);
  }
  return candidates.length ? candidates[crypto.randomInt(candidates.length)] : null;
}

function ringNext(callerToken) {
  const call = pendingCalls.get(callerToken);
  const caller = users.get(callerToken);
  if (!call || !caller) return;

  const target = findListener(callerToken, call.filters, call.tried);
  if (!target) {
    pendingCalls.delete(callerToken);
    send(caller, { type: 'no-match', tried: call.tried.size });
    return;
  }
  call.target = target;
  call.tried.add(target);
  const listener = users.get(target);
  listener.ringing = callerToken;
  send(listener, { type: 'incoming', from: publicProfile(caller), minutes: call.minutes });
  send(caller, { type: 'ringing' });
  call.timer = setTimeout(() => {
    listener.ringing = null;
    send(listener, { type: 'incoming-cancelled', reason: 'missed' });
    ringNext(callerToken);
  }, RING_TIMEOUT_MS);
  broadcastCounts();
}

function cancelPending(callerToken, reason) {
  const call = pendingCalls.get(callerToken);
  if (!call) return;
  clearTimeout(call.timer);
  const listener = users.get(call.target);
  if (listener && listener.ringing === callerToken) {
    listener.ringing = null;
    send(listener, { type: 'incoming-cancelled', reason });
  }
  pendingCalls.delete(callerToken);
}

function hangUp(token, reason = 'ended', notifyBoth = false) {
  const u = users.get(token);
  if (!u?.peer) return;
  endSession(token);
  const other = users.get(u.peer);
  u.canRate = true;
  if (other) other.canRate = true;
  u.peer = null;
  if (notifyBoth) send(u, { type: 'call-ended', reason });
  if (other) {
    other.peer = null;
    send(other, { type: 'call-ended', reason });
  }
  broadcastCounts();
}

// Fetch relay credentials for both people, then start the call and its clock.
async function connectPair(callerToken, listenerToken, minutes) {
  let ice = [DEV_ICE, DEV_ICE];
  if (TURN_ENABLED) {
    try {
      ice = await Promise.all([getIceServers(), getIceServers()]);
    } catch (err) {
      // Never fall back to a direct connection: that would expose IP addresses.
      console.error('TURN credentials failed:', err.message);
      ice = null;
    }
  }
  const caller = users.get(callerToken), listener = users.get(listenerToken);
  // Someone may have hung up or left while we waited.
  if (!caller || !listener || caller.peer !== listenerToken || listener.peer !== callerToken) return;
  if (!ice) {
    caller.peer = listener.peer = null;
    for (const p of [caller, listener]) send(p, { type: 'call-failed' });
    broadcastCounts();
    return;
  }
  const session = startSession(callerToken, listenerToken, minutes);
  const remainingMs = session.endsAt - Date.now();
  const relayOnly = TURN_ENABLED;
  send(caller, { type: 'connected', role: 'caller', peer: publicProfile(listener), remainingMs, iceServers: ice[0], relayOnly });
  send(listener, { type: 'connected', role: 'listener', peer: publicProfile(caller), remainingMs, iceServers: ice[1], relayOnly });
}

// ---- message handling ---------------------------------------------------
function handle(token, msg) {
  const u = users.get(token);
  if (!u) return;

  switch (msg.type) {
    case 'profile': {
      const losses = (Array.isArray(msg.losses) ? msg.losses : []).filter((l) => LOSSES.includes(l));
      u.losses = losses.length ? losses : ['other'];
      u.stage = STAGES.includes(msg.stage) ? msg.stage : 'new';
      send(u, { type: 'profile-ok', ...publicProfile(u) });
      break;
    }
    case 'set-available':
      u.available = !!msg.available && !suspended(token);
      send(u, { type: 'available', available: u.available });
      broadcastCounts();
      break;

    case 'call': {
      if (u.peer || pendingCalls.has(token)) return;
      if (suspended(token)) return send(u, { type: 'suspended' });
      const filters = {
        loss: LOSSES.includes(msg.loss) ? msg.loss : 'any',
        stage: STAGES.includes(msg.stage) ? msg.stage : 'any',
      };
      const minutes = CALL_LENGTHS.includes(Number(msg.minutes)) ? Number(msg.minutes) : CALL_LENGTHS[0];
      pendingCalls.set(token, { target: null, tried: new Set(), filters, minutes, timer: null });
      ringNext(token);
      break;
    }
    case 'cancel-call':
      cancelPending(token, 'cancelled');
      broadcastCounts();
      break;

    case 'answer-call': {
      const callerToken = u.ringing;
      const call = callerToken && pendingCalls.get(callerToken);
      if (!call || call.target !== token) return;
      clearTimeout(call.timer);
      u.ringing = null;
      if (!msg.accept) {
        ringNext(callerToken); // try someone else, quietly
        return;
      }
      pendingCalls.delete(callerToken);
      const caller = users.get(callerToken);
      caller.peer = token;
      u.peer = callerToken;
      broadcastCounts();
      connectPair(callerToken, token, call.minutes);
      break;
    }
    case 'signal': // WebRTC offer / answer / ICE, only between the paired people
      if (u.peer) send(users.get(u.peer), { type: 'signal', data: msg.data });
      break;

    case 'hang-up':
      hangUp(token, 'ended');
      break;

    case 'extend':
      voteExtend(token);
      break;

    case 'rate': {
      const stars = Number(msg.stars);
      if (!u.canRate || !ratings.hasOwnProperty(stars)) return;
      u.canRate = false; // one rating per call
      ratings[stars]++;
      break;
    }

    case 'report': {
      const other = u.peer;
      if (!other) return;
      if (!blocks.has(token)) blocks.set(token, new Set());
      blocks.get(token).add(other);
      reports.set(other, (reports.get(other) || 0) + 1);
      if (suspended(other)) {
        const o = users.get(other);
        if (o) o.available = false;
      }
      hangUp(token, 'ended');
      send(u, { type: 'reported' });
      break;
    }
  }
}

// ---- HTTP (static files) ------------------------------------------------
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket ----------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  let token = url.searchParams.get('t');
  if (!token || !/^[a-f0-9]{32}$/.test(token)) token = crypto.randomBytes(16).toString('hex');

  // One live connection per device token.
  const existing = users.get(token);
  if (existing) existing.ws.close();

  const u = { ws, alias: existing?.alias || alias(), losses: ['other'], stage: 'new',
    available: false, peer: null, ringing: null };
  users.set(token, u);
  send(u, { type: 'hello', token, alias: u.alias, suspended: suspended(token) });
  broadcastCounts();

  ws.on('message', (raw) => {
    if (raw.length > 64_000) return;
    try { handle(token, JSON.parse(raw)); } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    if (users.get(token)?.ws !== ws) return; // replaced by a newer connection
    cancelPending(token, 'cancelled');
    const ringingCaller = u.ringing;
    if (ringingCaller) { u.ringing = null; clearTimeout(pendingCalls.get(ringingCaller)?.timer); ringNext(ringingCaller); }
    hangUp(token, 'disconnected');
    users.delete(token);
    broadcastCounts();
  });
});

server.listen(PORT, () => {
  console.log(`Kindred running on http://localhost:${PORT}`);
  console.log(TURN_ENABLED
    ? 'Calls are relayed through Cloudflare TURN (IP addresses stay private).'
    : 'WARNING: CF_TURN_KEY_ID / CF_TURN_API_TOKEN not set. Calls connect directly, which is only OK for testing.');
});
