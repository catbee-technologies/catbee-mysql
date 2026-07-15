import type { SqlParameters, SqlValue } from './types';

/**
 * Named SQL parameters map, for example: { userId: 1, status: 'active' }.
 */
export type NamedSqlParameters = Readonly<Record<string, SqlValue>>;

/**
 * Compiled SQL output with positional placeholders.
 */
export interface CompiledNamedQuery {
  sql: string;
  parameters: SqlParameters;
}

/**
 * Compile named placeholders like :userId into positional ? parameters.
 *
 * The compiler avoids replacing tokens inside string literals, identifiers,
 * and SQL comments, and throws if a referenced named parameter is missing.
 */
export function compileNamedParameters(sql: string, namedParameters: NamedSqlParameters): CompiledNamedQuery {
  const output: string[] = [];
  const parameters: SqlValue[] = [];

  let i = 0;
  let state: 'normal' | 'single' | 'double' | 'backtick' | 'lineComment' | 'blockComment' = 'normal';

  while (i < sql.length) {
    const char = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    if (state === 'single') {
      output.push(char);
      if (char === "'" && next === "'") {
        output.push(next);
        i += 2;
        continue;
      }
      if (char === "'" && sql[i - 1] !== '\\') {
        state = 'normal';
      }
      i += 1;
      continue;
    }

    if (state === 'double') {
      output.push(char);
      if (char === '"' && next === '"') {
        output.push(next);
        i += 2;
        continue;
      }
      if (char === '"' && sql[i - 1] !== '\\') {
        state = 'normal';
      }
      i += 1;
      continue;
    }

    if (state === 'backtick') {
      output.push(char);
      if (char === '`') {
        state = 'normal';
      }
      i += 1;
      continue;
    }

    if (state === 'lineComment') {
      output.push(char);
      if (char === '\n') {
        state = 'normal';
      }
      i += 1;
      continue;
    }

    if (state === 'blockComment') {
      output.push(char);
      if (char === '*' && next === '/') {
        output.push(next);
        i += 2;
        state = 'normal';
        continue;
      }
      i += 1;
      continue;
    }

    if (char === "'") {
      state = 'single';
      output.push(char);
      i += 1;
      continue;
    }

    if (char === '"') {
      state = 'double';
      output.push(char);
      i += 1;
      continue;
    }

    if (char === '`') {
      state = 'backtick';
      output.push(char);
      i += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      const afterDash = i + 2 < sql.length ? sql[i + 2] : '';
      if (afterDash === '' || /\s/.test(afterDash)) {
        state = 'lineComment';
        output.push(char, next);
        i += 2;
        continue;
      }
    }

    if (char === '#') {
      state = 'lineComment';
      output.push(char);
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      state = 'blockComment';
      output.push(char, next);
      i += 2;
      continue;
    }

    if (char === ':' && /^[A-Za-z_]$/.test(next)) {
      let j = i + 2;
      while (j < sql.length && /^[A-Za-z0-9_]$/.test(sql[j])) {
        j += 1;
      }

      const key = sql.slice(i + 1, j);
      if (!(key in namedParameters)) {
        throw new Error(`Missing named SQL parameter: :${key}`);
      }

      output.push('?');
      parameters.push(namedParameters[key]);
      i = j;
      continue;
    }

    output.push(char);
    i += 1;
  }

  return {
    sql: output.join(''),
    parameters: parameters as SqlParameters
  };
}
