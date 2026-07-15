import type { ComparisonClauseKeyword, SqlParameters, SqlValue } from './types';

type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE';

/**
 * Lightweight SQL query builder for constructing type-safe parameterized queries.
 *
 * Provides a fluent API for building SELECT, INSERT, UPDATE, and DELETE queries
 * with automatic parameterization and MySQL identifier escaping.
 *
 * All methods can be chained together for a fluent interface.
 *
 * @example
 * // SELECT query
 * const query = buildQuery()
 *   .select('id', 'name', 'email')
 *   .from('users')
 *   .where('age', '>', 18)
 *   .orderBy('name', 'ASC')
 *   .limit(10);
 *
 * const { sql, parameters } = query.build();
 * const users = await db.query(sql, parameters);
 *
 * @example
 * // INSERT query
 * const query = buildQuery().insert('users', {
 *   name: 'Alice',
 *   email: 'alice@example.com',
 *   age: 25,
 * });
 *
 * const { sql, parameters } = query.build();
 * await db.execute(sql, parameters);
 */
export class QueryBuilder {
  /** Array of SQL clause parts */
  private parts: string[] = [];

  /** Array of parameter values */
  private params: SqlValue[] = [];

  /**
   * Add a SELECT clause to the query.
   * Can select specific columns or use wildcards.
   *
   * @param columns - Column names to select
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.select('id', 'name', 'email');
   * query.select('*'); // Select all columns
   */
  public select(...columns: string[]): this {
    this.parts.push(`SELECT ${columns.join(', ')}`);
    return this;
  }

  /**
   * Add a FROM clause to the query.
   * Automatically escapes the table name with backticks.
   *
   * @param table - Table name (and optionally alias)
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.from('users');
   * query.from('users u'); // With alias
   */
  public from(table: string): this {
    this.parts.push(`FROM ${this.escapeTableReference(table)}`);
    return this;
  }

  /**
   * Add a typed WHERE predicate to the query.
   *
   * @param column - Column name to compare
   * @param operator - Comparison operator
   * @param value - Right-hand value
   * @returns This QueryBuilder instance for chaining
   */
  public where(column: string, operator: ComparisonOperator, value: SqlValue): this {
    return this.addComparisonClause('WHERE', column, operator, value);
  }

  /**
   * Add a WHERE ... IN (...) predicate.
   */
  public whereIn(column: string, values: readonly SqlValue[]): this {
    return this.addInClause('WHERE', column, values);
  }

  /**
   * Add a WHERE ... BETWEEN ? AND ? predicate.
   */
  public whereBetween(column: string, lower: SqlValue, upper: SqlValue): this {
    return this.addBetweenClause('WHERE', column, lower, upper);
  }

  /**
   * Add a typed AND predicate.
   */
  public and(column: string, operator: ComparisonOperator, value: SqlValue): this {
    return this.addComparisonClause('AND', column, operator, value);
  }

  /**
   * Add an AND ... IN (...) predicate.
   */
  public andIn(column: string, values: readonly SqlValue[]): this {
    return this.addInClause('AND', column, values);
  }

  /**
   * Add an AND ... BETWEEN ? AND ? predicate.
   */
  public andBetween(column: string, lower: SqlValue, upper: SqlValue): this {
    return this.addBetweenClause('AND', column, lower, upper);
  }

  /**
   * Add a typed OR predicate.
   */
  public or(column: string, operator: ComparisonOperator, value: SqlValue): this {
    return this.addComparisonClause('OR', column, operator, value);
  }

  /**
   * Add an OR ... IN (...) predicate.
   */
  public orIn(column: string, values: readonly SqlValue[]): this {
    return this.addInClause('OR', column, values);
  }

  /**
   * Add an OR ... BETWEEN ? AND ? predicate.
   */
  public orBetween(column: string, lower: SqlValue, upper: SqlValue): this {
    return this.addBetweenClause('OR', column, lower, upper);
  }

