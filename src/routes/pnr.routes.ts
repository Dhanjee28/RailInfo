import { Router } from 'express';
import { pnrController } from '../controllers/pnr.controller';

const router = Router();

// Public — no auth required, matches real IRCTC behaviour.
router.get('/:pnr', pnrController.getStatus);

export default router;
