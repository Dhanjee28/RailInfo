import { Router } from 'express';
import { stationController } from '../controllers/station.controller';

const router = Router();

// Public — station list for search dropdowns etc.
router.get('/', stationController.list);

export default router;
