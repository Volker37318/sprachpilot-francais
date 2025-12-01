// src/app.js – Vor-A1 Training (Pack 4) + Container + 3 Tests + Satzphase
// Stabiler ASR: SpeechRecognition (wenn vorhanden) + gleichzeitige Audioaufnahme.
// Wenn SpeechRecognition leer liefert -> Whisper-Fallback mit derselben Aufnahme.

const LESSON_ID = "W1D1";
const IMAGE_DIR = `/assets/images/${LESSON_ID}/`;

const PACK_SIZE = 4;
const PASS_THRESHOLD = 80;
const FAILS_TO_CONTAINER = 4;
const TEST_NEED_EACH = 2;
const TESTC_MAX_FAILS_BEFORE_HINT = 3;

// Training ist Französisch (TTS + ASR)
const ASR_LANG = "fr-FR";
const TTS_LANG_PREFIX = "fr";

// Whisper Endpoint (Fallback)
const WHISPER_URL =
  (window.WHISPER_URL) ||
  localStorage.getItem("sp_whisper_url") ||
  "https://whisper-proxy-w.onrender.com/whisper";

// ---------- Inhalte (12 Bilder) ----------
const ITEMS = [
  { id: "w01_ich",       word: "je",       de: "ich",        img: "w01_ich.png" },
  { id: "w02_du",        word: "tu",       de: "du",         img: "w02_du.png" },
  { id: "w03_wir",       word: "nous",     de: "wir",        img: "w03_wir.png" },
  { id: "w04_sie",       word: "vous",     de: "Sie / ihr",  img: "w04_sie.png" },

  { id: "w05_buch",      word: "livre",    de: "Buch",       img: "w05_buch.png" },
  { id: "w06_tuer",      word: "porte",    de: "Tür",        img: "w06_tuer.png" },
  { id: "w07_oeffnen",   word: "ouvrir",   de: "öffnen",     img: "w07_oeffnen.png" },
  { id: "w08_schliessen",word: "fermer",   de: "schließen",  img: "w08_schliessen.png" },

  { id: "w09_hoeren",    word: "écouter",  de: "hören",      img: "w09_hoeren.png" },
  { id: "w10_sprechen",  word: "parler",   de: "sprechen",   img: "w10_sprechen.png" },
  { id: "w11_lesen",     word: "lire",     de: "lesen",      img: "w11_lesen.png" },
  { id: "w12_schreiben", word: "écrire",   de: "schreiben",  img: "w12_schreiben.png" }
];

const appEl = document.getElementById("app");
const statusLine = document.getElementById("statusLine");
const status = (msg) => {
  if (statusLine) statusLine.textContent = msg || "";
  console.log("[STATUS]", msg);
};

const stats = Object.fromEntries(ITEMS.map(it => [it.id, { failsLearn: 0, inContainer: false, learned: false }]));

let packIndex = 0;
let mode = "learn"; // learn | testA | testB | testC | review | sentences | end
let currentItemIdxInPack = 0;

let container = [];
let testCounts = {};
let testTargetId = null;
let testC_failStreakById = {};

let ttsSupported = "speechSynthesis" in window;
let ttsVoice = null;
let ttsActive = false;

let micRecording = false;

let _uiRefreshLocks = null;
function setUiRefreshLocks(fn) { _uiRefreshLocks = fn; }
function refreshLocks() { try { _uiRefreshLocks && _uiRefreshLocks(); } catch {} }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function imgSrc(it) { return IMAGE_DIR + it.img; }

function getPackItems() {
  const start = packIndex * PACK_SIZE;
  return ITEMS.slice(start, start + PACK_SIZE);
}
function packLabel() {
  return `Pack ${packIndex + 1} von ${Math.ceil(ITEMS.length / PACK_SIZE)}`;
}
function packProgressLabel() {
  const packItems = getPackItems();
  const learnedCount = packItems.filter(it => stats[it.id]?.learned).length;
  return `Gelernt: ${learnedCount}/${packItems.length}`;
}
function getPackItemById(id) {
  return getPackItems().find(x => x.id === id) || null;
}

