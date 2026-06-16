import { Router } from 'express';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { bookingLimiter } from '../middlewares/rateLimit';
import { bookingHistoryQuerySchema, createBookingSchema } from '../validators/booking.validators';
import { bookingController } from '../controllers/booking.controller';

const router = Router();

router.use(requireAuth);

router.get('/',               validate(bookingHistoryQuerySchema, 'query'), bookingController.getHistory);
router.get('/:pnr',           bookingController.getDetail);
// 10/min per user — runs after requireAuth so it buckets on userId.
router.post('/',              bookingLimiter, validate(createBookingSchema),                bookingController.create);
router.post('/:pnr/cancel',   bookingController.cancel);

export default router;
