'use strict';
/*
 * 기도음악 타이머 – web app (iPhone & Android browsers, installable to the home screen).
 * Same ideas as the Android app, minus what browsers can't do (scheduled auto-start,
 * Do Not Disturb, YouTube). Music files are copied into the browser (IndexedDB) so they
 * keep playing without the cloud drive; settings live in localStorage.
 */
const VERSION = '1.2.3';

// ---------- storage ----------

const DEFAULTS = {
  fadeInOn: true, fadeInSec: 10, fadeOutOn: true, fadeOutSec: 30,
  volume: 100, loop: true, shuffle: false, resume: false,
  timerMin: 10, stopAtClock: false, stopHour: 6, stopMinute: 0,
};
const s = Object.assign({}, DEFAULTS, readJson('settings', {}));
// 1.2 changed the default from 30 to 10 minutes. Move people still on the old default once;
// anyone who chose another time (or "시각에 꺼짐") keeps it.
if (!s.default10) {
  if (s.timerMin === 30 && !s.stopAtClock) s.timerMin = 10;
  s.default10 = true;
  try { localStorage.setItem('settings', JSON.stringify(s)); } catch {}
}
let tracks = readJson('tracks', []);           // [{id, name, kind: 'file'|'url', url?}]

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveSettings() { try { localStorage.setItem('settings', JSON.stringify(s)); } catch {} }
function saveTracks() { syncQueue(); try { localStorage.setItem('tracks', JSON.stringify(tracks)); } catch {} }

