import { vi } from "vitest";

/**
 * Silence the function logger for the integration suite.
 *
 * Most of these tests assert that an upload is REFUSED, and every refusal logs an
 * error with a stack — which is correct in production and makes a passing run here
 * read as several hundred lines of failure. Whoever runs this needs to be able to
 * see the result.
 *
 * Only the transport is silenced. Nothing about what the code decides changes, and
 * the unit suite asserts nothing about the logger either way.
 */
vi.mock("firebase-functions/logger", () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  write: vi.fn(),
}));
