
import express from 'express';
import cookieParser from 'cookie-parser';
import { errorHandler } from './middlewares/errorHandler';
import { globalLimiter } from './middlewares/rateLimit';
import authRouter    from './routes/auth.routes';
import trainRouter   from './routes/train.routes';
import bookingRouter from './routes/booking.routes';
import pnrRouter     from './routes/pnr.routes';
import adminRouter   from './routes/admin.routes';
import stationRouter from './routes/station.routes';

const app = express();

app.use(express.json());
app.use(cookieParser());

// Global per-IP limiter (100/min) — a coarse backstop in front of everything.
// Per-route tiers (login, register, bookings) stack on top in their routers.
app.use(globalLimiter);

// Health check — useful for Docker and load balancer probes later
app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/v1/auth',     authRouter);
app.use('/api/v1/trains',   trainRouter);
app.use('/api/v1/bookings', bookingRouter);
app.use('/api/v1/pnr',      pnrRouter);
app.use('/api/v1/admin',    adminRouter);
app.use('/api/v1/stations', stationRouter);

app.use(errorHandler);

export default app;
