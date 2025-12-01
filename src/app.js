// src/app.js – FIXED 12 Bilder (w01..w12) + 80% + Container + 3 Tests + Satzphase
// Fixes gegen Frust:
// 1) Scoring ist tolerant gegen Wiederholungen/Extra-Wörter (z.B. "je je je" => 100% für Ziel "je")
// 2) Test C: Nach 3 Fehlversuchen erscheint Button "Weiter & später nochmal" (deferred Queue)
// 3) Aufnahme-Flow bleibt stabil: SpeechRecognition + Auto-Stop (kein Freeze bei "Sprich jetzt...")

const LESSON_ID = "W1D1";

// Training: Französisch
const ASR_LANG = "fr-FR";
const TTS_LANG_PREFIX = "fr";

// Regeln
const PACK_SIZE = 4;
const PASS_THRESHOLD = 80;
const FAILS_TO_CONTAINER = 4;
const TEST_NEED_EACH = 2;      // pro Bild 2x korrekt
const TESTC_DEFER_AFTER = 3;   // nach 3 Fehlversuchen: Button "Weiter & später nochmal"
const AUTO_STOP_MS = 3800;

const IMAGE_DIR_REL = `/assets/images/${LESSON_ID}/`;
const IMAGE_DIR_ABS = `${location.origin}${IMAGE_DIR_REL}`;

const appEl = document.getElementById("app");
const statusLine = document.getElementById("statusLine");
const status = (msg) => {
  if (statusLine) statusLine.textContent = msg || "";
  console.log("[STATUS]", msg);
};

// ----------------- FESTE 12 ITEMS (Bilder bleiben w01..w12) -----------------
const FIXED_ITEMS = [
  { id: "w01_ich",       word: "je",        img: IMAGE_DIR_ABS + "w01_ich.png",       fallbackImg: IMAGE_DIR_REL + "w01_ich.png" },
  { id: "w02_sie",       word: "vous",      img: IMAGE_DIR_ABS + "w02_sie.png",       fallbackImg: IMAGE_DIR_REL + "w02_sie.png" },
  { id: "w03_buch",      word: "le livre",  img: IMAGE_DIR_ABS + "w03_buch.png",      fallbackImg: IMAGE_DIR_REL + "w03_buch.png" },
  { id: "w04_heft",      word: "le cahier", img: IMAGE_DIR_ABS + "w04_heft.png",      fallbackImg: IMAGE_DIR_REL + "w04_heft.png" },
  { id: "w05_stift",     word: "le stylo",  img: IMAGE_DIR_ABS + "w05_stift.png",     fallbackImg: IMAGE_DIR_REL + "w05_stift.png" },
  { id: "w06_tisch",     word: "la table",  img: IMAGE_DIR_ABS + "w06_tisch.png",     fallbackImg: IMAGE_DIR_REL + "w06_tisch.png" },
  { id: "w07_stuhl",     word: "la chaise", img: IMAGE_DIR_ABS + "w07_stuhl.png",     fallbackImg: IMAGE_DIR_REL + "w07_stuhl.png" },
  { id: "w08_tuer",      word: "la porte",  img: IMAGE_DIR_ABS + "w08_tuer.png",      fallbackImg: IMAGE_DIR_REL + "w08_tuer.png" },
  { id: "w09_hoeren",    word: "écouter",   img: IMAGE_DIR_ABS + "w09_hoeren.png",    fallbackImg: IMAGE_DIR_REL + "w09_hoeren.png" },
  { id: "w10_sprechen",  word: "parler",    img: IMAGE_DIR_ABS + "w10_sprechen.png",  fallbackImg: IMAGE_DIR_REL + "w10_sprechen.png" },
  { id: "w11_oeffnen",   word: "ouvrir",    img: IMAGE_DIR_ABS + "w11_oeffnen.png",   fallbackImg: IMAGE_DIR_REL + "w11_oeffnen.png" },
  { id: "w12_schreiben", word: "écrire",    img: IMAGE_DIR_ABS + "w12_schreiben.png", fallbackImg: IMAGE_DIR_REL + "w12_schreiben.png" }
];

const ID2ITEM = Object.fromEntries(FIXED_ITEMS.map(x => [x.id, x]));

