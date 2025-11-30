// netlify/functions/pronounce.js
// Browser -> Netlify Function (same-origin) -> Koyeb /pronounce (server-to-server)

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || "*";

  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  // Simple health check in browser
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, service: "pronounce-proxy" })
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" })
    };
  }

  try {
    const KOYEB_URL = (process.env.KOYEB_PRONOUNCE_URL || "").trim(); // https://...koyeb.app/pronounce
    const SECRET = (process.env.PRONOUNCE_SECRET || "").trim();       // only in Netlify env

    if (!KOYEB_URL) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing env: KOYEB_PRONOUNCE_URL" })
      };
    }
    if (!SECRET) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing env: PRONOUNCE_SECRET" })
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const resp = await fetch(KOYEB_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pronounce-secret": SECRET
      },
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    const contentType = resp.headers.get("content-type") || "application/json";

    return {
      statusCode: resp.status,
      headers: { ...cors, "Content-Type": contentType, "Cache-Control": "no-store" },
      body: text
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) })
    };
  }
};
