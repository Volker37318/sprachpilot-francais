// src/app.js – Vor-A1 / Klassensprache Französisch
// Flow:
// Block 1: Phase 1 (Lernen + Aussprache) → Phase 2 (Tippen, 4er Pack)
// Block 2: Phase 1 → Phase 2
// Block 3: Phase 1 → Phase 2
// Danach: Phase 3 (Globales Hör-Quiz aus 12 Bildern, 4er Pack, ohne Beschriftung)
// Danach: Phase 4 (Sätze nachsprechen)
// Danach: Ende
//

const TARGET_LANG = "fr";
const LESSON_ID = "W1D1";

const PASS_EXACT = 100;          // nur bei 100% automatisch weiter
const FAILS_FOR_SKIP = 5;        // nach 5x falsch -> Skip-Button aktiv
const AUTO_ADVANCE_MS = 2500;    // 2,5 Sekunden Anzeige bei 100%

const IMAGE_DIR = `/assets/images/${LESSON_ID}/`; // => /assets/images/W1D1/

const appEl = document.getElementById("app");
const statusLine = document.getElementById("statusLine");
const status = (msg) => {
  if (statusLine) statusLine.textContent = msg || "";
  console.log("[STATUS]", msg);
};

let lesson = null;

// Block-Flow
let currentBlockIndex = 0;
let currentPhase = "learn"; // "learn" | "shuffle" | "quiz" | "sentences"
let currentItemIndex = 0;

// Phase 2
let shuffleOrder = [];

// Phase 3
let quizPool = [];
let quizTargetOrder = [];
let quizIndex = 0;
let quizAttemptsLeft = 3;

// Phase 4
let sentenceList = [];
let sentenceIndex = 0;

// TTS
let ttsSupported = "speechSynthesis" in window;
let ttsVoices = [];
let ttsVoice = null;
let ttsActive = false;

// ASR state
let micRecording = false;
let autoStopTimer = null;
let advanceTimer = null;

// Fail counter (pro aktuellem Wort/Satz)
let currentFailCount = 0;

// UI lock refresh callback
let _uiRefreshLocks = null;
function setUiRefreshLocks(fn) { _uiRefreshLocks = fn; }
function refreshLocks() { try { _uiRefreshLocks && _uiRefreshLocks(); } catch {} }

const ARTICLES = new Set(["le", "la", "les", "un", "une", "des", "du", "de", "d", "l"]);

const BTN_GRAD = "background: linear-gradient(135deg,#ff8a00,#ffd54a); border:1px solid rgba(0,0,0,.14); color:#1b1b1b; font-weight:900;";
const BTN_GRAY = "background:#cbd5e1; border:1px solid rgba(0,0,0,.12); color:#64748b; font-weight:900; cursor:not-allowed; filter:grayscale(1);";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function clearAdvanceTimer() {
  try { if (advanceTimer) clearTimeout(advanceTimer); } catch {}
  advanceTimer = null;
}

// ----------------- WORD → IMAGE (HARDCODED) -----------------

function wordKeyForMap(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapKeyFromPhrase(wordOrPhrase) {
  const k = wordKeyForMap(wordOrPhrase);
  const parts = k.split(" ").filter(Boolean);
  if (!parts.length) return "";

  let start = 0;
  while (start < parts.length && ARTICLES.has(parts[start])) start++;

  const core = parts.slice(start);
  if (core.length) {
    const last = core[core.length - 1].replace(/[0-9]+$/g, "");
    return last || core[core.length - 1];
  }
  return parts[parts.length - 1].replace(/[0-9]+$/g, "");
}

const WORD_TO_IMAGE_FILE = {
  ecouter: "bild1-1.png",
  repeter: "bild1-2.png",
  lire: "bild1-3.png",
  ecrire: "bild1-4.png",

  voir: "bild2-1.png",
  ouvrir: "bild2-2.png",
  fermer: "bild2-3.png",
  trouver: "bild2-4.png",

  livre: "bild3-1.png",
  page: "bild3-2.png",
  numero: "bild3-3.png",

  tache: "bild4-4.png"
};

function imageSrcForWord(wordOrPhrase) {
  const key = mapKeyFromPhrase(wordOrPhrase);
  const file = WORD_TO_IMAGE_FILE[key];
  return file ? (IMAGE_DIR + file) : "";
}

function attachImgFallbacks() {
  appEl.querySelectorAll("img[data-fallback]").forEach((img) => {
    const fb = img.getAttribute("data-fallback") || "";
    img.onerror = () => {
      img.onerror = null;
      if (fb) img.src = fb;
    };
  });
}

// ----------------- LOCAL ASR (Browser SpeechRecognition) -----------------
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

// ----------------- SCORING -----------------
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

  // LOCK: Wenn Kanonisch identisch -> 100 (z.B. "Ferme le livre" vs "fermer le livre")
  if (tCan && hCan && tCan === hCan) {
    return { overall: 100, grade: "excellent", pass100: true };
  }

  const cs = _charSimilarity(tCan || target, hCan || heard);
  const ts = _tokenSimilarity(tCan || target, hCan || heard);
  const sim = (0.7 * cs) + (0.3 * ts);
  const overall = Math.max(0, Math.min(100, Math.round(sim * 100)));

  return {
    overall,
    grade: overall >= 90 ? "excellent" : overall >= 75 ? "good" : overall >= 60 ? "ok" : "try_again",
    pass100: overall >= PASS_EXACT
  };
}

