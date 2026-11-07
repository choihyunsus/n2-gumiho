// Validate bounded UTF-8 and plain JSON before crossing model, database and tool boundaries.
import { createHash } from 'node:crypto';
import type { JsonValue } from './types';
const MAX_JSON_BYTES = 65536;

export function textValue(value: unknown, label: string, maximum = MAX_JSON_BYTES): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    Buffer.byteLength(value) > maximum
  )
    throw new Error(`Invalid ${label}`);
  return value;
}

export function identity(value: unknown, label: string): string {
  const result = textValue(value, label, 128);
  if (!result || /[\s\p{Cc}\p{Cf}]/u.test(result)) throw new Error(`Invalid ${label}`);
  return result;
}

export function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`Invalid ${label}`);
  return value;
}

export function plainJson(
  value: unknown,
  maximumBytes = MAX_JSON_BYTES,
  maximumElements = 4096,
): JsonValue {
  let elements = 0,
    bytes = 0;
  const checkedText = (value: unknown, label: string, limit: number): string => {
    const result = textValue(value, label, limit);
    bytes += Buffer.byteLength(result);
    if (bytes > maximumBytes) throw new Error('JSON exceeds its byte limit');
    return result;
  };
  const visit = (value: unknown, depth: number): JsonValue => {
    if (++elements > maximumElements || depth > 16)
      throw new Error('JSON exceeds its element or nesting limit');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return checkedText(value, 'JSON string', maximumBytes);
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw new Error('JSON number loses precision');
      return value;
    }
    if (Array.isArray(value)) return value.map((child) => visit(child, depth + 1));
    if (
      value &&
      typeof value === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          checkedText(key, 'JSON key', 512),
          visit(child, depth + 1),
        ]),
      );
    throw new Error('Expected plain JSON');
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maximumBytes)
    throw new Error('JSON exceeds its byte limit');
  return result;
}

export function fingerprint(value: unknown, maximumBytes = MAX_JSON_BYTES): string {
  const checked = plainJson(value, maximumBytes, 32768);
  const order = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(order);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, order(value[key]!)]),
      );
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(order(checked)))
    .digest('hex');
}
