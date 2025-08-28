export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (e) {
      return json({ error: "Internal error", detail: String(e?.message || e) }, 500);
    }
  },

  // Cron trigger: purge any PENDING records older than 10 minutes
  async scheduled(_event, env, _ctx) {
    await purgeExpiredPending(env.DB);
  },
};


const OTP_TTL_SECONDS = 10 * 60;   // 10 minutes
const MAX_FAILED_ATTEMPTS = 2;


function nowSeconds() { return Math.floor(Date.now() / 1000); }

function generateCode() {
  // 7-digit, never leading zero
  return String(Math.floor(1_000_000 + Math.random() * 9_000_000));
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function withCORS(res, env) {
  const h = new Headers(res.headers);
  const origin = env.ALLOWED_ORIGIN || "*";
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers: h });
}

/** ====== BASIC AUTH ====== **/

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Restricted"' },
  });
}

function checkBasicAuth(req, env) {
  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Basic ")) return false;
  const b64 = auth.slice(6);
  let decoded;
  try { decoded = atob(b64); } catch { return false; }
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === env.BASIC_USER && pass === env.BASIC_PASS;
}

/** ====== D1 UTIL ====== **/

async function purgeExpiredPending(db) {
  const cutoff = nowSeconds() - OTP_TTL_SECONDS;
  // Only purge rows that are still pending (i.e., never resolved)
  await db.prepare(
    "DELETE FROM otps WHERE status = 'pending' AND created_at < ?"
  ).bind(cutoff).run();
}

async function sendSms(env, to, text) {
  const url = "https://[Domain]/api/v2/sms/send";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SMS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: env.SMS_FROM, to, text }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`SMS send failed (${r.status}): ${errText}`);
  }
  try { return await r.json(); } catch { return {}; }
}

/** ====== ROUTES ====== **/

async function handleRequest(req, env) {
  const { DB } = env;
  const { pathname } = new URL(req.url);

  // Allow preflight without auth
  if (req.method === "OPTIONS") {
    return withCORS(new Response(null, { status: 204 }), env);
  }

  // Enforce Basic Auth for all other requests
  if (!checkBasicAuth(req, env)) {
    return withCORS(unauthorized(), env);
  }

  if (req.method !== "POST") {
    return withCORS(json({ error: "Method not allowed" }, 405), env);
  }

  let payload;
  try { payload = await req.json(); }
  catch { return withCORS(json({ error: "Invalid JSON body" }, 400), env); }

  // Housekeeping: clean out only expired *pending* rows
  await purgeExpiredPending(DB);

  if (pathname === "/request") {
    const Number = String(payload?.Number || "").trim();
    const LSP    = String(payload?.LSP    || "").trim();
    const OR     = String(payload?.OR     || "").trim();
    if (!Number || !LSP || !OR) {
      return withCORS(json({ error: "Missing required fields: Number, LSP, OR" }, 400), env);
    }

    const code = generateCode();
    const createdAt = nowSeconds();

    // Upsert by number; reset attempts/timestamp and set status back to 'pending'
    await DB.prepare(`
      INSERT INTO otps (number, code, lsp, order_ref, failed_attempts, created_at, status)
      VALUES (?, ?, ?, ?, 0, ?, 'pending')
      ON CONFLICT(number) DO UPDATE SET
        code=excluded.code,
        lsp=excluded.lsp,
        order_ref=excluded.order_ref,
        failed_attempts=0,
        created_at=excluded.created_at,
        status='pending'
    `).bind(Number, code, LSP, OR, createdAt).run();

    const smsText = [
      "Hi,",
      "",
      "Thank you for your porting submission.",
      "",
      `Your unique code: ${code}`,
      ""
    ].join("\n");
    
    
    

    try {
      await sendSms(env, Number, smsText);
      return withCORS(json({ status: "sent" }), env);
    } catch (e) {
      await DB.prepare("DELETE FROM otps WHERE number = ? AND status = 'pending'")
        .bind(Number).run();
      return withCORS(json({ error: "Failed to send SMS", detail: String(e?.message || e) }, 502), env);
    }
  }

  if (pathname === "/otp") {
    const Number = String(payload?.Number || "").trim();
    const code   = String(payload?.code || payload?.Code || "").trim();
    if (!Number || !code) {
      return withCORS(json({ error: "Missing required fields: Number, code" }, 400), env);
    }

    const row = await DB.prepare(
      "SELECT code, failed_attempts, created_at, status FROM otps WHERE number = ?"
    ).bind(Number).first();

    if (!row) {
      return withCORS(json({ error: "OTP not found or expired" }, 404), env);
    }

    // If already resolved, don't allow further verification
    if (row.status === "success") {
      return withCORS(json({ error: "OTP already verified" }, 409), env);
    }
    if (row.status === "failed") {
      return withCORS(json({ error: "Attempts exhausted; request a new code." }, 403), env);
    }

    // Expired pending?
    if (row.created_at < nowSeconds() - OTP_TTL_SECONDS) {
      // Expired pending → delete (or set status='failed_expired' if you prefer to keep)
      await DB.prepare("DELETE FROM otps WHERE number = ? AND status = 'pending'")
        .bind(Number).run();
      return withCORS(json({ error: "OTP expired" }, 410), env);
    }

    // Check attempts (still pending)
    if (row.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      await DB.prepare("UPDATE otps SET status = 'failed' WHERE number = ?")
        .bind(Number).run();
      return withCORS(json({ error: "Too many attempts. Request a new code." }, 403), env);
    }

    if (row.code === code) {
      await DB.prepare("UPDATE otps SET status = 'success' WHERE number = ?")
        .bind(Number).run();
      return withCORS(json({ status: "success" }), env);
    }

    const newAttempts = row.failed_attempts + 1;
    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      await DB.prepare("UPDATE otps SET failed_attempts = ?, status = 'failed' WHERE number = ?")
        .bind(newAttempts, Number).run();
      return withCORS(json({ error: "Incorrect code. Attempts exhausted; request a new code." }, 403), env);
    } else {
      await DB.prepare("UPDATE otps SET failed_attempts = ? WHERE number = ?")
        .bind(newAttempts, Number).run();
      return withCORS(json({ error: "Incorrect code. Try again.", attempts_left: MAX_FAILED_ATTEMPTS - newAttempts }, 401), env);
    }
  }

  return withCORS(json({ error: "Not found" }, 404), env);
}
