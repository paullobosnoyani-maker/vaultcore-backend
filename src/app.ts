import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import userRoutes from './routes/userRoutes';

dotenv.config();

const app = express();
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
const PORT = process.env.PORT || 5000;

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());

app.use('/api/users', userRoutes);

app.get('/status', (req, res) => {
    res.json({ status: 'HEALTHY', message: 'Fintech ledger system core engine operational.' });
});

app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`🚀 Fintech server dashboard running cleanly on port ${PORT}`);
});
