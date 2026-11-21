import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../config/db";
import { sendEmailOtp, verifyEmailOtp } from "../services/otpService";

export const registerUser = async (req: Request, res: Response): Promise<void> => {
  const {
    email, password, fullName, phone, dob,
    streetAddress, city, usState, zipCode, businessName, einOrSsn, accountCategory
  } = req.body;

  if (!email || !password || !fullName || !phone || !dob || !streetAddress || !city || !usState || !zipCode || !einOrSsn) {
    res.status(400).json({ error: "All identity, address, phone, DOB, and tax ID fields are required." });
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) {
    res.status(400).json({ error: "Enter a valid 4-digit birth year (YYYY-MM-DD)." });
    return;
  }
  const birthYear = parseInt(String(dob).slice(0, 4), 10);
  const currentYear = new Date().getFullYear();
  if (birthYear < 1920 || birthYear > currentYear - 18) {
    res.status(400).json({ error: "Applicant must be at least 18 years old with a valid 4-digit birth year." });
    return;
  }

  const phoneDigits = String(phone).replace(/\D/g, "");
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    res.status(400).json({ error: "Enter a valid phone number (10 to 15 digits)." });
    return;
  }

  const isPersonal = String(accountCategory || "").toLowerCase() === "personal";
  const taxDigits = String(einOrSsn).replace(/\D/g, "");
  if (taxDigits.length !== 9) {
    res.status(400).json({
      error: isPersonal
        ? "Personal accounts require a valid 9-digit Social Security Number (SSN)."
        : "Business accounts require a valid 9-digit IRS EIN (XX-XXXXXXX).",
    });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const ssnLast4 = taxDigits.slice(-4);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const hashedPassword = await bcrypt.hash(password, 10);

    const userResult = await client.query(
      `INSERT INTO users (
        email, password_hash, kyc_status, role, full_name, phone, dob,
        street_address, city, us_state, zip_code, business_name, ein_or_ssn, ssn_last4
      ) VALUES ($1, $2, 'SUBMITTED', 'USER', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, email, kyc_status, role, full_name, business_name, us_state`,
      [
        normalizedEmail,
        hashedPassword,
        fullName,
        phone.trim(),
        dob,
        streetAddress,
        city,
        usState,
        zipCode,
        businessName || (isPersonal ? `${fullName} (Personal Checkings)` : fullName),
        einOrSsn,
        ssnLast4,
      ]
    );
    const newUser = userResult.rows[0];

    const q = "INSERT INTO accounts (user_id, account_name, account_type, currency) VALUES ($1, $2, $3, 'USD')";
    if (isPersonal) {
      await client.query(q, [newUser.id, "Personal Checkings", "EVERYDAY"]);
      await client.query(q, [newUser.id, "Personal Savings", "SAVINGS_GOAL"]);
    } else {
      await client.query(q, [newUser.id, "Business Checkings", "EVERYDAY"]);
      await client.query(q, [newUser.id, "Business Savings", "SAVINGS_GOAL"]);
      await client.query(q, [newUser.id, "Grant & Loan Reserve", "GRANT_RESERVE"]);
    }
    await client.query("COMMIT");

    await sendEmailOtp(normalizedEmail, "SIGNUP");

    res.status(201).json({
      requiresOtp: true,
      purpose: "SIGNUP",
      email: normalizedEmail,
      message: "6-digit verification code sent to your email."
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      res.status(400).json({ error: "An account with this email already exists." });
    } else {
      res.status(500).json({ error: error.message || "Error provisioning US account." });
    }
  } finally {
    client.release();
  }
};

export const loginUser = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const user = userResult.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }

    await sendEmailOtp(normalizedEmail, "LOGIN");

    res.status(200).json({
      requiresOtp: true,
      purpose: "LOGIN",
      email: normalizedEmail,
      message: "6-digit verification code sent to your email."
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Internal server error during login." });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  const { email, code } = req.body;
  if (!email || !code) {
    res.status(400).json({ error: "Email and 6-digit verification code are required." });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const valid = await verifyEmailOtp(normalizedEmail, String(code).trim());
    if (!valid) {
      res.status(401).json({ error: "Invalid or expired 6-digit verification code." });
      return;
    }

    await pool.query(
      "UPDATE users SET kyc_status = 'VERIFIED' WHERE email = $1 AND kyc_status != 'VERIFIED'",
      [normalizedEmail]
    );

    const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const user = userResult.rows[0];
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: "24h" }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        kyc_status: user.kyc_status,
        role: user.role,
        full_name: user.full_name,
        business_name: user.business_name,
        us_state: user.us_state,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Error verifying code." });
  }
};

export const resendOtp = async (req: Request, res: Response): Promise<void> => {
  const { email, purpose } = req.body;
  if (!email) {
    res.status(400).json({ error: "Email is required." });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const otpPurpose = purpose === "SIGNUP" ? "SIGNUP" : "LOGIN";

  try {
    await sendEmailOtp(normalizedEmail, otpPurpose);
    res.status(200).json({ message: "A new 6-digit verification code has been sent to your email." });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to resend verification code." });
  }
};
