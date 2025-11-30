// netlify/functions/pronounce.js
// Browser -> Netlify Function (same-origin) -> Koyeb /pronounce (server-to-server)

exports.handler = async (event) => {
  const origin = event.headers?.origin || "*";

  const headersBase = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, x-pronounce-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400"
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: headersBase, body: "" };
  }

  // Simple health check in browser (NO 404 confusion)
  if (event.httpMethod === "GET") {
    const hasKoyeb = !!process.env.KOYEB_PRONOUNCE_URL;
    const hasSecret = !!process.env.PRONOUNCE_SECRET;
    return {
      statusCode: 200,
      headers: { ...headersBase, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, service: "pronounce", hasKoyeb, hasSecret })
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...headersBase, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Method Not Allowed" })
    };
  }

  try {
    const KOYEB_URL = process.env.KOYEB_PRONOUNCE_URL; // https://...koyeb.app/pronounce
    const SECRET = process.env.PRONOUNCE_SECRET;       // set in Netlify env vars

    if (!KOYEB_URL) {
      return {
        statusCode: 500,
        headers: { ...headersBase, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing env: KOYEB_PRONOUNCE_URL" })
      };
    }
    if (!SECRET) {
      return {
        statusCode: 500,
        headers: { ...headersBase, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing env: PRONOUNCE_SECRET" })
      };
    }

    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return {
        statusCode: 400,
        headers: { ...headersBase, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Invalid JSON body" })
      };
    }

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
        ...headersBase,
        "Content-Type": resp.headers.get("content-type") || "application/json"
      },
      body: text
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...headersBase, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: String(e?.message || e) })
    };
  }
};
