const DUPLICATE_KEY = 11000;

/**
 * A duplicate-key error is not always a failure here. It is how the unique
 * index on idempotencyKey reports a replay, and how the partial unique index
 * on patientId reports that the patient already has an event in flight.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
