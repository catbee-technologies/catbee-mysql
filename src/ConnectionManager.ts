import type { ConnectionOptions } from 'mysql2';
import { createConnection, createPool, type Connection, type Pool } from 'mysql2/promise';
import type { PoolOptions, QueryResult_, QueryRows, SqlParameters } from './types';

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
    const result = await connection.query<T>(sql, [...parameters]);
    const rows = Array.isArray(result) ? result[0] : result;
    return rows as T;
  }

  /**
   * Execute a non-SELECT statement using the primary connection strategy.
   *
   * In pool mode this delegates to pool.execute(), which acquires and releases
   * connections automatically.
   */
  public async execute<T extends QueryResult_>(sql: string, parameters: SqlParameters): Promise<T> {
    if (this.isPooled) {
      const result = await this.ensurePool().execute<T>(sql, [...parameters]);
      const executeResult = Array.isArray(result) ? result[0] : result;
      return executeResult as T;
    }

    const connection = await this.getPrimaryConnection();
    const result = await connection.execute<T>(sql, [...parameters]);
    const executeResult = Array.isArray(result) ? result[0] : result;
    return executeResult as T;
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
      if (this.primaryConnection === connection) {
        this.primaryConnection = undefined;
      }
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
    if (this.isPooled) {
      const connection = await this.ensurePool().getConnection();
      let canceled = false;
      registerCancel(() => {
        canceled = true;
        this.terminateConnection(connection as unknown as Connection);
      });

      try {
        const result = await connection.execute<T>(sql, [...parameters]);
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
      if (this.primaryConnection === connection) {
        this.primaryConnection = undefined;
      }
    });

    const result = await connection.execute<T>(sql, [...parameters]);
    const executeResult = Array.isArray(result) ? result[0] : result;
    return executeResult as T;
  }

  /**
   * Lazily create and return the pool.
   *
   * @returns Active mysql2 pool instance
   */
  private ensurePool(): Pool {
    if (!this.pool) {
      this.pool = createPool(this.options as PoolOptions);
    }

    return this.pool;
  }

  /**
   * Get a connection from the pool or return the persistent connection.
   *
   * In single-connection mode, creates and reuses one connection.
   * In pool mode, gets a connection from the pool or waits for one to be available.
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
      // Kept for backward compatibility. For pooled non-transactional queries,
      // prefer query()/execute() on this manager so pool handles release.
      return this.ensurePool().getConnection();
    }

    if (!this.primaryConnection) {
      this.primaryConnection = await createConnection(this.options);
    }

    return this.primaryConnection;
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
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
      return;
    }

    if (!this.primaryConnection) {
      return;
    }

    const connection = this.primaryConnection;
    this.primaryConnection = undefined;
    await connection.end();
  }

  /**
   * Terminate a connection immediately when cancellation requires aborting in-flight work.
   */
  private terminateConnection(connection: Connection): void {
    const destroyable = connection as Connection & {
      destroy?: () => void;
      connection?: { destroy?: () => void };
    };

    if (typeof destroyable.destroy === 'function') {
      destroyable.destroy();
      return;
    }

    destroyable.connection?.destroy?.();
  }

  private stripOptionsForMysql2(options: PoolOptions): ConnectionOptions {
    const { retry: _, defaultQueryTimeoutMs: __, enforceStatementKinds: ___, ...mysqlOptions } = options;
    return mysqlOptions;
  }
}