// ---------- State ----------
let mode = "learn"; // learn | review | testA | testB | testC | sentences | end
let packIndex = 0;  // 0..2
let cursor = 0;     // Position in current learning list
let currentList = [];      // Lernliste (zuerst pack items in order)
let container = [];        // ids, die später nochmal kommen
let failCount = {};        // pro id (learn/review)
let testCounts = {};       // pro id: 0..2
let testTargetId = null;   // aktuelles Ziel
let testC_failStreak = {}; // pro id: Fehlserie
let testC_deferred = new Set(); // pro id: "später nochmal" innerhalb Test C

// Locks
let ttsSupported = "speechSynthesis" in window;
let ttsVoice = null;
let ttsActive = false;
let micRecording = false;
let autoStopTimer = null;

let _uiRefreshLocks = null;
function setUiRefreshLocks(fn) { _uiRefreshLocks = fn; }
function refreshLocks() { try { _uiRefreshLocks && _uiRefreshLocks(); } catch {} }

// ---------- Helpers ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function attachImgFallbacks() {
  appEl.querySelectorAll("img[data-fallback]").forEach((img) => {
    const fb = img.getAttribute("data-fallback") || "";
    img.onerror = () => { img.onerror = null; if (fb) img.src = fb; };
  });
}
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function getPacksCount() { return Math.ceil(FIXED_ITEMS.length / PACK_SIZE); }
function getPackItems(pi = packIndex) {
  const s = pi * PACK_SIZE;
  return FIXED_ITEMS.slice(s, s + PACK_SIZE);
}
function packLabel() { return `Pack ${packIndex + 1} von ${getPacksCount()}`; }

function resetPackState() {
  const pack = getPackItems();
  currentList = [...pack];
  cursor = 0;
  container = [];
  failCount = {};
  testCounts = {};
  testC_failStreak = {};
  testC_deferred = new Set();
  testTargetId = null;

  for (const it of pack) {
    failCount[it.id] = 0;
    testCounts[it.id] = 0;
    testC_failStreak[it.id] = 0;
  }
}

// ---------- Feedback helper ----------
function setFeedback(elId, text, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text || "";
  if (kind === "ok") { el.style.color = "#16a34a"; el.style.fontWeight = "900"; }
  else if (kind === "bad") { el.style.color = "#dc2626"; el.style.fontWeight = "900"; }
  else { el.style.color = ""; el.style.fontWeight = ""; }
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

// ---------- CLEANUP ----------
function stopAllAudioStates() {
  try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
  autoStopTimer = null;

  try { window.speechSynthesis?.cancel?.(); } catch {}
  ttsActive = false;

  // SpeechRecognition stop handled separately
  micRecording = false;
  refreshLocks();
}

// ---------- Browser SpeechRecognition (stabil) ----------
let _sr = null;
let _srFinal = "";
let _srInterim = "";
let _srResolve = null;

function speechRecAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function startBrowserASR(lang = "fr-FR") {
  if (!speechRecAvailable()) return false;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  _srFinal = "";
  _srInterim = "";

  _sr = new SR();
  _sr.lang = lang;
  _sr.interimResults = true;
  _sr.continuous = true;
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
    if (!_sr) return resolve((_srFinal || _srInterim || "").trim());
    _srResolve = resolve;
    try { _sr.stop(); } catch { resolve((_srFinal || _srInterim || "").trim()); }
  });
}

// ---------- SCORING (Anti-Frust: tolerant gegen Wiederholungen/Extra) ----------
const ARTICLES = new Set(["le","la","les","un","une","des","du","de","d","l"]);

