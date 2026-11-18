import { Request, Response } from "express";
import Stripe from "stripe";
import pool from "../config/db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

export const createStripePaymentIntent = async (req: Request, res: Response): Promise<void> => {
    const { amount } = req.body;
    if (!amount || amount < 1) {
        res.status(400).json({ error: "Minimum deposit is $1.00 USD." });
        return;
    }
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100),
            currency: "usd",
            automatic_payment_methods: { enabled: true },
        });
        res.status(200).json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
    } catch (error: any) {
        console.error("Stripe intent error:", error.message);
        res.status(500).json({ error: "Failed to initialize US payment session." });
    }
};

export const confirmStripeDeposit = async (req: Request, res: Response): Promise<void> => {
    let { paymentIntentId, accountId } = req.body;
    const userId = (req as any).user?.id || (req as any).user?.userId;

    if (!paymentIntentId) {
        res.status(400).json({ error: "PaymentIntent ID is required." });
        return;
    }

    const client = await pool.connect();

    try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== "succeeded") {
            res.status(400).json({ error: "Stripe payment has not succeeded yet." });
            return;
        }

        const verifiedUsdAmount = intent.amount_received / 100;

        await client.query("BEGIN");

        if (!accountId && userId) {
            let walletRes = await client.query(
                "SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
                [userId]
            );
            if (walletRes.rows.length === 0) {
                walletRes = await client.query(
                    `INSERT INTO accounts (user_id, account_name, account_type, currency) VALUES
                     ($1, 'Everyday Operating Checking', 'EVERYDAY', 'USD'),
                     ($1, 'Payroll & Tax Reserve', 'RESERVE', 'USD'),
                     ($1, 'Treasury Yield Reserve', 'TREASURY', 'USD')
                     RETURNING id`,
                    [userId]
                );
            }
            accountId = walletRes.rows.at(0)?.id;
        }

        if (!accountId) {
            await client.query("ROLLBACK");
            res.status(400).json({ error: "Target wallet ID could not be resolved." });
            return;
        }

        const existing = await client.query(
            "SELECT id FROM ledger WHERE reference_id = $1 LIMIT 1",
            [paymentIntentId]
        );
        if (existing.rows.length > 0) {
            await client.query("ROLLBACK");
            res.status(400).json({ error: "This Stripe payment has already been credited." });
            return;
        }

        await client.query(
            "INSERT INTO ledger (account_id, amount, transaction_type, description, reference_id) VALUES ($1, $2, $3, $4, $5)",
            [accountId, verifiedUsdAmount, "STRIPE_USD_DEPOSIT", `Stripe Card/ACH Deposit (${paymentIntentId})`, paymentIntentId]
        );

        await client.query("COMMIT");
        res.status(200).json({ message: `Verified and credited $${verifiedUsdAmount.toFixed(2)} USD via Stripe!` });
    } catch (error: any) {
        await client.query("ROLLBACK");
        console.error("Stripe confirmation error:", error.message);
        res.status(500).json({ error: `Stripe deposit error: ${error.message}` });
    } finally {
        client.release();
    }
};
