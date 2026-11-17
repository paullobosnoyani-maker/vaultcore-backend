import { Router } from "express";
import { registerUser, loginUser, verifyOtp, resendOtp } from "../controllers/userController";
import { handleDeposit, handleP2PTransfer, handleMemberTransfer, getUserDashboard } from "../controllers/ledgerController";
import { createStripePaymentIntent, confirmStripeDeposit } from "../controllers/paymentController";
import { submitFundingApplication, getFundingApplications, approveFundingApplication } from "../controllers/fundingController";
import { requestAchWithdrawal } from "../controllers/payoutController";
import { authenticateToken } from "../middleware/authMiddleware";

const router = Router();

router.post("/register", registerUser);
router.post("/login", loginUser);
router.post("/verify-otp", verifyOtp);
router.post("/resend-otp", resendOtp);

router.post("/deposit", authenticateToken, handleDeposit);
router.post("/transfer", authenticateToken, handleP2PTransfer);
router.post("/member-transfer", authenticateToken, handleMemberTransfer);
router.post("/stripe/create-intent", authenticateToken, createStripePaymentIntent);
router.post("/stripe/confirm", authenticateToken, confirmStripeDeposit);
router.post("/funding/apply", authenticateToken, submitFundingApplication);
router.get("/funding/all", authenticateToken, getFundingApplications);
router.post("/funding/approve", authenticateToken, approveFundingApplication);
router.post("/payout/ach", authenticateToken, requestAchWithdrawal);
router.get("/:userId/dashboard", authenticateToken, getUserDashboard);

export default router;