// ----------------- INIT -----------------
initTTS();

loadLesson(TARGET_LANG, LESSON_ID)
  .then((data) => {
    lesson = data;
    buildQuizPoolFromLesson();
    buildSentenceList();
    startLesson();
  })
  .catch((err) => {
    console.error(err);
    appEl.textContent = "Fehler beim Laden der Lektion.";
    status(err.message);
  });

async function loadLesson(lang, lessonId) {
  const res = await fetch(`lessons/${lang}/${lessonId}.json`);
  if (!res.ok) throw new Error(`Konnte Lektion nicht laden: ${res.status}`);
  return await res.json();
}

function startLesson() {
  clearAdvanceTimer();
  currentBlockIndex = 0;
  currentPhase = "learn";
  currentItemIndex = 0;
  shuffleOrder = [];
  quizIndex = 0;
  quizAttemptsLeft = 3;
  sentenceIndex = 0;
  currentFailCount = 0;
  render();
}

function advanceFromLearn(block) {
  stopAllAudioStates();
  clearAdvanceTimer();

  if (currentItemIndex < block.items.length - 1) {
    currentItemIndex++;
    return render();
  }

  currentPhase = "shuffle";
  currentItemIndex = 0;
  shuffleOrder = shuffleArray([...block.items]);
  render();
}

function advanceFromSentence() {
  stopAllAudioStates();
  clearAdvanceTimer();

  sentenceIndex++;
  renderSentencePhase();
}

// ----------------- QUIZ POOL (12) -----------------
function buildQuizPoolFromLesson() {
  quizPool = [];
  if (!lesson?.blocks?.length) return;

  for (let b = 0; b < lesson.blocks.length; b++) {
    const block = lesson.blocks[b];
    for (let i = 0; i < (block.items || []).length; i++) {
      const it = block.items[i];
      const w = String(it.word || "").trim();
      if (!w) continue;

      const mapped = imageSrcForWord(w);
      const img = mapped || (it.image || "");

      quizPool.push({
        qid: `b${b + 1}i${i + 1}:${mapKeyFromPhrase(w)}`,
        word: w,
        img,
        fallbackImg: it.image || ""
      });

      if (quizPool.length >= 12) break;
    }
    if (quizPool.length >= 12) break;
  }

  if (quizPool.length < 12) {
    const existing = new Set(quizPool.map(x => mapKeyFromPhrase(x.word)));
    for (const [k, file] of Object.entries(WORD_TO_IMAGE_FILE)) {
      if (existing.has(k)) continue;
      quizPool.push({
        qid: `map:${k}`,
        word: k,
        img: IMAGE_DIR + file,
        fallbackImg: ""
      });
      if (quizPool.length >= 12) break;
    }
  }

  quizTargetOrder = shuffleArray([...quizPool]);
}

// ----------------- SENTENCES (Phase 4) -----------------
function buildSentenceList() {
  const seen = new Set((quizPool || []).map(x => mapKeyFromPhrase(x.word)).filter(Boolean));
  const has = (k) => seen.has(k);

  const list = [];

  if (has("ecouter") && has("repeter")) list.push({ text: "Écoute et répète.", de: "Hör zu und wiederhole." });
  if (has("ouvrir") && has("livre"))   list.push({ text: "Ouvre le livre.", de: "Öffne das Buch." });
  if (has("fermer") && has("livre"))   list.push({ text: "Ferme le livre.", de: "Schließe das Buch." });
  if (has("lire") && has("page"))      list.push({ text: "Lis la page.", de: "Lies die Seite." });
  if (has("ecrire") && has("numero"))  list.push({ text: "Écris le numéro.", de: "Schreibe die Nummer." });
  if (has("trouver") && has("tache"))  list.push({ text: "Trouve la tâche.", de: "Finde die Aufgabe." });
  if (has("voir") && has("page"))      list.push({ text: "Vois la page.", de: "Sieh die Seite." });
  if (has("repeter") && has("numero")) list.push({ text: "Répète le numéro.", de: "Wiederhole die Nummer." });

  sentenceList = list;
}

