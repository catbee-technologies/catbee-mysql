import { EventEmitter } from 'node:events';
import type {
  QueryExecutionOptions,
  RetryOptions,
  QueryResult_,
  QueryRows,
  PoolOptions,
  SqlClientBase,
  SqlClientOptions,
  MiddlewareContext,
  MiddlewareFn,
  SqlQueryResult,
  SqlExecuteResult,
  SqlValue,
  SqlParameters,
  SqlTransaction,
  TransactionIsolationLevel,
  TransactionOptions
} from './types';
import { ConnectionManager } from './ConnectionManager';
import { TransactionClient } from './TransactionClient';
import { compileNamedParameters } from './NamedParameters';
import { assertSupportedSqlParameters } from './SqlParameterValidation';
import {
  escape,
  escapeId,
  format,
  raw,
  type ConnectionOptions,
  type Raw,
  type ResultSetHeader,
  type RowDataPacket,
  type SqlValue as DriverSqlValue
} from 'mysql2';
import type { Connection, Pool, PoolConnection } from 'mysql2/promise';

/**
 * Main SQL client for executing queries, statements, and transactions
 * against a MySQL database.
 *
 * Supports two modes of operation:
 * - **Single Connection**: Maintains one persistent connection (default)
 * - **Connection Pooling**: Manages a pool of connections for high-concurrency scenarios
 *
 * All methods use parameterized queries to prevent SQL injection.
 *
 * @implements {SqlClientBase}
 *
 * @example
 * // Single connection mode
 * const db = await SqlClient.create({
 *   host: 'localhost',
 *   user: 'root',
 *   password: 'password',
 *   database: 'myapp',
 * });
 *
 * @example
 * // Connection pooling mode
 * const db = SqlClient.createPool({
 *   host: 'localhost',
 *   user: 'root',
 *   password: 'password',
 *   database: 'myapp',
 *   connectionLimit: 10,
 * });
 *
 * // Use the client...
 * const users = await db.query('SELECT * FROM users');
 *
 * // Always close when done
 * await db.close();
 */
export class SqlClient extends EventEmitter implements SqlClientBase {
  /** Internal connection manager handling the actual connections */
  private readonly connectionManager: ConnectionManager;
  private readonly options: Readonly<SqlClientOptions | PoolOptions>;
  private readonly enforceStatementKinds: boolean;
  private readonly defaultQueryTimeoutMs?: number;
  private readonly retryOptions: Required<RetryOptions>;
  private readonly retryableErrorCodes: Set<string>;
  private readonly middlewares: MiddlewareFn[] = [];

  /**
   * Private constructor. Use `create()` or `createPool()` instead.
   * @param connectionManager - The internal connection manager
   * @param options - Client or pool configuration options
   * @internal
   */
  private constructor(connectionManager: ConnectionManager, options: SqlClientOptions | PoolOptions) {
    super();
    this.connectionManager = connectionManager;
    this.connectionManager.setEventEmitter(this);
    this.options = Object.freeze({
      timezone: 'Z',
      ...options
    });
    this.enforceStatementKinds = options.enforceStatementKinds === true;
    this.defaultQueryTimeoutMs = options.defaultQueryTimeoutMs;

    const defaults: Required<RetryOptions> = {
      maxRetries: 0,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      jitter: true,
      retryableErrorCodes: [
        'ER_LOCK_DEADLOCK',
        'ER_LOCK_WAIT_TIMEOUT',
        'PROTOCOL_CONNECTION_LOST',
        'ECONNRESET',
        'ETIMEDOUT',
        'EPIPE',
        'ERR_STREAM_WRITE_AFTER_END'
      ]
    };

    this.retryOptions = {
      ...defaults,
      ...(options.retry || {}),
      retryableErrorCodes: options.retry?.retryableErrorCodes || defaults.retryableErrorCodes
    };
    this.retryableErrorCodes = new Set(this.retryOptions.retryableErrorCodes);
  }

  /**
   * Create a new SqlClient with a single persistent connection.
   *
   * Use this for single-threaded applications or low-concurrency scenarios.
   * The connection is created once and reused for all operations.
   *
   * @param options - MySQL connection configuration
   * @returns Promise resolving to a new SqlClient instance
   * @throws Error if the connection fails
   *
   * @example
   * const db = await SqlClient.create({
   *   host: 'localhost',
   *   user: 'root',
   *   password: 'password',
   *   database: 'myapp',
   * });
   *
   * @example
   * // With more options
   * const db = await SqlClient.create({
   *   host: 'db.example.com',
   *   user: 'appuser',
   *   password: process.env.DB_PASSWORD,
   *   database: 'production',
   *   port: 3306,
   *   connectTimeout: 10000,
   * });
   */
  public static async create(options: SqlClientOptions): Promise<SqlClient> {
    const connectionManager = new ConnectionManager(options, false);
    await connectionManager.getPrimaryConnection();
    return new SqlClient(connectionManager, options);
  }

  /**
   * Create a new SqlClient with a connection pool.
   *
   * Use this for high-concurrency applications, servers, or APIs.
   * Maintains a pool of connections to efficiently handle multiple concurrent requests.
   *
   * @param options - MySQL connection configuration plus pool options
   * @returns A new SqlClient instance
   *
   * @example
   * const db = SqlClient.createPool({
   *   host: 'localhost',
   *   user: 'root',
   *   password: 'password',
   *   database: 'myapp',
   *   connectionLimit: 10, // Pool size
   *   waitForConnections: true,
   * });
   *
   * @example
   * // Production server config
   * const db = SqlClient.createPool({
   *   host: 'db.example.com',
   *   user: 'appuser',
   *   password: process.env.DB_PASSWORD,
   *   database: 'production',
   *   connectionLimit: 20,
   *   waitForConnections: true,
   *   queueLimit: 100,
   *   enableKeepAlive: true,
   * });
   */
  public static createPool(options: PoolOptions): SqlClient {
    const connectionManager = new ConnectionManager(options, true);
    return new SqlClient(connectionManager, options);
  }

