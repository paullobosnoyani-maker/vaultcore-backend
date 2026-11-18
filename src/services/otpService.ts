import crypto from "crypto";
import pool from "../config/db";

export async function ensureOtpTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_otps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL,
      otp_hash VARCHAR(255) NOT NULL,
      purpose VARCHAR(20) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function hashOtp(email: string, code: string): string {
  return crypto
    .createHash("sha256")
    .update(`${email.toLowerCase().trim()}:${code}:${process.env.JWT_SECRET || "vaultcore-otp"}`)
    .digest("hex");
}

export async function sendEmailOtp(email: string, purpose: "SIGNUP" | "LOGIN"): Promise<void> {
  await ensureOtpTable();
  const normalizedEmail = email.toLowerCase().trim();
  const code = crypto.randomInt(100000, 999999).toString();
  const otpHash = hashOtp(normalizedEmail, code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query("DELETE FROM email_otps WHERE email = $1", [normalizedEmail]);
  await pool.query(
    "INSERT INTO email_otps (email, otp_hash, purpose, expires_at) VALUES ($1, $2, $3, $4)",
    [normalizedEmail, otpHash, purpose, expiresAt]
  );

  const subject =
    purpose === "SIGNUP"
      ? "VaultCore US — Verify Your New Account (6-Digit Code)"
      : "VaultCore US — Your Sign-In Verification Code";

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
      <h2 style="color: #0f172a;">VaultCore US Security Verification</h2>
      <p style="color: #475569; font-size: 14px;">Enter this 6-digit code to complete your ${purpose === "SIGNUP" ? "registration" : "sign-in"}. Expires in 10 minutes.</p>
      <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 16px; text-align: center; margin: 20px 0;">
        <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0f172a; font-family: monospace;">${code}</span>
      </div>
    </div>
  `;

  if (process.env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "VaultCore US <onboarding@resend.dev>",
        to: [normalizedEmail],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const details = await res.text();
      console.error("RESEND FAILED:", res.status, details);
      throw new Error(`Resend error (${res.status}): ${details}`);
    }
  } else {
    console.log(`[DEV OTP] Email: ${normalizedEmail} | Purpose: ${purpose} | Code: ${code}`);
  }
}

export async function verifyEmailOtp(email: string, code: string): Promise<boolean> {
  await ensureOtpTable();
  const normalizedEmail = email.toLowerCase().trim();
  const res = await pool.query(
    "SELECT * FROM email_otps WHERE email = $1 ORDER BY created_at DESC LIMIT 1",
    [normalizedEmail]
  );
  if (res.rows.length === 0) return false;

  const record = res.rows[0];
  if (new Date(record.expires_at) < new Date() || record.attempts >= 5) {
    await pool.query("DELETE FROM email_otps WHERE id = $1", [record.id]);
    return false;
  }

  const submittedHash = hashOtp(normalizedEmail, code.trim());
  if (submittedHash !== record.otp_hash) {
    await pool.query("UPDATE email_otps SET attempts = attempts + 1 WHERE id = $1", [record.id]);
    return false;
  }

  await pool.query("DELETE FROM email_otps WHERE id = $1", [record.id]);
  return true;
}
