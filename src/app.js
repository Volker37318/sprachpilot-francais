// src/app.js – Vor-A1 / Klassensprache Französisch (STABIL: feste 12 Bilder, Reihenfolge später leicht änderbar)
//
// System pro 4er-Pack:
// 1) Lernen + Aussprache (Hören/Langsam/Sprechen/Später)
//    - ab 80% -> nächstes Wort
//    - nach 4x falsch -> Wort in Review-Container, dann weiter
// 2) Test A (Wort sichtbar): Wort + (Hören/Langsam) -> richtiges Bild klicken
//    - bis jedes der 4 Bilder 2× korrekt geklickt wurde (Fehler zählen nicht)
// 3) Test B (nur Hören): Wort wird gesprochen (ohne Text) -> Bild klicken
//    - bis jedes Bild 2× korrekt geklickt wurde (Fehler zählen nicht)
// 4) Test C (Produktion): Bild -> Nutzer spricht Wort
//    - bis jedes Bild 2× korrekt gesprochen wurde
//    - unkorrekt zählt nicht
//    - nach 3 Fehlversuchen: System sagt Wort (Lernhilfe), Wort bleibt im Review-Container
//
// Danach: nächstes 4er-Pack. Am Ende: Review-Container in 4er-Packs wiederholen. Dann Ende.

const TARGET_LANG = "fr";
const LESSON_ID = "W1D1";
const TITLE = "Vor-A1 Training";

const PACK_SIZE = 4;

const PASS_THRESHOLD = 80;         // ab 80% weiter
const FAILS_TO_REVIEW = 4;         // nach 4x falsch im Learn -> Review-Container
const TESTC_FAILS_BEFORE_TELL = 3; // nach 3 Fehlversuchen im Test C sagt System das Wort
const AUTO_ADVANCE_MS = 650;       // kurze Anzeige bei Erfolg

const IMAGE_DIR = `/assets/images/${LESSON_ID}/`; // => /assets/images/W1D1/

const appEl = document.getElementById("app");
const statusLine = document.getElementById("statusLine");
const status = (msg) => {
  if (statusLine) statusLine.textContent = msg || "";
  console.log("[STATUS]", msg);
};

// ----------------- FESTE 12 ITEMS (HIER SPÄTER REIHENFOLGE/WÖRTER ÄNDERN) -----------------
// Wichtig: img muss auf deine vorhandenen 12 Bilddateien zeigen (wie bisher).
const FIXED_ITEMS = [
  { id: "ecouter",  word: "Écouter",  translation: "", img: IMAGE_DIR + "bild1-1.png", fallbackImg: "" },
  { id: "repeter",  word: "Répéter",  translation: "", img: IMAGE_DIR + "bild1-2.png", fallbackImg: "" },
  { id: "lire",     word: "Lire",     translation: "", img: IMAGE_DIR + "bild1-3.png", fallbackImg: "" },
  { id: "ecrire",   word: "Écrire",   translation: "", img: IMAGE_DIR + "bild1-4.png", fallbackImg: "" },

  { id: "voir",     word: "Voir",     translation: "", img: IMAGE_DIR + "bild2-1.png", fallbackImg: "" },
  { id: "ouvrir",   word: "Ouvrir",   translation: "", img: IMAGE_DIR + "bild2-2.png", fallbackImg: "" },
  { id: "fermer",   word: "Fermer",   translation: "", img: IMAGE_DIR + "bild2-3.png", fallbackImg: "" },
  { id: "trouver",  word: "Trouver",  translation: "", img: IMAGE_DIR + "bild2-4.png", fallbackImg: "" },

  { id: "livre",    word: "Livre",    translation: "", img: IMAGE_DIR + "bild3-1.png", fallbackImg: "" },
  { id: "page",     word: "Page",     translation: "", img: IMAGE_DIR + "bild3-2.png", fallbackImg: "" },
  { id: "numero",   word: "Numéro",   translation: "", img: IMAGE_DIR + "bild3-3.png", fallbackImg: "" },
  { id: "tache",    word: "Tâche",    translation: "", img: IMAGE_DIR + "bild4-4.png", fallbackImg: "" }
];

