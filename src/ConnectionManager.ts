import type { EventEmitter } from 'node:events';
import type { ConnectionOptions, ExecuteValues, QueryValues } from 'mysql2';
import { createConnection, createPool, type Connection, type Pool, type PoolConnection } from 'mysql2/promise';
import type { PoolOptions, QueryResult_, QueryRows, SqlParameters } from './types';
import { has2DArrayParameter } from './SqlParameterValidation';

/**
 * Internal connection management class that handles both single connections
 * and connection pooling for the SqlClient.
 *
 * This class abstracts away the complexity of switching between:
 * - Single persistent connection mode
 * - Connection pool mode
 *
 * @internal
 * @example
 * // Single connection
 * const manager = new ConnectionManager({ host: 'localhost', user: 'root' }, false);
 * const conn = await manager.getPrimaryConnection();
 *
 * // Connection pool
 * const manager = new ConnectionManager({ host: 'localhost', user: 'root', connectionLimit: 10 }, true);
 * const conn = await manager.getPrimaryConnection();
 */
export class ConnectionManager {
  /** The primary (persistent) connection for single-connection mode */
  private primaryConnection?: Connection;

  /** The connection pool for pool mode */
  private pool?: Pool;

  /** Whether this manager is in pool mode (true) or single-connection mode (false) */
  private readonly isPooled: boolean;

  /** MySQL connection options */
  private readonly options: ConnectionOptions;

  /** Event emitter for forwarding pool lifecycle events */
  private eventEmitter?: EventEmitter;

  /**
   * Create a new ConnectionManager.
   *
   * @param options - MySQL connection options or pool options
   * @param isPooled - Whether to use connection pooling (default: false)
   *
   * @example
   * const manager = new ConnectionManager(
   *   { host: 'localhost', user: 'root', database: 'mydb' },
   *   false // single connection mode
   * );
   */
  public constructor(options: ConnectionOptions | PoolOptions, isPooled = false) {
    const mysqlOptions = this.stripOptionsForMysql2(options as PoolOptions);
    this.options = { timezone: 'Z', ...mysqlOptions };
    this.isPooled = isPooled;
  }

  private isPinned = false;

  /**
   * Create a ConnectionManager that wraps an already active connection.
   * All operations on this manager execute on this exact connection.
   *
   * @param connection - The active MySQL connection
   * @param options - Optional connection options
   * @returns A new ConnectionManager bound to the connection
   * @internal
   */
  public static fromConnection(connection: Connection, options: ConnectionOptions = {}): ConnectionManager {
    const manager = new ConnectionManager(options, false);
    manager.primaryConnection = connection;
    manager.isPinned = true;
    return manager;
  }

  /**
   * Returns true if this manager is configured to use a pool.
   *
   * @returns Whether pool mode is enabled
   */
  public isPoolMode(): boolean {
    return this.isPooled;
  }

  /**
   * Execute a SELECT query using the primary connection strategy.
   *
   * In pool mode this delegates to pool.query(), which acquires and releases
   * connections automatically.
   */
  public async query<T extends QueryRows>(sql: string, parameters: SqlParameters): Promise<T> {
    if (this.isPooled) {
      const result = await this.ensurePool().query<T>(sql, [...parameters]);
      const rows = Array.isArray(result) ? result[0] : result;
      return rows as T;
    }

    const connection = await this.getPrimaryConnection();
    try {
      const result = await connection.query<T>(sql, [...parameters]);
      const rows = Array.isArray(result) ? result[0] : result;
      return rows as T;
    } catch (error) {
      if (this.isFatalConnectionError(error)) {
        this.invalidatePrimaryConnection(connection);
      }
      throw error;
    }
  }

