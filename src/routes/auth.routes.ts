import { Router } from 'express';
import { validate } from '../middlewares/validate';
import { loginLimiter, registerLimiter } from '../middlewares/rateLimit';
import { registerSchema, loginSchema } from '../validators/auth.validators';
import { authController } from '../controllers/auth.controller';

const router = Router();

// Tight limits on credential endpoints — register 3/hour/IP (anti-spam),
// login 5/min/IP (anti credential-stuffing).
router.post('/register', registerLimiter, validate(registerSchema), authController.register);
router.post('/login', loginLimiter, validate(loginSchema), authController.login);
// Refresh + logout authenticate via the httpOnly cookie, not a body — no schema.
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export default router;
