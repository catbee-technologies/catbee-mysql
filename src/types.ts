import type { ConnectionOptions, QueryResult, ResultSetHeader, RowDataPacket } from 'mysql2';

/**
 * MySQL parameter type - can be string, number, boolean, Buffer, or null.
 * These are the safe types that can be parameterized in SQL queries.
 *
 * @example
 * const userId: SqlValue = 123;
 * const name: SqlValue = 'Alice';
 * const isActive: SqlValue = true;
 * const payload: SqlValue = Buffer.from('hello');
 * const nullValue: SqlValue = null;
 */
export type SqlValue = string | number | boolean | Buffer | null;

/**
 * SQL comparison clause keywords used in query building.
 * These keywords are used to construct WHERE, AND, OR, and HAVING clauses.
 *
 * @example
 * const clause: ComparisonClauseKeyword = 'WHERE';
 */
export type ComparisonClauseKeyword = 'WHERE' | 'AND' | 'OR' | 'HAVING';

/**
 * Array of SQL parameter values.
 * Use readonly to prevent accidental mutation of query parameters.
 *
 * @example
 * const params: SqlParameters = [123, 'Alice', true];
 */
export type SqlParameters = readonly SqlValue[];

/**
 * Extra controls for a single query or execute call.
 */
export interface QueryExecutionOptions {
  /** Override timeout for this call in milliseconds */
  timeoutMs?: number;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
  /** Whether retry policy is enabled for this call (default: true) */
  retry?: boolean;
  /**
   * Marks write operations as idempotent so they can be retried safely.
   * Ignored for SELECT queries.
   */
  idempotent?: boolean;
}

/**
 * Configuration for retry behavior on transient MySQL errors.
 */
export interface RetryOptions {
  /** Maximum retry attempts after the first failure (default: 0) */
  maxRetries?: number;
  /** Initial delay before retry in milliseconds (default: 50) */
  baseDelayMs?: number;
  /** Maximum delay between retries in milliseconds (default: 1000) */
  maxDelayMs?: number;
  /** Enable randomized jitter on backoff (default: true) */
  jitter?: boolean;
  /** Custom retryable MySQL error codes */
  retryableErrorCodes?: readonly string[];
}

/**
 * Context object passed through the middleware chain for every query or execute call.
 */
export interface MiddlewareContext {
  /** Whether this is a SELECT query or a write statement */
  readonly kind: 'query' | 'execute';
  /** The SQL string being executed */
  readonly sql: string;
  /** Bound parameter values */
  readonly parameters: SqlParameters;
  /** Zero-based attempt counter (increments on retry) */
  readonly attempt: number;
  /** Active timeout, if any */
  readonly timeoutMs?: number;
  /** Populated after `next()` resolves — the raw result value */
  result?: unknown;
  /** Populated after `next()` resolves — elapsed milliseconds */
  durationMs?: number;
  /** Populated when `next()` rejects */
  error?: unknown;
}

/**
 * Middleware function signature for `db.use()`.
 *
 * Call `await next()` to proceed to the next middleware or to the actual DB operation.
 * Anything you do after `await next()` runs after the query completes.
 *
 * @example
 * db.use(async (ctx, next) => {
 *   const start = Date.now();
 *   await next();
 *   console.log(`${ctx.sql} took ${Date.now() - start}ms`);
 * });
 */
export type MiddlewareFn = (context: MiddlewareContext, next: () => Promise<void>) => Promise<void>;

/**
 * Enriched result returned by `db.query()`.
 */
export interface SqlQueryResult<T> {
  /** The returned rows */
  rows: T;
  /** The SQL string that was executed */
  sql: string;
  /** Bound parameter values */
  parameters: SqlParameters;
  /** Total round-trip duration in milliseconds */
  durationMs: number;
  /** Zero-based retry attempt on which the result was obtained */
  attempt: number;
}

/**
 * Enriched result returned by `db.execute()`.
 */
