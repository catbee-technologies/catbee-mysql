import type {
  ConnectionOptions,
  QueryResult,
  ResultSetHeader,
  RowDataPacket,
  Raw,
  SqlValue as DriverSqlValue
} from 'mysql2';
import type { Connection, Pool, PoolConnection } from 'mysql2/promise';

/**
 * Primitive SQL scalar parameter value.
 * Safe types that can be parameterized directly as individual values in SQL queries.
 *
 * @example
 * const userId: SqlScalar = 123;
 * const name: SqlScalar = 'Alice';
 * const isActive: SqlScalar = true;
 * const payload: SqlScalar = Buffer.from('hello');
 * const nullValue: SqlScalar = null;
 */
export type SqlScalar = string | number | boolean | Buffer | null;

/**
 * Alias for SqlScalar representing single scalar SQL values.
 */
export type SqlScalarValue = SqlScalar;

/**
 * MySQL parameter value - supports:
 * - scalar SQL values (string, number, boolean, Buffer, null)
 * - 1D arrays of scalar SQL values (e.g. for IN clauses)
 * - 2D arrays of scalar SQL values (e.g. for bulk INSERT ... VALUES ? operations)
 *
 * Supports both mutable and readonly arrays.
 *
 * @example
 * const scalar: SqlValue = 'Alice';
 * const inClause: SqlValue = ['WORKORDER', 'MONITORING'];
 * const bulkInsert: SqlValue = [['uuid1', 'UK'], ['uuid2', 'US']];
 */
export type SqlValue = SqlScalar | readonly SqlScalar[] | readonly (readonly SqlScalar[])[];

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
 * Supports scalar parameters, IN clause parameters, and 2D arrays for bulk operations.
 *
 * @example
 * // Scalar parameters
 * const params1: SqlParameters = [123, 'Alice', true];
 *
 * // IN clause parameters with single placeholder: WHERE type IN (?)
 * const params2: SqlParameters = [['WORKORDER', 'MONITORING']];
 *
 * // IN clause parameters with multiple placeholders: WHERE type IN (?, ?)
 * const params3: SqlParameters = ['WORKORDER', 'MONITORING'];
 *
 * // Bulk insert: INSERT INTO tbl VALUES ?
 * const params4: SqlParameters = [[['uuid1', 'UK'], ['uuid2', 'US']]];
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
 * Supported transaction isolation levels in MySQL and MariaDB.
 */
export type TransactionIsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Options for starting a transaction.
 */
export interface TransactionOptions {
  /**
   * The transaction isolation level for this transaction.
   *
   * Executes standard ANSI SQL `SET TRANSACTION ISOLATION LEVEL <level>`
   * on the dedicated connection prior to beginning the transaction.
   * Scoped only to this transaction; does not alter session or pool defaults.
   */
  isolationLevel?: TransactionIsolationLevel;