/** Audio blobs, keyed by track id. */
const blobs = (() => {
  let dbp;
  const db = () => dbp ??= new Promise((ok, fail) => {
    const r = indexedDB.open('prayer-music', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('blobs');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  const tx = async (mode, fn) => {
    const store = (await db()).transaction('blobs', mode).objectStore('blobs');
    return new Promise((ok, fail) => { const r = fn(store); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
  };
  return {
    put: (id, blob) => tx('readwrite', st => st.put(blob, id)),
    get: id => tx('readonly', st => st.get(id)),
    del: id => tx('readwrite', st => st.delete(id)),
  };
})();

// Ask the browser not to clear our music when space is low (home-screen apps usually get this).
navigator.storage?.persist?.();

// ---------- helpers ----------

const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, '0');
function formatMs(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}
function clockText(h, m) { return `${h < 12 ? '오전' : '오후'} ${(h % 12) || 12}:${pad2(m)}`; }
function msUntil(h, m) {
  const now = new Date(), at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at - now;
}
function displayTitle(t) { return t.name.replace(/\.(mp3|m4a|aac|wav|ogg|flac|opus|webm)$/i, ''); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
let toastTimer;
/** A sticky toast stays until it is tapped (for messages people must be able to read). */
function toast(msg, sticky = false) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  el.classList.toggle('sticky', sticky);
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
$('toast').addEventListener('click', () => { clearTimeout(toastTimer); $('toast').hidden = true; });

// ---------- player ----------
/*
 * Files (and links that allow it) go through Web Audio so fades work everywhere – iPhone
 * ignores <audio>.volume. The fade-out is scheduled on the audio clock, so it still happens
 * on time if the browser slows down our timers. Links from servers that block Web Audio
 * play through a plain <audio> element; there fades use .volume (Android only).
 */
const player = {
  el: new Audio(),        // routed through Web Audio
  raw: new Audio(),       // plain fallback for other-site links
  ctx: null, fade: null, master: null,
  running: false, queue: [], index: 0,
  startAt: 0, endAt: 0,   // Date.now() based; endAt 0 = no limit
  objectUrl: null, usingRaw: false, failures: 0, pendingSeek: 0,
  wakeLock: null, tick: 0,
};
player.el.preload = 'auto';
player.el.crossOrigin = 'anonymous';
player.raw.preload = 'auto';

function ensureAudioGraph() {
  if (player.ctx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  player.ctx = new Ctx();
  player.master = player.ctx.createGain();
  player.fade = player.ctx.createGain();
  player.ctx.createMediaElementSource(player.el).connect(player.fade);
  player.fade.connect(player.master);
  player.master.connect(player.ctx.destination);
}

/** 0..1 loudness from the fade envelope at time t (Date.now based). */
function envelopeAt(t) {
  let f = 1;
  if (s.fadeInOn && s.fadeInSec > 0) f = Math.min(f, (t - player.startAt) / (s.fadeInSec * 1000));
  const fo = s.fadeOutOn ? s.fadeOutSec * 1000 : 0;
  if (player.endAt && fo > 0 && t >= player.endAt - fo) f = Math.min(f, (player.endAt - t) / fo);
  f = Math.max(0, Math.min(1, f));
  return f * f; // squared: sounds like an even fade to the ear
}

/** Hands the whole fade-in / fade-out curve to the audio clock in one go. */
function scheduleEnvelope() {
  const g = player.fade.gain, ctx = player.ctx;
  const now = ctx.currentTime, wall = Date.now();
  g.cancelScheduledValues(now);
  g.setValueAtTime(envelopeAt(wall), now);
  const end = player.endAt ? (player.endAt - wall) / 1000 : 0;
  const steps = [];
  const fi = s.fadeInOn ? s.fadeInSec : 0;
  for (let x = 0.25; fi > 0 && x <= fi; x += 0.25) {
    const at = (player.startAt + x * 1000 - wall) / 1000;
    if (at > 0) steps.push(at);
  }
  const fo = s.fadeOutOn ? s.fadeOutSec : 0;
  if (end > 0) {
    for (let x = fo; x >= 0; x -= 0.25) { const at = end - x; if (at > 0) steps.push(at); }
    steps.push(end);
  }
  steps.sort((a, b) => a - b).forEach(at => g.linearRampToValueAtTime(envelopeAt(wall + at * 1000), now + at));
}

function setMasterVolume() {
  if (player.master) player.master.gain.value = s.volume / 100;
}

/**
 * iPhone only lets a page start sound from a tap. Loading the songs takes a moment, so both
 * players are "unlocked" right away with a tiny silent clip while the tap is still fresh.
 */
let silentUrl;
function unlockMedia() {
  if (!silentUrl) {
    const rate = 8000, n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  for (const el of [player.el, player.raw]) { el.src = silentUrl; el.play().catch(() => {}); }
}

async function start() {
  if (!tracks.length) { toast('먼저 재생할 음악을 추가해 주세요'); openPanel('musicPanel'); return; }
  unlockMedia();
  ensureAudioGraph();
  if (player.ctx.state !== 'running') await player.ctx.resume();
  setMasterVolume();

  const duration = s.stopAtClock ? msUntil(s.stopHour, s.stopMinute) : s.timerMin * 60000;
  player.startAt = Date.now();
  player.endAt = duration > 0 ? player.startAt + duration : 0;
  player.queue = s.shuffle ? shuffled(tracks) : tracks.slice();
  player.index = 0; player.failures = 0; player.pendingSeek = 0;

  const point = s.resume ? readJson('resumePoint', null) : null;
  const at = point ? tracks.find(t => t.id === point.id) : null;
  if (at) {
    player.queue = s.shuffle ? [at, ...shuffled(tracks.filter(t => t !== at))] : tracks.slice();
    player.index = player.queue.indexOf(at);
    player.pendingSeek = point.pos || 0;
  }
  player.running = true;
  scheduleEnvelope();
  keepScreenOn();
  await playCurrent();
  clearInterval(player.tick);
  player.tick = setInterval(onTick, 250);
  if (s.stopAtClock) toast(`${clockText(s.stopHour, s.stopMinute)}에 꺼져요 (${formatMs(duration)} 후)`);
  render();
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- YouTube ----------
/*
 * YouTube plays in its own player inside the playback card (it must stay visible).
 * Fades use the player's volume; iPhone ignores that, so there it simply stops on time.
 */
const yt = { api: null, player: null, ready: false, startTimer: 0 };

function ytRef(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    const list = u.searchParams.get('list');
    let v = null;
    if (host === 'youtu.be') v = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const seg = u.pathname.split('/').filter(Boolean);
      v = seg[0] === 'watch' ? u.searchParams.get('v') : ['shorts', 'live', 'embed'].includes(seg[0]) ? seg[1] : null;
    } else return null;
    const ok = x => x && /^[\w-]{6,}$/.test(x);
    if (!ok(v) && !ok(list)) return null;
    return { v: ok(v) ? v : null, list: ok(list) ? list : null };
  } catch { return null; }
}

function loadYtApi() {
  return yt.api ??= new Promise(resolve => {
    window.onYouTubeIframeAPIReady = resolve;
    const sc = document.createElement('script');
    sc.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(sc);
  });
}

const currentIsYouTube = () => player.running && player.queue[player.index]?.kind === 'youtube';

async function playYouTube(t) {
  const ref = ytRef(t.url);
  if (!ref) return trackFailed();
  $('ytBox').hidden = false;
  const startSeconds = Math.floor(player.pendingSeek / 1000);
  player.pendingSeek = 0;
  try { await loadYtApi(); } catch { return trackFailed(); }
  if (!player.running) return;
  const volume = Math.round(envelopeAt(Date.now()) * s.volume);
  if (!yt.player) {
    yt.player = new YT.Player('ytPlayer', {
      width: '100%', height: '100%', videoId: ref.v || undefined,
      playerVars: Object.assign({ playsinline: 1, rel: 0, autoplay: 1, start: startSeconds },
        ref.list ? { listType: 'playlist', list: ref.list } : {}),
      events: {
        onReady: e => { yt.ready = true; e.target.setVolume(volume); e.target.playVideo(); },
        onStateChange: onYtState,
        onError: e => {
          if (!currentIsYouTube()) return;
          // 101/150: the uploader allows playback only on YouTube itself.
          if (e.data === 101 || e.data === 150) {
            const t = player.queue[player.index];
            t.blocked = true; saveTracks(); renderTracks();
            toast(`'${displayTitle(t)}' 영상은 유튜브 밖에서 재생이 막혀 있어요. 목록에 ⚠ 표시를 해 두었어요. 다른 영상을 골라 주세요 (눌러서 닫기)`, true);
          }
          trackFailed();
        },
      },
    });
  } else if (ref.list) {
    yt.player.setVolume(volume);
    yt.player.loadPlaylist({ list: ref.list, listType: 'playlist', index: 0, startSeconds });
  } else {
    yt.player.setVolume(volume);
    yt.player.loadVideoById({ videoId: ref.v, startSeconds });
  }
  // iPhone may not let YouTube start by itself; ask for one tap on the video.
  clearTimeout(yt.startTimer);
  yt.startTimer = setTimeout(() => {
    if (currentIsYouTube() && yt.player?.getPlayerState?.() !== YT.PlayerState.PLAYING) {
      toast('유튜브 화면의 ▶를 한 번 눌러 주세요');
    }
  }, 3500);
}

function onYtState(e) {
  if (!currentIsYouTube()) return;
  if (e.data === YT.PlayerState.PLAYING) {
    player.failures = 0;
    const t = player.queue[player.index];
    if (t.blocked) { delete t.blocked; saveTracks(); renderTracks(); } // it plays after all
  }
  if (e.data === YT.PlayerState.ENDED) {
    const pl = yt.player.getPlaylist?.();
    if (pl && pl.length && yt.player.getPlaylistIndex() < pl.length - 1) return; // playlist continues
    advance();
  }
}

function stopYouTube() {
  clearTimeout(yt.startTimer);
  try { yt.player?.stopVideo?.(); } catch {}
  $('ytBox').hidden = true;
}

async function playCurrent() {
  if (!player.running) return;
  const t = player.queue[player.index];
  releaseSource();
  if (t.kind === 'youtube') {
    await playYouTube(t);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: displayTitle(t), artist: '기도음악 타이머' });
    render();
    return;
  }
  stopYouTube();
  let src;
  if (t.kind === 'file') {
    const blob = await blobs.get(t.id).catch(() => null);
    if (!blob) return trackFailed();
    player.objectUrl = URL.createObjectURL(blob);
    src = player.objectUrl;
  } else {
    src = t.url;
  }
  player.usingRaw = false;
  const ok = await tryPlay(player.el, src);
  if (!ok && t.kind === 'url') {
    // The other site doesn't allow Web Audio; play it plainly (fades by .volume where supported).
    player.usingRaw = true;
    player.raw.volume = envelopeAt(Date.now()) * s.volume / 100;
    if (!(await tryPlay(player.raw, t.url))) return trackFailed();
  } else if (!ok) {
    return trackFailed();
  }
  player.failures = 0;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: displayTitle(t), artist: '기도음악 타이머' });
  }
  render();
}

function tryPlay(el, src) {
  return new Promise(resolve => {
    const done = ok => { el.oncanplay = el.onerror = null; resolve(ok); };
    el.onerror = () => done(false);
    el.oncanplay = async () => {
      if (player.pendingSeek > 0) {
        try { el.currentTime = player.pendingSeek / 1000; } catch {}
        player.pendingSeek = 0;
      }
      try { await el.play(); done(true); } catch { done(false); }
    };
    el.src = src;
    el.load();
  });
}

function releaseSource() {
  for (const el of [player.el, player.raw]) { el.pause(); el.removeAttribute('src'); el.load(); }
  if (player.objectUrl) { URL.revokeObjectURL(player.objectUrl); player.objectUrl = null; }
}

function trackFailed() {
  player.failures++;
  if (player.failures >= player.queue.length) {
    const blocked = document.getElementById('toast').textContent.includes('막혀');
    stop();
    if (!blocked) toast('재생할 수 있는 음악이 없어요');
    return;
  }
  advance();
}

function advance() {
  if (!player.running) return;
  player.index++;
  if (player.index >= player.queue.length) {
    if (!s.loop) { localStorage.removeItem('resumePoint'); stop(true); return; }
    player.index = 0;
    player.queue = s.shuffle ? shuffled(tracks) : tracks.slice();
    if (!player.queue.length) { stop(true); return; }
  }
  playCurrent();
}

/**
 * The list changed while playing: the current song keeps going and the next ones follow the new list.
 * Shuffle keeps its own order, only dropping removed songs and adding new ones at the end.
 */
function syncQueue() {
  if (!player.running) return;
  const cur = player.queue[player.index];
  let q;
  if (s.shuffle) {
    q = player.queue.filter(t => t === cur || tracks.includes(t));
    tracks.forEach(t => { if (!q.includes(t)) q.push(t); });
  } else {
    q = tracks.slice();
    // A removed current song stays where it was, so the song after it still plays next.
    if (cur && !q.includes(cur)) q.splice(Math.min(player.index, q.length), 0, cur);
  }
  player.queue = q;
  player.index = Math.max(0, q.indexOf(cur));
}
player.el.addEventListener('ended', () => !player.usingRaw && advance());
player.raw.addEventListener('ended', () => player.usingRaw && advance());

function saveResumePoint() {
  const t = player.queue[player.index];
  if (!t) return;
  let sec;
  if (t.kind === 'youtube') sec = yt.ready ? (yt.player.getCurrentTime?.() || 0) : 0;
  else sec = (player.usingRaw ? player.raw : player.el).currentTime;
  try { localStorage.setItem('resumePoint', JSON.stringify({ id: t.id, pos: Math.round(sec * 1000) })); } catch {}
}

/** Stopping by hand is immediate; only the automatic end fades out. */
function stop(completed = false) {
  if (player.running && !completed) saveResumePoint();
  player.running = false;
  clearInterval(player.tick);
  releaseSource();
  stopYouTube();
  if (player.fade) { player.fade.gain.cancelScheduledValues(player.ctx.currentTime); player.fade.gain.value = 1; }
  releaseScreen();
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  render();
}

let lastSave = 0;
function onTick() {
  if (!player.running) return;
  const now = Date.now();
  if (player.endAt && now >= player.endAt) { stop(); return; }
  if (currentIsYouTube()) { if (yt.ready) yt.player.setVolume(Math.round(envelopeAt(now) * s.volume)); }
  else if (player.usingRaw) player.raw.volume = Math.min(1, envelopeAt(now) * s.volume / 100);
  if (now - lastSave > 5000) { lastSave = now; saveResumePoint(); }
  renderHero();
}

// When the page comes back (e.g. screen turned on again), catch up at once.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (player.running) { onTick(); keepScreenOn(); }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('pause', () => stop());
  navigator.mediaSession.setActionHandler('stop', () => stop());
}