// ----------------- GLOBAL STATE -----------------
let orderedItems = [...FIXED_ITEMS]; // 12 items in fester Reihenfolge
let mainIndex = 0;                   // nächster Index im Haupt-Flow
let mode = "learn";                  // "learn" | "testA" | "testB" | "testC" | "review" | "end"
let currentPack = [];                // aktuelle 4 Items
let learnIndex = 0;                  // aktuelles Wort im Learn (0..3)

let learnFailCount = 0;              // Fehlschläge fürs aktuelle Wort (Learn)
let autoStopTimer = null;
let advanceTimer = null;

// Review-Container (Einträge werden später nochmal geübt)
let reviewSet = new Set();           // Set von item.id (in Einfüge-Reihenfolge)
let reviewCursor = 0;                // rotiert durch Review-IDs

// Tests – Mastery Counters (pro Pack)
let testA_correct = new Map();       // item.id -> 0..2
let testB_correct = new Map();       // item.id -> 0..2
let testC_correct = new Map();       // item.id -> 0..2

let testTargetId = null;             // welches Item ist gerade dran
let testC_failStreak = 0;            // Fehlversuche am aktuellen Test-C Target

// TTS
let ttsSupported = "speechSynthesis" in window;
let ttsVoices = [];
let ttsVoice = null;
let ttsActive = false;

// ASR state
let micRecording = false;
let _sr = null;
let _srFinal = "";
let _srInterim = "";
let _srResolve = null;

// UI lock refresh callback
let _uiRefreshLocks = null;
function setUiRefreshLocks(fn) { _uiRefreshLocks = fn; }
function refreshLocks() { try { _uiRefreshLocks && _uiRefreshLocks(); } catch {} }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function clearAdvanceTimer() {
  try { if (advanceTimer) clearTimeout(advanceTimer); } catch {}
  advanceTimer = null;
}

function clearAutoStopTimer() {
  try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
  autoStopTimer = null;
}

