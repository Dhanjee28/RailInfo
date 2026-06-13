// Extend Express's Request so req.user is available after requireAuth middleware.
// Inline import() avoids a top-level import, keeping this a pure ambient declaration
// file that ts-node loads even when it is not directly imported.
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        role: import('@prisma/client').Role;
      };
    }
  }
}

export {}; // make TypeScript treat this as a module so the augmentation is visible

