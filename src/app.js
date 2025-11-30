"use strict";

// src/app.js – Vor-A1 / Klassensprache Französisch
// Flow: Lernen → Bilder & Tippen → Hör-Quiz
// Aussprache-Check FINAL: Browser -> Netlify Function -> Koyeb (/pronounce) -> Azure
// FIX: Statt MediaRecorder(WebM) -> stabiler WAV PCM16 16k Recorder (kleine Payload, weniger Abbrüche)

const TARGET_LANG = "fr";
const LESSON_ID = "W1D1";

// WICHTIG: Frontend ruft NICHT direkt Koyeb auf, sondern die Netlify Function (same-origin, kein CORS)
const PRONOUNCE_URL_DEFAULT = "/.netlify/functions/pronounce";

const appEl = document.getElementById("app");
const statusLine = document.getElementById("statusLine");
const status = (msg) => {
  if (statusLine) statusLine.textContent = msg || "";
  console.log("[STATUS]", msg);
};

let lesson = null;
let currentBlockIndex = 0;
let currentPhase = "learn"; // 'learn' | 'shuffle' | 'quiz'
let currentItemIndex = 0;

let quizTargetItem = null;
let quizAttemptsLeft = 3;

// TTS-Setup
let ttsSupported = "speechSynthesis" in window;
let ttsVoices = [];
let ttsVoice = null;

// Mic / Pronounce state (WAV16k Recorder)
let micRecording = false;
let wavRec = null;
let autoStopTimer = null;

// Optionaler Health-Check (zeigt sofort, ob die Netlify Function existiert)
let pronounceProxyReady = null;
(async function healthCheckPronounceProxy() {
  try {
    const r = await fetch(PRONOUNCE_URL_DEFAULT, { method: "GET", cache: "no-store" });
    if (!r.ok) {
      pronounceProxyReady = false;
      console.warn("[PRONOUNCE] Proxy not reachable:", r.status);
      return;
    }
    const j = await r.json().catch(() => null);
    pronounceProxyReady = !!(j && j.ok);
    if (pronounceProxyReady) {
      console.log("[PRONOUNCE] Proxy ready.");
    } else {
      console.warn("[PRONOUNCE] Proxy responded, but not ok:", j);
    }
  } catch (e) {
    pronounceProxyReady = false;
    console.warn("[PRONOUNCE] Proxy check failed:", e);
  }
})();

// TTS initialisieren
initTTS();

// Einstieg: Lesson laden
loadLesson(TARGET_LANG, LESSON_ID)
  .then((data) => {
    lesson = data;
    startLesson();
  })
  .catch((err) => {
    console.error(err);
    appEl.textContent = "Fehler beim Laden der Lektion.";
    status(err.message);
  });

// ----------------- Daten laden -----------------

async function loadLesson(lang, lessonId) {
  const res = await fetch(`lessons/${lang}/${lessonId}.json`);
  if (!res.ok) {
    throw new Error(`Konnte Lektion nicht laden: ${res.status}`);
  }
  return await res.json();
}

// ----------------- State-Steuerung -----------------

function startLesson() {
  currentBlockIndex = 0;
  startBlock(0);
}

function startBlock(index) {
  stopMicIfNeeded(); // Sicherheit
  currentBlockIndex = index;
  currentPhase = "learn";
  currentItemIndex = 0;
  quizTargetItem = null;
  quizAttemptsLeft = 3;
  render();
}

function nextPhaseOrBlock() {
  stopMicIfNeeded(); // Sicherheit
  const blocks = lesson.blocks;
  if (currentPhase === "learn") {
    currentPhase = "shuffle";
  } else if (currentPhase === "shuffle") {
    currentPhase = "quiz";
  } else if (currentPhase === "quiz") {
    if (currentBlockIndex < blocks.length - 1) {
      startBlock(currentBlockIndex + 1);
      return;
    } else {
      renderEndScreen();
      return;
    }
  }
  currentItemIndex = 0;
  quizTargetItem = null;
  quizAttemptsLeft = 3;
  render();
}

// ----------------- Rendering -----------------

