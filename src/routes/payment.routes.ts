import { Router } from 'express';
import { requireAuth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { createPaymentSchema } from '../validators/payment.validators';
import { paymentController } from '../controllers/payment.controller';

const router = Router();

router.use(requireAuth);

// Idempotent: send an `Idempotency-Key` header; retries with the same key never
// charge twice.
router.post('/', validate(createPaymentSchema), paymentController.pay);

export default router;