// ----------------- WORD → KEY HELPERS (für Scoring) -----------------
const ARTICLES = new Set(["le", "la", "les", "un", "une", "des", "du", "de", "d", "l"]);

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function attachImgFallbacks() {
  if (!appEl) return;
  appEl.querySelectorAll("img[data-fallback]").forEach((img) => {
    const fb = img.getAttribute("data-fallback") || "";
    img.onerror = () => {
      img.onerror = null;
      if (fb) img.src = fb;
    };
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

function pickNextTargetId(masterMap) {
  const need = currentPack
    .filter(it => (masterMap.get(it.id) || 0) < 2)
    .map(it => it.id);

  if (!need.length) return null;
  return need[Math.floor(Math.random() * need.length)];
}

function allMastered(masterMap) {
  for (const it of currentPack) {
    if ((masterMap.get(it.id) || 0) < 2) return false;
  }
  return true;
}

function packProgressText(masterMap) {
  let sum = 0;
  let max = currentPack.length * 2;
  for (const it of currentPack) sum += Math.min(2, (masterMap.get(it.id) || 0));
  return `${sum}/${max}`;
}

function setFeedback(elId, text, kind) {
  const el = document.getElementById(elId);
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

// ----------------- AUDIO LOCKS -----------------
function setLocksForButtons({ btnHear, btnHearSlow, btnSpeak, btnLater }) {
  const localRefresh = () => {
    const rec = micRecording;
    const tts = ttsActive;

    if (btnHear) btnHear.disabled = rec || tts;
    if (btnHearSlow) btnHearSlow.disabled = rec || tts;

    if (btnSpeak) btnSpeak.disabled = rec || tts;
    if (btnLater) btnLater.disabled = rec || tts;
  };
  setUiRefreshLocks(localRefresh);
  localRefresh();
}

// ----------------- LOCAL ASR (Browser SpeechRecognition) -----------------
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

// ----------------- SCORING (wie bisher, aber PASS = >=80) -----------------
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
  return _norm(s)
    .split(" ")
    .filter(Boolean)
    .filter(t => !ARTICLES.has(t));
}

const FR_VERB_LEMMA = {
  ecoute: "ecouter", ecouter: "ecouter",
  repete: "repeter", repeter: "repeter",
  lis: "lire", lire: "lire",
  ecris: "ecrire", ecrire: "ecrire",
  vois: "voir", voir: "voir",
  ouvre: "ouvrir", ouvrir: "ouvrir", ouvert: "ouvrir",
  ferme: "fermer", fermer: "fermer",
  trouve: "trouver", trouver: "trouver"
};

function canonicalFrenchForScoring(s) {
  const toks = _tokensNoArticles(s);
  if (!toks.length) return "";
  const out = [...toks];
  out[0] = FR_VERB_LEMMA[out[0]] || out[0];
  return out.join(" ").trim();
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

function _tokenSimilarity(target, heard) {
  const A = _norm(target).split(" ").filter(Boolean);
  const B = _norm(heard).split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;

  const setB = new Set(B);
  let common = 0;
  for (const t of A) if (setB.has(t)) common++;

  const denom = Math.max(A.length, B.length) || 1;
  return common / denom;
}

function scoreSpeech(target, heard) {
  const tCan = canonicalFrenchForScoring(target);
  const hCan = canonicalFrenchForScoring(heard);

  if (tCan && hCan && tCan === hCan) {
    return { overall: 100, grade: "excellent", pass: true };
  }

  const cs = _charSimilarity(tCan || target, hCan || heard);
  const ts = _tokenSimilarity(tCan || target, hCan || heard);
  const sim = (0.7 * cs) + (0.3 * ts);
  const overall = Math.max(0, Math.min(100, Math.round(sim * 100)));

  return {
    overall,
    grade: overall >= 90 ? "excellent" : overall >= 80 ? "good" : overall >= 65 ? "ok" : "try_again",
    pass: overall >= PASS_THRESHOLD
  };
}

// ----------------- INIT (ohne JSON, nur feste Items) -----------------
initTTS();
startProgram();

// ----------------- PROGRAM FLOW -----------------
function startProgram() {
  clearAdvanceTimer();
  stopAllAudioStates();

  mainIndex = 0;
  mode = "learn";
  reviewSet = new Set();
  reviewCursor = 0;

  loadNextPackFromMain();
  render();
}

function loadNextPackFromMain() {
  currentPack = orderedItems.slice(mainIndex, mainIndex + PACK_SIZE);
  learnIndex = 0;
  learnFailCount = 0;
  resetPackTests();

  if (!currentPack.length) {
    return startReviewMode();
  }
}

function startReviewMode() {
  mode = "review";
  const ids = Array.from(reviewSet);

  if (!ids.length) {
    mode = "end";
    return;
  }

  if (reviewCursor >= ids.length) reviewCursor = 0;

  currentPack = ids
    .slice(reviewCursor, reviewCursor + PACK_SIZE)
    .map(id => orderedItems.find(x => x.id === id))
    .filter(Boolean);

  reviewCursor += PACK_SIZE;

  learnIndex = 0;
  learnFailCount = 0;
  resetPackTests();

  if (!currentPack.length) {
    mode = "end";
  }
}

function completeCurrentPack() {
  stopAllAudioStates();
  clearAdvanceTimer();

  if (mode === "review") {
    // Aus Review raus, wenn in Test C 2× korrekt gesprochen
    for (const it of currentPack) {
      const c = testC_correct.get(it.id) || 0;
      if (c >= 2) reviewSet.delete(it.id);
    }
    startReviewMode();
    return render();
  }

  mainIndex += PACK_SIZE;
  loadNextPackFromMain();
  return render();
}

function resetPackTests() {
  testA_correct = new Map();
  testB_correct = new Map();
  testC_correct = new Map();
  testTargetId = null;
  testC_failStreak = 0;

  for (const it of currentPack) {
    testA_correct.set(it.id, 0);
    testB_correct.set(it.id, 0);
    testC_correct.set(it.id, 0);
  }
}

function render() {
  if (!appEl) return;

  if (mode === "end") return renderEndScreen();
  if (mode === "learn" || mode === "review") return renderLearnWord();
  if (mode === "testA") return renderTestA();
  if (mode === "testB") return renderTestB();
  if (mode === "testC") return renderTestC();
}

// ----------------- LEARN (Wort für Wort) -----------------
function renderLearnWord() {
  clearAdvanceTimer();
  stopAllAudioStates();

  const it = currentPack[learnIndex];
  if (!it) {
    mode = "testA";
    testTargetId = null;
    return render();
  }

  const isReview = (mode === "review");
  const total = orderedItems.length || 12;
  const globalPos = Math.min(total, isReview ? total : (mainIndex + learnIndex + 1));
  const packNo = isReview ? "Wiederholung" : `Pack ${Math.floor(mainIndex / PACK_SIZE) + 1} von ${Math.ceil(total / PACK_SIZE)}`;

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">${escapeHtml(TITLE)} – ${escapeHtml(TARGET_LANG.toUpperCase())}</div>
        <div class="badge">${escapeHtml(packNo)}</div>
        <div class="badge">Wort ${learnIndex + 1} von ${currentPack.length}${isReview ? " (Review)" : ""}</div>
        <div class="badge">Gesamt ${globalPos} von ${total}</div>
      </div>

      <h1>${isReview ? "Wiederholung" : "Lernen"}</h1>

      <div class="card card-word">
        <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg || "")}" alt="${escapeHtml(it.word)}" class="word-image">
        <div class="word-text">${escapeHtml(it.word)}</div>
        <div class="word-translation">${escapeHtml(it.translation || "")}</div>
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

      <div style="margin-top:10px; font-size:13px; opacity:.8;">
        Fehlversuche: <strong>${learnFailCount}</strong> / ${FAILS_TO_REVIEW}
      </div>
    </div>
  `;

  attachImgFallbacks();

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnLater = document.getElementById("btn-later");

  setLocksForButtons({ btnHear, btnHearSlow, btnSpeak, btnLater });

  btnHear.onclick = () => { if (!micRecording && !ttsActive) speakWord(it.word, 1.0); };
  btnHearSlow.onclick = () => { if (!micRecording && !ttsActive) speakWord(it.word, 0.7); };

  btnLater.onclick = async () => {
    if (micRecording || ttsActive) return;
    reviewSet.add(it.id);
    setFeedback("learn-feedback", "Okay – dieses Wort kommt später nochmal (Review).", "ok");
    await sleep(500);
    goNextLearnWord();
  };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;

    stopAllAudioStates();

    if (!speechRecAvailable()) {
      setFeedback("learn-feedback", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("learn-feedback", "Sprich jetzt. Aufnahme stoppt automatisch.", null);

    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR("fr-FR");
    if (!started) {
      setFeedback("learn-feedback", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    clearAutoStopTimer();
    autoStopTimer = setTimeout(async () => {
      try {
        setFeedback("learn-feedback", "Verarbeite…", null);

        const recognizedText = await stopBrowserASR();
        const res = scoreSpeech(it.word, recognizedText);

        micRecording = false;
        refreshLocks();

        if (res.pass) {
          setFeedback(
            "learn-feedback",
            `Aussprache: ${res.overall}% (${res.grade}) · Erkannt: „${recognizedText || "(leer)"}“ · Weiter!`,
            "ok"
          );
          clearAdvanceTimer();
          advanceTimer = setTimeout(() => goNextLearnWord(), AUTO_ADVANCE_MS);
          return;
        }

        learnFailCount++;
        setFeedback(
          "learn-feedback",
          `Aussprache: ${res.overall}% (${res.grade}) · Erkannt: „${recognizedText || "(leer)"}“ · Nochmal.`,
          "bad"
        );

        if (learnFailCount >= FAILS_TO_REVIEW) {
          reviewSet.add(it.id);
          setFeedback("learn-feedback", "Noch nicht sicher. Dieses Wort kommt später nochmal (Review).", "bad");
          clearAdvanceTimer();
          advanceTimer = setTimeout(() => goNextLearnWord(true), 900);
        }
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("learn-feedback", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, 3500);
  };
}

function goNextLearnWord(resetFail = false) {
  stopAllAudioStates();
  clearAdvanceTimer();
  if (resetFail) learnFailCount = 0;

  learnIndex++;
  learnFailCount = 0;
  renderLearnWord();
}

// ----------------- TEST A (WORT SICHTBAR) -----------------
function renderTestA() {
  clearAdvanceTimer();
  stopAllAudioStates();

  if (testTargetId == null) testTargetId = pickNextTargetId(testA_correct);
  if (testTargetId == null) {
    mode = "testB";
    testTargetId = null;
    return render();
  }

  const target = currentPack.find(x => x.id === testTargetId);
  const packShuffled = shuffleArray([...currentPack]);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">Test A – Wort sichtbar</div>
        <div class="badge">Ziel: jedes Bild 2× korrekt</div>
        <div class="badge">Fortschritt: ${packProgressText(testA_correct)}</div>
      </div>

      <h1>Welches Bild passt?</h1>
      <div class="card card-word" style="text-align:center;">
        <div class="word-text" style="font-size:30px; line-height:1.1;">${escapeHtml(target.word)}</div>
        <div class="word-translation" style="margin-top:8px;">${escapeHtml(target.translation || "")}</div>
      </div>

      <div class="icon-grid">
        ${packShuffled.map((it) => `
          <button class="icon-card" data-id="${it.id}" aria-label="Option">
            <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg || "")}" alt="">
          </button>
        `).join("")}
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div id="testA-feedback" class="feedback"></div>
    </div>
  `;

  attachImgFallbacks();

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  setLocksForButtons({ btnHear, btnHearSlow, btnSpeak: null, btnLater: null });

  btnHear.onclick = () => { if (!micRecording && !ttsActive) speakWord(target.word, 1.0); };
  btnHearSlow.onclick = () => { if (!micRecording && !ttsActive) speakWord(target.word, 0.7); };

  speakWord(target.word, 1.0);

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = async () => {
      if (ttsActive || micRecording) return;

      const id = btn.getAttribute("data-id");
      if (id === target.id) {
        const c = (testA_correct.get(target.id) || 0) + 1;
        testA_correct.set(target.id, Math.min(2, c));
        setFeedback("testA-feedback", "Richtig!", "ok");

        await sleep(550);

        if (allMastered(testA_correct)) {
          mode = "testB";
          testTargetId = null;
          return render();
        }

        testTargetId = pickNextTargetId(testA_correct);
        return renderTestA();
      } else {
        setFeedback("testA-feedback", "Falsch. Nicht gezählt – versuch es nochmal.", "bad");
      }
    };
  });
}

