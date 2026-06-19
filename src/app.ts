
import express from 'express';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { errorHandler } from './middlewares/errorHandler';
import { requestLogger } from './middlewares/requestLogger';
import { globalLimiter } from './middlewares/rateLimit';
import { buildOpenApiDocument } from './docs/openapi';
import authRouter    from './routes/auth.routes';
import trainRouter   from './routes/train.routes';
import bookingRouter from './routes/booking.routes';
import pnrRouter     from './routes/pnr.routes';
import adminRouter   from './routes/admin.routes';
import stationRouter from './routes/station.routes';
import paymentRouter from './routes/payment.routes';

const app = express();

// First: assign a requestId + log each request's completion. Everything
// downstream (including the limiter) logs correlated to this request.
app.use(requestLogger);

app.use(express.json());
app.use(cookieParser());

// Global per-IP limiter (100/min) — a coarse backstop in front of everything.
// Per-route tiers (login, register, bookings) stack on top in their routers.
app.use(globalLimiter);

// Health check — useful for Docker and load balancer probes later
app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// API docs — OpenAPI generated from the Zod validators (single source of truth).
const openApiDocument = buildOpenApiDocument();
app.get('/api/docs.json', (_req, res) => res.json(openApiDocument));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.use('/api/v1/auth',     authRouter);
app.use('/api/v1/trains',   trainRouter);
app.use('/api/v1/bookings', bookingRouter);
app.use('/api/v1/pnr',      pnrRouter);
app.use('/api/v1/admin',    adminRouter);
app.use('/api/v1/stations', stationRouter);
app.use('/api/v1/payments', paymentRouter);

app.use(errorHandler);

export default app;
