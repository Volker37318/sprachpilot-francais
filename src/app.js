// src/app.js – Vor-A1 Training (Pack-Modus: 4 Wörter) + Container + 3 Tests
// - PASS ab 80%
// - Nach 4 Fehlversuchen: Wort in Container (Review) und weiter
// - Nach je 4 Wörtern: 3 Tests (A: Wort+Bild, B: nur hören, C: Bild->sprechen)
// - Fix: "(leer)" wird NICHT als Fehlversuch gezählt
// - Fix: bei Ein-Wort-Targets wird bestes Token gewertet (z.B. "je je" => "je" => 100%)

const LESSON_ID = "W1D1";
const IMAGE_DIR = `/assets/images/${LESSON_ID}/`; // "/assets/images/W1D1/"

const PACK_SIZE = 4;
const PASS_THRESHOLD = 80;
const FAILS_TO_CONTAINER = 4;   // nach 4 Fehlversuchen ins Review
const TEST_NEED_EACH = 2;       // je Wort/Bild 2x korrekt für Test A/B/C
const TESTC_MAX_FAILS_BEFORE_HINT = 3;

const ASR_LANG = "fr-FR";       // Sprache für SpeechRecognition
const TTS_LANG_PREFIX = "fr";   // Voice-Auswahl

// ---------- Inhalt (später leicht austauschbar) ----------
// word = das gesprochene/zu trainierende Wort (französisch)
// de   = Anzeige/Übersetzung (optional)
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

// ---------- globale Lern-States ----------
const stats = Object.fromEntries(ITEMS.map(it => [it.id, {
  failsLearn: 0,
  inContainer: false,
  learned: false
}]));

let packIndex = 0;              // 0..2 bei 12 Wörtern
let mode = "learn";             // learn | testA | testB | testC | review | sentences | end
let currentItemIdxInPack = 0;

let container = [];             // IDs im aktuellen Pack
let testCounts = {};            // id -> correctCount (für Tests A/B/C)
let testTargetId = null;
let testC_failStreakById = {};  // id -> fails in a row (Test C)

// TTS
let ttsSupported = "speechSynthesis" in window;
let ttsVoice = null;
let ttsActive = false;

// ASR
let micRecording = false;
let autoStopTimer = null;
let advanceTimer = null;

// UI lock refresh callback
let _uiRefreshLocks = null;
function setUiRefreshLocks(fn) { _uiRefreshLocks = fn; }
function refreshLocks() { try { _uiRefreshLocks && _uiRefreshLocks(); } catch {} }

// ---------- Util ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clearTimers() {
  try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
  try { if (advanceTimer) clearTimeout(advanceTimer); } catch {}
  autoStopTimer = null;
  advanceTimer = null;
}
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

    ttsVoice =
      voices.find(v => (v.lang || "").toLowerCase().startsWith(TTS_LANG_PREFIX)) ||
      voices[0];

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
    if (ttsVoice) {
      u.voice = ttsVoice;
      u.lang = ttsVoice.lang;
    } else {
      u.lang = ASR_LANG;
    }
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

// ---------- ASR (Browser SpeechRecognition) ----------
let _sr = null;
let _srFinal = "";
let _srInterim = "";
let _srResolve = null;

function speechRecAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function startBrowserASR(lang = ASR_LANG) {
  if (!speechRecAvailable()) return false;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  _srFinal = "";
  _srInterim = "";

  _sr = new SR();
  _sr.lang = lang;
  _sr.interimResults = true;
  _sr.continuous = false;      // wichtiger Fix: weniger "je je" & stabiler für Single-Words
  _sr.maxAlternatives = 1;

  _sr.onresult = (e) => {
    let interimAll = "";
    let addFinal = "";

    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = (r && r[0] && r[0].transcript) ? r[0].transcript : "";
      if (r.isFinal) addFinal += " " + t;
      else interimAll += " " + t;
    }
    if (interimAll.trim()) _srInterim = interimAll.trim();
    if (addFinal.trim()) _srFinal = (_srFinal + " " + addFinal).trim();
  };

  _sr.onerror = (e) => console.warn("[ASR] error:", e?.error || e);

  _sr.onend = () => {
    try {
      if (_srResolve) {
        const out = (_srFinal || _srInterim || "").trim();
        _srResolve(out);
        _srResolve = null;
      }
    } finally {
      _sr = null;
      _srInterim = "";
    }
  };

  try {
    _sr.start();
    return true;
  } catch (e) {
    console.warn("[ASR] start failed:", e);
    _sr = null;
    return false;
  }
}