const FR_LEMMA = {
  // Pronomen
  je: "je", j: "je", vous: "vous",

  // Nomen
  livre: "livre", cahier: "cahier", stylo: "stylo", table: "table", chaise: "chaise", porte: "porte",

  // Verben & Formen
  ecouter: "ecouter", ecoute: "ecouter", ecoutes: "ecouter", ecoutez: "ecouter",
  parler: "parler", parle: "parler", parles: "parler", parlez: "parler",
  ouvrir: "ouvrir", ouvre: "ouvrir", ouvres: "ouvrir", ouvrez: "ouvrir",
  ecrire: "ecrire", ecris: "ecrire", ecrit: "ecrire", ecrivez: "ecrire"
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

function canonicalFrenchForScoring(s) {
  const toks = _norm(s)
    .split(" ")
    .filter(Boolean)
    .filter(t => !ARTICLES.has(t));

  if (!toks.length) return "";
  return toks.map(t => FR_LEMMA[t] || t).join(" ").trim();
}

function collapseAdjacentDuplicates(tokens) {
  const out = [];
  for (const t of tokens) {
    if (!out.length || out[out.length - 1] !== t) out.push(t);
  }
  return out;
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

function scoreSpeech(target, heard) {
  const tCan = canonicalFrenchForScoring(target);
  const hCan = canonicalFrenchForScoring(heard);

  if (!tCan || !hCan) return { overall: 0, pass: false };

  let tTokens = tCan.split(" ").filter(Boolean);
  let hTokens = collapseAdjacentDuplicates(hCan.split(" ").filter(Boolean));

  // 1-Wort-Ziele: bestes Token zählt (damit "je je je" nicht bestraft wird)
  if (tTokens.length === 1) {
    let best = 0;

    for (const ht of hTokens) {
      if (ht === tCan) { best = 1; break; }
      best = Math.max(best, _charSimilarity(tCan, ht));
    }

    // Extra-Boost: wenn Zielwort irgendwo als Token vorkommt -> 100
    if (hTokens.includes(tCan)) best = 1;

    const overall = Math.round(best * 100);
    return { overall, pass: overall >= PASS_THRESHOLD };
  }

  // Mehrwort-Ziele: wenn alle Ziel-Tokens enthalten sind -> 100 (tolerant gegen Zusatzwörter)
  const setH = new Set(hTokens);
  const coverageCount = tTokens.reduce((acc, t) => acc + (setH.has(t) ? 1 : 0), 0);
  const coverage = coverageCount / (tTokens.length || 1);
  if (coverage >= 1) return { overall: 100, pass: true };

  const cs = _charSimilarity(tCan, hCan);
  // Zusatz tolerant: Coverage wichtiger als Levenshtein
  const overall = Math.round(((0.55 * cs) + (0.45 * coverage)) * 100);
  return { overall, pass: overall >= PASS_THRESHOLD };
}

// ---------- FLOW ----------
resetPackState();
render();

function addToContainer(id) {
  if (!container.includes(id)) container.push(id);
}

function allCountsReached2() {
  return getPackItems().every(it => (testCounts[it.id] || 0) >= TEST_NEED_EACH);
}

function pickNextTargetIdFrom(list) {
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)].id;
}

function nextPackOrSentences() {
  if (packIndex < getPacksCount() - 1) {
    packIndex++;
    resetPackState();
    mode = "learn";
    return render();
  }
  mode = "sentences";
  return render();
}

// ---------- RENDER ----------
function render() {
  stopAllAudioStates();

  if (mode === "learn") return renderLearn();
  if (mode === "review") return renderReview();
  if (mode === "testA") return renderTestA();
  if (mode === "testB") return renderTestB();
  if (mode === "testC") return renderTestC();
  if (mode === "sentences") return renderSentences();
  return renderEnd();
}

