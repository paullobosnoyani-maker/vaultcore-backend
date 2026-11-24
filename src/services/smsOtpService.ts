import crypto from "crypto";
import https from "https";
import pool from "../config/db";

export async function ensureSmsOtpTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_otps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      phone VARCHAR(30) NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function hashSmsOtp(userId: string, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${code}:${process.env.JWT_SECRET || "vaultcore-sms"}`)
    .digest("hex");
}

function postTwilioSms(sid: string, token: string, formBody: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const req = https.request(
      {
        hostname: "api.twilio.com",
        port: 443,
        path: `/2010-04-01/Accounts/${sid}/Messages.json`,
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(formBody),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Twilio error (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`Twilio network error: ${err.message}`)));
    req.write(formBody);
    req.end();
  });
}

async function sendWireEmailFallback(email: string, code: string, amount: number): Promise<void> {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) return;

  const fromAddress = process.env.EMAIL_FROM || "VaultCore US <security@vaultcoreus.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [email.toLowerCase().trim()],
      subject: `VaultCore US — Wire Authorization Code ($${amount.toFixed(2)} USD)`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
          <h2 style="color: #0f172a; margin-top: 0;">Wire Transfer Security Authorization</h2>
          <p style="color: #475569; font-size: 14px;">Enter this 6-digit security code to authorize your <strong>$${amount.toFixed(2)} USD</strong> VaultCore US member wire transfer. Expires in 5 minutes.</p>
          <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
            <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0f172a; font-family: monospace;">${code}</span>
          </div>
          <p style="color: #94a3b8; font-size: 12px; margin-bottom: 0;">If you did not initiate this wire transfer, freeze your account immediately.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const details = await res.text();
    throw new Error(`Email OTP delivery failed (${res.status}): ${details}`);
  }
}

export async function sendWireSmsOtp(userId: string, rawPhone: string, amount: number): Promise<string> {
  await ensureSmsOtpTable();

  const userRes = await pool.query("SELECT email FROM users WHERE id = $1 LIMIT 1", [userId]);
  const userEmail = userRes.rows[0]?.email;

  const digits = String(rawPhone || "").replace(/\D/g, "");
  const e164Phone = rawPhone?.trim().startsWith("+")
    ? `+${digits}`
    : digits.length === 10
    ? `+1${digits}`
    : digits.length >= 10
    ? `+${digits}`
    : "";

  const code = crypto.randomInt(100000, 999999).toString();
  const otpHash = hashSmsOtp(userId, code);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await pool.query("DELETE FROM sms_otps WHERE user_id = $1", [userId]);
  await pool.query(
    "INSERT INTO sms_otps (user_id, phone, otp_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [userId, e164Phone || userEmail || "email-2fa", otpHash, expiresAt]
  );

  const sid = (process.env.TWILIO_ACCOUNT_SID || "").replace(/\s+/g, "");
  const token = (process.env.TWILIO_AUTH_TOKEN || "").replace(/\s+/g, "");
  const from = (process.env.TWILIO_PHONE_NUMBER || "").replace(/\s+/g, "");

  let smsSent = false;
  if (sid && token && from && e164Phone) {
    try {
      const body = new URLSearchParams({
        To: e164Phone,
        From: from,
        Body: `VaultCore US Security: Your wire transfer verification code for $${amount.toFixed(2)} USD is ${code}. Expires in 5 minutes.`,
      }).toString();
      await postTwilioSms(sid, token, body);
      smsSent = true;
    } catch (err: any) {
      console.warn("Twilio SMS fallback triggered:", err.message);
    }
  }

  if (smsSent) {
    return `SMS (••••${e164Phone.slice(-4)})`;
  }

  if (userEmail) {
    await sendWireEmailFallback(userEmail, code, amount);
    const [localPart, domain] = userEmail.split("@");
    return `${localPart.slice(0, 2)}***@${domain}`;
  }

  throw new Error("Could not deliver wire security code via SMS or email.");
}

export async function verifyWireSmsOtp(userId: string, code: string): Promise<boolean> {
  await ensureSmsOtpTable();
  const res = await pool.query(
    "SELECT * FROM sms_otps WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (res.rows.length === 0) return false;

  const record = res.rows[0];
  if (new Date(record.expires_at) < new Date() || record.attempts >= 5) {
    await pool.query("DELETE FROM sms_otps WHERE id = $1", [record.id]);
    return false;
  }

  const submittedHash = hashSmsOtp(userId, code.trim());
  if (submittedHash !== record.otp_hash) {
    await pool.query("UPDATE sms_otps SET attempts = attempts + 1 WHERE id = $1", [record.id]);
    return false;
  }

  await pool.query("DELETE FROM sms_otps WHERE id = $1", [record.id]);
  return true;
}