function stopBrowserASR() {
  return new Promise((resolve) => {
    const safeResolve = () => resolve((_srFinal || _srInterim || "").trim());

    if (!_sr) return safeResolve();
    _srResolve = resolve;

    // Sicherheitsnetz: wenn onend nicht kommt, trotzdem nach kurzer Zeit liefern
    const fallback = setTimeout(() => {
      if (_srResolve) {
        const out = (_srFinal || _srInterim || "").trim();
        _srResolve(out);
        _srResolve = null;
        try { _sr?.abort?.(); } catch {}
        _sr = null;
      }
    }, 900);

    const prevResolve = _srResolve;
    _srResolve = (txt) => {
      try { clearTimeout(fallback); } catch {}
      resolve((txt || "").trim());
    };

    try { _sr.stop(); } catch { safeResolve(); }
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
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
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

  // Lemma nur für erstes Token (verb/pronomen)
  out[0] = FR_LEMMA[out[0]] || out[0];

  // Doppelte direkt hintereinander entfernen: "je je" -> "je"
  const dedup = [];
  for (const t of out) {
    if (dedup.length && dedup[dedup.length - 1] === t) continue;
    dedup.push(t);
  }
  return dedup.join(" ").trim();
}

// Wenn Target ein einzelnes Wort ist, werten wir das beste Token aus "heard".
// Fix für "je je" und für ASR, das manchmal zwei Wörter liefert.
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

  if (!targetCan || !heardCan) {
    return { overall: 0, pass: false, usedHeard: heardCan, usedTarget: targetCan };
  }

  // Single word target: bestes Token aus heard
  const isSingle = !targetCan.includes(" ");
  const usedHeard = isSingle ? bestTokenForSingleWord(targetCan, heardCan) : heardCan;

  const cs = _charSimilarity(targetCan, usedHeard);
  const overall = Math.max(0, Math.min(100, Math.round(cs * 100)));

  return {
    overall,
    pass: overall >= PASS_THRESHOLD,
    usedHeard,
    usedTarget: targetCan
  };
}

// ---------- Audio cleanup ----------
function stopAllAudioStates() {
  clearTimers();

  if (_sr) {
    try { _sr.stop(); } catch {}
    _sr = null;
  }
  micRecording = false;

  try { window.speechSynthesis?.cancel?.(); } catch {}
  ttsActive = false;

  refreshLocks();
}

// ---------- Feedback helpers ----------
function setFeedback(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  if (kind === "ok") {
    el.style.color = "#16a34a";
    el.style.fontWeight = "900";
  } else if (kind === "bad") {
    el.style.color = "#dc2626";
    el.style.fontWeight = "900";
  } else {
    el.style.color = "";
    el.style.fontWeight = "";
  }
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

function render() {
  stopAllAudioStates();

  if (mode === "learn") return renderLearn();
  if (mode === "testA") return renderTestA();
  if (mode === "testB") return renderTestB();
  if (mode === "testC") return renderTestC();
  if (mode === "review") return renderReview();
  if (mode === "sentences") return renderSentences();
  return renderEnd();
}

// ---------- LEARN (Wort -> sprechen) ----------
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
    if (!speechRecAvailable()) {
      setFeedback("learn-feedback", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("learn-feedback", "Sprich jetzt…", null);

    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("learn-feedback", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    clearTimers();
    autoStopTimer = setTimeout(async () => {
      try {
        const heardRaw = (await stopBrowserASR()).trim();
        micRecording = false;
        refreshLocks();

        // IMPORTANT FIX: "(leer)" NICHT als Fehlversuch zählen
        if (!heardRaw) {
          setFeedback("learn-feedback", "Ich habe nichts verstanden (leer). Bitte näher ans Mikro und deutlich sprechen.", "bad");
          return;
        }

        const res = scoreSpeech(it.word, heardRaw);
        const used = res.usedHeard || heardRaw;

        if (res.pass) {
          stats[it.id].learned = true;
          setFeedback("learn-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ → gewertet: „${used}“ · Weiter!`, "ok");
          clearTimers();
          advanceTimer = setTimeout(() => advanceLearn(), 900);
          return;
        }

        // fail (gezählt)
        stats[it.id].failsLearn++;

        if (stats[it.id].failsLearn >= FAILS_TO_CONTAINER) {
          putIntoContainer(it.id);
          setFeedback("learn-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ → „${used}“ · In den Container (kommt später).`, "bad");
          clearTimers();
          advanceTimer = setTimeout(() => advanceLearn(), 900);
          return;
        }

        setFeedback(
          "learn-feedback",
          `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ → „${used}“ · Nochmal (${stats[it.id].failsLearn}/${FAILS_TO_CONTAINER})`,
          "bad"
        );
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("learn-feedback", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, 5200);
  };
}

function putIntoContainer(id) {
  if (!stats[id].inContainer) stats[id].inContainer = true;
  if (!container.includes(id)) container.push(id);
}

function advanceLearn() {
  const pack = getPackItems();
  if (currentItemIdxInPack < pack.length - 1) {
    currentItemIdxInPack++;
    return render();
  }
  // Nach 4 Wörtern -> Test A
  initTestCountsForPack();
  mode = "testA";
  testTargetId = null;
  render();
}

function initTestCountsForPack() {
  const pack = getPackItems();
  testCounts = {};
  for (const it of pack) testCounts[it.id] = 0;
  testC_failStreakById = {};
  for (const it of pack) testC_failStreakById[it.id] = 0;
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

function getPackItemById(id) {
  return getPackItems().find(x => x.id === id) || null;
}

// ---------- TEST A: Wort (sichtbar) + Bild anklicken ----------
function renderTestA() {
  const pack = getPackItems();
  if (allTestsDoneForPack()) {
    // weiter zu Test B
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

  // Wort einmal automatisch sprechen (hilft, ist aber nicht "nur hören")
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
        await sleep(550);
        renderTestA();
      } else {
        setFeedback("testA-feedback", "Falsch. Nicht gezählt – probier nochmal.", "bad");
      }
    };
  });
}

// ---------- TEST B: Nur hören + Bild anklicken (Wort NICHT sichtbar) ----------
function renderTestB() {
  const pack = getPackItems();
  if (allTestsDoneForPack()) {
    // weiter zu Test C
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

  // automatisch abspielen
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
        await sleep(550);
        renderTestB();
      } else {
        setFeedback("testB-feedback", "Falsch. Nicht gezählt – probier nochmal.", "bad");
      }
    };
  });
}

// ---------- TEST C: Bild -> sprechen (2x je Bild korrekt) ----------
function renderTestC() {
  const pack = getPackItems();
  if (allTestsDoneForPack()) {
    // Nach Test C -> Review (nur wenn Container gefüllt), sonst nächstes Pack
    if (container.length) {
      mode = "review";
      currentItemIdxInPack = 0; // wird in review als index über container verwendet
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
    // Hear buttons nur wenn unlocked und nicht blockiert
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
    await sleep(450);
    renderTestC();
  };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;
    if (!speechRecAvailable()) {
      setFeedback("testC-feedback", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("testC-feedback", "Sprich jetzt…", null);

    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("testC-feedback", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    clearTimers();
    autoStopTimer = setTimeout(async () => {
      try {
        const heardRaw = (await stopBrowserASR()).trim();
        micRecording = false;
        refreshLocks();

        if (!heardRaw) {
          setFeedback("testC-feedback", "Ich habe nichts verstanden (leer). Nicht gezählt – bitte nochmal deutlich.", "bad");
          return;
        }

        const res = scoreSpeech(target.word, heardRaw);
        const used = res.usedHeard || heardRaw;

        if (res.pass) {
          testCounts[target.id] = (testCounts[target.id] || 0) + 1;
          testC_failStreakById[target.id] = 0;

          setFeedback("testC-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ → „${used}“ · Gezählt! (${testCounts[target.id]}/${TEST_NEED_EACH})`, "ok");

          testTargetId = null;
          clearTimers();
          advanceTimer = setTimeout(() => renderTestC(), 800);
          return;
        }

        // Fail (gezählt)
        testC_failStreakById[target.id] = (testC_failStreakById[target.id] || 0) + 1;

        const n = testC_failStreakById[target.id];
        if (n >= TESTC_MAX_FAILS_BEFORE_HINT) {
          // Hilfe: Wort wird gesprochen
          setFeedback("testC-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ → „${used}“ · Hilfe: Hör nochmal zu.`, "bad");
          speakWord(target.word, 1.0);
          // danach bleiben wir bei gleichem Target
          renderTestC();
          return;
        }

        setFeedback("testC-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ → „${used}“ · Nochmal (${n}/${TESTC_MAX_FAILS_BEFORE_HINT})`, "bad");
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("testC-feedback", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, 5600);
  };
}

// ---------- REVIEW: Container-Wörter nach dem Pack nochmal kurz ----------
function renderReview() {
  const pack = getPackItems();
  const reviewIds = container.filter(id => pack.some(it => it.id === id));

  if (!reviewIds.length) {
    return nextPackOrSentences();
  }

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

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnNext = document.getElementById("btn-next");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnHear.disabled = lock;
    btnHearSlow.disabled = lock;
    btnSpeak.disabled = lock;
    btnNext.disabled = lock;
  };
  setUiRefreshLocks(refresh);
  refresh();

  btnHear.onclick = () => speakWord(it.word, 1.0);
  btnHearSlow.onclick = () => speakWord(it.word, 0.7);

  btnNext.onclick = () => {
    if (idx < reviewIds.length - 1) currentItemIdxInPack++;
    else {
      // Review fertig -> nächstes Pack oder Sätze
      return nextPackOrSentences();
    }
    renderReview();
  };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;
    if (!speechRecAvailable()) {
      setFeedback("rev-feedback", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("rev-feedback", "Sprich jetzt…", null);

    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("rev-feedback", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    clearTimers();
    autoStopTimer = setTimeout(async () => {
      const heardRaw = (await stopBrowserASR()).trim();
      micRecording = false;
      refreshLocks();

      if (!heardRaw) {
        setFeedback("rev-feedback", "Ich habe nichts verstanden (leer). Nicht gezählt.", "bad");
        return;
      }

      const res = scoreSpeech(it.word, heardRaw);
      const used = res.usedHeard || heardRaw;

      if (res.pass) {
        setFeedback("rev-feedback", `Aussprache: ${res.overall}% · „${heardRaw}“ → „${used}“ · Gut!`, "ok");
      } else {
        setFeedback("rev-feedback", `Aussprache: ${res.overall}% · „${heardRaw}“ → „${used}“ · Nochmal.`, "bad");
      }
    }, 5200);
  };
}

// ---------- SENTENCES (einfach, als Start – später feinjustierbar) ----------
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

  if (i >= sentences.length) {
    mode = "end";
    return render();
  }

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

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnHear.disabled = lock;
    btnHearSlow.disabled = lock;
    btnSpeak.disabled = lock;
  };
  setUiRefreshLocks(refresh);
  refresh();

  btnHear.onclick = () => speakWord(s.text, 1.0);
  btnHearSlow.onclick = () => speakWord(s.text, 0.75);

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;
    if (!speechRecAvailable()) {
      setFeedback("sent-feedback", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("sent-feedback", "Sprich jetzt…", null);

    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("sent-feedback", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    clearTimers();
    autoStopTimer = setTimeout(async () => {
      const heardRaw = (await stopBrowserASR()).trim();
      micRecording = false;
      refreshLocks();

      if (!heardRaw) {
        setFeedback("sent-feedback", "Ich habe nichts verstanden (leer). Nicht gezählt.", "bad");
        return;
      }

      const res = scoreSpeech(s.text, heardRaw);
      if (res.pass) {
        setFeedback("sent-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ · Weiter!`, "ok");
        window.__sent_idx++;
        clearTimers();
        advanceTimer = setTimeout(() => renderSentences(), 950);
      } else {
        setFeedback("sent-feedback", `Aussprache: ${res.overall}% · Erkannt: „${heardRaw}“ · Nochmal.`, "bad");
      }
    }, 6500);
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

