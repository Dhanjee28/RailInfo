import { Router } from 'express';
import { Role } from '@prisma/client';
import { requireAuth, requireRole } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import {
  createStationSchema,
  createTrainSchema,
  updateTrainSchema,
  createCoachSchema,
} from '../validators/admin.validators';
import { adminController } from '../controllers/admin.controller';

const router = Router();

// Every admin route is authenticated AND gated to ADMIN — applied once at the
// router level so no route can be accidentally left open.
router.use(requireAuth, requireRole(Role.ADMIN));

router.post('/stations',            validate(createStationSchema), adminController.createStation);
router.post('/trains',              validate(createTrainSchema),   adminController.createTrain);
router.patch('/trains/:trainNumber', validate(updateTrainSchema),  adminController.updateTrain);
router.post('/coaches',             validate(createCoachSchema),   adminController.createCoach);

export default router;
