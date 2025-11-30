// src/app.js – Vor-A1 / Klassensprache Französisch
// Flow:
// Block 1: Phase 1 (Lernen + Aussprache) → Phase 2 (Tippen, 4er Pack)
// Block 2: Phase 1 → Phase 2
// Block 3: Phase 1 → Phase 2
// Danach: Phase 3 (Globales Hör-Quiz aus 12 Bildern, 4er Pack, ohne Beschriftung)
// Danach: Phase 4 (Sätze nachsprechen, Score ≥ 85% zum Weiter)
// Danach: Ende
//
// BILD-ZUORDNUNG (EXAKT nach User-Vorgabe):
// bild1-1.png = Ecouter
// bild1-2.png = Repeter
// bild1-3.png = Lire
// bild1-4.png = Ecrire
// bild2-1.png = Voir
// bild2-2.png = Ouvrir
// bild2-3.png = Fermer
// bild2-4.png = Trouver
// bild3-1.png = Livre
// bild3-2.png = Page
// bild3-3.png = Numero
// bild4-4.png = Tache

const TARGET_LANG = "fr";
const LESSON_ID = "W1D1";

// Wir laufen erstmal lokal stabil (Browser-Spracherkennung)
const PRONOUNCE_MODE = "browser"; // "browser" | "server"

const PASS_THRESHOLD = 85;

// Exakter Basis-Pfad, wie du es beschrieben hast:
const IMAGE_DIR = `/assets/images/${LESSON_ID}/`; // => /assets/images/W1D1/

const appEl = document.getElementById("app");
const statusLine = document.getElementById("statusLine");
const status = (msg) => {
  if (statusLine) statusLine.textContent = msg || "";
  console.log("[STATUS]", msg);
};

let lesson = null;

// Block-Flow
let currentBlockIndex = 0; // 0-based
let currentPhase = "learn"; // "learn" | "shuffle" | "quiz" | "sentences"
let currentItemIndex = 0;

// Phase 2: Ziel-Reihenfolge pro Block
let shuffleOrder = [];

// Phase 3: Global Quiz
let quizPool = [];        // 12 Items
let quizTargetOrder = []; // gemischte Reihenfolge der Ziele
let quizIndex = 0;
let quizAttemptsLeft = 3;

// Phase 4: Sätze
let sentenceList = [];
let sentenceIndex = 0;

// TTS
let ttsSupported = "speechSynthesis" in window;
let ttsVoices = [];
let ttsVoice = null;

// ASR state
let micRecording = false;
let autoStopTimer = null;

// ----------------- WORD → IMAGE (HARDCODED) -----------------