// Keep the screen on while playing (phones stop web timers when the screen is off).
async function keepScreenOn() {
  try { if (navigator.wakeLock && !player.wakeLock) player.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  player.wakeLock?.addEventListener?.('release', () => (player.wakeLock = null));
}
function releaseScreen() { player.wakeLock?.release?.(); player.wakeLock = null; }

// ---------- rendering ----------

const PLAY = 'M8,5v14l11,-7z', STOP = 'M7,7h10v10H7z';

function resumeTarget() {
  if (!s.resume) return null;
  const p = readJson('resumePoint', null);
  const t = p && tracks.find(x => x.id === p.id);
  return t ? { t, pos: p.pos || 0 } : null;
}

function renderHero() {
  const state = $('heroState'), title = $('heroTitle'), time = $('heroTime'), sub = $('heroSub');
  if (player.running) {
    const now = Date.now();
    const rem = player.endAt ? player.endAt - now : -1;
    const fo = s.fadeOutOn ? s.fadeOutSec * 1000 : 0;
    const ending = player.endAt && fo > 0 && rem <= fo;
    state.hidden = false;
    state.textContent = ending ? '곧 꺼져요' : '재생 중';
    const t = player.queue[player.index];
    title.textContent = t ? displayTitle(t) : '준비 중…';
    time.textContent = rem >= 0 ? formatMs(rem) : '∞';
    sub.textContent = ending ? '부드럽게 끝나는 중이에요'
      : rem >= 0 ? `${clockText(new Date(player.endAt).getHours(), new Date(player.endAt).getMinutes())}에 꺼져요`
      : '직접 끌 때까지 재생해요';
    $('playIcon').innerHTML = `<path d="${STOP}"/>`;
    return;
  }
  const r = resumeTarget();
  state.hidden = !r;
  if (r) state.textContent = `이어서 재생 · ${formatMs(r.pos)}부터`;
  title.textContent = r ? displayTitle(r.t)
    : tracks.length === 0 ? '재생할 음악을 추가해 주세요'
    : tracks.length === 1 ? displayTitle(tracks[0])
    : `${displayTitle(tracks[0])} 외 ${tracks.length - 1}곡`;
  if (s.stopAtClock) { time.textContent = clockText(s.stopHour, s.stopMinute); sub.textContent = '재생하면 이 시각에 꺼져요'; }
  else if (s.timerMin === 0) { time.textContent = '∞'; sub.textContent = '직접 끌 때까지 재생해요'; }
  else { time.textContent = formatMs(s.timerMin * 60000); sub.textContent = `재생하면 ${s.timerMin}분 후 꺼져요`; }
  $('playIcon').innerHTML = `<path d="${PLAY}"/>`;
}

function render() {
  $('offValue').textContent = s.stopAtClock ? clockText(s.stopHour, s.stopMinute) : s.timerMin === 0 ? '직접 끄기' : `${s.timerMin}분 후`;
  $('musicValue').textContent = `${tracks.length}곡`;
  $('fadeInValue').textContent = s.fadeInOn && s.fadeInSec > 0 ? `${s.fadeInSec}초` : '끔';
  $('fadeOutValue').textContent = s.fadeOutOn && s.fadeOutSec > 0 ? `${s.fadeOutSec}초` : '끔';
  $('volumeValue').textContent = `${s.volume}%`;
  $('modeTimer').classList.toggle('on', !s.stopAtClock);
  $('modeClock').classList.toggle('on', s.stopAtClock);
  $('minutesBox').hidden = s.stopAtClock;
  $('clockBox').hidden = !s.stopAtClock;
  $('stopTimeBtn').textContent = clockText(s.stopHour, s.stopMinute);
  document.querySelectorAll('.switch[data-key]').forEach(sw => (sw.checked = !!s[sw.dataset.key]));
  document.querySelectorAll('.stepper').forEach(st => {
    const input = st.querySelector('input');
    if (input && document.activeElement !== input) input.value = s[st.dataset.key];
  });
  $('volume').value = s.volume;
  renderHero();
}

// ---------- folding rows ----------

function openPanel(id, force) {
  document.querySelectorAll('.row[data-panel]').forEach(row => {
    const panel = $(row.dataset.panel);
    const show = row.dataset.panel === id && (force || panel.hidden);
    panel.hidden = !show;
    row.classList.toggle('open', show);
  });
  document.activeElement?.blur?.();
}
document.querySelectorAll('.row[data-panel]').forEach(row =>
  row.addEventListener('click', () => openPanel(row.dataset.panel)));

/** Folds every open section (values are already saved as they change). */
function closePanels() { openPanel(null); }

// "확인" at the bottom of each section: done adjusting, fold it up.
document.querySelectorAll('.panel').forEach(panel => {
  const ok = document.createElement('button');
  ok.className = 'panel-ok';
  ok.textContent = '확인';
  ok.addEventListener('click', closePanels);
  panel.appendChild(ok);
});

// ---------- controls ----------

$('playBtn').addEventListener('click', () => (player.running ? stop() : start()));
$('modeTimer').addEventListener('click', () => { s.stopAtClock = false; saveSettings(); render(); });
$('modeClock').addEventListener('click', () => { s.stopAtClock = true; saveSettings(); render(); });

document.querySelectorAll('.switch[data-key]').forEach(sw => sw.addEventListener('change', () => {
  s[sw.dataset.key] = sw.checked; saveSettings(); render();
}));

$('volume').addEventListener('input', e => {
  s.volume = +e.target.value; setMasterVolume(); saveSettings(); render();
  if (currentIsYouTube() && yt.ready) yt.player.setVolume(Math.round(envelopeAt(Date.now()) * s.volume));
});

/** [−] value [+] unit; tap = one step, hold = keep stepping. */
document.querySelectorAll('.stepper').forEach(st => {
  const key = st.dataset.key, min = +st.dataset.min, max = +st.dataset.max, step = +st.dataset.step;
  st.innerHTML = `<button class="round" aria-label="줄이기">−</button>
    <input type="text" inputmode="numeric" maxlength="3">
    <button class="round" aria-label="늘리기">+</button><span class="unit">${st.dataset.unit}</span>`;
  const [minus, input, plus] = st.querySelectorAll('button, input');
  const set = v => { s[key] = Math.max(min, Math.min(max, v)); saveSettings(); render(); };
  input.addEventListener('input', () => { const v = parseInt(input.value, 10); if (!isNaN(v)) set(v); });
  input.addEventListener('focus', () => input.select());
  for (const [btn, d] of [[minus, -step], [plus, step]]) {
    let timer, repeat;
    const stopHold = () => { clearTimeout(timer); clearInterval(repeat); };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      set(s[key] + d);
      timer = setTimeout(() => (repeat = setInterval(() => set(s[key] + d), 100)), 450);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, stopHold));
  }
});

