
import express from 'express';
import { errorHandler } from './middlewares/errorHandler';
import authRouter    from './routes/auth.routes';
import trainRouter   from './routes/train.routes';
import bookingRouter from './routes/booking.routes';

const app = express();

app.use(express.json());

// Health check — useful for Docker and load balancer probes later
app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/v1/auth',     authRouter);
app.use('/api/v1/trains',   trainRouter);
app.use('/api/v1/bookings', bookingRouter);

app.use(errorHandler);

export default app;