// ---------- PHASE learn ----------
function renderLearn() {
  if (cursor >= currentList.length) {
    // nach Pack: Container nochmal oder Test A
    if (container.length) {
      mode = "review";
      currentList = container.map(id => ID2ITEM[id]).filter(Boolean);
      container = [];
      cursor = 0;
      // in Review starten wir Failcount für diese Runde neu, sonst frustig
      for (const it of currentList) failCount[it.id] = 0;
      return render();
    }
    mode = "testA";
    testTargetId = null;
    return render();
  }

  const it = currentList[cursor];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Lernen</div>
        <div class="badge">Wort ${cursor + 1} von ${currentList.length}</div>
      </div>

      <h1>1 Wort</h1>

      <div class="card card-word">
        <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg)}" alt="" class="word-image">
        <div class="word-text">${escapeHtml(it.word)}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-later" class="btn secondary">Später noch einmal</button>
        <div id="fb" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  attachImgFallbacks();

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
    addToContainer(it.id);
    setFeedback("fb", "Okay – kommt später nochmal.", "bad");
    await sleep(350);
    cursor++;
    renderLearn();
  };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;
    if (!speechRecAvailable()) {
      setFeedback("fb", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("fb", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("fb", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
    autoStopTimer = setTimeout(async () => {
      try {
        const txt = await stopBrowserASR();
        micRecording = false;
        refreshLocks();

        const heard = (txt || "").trim();
        if (!heard) {
          setFeedback("fb", "Ich habe nichts verstanden (leer). Nicht gezählt – bitte nochmal.", "bad");
          return;
        }

        const res = scoreSpeech(it.word, heard);
        if (res.pass) {
          setFeedback("fb", `Aussprache: ${res.overall}% · Erkannt: „${heard}“ · Weiter!`, "ok");
          await sleep(420);
          cursor++;
          renderLearn();
          return;
        }

        failCount[it.id] = (failCount[it.id] || 0) + 1;
        const f = failCount[it.id];

        if (f >= FAILS_TO_CONTAINER) {
          addToContainer(it.id);
          setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Kommt später nochmal.`, "bad");
          await sleep(650);
          cursor++;
          renderLearn();
          return;
        }

        setFeedback("fb", `Aussprache: ${res.overall}% · Erkannt: „${heard}“ · Nochmal (${f}/${FAILS_TO_CONTAINER}).`, "bad");
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("fb", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, AUTO_STOP_MS);
  };
}

// ---------- PHASE review ----------
function renderReview() {
  if (cursor >= currentList.length) {
    mode = "testA";
    testTargetId = null;
    return render();
  }

  const it = currentList[cursor];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Container</div>
        <div class="badge">Wort ${cursor + 1} von ${currentList.length}</div>
      </div>

      <h1>Nochmal üben</h1>

      <div class="card card-word">
        <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg)}" alt="" class="word-image">
        <div class="word-text">${escapeHtml(it.word)}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-next" class="btn secondary">Weiter</button>
        <div id="fb" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  attachImgFallbacks();

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

  btnNext.onclick = () => { cursor++; renderReview(); };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;
    if (!speechRecAvailable()) {
      setFeedback("fb", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("fb", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("fb", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
    autoStopTimer = setTimeout(async () => {
      try {
        const txt = await stopBrowserASR();
        micRecording = false;
        refreshLocks();

        const heard = (txt || "").trim();
        if (!heard) {
          setFeedback("fb", "Ich habe nichts verstanden (leer). Nicht gezählt – bitte nochmal.", "bad");
          return;
        }

        const res = scoreSpeech(it.word, heard);
        if (res.pass) {
          setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Gut!`, "ok");
        } else {
          setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Nochmal.`, "bad");
        }
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("fb", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, AUTO_STOP_MS);
  };
}

// ---------- TEST A (Wort sichtbar + hören) ----------
function renderTestA() {
  const pack = getPackItems();

  if (allCountsReached2()) {
    for (const it of pack) testCounts[it.id] = 0;
    testTargetId = null;
    mode = "testB";
    return render();
  }

  if (!testTargetId) {
    const remaining = pack.filter(it => (testCounts[it.id] || 0) < TEST_NEED_EACH);
    testTargetId = pickNextTargetIdFrom(remaining);
  }
  const target = ID2ITEM[testTargetId];
  const grid = shuffleArray(pack);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Test A</div>
      </div>

      <h1>Test A</h1>
      <p>Tippe das richtige Bild zum Wort. (Falsch zählt nicht.)</p>

      <div class="card card-word" style="text-align:center;">
        <div class="word-text" style="font-size:34px;">${escapeHtml(target.word)}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="icon-grid">
        ${grid.map(it => `
          <button class="icon-card" data-id="${it.id}" aria-label="Option">
            <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg)}" alt="">
          </button>
        `).join("")}
      </div>

      <div id="fb" class="feedback"></div>

      <div class="meta" style="margin-top:8px;">
        ${pack.map(it => `<div class="badge">${escapeHtml(it.id)}: ${(testCounts[it.id]||0)}/${TEST_NEED_EACH}</div>`).join("")}
      </div>
    </div>
  `;

  attachImgFallbacks();

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
        setFeedback("fb", `Richtig! (${testCounts[id]}/${TEST_NEED_EACH})`, "ok");
        testTargetId = null;
        await sleep(300);
        renderTestA();
      } else {
        setFeedback("fb", "Falsch. Nicht gezählt – probier nochmal.", "bad");
      }
    };
  });
}

