import type { Config } from 'jest';

const config: Config = {
  preset:          'ts-jest',
  testEnvironment: 'node',
  roots:           ['<rootDir>/tests'],
  // Only run unit tests (no DB) with the default `npm test`
  testMatch:       ['**/tests/unit/**/*.test.ts'],
};

export default config;
