import { Request, Response } from "express";
import pool from "../config/db";
import { sendWireSmsOtp, verifyWireSmsOtp } from "../services/smsOtpService";

function generateVirtualAccountNumber(seed: string): string {
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
    const part1 = String(Math.abs(h1) % 900000 + 100000).padStart(6, "0");
    const part2 = String(Math.abs(h2) % 900000 + 100000).padStart(6, "0");
    return `88${part1.slice(0, 5)}${part2.slice(0, 5)}`;
}

async function ensureLedgerTable(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ledger (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            amount NUMERIC(15, 2) NOT NULL,
            transaction_type VARCHAR(50) NOT NULL,
            description TEXT,
            reference_id VARCHAR(255),
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);
}

export const handleDeposit = async (req: Request, res: Response): Promise<void> => {
    const { accountId, amount, description } = req.body;
    const numericAmount = parseFloat(amount);
    if (!accountId || isNaN(numericAmount) || numericAmount <= 0) {
        res.status(400).json({ error: "Valid accountId and positive amount are required." });
        return;
    }
    try {
        await ensureLedgerTable();
        const result = await pool.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, 'DEPOSIT', $3) RETURNING id, amount, created_at;",
            [accountId, numericAmount, description || "External deposit"]
        );
        res.status(201).json({ message: "Deposit recorded successfully.", transaction: result.rows[0] });
    } catch (error: any) {
        res.status(500).json({ error: "System error recording ledger deposit." });
    }
};

export const handleP2PTransfer = async (req: Request, res: Response): Promise<void> => {
    const { senderAccountId, receiverAccountId, amount, description } = req.body;
    const numericAmount = parseFloat(amount);

    if (!senderAccountId || !receiverAccountId || isNaN(numericAmount) || numericAmount <= 0) {
        res.status(400).json({ error: "Select both source and destination accounts and enter a valid amount." });
        return;
    }
    if (senderAccountId === receiverAccountId) {
        res.status(400).json({ error: "Source and destination sub-accounts must be different." });
        return;
    }

    const client = await pool.connect();
    try {
        await ensureLedgerTable();
        await client.query("BEGIN");

        const balanceCheck = await client.query(
            "SELECT COALESCE(SUM(amount), 0) as balance FROM ledger WHERE account_id = $1",
            [senderAccountId]
        );
        const available = parseFloat(balanceCheck.rows[0]?.balance || "0");
        if (available < numericAmount) {
            throw new Error("INSUFFICIENT_FUNDS");
        }

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [senderAccountId, -numericAmount, "INTERNAL_REBALANCE_DEBIT", description || "Internal Sub-Account Rebalance (Out)"]
        );
        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [receiverAccountId, numericAmount, "INTERNAL_REBALANCE_CREDIT", description || "Internal Sub-Account Rebalance (In)"]
        );

        await client.query("COMMIT");
        res.status(200).json({ message: `Transferred $${numericAmount.toFixed(2)} USD between sub-accounts!` });
    } catch (error: any) {
        await client.query("ROLLBACK");
        if (error.message === "INSUFFICIENT_FUNDS") {
            res.status(400).json({ error: "Insufficient balance in the selected source sub-account." });
        } else {
            console.error("Internal transfer error:", error.message);
            res.status(500).json({ error: `System error processing transfer: ${error.message}` });
        }
    } finally {
        client.release();
    }
};
export const requestWireSmsOtp = async (req: Request, res: Response): Promise<void> => {
    const { senderUserId, recipientIdentifier, amount } = req.body;
    const numericAmount = parseFloat(amount);

    if (!senderUserId || !recipientIdentifier || isNaN(numericAmount) || numericAmount <= 0) {
        res.status(400).json({ error: "Enter a recipient account number or email and a valid USD amount first." });
        return;
    }

    try {
        const senderRes = await pool.query("SELECT id, email, phone FROM users WHERE id = $1 LIMIT 1", [senderUserId]);
        if (senderRes.rows.length === 0) {
            res.status(404).json({ error: "Sender account not found." });
            return;
        }
        const sender = senderRes.rows[0];
        if (!sender.phone) {
            res.status(400).json({ error: "No phone number registered on your profile for SMS OTP." });
            return;
        }

        const cleanTarget = String(recipientIdentifier).trim().toLowerCase();
        const usersRes = await pool.query("SELECT id, email, full_name, business_name FROM users");
        const recipient = usersRes.rows.find(
            (u: any) => u.email.toLowerCase() === cleanTarget || generateVirtualAccountNumber(u.email) === cleanTarget
        );

        if (!recipient) {
            res.status(404).json({ error: "No VaultCore account matches that 12-digit account number or email." });
            return;
        }
        if (recipient.id === sender.id) {
            res.status(400).json({ error: "Cannot send a member wire to your own account." });
            return;
        }

        const maskedPhone = await sendWireSmsOtp(sender.id, sender.phone, numericAmount);
        res.status(200).json({
            message: `6-digit SMS security code sent to ${maskedPhone}.`,
            recipientLabel: recipient.business_name || recipient.full_name || recipient.email,
        });
    } catch (error: any) {
        console.error("SMS OTP error:", error.message);
        res.status(500).json({ error: error.message || "Failed to send SMS verification code." });
    }
};