// ----------------- RENDER -----------------
function render() {
  if (!lesson) return;

  if (currentPhase === "learn") return renderLearnPhase(lesson.blocks[currentBlockIndex]);
  if (currentPhase === "shuffle") return renderShufflePhase(lesson.blocks[currentBlockIndex]);
  if (currentPhase === "quiz") return renderGlobalQuizPhase();
  if (currentPhase === "sentences") return renderSentencePhase();

  renderEndScreen();
}

// ------- button style helper -------
function styleSpeakButtons(btnSpeak, btnSkip) {
  const skipActive = currentFailCount >= FAILS_FOR_SKIP;

  // Speak: aktiv = Gradient, ab 5 fails grau & disabled
  if (skipActive) {
    btnSpeak.disabled = true;
    btnSpeak.setAttribute("style", BTN_GRAY);
  } else {
    btnSpeak.disabled = false;
    btnSpeak.setAttribute("style", BTN_GRAD);
  }

  // Skip: ab 5 fails aktiv (Gradient), sonst disabled (grau/optisch neutral)
  if (skipActive) {
    btnSkip.disabled = false;
    btnSkip.setAttribute("style", BTN_GRAD);
  } else {
    btnSkip.disabled = true;
    // leicht neutral, nicht voll grau wie disabled speak
    btnSkip.setAttribute("style", "background:#eef2ff; border:1px solid rgba(0,0,0,.12); color:#64748b; font-weight:900;");
  }
}

// ----------------- Phase 1 (Learn + Speak) -----------------
function renderLearnPhase(block) {
  clearAdvanceTimer();
  stopAllAudioStates();

  const item = block.items[currentItemIndex];
  const blockNo = currentBlockIndex + 1;

  // Reset Failcounter pro Wort
  currentFailCount = 0;

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Tag 1 – ${lesson.title || "Französisch"}</div>
        <div class="badge">Block ${blockNo} von ${lesson.blocks.length}</div>
        <div class="badge">Wort ${currentItemIndex + 1} von ${block.items.length}</div>
      </div>

      <h1>${block.label}</h1>

      <div class="card card-word">
        <img src="${item.image}" alt="${escapeHtml(item.word)}" class="word-image">
        <div class="word-text">${escapeHtml(item.word)}</div>
        <div class="word-translation">${escapeHtml(item.translation || "")}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-skip" class="btn secondary" disabled>Später noch einmal</button>
        <div id="speak-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnSkip = document.getElementById("btn-skip");

  styleSpeakButtons(btnSpeak, btnSkip);

  const localRefresh = () => {
    const rec = micRecording;
    const tts = ttsActive;

    // Verriegelung: Keine TTS-Buttons während Mic/TTS
    btnHear.disabled = rec || tts;
    btnHearSlow.disabled = rec || tts;

    // Während Mic/TTS: Speak/Skip ebenfalls blocken, danach Style wieder setzen
    if (rec || tts) {
      btnSpeak.disabled = true;
      btnSkip.disabled = true;
    } else {
      styleSpeakButtons(btnSpeak, btnSkip);
    }
  };
  setUiRefreshLocks(localRefresh);
  localRefresh();

  btnHear.onclick = () => { if (!micRecording && !ttsActive) speakWord(item.word, 1.0); };
  btnHearSlow.onclick = () => { if (!micRecording && !ttsActive) speakWord(item.word, 0.7); };

  btnSkip.onclick = async () => {
    setSpeakFeedback("Wir kommen später zurück.", null);
    // kurzer Moment für Feedback, dann automatisch weiter
    await sleep(650);
    advanceFromLearn(block);
  };

  btnSpeak.onclick = async () => {
    if (micRecording) return;
    if (currentFailCount >= FAILS_FOR_SKIP) return; // Speak ist ab 5 fails passiv

    const clearAutoStop = () => {
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
    };

    const stopAndAssess = async () => {
      if (!micRecording) return;

      clearAutoStop();
      setSpeakFeedback("Verarbeite…", null);

      const recognizedText = await stopBrowserASR();
      const res = scoreSpeech(item.word, recognizedText);

      micRecording = false;
      refreshLocks();

      if (!res.pass100) currentFailCount++;

      if (res.pass100) {
        setSpeakFeedback(
          `Aussprache: ${res.overall}% (${res.grade}) · Erkannt: „${recognizedText || "(leer)"}“ · Perfekt!`,
          true
        );

        // 4 Sekunden anzeigen, dann automatisch weiter
        clearAdvanceTimer();
        advanceTimer = setTimeout(() => {
          advanceFromLearn(block);
        }, AUTO_ADVANCE_MS);

        return;
      }

      // nicht 100%
      if (currentFailCount >= FAILS_FOR_SKIP) {
        // Speak grau, Skip aktiv
        styleSpeakButtons(btnSpeak, btnSkip);
      }

      setSpeakFeedback(
        `Aussprache: ${res.overall}% (${res.grade})` +
        ` · Erkannt: „${recognizedText || "(leer)"}“` +
        ` · Nochmal (${currentFailCount}/${FAILS_FOR_SKIP})`,
        false
      );
    };

    try {
      stopAllAudioStates();

      if (!speechRecAvailable()) {
        setSpeakFeedback("Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", false);
        return;
      }

      setSpeakFeedback("Sprich jetzt. Aufnahme stoppt automatisch.", null);

      // TTS aus, damit Mic nicht die Stimme einsammelt
      try { window.speechSynthesis.cancel(); } catch {}
      ttsActive = false;
      refreshLocks();
      await sleep(150);

      const started = startBrowserASR("fr-FR");
      if (!started) {
        setSpeakFeedback("Spracherkennung konnte nicht starten. Bitte Seite neu laden.", false);
        return;
      }

      micRecording = true;
      refreshLocks();

      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        stopAndAssess().catch((e) => {
          console.error(e);
          micRecording = false;
          refreshLocks();
          setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
        });
      }, 3500);

    } catch (e) {
      console.error(e);
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
      micRecording = false;
      stopAllAudioStates();
      refreshLocks();
      setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
    }
  };
}