// ---------- playlist ----------

const ICON = {
  file: ['#FF2D55', 'M12,3v10.55c-0.59,-0.34 -1.27,-0.55 -2,-0.55 -2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4V7h4V3h-6z'],
  youtube: ['#FF3B30', 'M21.58,7.19c-0.23,-0.86 -0.91,-1.54 -1.77,-1.77C18.25,5 12,5 12,5s-6.25,0 -7.81,0.42c-0.86,0.23 -1.54,0.91 -1.77,1.77C2,8.75 2,12 2,12s0,3.25 0.42,4.81c0.23,0.86 0.91,1.54 1.77,1.77C5.75,19 12,19 12,19s6.25,0 7.81,-0.42c0.86,-0.23 1.54,-0.91 1.77,-1.77C22,15.25 22,12 22,12s0,-3.25 -0.42,-4.81zM10,15V9l5.2,3 -5.2,3z'],
  url: ['#8E8E93', 'M3.9,12c0,-1.71 1.39,-3.1 3.1,-3.1h4V7H7c-2.76,0 -5,2.24 -5,5s2.24,5 5,5h4v-1.9H7c-1.71,0 -3.1,-1.39 -3.1,-3.1zM8,13h8v-2H8v2zM17,7h-4v1.9h4c1.71,0 3.1,1.39 3.1,3.1s-1.39,3.1 -3.1,3.1h-4V17h4c2.76,0 5,-2.24 5,-5s-2.24,-5 -5,-5z'],
};
const DELETE = 'M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2V7H6v12zM19,4h-3.5l-1,-1h-5l-1,1H5v2h14V4z';
const HANDLE = 'M20,9H4v2h16V9zM4,15h16v-2H4v2z';

