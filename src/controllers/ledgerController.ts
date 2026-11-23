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

async function findRecipientUserByIdentifier(identifier: string) {
  const raw = String(identifier || "").trim();
  const digits = raw.replace(/\D/g, "");
  const usersRes = await pool.query("SELECT id, email, full_name, business_name FROM users");

  if (digits.length === 12 && digits.startsWith("88")) {
    return (
      usersRes.rows.find(
        (u: any) =>
          generateUniqueAccountNumber(`:${u.email}`) === digits ||
          generateUniqueAccountNumber(`${u.id}:${u.email}`) === digits
      ) || null
    );
  }

  const normalizedEmail = raw.toLowerCase();
  return usersRes.rows.find((u: any) => String(u.email || "").toLowerCase().trim() === normalizedEmail) || null;
}

export const handleDeposit = async (req: Request, res: Response): Promise<void> => {
  const { accountId, amount, description } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!accountId || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "Invalid accountId or deposit amount." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO transactions (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'DEPOSIT', $3) RETURNING *`,
      [accountId, parsedAmount, description || "ACH Deposit"]
    );
    await client.query(
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'balance') THEN
           UPDATE accounts SET balance = COALESCE(balance, 0) + ${parsedAmount} WHERE id = '${accountId}';
         END IF;
       END $$;`
    );
    await client.query("COMMIT");
    res.status(201).json({ message: "Deposit settled", transaction: result.rows.at(0) });
  } catch (error: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Error processing deposit." });
  } finally {
    client.release();
  }
};


export const handleP2PTransfer = async (req: Request, res: Response): Promise<void> => {
  const { senderAccountId, receiverAccountId, amount, description } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!senderAccountId || !receiverAccountId || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "Invalid transfer parameters." });
    return;
  }
  if (senderAccountId === receiverAccountId) {
    res.status(400).json({ error: "Cannot transfer to the same account." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const balanceCheck = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE account_id = $1",
      [senderAccountId]
    );
    const currentBalance = parseFloat(balanceCheck.rows[0]?.balance || "0");
    if (currentBalance < parsedAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Insufficient funds in source wallet." });
      return;
    }

    await client.query(
      `INSERT INTO transactions (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'TRANSFER_OUT', $3)`,
      [senderAccountId, -parsedAmount, description || "Internal Transfer Out"]
    );
    await client.query(
      `INSERT INTO transactions (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'TRANSFER_IN', $3)`,
      [receiverAccountId, parsedAmount, description || "Internal Transfer In"]
    );

    await client.query("COMMIT");
    res.status(200).json({ message: `Transferred $${parsedAmount.toFixed(2)} USD between wallets.` });
  } catch (error: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Transfer failed." });
  } finally {
    client.release();
  }
};