function render() {
  if (!lesson) return;
  const block = lesson.blocks[currentBlockIndex];

  if (currentPhase === "learn") {
    renderLearnPhase(block);
  } else if (currentPhase === "shuffle") {
    renderShufflePhase(block);
  } else {
    renderQuizPhase(block);
  }
}

// Phase 1: Icon + Wort + Hören + Aussprache prüfen

function renderLearnPhase(block) {
  const item = block.items[currentItemIndex];

  appEl.innerHTML = `
    <div class="screen screen-learn">
      <div class="meta">
        <div class="badge">Tag 1 – ${lesson.title || "Französisch"}</div>
        <div class="badge">Block ${currentBlockIndex + 1} von ${lesson.blocks.length}</div>
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
        <button id="btn-next-word" class="btn secondary" disabled>Weiter</button>
      </div>
    </div>
  `;

  const btnHear = document.getElementById("btn-hear");
  const btnHearSlow = document.getElementById("btn-hear-slow");
  const btnSpeak = document.getElementById("btn-speak");
  const btnNext = document.getElementById("btn-next-word");

  btnHear.onclick = () => speakWord(item.word, 1.0);
  btnHearSlow.onclick = () => speakWord(item.word, 0.7);

  btnSpeak.onclick = async () => {
    const clearAutoStop = () => {
      try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
      autoStopTimer = null;
    };

    const stopAndAssess = async () => {
      if (!micRecording) return;

      clearAutoStop();
      btnSpeak.disabled = true;
      setSpeakFeedback("Verarbeite Audio…");

      const audioDataUrl = await stopMicGetWavDataUrl();

      micRecording = false;
      btnSpeak.textContent = "🎤 Ich spreche";

      // Wenn Proxy definitiv fehlt, sag es sofort klar (ohne Rätselraten)
      if (pronounceProxyReady === false) {
        setSpeakFeedback(
          "Aussprache-Prüfung ist nicht erreichbar (Proxy fehlt / 404). " +
          "Prüfe: /.netlify/functions/pronounce"
        );
        btnNext.disabled = false;
        btnSpeak.disabled = false;
        return;
      }

      const result = await callPronounce({
        targetText: item.word,
        language: "fr-FR",
        audioDataUrl
      });

      const overall = result?.overallScore ?? 0;
      const recText = result?.details?.recognizedText || "";
      const grade = result?.grade || "";

      const pass = overall >= 85;

      setSpeakFeedback(
        `Score: ${overall}/100 (${grade})` +
        (recText ? ` · Erkannt: „${recText}“` : "") +
        (pass ? " ✅" : " ❌")
      );

      btnNext.disabled = false;
      btnSpeak.disabled = false;
    };

    try {
      if (!micRecording) {
        stopMicIfNeeded();
        setSpeakFeedback("Aufnahme läuft… sprich kurz (ca. 2–3 Sekunden). Dann Stop drücken.");
        btnNext.disabled = true;

        await startMicWav16k();
        micRecording = true;
        btnSpeak.textContent = "⏹ Stop";

        clearAutoStop();
        autoStopTimer = setTimeout(() => {
          stopAndAssess().catch((e) => {
            console.error(e);
            setSpeakFeedback("Fehler beim Aufnehmen/Prüfen. Bitte nochmal versuchen.");
          });
        }, 3500);
      } else {
        await stopAndAssess();
      }
    } catch (e) {
      console.error(e);
      clearAutoStop();
      setSpeakFeedback("Fehler beim Aufnehmen/Prüfen. Bitte nochmal versuchen.");
      micRecording = false;
      stopMicIfNeeded();

      const btnSpeakNow = document.getElementById("btn-speak");
      if (btnSpeakNow) {
        btnSpeakNow.disabled = false;
        btnSpeakNow.textContent = "🎤 Ich spreche";
      }
      btnNext.disabled = false;
    } finally {
      const btnSpeakNow = document.getElementById("btn-speak");
      if (btnSpeakNow) btnSpeakNow.disabled = false;
    }
  };

  btnNext.onclick = () => {
    stopMicIfNeeded();
    if (currentItemIndex < block.items.length - 1) {
      currentItemIndex++;
      render();
    } else {
      nextPhaseOrBlock();
    }
  };
}

