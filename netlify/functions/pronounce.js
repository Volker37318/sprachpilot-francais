// netlify/functions/pronounce.js
// Proxy: Browser -> Netlify Function (same-origin) -> Koyeb /pronounce (server-to-server)

exports.handler = async (event) => {
  const origin = event.headers?.origin || "*";

  // Preflight (falls Browser OPTIONS macht)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "86400"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": origin },
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" })
    };
  }

  try {
    const KOYEB_URL = process.env.KOYEB_PRONOUNCE_URL; // z.B. https://...koyeb.app/pronounce
    const SECRET = process.env.PRONOUNCE_SECRET;       // spfr-2025-test

    if (!KOYEB_URL) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": origin },
        body: JSON.stringify({ ok: false, error: "Missing env: KOYEB_PRONOUNCE_URL" })
      };
    }
    if (!SECRET) {
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": origin },
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

    return {
      statusCode: resp.status,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": resp.headers.get("content-type") || "application/json"
      },
      body: text
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": origin },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) })
    };
  }
};