export interface SqlExecuteResult<T> {
  /** The ResultSetHeader (or equivalent) */
  result: T;
  /** The SQL string that was executed */
  sql: string;
  /** Bound parameter values */
  parameters: SqlParameters;
  /** Total round-trip duration in milliseconds */
  durationMs: number;
  /** Zero-based retry attempt on which the result was obtained */
  attempt: number;
}

/**
 * Shared advanced options for both single connection and pooled clients.
 */
export interface SqlClientAdvancedOptions {
  /** Default timeout applied when per-call timeout is not provided */
  defaultQueryTimeoutMs?: number;
  /** Retry configuration for transient errors */
  retry?: RetryOptions;
  /**
   * Enforce strict statement intent:
   * - `query()` allows only SELECT
   * - `execute()` allows only non-SELECT
   *
   * Default: false
   */
  enforceStatementKinds?: boolean;
}

/**
 * Configuration options for creating a single-connection SqlClient.
 * Extends mysql2 ConnectionOptions for all standard MySQL connection settings.
 *
 * @example
 * const options: SqlClientOptions = {
 *   host: 'localhost',
 *   user: 'root',
 *   password: 'password',
 *   database: 'myapp',
 * };
 */
export interface SqlClientOptions extends ConnectionOptions, SqlClientAdvancedOptions {}

/**
 * Configuration options for creating a connection pool SqlClient.
 * Includes all standard MySQL connection options, including mysql2 pool settings
 * such as `connectionLimit`, `waitForConnections`, `queueLimit`,
 * `enableKeepAlive`, and `keepAliveInitialDelay`.
 *
 * @example
 * const options: PoolOptions = {
 *   host: 'localhost',
 *   user: 'root',
 *   password: 'password',
 *   database: 'myapp',
 *   connectionLimit: 10,
 *   waitForConnections: true,
 * };
 */
export interface PoolOptions extends ConnectionOptions, SqlClientAdvancedOptions {}

/**
 * Type alias for query result rows.
 * Can be a single array of rows or nested arrays for multiple result sets.
 */
export type QueryRows = RowDataPacket[] | RowDataPacket[][];

/**
 * Type alias for execute result (INSERT, UPDATE, DELETE operations).
 * Can be a single ResultSetHeader or array for batch operations.
 */
export type ExecuteResult = ResultSetHeader | ResultSetHeader[];

/**
 * Internal type alias for QueryResult from mysql2.
 * Used to maintain compatibility with mysql2/promise types.
 */
export type QueryResult_ = QueryResult;

/**
 * Interface for SQL transaction operations.
 * Provides all query/execution methods plus commit/rollback.
 *
 * @example
 * const tx = await db.startTransaction();
 * try {
 *   await tx.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
 *   await tx.commit();
 * } catch (e) {
 *   await tx.rollback();
 *   throw e;
 * }
 */
export interface SqlTransaction {
  /**
   * Execute a SELECT query within the transaction.
   * @template T - The type of rows returned (default: RowDataPacket[])
   * @param sql - The SQL query string
   * @param parameters - Query parameters for parameterized queries
   * @returns Promise resolving to query result rows
   *
   * @example
   * const rows = await tx.query('SELECT * FROM users WHERE age > ?', [18]);
   */
  query<T extends QueryRows = RowDataPacket[]>(sql: string, parameters?: SqlParameters): Promise<T>;

  /**
   * Execute an INSERT, UPDATE, or DELETE statement within the transaction.
   * @template T - The type of result (default: ResultSetHeader)
   * @param sql - The SQL statement
   * @param parameters - Statement parameters
   * @returns Promise resolving to the result
   *
   * @example
   * const result = await tx.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
   */
  execute<T extends QueryResult_ = ResultSetHeader>(sql: string, parameters?: SqlParameters): Promise<T>;

  /**
   * Get a single row from a query within the transaction.
   * Throws an error if the query returns more than one row.
   * @template T - The row type (default: RowDataPacket)
   * @param sql - The SQL query
   * @param parameters - Query parameters
   * @returns Promise resolving to the row or null if not found
   *
   * @example
   * const user = await tx.get('SELECT * FROM users WHERE id = ?', [1]);
   * if (user) {
   *   console.log(user.name);
   * }
   */
  get<T extends RowDataPacket = RowDataPacket>(sql: string, parameters?: SqlParameters): Promise<T | null>;