// ----------------- TEST B (NUR HÖREN) -----------------
function renderTestB() {
  clearAdvanceTimer();
  stopAllAudioStates();

  if (testTargetId == null) testTargetId = pickNextTargetId(testB_correct);
  if (testTargetId == null) {
    mode = "testC";
    testTargetId = null;
    testC_failStreak = 0;
    return render();
  }

  const target = currentPack.find(x => x.id === testTargetId);
  const packShuffled = shuffleArray([...currentPack]);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">Test B – Nur hören</div>
        <div class="badge">Ziel: jedes Bild 2× korrekt</div>
        <div class="badge">Fortschritt: ${packProgressText(testB_correct)}</div>
      </div>

      <h1>Hör zu und wähle</h1>
      <p>Das Wort wird gesprochen. Tippe das passende Bild an.</p>

      <div class="icon-grid">
        ${packShuffled.map((it) => `
          <button class="icon-card" data-id="${it.id}" aria-label="Option">
            <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg || "")}" alt="">
          </button>
        `).join("")}
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div id="testB-feedback" class="feedback"></div>
    </div>
  `;

  attachImgFallbacks();

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  setLocksForButtons({ btnHear, btnHearSlow, btnSpeak: null, btnLater: null });

  btnHear.onclick = () => { if (!micRecording && !ttsActive) speakWord(target.word, 1.0); };
  btnHearSlow.onclick = () => { if (!micRecording && !ttsActive) speakWord(target.word, 0.7); };

  speakWord(target.word, 1.0);

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = async () => {
      if (ttsActive || micRecording) return;

      const id = btn.getAttribute("data-id");
      if (id === target.id) {
        const c = (testB_correct.get(target.id) || 0) + 1;
        testB_correct.set(target.id, Math.min(2, c));
        setFeedback("testB-feedback", "Richtig!", "ok");

        await sleep(550);

        if (allMastered(testB_correct)) {
          mode = "testC";
          testTargetId = null;
          testC_failStreak = 0;
          return render();
        }

        testTargetId = pickNextTargetId(testB_correct);
        return renderTestB();
      } else {
        setFeedback("testB-feedback", "Falsch. Nicht gezählt – hör nochmal.", "bad");
      }
    };
  });
}

// ----------------- TEST C (BILD → SPRECHEN) -----------------
function renderTestC() {
  clearAdvanceTimer();
  stopAllAudioStates();

  if (testTargetId == null) testTargetId = pickNextTargetId(testC_correct);

  if (testTargetId == null) {
    completeCurrentPack();
    return;
  }

  const target = currentPack.find(x => x.id === testTargetId);

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Test C – Bild sprechen</div>
        <div class="badge">Ziel: jedes Bild 2× korrekt sprechen</div>
        <div class="badge">Fortschritt: ${packProgressText(testC_correct)}</div>
      </div>

      <h1>Wie heißt das?</h1>

      <div class="card card-word">
        <img src="${target.img}" data-fallback="${escapeHtml(target.fallbackImg || "")}" alt="Bild" class="word-image">
        <div class="word-translation" style="margin-top:10px;">Sprich das Wort (ohne dass es angezeigt wird).</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <div id="testC-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>

      <div style="margin-top:10px; font-size:13px; opacity:.8;">
        Fehlversuche aktuell: <strong>${testC_failStreak}</strong> / ${TESTC_FAILS_BEFORE_TELL}
      </div>
    </div>
  `;

  attachImgFallbacks();

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");

  setLocksForButtons({ btnHear, btnHearSlow, btnSpeak, btnLater: null });

  btnHear.onclick = () => { if (!micRecording && !ttsActive) speakWord(target.word, 1.0); };
  btnHearSlow.onclick = () => { if (!micRecording && !ttsActive) speakWord(target.word, 0.7); };

  btnSpeak.onclick = async () => {
    if (micRecording || ttsActive) return;

    stopAllAudioStates();

    if (!speechRecAvailable()) {
      setFeedback("testC-feedback", "Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", "bad");
      return;
    }

    setFeedback("testC-feedback", "Sprich jetzt. Aufnahme stoppt automatisch.", null);

    try { window.speechSynthesis.cancel(); } catch {}
    ttsActive = false;
    refreshLocks();
    await sleep(120);

    const started = startBrowserASR("fr-FR");
    if (!started) {
      setFeedback("testC-feedback", "Spracherkennung konnte nicht starten. Bitte Seite neu laden.", "bad");
      return;
    }

    micRecording = true;
    refreshLocks();

    clearAutoStopTimer();
    autoStopTimer = setTimeout(async () => {
      try {
        setFeedback("testC-feedback", "Verarbeite…", null);

        const recognizedText = await stopBrowserASR();
        const res = scoreSpeech(target.word, recognizedText);

        micRecording = false;
        refreshLocks();

        if (res.pass) {
          const c = (testC_correct.get(target.id) || 0) + 1;
          testC_correct.set(target.id, Math.min(2, c));
          testC_failStreak = 0;

          setFeedback(
            "testC-feedback",
            `Aussprache: ${res.overall}% (${res.grade}) · Erkannt: „${recognizedText || "(leer)"}“ · Gezählt!`,
            "ok"
          );

          clearAdvanceTimer();
          advanceTimer = setTimeout(() => {
            testTargetId = pickNextTargetId(testC_correct);
            renderTestC();
          }, AUTO_ADVANCE_MS);

          return;
        }

        testC_failStreak++;
        setFeedback(
          "testC-feedback",
          `Aussprache: ${res.overall}% (${res.grade}) · Erkannt: „${recognizedText || "(leer)"}“ · Nicht gezählt.`,
          "bad"
        );

        if (testC_failStreak >= TESTC_FAILS_BEFORE_TELL) {
          reviewSet.add(target.id);
          testC_failStreak = 0;

          setFeedback("testC-feedback", "Lernhilfe: Hör nochmal zu. (Dieses Wort kommt später nochmal.)", "bad");
          await sleep(350);
          speakWord(target.word, 0.7);

          clearAdvanceTimer();
          advanceTimer = setTimeout(() => {
            testTargetId = pickNextTargetId(testC_correct);
            renderTestC();
          }, 900);
        }
      } catch (e) {
        console.error(e);
        micRecording = false;
        refreshLocks();
        setFeedback("testC-feedback", "Fehler beim Prüfen. Bitte nochmal versuchen.", "bad");
      }
    }, 3800);
  };
}

