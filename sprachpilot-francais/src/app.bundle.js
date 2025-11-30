/* src/app.bundle.js — single-file app for Netlify Drop (no imports) */
(() => {
  const APP_VERSION = "2025-11-28-strict-pron-v2";

  // Slow settings (audible when supported)
  const SLOW_AUDIO_RATE = 0.45; // HTMLAudioElement playbackRate
  const SLOW_TTS_RATE = 0.30;   // SpeechSynthesisUtterance.rate (stronger than 0.35)

  // Strictness presets
  const STRICTNESS = {
    normal: {
      name: "Normal",
      correct_confidence: 0.70,
      ambiguous_gap: 0.07,
      min_ms_base: 260,
      min_ms_per_char: 30,
      require_double_confirm: false,
    },
    strict: {
      name: "Strict",
      correct_confidence: 0.82,
      ambiguous_gap: 0.12,
      min_ms_base: 340,
      min_ms_per_char: 55,
      require_double_confirm: false,
    },
    ultra: {
      name: "Ultra-Strict",
      correct_confidence: 0.86,
      ambiguous_gap: 0.14,
      min_ms_base: 380,
      min_ms_per_char: 65,
      require_double_confirm: true, // ✅ only after 2 consecutive correct
    },
  };

  let strictMode = "strict";

  const $ = (sel, root = document) => {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`Missing element in DOM: ${sel}`);
    return el;
  };

  const escapeHtml = (v) => {
    const s = String(v ?? "");
    return s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&": return "&amp;";
        case "<": return "&lt;";
        case ">": return "&gt;";
        case '"': return "&quot;";
        case "'": return "&#39;";
        default: return c;
      }
    });
  };

  /* ---------------- SRS ---------------- */
  class SRS {
    constructor(storageKey) {
      this.key = storageKey;
      this.state = { mastery: {}, wrongAct: [], wrongRepeat: [] };
      this.load();
    }
    load() {
      try {
        const raw = localStorage.getItem(this.key);
        if (raw) this.state = JSON.parse(raw);
      } catch {}
    }
    save() { localStorage.setItem(this.key, JSON.stringify(this.state)); }
    reset() { this.state = { mastery: {}, wrongAct: [], wrongRepeat: [] }; this.save(); }
    masteryKey(kind, id) { return `${kind}:${id}`; }
    bumpMastery(kind, id, ok) {
      const k = this.masteryKey(kind, id);
      const cur = this.state.mastery[k] ?? 0;
      this.state.mastery[k] = ok ? Math.min(3, cur + 1) : 0;
      this.save();
    }
    addWrongAct(itemId) {
      this.state.wrongAct = [...new Set([...(this.state.wrongAct || []), itemId])];
      this.save();
    }
    addWrongRepeat(refKey) {
      this.state.wrongRepeat = [...new Set([...(this.state.wrongRepeat || []), refKey])];
      this.save();
    }
    clearWrongAct(itemId) {
      this.state.wrongAct = (this.state.wrongAct || []).filter((x) => x !== itemId);
      this.save();
    }
    clearWrongRepeat(refKey) {
      this.state.wrongRepeat = (this.state.wrongRepeat || []).filter((x) => x !== refKey);
      this.save();
    }
    getWeakTop(n = 3) {
      const entries = Object.entries(this.state.mastery || {});
      entries.sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0));
      return entries.slice(0, n);
    }
  }

  /* ---------------- Audio ---------------- */
  class AudioPlayer {
    constructor(statusFn = () => {}) {
      this.status = statusFn;
      this.audio = new Audio();
      this.audio.preload = "auto";
      this._playId = 0;
    }

    buildPath(lesson, ref, slow) {
      const map = lesson?.audio_map;
      if (!map || map.type !== "path_template") {
        throw new Error("lesson.audio_map missing or unsupported");
      }
      const tpl =
        ref.type === "word"
          ? (slow ? map.word_slow : map.word_normal)
          : (slow ? map.sentence_slow : map.sentence_normal);

      if (!tpl) throw new Error(`audio_map template missing for ${ref.type} slow=${slow}`);

      return tpl
        .replaceAll("{lesson_id}", String(lesson.lesson_id))
        .replaceAll("{id}", String(ref.id));
    }

    _applyRate(rate) {
      try { this.audio.defaultPlaybackRate = rate; } catch {}
      try { this.audio.playbackRate = rate; } catch {}
      try { this.audio.preservesPitch = false; } catch {}
      try { this.audio.mozPreservesPitch = false; } catch {}
      try { this.audio.webkitPreservesPitch = false; } catch {}
    }

    async playRef(lesson, ref, slow = false) {
      const url = this.buildPath(lesson, ref, slow);
      const myId = ++this._playId;
      const rate = slow ? SLOW_AUDIO_RATE : 1.0;

      try { this.audio.pause(); } catch {}
      try { this.audio.currentTime = 0; } catch {}

      this.audio.src = url;
      this._applyRate(rate);

      const onMeta = () => this._applyRate(rate);
      this.audio.addEventListener("loadedmetadata", onMeta, { once: true });

      setTimeout(() => { if (this._playId === myId) this._applyRate(rate); }, 40);
      setTimeout(() => { if (this._playId === myId) this._applyRate(rate); }, 140);

      this.status(`Audio ▶ ${ref.type}:${ref.id} slow=${slow ? "1" : "0"} rate=${rate} · ${APP_VERSION}`);

      try { this.audio.load(); } catch {}

      try {
        await this.audio.play();
        this._applyRate(rate);
      } catch {
        throw new Error(`Audio failed: ${url}`);
      }

      await new Promise((resolve, reject) => {
        const cleanup = (done) => {
          this.audio.removeEventListener("ended", onEnd);
          this.audio.removeEventListener("error", onErr);
          this.audio.removeEventListener("pause", onPause);
          done();
        };

        const onEnd = () => cleanup(resolve);
        const onErr = () => cleanup(() => reject(new Error(`Audio failed: ${url}`)));
        const onPause = () => cleanup(resolve);

        this.audio.addEventListener("ended", onEnd);
        this.audio.addEventListener("error", onErr);
        this.audio.addEventListener("pause", onPause);
      });
    }

    stop() {
      this._playId++;
      try { this.audio.pause(); } catch {}
      try { this.audio.currentTime = 0; } catch {}
      this._applyRate(1.0);
    }
  }

  /* ---------------- SpeechRecognition ---------------- */
  class SpeechCoach {
    constructor({ locale = "de-DE", statusFn = () => {} } = {}) {
      this.locale = locale;
      this.status = statusFn;
    }
    _ctor() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
    isSupported() { return !!this._ctor(); }

    recognizeOnce({ timeoutMs = 11000 } = {}) {
      const Ctor = this._ctor();
      if (!Ctor) throw new Error("SpeechRecognition not supported");

      const rec = new Ctor();
      rec.lang = this.locale;
      rec.interimResults = false;
      rec.maxAlternatives = 5;

      const tStart = performance.now();

      return new Promise((resolve, reject) => {
        let done = false;

        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { rec.abort(); } catch {}
          reject(new Error("Speech timeout (no input)"));
        }, timeoutMs);

        rec.onresult = (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);

          const ms = Math.max(0, Math.round(performance.now() - tStart));
          const altList = [];
          const res0 = e.results?.[0];

          if (res0 && res0.length) {
            for (let i = 0; i < res0.length; i++) {
              const a = res0[i];
              const text = (a?.transcript || "").trim();
              const confidence = typeof a?.confidence === "number" ? a.confidence : null;
              if (text) altList.push({ text, confidence });
            }
          }

          const best = altList[0]?.text || "";
          const bestConf = altList[0]?.confidence ?? null;

          resolve({ text: best, confidence: bestConf, alternatives: altList, ms });
        };

        rec.onerror = (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(new Error(`Speech error: ${e.error || "unknown"}`));
        };

        try {
          this.status("Listening… speak now.");
          rec.start();
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    }
  }

  // IMPORTANT: strict normalization: keep umlauts/diacritics (no ä->ae etc)
  function normStrict(s) {
    return String(s ?? "")
      .toLowerCase()
      .trim()
      .replace(/[.,!?;:()"'„“”‘’]/g, "")
      .replace(/\s+/g, " ");
  }

  function similarity(a, b) {
    if (!a && !b) return 1;
    const dist = levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length) || 1;
    return 1 - dist / maxLen;
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
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

  function minSpeakMsForTarget(targetText, preset) {
    const t = normStrict(targetText);
    const n = t.length;
    return Math.min(1800, preset.min_ms_base + n * preset.min_ms_per_char);
  }

  function isAmbiguous(alts, gap) {
    if (!alts || alts.length < 2) return false;
    const c0 = typeof alts[0]?.confidence === "number" ? alts[0].confidence : null;
    const c1 = typeof alts[1]?.confidence === "number" ? alts[1].confidence : null;
    if (c0 == null || c1 == null) return false;
    return (c0 - c1) < gap;
  }

  /* ---------------- UI helpers ---------------- */
  const setPanelTitle = (text) => { $("#panelTitle").textContent = text || ""; };
  const setPanelActions = (html) => { $("#panelActions").innerHTML = html || ""; };
  const setPanelBody = (html) => { $("#panelBody").innerHTML = html || ""; };

  function renderLessonMeta(lesson) {
    const el = $("#lessonMeta");
    if (!lesson) {
      el.innerHTML = `<div class="meta">No lesson loaded.</div>`;
      return;
    }
    const titleEn = lesson?.title?.en || lesson?.title_en || "";
    const titleDe = lesson?.title?.de || lesson?.title_de || "";
    el.innerHTML = `
      <div class="meta">
        <div><b>ID</b>: ${escapeHtml(lesson.lesson_id)}</div>
        <div><b>Title</b>: ${escapeHtml(titleEn)}</div>
        <div class="tiny muted">${escapeHtml(titleDe)}</div>
        <div style="margin-top:8px;"><b>Goal</b>: understand teacher instructions by sound.</div>
      </div>
    `;
  }

  function renderBook(lesson, { hidden } = {}) {
    const el = $("#bookBody");
    if (hidden) {
      el.innerHTML = `<div class="meta">Hidden.</div>`;
      return;
    }
    if (!lesson?.book_page) {
      el.innerHTML = `<div class="meta">No book content in this lesson.</div>`;
      return;
    }
    const words = lesson.book_page.words_table || [];
    const sents = lesson.book_page.teacher_sentences_table || [];
    el.innerHTML = `
      <div class="meta" style="margin-bottom:10px;">
        ${escapeHtml(lesson.book_page.rule_en || "")}
      </div>

      <div class="row">
        <div class="grow">
          <div class="k">Words (DE | EN)</div>
          <div class="m">Read only after LISTEN.</div>
        </div>
        <span class="badge good">${escapeHtml(words.length)} items</span>
      </div>

      <table class="table">
        <thead><tr><th style="width:70px;">ID</th><th>Deutsch</th><th>English</th></tr></thead>
        <tbody>
          ${words.map(w => `
            <tr>
              <td><span class="chip">${escapeHtml(w.id)}</span></td>
              <td>${escapeHtml(w.de || "")}</td>
              <td class="muted">${escapeHtml(w.en || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>

      <div style="height:14px;"></div>

      <div class="row">
        <div class="grow">
          <div class="k">Teacher sentences (DE | EN)</div>
          <div class="m">These are the phrases you will hear in class.</div>
        </div>
        <span class="badge good">${escapeHtml(sents.length)} items</span>
      </div>

      <table class="table">
        <thead><tr><th style="width:70px;">ID</th><th>Deutsch</th><th>English</th></tr></thead>
        <tbody>
          ${sents.map(s => `
            <tr>
              <td><span class="chip">${escapeHtml(s.id)}</span></td>
              <td>${escapeHtml(s.de || "")}</td>
              <td class="muted">${escapeHtml(s.en || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  /* ---------------- Data loading ---------------- */
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Fetch failed: ${url} (HTTP ${res.status})`);
    return await res.json();
  }

  function getTrack(manifest, trackId) {
    const track = (manifest?.tracks || []).find((t) => t.id === trackId);
    if (!track) throw new Error(`Track not found: ${trackId}`);
    return track;
  }

  function joinPath(base, file) {
    const b = String(base || "");
    const f = String(file || "");
    if (!b) return f;
    if (b.endsWith("/")) return b + f;
    return b + "/" + f;
  }

  function buildLessonOptions(manifest, trackId) {
    const track = getTrack(manifest, trackId);
    return (track.lessons || []).map((l) => ({
      value: `${trackId}|${l.file}`,
      label: `Day ${l.global_day} · ${l.lesson_id} — ${l.title_en || l.title_de || l.file}`,
    }));
  }

  /* ---------------- Status / state ---------------- */
  const statusLine = document.getElementById("statusLine");
  const status = (msg) => { if (statusLine) statusLine.textContent = msg; };

  const player = new AudioPlayer(status);
  const coach = new SpeechCoach({ locale: "de-DE", statusFn: status });

  let manifest = null;
  let lessonOptions = [];
  let lesson = null;
  let srs = null;
  let activeTab = "listen";
  let bookHidden = false;

  // Repeat confirmation memory (for Ultra)
  const repeatConfirm = new Map(); // key -> count

  /* ---------------- TTS voice handling (Anna) ---------------- */
  const TTS_KEY = "tts:voiceURI";
  let ttsVoiceURI = "";
  let ttsVoiceObj = null;

  function ttsSupported() {
    return "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
  }

  function getDeVoices() {
    if (!ttsSupported()) return [];
    const all = window.speechSynthesis.getVoices?.() || [];
    const de = all.filter((v) => String(v.lang || "").toLowerCase().startsWith("de"));
    de.sort((a, b) => {
      const ade = String(a.lang || "").toLowerCase().startsWith("de-de") ? 0 : 1;
      const bde = String(b.lang || "").toLowerCase().startsWith("de-de") ? 0 : 1;
      if (ade !== bde) return ade - bde;

      const ap = /google|microsoft|edge|apple/i.test(a.name || "") ? 0 : 1;
      const bp = /google|microsoft|edge|apple/i.test(b.name || "") ? 0 : 1;
      if (ap !== bp) return ap - bp;

      return String(a.name).localeCompare(String(b.name));
    });
    return de;
  }

  function findAnnaVoice(voices) {
    const isDe = (v) => String(v.lang || "").toLowerCase().startsWith("de");
    const v1 = voices.find((v) => isDe(v) && String(v.name || "").trim().toLowerCase() === "anna");
    if (v1) return v1;
    const v2 = voices.find((v) => isDe(v) && /anna/i.test(String(v.name || "")));
    if (v2) return v2;
    const v3 = voices.find((v) => isDe(v) && /anna/i.test(String(v.voiceURI || "")));
    return v3 || null;
  }

  function resolveVoice() {
    const voices = getDeVoices();
    const stored = localStorage.getItem(TTS_KEY) || "";
    ttsVoiceURI = stored || ttsVoiceURI || "";
    ttsVoiceObj = null;

    if (ttsVoiceURI) {
      ttsVoiceObj = voices.find((v) => v.voiceURI === ttsVoiceURI) || null;
    }

    if (!ttsVoiceObj && !stored) {
      const anna = findAnnaVoice(voices);
      if (anna) {
        ttsVoiceObj = anna;
        ttsVoiceURI = anna.voiceURI;
        try { localStorage.setItem(TTS_KEY, ttsVoiceURI); } catch {}
        return;
      }
    }

    if (!ttsVoiceObj && voices.length) {
      ttsVoiceObj = voices[0];
      ttsVoiceURI = ttsVoiceObj.voiceURI;
      try { localStorage.setItem(TTS_KEY, ttsVoiceURI); } catch {}
    }
  }

  function injectVoiceUI() {
    const bar = document.querySelector(".topbarActions");
    if (!bar) return;

    // Strictness select
    if (!document.getElementById("strictSelect")) {
      const strictSel = document.createElement("select");
      strictSel.id = "strictSelect";
      strictSel.className = "select";
      strictSel.title = "Pronunciation strictness";
      strictSel.innerHTML = `
        <option value="normal">Pronunciation: Normal</option>
        <option value="strict" selected>Pronunciation: Strict</option>
        <option value="ultra">Pronunciation: Ultra-Strict</option>
      `;
      strictSel.addEventListener("change", () => {
        strictMode = strictSel.value || "strict";
        status(`Strictness set: ${STRICTNESS[strictMode]?.name || strictMode} · ${APP_VERSION}`);
      });

      const reset = document.getElementById("resetBtn");
      if (reset && reset.parentElement === bar) bar.insertBefore(strictSel, reset);
      else bar.appendChild(strictSel);
    }

    // Voice select
    if (!document.getElementById("ttsVoiceSelect")) {
      const select = document.createElement("select");
      select.id = "ttsVoiceSelect";
      select.className = "select";
      select.title = "TTS Voice (Default: Anna if available)";
      select.style.maxWidth = "260px";

      const reset = document.getElementById("resetBtn");
      if (reset && reset.parentElement === bar) bar.insertBefore(select, reset);
      else bar.appendChild(select);

      const fill = () => {
        resolveVoice();
        const voices = getDeVoices();
        select.innerHTML = voices.length
          ? voices.map((v) => {
              const isAnna = String(v.name || "").trim().toLowerCase() === "anna";
              const label = `${v.name} (${v.lang})${isAnna ? " — recommended" : ""}`;
              const sel = v.voiceURI === ttsVoiceURI ? " selected" : "";
              return `<option value="${escapeHtml(v.voiceURI)}"${sel}>${escapeHtml(label)}</option>`;
            }).join("")
          : `<option value="">No DE voices found</option>`;
      };

      fill();

      select.addEventListener("change", () => {
        const uri = select.value || "";
        ttsVoiceURI = uri;
        try { localStorage.setItem(TTS_KEY, uri); } catch {}
        resolveVoice();
        status(`TTS voice set: ${(ttsVoiceObj?.name || "unknown")} · ${APP_VERSION}`);
      });

      if (ttsSupported() && typeof window.speechSynthesis.onvoiceschanged !== "undefined") {
        window.speechSynthesis.onvoiceschanged = () => fill();
      }
    }
  }

  function ttsStop() { try { window.speechSynthesis?.cancel?.(); } catch {} }

  function ttsSpeak(text, { rate = 1.0 } = {}) {
    return new Promise((resolve, reject) => {
      try {
        if (!ttsSupported()) return reject(new Error("TTS not supported"));
        ttsStop();
        resolveVoice();

        const u = new SpeechSynthesisUtterance(String(text || ""));
        u.lang = "de-DE";
        u.rate = rate;
        u.pitch = 0.95;
        if (ttsVoiceObj) u.voice = ttsVoiceObj;

        u.onend = () => resolve();
        u.onerror = (e) => reject(new Error(e?.error || "TTS error"));

        window.speechSynthesis.speak(u);
      } catch (err) {
        reject(err);
      }
    });
  }

  async function safePlay(ref, slow) {
    try {
      ttsStop();
      await player.playRef(lesson, ref, slow);
    } catch (e) {
      const de = refToDeText(ref);
      if (de) {
        const rate = slow ? SLOW_TTS_RATE : 1.0;
        const vname = ttsVoiceObj?.name || "default";
        status(`TTS ▶ ${ref.type}:${ref.id} slow=${slow ? "1" : "0"} rate=${rate} voice="${vname}" · ${APP_VERSION}`);
        try {
          await ttsSpeak(de, { rate });
          return;
        } catch (ttsErr) {
          console.error(ttsErr);
        }
      }
      console.error(e);
      status(`Audio missing for ${ref.type}:${ref.id}. · ${APP_VERSION}`);
    }
  }

  function stopAllAudio() {
    player.stop();
    ttsStop();
    status(`Stopped · ${APP_VERSION}`);
  }

  /* ---------------- init / fatal ---------------- */
  window.addEventListener("error", (e) => fatal(e.error || e.message || "Unknown error"));
  window.addEventListener("unhandledrejection", (e) => fatal(e.reason || "Unhandled rejection"));
  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    status(`Booting… ${APP_VERSION} · loading manifest.json`);
    wireUIHandlers();
    injectVoiceUI();

    try {
      manifest = await fetchJSON("/lessons/manifest.json");

      const trackId =
        (manifest?.tracks || []).some((t) => t.id === "en")
          ? "en"
          : (manifest?.tracks?.[0]?.id || "en");

      lessonOptions = buildLessonOptions(manifest, trackId);

      const select = $("#lessonSelect");
      select.innerHTML =
        `<option value="">Select a lesson…</option>` +
        lessonOptions.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");

      if (!lessonOptions.length) {
        setPanelTitle("No lessons");
        setPanelBody(`<div class="meta">manifest.json loaded, but lessons[] is empty.</div>`);
        status(`No lessons found · ${APP_VERSION}`);
        return;
      }

      select.value = lessonOptions[0].value;
      await loadLessonByValue(select.value);

      resolveVoice();
      status(
        coach.isSupported()
          ? `Ready · ${APP_VERSION} · Strict pronunciation enabled (${STRICTNESS[strictMode].name})`
          : `Ready · ${APP_VERSION} · REPEAT needs Chrome/Edge`
      );
    } catch (e) {
      fatal(e);
    }
  }

  function fatal(err) {
    const msg = typeof err === "string" ? err : (err?.message || String(err));
    console.error(err);

    setPanelTitle("App Error");
    setPanelActions("");
    setPanelBody(`
      <div class="row">
        <div class="grow">
          <div class="k">The app could not start.</div>
          <div class="m">Error: ${escapeHtml(msg)}</div>
          <div class="m" style="margin-top:10px;">
            Check these URLs in your browser:
            <ul class="meta">
              <li><b>/lessons/manifest.json</b> must show JSON</li>
              <li><b>/src/app.bundle.js</b> must show JS</li>
              <li><b>/lessons/en/W1D1.json</b> must show JSON</li>
            </ul>
          </div>
        </div>
        <span class="badge danger">Stop</span>
      </div>
    `);

    status(`ERROR · ${APP_VERSION}: ${msg}`);
  }

  /* ---------------- UI events ---------------- */
  function wireUIHandlers() {
    $("#lessonSelect").addEventListener("change", async (e) => {
      const value = e.target.value;
      if (!value) return;
      stopAllAudio();
      await loadLessonByValue(value);
    });

    $("#fileInput").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        stopAllAudio();
        const json = JSON.parse(await file.text());
        if (!json.lesson_id) throw new Error("Invalid JSON: missing lesson_id");
        await applyLesson(json, { sourceName: file.name });
        status(`Imported ${file.name} · ${APP_VERSION}`);
      } catch (err) {
        fatal(err);
      } finally {
        e.target.value = "";
      }
    });

    $("#resetBtn").addEventListener("click", () => {
      if (!srs) return;
      srs.reset();
      repeatConfirm.clear();
      status(`Progress reset · ${APP_VERSION}`);
      renderActiveTab();
    });

    $("#toggleBookBtn").addEventListener("click", () => {
      bookHidden = !bookHidden;
      $("#toggleBookBtn").textContent = bookHidden ? "Show" : "Hide";
      renderBook(lesson, { hidden: bookHidden });
    });

    $("#tabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;

      stopAllAudio();

      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");

      activeTab = btn.dataset.tab;
      renderActiveTab();
    });
  }

  async function loadLessonByValue(value) {
    const [trackId, file] = String(value || "").split("|");
    if (!trackId || !file) throw new Error(`Invalid lesson selector value: ${value}`);

    const track = getTrack(manifest, trackId);
    const url = joinPath(track.base_path, file);

    const json = await fetchJSON(url);
    await applyLesson(json, { sourceName: url });
  }

  async function applyLesson(json, { sourceName } = {}) {
    stopAllAudio();
    repeatConfirm.clear();

    lesson = json;
    srs = new SRS(`srs:${lesson.lesson_id}`);

    renderLessonMeta(lesson);
    renderBook(lesson, { hidden: bookHidden });

    status(`Loaded ${lesson.lesson_id} (${sourceName || "data"}) · ${APP_VERSION}`);
    renderActiveTab();
  }

  function renderActiveTab() {
    if (!lesson) return;
    if (activeTab === "listen") return renderListen();
    if (activeTab === "repeat") return renderRepeat();
    if (activeTab === "act") return renderAct();
    if (activeTab === "review") return renderReview();
  }

  function getWords() { return lesson?.book_page?.words_table || []; }
  function getSentences() { return lesson?.book_page?.teacher_sentences_table || []; }

  function refToDeText(ref) {
    if (!lesson) return "";
    if (ref.type === "word") return getWords().find((w) => w.id === ref.id)?.de || "";
    if (ref.type === "sentence") return getSentences().find((s) => s.id === ref.id)?.de || "";
    return "";
  }

  function itemRowHtml(type, id, de, en) {
    return `
      <div class="row">
        <div class="chips">
          <span class="chip">${escapeHtml(id)}</span>
          <span class="chip">${escapeHtml(type)}</span>
        </div>
        <div class="grow">
          <div class="k">${escapeHtml(de)}</div>
          <div class="m">${escapeHtml(en || "")}</div>
        </div>
        <button class="btn" data-play="1" data-type="${escapeHtml(type)}" data-id="${escapeHtml(id)}" data-slow="0">▶</button>
        <button class="btn ghost" data-play="1" data-type="${escapeHtml(type)}" data-id="${escapeHtml(id)}" data-slow="1">Slow</button>
      </div>
    `;
  }

  /* ---------------- LISTEN ---------------- */
  function renderListen() {
    setPanelTitle("LISTEN (Audio first)");
    setPanelActions(`
      <button class="btn" id="playWordsAll">Play all (words)</button>
      <button class="btn" id="playSentsAll">Play all (sentences)</button>
      <button class="btn ghost" id="stopAudio">Stop</button>
      <span class="badge good">Step 1</span>
    `);

    const words = getWords();
    const sents = getSentences();

    setPanelBody(`
      <div class="meta">
        Tap ▶ to hear. If MP3 missing, TTS is used (Anna preferred).
        <span class="tiny muted">(${escapeHtml(APP_VERSION)})</span>
      </div>
      <div class="row"><div class="grow"><div class="k">Words</div><div class="m">First: listen only.</div></div></div>
      ${words.map((w) => itemRowHtml("word", w.id, w.de, w.en)).join("")}
      <div class="row"><div class="grow"><div class="k">Teacher sentences</div><div class="m">Classroom phrases.</div></div></div>
      ${sents.map((s) => itemRowHtml("sentence", s.id, s.de, s.en)).join("")}
    `);

    $("#stopAudio").onclick = () => stopAllAudio();
    $("#playWordsAll").onclick = async () => { for (const w of words) await safePlay({ type: "word", id: w.id }, false); };
    $("#playSentsAll").onclick = async () => { for (const s of sents) await safePlay({ type: "sentence", id: s.id }, false); };

    document.querySelectorAll("[data-play]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        const slow = btn.dataset.slow === "1";
        await safePlay({ type, id }, slow);
      });
    });
  }

  /* ---------------- REPEAT (STRICT PRON) ---------------- */
  function repeatBadgeHtml(state, pct, extra = "") {
    if (state === "correct") return `<span class="badge good">✅ Korrekt${extra ? " " + escapeHtml(extra) : ""}</span>`;
    if (state === "almost") return `<span class="badge warn">🟡 Fast${pct ? ` (${pct}%)` : ""}${extra ? " " + escapeHtml(extra) : ""}</span>`;
    if (state === "try_again") return `<span class="badge danger">🔁 Wiederholen${extra ? " " + escapeHtml(extra) : ""}</span>`;
    return `<span class="badge">—</span>`;
  }

  function renderRepeat() {
    setPanelTitle("REPEAT (Speak)");
    setPanelActions(`
      <span class="badge ${coach.isSupported() ? "good" : "warn"}">
        ${coach.isSupported() ? "Mic ready" : "SpeechRecognition not supported"}
      </span>
      <span class="badge good">Step 2</span>
    `);

    if (!coach.isSupported()) {
      setPanelBody(`<div class="meta">Use Chrome/Edge for speech recognition. LISTEN and ACT still work.</div>`);
      return;
    }

    const speakItems = lesson?.repeat?.speak_items || [];
    const scoring = lesson?.repeat?.scoring || {};
    const correctThreshold = typeof scoring.correct_threshold === "number" ? scoring.correct_threshold : 0.78;
    const almostThreshold = typeof scoring.almost_threshold === "number" ? scoring.almost_threshold : 0.62;

    const preset = STRICTNESS[strictMode] || STRICTNESS.strict;
    const ultra = !!preset.require_double_confirm;

    if (!speakItems.length) {
      setPanelBody(`<div class="meta">No REPEAT items in this lesson (repeat.speak_items is empty).</div>`);
      return;
    }

    setPanelBody(`
      <div class="meta">
        Strict pronunciation: Green only when the recognizer is confident and you spoke long enough.
        Mode: <b>${escapeHtml(preset.name)}</b>.
        <div class="tiny muted">You always see what the browser actually heard: “Gehört: …” · ${escapeHtml(APP_VERSION)}</div>
      </div>

      ${speakItems.map((it, idx) => {
        const type = it.type === "word" ? "word" : "sentence";
        const id = it.ref_id;
        const de = refToDeText({ type, id });
        const key = `${type}:${id}`;
        return `
          <div class="row" style="align-items:flex-start;">
            <div class="chips">
              <span class="chip">${escapeHtml(String(idx + 1).padStart(2, "0"))}</span>
              <span class="chip">${escapeHtml(type)}</span>
            </div>

            <div class="grow">
              <div class="k">${escapeHtml(de)}</div>
              <div class="m">${escapeHtml(it.hint_en || "")}</div>
              <div class="tiny muted" id="heard-${escapeHtml(key)}">Gehört: —</div>
            </div>

            <span id="repBadge-${escapeHtml(key)}">${repeatBadgeHtml("idle")}</span>

            <button class="btn" data-r-listen="1" data-type="${escapeHtml(type)}" data-id="${escapeHtml(id)}">▶</button>
            <button class="btn" data-r-speak="1" data-type="${escapeHtml(type)}" data-id="${escapeHtml(id)}">${ultra ? "Speak (2x)" : "Speak"}</button>
          </div>
        `;
      }).join("")}
    `);

    const setBadge = (type, id, grade, pct, extra = "") => {
      const key = `${type}:${id}`;
      const el = document.getElementById(`repBadge-${key}`);
      if (!el) return;
      el.innerHTML = repeatBadgeHtml(grade, pct, extra);
    };

    const setHeard = (type, id, txt) => {
      const key = `${type}:${id}`;
      const el = document.getElementById(`heard-${key}`);
      if (!el) return;
      el.textContent = txt;
    };

    document.querySelectorAll("[data-r-listen]").forEach((btn) => {
      btn.onclick = async () => {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        await safePlay({ type, id }, true);
      };
    });

    document.querySelectorAll("[data-r-speak]").forEach((btn) => {
      btn.onclick = async () => {
        const type = btn.dataset.type;
        const id = btn.dataset.id;
        const targetRaw = refToDeText({ type, id });
        if (!targetRaw) return;

        const presetNow = STRICTNESS[strictMode] || STRICTNESS.strict;
        const target = normStrict(targetRaw);
        const refKey = `${type}:${id}`;
        const minMs = minSpeakMsForTarget(targetRaw, presetNow);

        setBadge(type, id, "idle");
        setHeard(type, id, "Gehört: —");

        try {
          const rec = await coach.recognizeOnce();
          const heard = normStrict(rec.text || "");
          const sim = similarity(heard, target);
          const pct = Math.round(sim * 100);

          const conf = (typeof rec.confidence === "number") ? rec.confidence : null;
          const confPct = conf == null ? "?" : Math.round(conf * 100);
          const amb = isAmbiguous(rec.alternatives, presetNow.ambiguous_gap);

          // show what was heard regardless
          setHeard(type, id, `Gehört: "${rec.text || ""}" · conf=${confPct}% · ${rec.ms}ms`);

          // basic grade by similarity thresholds (kept for robustness)
          let grade = "try_again";
          if (sim >= correctThreshold) grade = "correct";
          else if (sim >= almostThreshold) grade = "almost";

          // strict gate for "correct"
          const longEnough = rec.ms >= minMs;
          const confidentEnough = (conf == null) ? false : conf >= presetNow.correct_confidence;

          // If confidence missing, we still allow "almost", but "correct" requires more
          let allowGreen = (heard === target) && longEnough && (conf == null ? false : confidentEnough) && !amb;

          // Ultra mode: need 2 consecutive greens
          if (allowGreen && presetNow.require_double_confirm) {
            const c = (repeatConfirm.get(refKey) || 0) + 1;
            repeatConfirm.set(refKey, c);
            if (c < 2) {
              allowGreen = false;
              setBadge(type, id, "almost", pct, "✅ 1/2");
              status(`Almost (need 2x) · heard="${rec.text}" · conf=${confPct}% · ${rec.ms}ms · ${APP_VERSION}`);
              srs.bumpMastery(type, id, false);
              srs.addWrongRepeat(refKey);
              return;
            }
          } else {
            // reset confirm if not passing
            repeatConfirm.set(refKey, 0);
          }

          // If it's exact match but too short or ambiguous or low confidence -> downgrade to almost
          if ((heard === target) && !allowGreen) {
            const why = !longEnough ? `⏱ >=${minMs}ms` : (amb ? "ambiguous" : `conf>=${Math.round(presetNow.correct_confidence * 100)}%`);
            setBadge(type, id, "almost", pct, why);
            status(`Almost (strict gate) · ${why} · heard="${rec.text}" · ${APP_VERSION}`);
            srs.bumpMastery(type, id, false);
            srs.addWrongRepeat(refKey);
            return;
          }

          if (allowGreen) {
            setBadge(type, id, "correct", 100);
            status(`✅ Korrekt (strict) · heard="${rec.text}" · conf=${confPct}% · ${rec.ms}ms · ${APP_VERSION}`);
            srs.bumpMastery(type, id, true);
            srs.clearWrongRepeat(refKey);
            repeatConfirm.set(refKey, 0);
            return;
          }

          // otherwise: keep normal grading result
          if (grade === "almost") {
            setBadge(type, id, "almost", pct);
            status(`🟡 Fast (${pct}%) · heard="${rec.text}" · conf=${confPct}% · ${APP_VERSION}`);
            srs.bumpMastery(type, id, false);
            srs.addWrongRepeat(refKey);
          } else {
            setBadge(type, id, "try_again", pct);
            status(`🔁 Wiederholen (${pct}%) · heard="${rec.text}" · conf=${confPct}% · ${APP_VERSION}`);
            srs.bumpMastery(type, id, false);
            srs.addWrongRepeat(refKey);
          }
        } catch (e) {
          fatal(e);
        }
      };
    });
  }

  /* ---------------- ACT ---------------- */
  function renderAct() {
    setPanelTitle("ACT (Tap answers)");
    setPanelActions(`<span class="badge good">Step 3</span>`);

    const items = lesson?.act?.items || [];
    if (!items.length) {
      setPanelBody(`<div class="meta">No ACT items in this lesson yet.</div>`);
      return;
    }

    let idx = 0;

    const draw = () => {
      const it = items[idx];
      const promptRef = it.prompt_ref || {};
      const mode = it.mode || "audio_to_choice_en";

      let choicesHtml = "";
      if (mode === "audio_to_choice_en") {
        choicesHtml = `
          <div class="choiceGrid">
            ${(it.choices_en || []).map((c, i) => `<button class="choice" data-choice="${i}">${escapeHtml(c)}</button>`).join("")}
          </div>
        `;
      } else {
        choicesHtml = `<div class="meta">Unsupported ACT mode: ${escapeHtml(mode)}</div>`;
      }

      setPanelBody(`
        <div class="row">
          <div class="grow">
            <div class="k">Item ${idx + 1} / ${items.length}</div>
            <div class="m">Tap ▶ to hear German, then tap the correct answer.</div>
          </div>
          <button class="btn" id="actPlay">▶</button>
          <button class="btn ghost" id="actPlaySlow">Slow</button>
        </div>

        ${choicesHtml}

        <div class="row" style="justify-content:space-between;">
          <button class="btn ghost" id="prevBtn">Prev</button>
          <span class="badge warn">Wrong items go to REVIEW</span>
          <button class="btn" id="nextBtn">Next</button>
        </div>
      `);

      $("#actPlay").onclick = () => safePlay({ type: promptRef.type, id: promptRef.id }, false);
      $("#actPlaySlow").onclick = () => safePlay({ type: promptRef.type, id: promptRef.id }, true);

      $("#prevBtn").onclick = () => { idx = Math.max(0, idx - 1); draw(); };
      $("#nextBtn").onclick = () => { idx = Math.min(items.length - 1, idx + 1); draw(); };

      document.querySelectorAll(".choice").forEach((btn) => {
        btn.onclick = () => {
          const choice = Number(btn.dataset.choice);
          const ok = choice === it.correct_index;

          document.querySelectorAll(".choice").forEach((b, i) => {
            b.classList.remove("correct", "wrong");
            if (i === it.correct_index) b.classList.add("correct");
          });
          if (!ok) btn.classList.add("wrong");

          status(`${ok ? "Correct" : "Try again"} · ${APP_VERSION}`);
          srs.bumpMastery("act", it.id, ok);
          if (ok) srs.clearWrongAct(it.id);
          else srs.addWrongAct(it.id);
        };
      });
    };

    draw();
  }

  /* ---------------- REVIEW ---------------- */
  function renderReview() {
    setPanelTitle("REVIEW (Weak items)");
    setPanelActions(`<span class="badge good">Step 4</span>`);

    const wrongAct = srs?.state?.wrongAct || [];
    const wrongRepeat = srs?.state?.wrongRepeat || [];
    const weakTop = srs?.getWeakTop(5) || [];

    setPanelBody(`
      <div class="meta">This shows what you should repeat again (fast). (${escapeHtml(APP_VERSION)})</div>

      <div class="row">
        <div class="grow">
          <div class="k">Wrong ACT</div>
          <div class="m">${escapeHtml(wrongAct.join(", ") || "None")}</div>

          <div class="k" style="margin-top:10px;">Wrong REPEAT</div>
          <div class="m">${escapeHtml(wrongRepeat.join(", ") || "None")}</div>

          <div class="k" style="margin-top:10px;">Weak mastery</div>
          <div class="m">${escapeHtml(weakTop.map(([k, v]) => `${k}=${v}`).join(" · ") || "None")}</div>
        </div>

        <span class="badge ${wrongAct.length + wrongRepeat.length ? "warn" : "good"}">
          ${wrongAct.length + wrongRepeat.length ? "Practice" : "All good"}
        </span>
      </div>
    `);
  }
})();
