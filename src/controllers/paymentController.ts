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
    const { paymentIntentId, accountId } = req.body;
    if (!paymentIntentId || !accountId) {
        res.status(400).json({ error: "PaymentIntent ID and target wallet ID are required." });
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
        res.status(500).json({ error: "System error confirming Stripe deposit." });
    } finally {
        client.release();
    }
};
