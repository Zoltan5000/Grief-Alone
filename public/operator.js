// Old-school telephone operator announcement, played locally on each phone
// (it is never sent over the call itself).
//
// If public/audio/operator.mp3 exists (for example, a voice actor's recording),
// it is played through a narrow "vintage phone line" filter with crackle.
// Otherwise the phone's built-in voice reads the line after the classic
// three-tone telephone intercept chime.

const Operator = (() => {
  const LINE = 'The call will end in one minute, but you can add time by pressing a button on your phone. '
    + 'If you both have the time to talk longer, the call will continue.';
  const RECORDING = 'audio/operator.mp3';

  let ctx = null;
  let recording; // undefined = not checked, null = none, AudioBuffer = loaded

  // Must be called from a tap (Call / Answer) so mobile browsers allow audio later.
  function unlock() {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch { ctx = null; }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(''); u.volume = 0;
      speechSynthesis.speak(u);
    }
    if (recording === undefined) loadRecording();
  }

  async function loadRecording() {
    recording = null;
    if (!ctx) return;
    try {
      const res = await fetch(RECORDING);
      if (res.ok) recording = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch { recording = null; }
  }

  // Classic "doo-dee-DOO" special-information tones.
  function chime(at) {
    const tones = [[913.8, 0.274], [1370.6, 0.274], [1776.7, 0.38]];
    let t = at;
    for (const [freq, len] of tones) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.01);
      g.gain.setValueAtTime(0.18, t + len - 0.02);
      g.gain.linearRampToValueAtTime(0, t + len);
      osc.connect(g).connect(ctx.destination);
      osc.start(t); osc.stop(t + len);
      t += len;
    }
    return t;
  }

  // Soft hiss with occasional pops, like an old line.
  function crackle(at, seconds) {
    const len = Math.ceil(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * 0.02;
      if (Math.random() < 0.0004) d[i] = (Math.random() * 2 - 1) * 0.5;
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(at); src.stop(at + seconds);
  }

  // Play a recording through a 300–3400 Hz telephone band with slight overdrive.
  function playRecording(at) {
    return new Promise((resolve) => {
      const src = ctx.createBufferSource(); src.buffer = recording;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
      const drive = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
      drive.curve = curve;
      src.connect(hp).connect(lp).connect(drive).connect(ctx.destination);
      src.onended = resolve;
      src.start(at);
    });
  }

  function speak() {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(LINE);
      const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith('en'));
      u.voice = voices.find((v) => /female|samantha|karen|moira|serena|victoria|zira|susan/i.test(v.name)) || voices[0] || null;
      u.rate = 0.88; u.pitch = 0.95; u.volume = 1;
      const done = () => { clearTimeout(fallback); resolve(); };
      const fallback = setTimeout(done, 12_000);
      u.onend = done; u.onerror = done;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  /** Plays the announcement. duck(true/false) lowers the other person's voice meanwhile. */
  async function announce(duck = () => {}) {
    duck(true);
    try {
      if (!ctx) unlock();
      if (ctx) {
        if (ctx.state === 'suspended') await ctx.resume();
        const start = ctx.currentTime + 0.05;
        if (recording) {
          crackle(start, recording.duration + 1.3);
          await playRecording(chime(start) + 0.25);
        } else {
          crackle(start, 1.4);
          const end = chime(start);
          await new Promise((r) => setTimeout(r, (end - ctx.currentTime + 0.25) * 1000));
          await speak();
        }
      } else {
        await speak();
      }
    } finally {
      duck(false);
    }
  }

  return { unlock, announce, LINE };
})();