  /**
   * Whether to execute the transaction in read-only mode (MySQL 5.6.5+, MariaDB 10.0+).
   *
   * When true, issues `SET TRANSACTION READ ONLY`.
   * When false, issues `SET TRANSACTION READ WRITE`.
   */
  readOnly?: boolean;
}

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
   * @param options - Execution options
   * @returns Promise resolving to the row or null
   */
  get<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    parameters?: SqlParameters,
    options?: QueryExecutionOptions
  ): Promise<T | null>;

  /**
   * Get all matching rows from a query.
   * @template T - The row type
   * @param sql - The SQL query
   * @param parameters - Query parameters
   * @param options - Execution options
   * @returns Promise resolving to an array of rows
   */
  all<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    parameters?: SqlParameters,
    options?: QueryExecutionOptions
  ): Promise<T[]>;

  /**
   * Execute an INSERT statement and return the affected rows count.
   */
  insert(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<number>;

  /**
   * Execute an UPDATE statement and return the affected rows count.
   */
  update(
    sql: string,
    parameters?: SqlParameters,
    returnChangedRows?: boolean,
    options?: QueryExecutionOptions
  ): Promise<number>;

  /**
   * Execute a DELETE statement and return the deleted rows count.
   */
  delete(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<number>;

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
   *
   * @param options - Optional transaction options (e.g. isolation level, readOnly)
   */
  startTransaction(options?: TransactionOptions): Promise<SqlTransaction>;

  /**
   * Execute a callback within an automatic transaction.
   *
   * @param callback - Async function to execute within the transaction
   * @param options - Optional transaction options (e.g. isolation level, readOnly)
   */
  transaction<T>(callback: (transaction: SqlTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;

  /**
   * Execute an operation while holding a MySQL distributed advisory lock (`GET_LOCK`).
   *
   * @param lockName - The unique advisory lock name
   * @param timeoutSeconds - Maximum seconds to wait to acquire the lock
   * @param callback - Async function to execute while holding the lock
   */
  withAdvisoryLock<T>(
    lockName: string,
    timeoutSeconds: number,
    callback: (client: SqlClientBase) => Promise<T>
  ): Promise<T>;

  /**
   * Close the connection or connection pool.
   */
  close(): Promise<void>;

  /**
   * Explicit resource management support (`await using db = ...`).
   * Automatically calls `close()` when exiting the block scope.
   */
  [Symbol.asyncDispose](): Promise<void>;

  /**
   * Connection or pool configuration options.
   */
  readonly config: Readonly<SqlClientOptions | PoolOptions>;

  /**
   * Safely format a SQL query by replacing `?` with escaped values and `??` with escaped identifiers.
   *
   * @param sql - SQL query template
   * @param values - Values to interpolate into the template
   * @returns Formatted SQL query string
   */
  format(sql: string, values?: DriverSqlValue | DriverSqlValue[]): string;

  /**
   * Escape an arbitrary value for safe inclusion in a SQL statement.
   *
   * @param value - Value to escape
   * @returns Escaped SQL string
   */
  escape(value: DriverSqlValue): string;

  /**
   * Escape an identifier (column name, table name, or array of names).
   *
   * @param value - Identifier name or array of identifier names
   * @returns Escaped identifier string
   */
  escapeId(value: DriverSqlValue): string;

  /**
   * Get the underlying mysql2 Pool instance when operating in connection pool mode.
   *
   * @returns Underlying mysql2 Promise Pool instance
   * @throws Error if client is in single-connection mode
   */
  getPool(): Pool;

  /**
   * Acquire a direct connection.
   *
   * When in pool mode, acquires a connection from the pool that must be released
   * via `connection.release()` or `client.releaseConnection(connection)`.
   * When in single connection mode, returns the primary connection.
   *
   * @returns Direct connection object
   */
  getConnection(): Promise<PoolConnection | Connection>;

  /**
   * Release an acquired connection back to the pool.
   *
   * @param connection - Connection previously acquired via `getConnection()`
   */
  releaseConnection(connection: PoolConnection | Connection): void;

  /**
   * Immediately destroy the active connection or connection pool without waiting for in-flight queries.
   */
  destroy(): void;

  /**
   * Deallocate a prepared statement.
   *
   * @param sql - The SQL query string or options previously prepared
   */
  unprepare(sql: string): void;

  /**
   * Re-authenticate or change active database on the persistent connection (single-connection mode only).
   *
   * @param options - New user or database options
   */
  changeUser(options: ConnectionOptions): Promise<void>;

  /**
   * Reset session state on the persistent connection (single-connection mode only).
   */
  reset(): Promise<void>;

  /**
   * Return a raw SQL expression that bypasses quoting and escaping in `format()`.
   *
   * @param sql - Raw SQL string
   */
  rawSql(sql: string): Raw;

  /**
   * Subscribe to connection pool lifecycle events.
   */
  on(event: 'connection', listener: (connection: PoolConnection) => void): this;
  on(event: 'acquire', listener: (connection: PoolConnection) => void): this;
  on(event: 'release', listener: (connection: PoolConnection) => void): this;
  on(event: 'enqueue', listener: () => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}