  /**
   * Create a SqlClient that executes all operations on an existing dedicated connection.
   *
   * @param connection - The active MySQL connection
   * @param options - Client configuration options
   * @returns A SqlClient instance bound exclusively to that connection
   * @internal
   */
  private static fromConnection(
    connection: Connection,
    options: SqlClientOptions | PoolOptions = {} as SqlClientOptions
  ): SqlClient {
    const connectionManager = ConnectionManager.fromConnection(connection);
    // Pin retries to 0 so pinned operations never silently retry across sessions
    const client = new SqlClient(connectionManager, {
      ...options,
      retry: { maxRetries: 0 }
    });

    // Pinned connection client lifecycle is managed by withAdvisoryLock.
    // Prevent callers from prematurely closing or destroying the shared locked connection.
    client.close = async (): Promise<void> => {
      // No-op to preserve session lock integrity
    };

    client.destroy = (): void => {
      // No-op to preserve session lock integrity
    };

    client.reset = async (): Promise<void> => {
      throw new Error(
        'reset() is not permitted inside an advisory lock callback. Operations must remain on the locked connection.'
      );
    };

    client.changeUser = async (): Promise<void> => {
      throw new Error(
        'changeUser() is not permitted inside an advisory lock callback. Operations must remain on the locked connection.'
      );
    };

    client.startTransaction = async (): Promise<SqlTransaction> => {
      throw new Error(
        'startTransaction() is not permitted inside an advisory lock callback. Operations must remain on the locked connection.'
      );
    };

    client.transaction = async (): Promise<never> => {
      throw new Error(
        'transaction() is not permitted inside an advisory lock callback. Operations must remain on the locked connection.'
      );
    };

    client.withAdvisoryLock = async (): Promise<never> => {
      throw new Error(
        'withAdvisoryLock() is not permitted inside an advisory lock callback. Lock nesting is not allowed.'
      );
    };

    return client;
  }

  /**
   * Register a middleware function that wraps every `query()` and `execute()` call.
   *
   * Middleware runs in registration order. Call `await next()` to proceed.
   * Anything after `await next()` runs after the DB operation completes.
   * Hook into `ctx.result`, `ctx.durationMs`, and `ctx.error` for observability.
   *
   * @param fn - Middleware function
   * @returns The client instance (for chaining)
   *
   * @example
   * db.use(async (ctx, next) => {
   *   const start = Date.now();
   *   await next();
   *   console.log(`${ctx.kind} "${ctx.sql}" took ${Date.now() - start}ms`);
   * });
   *
   * @example
   * // Error observability
   * db.use(async (ctx, next) => {
   *   try {
   *     await next();
   *   } catch (err) {
   *     myMetrics.increment('db.error', { kind: ctx.kind });
   *     throw err;
   *   }
   * });
   */
  public use(fn: MiddlewareFn): this {
    this.middlewares.push(fn);
    return this;
  }

  /**
   * Execute a SELECT query and return the result rows.
   *
   * @template T - The type of rows in the result (default: RowDataPacket[])
   * @param sql - The SELECT query string with ? placeholders for parameters
   * @param parameters - Parameter values to safely substitute into the query (default: [])
   * @returns Promise resolving to query result rows
   * @throws Error if the query fails
   *
   * @example
   * // Simple query
   * const users = await db.query('SELECT * FROM users');
   *
   * @example
   * // With parameters
   * const activeUsers = await db.query(
   *   'SELECT * FROM users WHERE active = ? AND age > ?',
   *   [true, 18]
   * );
   *
   * @example
   * // With typing
   * interface User {
   *   id: number;
   *   name: string;
   *   email: string;
   * }
   * const users = await db.query<User[]>(
   *   'SELECT id, name, email FROM users WHERE status = ?',
   *   ['active']
   * );
   */
  public async query<T extends QueryRows = RowDataPacket[]>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<SqlQueryResult<T>> {
    if (this.enforceStatementKinds) {
      this.assertQueryStatement(sql);
    }

    return this.runQuery<T>(sql, parameters, options, true, async r =>
      r
        ? this.connectionManager.queryCancelable<T>(sql, parameters, r)
        : this.connectionManager.query<T>(sql, parameters)
    );
  }

  /**
   * Execute any SQL statement and return the raw mysql2 result value.
   *
   * This escape-hatch method is intended for advanced use cases where
   * strict `query()`/`execute()` separation is not desired.
   *
   * Retries are disabled by default for safety and can still be configured
   * explicitly through options when needed.
   *
   * @template T - Raw mysql2 result type (rows or ResultSetHeader-like)
   * @param sql - SQL statement of any kind
   * @param parameters - Statement/query parameters
   * @param options - Execution options
   * @returns Promise resolving to the raw mysql2 result value
   */
  public async raw<T = QueryRows | QueryResult_>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<T> {
    const mergedOptions: QueryExecutionOptions = {
      retry: false,
      ...options
    };

    const value = await this.runCore<any>('query', sql, parameters, mergedOptions, false, async r =>
      r
        ? this.connectionManager.queryCancelable<any>(sql, parameters, r)
        : this.connectionManager.query<any>(sql, parameters)
    );

    return (value as SqlQueryResult<unknown>).rows as T;
  }

  /** @internal Raw rows for convenience helpers */
  private async queryRaw<T extends QueryRows = RowDataPacket[]>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<T> {
    return (await this.query<T>(sql, parameters, options)).rows;
  }

