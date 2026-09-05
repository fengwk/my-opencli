/**
 * Browser Bridge wraps page.evaluate results in `{ session, data }`.
 */

import { ArgumentError } from '@jackwener/opencli/errors';

export function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === 'object' && 'session' in payload && 'data' in payload) {
    return payload.data;
  }
  return payload;
}

export function requireNonEmptyPrompt(prompt, commandName) {
  const text = String(prompt ?? '').trim();
  if (!text) {
    throw new ArgumentError(
      `${commandName} prompt cannot be empty`,
      `Example: opencli ${commandName} "hello"`,
    );
  }
  return text;
}

export function requirePositiveInt(value, flagLabel, hint) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArgumentError(`${flagLabel} must be a positive integer`, hint);
  }
  return value;
}
