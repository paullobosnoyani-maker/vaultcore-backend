import { Request, Response } from "express";
import pool from "../config/db";
import { sendWireSmsOtp, verifyWireSmsOtp } from "../services/smsOtpService";

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

export const requestWireSmsOtp = async (req: Request, res: Response): Promise<void> => {
  const userId = (req as any).user?.id || (req as any).user?.userId;
  const { amount } = req.body;
  const parsedAmount = parseFloat(amount || "0");

  if (!userId) {
    res.status(401).json({ error: "Unauthorized session." });
    return;
  }

  try {
    const uRes = await pool.query("SELECT email, phone FROM users WHERE id = $1 LIMIT 1", [userId]);
    const user = uRes.rows.at(0);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }

      const destination = await sendWireSmsOtp(
      userId,
      user.phone || "",
      parsedAmount > 0 ? parsedAmount : 1
    );


      res.status(200).json({
      channel: destination.startsWith("SMS") ? "SMS" : "EMAIL",
      maskedTarget: destination,
      message: `6-digit wire authorization code sent to ${destination}.`,
    });

  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to send wire security code." });
  }
};

export const handleDeposit = async (req: Request, res: Response): Promise<void> => {
  const { accountId, amount, description } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!accountId || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "Invalid accountId or deposit amount." });
    return;
  }

  try {
    const result = await pool.query(
      `INSERT INTO ledger (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'DEPOSIT', $3) RETURNING *`,
      [accountId, parsedAmount, description || "ACH / Wire Deposit"]
    );
    res.status(201).json({ message: "Deposit settled", transaction: result.rows.at(0) });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Error processing deposit." });
  }
};

export const handleP2PTransfer = async (req: Request, res: Response): Promise<void> => {
  const fromAccountId =
    req.body.fromAccountId ||
    req.body.senderAccountId ||
    req.body.senderId ||
    req.body.fromWalletId ||
    req.body.sourceAccountId;
  const toAccountId =
    req.body.toAccountId ||
    req.body.receiverAccountId ||
    req.body.receiverId ||
    req.body.toWalletId ||
    req.body.destinationAccountId;
  const { amount, description } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "Invalid source, destination, or transfer amount." });
    return;
  }




  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const balRes = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger WHERE account_id = $1",
      [fromAccountId]
    );
    const currentBalance = parseFloat(balRes.rows.at(0)?.balance || "0");

    if (currentBalance < parsedAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Insufficient funds in source wallet." });
      return;
    }

    await client.query(
      `INSERT INTO ledger (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'INTERNAL_TRANSFER_OUT', $3)`,
      [fromAccountId, -parsedAmount, description || "Internal Sub-Account Rebalance"]
    );

    await client.query(
      `INSERT INTO ledger (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'INTERNAL_TRANSFER_IN', $3)`,
      [toAccountId, parsedAmount, description || "Internal Sub-Account Rebalance"]
    );

    await client.query("COMMIT");
    res.status(200).json({ message: `Transferred $${parsedAmount.toFixed(2)} USD between accounts.` });
  } catch (error: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Internal transfer failed." });
  } finally {
    client.release();
  }
};
export const handleMemberTransfer = async (req: Request, res: Response): Promise<void> => {
  const { fromAccountId, senderUserId, recipientIdentifier, amount, description, otpCode, smsCode } = req.body;
  const parsedAmount = parseFloat(amount);
  const senderId = (req as any).user?.id || (req as any).user?.userId || senderUserId;
  const verificationCode = smsCode || otpCode;

  if (!recipientIdentifier || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "Recipient identifier and a valid amount are required." });
    return;
  }

  if (!senderId) {
    res.status(401).json({ error: "Unauthorized session." });
    return;
  }

  if (!verificationCode) {
    res.status(400).json({ error: "6-digit wire verification code is required." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const valid = await verifyWireSmsOtp(senderId, String(verificationCode).trim());
    if (!valid) {
      await client.query("ROLLBACK");
      res.status(401).json({ error: "Invalid or expired 6-digit wire security code." });
      return;
    }

    let resolvedFromAccountId = fromAccountId;
    if (!resolvedFromAccountId) {
      const srcAccRes = await client.query(
        `SELECT id FROM accounts
         WHERE user_id = $1
         ORDER BY CASE WHEN account_type = 'EVERYDAY' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`,
        [senderId]
      );
      resolvedFromAccountId = srcAccRes.rows.at(0)?.id;
    }

    if (!resolvedFromAccountId) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "No active source checking account found for sender." });
      return;
    }

    const balRes = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger WHERE account_id = $1",
      [resolvedFromAccountId]
    );
    const currentBalance = parseFloat(balRes.rows.at(0)?.balance || "0");
    if (currentBalance < parsedAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Insufficient funds in source wallet." });
      return;
    }

    const cleanRecipient = String(recipientIdentifier).trim();
    const isAcctNum = /^\d{12}$/.test(cleanRecipient);
    let targetUser: any = null;

      if (isAcctNum) {
      const allUsers = await client.query("SELECT id, email, full_name, business_name FROM users");
      targetUser = allUsers.rows.find(
        (u: any) =>
          generateUniqueAccountNumber(`${u.id}:${u.email}`) === cleanRecipient ||
          generateUniqueAccountNumber(`:${u.email}`) === cleanRecipient
      );
    } else {

      const uRes = await client.query(
        "SELECT id, email, full_name, business_name FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1",
        [cleanRecipient]
      );
      targetUser = uRes.rows.at(0);
    }

    if (!targetUser) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "No verified VaultCore US recipient found for that Account Number or email." });
      return;
    }

    const destAccRes = await client.query(
      "SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [targetUser.id]
    );
    const destAccountId = destAccRes.rows.at(0)?.id;
    if (!destAccountId) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Recipient does not have an active receiving account." });
      return;
    }

    const recipientLabel = targetUser.full_name || targetUser.business_name || targetUser.email;

    await client.query(
      `INSERT INTO ledger (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'WIRE_TRANSFER_OUT', $3)`,
            [resolvedFromAccountId, -parsedAmount, description || `Wire Transfer to ${recipientLabel} (${cleanRecipient})`]
    );

    await client.query(
      `INSERT INTO ledger (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'WIRE_TRANSFER_IN', $3)`,
      [destAccountId, parsedAmount, description || `Incoming Wire Transfer (${cleanRecipient})`]
    );

    await client.query("COMMIT");
    res.status(200).json({
      message: `Instant wire of $${parsedAmount.toFixed(2)} USD settled to ${recipientLabel}.`,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Wire transfer failed." });
  } finally {
    client.release();
  }
};

export const getUserDashboard = async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  try {
    const walletsResult = await pool.query(
      `SELECT a.id, a.account_name, a.account_type, a.currency,
              COALESCE(SUM(l.amount), 0) AS balance
       FROM accounts a
       LEFT JOIN ledger l ON a.id = l.account_id
       WHERE a.user_id = $1
       GROUP BY a.id, a.account_name, a.account_type, a.currency, a.created_at
       ORDER BY a.created_at ASC`,
      [userId]
    );

    const txResult = await pool.query(
      `SELECT l.id, l.amount, l.transaction_type, l.description, l.created_at, a.account_name
       FROM ledger l
       JOIN accounts a ON l.account_id = a.id
       WHERE a.user_id = $1
       ORDER BY l.created_at DESC
       LIMIT 25`,
      [userId]
    );

    res.status(200).json({
      wallets: walletsResult.rows.map((w: any) => ({
        ...w,
        balance: parseFloat(w.balance || "0").toFixed(2),
      })),
      recentTransactions: txResult.rows,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to load dashboard." });
  }
};