export const handleMemberTransfer = async (req: Request, res: Response): Promise<void> => {
    const { senderUserId, recipientEmail, recipientIdentifier, smsCode, amount, description } = req.body;
    const targetInput = String(recipientIdentifier || recipientEmail || "").trim().toLowerCase();
    const numericAmount = parseFloat(amount);

    if (!senderUserId || !targetInput || isNaN(numericAmount) || numericAmount <= 0) {
        res.status(400).json({ error: "Valid sender, recipient account number or email, and amount are required." });
        return;
    }
    if (!smsCode || String(smsCode).trim().length !== 6) {
        res.status(400).json({ error: "Enter the 6-digit SMS verification code sent to your phone." });
        return;
    }

    const isOtpValid = await verifyWireSmsOtp(senderUserId, String(smsCode));
    if (!isOtpValid) {
        res.status(401).json({ error: "Invalid or expired 6-digit SMS code. Please request a new code." });
        return;
    }

    const client = await pool.connect();
    try {
        await ensureLedgerTable();
        await client.query("BEGIN");

        const senderWalletReq = await client.query(
            "SELECT id FROM accounts WHERE user_id = $1 AND account_type = 'EVERYDAY' LIMIT 1",
            [senderUserId]
        );
        if (senderWalletReq.rows.length === 0) throw new Error("SENDER_WALLET_NOT_FOUND");
        const senderWalletId = senderWalletReq.rows[0].id;

        const usersRes = await client.query("SELECT id, email, business_name, full_name FROM users");
        const matchedUser = usersRes.rows.find(
            (u: any) => u.email.toLowerCase() === targetInput || generateVirtualAccountNumber(u.email) === targetInput
        );
        if (!matchedUser) throw new Error("RECIPIENT_NOT_FOUND");

        const recipientReq = await client.query(
            "SELECT id AS wallet_id FROM accounts WHERE user_id = $1 AND account_type = 'EVERYDAY' LIMIT 1",
            [matchedUser.id]
        );
        if (recipientReq.rows.length === 0) throw new Error("RECIPIENT_NOT_FOUND");
        const recipientWalletId = recipientReq.rows[0].wallet_id;

        if (senderWalletId === recipientWalletId) throw new Error("SELF_TRANSFER");

        const balanceReq = await client.query(
            "SELECT COALESCE(SUM(amount), 0) as balance FROM ledger WHERE account_id = $1",
            [senderWalletId]
        );
        if (parseFloat(balanceReq.rows[0]?.balance || "0") < numericAmount) throw new Error("INSUFFICIENT_FUNDS");

        const acctNum = generateVirtualAccountNumber(matchedUser.email);
        const recipientDisplay = matchedUser.business_name || matchedUser.full_name || matchedUser.email;

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [senderWalletId, -numericAmount, "MEMBER_WIRE_DEBIT", description || `Wire to ${recipientDisplay} (Acct #${acctNum})`]
        );
        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description) VALUES ($1, $2, $3, $4)",
            [recipientWalletId, numericAmount, "MEMBER_WIRE_CREDIT", description || `Incoming Member Wire (Acct #${acctNum})`]
        );
        await client.query("COMMIT");
        res.status(200).json({
            message: `SMS Verified: Sent $${numericAmount.toFixed(2)} USD to ${recipientDisplay} (Acct #${acctNum})!`,
        });
    } catch (error: any) {
        await client.query("ROLLBACK");
        if (error.message === "RECIPIENT_NOT_FOUND") {
            res.status(404).json({ error: "Recipient account number or email not found on VaultCore US." });
        } else if (error.message === "INSUFFICIENT_FUNDS") {
            res.status(400).json({ error: "Insufficient funds in your Everyday Wallet." });
        } else if (error.message === "SELF_TRANSFER") {
            res.status(400).json({ error: "Cannot send a wire transfer to yourself." });
        } else {
            res.status(500).json({ error: "System error processing wire transfer." });
        }
    } finally {
        client.release();
    }
};

export const getUserDashboard = async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;
    try {
        await ensureLedgerTable();
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
            "SELECT l.id, l.amount, l.transaction_type, l.description, l.created_at, a.account_name FROM ledger l JOIN accounts a ON l.account_id = a.id WHERE a.user_id = $1 ORDER BY l.created_at DESC LIMIT 25;",
            [userId]
        );

        res.status(200).json({
            wallets: walletsResult.rows,
            recentTransactions: transactionsResult.rows,
        });
    } catch (error: any) {
        console.error("Dashboard fetch error:", error.message);
        res.status(500).json({ error: "Error loading treasury dashboard." });
    }
};