// ---------- TTS ----------
initTTS();

function initTTS() {
  if (!ttsSupported) {
    status("Sprachausgabe wird von diesem Browser nicht unterstützt.");
    return;
  }
  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return;
    ttsVoice = voices.find(v => (v.lang || "").toLowerCase().startsWith(TTS_LANG_PREFIX)) || voices[0];
    status(ttsVoice ? `Sprachausgabe bereit: ${ttsVoice.name} (${ttsVoice.lang})` : "Sprachausgabe bereit.");
  };
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

function speakWord(text, rate = 1.0) {
  if (!ttsSupported || !text) return;
  if (micRecording) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (ttsVoice) { u.voice = ttsVoice; u.lang = ttsVoice.lang; }
    else { u.lang = ASR_LANG; }
    u.rate = rate;

    u.onstart = () => { ttsActive = true; refreshLocks(); };
    u.onend = () => { ttsActive = false; refreshLocks(); };
    u.onerror = () => { ttsActive = false; refreshLocks(); };

    window.speechSynthesis.speak(u);
  } catch (e) {
    console.error("TTS error", e);
    ttsActive = false;
    refreshLocks();
  }
}

// ---------- ASR: Smart (SR + Whisper-Fallback aus gleicher Aufnahme) ----------
function speechRecAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function pickSupportedMime() {
  const cands = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg"
  ];
  for (const m of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function transcribeWhisper(blob, languageShort = "fr") {
  // 1) multipart/form-data Versuch
  try {
    const fd = new FormData();
    fd.append("file", blob, "speech.webm");
    fd.append("language", languageShort);

    const r = await fetch(WHISPER_URL, { method: "POST", body: fd });
    const txt = await r.text();
    let data = {};
    try { data = JSON.parse(txt); } catch { data = {}; }

    if (!r.ok) throw new Error(data?.error || txt || `HTTP ${r.status}`);
    const out = (data.text || data.transcript || data.result || "").trim();
    if (out) return out;
  } catch (e) {
    // weiter mit JSON fallback
  }

  // 2) JSON base64 Versuch (falls dein Proxy so gebaut ist)
  const b64 = await blobToBase64(blob);
  const r2 = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64: b64, language: languageShort })
  });
  const data2 = await r2.json().catch(() => ({}));
  if (!r2.ok) throw new Error(data2?.error || `HTTP ${r2.status}`);
  return String(data2.text || data2.transcript || data2.result || "").trim();
}

