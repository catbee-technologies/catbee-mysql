import type { SqlParameters } from './types';

function isSqlScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Buffer.isBuffer(value)
  );
}

function isValidSqlParameterValue(value: unknown): boolean {
  if (isSqlScalar(value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(item => {
      if (isSqlScalar(item)) {
        return true;
      }
      if (Array.isArray(item)) {
        return item.every(subItem => isSqlScalar(subItem));
      }
      return false;
    });
  }

  return false;
}

/**
 * Guard runtime parameter values so callers cannot pass unsupported types.
 * Supports scalar SQL values, 1D arrays of scalars, and 2D arrays of scalars.
 */
export function assertSupportedSqlParameters(parameters: SqlParameters): void {
  for (const [index, value] of parameters.entries()) {
    if (isValidSqlParameterValue(value)) {
      continue;
    }

    throw new TypeError(
      `Unsupported SQL parameter at index ${index}: expected string | number | boolean | Buffer | null, or an array/2D array of such values.`
    );
  }
}

/**
 * Detects whether any SQL parameter is a non-empty 2D array (e.g. `[[row1], [row2]]` for `VALUES ?`).
 * MySQL prepared statements (`connection.execute`) reject `VALUES ?` with 2D arrays,
 * so queries with 2D array parameters must be dispatched via `connection.query`.
 */
export function has2DArrayParameter(parameters: SqlParameters): boolean {
  return parameters.some(p => Array.isArray(p) && p.length > 0 && Array.isArray((p as unknown[])[0]));
}