function renderTracks() {
  const list = $('trackList');
  list.innerHTML = '';
  if (!tracks.length) { list.innerHTML = '<li class="empty">아직 음악이 없어요. 위 버튼으로 추가해 보세요</li>'; }
  tracks.forEach((t, i) => {
    const [color, path] = ICON[t.kind] || ICON.file;
    const li = document.createElement('li');
    li.className = 'track';
    li.innerHTML = `<span class="badge" style="--c:${color}"><svg viewBox="0 0 24 24"><path d="${path}"/></svg></span>
      <span class="name"></span>
      <button class="icon-btn delete" aria-label="삭제"><svg viewBox="0 0 24 24"><path d="${DELETE}"/></svg></button>
      <span class="icon-btn handle" aria-label="끌어서 순서 바꾸기"><svg viewBox="0 0 24 24"><path d="${HANDLE}"/></svg></span>`;
    li.querySelector('.name').textContent = displayTitle(t);
    if (t.blocked) li.querySelector('.name').insertAdjacentHTML('afterbegin', '<span class="blocked-tag">⚠ 재생 불가</span>');
    li.querySelector('.name').addEventListener('click', () => openRename(i));
    li.querySelector('.delete').addEventListener('click', () => removeTrack(i));
    dragWith(li.querySelector('.handle'), li, i);
    list.appendChild(li);
  });
  render();
}