  /**
   * Get all matching rows from a query within the transaction.
   * @template T - The row type (default: RowDataPacket)
   * @param sql - The SQL query
   * @param parameters - Query parameters
   * @returns Promise resolving to an array of rows
   *
   * @example
   * const users = await tx.all('SELECT * FROM users WHERE active = ?', [true]);
   */
  all<T extends RowDataPacket = RowDataPacket>(sql: string, parameters?: SqlParameters): Promise<T[]>;

  /**
   * Execute an INSERT statement and return the affected rows count.
   * @param sql - The INSERT statement
   * @param parameters - Statement parameters
   * @returns Promise resolving to the number of affected rows
   *
   * @example
   * const affectedRows = await tx.insert(
   *   'INSERT INTO users(name, email) VALUES(?, ?)',
   *   ['Alice', 'alice@example.com']
   * );
   */
  insert(sql: string, parameters?: SqlParameters): Promise<number>;

  /**
   * Execute an UPDATE statement and return the affected rows count.
   * @param sql - The UPDATE statement
   * @param parameters - Statement parameters
   * @param returnChangedRows - If true, return changedRows instead of affectedRows (default: false)
   * @returns Promise resolving to the count of affected or changed rows
   *
   * @example
   * const affected = await tx.update(
   *   'UPDATE users SET active = ? WHERE id = ?',
   *   [true, 1]
   * );
   * const changed = await tx.update(
   *   'UPDATE users SET active = ? WHERE id = ?',
   *   [true, 1],
   *   true // return changed rows instead
   * );
   */
  update(sql: string, parameters?: SqlParameters, returnChangedRows?: boolean): Promise<number>;

  /**
   * Execute a DELETE statement and return the deleted rows count.
   * @param sql - The DELETE statement
   * @param parameters - Statement parameters
   * @returns Promise resolving to the number of deleted rows
   *
   * @example
   * const deleted = await tx.delete('DELETE FROM users WHERE id = ?', [1]);
   */
  delete(sql: string, parameters?: SqlParameters): Promise<number>;

  /**
   * Commit the transaction.
   * Persists all changes and closes the transaction connection.
   *
   * @returns Promise that resolves when the transaction is committed
   * @throws Error if the transaction was already completed
   *
   * @example
   * await tx.commit();
   */
  commit(): Promise<void>;

  /**
   * Rollback the transaction.
   * Discards all changes and closes the transaction connection.
   *
   * @returns Promise that resolves when the transaction is rolled back
   * @throws Error if the transaction was already completed
   *
   * @example
   * await tx.rollback();
   */
  rollback(): Promise<void>;

  /**
   * Create a savepoint in the current transaction.
   * @param name - Optional savepoint name. Auto-generated when omitted.
   * @returns The created savepoint name
   */
  savepoint(name?: string): Promise<string>;

  /**
   * Roll back transaction state to a previously created savepoint.
   * @param name - Savepoint name
   */
  rollbackTo(name: string): Promise<void>;

  /**
   * Release a previously created savepoint.
   * @param name - Savepoint name
   */
  releaseSavepoint(name: string): Promise<void>;

  /**
   * Check whether any rows match the given query.
   * @param sql - The SELECT query string
   * @param parameters - Query parameters
   * @returns Promise resolving to true if at least one row is found
   *
   * @example
   * const exists = await tx.exists('SELECT 1 FROM users WHERE email = ?', ['alice@example.com']);
   */
  exists(sql: string, parameters?: SqlParameters): Promise<boolean>;

  /**
   * Return the numeric value of the first column of the first row.
   * Intended for use with COUNT(*), SUM(), AVG() and similar aggregate queries.
   * @param sql - The aggregate SELECT query
   * @param parameters - Query parameters
   * @returns Promise resolving to the numeric count (0 when no rows returned)
   *
   * @example
   * const total = await tx.count('SELECT COUNT(*) FROM users WHERE active = ?', [true]);
   */
  count(sql: string, parameters?: SqlParameters): Promise<number>;
}

