export const REFERENCE_RETRY_BASE_MS = 2_000;
export const REFERENCE_RETRY_MAX_MS = 5 * 60_000;

/** Backoff exponencial com teto: 2s, 4s, 8s, ... até 5 min. */
export function referenceRetryAt(now: Date, attempts: number): Date {
  const delay = Math.min(REFERENCE_RETRY_BASE_MS * 2 ** (attempts - 1), REFERENCE_RETRY_MAX_MS);
  return new Date(now.getTime() + delay);
}
