import { Router } from 'express';
import { validate } from '../middlewares/validate';
import { registerSchema, loginSchema } from '../validators/auth.validators';
import { authController } from '../controllers/auth.controller';

const router = Router();

router.post('/register', validate(registerSchema), authController.register);
router.post('/login', validate(loginSchema), authController.login);
// Refresh + logout authenticate via the httpOnly cookie, not a body — no schema.
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export default router;
