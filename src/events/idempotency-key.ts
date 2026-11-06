import { createHash } from 'node:crypto';

/**
 * Sorts object keys recursively. JSON preserves insertion order, so a sender
 * that serialises {"a":1,"b":2} on one attempt and {"b":2,"a":1} on the retry
 * produces two different strings for the same event. Without this, idempotency
 * fails silently for exactly the clients that need it most.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = canonicalise(source[key]);
  }
  return sorted;
}

/**
 * Derives an identity for an event whose payload carries no id of its own.
 *
 * Two genuinely distinct events with the same patient, type, instant and
 * payload collapse into one. That case cannot be told apart from a retry
 * without an identifier from the sender, which is what clientKey() is for.
 */
export function contentKey(event: {
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}): string {
  // Hashed as an array rather than a concatenated string so that a separator
  // appearing inside a value cannot forge a different event's key. The instant
  // is hashed as epoch millis: "10:00:00Z", "10:00:00.000Z" and "10:00:00+00:00"
  // are three spellings of the same moment.
  const canonical = JSON.stringify([
    event.patientId,
    event.type,
    event.ts.getTime(),
    canonicalise(event.data),
  ]);

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Key supplied by the sender through the Idempotency-Key header. */
export function clientKey(headerValue: string): string {
  // Namespaced so a sender cannot craft a key that collides with a content hash.
  return `client:${headerValue}`;
}