// ----------------- END SCREEN -----------------
function renderEndScreen() {
  clearAdvanceTimer();
  stopAllAudioStates();

  const reviewLeft = Array.from(reviewSet).length;

  appEl.innerHTML = `
    <div class="screen screen-end">
      <h1>Fertig</h1>
      <p>Du hast die 12 Wörter durchgearbeitet und die Tests abgeschlossen.</p>
      <p>${reviewLeft ? `Offene Wiederholungen: <strong>${reviewLeft}</strong>` : "Keine offenen Wiederholungen mehr."}</p>

      <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:14px;">
        <button id="btn-repeat" class="btn primary">Nochmal starten</button>
      </div>
    </div>
  `;

  document.getElementById("btn-repeat").onclick = () => startProgram();
}

// ----------------- TTS -----------------
function initTTS() {
  if (!ttsSupported) {
    status("Sprachausgabe wird von diesem Browser nicht unterstützt.");
    return;
  }

  const pickVoice = () => {
    ttsVoices = window.speechSynthesis.getVoices() || [];
    if (!ttsVoices.length) return;

    ttsVoice =
      ttsVoices.find((v) => v.lang && v.lang.toLowerCase().startsWith("fr")) ||
      ttsVoices[0];

    status(
      ttsVoice
        ? `Sprachausgabe bereit: ${ttsVoice.name} (${ttsVoice.lang})`
        : "Sprachausgabe bereit."
    );
  };

  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

function speakWord(text, rate = 1.0) {
  if (!ttsSupported) return;
  if (!text) return;
  if (micRecording) return;

  try {
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    if (ttsVoice) {
      utter.voice = ttsVoice;
      utter.lang = ttsVoice.lang;
    } else {
      utter.lang = "fr-FR";
    }
    utter.rate = rate;

    utter.onstart = () => { ttsActive = true; refreshLocks(); };
    utter.onend = () => { ttsActive = false; refreshLocks(); };
    utter.onerror = () => { ttsActive = false; refreshLocks(); };

    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.error("TTS error", e);
    ttsActive = false;
    refreshLocks();
    status("Fehler bei der Sprachausgabe.");
  }
}

// ----------------- CLEANUP -----------------
function stopAllAudioStates() {
  clearAutoStopTimer();

  if (_sr) {
    try { _sr.stop(); } catch {}
    _sr = null;
  }

  micRecording = false;

  try { window.speechSynthesis?.cancel?.(); } catch {}
  ttsActive = false;

  refreshLocks();
}




