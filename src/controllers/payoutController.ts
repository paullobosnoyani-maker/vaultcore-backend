import { Response } from "express";
import { AuthRequest } from "../middleware/authMiddleware";
import pool from "../config/db";

export const requestAchWithdrawal = async (req: AuthRequest, res: Response): Promise<void> => {
    const { bankName, routingNumber, accountNumber, amount } = req.body;
    const userId = req.user?.userId;

    if (!userId || !bankName || !routingNumber || !accountNumber || !amount || amount <= 0) {
        res.status(400).json({ error: "All US bank payout fields and a positive amount are required." });
        return;
    }

    if (!/^\d{9}$/.test(routingNumber)) {
        res.status(400).json({ error: "Invalid US ABA routing number. Must be exactly 9 digits." });
        return;
    }

    if (accountNumber.length < 4) {
        res.status(400).json({ error: "Invalid US bank account number." });
        return;
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const walletRes = await client.query(
            "SELECT id FROM accounts WHERE user_id = $1 AND account_type = 'EVERYDAY' LIMIT 1",
            [userId]
        );
        if (walletRes.rows.length === 0) throw new Error("WALLET_NOT_FOUND");
        const walletId = walletRes.rows[0].id;

        const balanceRes = await client.query(
            "SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger WHERE account_id = $1",
            [walletId]
        );
        if (parseFloat(balanceRes.rows[0].balance) < amount) {
            throw new Error("INSUFFICIENT_FUNDS");
        }

        const last4 = accountNumber.slice(-4);

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [walletId, -amount, "ACH_WITHDRAWAL_DEBIT", `ACH Payout to ${bankName} (****${last4})`]
        );

        await client.query(
            "INSERT INTO payouts (user_id, bank_name, routing_number, account_last4, amount, status) VALUES ($1, $2, $3, $4, $5, 'INITIATED')",
            [userId, bankName, routingNumber, last4, amount]
        );

        await client.query("COMMIT");
        res.status(200).json({ message: `ACH withdrawal of $${parseFloat(amount).toFixed(2)} initiated to ${bankName} (****${last4})!` });
    } catch (error: any) {
        await client.query("ROLLBACK");
        if (error.message === "INSUFFICIENT_FUNDS") {
            res.status(400).json({ error: "Insufficient balance in your Everyday Wallet." });
        } else {
            res.status(500).json({ error: "System error initiating ACH payout." });
        }
    } finally {
        client.release();
    }
};
