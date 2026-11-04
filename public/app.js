// Kindred client: profile, open line, matching, and a WebRTC voice call.

// Connection servers come from our server for each call (Cloudflare relay in production).
const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

const LOSS_TEXT = {
  parent: 'a parent', grandparent: 'a grandparent', sibling: 'a sibling', child: 'a child',
  partner: 'a partner', friend: 'a friend', other: 'someone close',
};
const STAGE_TEXT = { new: 'recently', older: 'some time ago' };

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  ws: null, token: store.get('token'), alias: null,
  profile: store.get('profile') || { losses: [], stage: null },
  available: false, pc: null, localStream: null, role: null,
  pendingSignals: [], endsAt: 0, timerId: null, muted: false, minutes: 2,
};

function describe(p) {
  const losses = p.losses.map((l) => LOSS_TEXT[l]).filter(Boolean);
  const who = losses.length > 1 ? losses.slice(0, -1).join(', ') + ' and ' + losses.at(-1) : losses[0];
  return `Lost ${who}, ${STAGE_TEXT[p.stage] || ''}`.trim();
}

// ---- screens ------------------------------------------------------------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => (s.hidden = s.id !== id));
  $('guide-tab').hidden = id === 'street' || id === 'welcome' || id === 'about-loss';
  document.body.classList.toggle('has-guide', !$('guide-tab').hidden);
  if ($('guide-tab').hidden) closeGuide();
  if (window.Scene) Scene.setScreen(id);
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));

// ---- connection ---------------------------------------------------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws${state.token ? `?t=${state.token}` : ''}`);
  state.ws = ws;
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    if (state.ws !== ws) return;
    endCallLocally();
    setTimeout(connect, 2000);
  };
}
const send = (msg) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg));

function onMessage(m) {
  switch (m.type) {
    case 'hello':
      state.token = m.token; store.set('token', m.token);
      state.alias = m.alias; $('my-alias').textContent = m.alias;
      if (state.profile.losses.length && state.profile.stage) {
        send({ type: 'profile', ...state.profile });
        if (state.available) send({ type: 'set-available', available: true });
      }
      if (m.suspended) toast('Your line is paused after reports from other callers.');
      break;
    case 'stats':
      $('open-count').textContent = m.openLines === 1
        ? '1 person has their line open right now'
        : `${m.openLines} people have their line open right now`;
      break;
    case 'available':
      state.available = m.available;
      $('available-toggle').checked = m.available;
      $('line-card').classList.toggle('open', m.available);
      $('line-hint').hidden = !m.available;
      $('line-status').textContent = m.available
        ? 'Your line is open. Someone may call you.'
        : 'Let someone call you when they need to talk.';
      break;

    // caller side
    case 'ringing':
      $('calling-title').textContent = 'Ringing someone…';
      $('calling-sub').textContent = 'If they can’t answer, we’ll gently try someone else.';
      break;
    case 'no-match':
      releaseMic();
      show('home');
      toast(m.tried ? 'No one could answer just now. Please try again soon.'
        : 'No one with that background has their line open right now. Try widening your choice.');
      break;
    case 'suspended':
      releaseMic(); show('home');
      toast('Calling is paused for you after reports from other people.');
      break;

    // listener side
    case 'incoming':
      $('incoming-title').textContent = m.from.alias;
      $('incoming-detail').textContent = `${describe(m.from)} · would like ${m.minutes} minutes`;
      $('incoming').hidden = false;
      navigator.vibrate?.([300, 200, 300]);
      break;
    case 'incoming-cancelled':
      $('incoming').hidden = true;
      if (m.reason === 'missed') toast('You missed a call. Your line is still open.');
      break;

    // both
    case 'connected':
      $('incoming').hidden = true;
      startCountdown(m.remainingMs);
      setGuideTab(m.role === 'caller' ? 'icebreakers' : 'listening');
      startCall(m.role, m.peer, m.iceServers, m.relayOnly);
      break;

    // call clock
    case 'one-minute':
      startCountdown(m.remainingMs);
      $('extend-box').hidden = false;
      $('extend-btn').disabled = false;
      $('extend-btn').textContent = 'Add 5 minutes';
      $('extend-text').textContent = 'One minute left. Want to keep talking?';
      Operator.announce((on) => { $('remote-audio').volume = on ? 0.25 : 1; });
      break;
    case 'extend-waiting':
      $('extend-btn').disabled = true;
      $('extend-btn').textContent = 'Waiting for them…';
      $('extend-text').textContent = 'You\u2019d like more time. If they press it too, the call continues.';
      break;
    case 'peer-wants-more':
      $('extend-text').textContent = 'They\u2019d like to keep talking. Only if you have the time.';
      break;
    case 'extended':
      startCountdown(m.remainingMs);
      $('extend-box').hidden = true;
      toast(`You both added ${m.added} more minutes.`);
      break;
    case 'signal':
      if (state.pc) handleSignal(m.data); else state.pendingSignals.push(m.data);
      break;
    case 'call-ended':
      endCallLocally();
      showAfterCall(m.reason === 'disconnected' ? 'The call dropped.'
        : m.reason === 'time' ? 'Your time together has ended.' : 'The call has ended.',
      'Thank you for being there. Be gentle with yourself for the next little while.', true);
      break;
    case 'reported':
      showAfterCall('You won\u2019t be matched with them again.',
        'We\u2019re sorry that happened. You did nothing wrong by leaving.', false);
      break;
    case 'call-failed':
      endCallLocally();
      show('home');
      toast('We couldn\u2019t set up a private line just now. Please try again in a moment.');
      break;
  }
}