// ----------------- Phase 2 (Tippen) -----------------
function renderShufflePhase(block) {
  clearAdvanceTimer();
  stopAllAudioStates();

  const blockNo = currentBlockIndex + 1;

  if (!shuffleOrder || shuffleOrder.length !== block.items.length) {
    shuffleOrder = shuffleArray([...block.items]);
  }

  if (currentItemIndex >= shuffleOrder.length) {
    if (currentBlockIndex < lesson.blocks.length - 1 && currentBlockIndex < 2) {
      currentBlockIndex++;
      currentPhase = "learn";
      currentItemIndex = 0;
      shuffleOrder = [];
      return render();
    }

    currentPhase = "quiz";
    quizIndex = 0;
    quizAttemptsLeft = 3;
    quizTargetOrder = shuffleArray([...quizPool]);
    return render();
  }

  const target = shuffleOrder[currentItemIndex];
  const gridItems = shuffleArray([...block.items]);

  appEl.innerHTML = `
    <div class="screen screen-shuffle">
      <div class="meta">
        <div class="badge">Block ${blockNo} – Phase 2</div>
        <div class="badge">Aufgabe ${currentItemIndex + 1} von ${shuffleOrder.length}</div>
      </div>

      <h1>Bilder & Wörter</h1>
      <p>Höre das Wort und tippe das richtige Bild.</p>

      <div class="icon-grid">
        ${gridItems.map((it) => {
          const mapped = imageSrcForWord(it.word);
          const src = mapped || (it.image || "");
          const fb = it.image || "";
          return `
            <button class="icon-card" data-word="${escapeHtml(it.word)}" aria-label="Option">
              <img src="${src}" data-fallback="${escapeHtml(fb)}" alt="">
            </button>
          `;
        }).join("")}
      </div>

      <div class="controls">
        <button id="btn-play-target" class="btn primary">Wort anhören</button>
      </div>

      <div id="shuffle-feedback" class="feedback"></div>
    </div>
  `;

  attachImgFallbacks();

  const feedbackEl = document.getElementById("shuffle-feedback");
  const playTarget = () => speakWord(target.word, 1.0);
  document.getElementById("btn-play-target").onclick = playTarget;
  playTarget();

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = () => {
      const w = btn.getAttribute("data-word") || "";
      if (canonicalFrenchForScoring(w) !== canonicalFrenchForScoring(target.word)) {
        feedbackEl.textContent = "Falsch. Tippe ein anderes Bild.";
        return;
      }
      feedbackEl.textContent = "Richtig!";
      setTimeout(() => {
        currentItemIndex++;
        renderShufflePhase(block);
      }, 650);
    };
  });
}

