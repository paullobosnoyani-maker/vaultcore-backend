import { Request, Response } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../config/db";

export const registerUser = async (req: Request, res: Response): Promise<void> => {
    const {
        email, password, fullName, phone, dob,
        streetAddress, city, usState, zipCode, businessName, einOrSsn
    } = req.body;

    if (!email || !password || !fullName || !dob || !streetAddress || !city || !usState || !zipCode || !einOrSsn) {
        res.status(400).json({ error: "All US CIP identity, address, DOB, and SSN/EIN fields are required." });
        return;
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const hashedPassword = await bcrypt.hash(password, 10);
        const ssnLast4 = einOrSsn.replace(/\D/g, "").slice(-4);

        const userResult = await client.query(
            `INSERT INTO users (
                email, password_hash, kyc_status, role, full_name, phone, dob,
                street_address, city, us_state, zip_code, business_name, ein_or_ssn, ssn_last4
            ) VALUES ($1, $2, 'SUBMITTED', 'USER', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id, email, kyc_status, role, full_name, business_name, us_state;`,
            [email.toLowerCase().trim(), hashedPassword, fullName, phone || "", dob, streetAddress, city, usState, zipCode, businessName || fullName, einOrSsn, ssnLast4]
        );
        const newUser = userResult.rows[0];

        const q = "INSERT INTO accounts (user_id, account_name, account_type, currency) VALUES ($1, $2, $3, 'USD');";
        await client.query(q, [newUser.id, "Everyday Wallet", "EVERYDAY"]);
        await client.query(q, [newUser.id, "Target Savings Goal", "SAVINGS_GOAL"]);
        await client.query(q, [newUser.id, "Grant & Loan Reserve", "GRANT_RESERVE"]);
        await client.query("COMMIT");

        const token = jwt.sign(
            { userId: newUser.id, email: newUser.email, role: newUser.role },
            process.env.JWT_SECRET as string,
            { expiresIn: "2h" }
        );
        res.status(201).json({ message: "US Treasury Account provisioned!", token, user: newUser });
    } catch (error: any) {
        await client.query("ROLLBACK");
        if (error.code === "23505") {
            res.status(400).json({ error: "An account with this email already exists." });
        } else {
            res.status(500).json({ error: "Error provisioning US account." });
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
    try {
        const userResult = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase().trim()]);
        const user = userResult.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            res.status(401).json({ error: "Invalid email or password." });
            return;
        }
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET as string,
            { expiresIn: "2h" }
        );
        res.status(200).json({
            message: "Login successful.",
            token,
            user: { id: user.id, email: user.email, kyc_status: user.kyc_status, role: user.role, full_name: user.full_name, business_name: user.business_name }
        });
    } catch (error: any) {
        res.status(500).json({ error: "Internal server error during login." });
    }
};