async function removeTrack(i) {
  const [t] = tracks.splice(i, 1);
  saveTracks();
  if (t.kind === 'file') blobs.del(t.id).catch(() => {});
  renderTracks();
}

/** Press and hold ≡, move up or down, let go where the song should go. */
function dragWith(handle, li, from) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const rows = [...$('trackList').children];
    const startY = e.clientY;
    const tops = rows.map(r => r.offsetTop + r.offsetHeight / 2);
    const gap = li.offsetHeight;
    let target = from;
    li.classList.add('dragging');
    navigator.vibrate?.(15);
    rows.forEach(r => r !== li && r.classList.add('shift'));
    const move = ev => {
      const dy = ev.clientY - startY;
      li.style.transform = `translateY(${dy}px) scale(1.02)`;
      const center = tops[from] + dy;
      target = tops.reduce((best, c, k) => (Math.abs(c - center) < Math.abs(tops[best] - center) ? k : best), from);
      rows.forEach((r, k) => {
        if (k === from) return;
        const shift = k > from && k <= target ? -gap : k < from && k >= target ? gap : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      rows.forEach(r => { r.style.transform = ''; r.classList.remove('shift', 'dragging'); });
      if (target !== from) {
        tracks.splice(target, 0, tracks.splice(from, 1)[0]);
        // A new order means "play it this way": the next ▶ starts from the top, not where it stopped.
        if (!player.running) localStorage.removeItem('resumePoint');
        saveTracks();
        setTimeout(renderTracks, 0); // rebuild after this touch is fully handled
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

$('fileInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  toast('음악을 저장하는 중…');
  let ok = 0;
  for (const f of files) {
    const id = newId();
    try { await blobs.put(id, f); tracks.push({ id, name: f.name, kind: 'file' }); ok++; } catch {}
  }
  saveTracks();
  renderTracks();
  toast(ok === files.length ? `${ok}곡을 추가했어요` : `${ok}곡만 추가했어요. 저장 공간을 확인해 주세요`);
});

function openLinkSheet(url = '', name = '') {
  $('linkUrl').value = url;
  $('linkName').value = name;
  $('linkSheet').hidden = false;
}
$('addLinkBtn').addEventListener('click', () => openLinkSheet());
$('linkCancel').addEventListener('click', () => ($('linkSheet').hidden = true));

$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const m = text.match(/https?:\/\/\S+/);
    if (m) $('linkUrl').value = m[0]; else toast('복사된 링크가 없어요');
  } catch {
    toast('주소 칸을 길게 눌러 붙여넣기 해 주세요');
    $('linkUrl').focus();
  }
});

