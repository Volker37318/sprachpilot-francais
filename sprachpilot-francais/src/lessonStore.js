// src/lessonStore.js

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${url} (HTTP ${res.status})`);
  return await res.json();
}

function toRootPath(p) {
  // turns "./lessons/en/" -> "/lessons/en/"
  if (!p) return "/";
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  if (p.startsWith("/")) return p;
  return "/" + p.replace(/^\.\/+/, "");
}

export async function loadManifest() {
  // Root deployment: this must work
  return await fetchJson("/lessons/manifest.json");
}

export function buildLessonOptions(manifest, trackId) {
  if (!manifest || !Array.isArray(manifest.tracks)) return [];

  const track = manifest.tracks.find((t) => t.id === trackId) || manifest.tracks[0];
  if (!track || !Array.isArray(track.lessons)) return [];

  return track.lessons.map((l) => {
    const label =
      `Day ${l.global_day} · ${l.lesson_id} — ${l.title_en || l.title_de || l.file}`;
    return {
      // value encodes how to load the lesson
      value: `${track.id}|${l.file}`,
      label
    };
  });
}

export async function fetchLessonByValue(manifest, value) {
  const [trackId, file] = String(value || "").split("|");
  if (!trackId || !file) throw new Error(`Invalid lesson selector value: ${value}`);

  const track = manifest.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`Track not found in manifest: ${trackId}`);

  const base = toRootPath(track.base_path || "/lessons/en/");
  const url = base.endsWith("/") ? `${base}${file}` : `${base}/${file}`;

  return await fetchJson(url);
}

export async function importLessonFromFile(file) {
  const text = await file.text();
  const json = JSON.parse(text);
  if (!json.lesson_id) throw new Error("Invalid lesson JSON: missing lesson_id");
  return json;
}
