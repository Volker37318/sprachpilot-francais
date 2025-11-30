// netlify/functions/pronounce.js
const https = require("https");
const http = require("http");
const { URL } = require("url");

function cors(origin) {
  const allow = origin || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, x-pronounce-secret",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

function header(event, name) {
  const h = event?.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || "";
}

function requestText(urlStr, { method = "GET", headers = {}, body = "", timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "http:" ? http : https;

    const requestBody = body ? String(body) : "";
    const reqHeaders = { ...headers };
    if (requestBody && !reqHeaders["Content-Length"] && !reqHeaders["content-length"]) {
      reqHeaders["Content-Length"] = Buffer.byteLength(requestBody);
    }

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            text: buf.toString("utf8"),
          });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });

    if (requestBody) req.write(requestBody);
    req.end();
  });
}

exports.handler = async (event) => {
  const origin = header(event, "origin");
  const baseHeaders = { ...cors(origin), "content-type": "application/json; charset=utf-8" };

  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: baseHeaders, body: "" };
    }

    const KOYEB_BASE = pickEnv(
      "KOYEB_PRONOUNCE_URL",
      "PRONOUNCE_KOYEB_URL",
      "KOYEB_URL",
      "PRONOUNCE_UPSTREAM_URL"
    );

    const SECRET = pickEnv(
      "PRONOUNCE_SECRET",
      "X_PRONOUNCE_SECRET",
      "PRONOUNCE_PROXY_SECRET"
    );

    if (event.httpMethod === "GET") {
      return {
        statusCode: 200,
        headers: baseHeaders,
        body: JSON.stringify({
          ok: true,
          service: "pronounce",
          hasKoyeb: !!KOYEB_BASE,
          hasSecret: !!SECRET,
        }),
      };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Method not allowed" }) };
    }

    if (!KOYEB_BASE) {
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Missing env KOYEB_PRONOUNCE_URL" }) };
    }
    if (!SECRET) {
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Missing env PRONOUNCE_SECRET" }) };
    }

    let bodyText = event.body || "";
    if (event.isBase64Encoded) bodyText = Buffer.from(bodyText, "base64").toString("utf8");

    let data;
    try {
      data = JSON.parse(bodyText || "{}");
    } catch (e) {
      console.log("[PRONOUNCE_FN] JSON parse failed:", String(e));
      return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Invalid JSON body" }) };
    }

    const { targetText, language, audioBase64, enableMiscue } = data || {};
    if (!targetText || !language || !audioBase64) {
      return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Missing targetText/language/audioBase64" }) };
    }

    // robust: egal ob KOYEB_BASE schon /pronounce hat oder nicht
    const base = KOYEB_BASE.replace(/\/$/, "");
    const upstreamUrl = base.endsWith("/pronounce") ? base : (base + "/pronounce");

    console.log("[PRONOUNCE_FN] → Upstream:", upstreamUrl, "| b64.len:", String(audioBase64).length);

    let upstream;
    try {
      upstream = await requestText(upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pronounce-secret": SECRET },
        body: JSON.stringify({ targetText, language, audioBase64, enableMiscue: !!enableMiscue }),
        timeoutMs: 25000,
      });
    } catch (e) {
      console.log("[PRONOUNCE_FN] Upstream request failed:", String(e));
      return { statusCode: 503, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Upstream request failed", detail: String(e) }) };
    }

    const ct = upstream.headers["content-type"] || upstream.headers["Content-Type"] || "application/json; charset=utf-8";
    console.log("[PRONOUNCE_FN] Upstream status:", upstream.status, "| ct:", ct);
    console.log("[PRONOUNCE_FN] Upstream body head:", (upstream.text || "").slice(0, 800));

    return {
      statusCode: upstream.status,
      headers: { ...baseHeaders, "content-type": ct },
      body: upstream.text || "",
    };
  } catch (e) {
    console.log("[PRONOUNCE_FN] Unhandled error:", String(e));
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ ok: false, error: "Function crashed", detail: String(e) }) };
  }
};
