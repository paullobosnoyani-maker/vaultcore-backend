import crypto from "crypto";
import { Resend } from "resend";
import pool from "../config/db";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = "VaultCore US <security@vaultcoreus.com>";
const LOGO_URL = "https://vaultcoreus.com";

function generateUniqueAccountNumber(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  const clean = (seed || "vaultcore-default").toLowerCase().trim();
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const part1 = String((Math.abs(h1) % 900000) + 100000).padStart(6, "0");
  const part2 = String((Math.abs(h2) % 900000) + 100000).padStart(6, "0");
  return `88${part1.slice(0, 5)}${part2.slice(0, 5)}`;
}

async function ensureOtpTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_otps (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'LOGIN',
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE email_otps
    ADD COLUMN IF NOT EXISTS code TEXT,
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'LOGIN',
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'email_otps' AND column_name = 'otp_hash'
      ) THEN
        ALTER TABLE email_otps ALTER COLUMN otp_hash DROP NOT NULL;
      END IF;
    END $$;
  `);
}


export async function sendEmailOtp(email: string, purpose: "SIGNUP" | "LOGIN"): Promise<void> {
  await ensureOtpTable();
  const normalizedEmail = email.toLowerCase().trim();
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query("UPDATE email_otps SET used = TRUE WHERE email = $1 AND used = FALSE", [normalizedEmail]);
  await pool.query(
    "INSERT INTO email_otps (email, code, purpose, expires_at) VALUES ($1, $2, $3, $4)",
    [normalizedEmail, code, purpose, expiresAt]
  );

  const isSignup = purpose === "SIGNUP";
  const subject = isSignup
    ? `${code} is your VaultCore US Account Verification Code`
    : `${code} is your VaultCore US Sign-In Security Code`;

  const headline = isSignup
    ? "Verify Your VaultCore US Application"
    : "Two-Factor Sign-In Security Alert";

  const introText = isSignup
    ? "Thank you for opening an account with VaultCore US. Enter the one-time security code below to verify your email address and activate your FDIC-insured custodial accounts."
    : "A sign-in attempt was initiated for your VaultCore US banking profile. Enter the one-time security code below to complete authentication.";

  const timestamp = new Date().toUTCString();

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:0;background-color:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0;box-shadow:0 4px 20px rgba(15,23,42,0.06);">
            <tr>
              <td style="background-color:#0A0F1C;padding:24px 32px;border-bottom:3px solid #D4AF37;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <img src="${LOGO_URL}" alt="VaultCore US" width="42" height="42" style="border-radius:10px;vertical-align:middle;border:1px solid #D4AF37;" />
                      <span style="color:#FFFFFF;font-size:20px;font-weight:800;letter-spacing:-0.3px;vertical-align:middle;margin-left:12px;">VaultCore <span style="color:#D4AF37;">US</span></span>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      <span style="background-color:#1E293B;color:#94A3B8;font-size:11px;font-weight:700;padding:5px 10px;border-radius:999px;letter-spacing:0.5px;">SECURITY ALERT</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;color:#0F172A;font-size:22px;font-weight:800;">${headline}</h1>
                <p style="margin:0 0 24px;color:#475569;font-size:14px;line-height:1.6;">${introText}</p>
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#FFF1F2;border:1px solid #FECDD3;border-radius:12px;margin-bottom:24px;">
                  <tr>
                    <td align="center" style="padding:24px;">
                      <div style="font-size:11px;font-weight:700;color:#9F1239;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:8px;">One-Time Verification Code</div>
                      <div style="font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:800;color:#0F172A;letter-spacing:8px;">${code}</div>
                      <div style="font-size:12px;color:#64748B;margin-top:8px;">Expires in <strong>10 minutes</strong> &bull; Do not share this code</div>
                    </td>
                  </tr>
                </table>
                <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;margin-bottom:20px;">
                  <tr>
                    <td style="padding:14px 18px;font-size:12px;color:#475569;line-height:1.6;">
                      <strong>Account:</strong> ${normalizedEmail}<br />
                      <strong>Timestamp:</strong> ${timestamp}<br />
                      <strong>Protection:</strong> 256-Bit TLS &bull; USA PATRIOT Act CIP Monitored
                    </td>
                  </tr>
                </table>
                <p style="margin:0;color:#64748B;font-size:12px;line-height:1.5;">
                  VaultCore US staff will <strong>never</strong> call, text, or email asking for your 6-digit code or password. If you did not request this code, please secure your account immediately.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background-color:#F8FAFC;padding:18px 32px;border-top:1px solid #E2E8F0;text-align:center;font-size:11px;color:#64748B;">
                VaultCore US Financial Technologies &bull; Custodial deposits held at FDIC-insured partner banks &bull; ABA 021000021
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

  await resend.emails.send({
    from: FROM_EMAIL,
    to: normalizedEmail,
    subject,
    html,
  });
}

export async function verifyEmailOtp(email: string, code: string): Promise<"SIGNUP" | "LOGIN" | null> {
  await ensureOtpTable();
  const normalizedEmail = email.toLowerCase().trim();
  const res = await pool.query(
    `SELECT id, purpose FROM email_otps
     WHERE email = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [normalizedEmail, code.trim()]
  );
  if (res.rows.length === 0) return null;

  await pool.query("UPDATE email_otps SET used = TRUE WHERE id = $1", [res.rows.id]);
  return res.rows.purpose === "SIGNUP" ? "SIGNUP" : "LOGIN";
}

