// src/app.js – Vor-A1 / Klassensprache Französisch
// Flow (NEU):
// Block 1: Phase 1 (Lernen + Aussprache) → Phase 2 (Bilder tippen, 4er Pack)
// Block 2: Phase 1 → Phase 2
// Block 3: Phase 1 → Phase 2
// Danach: Phase 3 (Globales Hör-Quiz: 12 Bilder Pool, immer 4er Pack, ohne Beschriftung)
// Danach: Phase 4 (Satz-Übung: Sätze aus gelernten Wörtern, nachsprechen, Score ≥85% zum Weiter)
// Danach: Ende
//
// Bilder liegen unter: assets/images/W1D1/bild1-1.png, bild1-2.png ... bild3-4.png

const TARGET_LANG = "fr";
const LESSON_ID = "W1D1";

const PRONOUNCE_MODE = "browser"; // "browser" | "server" (server bleibt drin, wird nicht genutzt)
const PASS_THRESHOLD = 85;

// Deine echte Struktur:
const IMAGE_DIR = `assets/images/${LESSON_ID}/`; // -> /assets/images/W1D1/...

// Global-Quiz: 3 Übungen * 4 Bilder = 12
const QUIZ_BLOCKS = 3;
const QUIZ_ITEMS_PER_BLOCK = 4;

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
let currentItemIndex = 0;   // Index innerhalb Phase (Learn: Wort-Index, Shuffle: Aufgabe-Index)

// Phase 2: Ziel-Reihenfolge pro Block
let shuffleOrder = []; // array of items (block.items) in random order

// Phase 3: Global Quiz
let quizPool = [];          // 12 Items (blockNo,pos,word,id)
let quizTargetOrder = [];   // shuffled quizPool
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

// --- scoring ---
function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}' -]/gu, " ")
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
    buildGlobalQuizPool();     // 12 Bilder vorbereiten
    buildSentenceListSimple(); // Sätze vorbereiten
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

// ----------------- IMAGE PATHS -----------------
function getBlockImagePath(blockNo1based, pos1based) {
  // assets/images/W1D1/bild1-1.png
  return `${IMAGE_DIR}bild${blockNo1based}-${pos1based}.png`;
}

// Fixe Zuordnung: item an Position -> bild<block>-<pos>.png
function getItemQuizImageSrc(block, blockNo1based, it) {
  const pos0 = block.items.findIndex((x) => x.id === it.id);
  const pos1 = Math.max(1, pos0 + 1);
  return getBlockImagePath(blockNo1based, pos1);
}

// Optionaler Fallback: wenn Bild nicht existiert, nimm lesson-json image
function attachImgFallbacks() {
  appEl.querySelectorAll("img[data-fallback]").forEach((img) => {
    const fb = img.getAttribute("data-fallback");
    img.onerror = () => {
      img.onerror = null;
      if (fb) img.src = fb;
    };
  });
}

// ----------------- GLOBAL QUIZ POOL (12 Bilder) -----------------
function buildGlobalQuizPool() {
  quizPool = [];
  if (!lesson?.blocks?.length) return;

  const maxBlocks = Math.min(QUIZ_BLOCKS, lesson.blocks.length);
  for (let b = 0; b < maxBlocks; b++) {
    const block = lesson.blocks[b];
    const maxItems = Math.min(QUIZ_ITEMS_PER_BLOCK, block.items.length);
    for (let i = 0; i < maxItems; i++) {
      const it = block.items[i];
      const blockNo = b + 1;
      const pos = i + 1;
      quizPool.push({
        // stabiler key:
        qid: `b${blockNo}p${pos}`,
        blockNo,
        pos,
        word: it.word,
        // Bild ist fest:
        img: getBlockImagePath(blockNo, pos),
        // Fallback (falls assets fehlen):
        fallbackImg: it.image || ""
      });
    }
  }

  quizTargetOrder = shuffleArray([...quizPool]);
}

// ----------------- SENTENCES (Phase 4) -----------------
function buildSentenceListSimple() {
  // Einfache Sätze aus den gelernten Wörtern (aus quizPool = 12 Wörter)
  // Ziel: leicht lesbar, nur aus bekannten Wörtern + Konnektor "et".
  const words = (quizPool || []).map(x => x.word).filter(Boolean);
  const uniq = [];
  const seen = new Set();
  for (const w of words) {
    const k = _norm(w);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(w.trim());
  }

  // Mindestens 6–10 Sätze erzeugen
  const out = [];

  // Paar-Sätze: "X et Y."
  for (let i = 0; i < uniq.length - 1; i += 2) {
    const a = uniq[i];
    const b = uniq[i + 1];
    if (!a || !b) continue;
    out.push(`${capFirst(a)} et ${b}.`);
    if (out.length >= 8) break;
  }

  // Wenn zu wenig: zweite Runde mit anderen Paaren
  if (out.length < 8) {
    const shuffled = shuffleArray([...uniq]);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
      out.push(`${capFirst(shuffled[i])} et ${shuffled[i + 1]}.`);
      if (out.length >= 10) break;
    }
  }

  // Notfall
  if (!out.length && uniq.length) out.push(`${capFirst(uniq[0])}.`);

  // Als Liste speichern
  sentenceList = out.map((s, idx) => ({ sid: `s${idx+1}`, text: s }));
}

