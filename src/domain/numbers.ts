/**
 * Shared numeric rules for V1 (single source of truth).
 *
 * Node values AND connection/flow values use the exact same rules:
 * - integers 0 through 10,000 inclusive
 * - no decimals (rounded), no negatives (clamped to 0)
 * - numeric strings are coerced ("31" -> 31), never measured by length
 * - multi-digit typing/paste must work — no single-char handlers, no truncation
 */

export const MIN_VALUE = 0;
export const MAX_VALUE = 10_000;

/** Clamp a finite number to [MIN_VALUE, MAX_VALUE] and round to an integer. */
export function clampInt(value: number): number {
  if (!Number.isFinite(value)) return MIN_VALUE;
  return Math.min(MAX_VALUE, Math.max(MIN_VALUE, Math.round(value)));
}

/**
 * Coerce unknown/persisted input to a bounded integer.
 * Returns null when the input carries no usable number (empty, NaN, objects).
 * Numeric strings are converted via Number — "31" becomes 31, not 2 (length).
 */
export function coerceToBoundedInt(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return clampInt(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return clampInt(parsed);
  }
  return null;
}

/**
 * Parse an editor draft string on commit (Enter/blur).
 * Returns null when the draft is not committable — caller keeps the old value.
 */
export function parseBoundedIntInput(draft: string): number | null {
  return coerceToBoundedInt(draft);
}

/** Normalize a node value at the domain boundary (fallback 0). */
export function normalizeNodeValue(raw: unknown, fallback = 0): number {
  const coerced = coerceToBoundedInt(raw);
  if (coerced !== null) return coerced;
  return clampInt(fallback);
}

/** Normalize a connection/flow value at the domain boundary (fallback 1). */
export function normalizeConnectionValue(raw: unknown, fallback = 1): number {
  const coerced = coerceToBoundedInt(raw);
  if (coerced !== null) return coerced;
  return clampInt(fallback);
}