async function listenSmart({ lang = ASR_LANG, maxMs = 4500, whisper = true } = {}) {
  // Startet Recording + SR parallel. Wenn SR leer -> Whisper transkribiert dieselbe Aufnahme.
  const languageShort = (lang || "fr").slice(0, 2).toLowerCase();

  // Wenn MediaRecorder fehlt, versuchen wir wenigstens SR
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    if (!speechRecAvailable()) return { text: "", source: "none", error: "no_asr" };
    return await listenSRonly(lang, maxMs);
  }

  let stream = null;
  let recorder = null;
  let chunks = [];
  let srText = "";
  let srError = "";

  const mimeType = pickSupportedMime();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let sr = null;

  let resolveDone;
  const done = new Promise(r => (resolveDone = r));

  const stopTracks = (s) => {
    try { s?.getTracks?.().forEach(t => t.stop()); } catch {}
  };

  const finish = async () => {
    try {
      if (sr) { try { sr.onresult = sr.onerror = sr.onend = null; } catch {} }
      if (sr) { try { sr.stop(); } catch {} }
    } catch {}

    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {}

    // recorder.onstop löst resolveDone aus (mit Blob)
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      stopTracks(stream);

      // 1) Wenn SR Text hat -> fertig
      const cleaned = (srText || "").trim();
      if (cleaned) return resolveDone({ text: cleaned, source: "sr+rec", error: srError });

      // 2) SR leer, Whisper fallback
      if (whisper) {
        try {
          const w = await transcribeWhisper(blob, languageShort);
          return resolveDone({ text: (w || "").trim(), source: "whisper", error: srError });
        } catch (e) {
          return resolveDone({ text: "", source: "whisper_failed", error: String(e?.message || e) });
        }
      }

      return resolveDone({ text: "", source: "empty", error: srError || "empty" });
    };

    // Start Recording
    recorder.start(200);

    // Start SpeechRecognition (falls verfügbar)
    if (speechRecAvailable()) {
      srText = "";
      srError = "";
      sr = new SR();
      sr.lang = lang;
      sr.interimResults = true;
      sr.continuous = false;
      sr.maxAlternatives = 1;

      sr.onresult = (e) => {
        let interimAll = "";
        let addFinal = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const t = (r && r[0] && r[0].transcript) ? r[0].transcript : "";
          if (r.isFinal) addFinal += " " + t;
          else interimAll += " " + t;
        }
        if (interimAll.trim()) srText = interimAll.trim();
        if (addFinal.trim()) srText = (srText + " " + addFinal).trim();

        // Sobald ein Final da ist -> beenden
        if (addFinal.trim()) finish();
      };

      sr.onerror = (e) => { srError = e?.error || "asr_error"; };
      sr.onend = () => { /* wir beenden über timer oder final */ };

      try { sr.start(); } catch (e) { srError = "start_failed"; }
    }

    // Hard timeout
    setTimeout(() => { finish(); }, maxMs);

    return await done;
  } catch (e) {
    stopTracks(stream);
    return { text: "", source: "getUserMedia_failed", error: String(e?.message || e) };
  }
}

async function listenSRonly(lang, maxMs) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let sr = null;
  let text = "";
  let err = "";

  return await new Promise((resolve) => {
    const end = () => resolve({ text: (text || "").trim(), source: "sr_only", error: err });

    try {
      sr = new SR();
      sr.lang = lang;
      sr.interimResults = true;
      sr.continuous = false;
      sr.maxAlternatives = 1;

      sr.onresult = (e) => {
        let interimAll = "";
        let addFinal = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const t = (r && r[0] && r[0].transcript) ? r[0].transcript : "";
          if (r.isFinal) addFinal += " " + t;
          else interimAll += " " + t;
        }
        text = (addFinal || interimAll || "").trim();
        if (addFinal.trim()) { try { sr.stop(); } catch {} }
      };

      sr.onerror = (e) => { err = e?.error || "asr_error"; };
      sr.onend = () => end();

      sr.start();
      setTimeout(() => { try { sr.stop(); } catch {} }, maxMs);
    } catch (e) {
      resolve({ text: "", source: "sr_only_failed", error: "start_failed" });
    }
  });
}

// ---------- Scoring (robust gegen "je je") ----------
const ARTICLES = new Set(["le","la","les","un","une","des","du","de","d","l"]);
const FR_LEMMA = {
  ecoute: "écouter", ecouter: "écouter", écouter: "écouter",
  repete: "répéter", repeter: "répéter", répéter: "répéter",
  lis: "lire", lire: "lire",
  ecris: "écrire", ecrire: "écrire", écrire: "écrire",
  ouvre: "ouvrir", ouvrir: "ouvrir",
  ferme: "fermer", fermer: "fermer",
  parle: "parler", parler: "parler",
  j: "je", je: "je"
};