/** Plain link without tracking or mobile-site parts, so the same song isn't added twice. */
function canonicalYouTube(ref) {
  if (ref.v && ref.list) return `https://www.youtube.com/watch?v=${ref.v}&list=${ref.list}`;
  if (ref.v) return `https://www.youtube.com/watch?v=${ref.v}`;
  return `https://www.youtube.com/playlist?list=${ref.list}`;
}

async function youTubeTitle(url) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (r.ok) return (await r.json()).title || null;
  } catch {}
  return null;
}

function addLink(raw, givenName) {
  const m = raw.match(/https?:\/\/\S+/);
  if (!m) { toast('http:// 또는 https:// 로 시작하는 주소를 넣어 주세요'); return false; }
  const ref = ytRef(m[0]);
  if (/spotify\.com/i.test(m[0])) { toast('스포티파이는 웹 앱에서 재생할 수 없어요'); return false; }
  const url = ref ? canonicalYouTube(ref) : m[0];
  if (tracks.some(t => t.url === url)) { toast('이미 목록에 있어요'); return false; }
  const kind = ref ? 'youtube' : 'url';
  const fallback = ref ? (ref.v ? '유튜브 영상' : '유튜브 재생목록') : decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url);
  const t = { id: newId(), name: givenName || fallback, kind, url };
  tracks.push(t);
  saveTracks(); renderTracks();
  toast(ref ? '유튜브 곡을 추가했어요' : '주소를 추가했어요');
  if (ref && !givenName) {
    // Fill in the real title when YouTube tells us (the user can still rename it).
    youTubeTitle(url).then(title => { if (title && t.name === fallback) { t.name = title; saveTracks(); renderTracks(); } });
  }
  return true;
}

$('linkOk').addEventListener('click', () => {
  if (addLink($('linkUrl').value.trim(), $('linkName').value.trim())) $('linkSheet').hidden = true;
});

// YouTube search: opens YouTube (app or site); coming back opens the add sheet ready to paste.
let awaitingYouTube = false;
$('ytFindBtn').addEventListener('click', () => {
  $('shareTip').hidden = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('ytSheet').hidden = false;
});
$('ytCancel').addEventListener('click', () => ($('ytSheet').hidden = true));
$('ytGo').addEventListener('click', () => {
  const q = $('ytQuery').value.trim() || '찬양 기도음악';
  awaitingYouTube = true;
  $('ytSheet').hidden = true;
  window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, '_blank');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && awaitingYouTube) {
    awaitingYouTube = false;
    openLinkSheet();
    toast('복사한 링크를 붙여넣기 해 주세요');
  }
});

// ---------- rename ----------

let renameIndex = -1;
function openRename(i) {
  renameIndex = i;
  $('renameInput').value = tracks[i].name;
  $('renameSheet').hidden = false;
  setTimeout(() => $('renameInput').select(), 50);
}
$('renameCancel').addEventListener('click', () => ($('renameSheet').hidden = true));
$('renameOk').addEventListener('click', () => {
  const name = $('renameInput').value.trim();
  if (name && tracks[renameIndex]) { tracks[renameIndex].name = name; saveTracks(); renderTracks(); }
  $('renameSheet').hidden = true;
});

// ---------- time wheel ----------

const wheel = { pm: false };

