import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import userRoutes from './routes/userRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use('/api/users', userRoutes);

app.get('/status', (req, res) => {
    res.json({ status: 'HEALTHY', message: 'Fintech ledger system core engine operational.' });
});

app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`🚀 Fintech server dashboard running cleanly on port ${PORT}`);
});