// ---- profile ------------------------------------------------------------
function renderProfileForm() {
  document.querySelectorAll('#loss-chips .chip').forEach((c) =>
    c.classList.toggle('on', state.profile.losses.includes(c.dataset.loss)));
  document.querySelectorAll('#stage-options .option').forEach((o) =>
    o.classList.toggle('on', o.dataset.stage === state.profile.stage));
  $('save-profile').disabled = !(state.profile.losses.length && state.profile.stage);
}
$('loss-chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  const l = c.dataset.loss, ls = state.profile.losses;
  state.profile.losses = ls.includes(l) ? ls.filter((x) => x !== l) : [...ls, l];
  renderProfileForm();
});
$('stage-options').addEventListener('click', (e) => {
  const o = e.target.closest('.option'); if (!o) return;
  state.profile.stage = o.dataset.stage; renderProfileForm();
});
$('save-profile').addEventListener('click', () => {
  store.set('profile', state.profile);
  send({ type: 'profile', ...state.profile });
  show('home');
});

// ---- open line ----------------------------------------------------------
$('available-toggle').addEventListener('change', (e) => {
  send({ type: 'set-available', available: e.target.checked });
});

// ---- calling ------------------------------------------------------------
async function getMic() {
  if (state.localStream) return true;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return true;
  } catch {
    toast('Kindred needs your microphone to call. Please allow it in your browser settings.');
    return false;
  }
}
function releaseMic() {
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
}

$('length-choice').addEventListener('click', (e) => {
  const b = e.target.closest('[data-minutes]'); if (!b) return;
  state.minutes = Number(b.dataset.minutes);
  document.querySelectorAll('#length-choice [data-minutes]').forEach((x) =>
    x.setAttribute('aria-checked', String(x === b)));
});

async function placeCall() {
  Operator.unlock();
  if (!(await getMic())) return;
  $('calling-title').textContent = 'Looking for someone…';
  $('calling-sub').textContent = 'Take a breath. This can take a moment.';
  show('calling');
  send({ type: 'call', loss: $('filter-loss').value, stage: $('filter-stage').value, minutes: state.minutes });
}
$('call-btn').addEventListener('click', placeCall);
$('cancel-call').addEventListener('click', () => {
  send({ type: 'cancel-call' }); releaseMic(); show('home');
});

$('accept-btn').addEventListener('click', async () => {
  $('incoming').hidden = true;
  Operator.unlock();
  if (!(await getMic())) return send({ type: 'answer-call', accept: false });
  send({ type: 'answer-call', accept: true });
});
$('decline-btn').addEventListener('click', () => {
  $('incoming').hidden = true;
  send({ type: 'answer-call', accept: false });
});

async function startCall(role, peer, iceServers, relayOnly) {
  state.role = role;
  $('peer-alias').textContent = peer.alias;
  $('peer-detail').textContent = describe(peer);
  $('call-state').textContent = 'Connecting audio…';
  $('extend-box').hidden = true;
  state.muted = false; $('mute-btn').setAttribute('aria-pressed', 'false'); $('mute-btn').textContent = 'Mute';
  show('in-call');

  if (!(await getMic())) { send({ type: 'hang-up' }); return; }

  // relayOnly: audio goes only through the relay, so neither phone ever learns the other's IP address.
  const pc = new RTCPeerConnection({
    iceServers: iceServers?.length ? iceServers : FALLBACK_ICE,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
  });
  state.pc = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
  pc.ontrack = (e) => { $('remote-audio').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', data: { candidate: e.candidate } });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      $('call-state').textContent = 'Connected';
    } else if (pc.connectionState === 'failed') {
      $('call-state').textContent = 'Couldn’t connect audio on this network.';
    }
  };

  if (role === 'caller') {
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'signal', data: { sdp: pc.localDescription } });
  }
  const queued = state.pendingSignals.splice(0);
  for (const s of queued) await handleSignal(s);
}

async function handleSignal(data) {
  const pc = state.pc;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'signal', data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) { console.warn('signal error', err); }
}