// Phase 2: Bilder gemischt + richtiges Icon

function renderShufflePhase(block) {
  stopMicIfNeeded();
  const items = shuffleArray([...block.items]);

  appEl.innerHTML = `
    <div class="screen screen-shuffle">
      <div class="meta">
        <div class="badge">Block ${currentBlockIndex + 1} – Phase 2</div>
      </div>
      <h1>Bilder & Wörter</h1>
      <p>Höre das Wort und tippe das richtige Bild.</p>

      <div class="icon-grid">
        ${items
          .map(
            (it) => `
          <button class="icon-card" data-id="${it.id}">
            <img src="${it.image}" alt="${escapeHtml(it.word)}">
          </button>
        `
          )
          .join("")}
      </div>

      <div class="controls">
        <button id="btn-play-target" class="btn primary">🔊 Wort anhören</button>
      </div>

      <div id="shuffle-feedback" class="feedback"></div>
    </div>
  `;

  let targetItem = items[currentItemIndex];
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
      feedbackEl.textContent = "✅ Richtiges Bild! Sprich das Wort laut für dich.";

      setTimeout(() => {
        if (currentItemIndex < block.items.length - 1) {
          currentItemIndex++;
          renderShufflePhase(block);
        } else {
          currentItemIndex = 0;
          nextPhaseOrBlock();
        }
      }, 800);
    };
  });
}

// Phase 3: Hör-Quiz mit 3 Versuchen

function renderQuizPhase(block) {
  stopMicIfNeeded();
  const items = shuffleArray([...block.items]);
  if (!quizTargetItem) {
    quizTargetItem = items[0];
    quizAttemptsLeft = 3;
  }

  appEl.innerHTML = `
    <div class="screen screen-quiz">
      <div class="meta">
        <div class="badge">Block ${currentBlockIndex + 1} – Phase 3</div>
      </div>
      <h1>Hör-Quiz</h1>
      <p>Höre das Wort und tippe auf das richtige Bild.</p>

      <div class="icon-grid">
        ${items
          .map(
            (it) => `
          <button class="icon-card" data-id="${it.id}">
            <img src="${it.image}" alt="${escapeHtml(it.word)}">
          </button>
        `
          )
          .join("")}
      </div>

      <div class="controls">
        <button id="btn-play-quiz" class="btn primary">🔊 Wort abspielen</button>
      </div>

      <div id="quiz-feedback" class="feedback"></div>
    </div>
  `;

  const feedbackEl = document.getElementById("quiz-feedback");
  const playTarget = () => speakWord(quizTargetItem.word, 1.0);
  document.getElementById("btn-play-quiz").onclick = playTarget;
  playTarget();

  appEl.querySelectorAll(".icon-card").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-id");
      if (id === quizTargetItem.id) {
        feedbackEl.textContent = "✅ Richtig!";
        appEl
          .querySelector(`.icon-card[data-id="${quizTargetItem.id}"]`)
          ?.classList.add("correct");

        setTimeout(() => {
          quizTargetItem = null;
          quizAttemptsLeft = 3;

          if (currentItemIndex < block.items.length - 1) {
            currentItemIndex++;
            renderQuizPhase(block);
          } else {
            nextPhaseOrBlock();
          }
        }, 900);
      } else {
        quizAttemptsLeft--;
        if (quizAttemptsLeft > 0) {
          feedbackEl.textContent = `❌ Falsch. Du hast noch ${quizAttemptsLeft} Möglichkeiten.`;
        } else {
          feedbackEl.textContent = "❌ Leider falsch. Das richtige Bild ist markiert.";
          appEl
            .querySelector(`.icon-card[data-id="${quizTargetItem.id}"]`)
            ?.classList.add("correct");
          setTimeout(() => {
            quizTargetItem = null;
            quizAttemptsLeft = 3;
            if (currentItemIndex < block.items.length - 1) {
              currentItemIndex++;
              renderQuizPhase(block);
            } else {
              nextPhaseOrBlock();
            }
          }, 1200);
        }
      }
    };
  });
}

// Endscreen