function wordKeyForMap(word) {
  // robust: lower + diacritics entfernen (écouter == ecouter)
  const s = String(word || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9 -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

const WORD_TO_IMAGE_FILE = {
  "ecouter": "bild1-1.png",
  "repeter": "bild1-2.png",
  "lire":    "bild1-3.png",
  "ecrire":  "bild1-4.png",

  "voir":    "bild2-1.png",
  "ouvrir":  "bild2-2.png",
  "fermer":  "bild2-3.png",
  "trouver": "bild2-4.png",

  "livre":   "bild3-1.png",
  "page":    "bild3-2.png",
  "numero":  "bild3-3.png",

  "tache":   "bild4-4.png"
};

function imageSrcForWord(word) {
  const k = wordKeyForMap(word);
  const file = WORD_TO_IMAGE_FILE[k];
  return file ? (IMAGE_DIR + file) : "";
}

// Fallback: falls deine PNG nicht gefunden wird, nimm lesson-json image
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
let _srResolve = null;

function speechRecAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function startBrowserASR(lang = "fr-FR") {
  if (!speechRecAvailable()) return false;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  _srFinal = "";
  _sr = new SR();
  _sr.lang = lang;
  _sr.interimResults = true;
  _sr.continuous = true;
  _sr.maxAlternatives = 1;

  _sr.onresult = (e) => {
    let add = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = (r && r[0] && r[0].transcript) ? r[0].transcript : "";
      if (r.isFinal) add += " " + t;
    }
    if (add.trim()) _srFinal = (_srFinal + " " + add).trim();
  };

  _sr.onerror = (e) => console.warn("[ASR] error:", e?.error || e);

  _sr.onend = () => {
    try {
      if (_srResolve) {
        const out = (_srFinal || "").trim();
        _srResolve(out);
        _srResolve = null;
      }
    } finally {
      _sr = null;
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
    if (!_sr) return resolve((_srFinal || "").trim());
    _srResolve = resolve;
    try { _sr.stop(); } catch { resolve((_srFinal || "").trim()); }
  });
}

// --- Scoring ---
function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function _similarityScore(target, heard) {
  const A = _norm(target), B = _norm(heard);
  if (!A || !B) return 0;
  const dist = _levenshtein(A, B);
  const maxLen = Math.max(A.length, B.length) || 1;
  const sim = 1 - dist / maxLen;
  return Math.max(0, Math.min(1, sim));
}

function _grade(score) {
  return score >= 90 ? "excellent" :
         score >= 75 ? "good" :
         score >= 60 ? "ok" : "try_again";
}

// ----------------- INIT -----------------
initTTS();

loadLesson(TARGET_LANG, LESSON_ID)
  .then((data) => {
    lesson = data;
    buildQuizPoolFromLesson();   // 12 Wörter aus der Lektion + Bildmapping
    buildSentenceListSimple();   // Sätze aus den Wörtern
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
  currentBlockIndex = 0;
  currentPhase = "learn";
  currentItemIndex = 0;
  shuffleOrder = [];
  quizIndex = 0;
  quizAttemptsLeft = 3;
  sentenceIndex = 0;
  render();
}

// ----------------- QUIZ POOL (12) -----------------
function buildQuizPoolFromLesson() {
  quizPool = [];
  if (!lesson?.blocks?.length) return;

  // Wir nehmen einfach ALLE Items, die wir in den ersten Blöcken finden,
  // aber maximal 12 (so wie du 12 Bilder hast).
  for (let b = 0; b < lesson.blocks.length; b++) {
    const block = lesson.blocks[b];
    for (let i = 0; i < (block.items || []).length; i++) {
      const it = block.items[i];
      const w = String(it.word || "").trim();
      if (!w) continue;

      // Bild kommt EXAKT aus Mapping. Falls kein Mapping existiert, fallback auf it.image.
      const mapped = imageSrcForWord(w);
      const img = mapped || (it.image || "");

      quizPool.push({
        qid: `b${b + 1}i${i + 1}:${wordKeyForMap(w)}`,
        word: w,
        img,
        fallbackImg: it.image || ""
      });

      if (quizPool.length >= 12) break;
    }
    if (quizPool.length >= 12) break;
  }

  // Falls Lesson weniger als 12 hatte: zusätzlich aus Mapping auffüllen (stabil)
  if (quizPool.length < 12) {
    const existing = new Set(quizPool.map(x => wordKeyForMap(x.word)));
    for (const [k, file] of Object.entries(WORD_TO_IMAGE_FILE)) {
      if (existing.has(k)) continue;
      quizPool.push({
        qid: `map:${k}`,
        word: k, // wird nicht angezeigt, nur gesprochen -> wir ersetzen beim Sprechen später
        img: IMAGE_DIR + file,
        fallbackImg: ""
      });
      if (quizPool.length >= 12) break;
    }
  }

  quizTargetOrder = shuffleArray([...quizPool]);
}

// ----------------- SENTENCES (Phase 4) -----------------
function buildSentenceListSimple() {
  // Basis: die Wörter aus quizPool (max 12)
  const words = (quizPool || []).map(x => x.word).filter(Boolean).map(String);

  const uniq = [];
  const seen = new Set();
  for (const w of words) {
    const k = wordKeyForMap(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    // Wenn wir aus Mapping aufgefüllt haben, kann word "ecouter" statt "écouter" sein.
    // Dann nutzen wir eine schöne Display-Form:
    uniq.push(prettyFrenchWord(w));
  }

  // Einfache Sätze (kurz, klar)
  // Wir bauen sie so, dass bekannte Wörter vorkommen.
  // (Wenn ein Wort fehlt, ist es trotzdem ok — dann bleibt der Satz kurz.)
  const has = (kw) => seen.has(kw);

  const s = [];

  if (has("ecouter") && has("repeter")) s.push("Écoute et répète.");
  if (has("ouvrir") && has("livre")) s.push("Ouvre le livre.");
  if (has("fermer") && has("livre")) s.push("Ferme le livre.");
  if (has("lire") && has("page")) s.push("Lis la page.");
  if (has("ecrire") && has("numero")) s.push("Écris le numéro.");
  if (has("trouver") && has("tache")) s.push("Trouve la tâche.");
  if (has("voir") && has("page")) s.push("Vois la page.");

  // Fallback: wenn wenig zusammenkommt, nutze Paar-Sätze mit "et"
  if (s.length < 8) {
    const pool = uniq.filter(Boolean);
    const shuffled = shuffleArray([...pool]);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
      const a = capFirst(shuffled[i]);
      const b = shuffled[i + 1];
      if (!a || !b) continue;
      s.push(`${a} et ${b}.`);
      if (s.length >= 10) break;
    }
  }

  if (!s.length && uniq.length) s.push(`${capFirst(uniq[0])}.`);

  sentenceList = s.map((text, idx) => ({ sid: `s${idx + 1}`, text }));
}

function prettyFrenchWord(w) {
  // Nur für Anzeige/Sätze; die Bewertung nutzt trotzdem den echten Satztext.
  const k = wordKeyForMap(w);
  const m = {
    ecouter: "écouter",
    repeter: "répéter",
    ecrire: "écrire",
    numero: "numéro",
    tache: "tâche"
  };
  return m[k] || w;
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

// ----------------- Phase 1 (Learn + Speak) -----------------
function renderLearnPhase(block) {
  const item = block.items[currentItemIndex];
  const blockNo = currentBlockIndex + 1;

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
        <button id="btn-hear" class="btn primary">🔊 Hören</button>
        <button id="btn-hear-slow" class="btn secondary">🐢 Langsam</button>
      </div>

      <div class="controls-speak">
        <button id="btn-speak" class="btn mic">${micRecording ? "⏹ Stop" : "🎤 Ich spreche"}</button>
        <div id="speak-feedback" class="feedback"></div>
      </div>

      <div class="controls-nav">
        <button id="btn-next" class="btn secondary" disabled>Weiter</button>
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnNext = document.getElementById("btn-next");

  btnHear.onclick = () => speakWord(item.word, 1.0);
  btnHearSlow.onclick = () => speakWord(item.word, 0.7);

  btnNext.disabled = true;

  btnSpeak.onclick = async () => {
    const clearAutoStop = () => {
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
    };

    const stopAndAssess = async () => {
      if (!micRecording) return;

      clearAutoStop();
      btnSpeak.disabled = true;
      setSpeakFeedback("Verarbeite…", null);

      const recognizedText = await stopBrowserASR();
      const exact = _norm(item.word) && (_norm(item.word) === _norm(recognizedText));
      const sim = exact ? 1 : _similarityScore(item.word, recognizedText);
      const overallScore = Math.round(sim * 100);

      micRecording = false;
      btnSpeak.textContent = "🎤 Ich spreche";

      const grade = _grade(overallScore);
      const pass = overallScore >= PASS_THRESHOLD;

      btnNext.disabled = !pass;

      setSpeakFeedback(
        `Aussprache: ${overallScore}% (${grade})` +
        (recognizedText ? ` · Erkannt: „${recognizedText}“` : " · Erkannt: (leer)") +
        (pass ? " ✅ Weiter" : ` ❌ Nochmal (ab ${PASS_THRESHOLD}%)`),
        pass
      );

      btnSpeak.disabled = false;
    };

    try {
      if (!micRecording) {
        stopAllAudioStates();

        if (!speechRecAvailable()) {
          setSpeakFeedback("Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", false);
          return;
        }

        setSpeakFeedback("Sprich jetzt 2–3 Sekunden. Dann Stop drücken.", null);

        const started = startBrowserASR("fr-FR");
        if (!started) {
          setSpeakFeedback("Spracherkennung konnte nicht starten. Bitte Seite neu laden.", false);
          return;
        }

        micRecording = true;
        btnSpeak.textContent = "⏹ Stop";

        clearAutoStop();
        autoStopTimer = setTimeout(() => {
          stopAndAssess().catch((e) => {
            console.error(e);
            setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
          });
        }, 3500);
      } else {
        await stopAndAssess();
      }
    } catch (e) {
      console.error(e);
      clearAutoStop();
      setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
      micRecording = false;
      stopAllAudioStates();
      btnSpeak.disabled = false;
      btnSpeak.textContent = "🎤 Ich spreche";
    } finally {
      btnSpeak.disabled = false;
    }
  };

  btnNext.onclick = () => {
    stopAllAudioStates();

    if (currentItemIndex < block.items.length - 1) {
      currentItemIndex++;
      return render();
    }

    // Phase 1 fertig -> Phase 2
    currentPhase = "shuffle";
    currentItemIndex = 0;
    shuffleOrder = shuffleArray([...block.items]);
    render();
  };
}

// ----------------- Phase 2 (Tippen 4er Pack, BILDER EXAKT nach Wort) -----------------
function renderShufflePhase(block) {
  stopAllAudioStates();

  const blockNo = currentBlockIndex + 1;

  if (!shuffleOrder || shuffleOrder.length !== block.items.length) {
    shuffleOrder = shuffleArray([...block.items]);
  }

  if (currentItemIndex >= shuffleOrder.length) {
    // Block-Phase2 fertig -> nächster Block oder globales Quiz
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
          const src = imageSrcForWord(it.word) || (it.image || "");
          const fb = it.image || "";
          return `
            <button class="icon-card" data-word="${escapeHtml(it.word)}" aria-label="Option">
              <img src="${src}" data-fallback="${escapeHtml(fb)}" alt="">
            </button>
          `;
        }).join("")}
      </div>

      <div class="controls">
        <button id="btn-play-target" class="btn primary">🔊 Wort anhören</button>
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
      if (_norm(w) !== _norm(target.word)) {
        feedbackEl.textContent = "❌ Falsch. Tippe ein anderes Bild.";
        return;
      }
      feedbackEl.textContent = "✅ Richtig!";
      setTimeout(() => {
        currentItemIndex++;
        renderShufflePhase(block);
      }, 650);
    };
  });
}

