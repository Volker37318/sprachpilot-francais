// netlify/functions/pronounce.js

function cors(origin) {
  // Wenn du später einschränken willst: hier eine Allowlist bauen
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

    // Health/Ready Check
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
      return {
        statusCode: 405,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: "Method not allowed" }),
      };
    }

    if (!KOYEB_BASE) {
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: "Missing env KOYEB_PRONOUNCE_URL" }),
      };
    }
    if (!SECRET) {
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: "Missing env PRONOUNCE_SECRET" }),
      };
    }

    // Body robust lesen (Netlify kann base64-encodet liefern)
    let bodyText = event.body || "";
    if (event.isBase64Encoded) {
      bodyText = Buffer.from(bodyText, "base64").toString("utf8");
    }

    let data;
    try {
      data = JSON.parse(bodyText || "{}");
    } catch (e) {
      console.log("[PRONOUNCE_FN] JSON parse failed:", String(e));
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: "Invalid JSON body" }),
      };
    }

    const { targetText, language, audioBase64, enableMiscue } = data || {};
    if (!targetText || !language || !audioBase64) {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: "Missing targetText/language/audioBase64" }),
      };
    }

    const upstreamUrl = KOYEB_BASE.replace(/\/$/, "") + "/pronounce";

    // Timeout
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 25000);

    let r, txt, ct;
    try {
      console.log("[PRONOUNCE_FN] → Upstream:", upstreamUrl, "| b64.len:", String(audioBase64).length);

      r = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pronounce-secret": SECRET,
        },
        body: JSON.stringify({ targetText, language, audioBase64, enableMiscue: !!enableMiscue }),
        signal: controller.signal,
      });

      ct = r.headers.get("content-type") || "";
      txt = await r.text();

      console.log("[PRONOUNCE_FN] Upstream status:", r.status, "| ct:", ct);
      console.log("[PRONOUNCE_FN] Upstream body head:", (txt || "").slice(0, 800));
    } catch (e) {
      console.log("[PRONOUNCE_FN] Upstream fetch failed:", String(e));
      return {
        statusCode: 503,
        headers: baseHeaders,
        body: JSON.stringify({ ok: false, error: "Upstream fetch failed", detail: String(e) }),
      };
    } finally {
      clearTimeout(t);
    }

    // Upstream-Antwort 1:1 durchreichen
    return {
      statusCode: r.status,
      headers: { ...baseHeaders, "content-type": ct || "application/json; charset=utf-8" },
      body: txt || "",
    };
  } catch (e) {
    console.log("[PRONOUNCE_FN] Unhandled error:", String(e));
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ ok: false, error: "Function crashed", detail: String(e) }),
    };
  }
};