function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function _tokensNoArticles(s) {
  return _norm(s).split(" ").filter(Boolean).filter(t => !ARTICLES.has(t));
}
function _levenshtein(a, b) {
  a = _norm(a); b = _norm(b);
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
function _charSimilarity(target, heard) {
  const A = _norm(target), B = _norm(heard);
  if (!A || !B) return 0;
  const dist = _levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length) || 1;
  return Math.max(0, Math.min(1, 1 - dist / maxLen));
}
function canonicalFrench(s) {
  const toks = _tokensNoArticles(s);
  if (!toks.length) return "";
  const out = [...toks];
  out[0] = FR_LEMMA[out[0]] || out[0];
  const dedup = [];
  for (const t of out) {
    if (dedup.length && dedup[dedup.length - 1] === t) continue;
    dedup.push(t);
  }
  return dedup.join(" ").trim();
}
function bestTokenForSingleWord(target, heard) {
  const t = canonicalFrench(target);
  const tokens = canonicalFrench(heard).split(" ").filter(Boolean);
  if (!t || !tokens.length) return "";
  let best = { tok: tokens[0], sim: -1 };
  for (const tok of tokens) {
    const sim = _charSimilarity(t, tok);
    if (sim > best.sim) best = { tok, sim };
  }
  return best.tok;
}
function scoreSpeech(target, heardRaw) {
  const targetCan = canonicalFrench(target);
  const heardCan = canonicalFrench(heardRaw);
  if (!targetCan || !heardCan) return { overall: 0, pass: false, usedHeard: heardCan, usedTarget: targetCan };

  const isSingle = !targetCan.includes(" ");
  const usedHeard = isSingle ? bestTokenForSingleWord(targetCan, heardCan) : heardCan;

  const cs = _charSimilarity(targetCan, usedHeard);
  const overall = Math.max(0, Math.min(100, Math.round(cs * 100)));

  return { overall, pass: overall >= PASS_THRESHOLD, usedHeard, usedTarget: targetCan };
}

// ---------- Feedback ----------
function setFeedback(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  if (kind === "ok") { el.style.color = "#16a34a"; el.style.fontWeight = "900"; }
  else if (kind === "bad") { el.style.color = "#dc2626"; el.style.fontWeight = "900"; }
  else { el.style.color = ""; el.style.fontWeight = ""; }
}

// ---------- Flow ----------
start();

function start() {
  packIndex = 0;
  mode = "learn";
  currentItemIdxInPack = 0;
  container = [];
  testCounts = {};
  testTargetId = null;
  testC_failStreakById = {};
  render();
}

function nextPackOrSentences() {
  if (packIndex < Math.ceil(ITEMS.length / PACK_SIZE) - 1) {
    packIndex++;
    mode = "learn";
    currentItemIdxInPack = 0;
    container = [];
    testCounts = {};
    testTargetId = null;
    testC_failStreakById = {};
    return render();
  }
  mode = "sentences";
  render();
}

function initTestCountsForPack() {
  const pack = getPackItems();
  testCounts = {};
  testC_failStreakById = {};
  for (const it of pack) {
    testCounts[it.id] = 0;
    testC_failStreakById[it.id] = 0;
  }
}

function pickNextTargetId() {
  const pack = getPackItems();
  const remaining = pack.filter(it => (testCounts[it.id] || 0) < TEST_NEED_EACH);
  if (!remaining.length) return null;
  return remaining[Math.floor(Math.random() * remaining.length)].id;
}

function allTestsDoneForPack() {
  const pack = getPackItems();
  return pack.every(it => (testCounts[it.id] || 0) >= TEST_NEED_EACH);
}

function putIntoContainer(id) {
  if (!stats[id].inContainer) stats[id].inContainer = true;
  if (!container.includes(id)) container.push(id);
}

function render() {
  try { window.speechSynthesis?.cancel?.(); } catch {}
  ttsActive = false;
  micRecording = false;
  refreshLocks();

  if (mode === "learn") return renderLearn();
  if (mode === "testA") return renderTestA();
  if (mode === "testB") return renderTestB();
  if (mode === "testC") return renderTestC();
  if (mode === "review") return renderReview();
  if (mode === "sentences") return renderSentences();
  return renderEnd();
}