// ----------------- Phase 3 (Global Hör-Quiz, 12 Bilder, 4er Pack, ohne Beschriftung) -----------------
function renderGlobalQuizPhase() {
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
        <button id="btn-play-quiz" class="btn primary">🔊 Wort abspielen</button>
      </div>

      <div id="quiz-feedback" class="feedback"></div>
    </div>
  `;

  attachImgFallbacks();

  const feedbackEl = document.getElementById("quiz-feedback");
  const playTarget = () => speakWord(prettyFrenchWord(target.word), 1.0);
  document.getElementById("btn-play-quiz").onclick = playTarget;
  playTarget();

  const markCorrect = () => {
    appEl.querySelector(`.icon-card[data-qid="${target.qid}"]`)?.classList.add("correct");
  };

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = () => {
      const qid = btn.getAttribute("data-qid");
      if (qid === target.qid) {
        feedbackEl.textContent = "✅ Richtig!";
        markCorrect();
        setTimeout(() => {
          quizAttemptsLeft = 3;
          quizIndex++;
          renderGlobalQuizPhase();
        }, 800);
      } else {
        quizAttemptsLeft--;
        if (quizAttemptsLeft > 0) {
          feedbackEl.textContent = `❌ Falsch. Noch ${quizAttemptsLeft} Versuch(e).`;
        } else {
          feedbackEl.textContent = "❌ Leider falsch. Das richtige Bild ist markiert.";
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

// ----------------- Phase 4 (Sätze nachsprechen, Score ≥ 85%) -----------------
function renderSentencePhase() {
  stopAllAudioStates();

  if (!sentenceList?.length || sentenceIndex >= sentenceList.length) {
    return renderEndScreen();
  }

  const s = sentenceList[sentenceIndex];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Phase 4 – Sätze</div>
        <div class="badge">Satz ${sentenceIndex + 1} von ${sentenceList.length}</div>
      </div>

      <h1>Satz nachsprechen</h1>

      <div class="card card-word" style="text-align:center;">
        <div class="word-text" style="font-size:28px; line-height:1.25;">${escapeHtml(s.text)}</div>
      </div>

      <div class="controls-audio">
        <button id="btn-hear" class="btn primary">🔊 Hören</button>
        <button id="btn-hear-slow" class="btn secondary">🐢 Langsam</button>
      </div>

      <div class="controls-speak">
        <button id="btn-speak" class="btn mic">${micRecording ? "⏹ Stop" : "🎤 Ich spreche"}</button>
        <div id="speak-feedback" class="feedback"></div>
      </div>

      <div class="controls-nav">
        <button id="btn-next" class="btn secondary" disabled>Weiter</button>
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnNext = document.getElementById("btn-next");

  btnHear.onclick = () => speakWord(s.text, 1.0);
  btnHearSlow.onclick = () => speakWord(s.text, 0.7);

  btnNext.disabled = true;

  btnSpeak.onclick = async () => {
    const clearAutoStop = () => {
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
    };

    const stopAndAssess = async () => {
      if (!micRecording) return;

      clearAutoStop();
      btnSpeak.disabled = true;
      setSpeakFeedback("Verarbeite…", null);

      const recognizedText = await stopBrowserASR();
      const exact = _norm(s.text) && (_norm(s.text) === _norm(recognizedText));
      const sim = exact ? 1 : _similarityScore(s.text, recognizedText);
      const overallScore = Math.round(sim * 100);

      micRecording = false;
      btnSpeak.textContent = "🎤 Ich spreche";

      const grade = _grade(overallScore);
      const pass = overallScore >= PASS_THRESHOLD;

      btnNext.disabled = !pass;

      setSpeakFeedback(
        `Aussprache: ${overallScore}% (${grade})` +
        (recognizedText ? ` · Erkannt: „${recognizedText}“` : " · Erkannt: (leer)") +
        (pass ? " ✅ Weiter" : ` ❌ Nochmal (ab ${PASS_THRESHOLD}%)`),
        pass
      );

      btnSpeak.disabled = false;
    };

    try {
      if (!micRecording) {
        stopAllAudioStates();

        if (!speechRecAvailable()) {
          setSpeakFeedback("Spracherkennung nicht verfügbar. Bitte Chrome/Edge nutzen.", false);
          return;
        }

        setSpeakFeedback("Sprich jetzt 2–4 Sekunden. Dann Stop drücken.", null);

        const started = startBrowserASR("fr-FR");
        if (!started) {
          setSpeakFeedback("Spracherkennung konnte nicht starten. Bitte Seite neu laden.", false);
          return;
        }

        micRecording = true;
        btnSpeak.textContent = "⏹ Stop";

        clearAutoStop();
        autoStopTimer = setTimeout(() => {
          stopAndAssess().catch((e) => {
            console.error(e);
            setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
          });
        }, 4500);
      } else {
        await stopAndAssess();
      }
    } catch (e) {
      console.error(e);
      clearAutoStop();
      setSpeakFeedback("Fehler beim Prüfen. Bitte nochmal versuchen.", false);
      micRecording = false;
      stopAllAudioStates();
      btnSpeak.disabled = false;
      btnSpeak.textContent = "🎤 Ich spreche";
    } finally {
      btnSpeak.disabled = false;
    }
  };

  btnNext.onclick = () => {
    stopAllAudioStates();
    sentenceIndex++;
    renderSentencePhase();
  };
}

// ----------------- END -----------------
function renderEndScreen() {
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
    status("⚠️ Sprachausgabe wird von diesem Browser nicht unterstützt.");
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
  if (!ttsSupported) {
    status("Keine Sprachausgabe verfügbar.");
    return;
  }
  if (!text) return;

  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    if (ttsVoice) {
      utter.voice = ttsVoice;
      utter.lang = ttsVoice.lang;
    } else utter.lang = "fr-FR";
    utter.rate = rate;
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.error("TTS error", e);
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
}

// ----------------- UI HELPERS -----------------
function setSpeakFeedback(text, pass) {
  const el = document.getElementById("speak-feedback");
  if (!el) return;

  el.textContent = text || "";

  if (pass === true) {
    el.style.color = "#16a34a";
    el.style.fontWeight = "800";
  } else if (pass === false) {
    el.style.color = "#dc2626";
    el.style.fontWeight = "800";
  } else {
    el.style.color = "";
    el.style.fontWeight = "";
  }
}

function capFirst(s) {
  s = String(s || "").trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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

