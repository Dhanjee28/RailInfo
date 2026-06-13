import { Router } from 'express';
import { validate } from '../middlewares/validate';
import { trainSearchSchema, trainDetailQuerySchema } from '../validators/train.validators';
import { trainController } from '../controllers/train.controller';

const router = Router();

router.get('/search',  validate(trainSearchSchema, 'query'),      trainController.search);
router.get('/:trainNumber', validate(trainDetailQuerySchema, 'query'), trainController.getDetails);

export default router;