  /**
   * Execute a non-SELECT statement using the primary connection strategy.
   *
   * In pool mode this delegates to pool.execute(), which acquires and releases
   * connections automatically.
   */
  public async execute<T extends QueryResult_>(sql: string, parameters: SqlParameters): Promise<T> {
    const is2D = has2DArrayParameter(parameters);
    if (this.isPooled) {
      const result = is2D
        ? await this.ensurePool().query<T>(sql, [...parameters] as unknown as QueryValues)
        : await this.ensurePool().execute<T>(sql, [...parameters] as unknown as ExecuteValues);
      const executeResult = Array.isArray(result) ? result[0] : result;
      return executeResult as T;
    }

    const connection = await this.getPrimaryConnection();
    try {
      const result = is2D
        ? await connection.query<T>(sql, [...parameters] as unknown as QueryValues)
        : await connection.execute<T>(sql, [...parameters] as unknown as ExecuteValues);
      const executeResult = Array.isArray(result) ? result[0] : result;
      return executeResult as T;
    } catch (error) {
      if (this.isFatalConnectionError(error)) {
        this.invalidatePrimaryConnection(connection);
      }
      throw error;
    }
  }

  /**
   * Execute a SELECT query and register a cancellation callback that can
   * terminate the underlying active connection.
   *
   * @param sql - SQL query
   * @param parameters - Query parameters
   * @param registerCancel - Callback receiver for operation cancellation
   * @returns Query rows
   */
  public async queryCancelable<T extends QueryRows>(
    sql: string,
    parameters: SqlParameters,
    registerCancel: (cancel: () => void) => void
  ): Promise<T> {
    if (this.isPooled) {
      const connection = await this.ensurePool().getConnection();
      let canceled = false;
      registerCancel(() => {
        canceled = true;
        this.terminateConnection(connection as unknown as Connection);
      });

      try {
        const result = await connection.query<T>(sql, [...parameters]);
        const rows = Array.isArray(result) ? result[0] : result;
        return rows as T;
      } finally {
        if (!canceled) {
          connection.release();
        }
      }
    }

    const connection = await this.getPrimaryConnection();
    registerCancel(() => {
      this.terminateConnection(connection);
      this.invalidatePrimaryConnection(connection);
    });

    const result = await connection.query<T>(sql, [...parameters]);
    const rows = Array.isArray(result) ? result[0] : result;
    return rows as T;
  }

  /**
   * Execute a statement and register a cancellation callback that can
   * terminate the underlying active connection.
   *
   * @param sql - SQL statement
   * @param parameters - Statement parameters
   * @param registerCancel - Callback receiver for operation cancellation
   * @returns Statement result
   */
  public async executeCancelable<T extends QueryResult_>(
    sql: string,
    parameters: SqlParameters,
    registerCancel: (cancel: () => void) => void
  ): Promise<T> {
    const is2D = has2DArrayParameter(parameters);
    if (this.isPooled) {
      const connection = await this.ensurePool().getConnection();
      let canceled = false;
      registerCancel(() => {
        canceled = true;
        this.terminateConnection(connection as unknown as Connection);
      });

      try {
        const result = is2D
          ? await connection.query<T>(sql, [...parameters] as unknown as QueryValues)
          : await connection.execute<T>(sql, [...parameters] as unknown as ExecuteValues);
        const executeResult = Array.isArray(result) ? result[0] : result;
        return executeResult as T;
      } finally {
        if (!canceled) {
          connection.release();
        }
      }
    }

    const connection = await this.getPrimaryConnection();
    registerCancel(() => {
      this.terminateConnection(connection);
      this.invalidatePrimaryConnection(connection);
    });

    const result = is2D
      ? await connection.query<T>(sql, [...parameters] as unknown as QueryValues)
      : await connection.execute<T>(sql, [...parameters] as unknown as ExecuteValues);
    const executeResult = Array.isArray(result) ? result[0] : result;
    return executeResult as T;
  }

  /**
   * Set the event emitter to receive forwarded pool lifecycle events.
   *
   * @param emitter - The EventEmitter (typically the SqlClient instance)
   */
  public setEventEmitter(emitter: EventEmitter): void {
    this.eventEmitter = emitter;
    if (this.pool) {
      this.attachPoolEvents(this.pool);
    }
  }