  /**
   * Execute an INSERT, UPDATE, or DELETE statement.
   *
   * Returns a ResultSetHeader with information about the operation:
   * - `affectedRows`: Number of rows affected
   * - `insertId`: The ID of inserted rows (for INSERT)
   * - `changedRows`: Number of rows actually changed (for UPDATE)
   *
   * @template T - The type of result (default: ResultSetHeader)
   * @param sql - The SQL statement string with ? placeholders for parameters
   * @param parameters - Parameter values (default: [])
   * @returns Promise resolving to the execution result
   * @throws Error if the statement fails
   *
   * @example
   * // UPDATE statement
   * const result = await db.execute(
   *   'UPDATE users SET active = ? WHERE id = ?',
   *   [true, 1]
   * );
   * console.log(result.affectedRows); // 1
   *
   * @example
   * // DELETE statement
   * const result = await db.execute(
   *   'DELETE FROM users WHERE age > ?',
   *   [100]
   * );
   * console.log(result.affectedRows); // Number of deleted rows
   *
   * @example
   * // INSERT statement
   * const result = await db.execute(
   *   'INSERT INTO users(name, email) VALUES(?, ?)',
   *   ['Alice', 'alice@example.com']
   * );
   * console.log(result.insertId); // ID of new row
   */
  public async execute<T extends QueryResult_ = ResultSetHeader>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<SqlExecuteResult<T>> {
    if (this.enforceStatementKinds) {
      this.assertExecuteStatement(sql);
    }

    return this.runExecute<T>(sql, parameters, options, options.idempotent === true, async r =>
      r
        ? this.connectionManager.executeCancelable<T>(sql, parameters, r)
        : this.connectionManager.execute<T>(sql, parameters)
    );
  }

  /** @internal Raw result for convenience helpers */
  private async executeRaw<T extends QueryResult_ = ResultSetHeader>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<T> {
    return (await this.execute<T>(sql, parameters, options)).result;
  }

  /**
   * Execute a SELECT query using named placeholders.
   *
   * Named placeholders (for example, `:userId`) are compiled into positional
   * placeholders (`?`) in a SQL-safe way, while ignoring placeholders inside
   * string literals, identifiers, and comments.
   *
   * @template T - The type of rows in the result (default: RowDataPacket[])
   * @param sql - SQL query containing named placeholders
   * @param namedParameters - Map of placeholder names to values
   * @param options - Per-query execution options (timeout, retry, abort signal)
   * @returns Promise resolving to query result rows
   * @throws Error if any named placeholder in SQL is missing in namedParameters
   * @throws Error if query execution fails
   *
   * @example
   * const users = await db.queryNamed(
   *   'SELECT * FROM users WHERE account_id = :accountId AND status = :status',
   *   { accountId: 42, status: 'active' }
   * );
   *
   * @example
   * interface UserRow {
   *   id: number;
   *   email: string;
   * }
   *
   * const rows = await db.queryNamed<UserRow[]>(
   *   'SELECT id, email FROM users WHERE id = :id',
   *   { id: 7 },
   *   { timeoutMs: 2000 }
   * );
   */
  public async queryNamed<T extends QueryRows = RowDataPacket[]>(
    sql: string,
    namedParameters: Readonly<Record<string, SqlValue>>,
    options: QueryExecutionOptions = {}
  ): Promise<SqlQueryResult<T>> {
    const compiled = compileNamedParameters(sql, namedParameters);
    return this.query<T>(compiled.sql, compiled.parameters, options);
  }

  /**
   * Execute an INSERT, UPDATE, or DELETE statement using named placeholders.
   *
   * This is equivalent to `execute()`, but allows more readable SQL by using
   * named tokens (for example, `:id`, `:status`) instead of positional arrays.
   *
   * @template T - The execution result type (default: ResultSetHeader)
   * @param sql - SQL statement containing named placeholders
   * @param namedParameters - Map of placeholder names to values
   * @param options - Per-statement execution options (timeout, idempotency, retry, abort signal)
   * @returns Promise resolving to execution result
   * @throws Error if any named placeholder in SQL is missing in namedParameters
   * @throws Error if statement execution fails
   *
   * @example
   * const result = await db.executeNamed(
   *   'UPDATE users SET status = :status WHERE id = :id',
   *   { status: 'inactive', id: 99 },
   *   { idempotent: true }
   * );
   *
   * console.log(result.affectedRows);
   */
  public async executeNamed<T extends QueryResult_ = ResultSetHeader>(
    sql: string,
    namedParameters: Readonly<Record<string, SqlValue>>,
    options: QueryExecutionOptions = {}
  ): Promise<SqlExecuteResult<T>> {
    const compiled = compileNamedParameters(sql, namedParameters);
    return this.execute<T>(compiled.sql, compiled.parameters, options);
  }