export const requestWireSmsOtp = async (req: Request, res: Response): Promise<void> => {
  const { senderId, recipientEmail, amount } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!senderId || !recipientEmail || isNaN(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: "Recipient account/email and a valid USD amount are required." });
    return;
  }

  try {
    const senderRes = await pool.query("SELECT id, phone, email FROM users WHERE id = $1 LIMIT 1", [senderId]);
    const sender = senderRes.rows[0];
    if (!sender) {
      res.status(404).json({ error: "Sender account not found." });
      return;
    }

    const recipientUser = await findRecipientUserByIdentifier(recipientEmail);
    if (!recipientUser) {
      res.status(404).json({ error: "No VaultCore account matches that 12-digit account number or email." });
      return;
    }
    if (recipientUser.id === senderId) {
      res.status(400).json({ error: "Cannot send a member wire to your own account." });
      return;
    }

    const maskedDestination = await sendWireSmsOtp(senderId, sender.phone || "", parsedAmount);
    res.status(200).json({
      message: `6-digit security authorization code sent to ${maskedDestination}.`,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to send verification code." });
  }
};

export const handleMemberTransfer = async (req: Request, res: Response): Promise<void> => {
  const { senderId, recipientEmail, amount, smsCode } = req.body;
  const parsedAmount = parseFloat(amount);

  if (!senderId || !recipientEmail || isNaN(parsedAmount) || parsedAmount <= 0 || !smsCode) {
    res.status(400).json({ error: "Recipient, amount, and 6-digit security code are required." });
    return;
  }

  const validCode = await verifyWireSmsOtp(senderId, String(smsCode));
  if (!validCode) {
    res.status(401).json({ error: "Invalid or expired 6-digit security authorization code." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const senderWalletReq = await client.query(
      "SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [senderId]
    );
    if (senderWalletReq.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Sender primary wallet not found." });
      return;
    }
    const senderWalletId = senderWalletReq.rows[0].id;

    const recipientUser = await findRecipientUserByIdentifier(recipientEmail);
    if (!recipientUser) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "No VaultCore account matches that 12-digit account number or email." });
      return;
    }
    if (recipientUser.id === senderId) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Cannot send a member wire to your own account." });
      return;
    }

    const recipientWalletReq = await client.query(
      "SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [recipientUser.id]
    );
    if (recipientWalletReq.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Recipient primary wallet not found." });
      return;
    }
    const recipientWalletId = recipientWalletReq.rows[0].id;

    const balanceReq = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM transactions WHERE account_id = $1",
      [senderWalletId]
    );
    const currentBalance = parseFloat(balanceReq.rows[0]?.balance || "0");
    if (currentBalance < parsedAmount) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Insufficient balance in primary checking wallet." });
      return;
    }

    const recipientLabel = recipientUser.business_name || recipientUser.full_name || recipientUser.email;
    await client.query(
      `INSERT INTO transactions (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'WIRE_OUT', $3)`,
      [senderWalletId, -parsedAmount, `VaultCore Member Wire to ${recipientLabel}`]
    );
    await client.query(
      `INSERT INTO transactions (account_id, amount, transaction_type, description)
       VALUES ($1, $2, 'WIRE_IN', $3)`,
      [recipientWalletId, parsedAmount, `VaultCore Member Wire Received`]
    );

    await client.query("COMMIT");
    res.status(200).json({
      message: `Settled $${parsedAmount.toFixed(2)} USD instant wire to ${recipientLabel}.`,
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Member wire failed." });
  } finally {
    client.release();
  }
};

export const getUserDashboard = async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  try {
    const accColsRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts'`
    );
    const accCols = new Set(accColsRes.rows.map((r: any) => r.column_name));
    const hasBalanceCol = accCols.has("balance");

    const txColsRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'`
    );
    const txCols = new Set(txColsRes.rows.map((r: any) => r.column_name));
    const fkCol = txCols.has("account_id") ? "account_id" : txCols.has("wallet_id") ? "wallet_id" : null;

    const walletsResult = await pool.query(
      `SELECT id, account_name, account_type, currency${hasBalanceCol ? ", COALESCE(balance, 0) AS stored_balance" : ", 0 AS stored_balance"}
       FROM accounts
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId]
    );

    const wallets = await Promise.all(
      walletsResult.rows.map(async (w: any) => {
        let txSum = 0;
        if (fkCol) {
          const sumRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE ${fkCol} = $1`,
            [w.id]
          );
          txSum = parseFloat(sumRes.rows.at(0)?.total || "0");
        }
        const stored = parseFloat(w.stored_balance || "0");
        const finalBalance = Math.abs(txSum) > 0 ? txSum : stored;
        return {
          id: w.id,
          account_name: w.account_name,
          account_type: w.account_type,
          currency: w.currency || "USD",
          balance: finalBalance.toFixed(2),
        };
      })
    );

    let recentTransactions: any[] = [];
    if (fkCol) {
      const txResult = await pool.query(
        `SELECT t.id, t.amount, t.transaction_type, t.description, t.created_at, a.account_name
         FROM transactions t
         JOIN accounts a ON t.${fkCol} = a.id
         WHERE a.user_id = $1
         ORDER BY t.created_at DESC
         LIMIT 25`,
        [userId]
      );
      recentTransactions = txResult.rows;
    }

    res.status(200).json({
      wallets,
      recentTransactions,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to load dashboard." });
  }
};