function buildWheel(el, values) {
  el.innerHTML = '<div class="pad"></div>' + values.map(v => `<div>${v}</div>`).join('') + '<div class="pad"></div>';
  const rows = () => [...el.children].slice(1, -1);
  const mark = () => {
    const i = Math.round(el.scrollTop / 60);
    rows().forEach((r, k) => r.classList.toggle('sel', k === i));
  };
  el.addEventListener('scroll', mark, { passive: true });
  return {
    get: () => Math.max(0, Math.min(values.length - 1, Math.round(el.scrollTop / 60))),
    set: i => { el.scrollTop = i * 60; mark(); },
  };
}
const hourWheel = buildWheel($('hourWheel'), Array.from({ length: 12 }, (_, i) => String(i + 1)));
const minuteWheel = buildWheel($('minuteWheel'), Array.from({ length: 60 }, (_, i) => pad2(i)));

function renderAmPm(pop) {
  $('ampmPill').textContent = wheel.pm ? '오후' : '오전';
  $('ampmAbove').textContent = wheel.pm ? '오전' : '';
  $('ampmBelow').textContent = wheel.pm ? '' : '오후';
  if (pop) { const p = $('ampmPill'); p.classList.add('pop'); setTimeout(() => p.classList.remove('pop'), 140); }
}
(() => {
  // Tap flips; swipe up shows 오후 (below), swipe down shows 오전 (above).
  const box = $('ampm');
  let y0 = null;
  box.addEventListener('pointerdown', e => { y0 = e.clientY; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointerup', e => {
    if (y0 === null) return;
    const dy = e.clientY - y0; y0 = null;
    if (Math.abs(dy) < 12) wheel.pm = !wheel.pm;
    else if (dy < 0) wheel.pm = true;
    else wheel.pm = false;
    renderAmPm(true);
  });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { wheel.pm = !wheel.pm; renderAmPm(true); } });
})();

$('stopTimeBtn').addEventListener('click', () => {
  wheel.pm = s.stopHour >= 12;
  renderAmPm(false);
  $('timeSheet').hidden = false;
  requestAnimationFrame(() => { hourWheel.set(((s.stopHour % 12) || 12) - 1); minuteWheel.set(s.stopMinute); });
});
$('timeCancel').addEventListener('click', () => ($('timeSheet').hidden = true));
$('timeOk').addEventListener('click', () => {
  const h12 = hourWheel.get() + 1;
  s.stopHour = (h12 % 12) + (wheel.pm ? 12 : 0);
  s.stopMinute = minuteWheel.get();
  saveSettings(); render();
  $('timeSheet').hidden = true;
  closePanels(); // one 확인 closes both the picker and the 꺼짐 예약 section
});

// ---------- install guide ----------

$('installRow').addEventListener('click', () => {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('installSteps').innerHTML = ios
    ? `<ol><li>사파리 아래쪽의 <b>공유 버튼</b>(네모에 위쪽 화살표)을 누르세요</li>
         <li><b>'홈 화면에 추가'</b>를 누르세요</li><li>오른쪽 위 <b>'추가'</b>를 누르면 끝!</li></ol>`
    : `<ol><li>크롬 오른쪽 위의 <b>⋮ 메뉴</b>를 누르세요</li>
         <li><b>'홈 화면에 추가'</b> 또는 <b>'앱 설치'</b>를 누르세요</li><li><b>'추가'</b>를 누르면 끝!</li></ol>`;
  $('installSheet').hidden = false;
});
$('installClose').addEventListener('click', () => ($('installSheet').hidden = true));
document.querySelectorAll('.sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh) sh.hidden = true; }));

// ---------- start up ----------

$('versionValue').textContent = VERSION;
if (location.hash.startsWith('#demo')) {
  // Preview only: sample songs and an open section, so screenshots show a filled screen.
  tracks = [
    { id: 'a', name: '아침을 여는 기도 찬양.mp3', kind: 'file' },
    { id: 'b', name: '평안의 기도 (피아노).mp3', kind: 'file' },
    { id: 'c', name: '묵상을 위한 첼로.mp3', kind: 'file' },
    { id: 'd', name: '새벽 예배 찬양 모음.mp3', kind: 'url', url: 'https://example.com/a.mp3' },
    { id: 'e', name: '은혜 (피아노 연주)', kind: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  ];
  const open = new URLSearchParams(location.hash.slice(6)).get('open');
  renderTracks();
  if (open) openPanel(open, true);
  if (location.hash.includes('time')) $('stopTimeBtn').click();
} else {
  renderTracks();
}

// Shared from another app (Android home-screen install: YouTube → 공유 → 기도음악).
(() => {
  const q = new URLSearchParams(location.search);
  const shared = q.get('url') || q.get('text');
  if (!shared) return;
  history.replaceState(null, '', location.pathname);
  const m = shared.match(/https?:\/\/\S+/);
  if (m) { openPanel('musicPanel', true); openLinkSheet(m[0], ''); }
})();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