  /**
   * Get a single row from a query.
   *
   * Convenience method for queries expected to return exactly one row.
   * Throws an error if the query returns more than one row.
   * Returns null if no rows are found.
   *
   * @template T - The row type (default: RowDataPacket)
   * @param sql - The SELECT query string
   * @param parameters - Parameter values (default: [])
   * @returns Promise resolving to the row or null if not found
   * @throws Error if the query returns more than one row
   * @throws Error if the query fails
   *
   * @example
   * // Get user by ID
   * const user = await db.get(
   *   'SELECT * FROM users WHERE id = ?',
   *   [1]
   * );
   *
   * if (user) {
   *   console.log(user.name);
   * } else {
   *   console.log('User not found');
   * }
   *
   * @example
   * // With typing
   * interface User {
   *   id: number;
   *   name: string;
   * }
   * const user = await db.get<User>(
   *   'SELECT id, name FROM users WHERE id = ?',
   *   [1]
   * );
   */
  public async get<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<T | null> {
    const rows = await this.queryRaw<T[]>(sql, parameters, options);
    if (rows.length > 1) throw new Error('get() returned more than one row');
    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * Get all rows matching a query.
   *
   * Convenience method for queries that return multiple rows.
   *
   * @template T - The row type (default: RowDataPacket)
   * @param sql - The SELECT query string
   * @param parameters - Parameter values (default: [])
   * @param options - Execution options
   * @returns Promise resolving to an array of rows (empty array if none found)
   * @throws Error if the query fails
   *
   * @example
   * // Get all active users
   * const activeUsers = await db.all(
   *   'SELECT * FROM users WHERE active = ?',
   *   [true]
   * );
   *
   * console.log(`Found ${activeUsers.length} active users`);
   *
   * @example
   * // With typing
   * interface User {
   *   id: number;
   *   name: string;
   *   email: string;
   * }
   * const users = await db.all<User>(
   *   'SELECT id, name, email FROM users',
   *   []
   * );
   */
  public async all<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<T[]> {
    return this.queryRaw<T[]>(sql, parameters, options);
  }

  /**
   * Execute an INSERT statement and return the affected rows count.
   *
   * Convenience method that executes an INSERT and returns `affectedRows`.
   *
   * @param sql - The INSERT statement
   * @param parameters - Parameter values (default: [])
   * @param options - Execution options
   * @returns Promise resolving to the number of affected rows
   * @throws Error if the insert fails
   *
   * @example
   * // Insert a new user and get affected row count
   * const affectedRows = await db.insert(
   *   'INSERT INTO users(name, email) VALUES(?, ?)',
   *   ['Alice', 'alice@example.com']
   * );
   * console.log(`Inserted ${affectedRows} row(s)`);
   */
  public async insert(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<number> {
    const result = await this.executeRaw<ResultSetHeader>(sql, parameters, options);
    return result.affectedRows;
  }

  /**
   * Execute an UPDATE statement and return the affected rows count.
   *
   * Convenience method that executes an UPDATE and returns either:
   * - `affectedRows`: Total rows affected by the update
   * - `changedRows`: Rows that actually changed (when returnChangedRows=true)
   *
   * @param sql - The UPDATE statement
   * @param parameters - Parameter values (default: [])
   * @param returnChangedRows - If true, return changedRows instead of affectedRows (default: false)
   * @param options - Execution options
   * @returns Promise resolving to the affected or changed rows count
   * @throws Error if the update fails
   *
   * @example
   * // Update and get affected count
   * const affectedCount = await db.update(
   *   'UPDATE users SET active = ? WHERE id = ?',
   *   [true, 1]
   * );
   * console.log(`Updated ${affectedCount} rows`);
   *
   * @example
   * // Get actually changed rows instead
   * const changedCount = await db.update(
   *   'UPDATE users SET status = ? WHERE department = ?',
   *   ['active', 'sales'],
   *   true // returnChangedRows flag
   * );
   * console.log(`Actually changed ${changedCount} rows`);
   *
   * @example
   * // Bulk update with parameters
   * const count = await db.update(
   *   'UPDATE products SET price = price * ? WHERE category = ?',
   *   [1.1, 'electronics']
   * );
   */
  public async update(
    sql: string,
    parameters: SqlParameters = [],
    returnChangedRows = false,
    options: QueryExecutionOptions = {}
  ): Promise<number> {
    const result = await this.executeRaw<ResultSetHeader>(sql, parameters, options);
    return returnChangedRows ? result?.changedRows : result.affectedRows;
  }

  /**
   * Execute a DELETE statement and return the deleted rows count.
   *
   * Convenience method that executes a DELETE and returns the number
   * of rows that were deleted.
   *
   * @param sql - The DELETE statement
   * @param parameters - Parameter values (default: [])
   * @param options - Execution options
   * @returns Promise resolving to the number of deleted rows
   * @throws Error if the delete fails
   *
   * @example
   * // Delete a specific user
   * const deletedCount = await db.delete(
   *   'DELETE FROM users WHERE id = ?',
   *   [1]
   * );
   * console.log(`Deleted ${deletedCount} user(s)`);
   *
   * @example
   * // Bulk delete with condition
   * const archivedCount = await db.delete(
   *   'DELETE FROM logs WHERE created_at < ?',
   *   [formatDateForMysql(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))] // 30 days ago
   * );
   * console.log(`Deleted ${archivedCount} old log entries`);
   */
  public async delete(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<number> {
    const result = await this.executeRaw<ResultSetHeader>(sql, parameters, options);
    return result.affectedRows;
  }

  /**
   * Check whether any rows match the given query.
   *
   * @param sql - The SELECT query string
   * @param parameters - Parameter values (default: [])
   * @param options - Per-query execution options
   * @returns Promise resolving to true if at least one row is found
   *
   * @example
   * const emailTaken = await db.exists(
   *   'SELECT 1 FROM users WHERE email = ?',
   *   ['alice@example.com']
   * );
   */
  public async exists(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<boolean> {
    const rows = await this.queryRaw<RowDataPacket[]>(sql, parameters, options);
    return rows.length > 0;
  }

  /**
   * Return the numeric value of the first column of the first row.
   *
   * Intended for aggregate queries such as `COUNT(*)`, `SUM()`, `AVG()`.
   * Returns `0` when the query returns no rows.
   *
   * @param sql - The aggregate SELECT query
   * @param parameters - Parameter values (default: [])
   * @param options - Per-query execution options
   * @returns Promise resolving to the numeric result
   *
   * @example
   * const total = await db.count(
   *   'SELECT COUNT(*) FROM users WHERE active = ?',
   *   [true]
   * );
   */
  public async count(
    sql: string,
    parameters: SqlParameters = [],
    options: QueryExecutionOptions = {}
  ): Promise<number> {
    const rows = await this.queryRaw<RowDataPacket[]>(sql, parameters, options);
    if (rows.length === 0) return 0;
    const firstValue = Object.values(rows[0])[0];
    return typeof firstValue === 'number' ? firstValue : Number(firstValue);
  }

  /**
   * Verify the database connection is alive by running a lightweight probe query.
   *
   * @returns Promise resolving to true when the connection is healthy, false otherwise
   *
   * @example
   * const healthy = await db.ping();
   * if (!healthy) {
   *   console.error('Database unreachable');
   * }
   */
  public async ping(): Promise<boolean> {
    try {
      await this.queryRaw('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start a manual transaction.
   *
   * Creates a new transaction that must be explicitly committed or rolled back.
   * Useful when you need fine-grained control over transaction boundaries.
   *
   * @returns Promise resolving to a SqlTransaction object for executing statements
   * @throws Error if the transaction fails to start
   *
   * @example
   * // Manual transaction with explicit commit/rollback
   * const tx = await db.startTransaction();
   *
   * try {
   *   await tx.execute(
   *     'UPDATE users SET active = ? WHERE id = ?',
   *     [true, 1]
   *   );
   *   await tx.execute(
   *     'INSERT INTO audit_logs(action, user_id) VALUES(?, ?)',
   *     ['activate', 1]
   *   );
   *
   *   await tx.commit(); // Persist both changes
   * } catch (error) {
   *   await tx.rollback(); // Discard both changes
   *   throw error;
   * }
   *
   * @param options - Optional transaction options (e.g. isolationLevel, readOnly)
   * @returns Promise resolving to a TransactionClient instance
   * @throws Error if connection creation or transaction initialization fails
   *
   * @example
   * const tx = await db.startTransaction({ isolationLevel: 'READ COMMITTED' });
   * try {
   *   await tx.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
   *   await tx.commit();
   * } catch (error) {
   *   await tx.rollback();
   *   throw error;
   * }
   *
   * @see transaction For automatic transaction handling
   */
  public async startTransaction(options?: TransactionOptions): Promise<SqlTransaction> {
    const connection = await this.connectionManager.createTransactionalConnection();
    try {
      if (options?.isolationLevel) {
        const level = options.isolationLevel.toUpperCase() as TransactionIsolationLevel;
        const validLevels: TransactionIsolationLevel[] = [
          'READ UNCOMMITTED',
          'READ COMMITTED',
          'REPEATABLE READ',
          'SERIALIZABLE'
        ];
        if (!validLevels.includes(level)) {
          throw new Error(
            `Invalid transaction isolation level: "${options.isolationLevel}". Supported levels: ${validLevels.join(', ')}`
          );
        }
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
      }

      if (options?.readOnly !== undefined) {
        await connection.query(options.readOnly ? 'SET TRANSACTION READ ONLY' : 'SET TRANSACTION READ WRITE');
      }

      await connection.beginTransaction();
      return new TransactionClient(connection);
    } catch (error) {
      await this.releaseTransactionConnection(connection);
      throw error;
    }
  }

  /**
   * Execute a callback function within an automatic transaction.
   *
   * Automatically commits if the callback succeeds or rolls back if it throws.
   * This is the preferred way to use transactions as it's more concise and
   * error-safe than manual transaction management.
   *
   * @template T - The type of value returned by the callback
   * @param callback - Async function to execute within the transaction
   * @param options - Optional transaction options (e.g. isolationLevel, readOnly)
   * @returns Promise resolving to the callback result
   * @throws Error thrown by the callback (with automatic rollback)
   * @throws Error if the transaction fails
   *
   * @example
   * // Simple automatic transaction
   * const userId = await db.transaction(async (tx) => {
   *   const id = await tx.insert(
   *     'INSERT INTO users(name, email) VALUES(?, ?)',
   *     ['Alice', 'alice@example.com']
   *   );
   *
   *   await tx.execute(
   *     'INSERT INTO user_settings(user_id) VALUES(?)',
   *     [id]
   *   );
   *
   *   return id; // Automatically committed
   * });
   *
   * @example
   * // Transaction with custom isolation level
   * await db.transaction(async (tx) => {
   *   return await tx.query('SELECT * FROM accounts');
   * }, { isolationLevel: 'READ COMMITTED', readOnly: true });
   *
   * @see startTransaction For manual transaction control
   */
  public async transaction<T>(
    callback: (transaction: SqlTransaction) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    const transaction = await this.startTransaction(options);
    let result: T;

    try {
      result = await callback(transaction);
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        if (error instanceof Error) {
          const enrichedError = error as Error & { cause?: unknown; rollbackError?: unknown };
          if (enrichedError.cause === undefined) {
            enrichedError.cause = rollbackError;
          }
          enrichedError.rollbackError = rollbackError;
          throw enrichedError;
        }

        const wrappedError = new Error('Transaction callback failed and rollback also failed');
        const enrichedWrappedError = wrappedError as Error & { cause?: unknown; rollbackError?: unknown };
        enrichedWrappedError.cause = error;
        enrichedWrappedError.rollbackError = rollbackError;
        throw wrappedError;
      }
      throw error;
    }

    await transaction.commit();
    return result;
  }

  /**
   * Execute an operation while holding a MySQL distributed advisory lock (`GET_LOCK`).
   *
   * Automatically allocates a dedicated session connection, acquires the lock with the specified
   * timeout, executes the callback, and ensures the lock is released in a finally block.
   *
   * @template T - Return type of the callback
   * @param lockName - The unique advisory lock name (up to 64 chars in MySQL)
   * @param timeoutSeconds - Maximum seconds to wait to acquire the lock (default: 60)
   * @param callback - The action to perform while holding the lock
   * @returns Result of the callback
   * @throws Error if lock acquisition times out or fails
   *
   * @example
   * const result = await client.withAdvisoryLock('my_migration_lock', 30, async (db) => {
   *   return await runCriticalSection(db);
   * });
   */
  public async withAdvisoryLock<T>(
    lockName: string,
    timeoutSeconds: number,
    callback: (client: SqlClient) => Promise<T>
  ): Promise<T> {
    if (typeof lockName !== 'string' || lockName.length === 0 || lockName.length > 64) {
      throw new TypeError(
        `Lock name must be a non-empty string of at most 64 characters, received length: ${
          typeof lockName === 'string' ? lockName.length : typeof lockName
        }`
      );
    }

    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
      throw new TypeError(`Lock timeout must be a non-negative integer, received: ${timeoutSeconds}`);
    }

    const connection = await this.connectionManager.createTransactionalConnection();
    let lockAcquired = false;
    let callbackResult: T | undefined;
    let callbackError: unknown;
    let hasCallbackError = false;

    try {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS lockAcquired', [
        lockName,
        timeoutSeconds
      ]);
      const row = Array.isArray(rows) && rows.length > 0 ? (rows[0] as { lockAcquired: number | null }) : undefined;

      if (!row || row.lockAcquired !== 1) {
        throw new Error(`Failed to acquire advisory lock "${lockName}" within ${timeoutSeconds}s`);
      }
      lockAcquired = true;

      const lockedClient = SqlClient.fromConnection(connection, {
        defaultQueryTimeoutMs: this.defaultQueryTimeoutMs,
        enforceStatementKinds: this.enforceStatementKinds,
        retry: { ...this.retryOptions, maxRetries: 0 }
      });
      for (const middleware of this.middlewares) {
        lockedClient.use(middleware);
      }

      callbackResult = await callback(lockedClient);
    } catch (error) {
      callbackError = error;
      hasCallbackError = true;
    }

    let releaseError: unknown;

    if (lockAcquired) {
      try {
        const [rows] = await connection.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lockName]);
        const released =
          Array.isArray(rows) && rows.length > 0 ? (rows[0] as { released: number | null }).released : undefined;
        if (released !== 1) {
          releaseError = new Error(
            `Failed to release advisory lock "${lockName}" (RELEASE_LOCK returned ${String(released)})`
          );
        }
      } catch (err) {
        releaseError = err;
      }
    }

    try {
      if (releaseError) {
        // If lock release failed, terminate and destroy the connection immediately
        // so the MySQL server drops the session and releases the advisory lock,
        // rather than returning a dirty, lock-holding connection back to the pool.
        this.connectionManager.terminateConnection(connection);
      } else {
        await this.releaseTransactionConnection(connection);
      }
    } catch (cleanupErr) {
      this.connectionManager.terminateConnection(connection);

      if (!releaseError) {
        releaseError = cleanupErr;
      } else if (releaseError instanceof Error) {
        const enrichedRelease = releaseError as Error & { cause?: unknown; cleanupError?: unknown };
        if (enrichedRelease.cause === undefined) {
          enrichedRelease.cause = cleanupErr;
        }
        enrichedRelease.cleanupError = cleanupErr;
      }
    }

    if (hasCallbackError) {
      if (releaseError) {
        if (callbackError instanceof Error) {
          const enriched = callbackError as Error & { cause?: unknown; releaseError?: unknown };
          if (enriched.cause === undefined) {
            enriched.cause = releaseError;
          }
          enriched.releaseError = releaseError;
          throw enriched;
        }

        const wrappedError = new Error(
          `Advisory lock callback failed with non-Error: ${String(callbackError)} and lock release failed`
        );
        const enriched = wrappedError as Error & { cause?: unknown; releaseError?: unknown };
        enriched.cause = callbackError;
        enriched.releaseError = releaseError;
        throw wrappedError;
      }

      throw callbackError;
    }

    if (releaseError) {
      throw releaseError;
    }

    return callbackResult as T;
  }

  /**
   * Close the connection or connection pool.
   *
   * Releases all resources held by the client.
   * After calling this method, the client cannot be reused.
   *
   * Should be called when the application is shutting down or no longer
   * needs database access.
   *
   * @returns Promise that resolves when the connection is closed
   *
   * @example
   * // Single connection
   * const db = await SqlClient.create({ host: 'localhost', ... });
   * // ... use db ...
   * await db.close(); // Closes the single connection
   *
   * @example
   * // Connection pool
   * const db = SqlClient.createPool({ host: 'localhost', ... });
   * // ... use db ...
   * await db.close(); // Closes all connections in the pool
   *
   * @example
   * // In an Express app
   * const db = SqlClient.createPool({ ... });
   *
   * process.on('SIGINT', async () => {
   *   console.log('Shutting down...');
   *   await db.close();
   *   process.exit(0);
   * });
   */
  public async close(): Promise<void> {
    await this.connectionManager.close();
  }

  /**
   * Explicit resource management support (`await using db = ...`).
   * Automatically closes the client when exiting the block scope.
   *
   * @example
   * {
   *   await using db = SqlClient.createPool(options);
   *   const users = await db.query('SELECT * FROM users');
   * } // db.close() is automatically called here
   */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Get the client configuration options.
   */
  public get config(): Readonly<SqlClientOptions | PoolOptions> {
    return this.options;
  }

  /**
   * Safely format a SQL query by replacing `?` with escaped values and `??` with escaped identifiers.
   *
   * @param sql - SQL query template
   * @param values - Values to interpolate into the template
   * @returns Formatted SQL query string
   *
   * @example
   * const sql = db.format('SELECT * FROM ?? WHERE id = ?', ['users', 42]);
   * // 'SELECT * FROM `users` WHERE id = 42'
   */
  public format(sql: string, values?: DriverSqlValue | DriverSqlValue[]): string {
    return format(sql, values, undefined, this.options.timezone ?? 'Z');
  }

  /**
   * Escape an arbitrary value for safe inclusion in a SQL statement.
   *
   * @param value - Value to escape
   * @returns Escaped SQL string
   *
   * @example
   * const safe = db.escape("O'Reilly");
   * // "'O\\'Reilly'"
   */
  public escape(value: DriverSqlValue): string {
    return escape(value, undefined, this.options.timezone ?? 'Z');
  }

  /**
   * Escape an identifier (column name, table name, or array of names).
   *
   * @param value - Identifier name or array of identifier names
   * @returns Escaped identifier string
   *
   * @example
   * const table = db.escapeId('user-table');
   * // '`user-table`'
   */
  public escapeId(value: DriverSqlValue): string {
    return escapeId(value);
  }

  /**
   * Static helper to format a SQL query.
   *
   * @param sql - SQL query template
   * @param values - Values to interpolate into the template
   * @param timeZone - Timezone to use for dates (default: 'Z')
   * @returns Formatted SQL query string
   */
  public static format(sql: string, values?: DriverSqlValue | DriverSqlValue[], timeZone = 'Z'): string {
    return format(sql, values, undefined, timeZone);
  }

  /**
   * Static helper to escape an arbitrary value.
   *
   * @param value - Value to escape
   * @param timeZone - Timezone to use for dates (default: 'Z')
   * @returns Escaped SQL string
   */
  public static escape(value: DriverSqlValue, timeZone = 'Z'): string {
    return escape(value, undefined, timeZone);
  }

  /**
   * Static helper to escape an identifier.
   *
   * @param value - Identifier name or array of identifier names
   * @returns Escaped identifier string
   */
  public static escapeId(value: DriverSqlValue): string {
    return escapeId(value);
  }

  /**
   * Get the underlying mysql2 Pool instance when operating in connection pool mode.
   *
   * @returns Underlying mysql2 Promise Pool instance
   * @throws Error if client is in single-connection mode
   *
   * @example
   * const rawPool = db.getPool();
   */
  public getPool(): Pool {
    return this.connectionManager.getPool();
  }

  /**
   * Acquire a direct connection.
   *
   * When in pool mode, acquires a connection from the pool that must be released
   * via `connection.release()` or `client.releaseConnection(connection)`.
   * When in single connection mode, returns the primary connection.
   *
   * @returns Direct connection object
   *
   * @example
   * const conn = await db.getConnection();
   * try {
   *   // use raw connection...
   * } finally {
   *   db.releaseConnection(conn);
   * }
   */
  public async getConnection(): Promise<PoolConnection | Connection> {
    return this.connectionManager.getConnection();
  }

  /**
   * Release an acquired connection back to the pool.
   *
   * @param connection - Connection previously acquired via `getConnection()`
   */
  public releaseConnection(connection: PoolConnection | Connection): void {
    this.connectionManager.releaseConnection(connection);
  }

  /**
   * Return a raw SQL string to be embedded in `format()` without being escaped.
   *
   * @param sql - Raw SQL string
   * @returns Raw object
   *
   * @example
   * db.format('UPDATE users SET updated_at = ? WHERE id = ?', [SqlClient.raw('NOW()'), 1]);
   */
  public static raw(sql: string): Raw {
    return raw(sql);
  }

  /**
   * Return a raw SQL string to be embedded in `format()` without being escaped.
   *
   * @param sql - Raw SQL string
   * @returns Raw object
   *
   * @example
   * db.format('UPDATE users SET updated_at = ? WHERE id = ?', [db.rawSql('NOW()'), 1]);
   */
  public rawSql(sql: string): Raw {
    return raw(sql);
  }

  /**
   * Immediately destroy the active connection or connection pool without waiting for in-flight queries.
   */
  public destroy(): void {
    this.connectionManager.destroy();
  }

  /**
   * Deallocate a prepared statement on the persistent connection.
   *
   * @param sql - The SQL query string or options previously prepared
   */
  public unprepare(sql: string): void {
    this.connectionManager.unprepare(sql);
  }

  /**
   * Re-authenticate or change active database on the persistent connection (single-connection mode only).
   *
   * @param options - New user or database options
   */
  public async changeUser(options: ConnectionOptions): Promise<void> {
    await this.connectionManager.changeUser(options);
  }

  /**
   * Reset session state on the persistent connection (single-connection mode only).
   */
  public async reset(): Promise<void> {
    await this.connectionManager.reset();
  }

  /**
   * Subscribe to connection pool lifecycle events.
   */
  public override on(event: 'connection', listener: (connection: PoolConnection) => void): this;
  public override on(event: 'acquire', listener: (connection: PoolConnection) => void): this;
  public override on(event: 'release', listener: (connection: PoolConnection) => void): this;
  public override on(event: 'enqueue', listener: () => void): this;
  public override on(event: string | symbol, listener: (...args: any[]) => void): this;
  public override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /**
   * Subscribe once to connection pool lifecycle events.
   */
  public override once(event: 'connection', listener: (connection: PoolConnection) => void): this;
  public override once(event: 'acquire', listener: (connection: PoolConnection) => void): this;
  public override once(event: 'release', listener: (connection: PoolConnection) => void): this;
  public override once(event: 'enqueue', listener: () => void): this;
  public override once(event: string | symbol, listener: (...args: any[]) => void): this;
  public override once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  /**
   * Execute a query/statement with shared timeout, retry, cancellation,
   * and hook policies.
   *
   * @template T - Result type returned by the run callback
   * @param args - Policy context and execution callback
   * @returns Promise resolving to operation result
   * @throws Error when execution fails after retries or cancellation/timeout
   */
  private async runQuery<T>(
    sql: string,
    parameters: SqlParameters,
    options: QueryExecutionOptions,
    allowRetry: boolean,
    run: (registerCancel?: (cancel: () => void) => void) => Promise<T>
  ): Promise<SqlQueryResult<T>> {
    const value = await this.runCore<T>('query', sql, parameters, options, allowRetry, run);
    return value as SqlQueryResult<T>;
  }

  private async runExecute<T>(
    sql: string,
    parameters: SqlParameters,
    options: QueryExecutionOptions,
    allowRetry: boolean,
    run: (registerCancel?: (cancel: () => void) => void) => Promise<T>
  ): Promise<SqlExecuteResult<T>> {
    const value = await this.runCore<T>('execute', sql, parameters, options, allowRetry, run);
    return value as SqlExecuteResult<T>;
  }

  private async runCore<T>(
    kind: 'query' | 'execute',
    sql: string,
    parameters: SqlParameters,
    options: QueryExecutionOptions,
    allowRetry: boolean,
    run: (registerCancel?: (cancel: () => void) => void) => Promise<T>
  ): Promise<SqlQueryResult<T> | SqlExecuteResult<T>> {
    assertSupportedSqlParameters(parameters);

    const timeoutMs = options.timeoutMs ?? this.defaultQueryTimeoutMs;
    const signal = options.signal;
    const retryEnabled = options.retry !== false;
    const maxRetries = retryEnabled && allowRetry ? this.retryOptions.maxRetries : 0;

    let attempt = 0;

    while (true) {
      if (signal?.aborted) {
        throw this.createAbortError();
      }

      const ctx: MiddlewareContext = { kind, sql, parameters, attempt, timeoutMs };
      const startedAt = Date.now();

      try {
        await this.runMiddlewareChain(ctx, async () => {
          const shouldActiveCancellation = (typeof timeoutMs === 'number' && timeoutMs > 0) || Boolean(signal);
          let cancelActiveOperation: (() => void) | undefined;

          const value = await this.withTimeoutAndCancellation(
            shouldActiveCancellation
              ? run(cancel => {
                  cancelActiveOperation = cancel;
                })
              : run(),
            timeoutMs,
            signal,
            () => {
              cancelActiveOperation?.();
            }
          );

          ctx.durationMs = Date.now() - startedAt;
          ctx.result = value;
        });

        const durationMs = ctx.durationMs ?? Date.now() - startedAt;
        const value = ctx.result as T;

        if (kind === 'query') {
          const enriched: SqlQueryResult<T> = { rows: value, sql, parameters, durationMs, attempt };
          this.emit('query', enriched);
          return enriched;
        }

        const enriched: SqlExecuteResult<T> = { result: value, sql, parameters, durationMs, attempt };
        this.emit('execute', enriched);
        return enriched;
      } catch (error) {
        ctx.error = error;
        ctx.durationMs = Date.now() - startedAt;
        this.emit('error:query', { kind, sql, parameters, attempt, durationMs: ctx.durationMs, error });

        if (attempt >= maxRetries || !this.isRetryableError(error)) {
          throw error;
        }

        this.connectionManager.invalidatePrimaryConnection();
        attempt += 1;
        await this.delay(this.getRetryDelayMs(attempt));
      }
    }
  }

  /**
   * Execute the registered middleware chain, with the actual DB call as the innermost step.
   */
  private async runMiddlewareChain(ctx: MiddlewareContext, execute: () => Promise<void>): Promise<void> {
    const chain = [...this.middlewares];
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      if (i === chain.length) {
        return execute();
      }
      await chain[i](ctx, () => dispatch(i + 1));
    };

    await dispatch(0);
  }

