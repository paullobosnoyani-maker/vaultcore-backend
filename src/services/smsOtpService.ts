import crypto from "crypto";
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

export async function sendWireSmsOtp(userId: string, rawPhone: string, amount: number): Promise<string> {
  await ensureSmsOtpTable();

  const digits = String(rawPhone || "").replace(/\D/g, "");
  if (digits.length < 10) {
    throw new Error("A valid phone number is required on your profile for SMS wire verification.");
  }
  const e164Phone = rawPhone.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;

  const code = crypto.randomInt(100000, 999999).toString();
  const otpHash = hashSmsOtp(userId, code);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

  await pool.query("DELETE FROM sms_otps WHERE user_id = $1", [userId]);
  await pool.query(
    "INSERT INTO sms_otps (user_id, phone, otp_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [userId, e164Phone, otpHash, expiresAt]
  );

  const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const token = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_PHONE_NUMBER?.trim();

  if (sid && token && from) {
    const body = new URLSearchParams({
      To: e164Phone,
      From: from,
      Body: `VaultCore US Security: Your wire transfer verification code for $${amount.toFixed(2)} USD is ${code}. Expires in 5 minutes.`,
    });

    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    const res = await fetch(`https://twilio.com{sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Twilio SMS failed (${res.status}): ${errText}`);
    }
  } else {
    console.log(`[DEV SMS OTP] User: ${userId} | Phone: ${e164Phone} | Code: ${code}`);
  }

  return `••••${e164Phone.slice(-4)}`;
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