// ---------- LEARN ----------
function renderLearn() {
  const pack = getPackItems();
  const it = pack[currentItemIdxInPack];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">${escapeHtml(packProgressLabel())}</div>
        <div class="badge">Wort ${currentItemIdxInPack + 1} von ${pack.length}</div>
      </div>

      <h1>Worttraining</h1>

      <div class="card card-word">
        <img src="${imgSrc(it)}" alt="" class="word-image">
        <div class="word-text">${escapeHtml(it.word)}</div>
        <div class="word-translation">${escapeHtml(it.de || "")}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-later" class="btn secondary">Später noch einmal</button>
        <div id="learn-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnLater = document.getElementById("btn-later");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnHear.disabled = lock;
    btnHearSlow.disabled = lock;
    btnSpeak.disabled = lock;
    btnLater.disabled = lock;
  };
  setUiRefreshLocks(refresh);
  refresh();

  btnHear.onclick = () => speakWord(it.word, 1.0);
  btnHearSlow.onclick = () => speakWord(it.word, 0.7);

  btnLater.onclick = async () => {
    putIntoContainer(it.id);
    setFeedback("learn-feedback", "Okay – kommt später nochmal.", "bad");
    await sleep(450);
    advanceLearn();
  };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;

    setFeedback("learn-feedback", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    micRecording = true;
    refreshLocks();

    const r = await listenSmart({ lang: ASR_LANG, maxMs: 4200, whisper: true });

    micRecording = false;
    refreshLocks();

    const heardRaw = (r.text || "").trim();
    if (!heardRaw) {
      setFeedback("learn-feedback", `Ich habe nichts verstanden (leer). Quelle=${r.source} Fehler=${r.error || "-"} · Bitte nochmal.`, "bad");
      return;
    }

    const res = scoreSpeech(it.word, heardRaw);
    const used = res.usedHeard || heardRaw;
    const srcInfo = r.source === "whisper" ? "Whisper" : "Browser";

    if (res.pass) {
      stats[it.id].learned = true;
      setFeedback("learn-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) Erkannt: „${heardRaw}“ → gewertet: „${used}“ · Weiter!`, "ok");
      await sleep(650);
      advanceLearn();
      return;
    }

    stats[it.id].failsLearn++;

    if (stats[it.id].failsLearn >= FAILS_TO_CONTAINER) {
      putIntoContainer(it.id);
      setFeedback("learn-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ → „${used}“ · In den Container.`, "bad");
      await sleep(800);
      advanceLearn();
      return;
    }

    setFeedback("learn-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ → „${used}“ · Nochmal (${stats[it.id].failsLearn}/${FAILS_TO_CONTAINER})`, "bad");
  };
}

function advanceLearn() {
  const pack = getPackItems();
  if (currentItemIdxInPack < pack.length - 1) {
    currentItemIdxInPack++;
    return render();
  }
  initTestCountsForPack();
  mode = "testA";
  testTargetId = null;
  render();
}

// ---------- TEST A ----------
function renderTestA() {
  const pack = getPackItems();
  if (allTestsDoneForPack()) {
    initTestCountsForPack();
    mode = "testB";
    testTargetId = null;
    return render();
  }

  if (!testTargetId) testTargetId = pickNextTargetId();
  const target = getPackItemById(testTargetId);
  const grid = shuffleArray(pack);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Test A</div>
      </div>

      <h1>Test A: Wort & Bild</h1>
      <p>Tippe das richtige Bild zum Wort.</p>

      <div class="card card-word" style="text-align:center;">
        <div class="word-text" style="font-size:34px;">${escapeHtml(target.word)}</div>
        <div class="word-translation">${escapeHtml(target.de || "")}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="icon-grid">
        ${grid.map(it => `
          <button class="icon-card" data-id="${it.id}" aria-label="Option">
            <img src="${imgSrc(it)}" alt="">
          </button>
        `).join("")}
      </div>

      <div id="testA-feedback" class="feedback"></div>
      <div class="meta" style="margin-top:8px;">
        ${pack.map(it => `<div class="badge">${escapeHtml(it.word)}: ${(testCounts[it.id]||0)}/${TEST_NEED_EACH}</div>`).join("")}
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnHear.disabled = lock;
    btnHearSlow.disabled = lock;
    appEl.querySelectorAll(".icon-card").forEach(b => b.disabled = lock);
  };
  setUiRefreshLocks(refresh);
  refresh();

  speakWord(target.word, 1.0);

  btnHear.onclick = () => speakWord(target.word, 1.0);
  btnHearSlow.onclick = () => speakWord(target.word, 0.7);

  appEl.querySelectorAll(".icon-card").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      if (id === target.id) {
        testCounts[id] = (testCounts[id] || 0) + 1;
        setFeedback("testA-feedback", `Richtig! (${testCounts[id]}/${TEST_NEED_EACH})`, "ok");
        testTargetId = null;
        await sleep(450);
        renderTestA();
      } else {
        setFeedback("testA-feedback", "Falsch. Nicht gezählt – probier nochmal.", "bad");
      }
    };
  });
}