function renderEndScreen() {
  stopMicIfNeeded();
  appEl.innerHTML = `
    <div class="screen screen-end">
      <h1>Tag 1 geschafft 🎉</h1>
      <p>Du hast alle Wörter zur Klassensprache Französisch bearbeitet.</p>
      <button id="btn-repeat" class="btn primary">Tag 1 wiederholen</button>
    </div>
  `;
  document.getElementById("btn-repeat").onclick = () => startLesson();
}

// ----------------- TTS (Text-to-Speech) -----------------

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
    } else {
      utter.lang = "fr-FR";
    }
    utter.rate = rate;
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.error("TTS error", e);
    status("Fehler bei der Sprachausgabe.");
  }
}

// ----------------- Pronounce / Mic -----------------

async function callPronounce({ targetText, language, audioDataUrl }) {
  const resp = await fetch(PRONOUNCE_URL_DEFAULT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetText,
      language,
      audioBase64: audioDataUrl,
      enableMiscue: true
    }),
    cache: "no-store"
  });

  // Wenn Netlify eine HTML-404-Seite liefert, ist JSON kaputt -> wir geben besseres Debug zurück
  const text = await resp.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const hint =
      resp.status === 404
        ? " (Netlify Function nicht gefunden: stimmt netlify.toml functions-Pfad + Repo-Pfad netlify/functions?)"
        : "";
    throw new Error((json && json.error) || `Pronounce failed (${resp.status})${hint}`);
  }
  return json;
}

// --- WAV16k Recorder: klein, stabil, Azure-tauglich ---

async function startMicWav16k() {
  stopMicIfNeeded();
  wavRec = await startWav16kRecorder();
}

async function stopMicGetWavDataUrl() {
  if (!wavRec) throw new Error("Recorder not started");
  const rec = wavRec;
  wavRec = null;

  const audioDataUrl = await rec.stop();
  if (typeof audioDataUrl !== "string" || audioDataUrl.length < 1000) {
    throw new Error("Audio zu kurz/leer");
  }
  if (!audioDataUrl.startsWith("data:audio/wav;base64,")) {
    throw new Error("Unerwartetes Audio-Format");
  }
  return audioDataUrl;
}

function stopMicIfNeeded() {
  try { if (autoStopTimer) clearTimeout(autoStopTimer); } catch {}
  autoStopTimer = null;

  // stop ohne await (Sicherheit beim Screen-Wechsel)
  if (wavRec && typeof wavRec.stop === "function") {
    try { wavRec.stop(); } catch {}
  }
  wavRec = null;
  micRecording = false;
}

async function startWav16kRecorder() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  try { await ctx.resume?.(); } catch {}

  const sampleRateIn = ctx.sampleRate;
  const source = ctx.createMediaStreamSource(stream);

  // ScriptProcessor ist deprecated, aber in Chrome/Edge/iOS Safari praktisch überall verfügbar.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const zero = ctx.createGain();
  zero.gain.value = 0;

  const chunks = [];
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  source.connect(processor);
  processor.connect(zero);
  zero.connect(ctx.destination);

  let stoppedOnce = false;

  const stop = async () => {
    if (stoppedOnce) return "";
    stoppedOnce = true;

    try { processor.disconnect(); } catch {}
    try { source.disconnect(); } catch {}
    try { zero.disconnect(); } catch {}

    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { await ctx.close(); } catch {}

    const merged = mergeFloat32(chunks);
    const down = downsampleFloat32(merged, sampleRateIn, 16000);
    const wavBlob = encodeWavFromFloat32(down, 16000);
    const dataUrl = await blobToDataURL(wavBlob);
    return dataUrl;
  };

  return { stop };
}

function mergeFloat32(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function downsampleFloat32(input, inRate, outRate) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (outRate === inRate) return input;

  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(newLen);

  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function encodeWavFromFloat32(float32, sampleRate) {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? (s * 0x8000) : (s * 0x7fff);
  }

  const bytesPerSample = 2;
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm16.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++, offset += 2) {
    view.setInt16(offset, pcm16[i], true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ----------------- Hilfsfunktionen -----------------

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setSpeakFeedback(text) {
  const el = document.getElementById("speak-feedback");
  if (el) el.textContent = text;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
