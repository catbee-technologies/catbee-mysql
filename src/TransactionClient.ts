import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QueryResult_, QueryRows, SqlParameters, SqlTransaction } from './types';
import { assertSupportedSqlParameters } from './SqlParameterValidation';

/**
 * Transaction client implementation that wraps a connection and provides
 * all query execution methods plus commit/rollback capabilities.
 *
 * This class ensures that a transaction can only be used after it's begun
 * and not after it's been committed or rolled back.
 *
 * @implements {SqlTransaction}
 * @internal
 *
 * @example
 * const tx = new TransactionClient(connection);
 * try {
 *   await tx.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
 *   await tx.commit();
 * } catch (error) {
 *   await tx.rollback();
 * }
 */
export class TransactionClient implements SqlTransaction {
  /** Whether the transaction has been completed (committed or rolled back) */
  private released = false;
  private savepointCounter = 0;

  /**
   * Create a new TransactionClient.
   *
   * The connection should already have `beginTransaction()` called on it.
   *
   * @param connection - The mysql2/promise Connection object
   *
   * @internal
   */
  public constructor(private readonly connection: Connection) {}

  /**
   * Execute a SELECT query within the transaction.
   *
   * @template T - The type of rows returned
   * @param sql - The SQL query string
   * @param parameters - Query parameters for parameterized queries (default: [])
   * @returns Promise resolving to query result rows
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const rows = await tx.query('SELECT * FROM users WHERE age > ?', [18]);
   */
  public async query<T extends QueryRows = RowDataPacket[]>(sql: string, parameters: SqlParameters = []): Promise<T> {
    this.assertActive();
    assertSupportedSqlParameters(parameters);
    const result = await this.connection.query<T>(sql, [...parameters]);
    // Handle both array and tuple returns from mysql2/promise
    const rows = Array.isArray(result) ? result[0] : result;
    return rows as T;
  }

  /**
   * Execute an INSERT, UPDATE, or DELETE statement within the transaction.
   *
   * @template T - The type of result (default: ResultSetHeader)
   * @param sql - The SQL statement
   * @param parameters - Statement parameters (default: [])
   * @returns Promise resolving to the result
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const result = await tx.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
   */
  public async execute<T extends QueryResult_ = ResultSetHeader>(
    sql: string,
    parameters: SqlParameters = []
  ): Promise<T> {
    this.assertActive();
    assertSupportedSqlParameters(parameters);
    const result = await this.connection.execute<T>(sql, [...parameters]);
    // Handle both array and tuple returns from mysql2/promise
    const executeResult = Array.isArray(result) ? result[0] : result;
    return executeResult as T;
  }