// ---------- TEST B ----------
function renderTestB() {
  const pack = getPackItems();
  if (allTestsDoneForPack()) {
    initTestCountsForPack();
    mode = "testC";
    testTargetId = null;
    return render();
  }

  if (!testTargetId) testTargetId = pickNextTargetId();
  const target = getPackItemById(testTargetId);
  const grid = shuffleArray(pack);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Test B</div>
      </div>

      <h1>Test B: Nur hören</h1>
      <p>Höre das Wort und tippe das richtige Bild.</p>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="icon-grid">
        ${grid.map(it => `
          <button class="icon-card" data-id="${it.id}" aria-label="Option">
            <img src="${imgSrc(it)}" alt="">
          </button>
        `).join("")}
      </div>

      <div id="testB-feedback" class="feedback"></div>
      <div class="meta" style="margin-top:8px;">
        ${pack.map(it => `<div class="badge">${escapeHtml(it.word)}: ${(testCounts[it.id]||0)}/${TEST_NEED_EACH}</div>`).join("")}
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnHear.disabled = lock;
    btnHearSlow.disabled = lock;
    appEl.querySelectorAll(".icon-card").forEach(b => b.disabled = lock);
  };
  setUiRefreshLocks(refresh);
  refresh();

  speakWord(target.word, 1.0);

  btnHear.onclick = () => speakWord(target.word, 1.0);
  btnHearSlow.onclick = () => speakWord(target.word, 0.7);

  appEl.querySelectorAll(".icon-card").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      if (id === target.id) {
        testCounts[id] = (testCounts[id] || 0) + 1;
        setFeedback("testB-feedback", `Richtig! (${testCounts[id]}/${TEST_NEED_EACH})`, "ok");
        testTargetId = null;
        await sleep(450);
        renderTestB();
      } else {
        setFeedback("testB-feedback", "Falsch. Nicht gezählt – probier nochmal.", "bad");
      }
    };
  });
}

