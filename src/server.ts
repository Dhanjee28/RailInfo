/// <reference path="./types/express.d.ts" />
import { env } from './config/env';
import app from './app';
import { logger } from './utils/logger';

app.listen(env.PORT, () => {
  logger.info(`Server running`, { port: env.PORT, env: env.NODE_ENV });
});