// Counts down to the end the server set. The server ends the call, not this timer.
function startCountdown(remainingMs) {
  state.endsAt = Date.now() + remainingMs;
  clearInterval(state.timerId);
  const tick = () => {
    const s = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
    $('call-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('call-timer').classList.toggle('low', s <= 60);
    // Film-leader sweep: one turn per minute.
    const ms = Math.max(0, state.endsAt - Date.now());
    $('leader-sweep').style.setProperty('--sweep', `${((ms % 60000) / 60000) * 360}deg`);
    $('leader').classList.toggle('low', s <= 60);
  };
  tick();
  state.timerId = setInterval(tick, 250);
}

function endCallLocally() {
  state.pc?.close(); state.pc = null;
  state.pendingSignals = [];
  clearInterval(state.timerId); state.timerId = null;
  $('extend-box').hidden = true;
  window.speechSynthesis?.cancel();
  $('remote-audio').srcObject = null;
  releaseMic();
}

$('mute-btn').addEventListener('click', () => {
  state.muted = !state.muted;
  state.localStream?.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  $('mute-btn').setAttribute('aria-pressed', String(state.muted));
  $('mute-btn').textContent = state.muted ? 'Unmute' : 'Mute';
});
$('hangup-btn').addEventListener('click', () => {
  send({ type: 'hang-up' });
  endCallLocally();
  showAfterCall('Thank you for being here.',
    'However that felt, reaching out took courage. Be gentle with yourself for the next little while.', true);
});

// ---- after the call -----------------------------------------------------
function showAfterCall(title, sub, canRate) {
  $('after-title').textContent = title;
  $('after-sub').textContent = sub;
  $('rate-card').hidden = !canRate;
  $('stars').classList.remove('done');
  $('rate-thanks').hidden = true;
  document.querySelectorAll('#stars button').forEach((b) => {
    b.classList.remove('lit'); b.setAttribute('aria-checked', 'false'); b.disabled = false;
  });
  show('after-call');
}
$('stars').addEventListener('click', (e) => {
  const b = e.target.closest('[data-stars]');
  if (!b || $('stars').classList.contains('done')) return;
  const n = Number(b.dataset.stars);
  document.querySelectorAll('#stars button').forEach((x) => {
    x.classList.toggle('lit', Number(x.dataset.stars) <= n);
    x.setAttribute('aria-checked', String(x === b));
    x.disabled = true;
  });
  $('stars').classList.add('done');
  $('rate-thanks').hidden = false;
  send({ type: 'rate', stars: n });
});
$('call-again').addEventListener('click', placeCall);
$('after-close').addEventListener('click', () => show('home'));
$('report-btn').addEventListener('click', () => {
  if (!confirm('End this call and make sure you are never matched with this person again?')) return;
  send({ type: 'report' });
  endCallLocally();
});

$('extend-btn').addEventListener('click', () => send({ type: 'extend' }));

// ---- pull-out guide -----------------------------------------------------
function setGuideTab(name) {
  document.querySelectorAll('[data-guide-tab]').forEach((t) =>
    t.setAttribute('aria-selected', String(t.dataset.guideTab === name)));
  $('guide-icebreakers').hidden = name !== 'icebreakers';
  $('guide-listening').hidden = name !== 'listening';
}
function openGuide() {
  $('guide').classList.add('open'); $('guide').setAttribute('aria-hidden', 'false');
  $('guide-scrim').hidden = false; $('guide-tab').setAttribute('aria-expanded', 'true');
}
function closeGuide() {
  $('guide').classList.remove('open'); $('guide').setAttribute('aria-hidden', 'true');
  $('guide-scrim').hidden = true; $('guide-tab').setAttribute('aria-expanded', 'false');
}
document.querySelectorAll('[data-open-guide]').forEach((b) => b.addEventListener('click', openGuide));
$('guide-close').addEventListener('click', closeGuide);
$('guide-scrim').addEventListener('click', closeGuide);
document.querySelectorAll('[data-guide-tab]').forEach((t) =>
  t.addEventListener('click', () => setGuideTab(t.dataset.guideTab)));
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeGuide());

// Swipe the guide closed to the right.
let swipeX = null;
$('guide').addEventListener('touchstart', (e) => (swipeX = e.touches[0].clientX), { passive: true });
$('guide').addEventListener('touchend', (e) => {
  if (swipeX !== null && e.changedTouches[0].clientX - swipeX > 60) closeGuide();
  swipeX = null;
});

// ---- start --------------------------------------------------------------
renderProfileForm();
initResources();
Scene.init();
show('street');
$('step-inside').addEventListener('click', () => {
  Operator.unlock(); // a tap: a good moment to allow sound later
  Scene.stepInside(() => show(state.profile.losses.length && state.profile.stage ? 'home' : 'welcome'));
});
connect();