  private attachPoolEvents(pool: Pool): void {
    if (!this.eventEmitter) {
      return;
    }
    const emitter = this.eventEmitter;
    pool.on('connection', (...args: unknown[]) => emitter.emit('connection', ...args));
    pool.on('acquire', (...args: unknown[]) => emitter.emit('acquire', ...args));
    pool.on('release', (...args: unknown[]) => emitter.emit('release', ...args));
    pool.on('enqueue', (...args: unknown[]) => emitter.emit('enqueue', ...args));
  }

  /**
   * Lazily create and return the pool.
   *
   * @returns Active mysql2 pool instance
   */
  private ensurePool(): Pool {
    if (!this.pool) {
      this.pool = createPool(this.options as PoolOptions);
      this.attachPoolEvents(this.pool);
    }

    return this.pool;
  }

  /**
   * Get a connection from the pool or return the persistent connection.
   *
   * In single-connection mode, creates and reuses one connection.
   * In pool mode, gets a connection from the pool and reuses it for getPrimaryConnection callers.
   *
   * @returns Promise resolving to a Connection object
   * @throws Error if connection creation fails
   *
   * @example
   * const connection = await manager.getPrimaryConnection();
   * const rows = await connection.query('SELECT * FROM users');
   */
  public async getPrimaryConnection(): Promise<Connection> {
    if (this.isPooled) {
      if (!this.primaryConnection) {
        this.primaryConnection = await this.ensurePool().getConnection();
      }
      return this.primaryConnection;
    }

    if (!this.primaryConnection) {
      if (this.isPinned) {
        throw new Error('Pinned connection has been closed or terminated.');
      }
      const connection = await createConnection(this.options);
      this.attachConnectionErrorHandler(connection);
      this.primaryConnection = connection;
    }

    return this.primaryConnection;
  }

  /**
   * Invalidate the primary connection so subsequent operations reconnect.
   *
   * @param connection - Optional specific connection to invalidate
   */
  public invalidatePrimaryConnection(connection?: Connection): void {
    if (!connection || this.primaryConnection === connection) {
      this.primaryConnection = undefined;
    }
  }

  /**
   * Create a new connection for a transaction.
   *
   * In single-connection mode, creates a new dedicated connection.
   * In pool mode, gets a connection from the pool.
   *
   * Each transaction gets its own connection to ensure ACID guarantees.
   *
   * @returns Promise resolving to a Connection object for the transaction
   * @throws Error if connection creation fails
   *
   * @internal
   *
   * @example
   * const txConnection = await manager.createTransactionalConnection();
   * await txConnection.beginTransaction();
   * // ... execute statements ...
   * await txConnection.commit();
   */
  public async createTransactionalConnection(): Promise<Connection> {
    if (this.isPooled) {
      // Transactional work needs a dedicated connection from the pool.
      return this.ensurePool().getConnection();
    }

    return createConnection(this.options);
  }

  /**
   * Return the underlying mysql2 Pool instance when in pool mode.
   *
   * @returns Active mysql2 Promise Pool instance
   * @throws Error if client is in single-connection mode
   */
  public getPool(): Pool {
    if (!this.isPooled) {
      throw new Error(
        'getPool() is only available when SqlClient is configured in pool mode (e.g. via SqlClient.createPool()).'
      );
    }
    return this.ensurePool();
  }

  /**
   * Acquire a direct connection.
   *
   * In pool mode, acquires a connection from the pool that should be released
   * using `connection.release()` or `releaseConnection(connection)`.
   * In single-connection mode, returns the primary connection.
   *
   * @returns Connection or PoolConnection instance
   */
  public async getConnection(): Promise<PoolConnection | Connection> {
    if (this.isPooled) {
      return this.ensurePool().getConnection();
    }
    return this.getPrimaryConnection();
  }

  /**
   * Release an acquired connection back to the pool.
   *
   * @param connection - Connection previously acquired via `getConnection()`
   */
  public releaseConnection(connection: PoolConnection | Connection): void {
    const maybePooled = connection as { release?: () => void };
    if (typeof maybePooled.release === 'function') {
      maybePooled.release();
    }
  }

  /**
   * Get the connection options configured on this manager.
   *
   * @returns Readonly connection options
   */
  public getOptions(): Readonly<ConnectionOptions> {
    return this.options;
  }