  /**
   * Wrap an in-flight promise with optional timeout and abort-signal handling.
   *
   * @template T - Result type of the wrapped promise
   * @param promise - Underlying query/statement promise
   * @param timeoutMs - Optional timeout in milliseconds
   * @param signal - Optional abort signal
   * @returns Promise resolving/rejecting based on original promise or cancel/timeout
   */
  private async withTimeoutAndCancellation<T>(
    promise: Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
    onCancel?: () => void
  ): Promise<T> {
    if (!timeoutMs && !signal) {
      return promise;
    }

    return new Promise<T>((resolve, reject) => {
      let completed = false;
      let timeoutId: NodeJS.Timeout | undefined;

      const onAbort = (): void => {
        if (completed) {
          return;
        }
        completed = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        onCancel?.();
        reject(this.createAbortError());
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (completed) {
            return;
          }
          completed = true;
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          onCancel?.();
          reject(new Error(`Query timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      promise.then(
        result => {
          if (completed) {
            return;
          }
          completed = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve(result);
        },
        error => {
          if (completed) {
            return;
          }
          completed = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(error);
        }
      );
    });
  }

  /**
   * Determine whether an error is retryable using configured error codes.
   *
   * @param error - Error thrown by mysql2 or underlying runtime
   * @returns True when the error code is configured as retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const maybeCode = error as { code?: string };
    return typeof maybeCode.code === 'string' && this.retryableErrorCodes.has(maybeCode.code);
  }

  /**
   * Compute exponential backoff delay for a retry attempt.
   *
   * @param attempt - Retry attempt number starting from 1
   * @returns Delay in milliseconds, optionally jittered
   */
  private getRetryDelayMs(attempt: number): number {
    const base = this.retryOptions.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(base, this.retryOptions.maxDelayMs);
    if (!this.retryOptions.jitter) {
      return capped;
    }

    const floor = Math.max(1, Math.floor(capped / 2));
    return floor + Math.floor(Math.random() * (capped - floor + 1));
  }

  /**
   * Sleep helper used between retry attempts.
   *
   * @param ms - Delay duration in milliseconds
   */
  private async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Release a transaction connection when startup fails before TransactionClient takes ownership.
   */
  private async releaseTransactionConnection(connection: Connection): Promise<void> {
    const maybePooledConnection = connection as Connection & {
      release?: () => void;
      destroy?: () => void;
      connection?: { release?: () => void };
    };

    if (typeof maybePooledConnection.connection?.release === 'function') {
      maybePooledConnection.release?.();
      return;
    }

    if (typeof maybePooledConnection.release === 'function' && !('connection' in maybePooledConnection)) {
      maybePooledConnection.release();
      return;
    }

    try {
      await connection.end();
    } catch {
      maybePooledConnection.destroy?.();
    }
  }

  /**
   * Create a standardized abort error used for signal-driven cancellation.
   *
   * @returns Error with name set to AbortError
   */
  private createAbortError(): Error {
    const error = new Error('Query was aborted');
    error.name = 'AbortError';
    return error;
  }

  /**
   * Ensure `execute()` is used only for write statements.
   */
  private assertExecuteStatement(sql: string): void {
    const leadingKeyword = this.getLeadingSqlKeyword(sql);
    if (leadingKeyword === 'SELECT' || leadingKeyword === 'WITH') {
      throw new Error('execute() does not support SELECT queries. Use query() instead.');
    }
  }

  /**
   * Ensure `query()` is used only for SELECT statements.
   */
  private assertQueryStatement(sql: string): void {
    const leadingKeyword = this.getLeadingSqlKeyword(sql);
    if (leadingKeyword && leadingKeyword !== 'SELECT' && leadingKeyword !== 'WITH') {
      throw new Error('query() supports SELECT queries only. Use execute() or raw() instead.');
    }
  }

  /**
   * Extract the first SQL keyword while ignoring leading comments and whitespace.
   */
  private getLeadingSqlKeyword(sql: string): string | undefined {
    let index = 0;

    while (index < sql.length) {
      while (index < sql.length && /\s/.test(sql[index])) {
        index += 1;
      }

      if (sql.startsWith('--', index)) {
        const newlineIndex = sql.indexOf('\n', index + 2);
        index = newlineIndex === -1 ? sql.length : newlineIndex + 1;
        continue;
      }

      if (sql.startsWith('#', index)) {
        const newlineIndex = sql.indexOf('\n', index + 1);
        index = newlineIndex === -1 ? sql.length : newlineIndex + 1;
        continue;
      }

      if (sql.startsWith('/*', index)) {
        const commentEndIndex = sql.indexOf('*/', index + 2);
        index = commentEndIndex === -1 ? sql.length : commentEndIndex + 2;
        continue;
      }

      break;
    }

    const keywordMatch = /^[A-Za-z]+/.exec(sql.slice(index));
    return keywordMatch?.[0].toUpperCase();
  }
}