export async function sendWelcomeEmail(user: {
  email: string;
  full_name?: string;
  business_name?: string;
}): Promise<void> {
  const normalizedEmail = user.email.toLowerCase().trim();
  const displayName = user.full_name || user.business_name || "Valued Client";
  const isPersonal = String(user.business_name || "").toLowerCase().includes("personal");
  const virtualAccountNumber = generateUniqueAccountNumber(`:${normalizedEmail}`);

  const accountsListHtml = isPersonal
    ? `<tr><td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#0F172A;font-weight:700;">Personal Checkings (USD)</td><td align="right" style="padding:10px 14px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#059669;font-weight:700;">ACTIVE</td></tr>
       <tr><td style="padding:10px 14px;font-size:13px;color:#0F172A;font-weight:700;">Personal Savings (USD)</td><td align="right" style="padding:10px 14px;font-size:12px;color:#059669;font-weight:700;">ACTIVE</td></tr>`
    : `<tr><td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#0F172A;font-weight:700;">Business Checkings (USD)</td><td align="right" style="padding:10px 14px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#059669;font-weight:700;">ACTIVE</td></tr>
       <tr><td style="padding:10px 14px;border-bottom:1px solid #E2E8F0;font-size:13px;color:#0F172A;font-weight:700;">Business Savings (USD)</td><td align="right" style="padding:10px 14px;border-bottom:1px solid #E2E8F0;font-size:12px;color:#059669;font-weight:700;">ACTIVE</td></tr>
       <tr><td style="padding:10px 14px;font-size:13px;color:#0F172A;font-weight:700;">Grant &amp; Loan Reserve (USD)</td><td align="right" style="padding:10px 14px;font-size:12px;color:#059669;font-weight:700;">ACTIVE</td></tr>`;

  const html = `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background-color:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;padding:32px 16px;">
      <tr>
        <td align="center">
          <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:18px;overflow:hidden;border:1px solid #E2E8F0;">
            <tr>
              <td style="background:linear-gradient(135deg,#0A0F1C 0%,#1E1B4B 55%,#881337 100%);padding:32px;border-bottom:3px solid #D4AF37;">
                <img src="${LOGO_URL}" alt="VaultCore US" width="48" height="48" style="border-radius:12px;vertical-align:middle;border:2px solid #D4AF37;" />
                <span style="color:#FFFFFF;font-size:22px;font-weight:800;vertical-align:middle;margin-left:12px;">VaultCore <span style="color:#D4AF37;">US</span></span>
                <span style="float:right;background-color:#10B981;color:#052E16;font-size:11px;font-weight:800;padding:6px 12px;border-radius:999px;">CIP VERIFIED</span>
                <h1 style="margin:24px 0 8px;color:#FFFFFF;font-size:25px;font-weight:800;">Welcome to VaultCore US, ${displayName}!</h1>
                <p style="margin:0;color:#E2E8F0;font-size:14px;line-height:1.6;">Your US banking profile is verified and your accounts are ready for ACH, Fedwire, and Visa card issuance.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <div style="background:linear-gradient(135deg,#FFF1F2 0%,#FEF3C7 100%);border:1px solid #FDE68A;border-radius:14px;padding:20px 24px;margin-bottom:24px;">
                  <div style="font-size:11px;font-weight:800;color:#9F1239;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Your US Routing &amp; Account Credentials</div>
                  <div style="font-size:13px;color:#0F172A;line-height:1.8;">
                    <strong>ABA Routing Number:</strong> <span style="font-family:monospace;">021000021</span><br />
                    <strong>Virtual Account Number:</strong> <span style="font-family:monospace;color:#9F1239;font-weight:800;">${virtualAccountNumber}</span><br />
                    <strong>Partner Bank:</strong> Evolve Bank &amp; Trust / JPMorgan
                  </div>
                </div>
                <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;margin-bottom:28px;">
                  ${accountsListHtml}
                </table>
                <div style="text-align:center;">
                  <a href="https://vaultcoreus.com" style="display:inline-block;background-color:#9F1239;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:700;padding:14px 32px;border-radius:12px;">Open Your VaultCore US Dashboard &rarr;</a>
                </div>
              </td>
            </tr>
            <tr>
              <td style="background-color:#0A0F1C;padding:18px 32px;text-align:center;font-size:11px;color:#94A3B8;">
                VaultCore US Financial Technologies &bull; Custodial deposits swept up to $2,500,000 FDIC coverage.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;

    await resend.emails.send({
    from: FROM_EMAIL,
    to: normalizedEmail,
    subject: "Welcome to VaultCore US — Your " + (isPersonal ? "Personal" : "Commercial") + " Accounts Are Active",
    html,
  });
}



