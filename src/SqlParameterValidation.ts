import type { SqlParameters } from './types';

/**
 * Guard runtime parameter values so JS callers cannot pass unsupported types.
 */
export function assertSupportedSqlParameters(parameters: SqlParameters): void {
  for (const [index, value] of parameters.entries()) {
    if (value === null) {
      continue;
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      Buffer.isBuffer(value)
    ) {
      continue;
    }

    throw new TypeError(
      `Unsupported SQL parameter at index ${index}: expected string | number | boolean | Buffer | null.`
    );
  }
}