  /**
   * Close the connection or connection pool.
   *
   * In single-connection mode, closes the persistent connection.
   * In pool mode, closes all connections in the pool.
   *
   * After calling this method, the ConnectionManager cannot be reused.
   * Create a new ConnectionManager if you need to reconnect.
   *
   * @returns Promise that resolves when the connection is closed
   *
   * @example
   * await manager.close();
   * // manager is now unusable
   */
  public async close(): Promise<void> {
    if (this.primaryConnection) {
      const connection = this.primaryConnection;
      this.primaryConnection = undefined;
      const maybePooled = connection as Connection & { release?: () => void };
      if (this.isPooled && typeof maybePooled.release === 'function') {
        maybePooled.release();
      } else if (!this.isPooled) {
        await connection.end();
      }
    }

    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      return;
    }
  }

  /**
   * Immediately destroy the connection or connection pool without waiting for in-flight queries.
   */
  public destroy(): void {
    if (this.primaryConnection) {
      const connection = this.primaryConnection;
      this.primaryConnection = undefined;
      this.terminateConnection(connection);
    }

    if (this.pool) {
      const pool = this.pool;
      this.pool = undefined;
      const destroyable = pool as unknown as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      } else {
        pool.end().catch(() => {});
      }
    }
  }

  /**
   * Deallocate a prepared statement on the persistent connection.
   *
   * @param sql - The SQL query string or options previously prepared
   */
  public unprepare(sql: string): void {
    if (this.primaryConnection) {
      this.primaryConnection.unprepare(sql);
    }
  }

  /**
   * Re-authenticate or change active database on the persistent connection.
   *
   * @param options - New user or database options
   */
  public async changeUser(options: ConnectionOptions): Promise<void> {
    if (this.isPooled) {
      throw new Error(
        'changeUser() cannot be invoked directly on a pooled SqlClient as it would affect only an arbitrary pooled connection. Use client.getConnection() to acquire a dedicated connection, or create a new pool with the target credentials.'
      );
    }
    const connection = await this.getPrimaryConnection();
    await connection.changeUser(options);
  }

  /**
   * Reset session state on the persistent connection.
   */
  public async reset(): Promise<void> {
    if (this.isPooled) {
      throw new Error(
        'reset() cannot be invoked directly on a pooled SqlClient. Use client.getConnection() to acquire and reset a dedicated connection.'
      );
    }
    const connection = await this.getPrimaryConnection();
    await connection.reset();
  }

  /**
   * Terminate a connection immediately when cancellation or failed lock release
   * requires aborting in-flight work and preventing dirty session reuse.
   *
   * @param connection - The MySQL connection to destroy
   * @internal
   */
  public terminateConnection(connection: Connection): void {
    if (this.primaryConnection === connection) {
      this.primaryConnection = undefined;
    }

    const destroyable = connection as Connection & {
      destroy?: () => void;
      connection?: { destroy?: () => void };
    };

    try {
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
        return;
      }
      destroyable.connection?.destroy?.();
    } catch {
      // Ignore errors during emergency termination
    }
  }

  private attachConnectionErrorHandler(connection: Connection): void {
    const emitter = connection as unknown as {
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
    };

    if (typeof emitter.on === 'function') {
      emitter.on('error', () => {
        if (this.primaryConnection === connection) {
          this.primaryConnection = undefined;
        }
      });
    }
  }

  private isFatalConnectionError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const maybeErr = error as { code?: string; fatal?: boolean };
    if (maybeErr.fatal === true) {
      return true;
    }

    const connectionCodes = new Set([
      'PROTOCOL_CONNECTION_LOST',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'ENOTFOUND',
      'ECONNREFUSED',
      'ER_SERVER_SHUTDOWN',
      'ERR_STREAM_WRITE_AFTER_END'
    ]);

    return typeof maybeErr.code === 'string' && connectionCodes.has(maybeErr.code);
  }

  private stripOptionsForMysql2(options: PoolOptions): ConnectionOptions {
    const { retry: _, defaultQueryTimeoutMs: __, enforceStatementKinds: ___, ...mysqlOptions } = options;
    return mysqlOptions;
  }
}
