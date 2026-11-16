import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware";
import pool from "../config/db";

export const submitFundingApplication = async (req: AuthRequest, res: Response): Promise<void> => {
    const { userId, fullName, ssnLast4, usState, fundingType, amount, purpose } = req.body;
    if (!userId || !fullName || !ssnLast4 || !usState || !fundingType || !amount || !purpose) {
        res.status(400).json({ error: "All US KYC and funding application fields are required." });
        return;
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            "UPDATE users SET full_name = $1, ssn_last4 = $2, us_state = $3 WHERE id = $4",
            [fullName, ssnLast4, usState, userId]
        );
        const appRes = await client.query(
            "INSERT INTO funding_applications (user_id, funding_type, amount, purpose) VALUES ($1, $2, $3, $4) RETURNING *",
            [userId, fundingType, amount, purpose]
        );
        await client.query("COMMIT");
        res.status(201).json({ message: "US KYC & Funding application submitted for review!", application: appRes.rows[0] });
    } catch (error: any) {
        await client.query("ROLLBACK");
        res.status(500).json({ error: "Failed to submit funding application." });
    } finally {
        client.release();
    }
};

export const getFundingApplications = async (req: AuthRequest, res: Response): Promise<void> => {
    try {
        const isAdmin = req.user?.role === "ADMIN";
        const query = isAdmin
            ? "SELECT f.*, u.email, u.full_name, u.us_state, u.ssn_last4, u.kyc_status FROM funding_applications f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC"
            : "SELECT f.*, u.email, u.full_name, u.us_state, u.ssn_last4, u.kyc_status FROM funding_applications f JOIN users u ON f.user_id = u.id WHERE f.user_id = $1 ORDER BY f.created_at DESC";
        const result = await pool.query(query, isAdmin ? [] : [req.user?.userId]);
        res.status(200).json({ applications: result.rows });
    } catch (error: any) {
        res.status(500).json({ error: "Failed to load funding applications." });
    }
};

export const approveFundingApplication = async (req: AuthRequest, res: Response): Promise<void> => {
    if (req.user?.role !== "ADMIN") {
        res.status(403).json({ error: "Forbidden: Only ADMIN underwriters can approve and disburse funds." });
        return;
    }

    const { applicationId } = req.body;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const appRes = await client.query("SELECT * FROM funding_applications WHERE id = $1 FOR UPDATE", [applicationId]);
        if (appRes.rows.length === 0) throw new Error("APPLICATION_NOT_FOUND");
        const app = appRes.rows[0];
        if (app.status === "APPROVED") throw new Error("ALREADY_APPROVED");

        await client.query("UPDATE funding_applications SET status = 'APPROVED' WHERE id = $1", [applicationId]);
        await client.query("UPDATE users SET kyc_status = 'VERIFIED' WHERE id = $1", [app.user_id]);

        const walletRes = await client.query(
            "SELECT id FROM accounts WHERE user_id = $1 AND account_type = 'GRANT_RESERVE' LIMIT 1",
            [app.user_id]
        );
        if (walletRes.rows.length === 0) throw new Error("RESERVE_WALLET_NOT_FOUND");

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [walletRes.rows[0].id, app.amount, `${app.funding_type}_DISBURSEMENT`, `Approved ${app.funding_type}: ${app.purpose}`]
        );

        await client.query("COMMIT");
        res.status(200).json({ message: `Approved & disbursed $${app.amount} USD to Grant & Loan Reserve!` });
    } catch (error: any) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: error.message });
    } finally {
        client.release();
    }
};