// ----------------- RENDER SWITCH -----------------
function render() {
  if (!lesson) return;

  if (currentPhase === "learn") {
    renderLearnPhase(lesson.blocks[currentBlockIndex]);
    return;
  }
  if (currentPhase === "shuffle") {
    renderShufflePhase(lesson.blocks[currentBlockIndex]);
    return;
  }
  if (currentPhase === "quiz") {
    renderGlobalQuizPhase();
    return;
  }
  if (currentPhase === "sentences") {
    renderSentencePhase();
    return;
  }
  renderEndScreen();
}

// ----------------- PHASE 1 (Learn + Speak) -----------------
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
      render();
      return;
    }

    // Phase 1 fertig -> Phase 2 (nur für diesen Block)
    currentPhase = "shuffle";
    currentItemIndex = 0;
    shuffleOrder = shuffleArray([...block.items]);
    render();
  };
}

// ----------------- PHASE 2 (Block Shuffle / Tippen, 4er Pack) -----------------
function renderShufflePhase(block) {
  stopAllAudioStates();

  const blockNo = currentBlockIndex + 1;

  if (!shuffleOrder || shuffleOrder.length !== block.items.length) {
    shuffleOrder = shuffleArray([...block.items]);
  }

  if (currentItemIndex >= shuffleOrder.length) {
    // Block-Phase 2 fertig -> nächster Block Phase 1 ODER globales Quiz
    if (currentBlockIndex < Math.min(QUIZ_BLOCKS, lesson.blocks.length) - 1) {
      currentBlockIndex++;
      currentPhase = "learn";
      currentItemIndex = 0;
      shuffleOrder = [];
      render();
      return;
    }

    // Alle 3 Blöcke erledigt -> globales Quiz
    currentPhase = "quiz";
    quizIndex = 0;
    quizAttemptsLeft = 3;
    quizTargetOrder = shuffleArray([...quizPool]);
    render();
    return;
  }

  const targetItem = shuffleOrder[currentItemIndex];
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
        ${gridItems.map((it) => `
          <button class="icon-card" data-id="${it.id}">
            <img
              src="${getItemQuizImageSrc(block, blockNo, it)}"
              data-fallback="${escapeHtml(it.image || "")}"
              alt=""
            >
          </button>
        `).join("")}
      </div>

      <div class="controls">
        <button id="btn-play-target" class="btn primary">🔊 Wort anhören</button>
      </div>

      <div id="shuffle-feedback" class="feedback"></div>
    </div>
  `;

  attachImgFallbacks();

  const feedbackEl = document.getElementById("shuffle-feedback");
  const playTarget = () => speakWord(targetItem.word, 1.0);
  document.getElementById("btn-play-target").onclick = playTarget;
  playTarget();

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-id");
      if (id !== targetItem.id) {
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

// ----------------- PHASE 3 (GLOBAL Hör-Quiz, 12er Pool, immer 4er Pack, no labels) -----------------
function renderGlobalQuizPhase() {
  stopAllAudioStates();

  if (!quizTargetOrder?.length) quizTargetOrder = shuffleArray([...quizPool]);

  if (quizIndex >= quizTargetOrder.length) {
    // Quiz fertig -> Satz-Übung
    currentPhase = "sentences";
    sentenceIndex = 0;
    render();
    return;
  }

  const target = quizTargetOrder[quizIndex];

  // 3 Distraktoren aus den übrigen 11 wählen
  const others = quizPool.filter((x) => x.qid !== target.qid);
  const distractors = takeN(shuffleArray(others), 3);

  // 4er-Pack mischen
  const pack = shuffleArray([target, ...distractors]);

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">Phase 3 – Hör-Quiz (12 Bilder)</div>
        <div class="badge">Aufgabe ${quizIndex + 1} von ${quizTargetOrder.length}</div>
        <div class="badge">Versuche: ${quizAttemptsLeft}</div>
      </div>

      <h1>Hör-Quiz</h1>
      <p>Höre das Wort und tippe auf das richtige Bild.</p>

      <div class="icon-grid">
        ${pack.map((it) => `
          <button class="icon-card" data-qid="${it.qid}">
            <img
              src="${it.img}"
              data-fallback="${escapeHtml(it.fallbackImg || "")}"
              alt=""
            >
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

// ----------------- PHASE 4 (Satz-Übung: nachsprechen, Score ≥85% zum Weiter) -----------------
function renderSentencePhase() {
  stopAllAudioStates();

  if (!sentenceList?.length) {
    currentPhase = "end";
    renderEndScreen();
    return;
  }

  if (sentenceIndex >= sentenceList.length) {
    renderEndScreen();
    return;
  }

  const s = sentenceList[sentenceIndex];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Phase 4 – Sätze nachsprechen</div>
        <div class="badge">Satz ${sentenceIndex + 1} von ${sentenceList.length}</div>
      </div>

      <h1>Satz-Training</h1>

      <div class="card card-word" style="text-align:center;">
        <div class="word-text" style="font-size:28px; line-height:1.25;">${escapeHtml(s.text)}</div>
        <div class="word-translation"></div>
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
      <h1>Tag 1 geschafft 🎉</h1>
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
