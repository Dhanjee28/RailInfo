import { Router } from 'express';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { bookingHistoryQuerySchema, createBookingSchema } from '../validators/booking.validators';
import { bookingController } from '../controllers/booking.controller';

const router = Router();

router.use(requireAuth);

router.get('/',               validate(bookingHistoryQuerySchema, 'query'), bookingController.getHistory);
router.get('/:pnr',           bookingController.getDetail);
router.post('/',              validate(createBookingSchema),                bookingController.create);
router.post('/:pnr/cancel',   bookingController.cancel);

export default router;
