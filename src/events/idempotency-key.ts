import { createHash } from 'node:crypto';

/**
 * JSON preserves insertion order, so a sender serialising {"a":1,"b":2} on one
 * attempt and {"b":2,"a":1} on the retry would hash to two different events.
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
 * An identity for an event whose payload carries no id. Two distinct events
 * with identical fields collapse into one; only the sender can tell them apart.
 */
export function contentKey(event: {
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}): string {
  // An array, not a concatenated string, so a separator inside a value cannot
  // forge another event's key. Epoch millis because "10:00:00Z",
  // "10:00:00.000Z" and "10:00:00+00:00" are one moment spelled three ways.
  const canonical = JSON.stringify([
    event.patientId,
    event.type,
    event.ts.getTime(),
    canonicalise(event.data),
  ]);

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function clientKey(headerValue: string): string {
  // Namespaced so a sender cannot craft a key that collides with a content hash.
  return `client:${headerValue}`;
}