/**
 * Base interface for the SQL client.
 * Defines all query, execution, and transaction methods.
 * Implemented by SqlClient for both single connection and pool modes.
 */
export interface SqlClientBase {
  /**
   * Register a middleware function that wraps every query and execute call.
   * Middleware runs in registration order. Call `await next()` to continue the chain.
   * @param fn - Middleware function
   * @returns The client instance (for chaining)
   */
  use(fn: MiddlewareFn): this;

  /**
   * Execute a SELECT query and return an enriched result object.
   * @template T - The type of rows returned
   * @param sql - The SQL query string
   * @param parameters - Query parameters
   * @param options - Execution options
   * @returns Promise resolving to enriched query result
   */
  query<T extends QueryRows = RowDataPacket[]>(
    sql: string,
    parameters?: SqlParameters,
    options?: QueryExecutionOptions
  ): Promise<SqlQueryResult<T>>;

  /**
   * Execute any SQL statement and return the raw mysql2 result value.
   *
   * This is an escape hatch for advanced use cases where strict query/execute
   * separation is not desired.
   */
  raw<T = QueryRows | QueryResult_>(
    sql: string,
    parameters?: SqlParameters,
    options?: QueryExecutionOptions
  ): Promise<T>;

  /**
   * Execute an INSERT, UPDATE, or DELETE statement and return an enriched result object.
   * @template T - The type of result
   * @param sql - The SQL statement
   * @param parameters - Statement parameters
   * @param options - Execution options
   * @returns Promise resolving to enriched execute result
   */
  execute<T extends QueryResult_ = ResultSetHeader>(
    sql: string,
    parameters?: SqlParameters,
    options?: QueryExecutionOptions
  ): Promise<SqlExecuteResult<T>>;

  /**
   * Execute a SELECT query with named parameters.
   */
  queryNamed<T extends QueryRows = RowDataPacket[]>(
    sql: string,
    namedParameters: Readonly<Record<string, SqlValue>>,
    options?: QueryExecutionOptions
  ): Promise<SqlQueryResult<T>>;

  /**
   * Execute a non-SELECT statement with named parameters.
   */
  executeNamed<T extends QueryResult_ = ResultSetHeader>(
    sql: string,
    namedParameters: Readonly<Record<string, SqlValue>>,
    options?: QueryExecutionOptions
  ): Promise<SqlExecuteResult<T>>;

  /**
   * Get a single row from a query.
   * @template T - The row type
   * @param sql - The SQL query
   * @param parameters - Query parameters
   * @returns Promise resolving to the row or null
   */
  get<T extends RowDataPacket = RowDataPacket>(sql: string, parameters?: SqlParameters): Promise<T | null>;

  /**
   * Get all matching rows from a query.
   * @template T - The row type
   * @param sql - The SQL query
   * @param parameters - Query parameters
   * @returns Promise resolving to an array of rows
   */
  all<T extends RowDataPacket = RowDataPacket>(sql: string, parameters?: SqlParameters): Promise<T[]>;

  /**
   * Execute an INSERT statement and return the affected rows count.
   */
  insert(sql: string, parameters?: SqlParameters): Promise<number>;

  /**
   * Execute an UPDATE statement and return the affected rows count.
   */
  update(sql: string, parameters?: SqlParameters, returnChangedRows?: boolean): Promise<number>;

  /**
   * Execute a DELETE statement and return the deleted rows count.
   */
  delete(sql: string, parameters?: SqlParameters): Promise<number>;

  /**
   * Check whether any rows match the given query.
   */
  exists(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<boolean>;

  /**
   * Return the numeric value of the first column of the first row.
   */
  count(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<number>;

  /**
   * Verify the database connection is alive.
   */
  ping(): Promise<boolean>;

  /**
   * Start a manual transaction.
   */
  startTransaction(): Promise<SqlTransaction>;

  /**
   * Execute a callback within an automatic transaction.
   */
  transaction<T>(callback: (transaction: SqlTransaction) => Promise<T>): Promise<T>;

  /**
   * Close the connection or connection pool.
   */
  close(): Promise<void>;
}