// ---------- TEST B (nur hören) ----------
function renderTestB() {
  const pack = getPackItems();

  if (allCountsReached2()) {
    for (const it of pack) { testCounts[it.id] = 0; testC_failStreak[it.id] = 0; }
    testC_deferred = new Set();
    testTargetId = null;
    mode = "testC";
    return render();
  }

  if (!testTargetId) {
    const remaining = pack.filter(it => (testCounts[it.id] || 0) < TEST_NEED_EACH);
    testTargetId = pickNextTargetIdFrom(remaining);
  }
  const target = ID2ITEM[testTargetId];
  const grid = shuffleArray(pack);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Test B</div>
      </div>

      <h1>Test B</h1>
      <p>Höre das Wort und tippe das richtige Bild. (Falsch zählt nicht.)</p>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="icon-grid">
        ${grid.map(it => `
          <button class="icon-card" data-id="${it.id}" aria-label="Option">
            <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg)}" alt="">
          </button>
        `).join("")}
      </div>

      <div id="fb" class="feedback"></div>

      <div class="meta" style="margin-top:8px;">
        ${pack.map(it => `<div class="badge">${escapeHtml(it.id)}: ${(testCounts[it.id]||0)}/${TEST_NEED_EACH}</div>`).join("")}
      </div>
    </div>
  `;

  attachImgFallbacks();

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
        setFeedback("fb", `Richtig! (${testCounts[id]}/${TEST_NEED_EACH})`, "ok");
        testTargetId = null;
        await sleep(300);
        renderTestB();
      } else {
        setFeedback("fb", "Falsch. Nicht gezählt – probier nochmal.", "bad");
      }
    };
  });
}

// ---------- TEST C (Bild -> sprechen) ----------
function renderTestC() {
  const pack = getPackItems();

  if (allCountsReached2()) {
    return nextPackOrSentences();
  }

  // Zielauswahl: erst nicht-deferred, dann deferred
  if (!testTargetId) {
    const remaining = pack.filter(it => (testCounts[it.id] || 0) < TEST_NEED_EACH);
    if (!remaining.length) return nextPackOrSentences();

    const nonDeferred = remaining.filter(it => !testC_deferred.has(it.id));
    const pool = nonDeferred.length ? nonDeferred : remaining;
    testTargetId = pickNextTargetIdFrom(pool);
  }

  const target = ID2ITEM[testTargetId];
  const streak = testC_failStreak[target.id] || 0;
  const showDefer = streak >= TESTC_DEFER_AFTER;

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(packLabel())}</div>
        <div class="badge">Test C</div>
        <div class="badge">${(testCounts[target.id]||0)}/${TEST_NEED_EACH}</div>
      </div>

      <h1>Test C</h1>
      <p>Sprich das Wort passend zum Bild. (Falsch zählt nicht.)</p>

      <div class="card card-word">
        <img src="${target.img}" data-fallback="${escapeHtml(target.fallbackImg)}" alt="" class="word-image">
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn secondary" ${showDefer ? "" : "disabled"}>Hören</button>
        <button id="btn-hear-slow" class="btn secondary" ${showDefer ? "" : "disabled"}>Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-defer" class="btn secondary" style="display:${showDefer ? "inline-block" : "none"};">
          Weiter & später nochmal
        </button>
        <div id="fb" class="feedback" style="flex-basis:100%;"></div>
      </div>

      <div class="meta" style="margin-top:8px;">
        ${pack.map(it => `<div class="badge">${escapeHtml(it.id)}: ${(testCounts[it.id]||0)}/${TEST_NEED_EACH}</div>`).join("")}
      </div>
    </div>
  `;

  attachImgFallbacks();

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnDefer = document.getElementById("btn-defer");

  const refresh = () => {
    const lock = micRecording || ttsActive;
    btnSpeak.disabled = lock;
    btnHear.disabled = lock || !showDefer;
    btnHearSlow.disabled = lock || !showDefer;
    if (btnDefer) btnDefer.disabled = lock || !showDefer;
  };
  setUiRefreshLocks(refresh);
  refresh();

  btnHear.onclick = () => speakWord(target.word, 1.0);
  btnHearSlow.onclick = () => speakWord(target.word, 0.7);

  if (btnDefer) {
    btnDefer.onclick = async () => {
      // dieses Bild später in Test C
      testC_deferred.add(target.id);
      testC_failStreak[target.id] = 0; // Frust-Reset
      testTargetId = null;
      setFeedback("fb", "Okay – dieses Bild kommt später nochmal.", "bad");
      await sleep(350);
      renderTestC();
    };
  }

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;
    if (!speechRecAvailable()) {
      setFeedback("fb", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("fb", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("fb", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
    autoStopTimer = setTimeout(async () => {
      try {
        const txt = await stopBrowserASR();
        micRecording = false;
        refreshLocks();

        const heard = (txt || "").trim();
        if (!heard) {
          setFeedback("fb", "Ich habe nichts verstanden (leer). Nicht gezählt – bitte nochmal.", "bad");
          return;
        }

        const res = scoreSpeech(target.word, heard);
        if (res.pass) {
          testCounts[target.id] = (testCounts[target.id] || 0) + 1;
          testC_failStreak[target.id] = 0;
          testC_deferred.delete(target.id);
          setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Gezählt! (${testCounts[target.id]}/${TEST_NEED_EACH})`, "ok");
          testTargetId = null;
          await sleep(500);
          renderTestC();
        } else {
          testC_failStreak[target.id] = (testC_failStreak[target.id] || 0) + 1;
          const n = testC_failStreak[target.id];

          // Ab 3 Fehlversuchen: Button sichtbar + System sagt das Wort (Lernhilfe)
          if (n >= TESTC_DEFER_AFTER) {
            setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Hilfe: Ich sage das Wort (oder nutze „Weiter & später nochmal“).`, "bad");
            speakWord(target.word, 1.0);
          } else {
            setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Nochmal (${n}/${TESTC_DEFER_AFTER}).`, "bad");
          }
        }
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("fb", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, 4700);
  };
}

// ---------- SATZPHASE (nur mit euren 12 Wörtern) ----------
function renderSentences() {
  const SENTS_EASY = [
    { text: "Je parle.",          imgId: "w10_sprechen" },
    { text: "Vous écoutez.",      imgId: "w09_hoeren" },
    { text: "J'ouvre la porte.",  imgId: "w08_tuer" },
    { text: "J'écris.",           imgId: "w12_schreiben" },
    { text: "Le livre.",          imgId: "w03_buch" },
    { text: "Le cahier.",         imgId: "w04_heft" },
    { text: "Le stylo.",          imgId: "w05_stift" },
    { text: "La table.",          imgId: "w06_tisch" },
    { text: "La chaise.",         imgId: "w07_stuhl" }
  ];

  const SENTS_HARD = [
    { text: "Je parle. Vous écoutez.",         imgId: "w10_sprechen" },
    { text: "Vous écoutez. Je parle.",         imgId: "w09_hoeren" },
    { text: "J'ouvre la porte. Je parle.",     imgId: "w08_tuer" },
    { text: "Je parle et j'écris.",            imgId: "w12_schreiben" },
    { text: "Vous écoutez et je parle.",       imgId: "w09_hoeren" }
  ];

  if (window.__sent_stage == null) window.__sent_stage = "easy";
  if (window.__sent_idx == null) window.__sent_idx = 0;

  const list = (window.__sent_stage === "easy") ? SENTS_EASY : SENTS_HARD;

  if (window.__sent_idx >= list.length) {
    if (window.__sent_stage === "easy") {
      window.__sent_stage = "hard";
      window.__sent_idx = 0;
      return renderSentences();
    }
    mode = "end";
    return render();
  }

  const s = list[window.__sent_idx];
  const imgItem = ID2ITEM[s.imgId] || FIXED_ITEMS[0];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Satzphase</div>
        <div class="badge">${window.__sent_stage === "easy" ? "einfach" : "anspruchsvoller"}</div>
        <div class="badge">Satz ${window.__sent_idx + 1} von ${list.length}</div>
      </div>

      <h1>Satz nachsprechen</h1>

      <div class="card card-word">
        <img src="${imgItem.img}" data-fallback="${escapeHtml(imgItem.fallbackImg)}" alt="" class="word-image">
        <div class="word-text" style="font-size:28px; line-height:1.25;">${escapeHtml(s.text)}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <div id="fb" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  attachImgFallbacks();

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
      setFeedback("fb", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("fb", "Sprich jetzt…", null);
    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR(ASR_LANG);
    if (!started) {
      setFeedback("fb", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
    autoStopTimer = setTimeout(async () => {
      try {
        const txt = await stopBrowserASR();
        micRecording = false;
        refreshLocks();

        const heard = (txt || "").trim();
        if (!heard) {
          setFeedback("fb", "Ich habe nichts verstanden (leer). Nicht gezählt – bitte nochmal.", "bad");
          return;
        }

        const res = scoreSpeech(s.text, heard);
        if (res.pass) {
          setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Weiter!`, "ok");
          window.__sent_idx++;
          await sleep(650);
          renderSentences();
        } else {
          setFeedback("fb", `Aussprache: ${res.overall}% · „${heard}“ · Nochmal.`, "bad");
        }
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("fb", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, 7000);
  };
}

// ---------- END ----------
function renderEnd() {
  appEl.innerHTML = `
    <div class="screen screen-end">
      <h1>Fertig</h1>
      <p>Alle Wörter, Tests und Sätze abgeschlossen.</p>
      <button id="btn-restart" class="btn primary">Neu starten</button>
    </div>
  `;
  document.getElementById("btn-restart").onclick = () => {
    window.__sent_stage = "easy";
    window.__sent_idx = 0;
    packIndex = 0;
    mode = "learn";
    resetPackState();
    render();
  };
}