  /**
   * Add an ORDER BY clause to sort results.
   *
   * @param column - Column name to sort by
   * @param direction - Sort direction: 'ASC' or 'DESC' (default: 'ASC')
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.orderBy('name', 'ASC');
   * query.orderBy('created_at', 'DESC');
   */
  public orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
    this.parts.push(`ORDER BY ${this.escapeQualifiedIdentifier(column)} ${direction}`);
    return this;
  }

  /**
   * Add a LIMIT clause to restrict result count.
   *
   * @param count - Maximum number of results to return
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.limit(10); // Return at most 10 rows
   */
  public limit(count: number): this {
    this.parts.push(`LIMIT ${count}`);
    return this;
  }

  /**
   * Add an OFFSET clause to skip results (use with LIMIT for pagination).
   *
   * @param count - Number of results to skip
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.limit(10).offset(20); // Skip first 20, return next 10 (page 3)
   */
  public offset(count: number): this {
    this.parts.push(`OFFSET ${count}`);
    return this;
  }

  /**
   * Add an INSERT clause to the query.
   * Automatically escapes column names and creates parameterized values.
   *
   * @param table - Table name to insert into
   * @param columns - Object with column names as keys and values to insert
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.insert('users', {
   *   name: 'Alice',
   *   email: 'alice@example.com',
   *   age: 25,
   * });
   */
  public insert(table: string, columns: Record<string, SqlValue>): this {
    const columnNames = Object.keys(columns);
    const values = Object.values(columns);
    const placeholders = columnNames.map(() => '?').join(', ');

    this.parts.push(
      `INSERT INTO ${this.escapeQualifiedIdentifier(table)} (${columnNames.map(c => this.escapeIdentifier(c)).join(', ')}) VALUES (${placeholders})`
    );
    this.params.push(...values);
    return this;
  }

  /**
   * Add an UPDATE clause to the query.
   * Automatically escapes column names and creates parameterized values.
   * Use where() to specify which rows to update.
   *
   * @param table - Table name to update
   * @param updates - Object with column names as keys and new values
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query
   *   .update('users', { active: true, updated_at: new Date() })
   *   .where('id = ?', 1);
   */
  public update(table: string, updates: Record<string, SqlValue>): this {
    const setClauses = Object.keys(updates)
      .map(key => `${this.escapeIdentifier(key)} = ?`)
      .join(', ');

    this.parts.push(`UPDATE ${this.escapeQualifiedIdentifier(table)} SET ${setClauses}`);
    this.params.push(...Object.values(updates));
    return this;
  }

  /**
   * Add a DELETE clause to the query.
   * Use where() to specify which rows to delete.
   *
   * @param table - Table name to delete from
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query
   *   .delete('users')
   *   .where('id = ?', 1);
   *
   * @example
   * // DELETE WHERE age > 100
   * query
   *   .delete('users')
   *   .where('age > ?', 100);
   */
  public delete(table: string): this {
    this.parts.push(`DELETE FROM ${this.escapeQualifiedIdentifier(table)}`);
    return this;
  }

  /**
   * Add a JOIN clause to the query.
   * Automatically escapes the joined table name.
   *
   * @param type - Type of join: 'INNER', 'LEFT', or 'RIGHT'
   * @param table - Table to join
   * @param condition - JOIN condition (use ? for parameters)
   * @param params - Parameter values for the condition
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query
   *   .select('u.id', 'u.name', 'p.title')
   *   .from('users u')
   *   .join('INNER', 'posts p', 'u.id = p.user_id');
   */
  public join(type: 'INNER' | 'LEFT' | 'RIGHT', table: string, condition: string, ...params: SqlValue[]): this {
    this.parts.push(`${type} JOIN ${this.escapeTableReference(table)} ON ${condition}`);
    this.params.push(...params);
    return this;
  }

  /**
   * Add a GROUP BY clause to aggregate results.
   *
   * @param columns - Column names to group by
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query
   *   .select('role', 'COUNT(*) as count')
   *   .from('users')
   *   .groupBy('role');
   */
  public groupBy(...columns: string[]): this {
    this.parts.push(`GROUP BY ${columns.map(c => this.escapeQualifiedIdentifier(c)).join(', ')}`);
    return this;
  }

  /**
   * Add a typed HAVING predicate to filter aggregated results.
   * Must be used after groupBy().
   *
   * @param column - Aggregate alias/column name
   * @param operator - Comparison operator
   * @param value - Right-hand value
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query
   *   .select('role', 'COUNT(*) as count')
   *   .from('users')
   *   .groupBy('role')
   *   .having('count', '>', 5);
   */
  public having(column: string, operator: ComparisonOperator, value: SqlValue): this {
    return this.addComparisonClause('HAVING', column, operator, value);
  }

  /**
   * Add a HAVING ... IN (...) predicate.
   */
  public havingIn(column: string, values: readonly SqlValue[]): this {
    return this.addInClause('HAVING', column, values);
  }

  /**
   * Add a HAVING ... BETWEEN ? AND ? predicate.
   */
  public havingBetween(column: string, lower: SqlValue, upper: SqlValue): this {
    return this.addBetweenClause('HAVING', column, lower, upper);
  }

  /**
   * Build the final SQL query string and parameters.
   * This should be called after all clauses have been added.
   *
   * @returns Object with `sql` (the SQL query string) and `parameters` (the parameter values)
   *
   * @example
   * const { sql, parameters } = query.build();
   * const results = await db.query(sql, parameters);
   */
  public build(): { sql: string; parameters: SqlParameters } {
    const sql = this.parts.join(' ');
    return {
      sql,
      parameters: this.params as SqlParameters
    };
  }

  /**
   * Get the built SQL query string without building the full object.
   * Useful for inspecting the query without getting parameters separately.
   *
   * @returns The SQL query string
   *
   * @example
   * const sql = query.getSql();
   * console.log(sql);
   */
  public getSql(): string {
    return this.parts.join(' ');
  }

  /**
   * Get the parameters array separately from the SQL string.
   *
   * @returns The array of parameter values
   *
   * @example
   * const params = query.getParameters();
   * console.log(params);
   */
  public getParameters(): SqlParameters {
    return this.params as SqlParameters;
  }

  /**
   * Reset the query builder to start fresh.
   * Clears all clauses and parameters.
   *
   * @returns This QueryBuilder instance for chaining
   *
   * @example
   * query.reset();
   * // Now you can build a completely different query
   * query.select('*').from('posts');
   */
  public reset(): this {
    this.parts = [];
    this.params = [];
    return this;
  }

  /**
   * Internal method to escape MySQL identifiers (table/column names) with backticks.
   * Prevents SQL injection and handles reserved words.
   *
   * @param identifier - The identifier to escape
   * @returns The escaped identifier
   * @internal
   */
  private escapeIdentifier(identifier: string): string {
    // Escape MySQL identifiers with backticks
    return `\`${identifier.replaceAll('`', '``')}\``;
  }

  /**
   * Escape dot-separated identifiers like schema.table or alias.column.
   *
   * @param identifier - Identifier path separated by dots
   * @returns Escaped qualified identifier
   */
  private escapeQualifiedIdentifier(identifier: string): string {
    return identifier
      .split('.')
      .map(part => this.escapeIdentifier(part.trim()))
      .join('.');
  }

  /**
   * Escape table references while preserving optional aliases.
   *
   * Supports `table`, `schema.table`, `table alias`, and `schema.table alias`.
   *
   * @param reference - Table reference with optional alias
   * @returns Escaped table reference
   * @throws Error when the table reference has unsupported extra segments
   */
  private escapeTableReference(reference: string): string {
    const [tableName, alias, ...extra] = reference.trim().split(/\s+/);

    if (extra.length > 0) {
      throw new Error(`Invalid table reference: "${reference}"`);
    }

    if (!alias) {
      return this.escapeQualifiedIdentifier(tableName);
    }

    return `${this.escapeQualifiedIdentifier(tableName)} ${this.escapeIdentifier(alias)}`;
  }

  /**
   * Append a typed predicate using a single value comparison.
   */
  private addComparisonClause(
    keyword: ComparisonClauseKeyword,
    column: string,
    operator: ComparisonOperator,
    value: SqlValue
  ): this {
    this.parts.push(`${keyword} ${this.escapeQualifiedIdentifier(column)} ${operator} ?`);
    this.params.push(value);
    return this;
  }

  /**
   * Append a typed IN predicate.
   */
  private addInClause(keyword: ComparisonClauseKeyword, column: string, values: readonly SqlValue[]): this {
    if (values.length === 0) {
      throw new Error(`${keyword} IN requires at least one value`);
    }

    const placeholders = values.map(() => '?').join(', ');
    this.parts.push(`${keyword} ${this.escapeQualifiedIdentifier(column)} IN (${placeholders})`);
    this.params.push(...values);
    return this;
  }

  /**
   * Append a typed BETWEEN predicate.
   */
  private addBetweenClause(keyword: ComparisonClauseKeyword, column: string, lower: SqlValue, upper: SqlValue): this {
    this.parts.push(`${keyword} ${this.escapeQualifiedIdentifier(column)} BETWEEN ? AND ?`);
    this.params.push(lower, upper);
    return this;
  }
}

/**
 * Factory function to create a new QueryBuilder instance.
 * Equivalent to `new QueryBuilder()` but provides a more fluent API.
 *
 * @returns A new QueryBuilder instance
 *
 * @example
 * import { buildQuery } from '@catbee/mysql';
 *
 * const query = buildQuery()
 *   .select('*')
 *   .from('users')
 *   .where('age', '>', 18);
 *
 * const { sql, parameters } = query.build();
 */
export function buildQuery(): QueryBuilder {
  return new QueryBuilder();
}