  /**
   * Get a single row from a query within the transaction.
   * Throws an error if the query returns more than one row.
   *
   * @template T - The row type (default: RowDataPacket)
   * @param sql - The SQL query
   * @param parameters - Query parameters (default: [])
   * @returns Promise resolving to the row or null if not found
   * @throws Error if the query returns more than one row
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const user = await tx.get('SELECT * FROM users WHERE id = ?', [1]);
   * if (user) {
   *   console.log(user.name);
   * }
   */
  public async get<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    parameters: SqlParameters = []
  ): Promise<T | null> {
    const rows = await this.query<T[]>(sql, parameters);
    if (rows.length > 1) {
      throw new Error('get() returned more than one row');
    }

    if (rows.length === 1) {
      return rows[0];
    }

    return null;
  }

  /**
   * Get all matching rows from a query within the transaction.
   *
   * @template T - The row type (default: RowDataPacket)
   * @param sql - The SQL query
   * @param parameters - Query parameters (default: [])
   * @returns Promise resolving to an array of rows
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const users = await tx.all('SELECT * FROM users WHERE active = ?', [true]);
   */
  public async all<T extends RowDataPacket = RowDataPacket>(sql: string, parameters: SqlParameters = []): Promise<T[]> {
    return this.query<T[]>(sql, parameters);
  }

  /**
   * Execute an INSERT statement and return the affected rows count.
   *
   * @param sql - The INSERT statement
   * @param parameters - Statement parameters (default: [])
   * @returns Promise resolving to the number of affected rows
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const affectedRows = await tx.insert(
   *   'INSERT INTO users(name, email) VALUES(?, ?)',
   *   ['Alice', 'alice@example.com']
   * );
   */
  public async insert(sql: string, parameters: SqlParameters = []): Promise<number> {
    const result = await this.execute<ResultSetHeader>(sql, parameters);
    return result.affectedRows;
  }

  /**
   * Execute an UPDATE statement and return the affected rows count.
   *
   * @param sql - The UPDATE statement
   * @param parameters - Statement parameters (default: [])
   * @param returnChangedRows - If true, return changedRows instead of affectedRows (default: false)
   * @returns Promise resolving to the count of affected or changed rows
   * @throws Error if the transaction has already been completed
   *
   * @example
   * // Return affected rows
   * const affected = await tx.update(
   *   'UPDATE users SET active = ? WHERE id = ?',
   *   [true, 1]
   * );
   *
   * // Return changed rows (actual modifications)
   * const changed = await tx.update(
   *   'UPDATE users SET active = ? WHERE id = ?',
   *   [true, 1],
   *   true // returnChangedRows flag
   * );
   */
  public async update(sql: string, parameters: SqlParameters = [], returnChangedRows = false): Promise<number> {
    const result = await this.execute<ResultSetHeader>(sql, parameters);
    return returnChangedRows ? result.changedRows : result.affectedRows;
  }

  /**
   * Execute a DELETE statement and return the deleted rows count.
   *
   * @param sql - The DELETE statement
   * @param parameters - Statement parameters (default: [])
   * @returns Promise resolving to the number of deleted rows
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const deleted = await tx.delete('DELETE FROM users WHERE id = ?', [1]);
   */
  public async delete(sql: string, parameters: SqlParameters = []): Promise<number> {
    const result = await this.execute<ResultSetHeader>(sql, parameters);
    return result.affectedRows;
  }

  /**
   * Check whether any rows match the given query within the transaction.
   *
   * @param sql - The SELECT query string
   * @param parameters - Query parameters (default: [])
   * @returns Promise resolving to true if at least one row is found
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const exists = await tx.exists('SELECT 1 FROM users WHERE email = ?', ['alice@example.com']);
   */
  public async exists(sql: string, parameters: SqlParameters = []): Promise<boolean> {
    const rows = await this.query<RowDataPacket[]>(sql, parameters);
    return rows.length > 0;
  }

  /**
   * Return the numeric value of the first column of the first row within the transaction.
   *
   * Intended for aggregate queries such as `COUNT(*)`, `SUM()`, `AVG()`.
   * Returns `0` when the query returns no rows.
   *
   * @param sql - The aggregate SELECT query
   * @param parameters - Query parameters (default: [])
   * @returns Promise resolving to the numeric result
   * @throws Error if the transaction has already been completed
   *
   * @example
   * const total = await tx.count('SELECT COUNT(*) FROM orders WHERE user_id = ?', [userId]);
   */
  public async count(sql: string, parameters: SqlParameters = []): Promise<number> {
    const rows = await this.query<RowDataPacket[]>(sql, parameters);
    if (rows.length === 0) {
      return 0;
    }

    const firstValue = Object.values(rows[0])[0];
    return typeof firstValue === 'number' ? firstValue : Number(firstValue);
  }

  /**
   * Commit the transaction.
   *
   * Persists all changes made within this transaction and closes the connection.
   * After calling this method, the transaction cannot be used again.
   *
   * @returns Promise that resolves when the transaction is committed
   * @throws Error if the transaction was already completed (committed or rolled back)
   *
   * @example
   * await tx.execute('INSERT INTO users(name) VALUES(?)', ['Alice']);
   * await tx.commit(); // Changes are now persisted
   */
  public async commit(): Promise<void> {
    this.assertActive();

    try {
      await this.connection.commit();
    } finally {
      await this.release();
    }
  }

  /**
   * Rollback the transaction.
   *
   * Discards all changes made within this transaction and closes the connection.
   * After calling this method, the transaction cannot be used again.
   *
   * @returns Promise that resolves when the transaction is rolled back
   * @throws Error if the transaction was already completed (committed or rolled back)
   *
   * @example
   * try {
   *   await tx.execute('INSERT INTO users(name) VALUES(?)', ['Alice']);
   *   throw new Error('Something went wrong');
   * } catch (e) {
   *   await tx.rollback(); // All changes are discarded
   *   throw e;
   * }
   */
  public async rollback(): Promise<void> {
    this.assertActive();

    try {
      await this.connection.rollback();
    } finally {
      await this.release();
    }
  }

  /**
   * Create a transaction savepoint.
   *
   * Savepoints allow partial rollback inside an active transaction.
   * If no name is provided, a safe auto-generated name is used.
   *
   * @param name - Optional savepoint name
   * @returns Promise resolving to the created savepoint name
   * @throws Error if the transaction is already completed
   * @throws Error if provided savepoint name is invalid
   */
  public async savepoint(name?: string): Promise<string> {
    this.assertActive();
    const savepointName = this.normalizeSavepointName(name || `sp_${++this.savepointCounter}`);
    await this.connection.query(`SAVEPOINT ${this.escapeIdentifier(savepointName)}`);
    return savepointName;
  }

  /**
   * Roll back to a previously created savepoint.
   *
   * @param name - Savepoint name to roll back to
   * @returns Promise that resolves after rollback to the savepoint
   * @throws Error if the transaction is already completed
   * @throws Error if provided savepoint name is invalid
   */
  public async rollbackTo(name: string): Promise<void> {
    this.assertActive();
    const savepointName = this.normalizeSavepointName(name);
    await this.connection.query(`ROLLBACK TO SAVEPOINT ${this.escapeIdentifier(savepointName)}`);
  }

  /**
   * Release a previously created savepoint.
   *
   * @param name - Savepoint name to release
   * @returns Promise that resolves after releasing the savepoint
   * @throws Error if the transaction is already completed
   * @throws Error if provided savepoint name is invalid
   */
  public async releaseSavepoint(name: string): Promise<void> {
    this.assertActive();
    const savepointName = this.normalizeSavepointName(name);
    await this.connection.query(`RELEASE SAVEPOINT ${this.escapeIdentifier(savepointName)}`);
  }

  /**
   * Internal method to assert that the transaction is still active.
   * @throws Error if the transaction has already been completed
   * @internal
   */
  private assertActive(): void {
    if (this.released) {
      throw new Error('Transaction has already been completed');
    }
  }

  /**
   * Internal method to release the connection and mark the transaction as completed.
   * @internal
   */
  private async release(): Promise<void> {
    if (this.released) {
      return;
    }

    this.released = true;
    const maybePooledConnection = this.connection as Connection & {
      release?: () => void;
    };

    if (typeof maybePooledConnection.release === 'function') {
      maybePooledConnection.release();
      return;
    }

    await this.connection.end();
  }

  /**
   * Validate that a savepoint name is SQL-identifier safe.
   *
   * @param name - Candidate savepoint name
   * @returns Normalized savepoint name
   * @throws Error when the name is not a valid identifier
   */
  private normalizeSavepointName(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid savepoint name: "${name}"`);
    }

    return name;
  }

  /**
   * Escape an identifier using MySQL backtick escaping rules.
   *
   * @param value - Identifier to escape
   * @returns Escaped identifier wrapped in backticks
   */
  private escapeIdentifier(value: string): string {
    return `\`${value.replace(/`/g, '``')}\``;
  }
}
