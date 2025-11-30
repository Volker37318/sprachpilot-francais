// src/utils.js
export const $ = (sel, root = document) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing element in DOM: ${sel}`);
  return el;
};

export const escapeHtml = (v) => {
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