// ----------------- Phase 3 (Global Quiz) -----------------
function renderGlobalQuizPhase() {
  clearAdvanceTimer();
  stopAllAudioStates();

  if (!quizTargetOrder?.length) quizTargetOrder = shuffleArray([...quizPool]);

  if (quizIndex >= quizTargetOrder.length) {
    currentPhase = "sentences";
    sentenceIndex = 0;
    return render();
  }

  const target = quizTargetOrder[quizIndex];
  const others = quizPool.filter((x) => x.qid !== target.qid);
  const distractors = takeN(shuffleArray(others), 3);
  const pack = shuffleArray([target, ...distractors]);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">Phase 3 – Hör-Quiz</div>
        <div class="badge">Aufgabe ${quizIndex + 1} von ${quizTargetOrder.length}</div>
        <div class="badge">Versuche: ${quizAttemptsLeft}</div>
      </div>

      <h1>Hör-Quiz</h1>
      <p>Höre das Wort und tippe auf das richtige Bild.</p>

      <div class="icon-grid">
        ${pack.map((it) => `
          <button class="icon-card" data-qid="${it.qid}" aria-label="Option">
            <img src="${it.img}" data-fallback="${escapeHtml(it.fallbackImg || "")}" alt="">
          </button>
        `).join("")}
      </div>

      <div class="controls">
        <button id="btn-play-quiz" class="btn primary">Wort abspielen</button>
      </div>

      <div id="quiz-feedback" class="feedback"></div>
    </div>
  `;

  attachImgFallbacks();

  const feedbackEl = document.getElementById("quiz-feedback");
  const playTarget = () => speakWord(target.word, 1.0);
  document.getElementById("btn-play-quiz").onclick = playTarget;
  playTarget();

  const markCorrect = () => {
    appEl.querySelector(`.icon-card[data-qid="${target.qid}"]`)?.classList.add("correct");
  };

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = () => {
      const qid = btn.getAttribute("data-qid");
      if (qid === target.qid) {
        feedbackEl.textContent = "Richtig!";
        markCorrect();
        setTimeout(() => {
          quizAttemptsLeft = 3;
          quizIndex++;
          renderGlobalQuizPhase();
        }, 800);
      } else {
        quizAttemptsLeft--;
        if (quizAttemptsLeft > 0) {
          feedbackEl.textContent = `Falsch. Noch ${quizAttemptsLeft} Versuch(e).`;
        } else {
          feedbackEl.textContent = "Leider falsch. Das richtige Bild ist markiert.";
          markCorrect();
          setTimeout(() => {
            quizAttemptsLeft = 3;
            quizIndex++;
            renderGlobalQuizPhase();
          }, 1000);
        }
      }
    };
  });
}

// ----------------- Phase 4 (Sätze) -----------------
function renderSentencePhase() {
  clearAdvanceTimer();
  stopAllAudioStates();

  if (!sentenceList?.length || sentenceIndex >= sentenceList.length) {
    return renderEndScreen();
  }

  const s = sentenceList[sentenceIndex];

  // Reset Failcounter pro Satz
  currentFailCount = 0;

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Phase 4 – Sätze</div>
        <div class="badge">Satz ${sentenceIndex + 1} von ${sentenceList.length}</div>
      </div>

      <h1>Satz nachsprechen</h1>

      <div class="card card-word" style="text-align:center;">
        <div class="word-text" style="font-size:28px; line-height:1.25;">${escapeHtml(s.text)}</div>
        <div class="word-translation" style="margin-top:10px;">${escapeHtml(s.de || "")}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">Hören</button>
        <button id="btn-hear-slow" class="btn secondary">Langsam</button>
      </div>

      <div class="controls-speak" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button id="btn-speak" class="btn mic">Ich spreche</button>
        <button id="btn-skip" class="btn secondary" disabled>Später noch einmal</button>
        <div id="speak-feedback" class="feedback" style="flex-basis:100%;"></div>
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnSkip = document.getElementById("btn-skip");

  styleSpeakButtons(btnSpeak, btnSkip);

  const localRefresh = () => {
    const rec = micRecording;
    const tts = ttsActive;

    btnHear.disabled = rec || tts;
    btnHearSlow.disabled = rec || tts;

    if (rec || tts) {
      btnSpeak.disabled = true;
      btnSkip.disabled = true;
    } else {
      styleSpeakButtons(btnSpeak, btnSkip);
    }
  };
  setUiRefreshLocks(localRefresh);
  localRefresh();

  btnHear.onclick = () => { if (!micRecording && !ttsActive) speakWord(s.text, 1.0); };
  btnHearSlow.onclick = () => { if (!micRecording && !ttsActive) speakWord(s.text, 0.7); };

  btnSkip.onclick = async () => {
    setSpeakFeedback("Wir kommen später zurück.", null);
    await sleep(650);
    advanceFromSentence();
  };

  btnSpeak.onclick = async () => {
    if (micRecording) return;
    if (currentFailCount >= FAILS_FOR_SKIP) return;

    const clearAutoStop = () => {
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
    };

    const stopAndAssess = async () => {
      if (!micRecording) return;

      clearAutoStop();
      setSpeakFeedback("Verarbeite…", null);

      const recognizedText = await stopBrowserASR();
      const res = scoreSpeech(s.text, recognizedText);

      micRecording = false;
      refreshLocks();

      if (!res.pass100) currentFailCount++;

      if (res.pass100) {
        setSpeakFeedback(
          `Aussprache: ${res.overall}% (${res.grade}) · Erkannt: „${recognizedText || "(leer)"}“ · Perfekt!`,
          true
        );

        clearAdvanceTimer();
        advanceTimer = setTimeout(() => {
          advanceFromSentence();
        }, AUTO_ADVANCE_MS);

        return;
      }

      if (currentFailCount >= FAILS_FOR_SKIP) {
        styleSpeakButtons(btnSpeak, btnSkip);
      }

      setSpeakFeedback(
        `Aussprache: ${res.overall}% (${res.grade})` +
        ` · Erkannt: „${recognizedText || "(leer)"}“` +
        ` · Nochmal (${currentFailCount}/${FAILS_FOR_SKIP})`,
        false
      );
    };

    try {
      stopAllAudioStates();

      if (!speechRecAvailable()) {
        setSpeakFeedback("Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", false);
        return;
      }

      setSpeakFeedback("Sprich jetzt. Aufnahme stoppt automatisch.", null);

      try { window.speechSynthesis.cancel(); } catch {}
      ttsActive = false;
      refreshLocks();
      await sleep(150);

      const started = startBrowserASR("fr-FR");
      if (!started) {
        setSpeakFeedback("Spracherkennung konnte nicht starten. Bitte Seite neu laden.", false);
        return;
      }

      micRecording = true;
      refreshLocks();

      clearAutoStop();
      autoStopTimer = setTimeout(() => {
        stopAndAssess().catch((e) => {
          console.error(e);
          micRecording = false;
          refreshLocks();
          setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
        });
      }, 4500);

    } catch (e) {
      console.error(e);
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
      micRecording = false;
      stopAllAudioStates();
      refreshLocks();
      setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
    }
  };
}

// ----------------- END -----------------
function renderEndScreen() {
  clearAdvanceTimer();
  stopAllAudioStates();
  appEl.innerHTML = `
    <div class="screen screen-end">
      <h1>Tag 1 geschafft</h1>
      <p>Du hast alle Übungen abgeschlossen (Wörter, Quiz, Sätze).</p>
      <button id="btn-repeat" class="btn primary">Tag 1 wiederholen</button>
    </div>
  `;
  document.getElementById("btn-repeat").onclick = () => startLesson();
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
  try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
  autoStopTimer = null;

  if (_sr) {
    try { _sr.stop(); } catch {}
    _sr = null;
  }

  micRecording = false;

  try { window.speechSynthesis?.cancel?.(); } catch {}
  ttsActive = false;

  refreshLocks();
}

// ----------------- UI HELPERS -----------------
function setSpeakFeedback(text, pass) {
  const el = document.getElementById("speak-feedback");
  if (!el) return;

  el.textContent = text || "";

  if (pass === true) {
    el.style.color = "#16a34a";
    el.style.fontWeight = "900";
  } else if (pass === false) {
    el.style.color = "#dc2626";
    el.style.fontWeight = "900";
  } else {
    el.style.color = "";
    el.style.fontWeight = "";
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ----------------- ARRAY HELPERS -----------------
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function takeN(arr, n) {
  return arr.slice(0, Math.max(0, n));
}