// ---------- TEST C ----------
function renderTestC() {
  const pack = getPackItems();
  if (allTestsDoneForPack()) {
    if (container.length) {
      mode = "review";
      currentItemIdxInPack = 0;
      return render();
    }
    return nextPackOrSentences();
  }

  if (!testTargetId) testTargetId = pickNextTargetId();
  const target = getPackItemById(testTargetId);

  const hintUnlocked = (testC_failStreakById[target.id] || 0) >= TESTC_MAX_FAILS_BEFORE_HINT;

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Test C</div>
        <div class="badge">${escapeHtml(target.word)}: ${(testCounts[target.id]||0)}/${TEST_NEED_EACH}</div>
      </div>

      <h1>Test C: Bild → Wort sprechen</h1>
      <p>Sprich das Wort passend zum Bild.</p>

      <div class="card card-word">
        <img src="${imgSrc(target)}" alt="" class="word-image">
        <div class="word-translation">${escapeHtml(target.de || "")}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn secondary" ${hintUnlocked ? "" : "disabled"}>Hören</button>
        <button id="btn-hear-slow" class="btn secondary" ${hintUnlocked ? "" : "disabled"}>Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-later" class="btn secondary">Später noch einmal</button>
        <div id="testC-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>

      <div class="meta" style="margin-top:8px;">
        ${pack.map(it => `<div class="badge">${escapeHtml(it.word)}: ${(testCounts[it.id]||0)}/${TEST_NEED_EACH}</div>`).join("")}
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnLater = document.getElementById("btn-later");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnSpeak.disabled = lock;
    btnLater.disabled = lock;
    btnHear.disabled = lock || !hintUnlocked;
    btnHearSlow.disabled = lock || !hintUnlocked;
  };
  setUiRefreshLocks(refresh);
  refresh();

  btnHear.onclick = () => speakWord(target.word, 1.0);
  btnHearSlow.onclick = () => speakWord(target.word, 0.7);

  btnLater.onclick = async () => {
    setFeedback("testC-feedback", "Okay – später nochmal (nicht gezählt).", "bad");
    testTargetId = null;
    await sleep(350);
    renderTestC();
  };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;

    setFeedback("testC-feedback", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    micRecording = true;
    refreshLocks();

    const r = await listenSmart({ lang: ASR_LANG, maxMs: 5200, whisper: true });

    micRecording = false;
    refreshLocks();

    const heardRaw = (r.text || "").trim();
    if (!heardRaw) {
      setFeedback("testC-feedback", `Ich habe nichts verstanden (leer). Quelle=${r.source} Fehler=${r.error || "-"} · Bitte nochmal.`, "bad");
      return;
    }

    const res = scoreSpeech(target.word, heardRaw);
    const used = res.usedHeard || heardRaw;
    const srcInfo = r.source === "whisper" ? "Whisper" : "Browser";

    if (res.pass) {
      testCounts[target.id] = (testCounts[target.id] || 0) + 1;
      testC_failStreakById[target.id] = 0;
      setFeedback("testC-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ → „${used}“ · Gezählt! (${testCounts[target.id]}/${TEST_NEED_EACH})`, "ok");
      testTargetId = null;
      await sleep(650);
      renderTestC();
      return;
    }

    testC_failStreakById[target.id] = (testC_failStreakById[target.id] || 0) + 1;
    const n = testC_failStreakById[target.id];

    if (n >= TESTC_MAX_FAILS_BEFORE_HINT) {
      setFeedback("testC-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ → „${used}“ · Hilfe: Hör nochmal zu.`, "bad");
      speakWord(target.word, 1.0);
      return;
    }

    setFeedback("testC-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ → „${used}“ · Nochmal (${n}/${TESTC_MAX_FAILS_BEFORE_HINT})`, "bad");
  };
}

// ---------- REVIEW ----------
function renderReview() {
  const pack = getPackItems();
  const reviewIds = container.filter(id => pack.some(it => it.id === id));
  if (!reviewIds.length) return nextPackOrSentences();

  const idx = Math.min(currentItemIdxInPack, reviewIds.length - 1);
  const id = reviewIds[idx];
  const it = getPackItemById(id);

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Review-Container</div>
        <div class="badge">${idx + 1} von ${reviewIds.length}</div>
      </div>

      <h1>Nochmal üben</h1>

      <div class="card card-word">
        <img src="${imgSrc(it)}" alt="" class="word-image">
        <div class="word-text">${escapeHtml(it.word)}</div>
        <div class="word-translation">${escapeHtml(it.de || "")}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-next" class="btn secondary">Weiter</button>
        <div id="rev-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  document.getElementById("btn-hear").onclick = () => speakWord(it.word, 1.0);
  document.getElementById("btn-hear-slow").onclick = () => speakWord(it.word, 0.7);

  document.getElementById("btn-next").onclick = () => {
    if (idx < reviewIds.length - 1) currentItemIdxInPack++;
    else return nextPackOrSentences();
    renderReview();
  };

  document.getElementById("btn-speak").onclick = async () => {
    if (micRecording || ttsActive) return;

    setFeedback("rev-feedback", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    micRecording = true;
    refreshLocks();

    const r = await listenSmart({ lang: ASR_LANG, maxMs: 4200, whisper: true });

    micRecording = false;
    refreshLocks();

    const heardRaw = (r.text || "").trim();
    if (!heardRaw) {
      setFeedback("rev-feedback", `Ich habe nichts verstanden (leer). Quelle=${r.source} Fehler=${r.error || "-"} · Nicht gezählt.`, "bad");
      return;
    }

    const res = scoreSpeech(it.word, heardRaw);
    const srcInfo = r.source === "whisper" ? "Whisper" : "Browser";

    if (res.pass) setFeedback("rev-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ · Gut!`, "ok");
    else setFeedback("rev-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ · Nochmal.`, "bad");
  };
}

// ---------- SENTENCES ----------
function renderSentences() {
  const sentences = [
    { text: "J'ouvre la porte.", imgId: "w06_tuer" },
    { text: "Je ferme la porte.", imgId: "w06_tuer" },
    { text: "J'écoute.", imgId: "w09_hoeren" },
    { text: "Je parle.", imgId: "w10_sprechen" },
    { text: "Je lis le livre.", imgId: "w05_buch" },
    { text: "J'écris.", imgId: "w12_schreiben" }
  ];

  if (!window.__sent_idx) window.__sent_idx = 0;
  const i = window.__sent_idx;
  if (i >= sentences.length) { mode = "end"; return render(); }

  const s = sentences[i];
  const imgItem = ITEMS.find(x => x.id === s.imgId) || ITEMS[0];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Sätze</div>
        <div class="badge">Satz ${i + 1} von ${sentences.length}</div>
      </div>

      <h1>Satztraining</h1>

      <div class="card card-word">
        <img src="${imgSrc(imgItem)}" alt="" class="word-image">
        <div class="word-text" style="font-size:28px; line-height:1.25;">${escapeHtml(s.text)}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <div id="sent-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  document.getElementById("btn-hear").onclick = () => speakWord(s.text, 1.0);
  document.getElementById("btn-hear-slow").onclick = () => speakWord(s.text, 0.75);

  document.getElementById("btn-speak").onclick = async () => {
    if (micRecording || ttsActive) return;

    setFeedback("sent-feedback", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    micRecording = true;
    refreshLocks();

    const r = await listenSmart({ lang: ASR_LANG, maxMs: 7000, whisper: true });

    micRecording = false;
    refreshLocks();

    const heardRaw = (r.text || "").trim();
    if (!heardRaw) {
      setFeedback("sent-feedback", `Ich habe nichts verstanden (leer). Quelle=${r.source} Fehler=${r.error || "-"} · Nicht gezählt.`, "bad");
      return;
    }

    const res = scoreSpeech(s.text, heardRaw);
    const srcInfo = r.source === "whisper" ? "Whisper" : "Browser";

    if (res.pass) {
      setFeedback("sent-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ · Weiter!`, "ok");
      window.__sent_idx++;
      await sleep(800);
      renderSentences();
    } else {
      setFeedback("sent-feedback", `Aussprache: ${res.overall}% · (${srcInfo}) „${heardRaw}“ · Nochmal.`, "bad");
    }
  };
}

// ---------- END ----------
function renderEnd() {
  appEl.innerHTML = `
    <div class="screen screen-end">
      <h1>Fertig</h1>
      <p>Du hast alle Packs, Tests und Sätze abgeschlossen.</p>
      <button id="btn-restart" class="btn primary">Neu starten</button>
    </div>
  `;
  document.getElementById("btn-restart").onclick = () => {
    window.__sent_idx = 0;
    start();
  };
}




