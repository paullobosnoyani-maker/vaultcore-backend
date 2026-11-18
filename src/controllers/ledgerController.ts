import { Request, Response } from "express";
import pool from "../config/db";

export const handleDeposit = async (req: Request, res: Response): Promise<void> => {
    const { accountId, amount, description } = req.body;
    if (!accountId || !amount || amount <= 0) {
        res.status(400).json({ error: "Valid accountId and positive amount are required." });
        return;
    }
    try {
        const result = await pool.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, 'DEPOSIT', $3) RETURNING id, amount, created_at;",
            [accountId, amount, description || "External deposit"]
        );
        res.status(201).json({ message: "Deposit recorded successfully.", transaction: result.rows[0] });
    } catch (error: any) {
        res.status(500).json({ error: "System error recording ledger deposit." });
    }
};

export const handleP2PTransfer = async (req: Request, res: Response): Promise<void> => {
    const { senderAccountId, receiverAccountId, amount, description } = req.body;
    if (!senderAccountId || !receiverAccountId || !amount || amount <= 0) {
        res.status(400).json({ error: "Invalid transfer payload parameters." });
        return;
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const balanceCheck = await client.query(
            "SELECT COALESCE(SUM(amount), 0) as balance FROM ledger WHERE account_id = $1",
            [senderAccountId]
        );
        if (parseFloat(balanceCheck.rows[0].balance) < amount) throw new Error("INSUFFICIENT_FUNDS");

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [senderAccountId, -amount, "P2P_TRANSFER_DEBIT", description || "P2P Outgoing Transfer"]
        );
        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [receiverAccountId, amount, "P2P_TRANSFER_CREDIT", description || "P2P Incoming Funds"]
        );
        await client.query("COMMIT");
        res.status(200).json({ message: "Peer-to-peer ledger settlement complete." });
    } catch (error: any) {
        await client.query("ROLLBACK");
        if (error.message === "INSUFFICIENT_FUNDS") {
            res.status(400).json({ error: "Insufficient ledger funds available." });
        } else {
            res.status(500).json({ error: "System error processing transfer." });
        }
    } finally {
        client.release();
    }
};

export const handleMemberTransfer = async (req: Request, res: Response): Promise<void> => {
    const { senderUserId, recipientEmail, amount, description } = req.body;
    if (!senderUserId || !recipientEmail || !amount || amount <= 0) {
        res.status(400).json({ error: "Valid sender, recipient email, and positive amount are required." });
        return;
    }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const senderWalletReq = await client.query(
            "SELECT id FROM accounts WHERE user_id = $1 AND account_type = 'EVERYDAY' LIMIT 1",
            [senderUserId]
        );
        if (senderWalletReq.rows.length === 0) throw new Error("SENDER_WALLET_NOT_FOUND");
        const senderWalletId = senderWalletReq.rows[0].id;

        const recipientReq = await client.query(
            "SELECT a.id AS wallet_id FROM users u JOIN accounts a ON u.id = a.user_id WHERE u.email = $1 AND a.account_type = 'EVERYDAY' LIMIT 1",
            [recipientEmail.toLowerCase().trim()]
        );
        if (recipientReq.rows.length === 0) throw new Error("RECIPIENT_NOT_FOUND");
        const recipientWalletId = recipientReq.rows[0].wallet_id;

        if (senderWalletId === recipientWalletId) throw new Error("SELF_TRANSFER");

        const balanceReq = await client.query(
            "SELECT COALESCE(SUM(amount), 0) as balance FROM ledger WHERE account_id = $1",
            [senderWalletId]
        );
        if (parseFloat(balanceReq.rows[0].balance) < amount) throw new Error("INSUFFICIENT_FUNDS");

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [senderWalletId, -amount, "MEMBER_P2P_DEBIT", description || `Sent to ${recipientEmail}`]
        );
        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [recipientWalletId, amount, "MEMBER_P2P_CREDIT", description || "Member P2P Received"]
        );
        await client.query("COMMIT");
        res.status(200).json({ message: `Sent $${amount} to ${recipientEmail} successfully!` });
    } catch (error: any) {
        await client.query("ROLLBACK");
        if (error.message === "RECIPIENT_NOT_FOUND") {
            res.status(404).json({ error: "Recipient email not found on platform." });
        } else if (error.message === "INSUFFICIENT_FUNDS") {
            res.status(400).json({ error: "Insufficient funds in your Everyday Wallet." });
        } else if (error.message === "SELF_TRANSFER") {
            res.status(400).json({ error: "Cannot send member transfer to yourself." });
        } else {
            res.status(500).json({ error: "System error processing member transfer." });
        }
    } finally {
        client.release();
    }
};

export const getUserDashboard = async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;
    try {
        let walletsResult = await pool.query(
            "SELECT a.id, a.account_name, a.account_type, a.currency, COALESCE(SUM(l.amount), 0) AS balance FROM accounts a LEFT JOIN ledger l ON a.id = l.account_id WHERE a.user_id = $1 GROUP BY a.id, a.account_name, a.account_type, a.currency ORDER BY a.created_at ASC;",
            [userId]
        );

        if (walletsResult.rows.length === 0) {
            await pool.query(
                `INSERT INTO accounts (user_id, account_name, account_type, currency) VALUES
                 ($1, 'Everyday Operating Checking', 'EVERYDAY', 'USD'),
                 ($1, 'Payroll & Tax Reserve', 'RESERVE', 'USD'),
                 ($1, 'Treasury Yield Reserve', 'TREASURY', 'USD')`,
                [userId]
            );
            walletsResult = await pool.query(
                "SELECT a.id, a.account_name, a.account_type, a.currency, COALESCE(SUM(l.amount), 0) AS balance FROM accounts a LEFT JOIN ledger l ON a.id = l.account_id WHERE a.user_id = $1 GROUP BY a.id, a.account_name, a.account_type, a.currency ORDER BY a.created_at ASC;",
                [userId]
            );
        }

        const transactionsResult = await pool.query(
            "SELECT l.id, a.account_name, l.amount, l.transaction_type, l.description, l.created_at FROM ledger l JOIN accounts a ON l.account_id = a.id WHERE a.user_id = $1 ORDER BY l.created_at DESC LIMIT 10;",
            [userId]
        );
        res.status(200).json({ wallets: walletsResult.rows, recentTransactions: transactionsResult.rows });
    } catch (error: any) {
        console.error("Dashboard error:", error);
        res.status(500).json({ error: "System error loading dashboard data." });
    }
};
