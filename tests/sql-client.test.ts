import {
  createMockConnection,
  createMockPool,
  mockedCreateConnection,
  mockedCreatePool
} from './__mocks__/connection.mock';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { PoolConnection, type Connection, type Pool } from 'mysql2/promise';
import { SqlClient, compileNamedParameters } from '../src';
import { ConnectionManager } from '../src/ConnectionManager';
import { TransactionClient } from '../src/TransactionClient';

describe('SqlClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Single Connection Mode', () => {
    it('exposes pool mode flag as false for single connection clients', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const manager = (client as unknown as { connectionManager: { isPoolMode: () => boolean } }).connectionManager;
      expect(manager.isPoolMode()).toBe(false);
    });

    it('opens a primary connection and runs queries', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1, age: 22 }] as RowDataPacket[];

      primaryConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.query('SELECT * FROM users WHERE age > ?', [18])).resolves.toMatchObject({ rows });

      expect(mockedCreateConnection).toHaveBeenCalledTimes(1);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM users WHERE age > ?', [18]);

      await client.close();

      expect(primaryConnection.end).toHaveBeenCalledTimes(1);
    });

    it('executes statements on the primary connection', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 1, insertId: 0 } as ResultSetHeader;

      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1])).resolves.toMatchObject({
        result
      });

      expect(primaryConnection.execute).toHaveBeenCalledWith('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
    });

    it('rejects Date parameters before hitting mysql2', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.query('SELECT ?', [new Date()] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
      expect(primaryConnection.query).not.toHaveBeenCalled();
    });

    it('allows SELECT statements in execute() when strict statement enforcement is disabled', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1 }] as unknown as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.execute('SELECT * FROM users WHERE id = ?', [1])).resolves.toMatchObject({ result: rows });
      expect(primaryConnection.execute).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?', [1]);
    });

    it('enforces strict query/execute statement kinds when configured', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        enforceStatementKinds: true,
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.executeNamed('SELECT * FROM users WHERE id = :id', { id: 1 })).rejects.toThrow(
        'execute() does not support SELECT queries. Use query() instead.'
      );

      await expect(client.query('UPDATE users SET active = 1')).rejects.toThrow(
        'query() supports SELECT queries only. Use execute() or raw() instead.'
      );

      expect(primaryConnection.execute).not.toHaveBeenCalled();
      expect(primaryConnection.query).not.toHaveBeenCalled();
    });

    it('raw() supports SELECT and returns rows', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1, name: 'Alice' }] as RowDataPacket[];

      primaryConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.raw<RowDataPacket[]>('SELECT * FROM users WHERE id = ?', [1])).resolves.toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?', [1]);
    });

    it('raw() supports write statements and returns ResultSetHeader-like values', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 2, insertId: 0 } as ResultSetHeader;

      primaryConnection.query.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.raw<ResultSetHeader>('UPDATE users SET active = ? WHERE id = ?', [true, 1])).resolves.toEqual(
        result
      );
      expect(primaryConnection.query).toHaveBeenCalledWith('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
    });

    it('passes execution options to convenience methods (get, all, insert, update, delete)', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1, name: 'Alice' }] as RowDataPacket[];
      const result = { affectedRows: 2, changedRows: 1, insertId: 10 } as unknown as ResultSetHeader;

      primaryConnection.query.mockResolvedValue([rows, []]);
      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const opts = { timeoutMs: 3000 };
      await expect(client.get('SELECT * FROM users WHERE id = ?', [1], opts)).resolves.toEqual(rows[0]);
      await expect(client.all('SELECT * FROM users', [], opts)).resolves.toEqual(rows);
      await expect(client.insert('INSERT INTO users(name) VALUES(?)', ['Bob'], opts)).resolves.toBe(2);
      await expect(client.update('UPDATE users SET active = ?', [true], false, opts)).resolves.toBe(2);
      await expect(client.delete('DELETE FROM users WHERE id = ?', [1], opts)).resolves.toBe(2);
    });

    it('ping() returns false when connection fails', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockRejectedValue(new Error('connection lost'));
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.ping()).resolves.toBe(false);
    });

    it('rejects immediately when AbortSignal is already aborted', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const controller = new AbortController();
      controller.abort();

      await expect(client.query('SELECT 1', [], { signal: controller.signal })).rejects.toThrow('Query was aborted');
    });

    it('aborts an in-flight query when AbortSignal triggers', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolving
          })
      );
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const controller = new AbortController();
      const queryPromise = client.query('SELECT 1', [], { signal: controller.signal });

      setTimeout(() => controller.abort(), 10);

      await expect(queryPromise).rejects.toThrow('Query was aborted');
    });
  });

  describe('Manual Transactions', () => {
    it('creates manual transactions that commit and release their connection', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();
      const result = { affectedRows: 1, insertId: 0 } as ResultSetHeader;

      transactionConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const transaction = await client.startTransaction();
      await transaction.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
      await transaction.commit();

      expect(transactionConnection.beginTransaction).toHaveBeenCalledTimes(1);
      expect(transactionConnection.execute).toHaveBeenCalledWith('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
      expect(transactionConnection.commit).toHaveBeenCalledTimes(1);
      expect(transactionConnection.end).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid isolation levels and releases the connection', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.startTransaction({
          isolationLevel: 'SNAPSHOT' as unknown as 'READ COMMITTED'
        })
      ).rejects.toThrow('Invalid transaction isolation level: "SNAPSHOT"');

      expect(transactionConnection.end).toHaveBeenCalledTimes(1);
      expect(transactionConnection.beginTransaction).not.toHaveBeenCalled();
    });

    it('releases transaction connection when beginTransaction fails', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();
      const failure = new Error('begin failed');

      transactionConnection.beginTransaction.mockRejectedValue(failure);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.startTransaction()).rejects.toThrow(failure);
      expect(transactionConnection.end).toHaveBeenCalledTimes(1);
    });

    it('rolls back automatic transactions when the callback fails', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();
      const failure = new Error('boom');

      transactionConnection.query.mockResolvedValue([[], []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.transaction(async transaction => {
          await transaction.query('SELECT * FROM users');
          throw failure;
        })
      ).rejects.toThrow(failure);

      expect(transactionConnection.beginTransaction).toHaveBeenCalledTimes(1);
      expect(transactionConnection.rollback).toHaveBeenCalledTimes(1);
      expect(transactionConnection.end).toHaveBeenCalledTimes(1);
      expect(transactionConnection.commit).not.toHaveBeenCalled();
    });

    it('preserves callback error when rollback also fails', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();
      const failure = new Error('boom');
      const rollbackFailure = new Error('rollback failed');

      transactionConnection.query.mockResolvedValue([[], []]);
      transactionConnection.rollback.mockRejectedValue(rollbackFailure);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.transaction(async transaction => {
          await transaction.query('SELECT * FROM users');
          throw failure;
        })
      ).rejects.toBe(failure);

      const enrichedFailure = failure as Error & { cause?: unknown; rollbackError?: unknown };
      expect(enrichedFailure.cause).toBe(rollbackFailure);
      expect(enrichedFailure.rollbackError).toBe(rollbackFailure);
      expect(transactionConnection.end).toHaveBeenCalledTimes(1);
    });

    it('supports releaseSavepoint with explicit names', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.query.mockResolvedValue([[], []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const tx = await client.startTransaction();
      await tx.releaseSavepoint('custom_sp');
      await tx.rollback();

      expect(transactionConnection.query).toHaveBeenCalledWith('RELEASE SAVEPOINT `custom_sp`');
    });

    it('covers transaction get branches for null and multi-row results', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.query
        .mockResolvedValueOnce([[], []])
        .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }] as unknown as RowDataPacket[], []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const tx = await client.startTransaction();
      await expect(tx.get('SELECT * FROM users WHERE id = 1')).resolves.toBeNull();
      await expect(tx.get('SELECT * FROM users WHERE role = "admin"')).rejects.toThrow('more than one row');
      await tx.rollback();
    });

    it('covers transaction all with default parameters', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();
      const rows = [{ id: 1 }] as RowDataPacket[];

      transactionConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const tx = await client.startTransaction();
      await expect(tx.all('SELECT * FROM users')).resolves.toEqual(rows);
      await tx.rollback();
    });

    it('throws for invalid savepoint names', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.query.mockResolvedValue([[], []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const tx = await client.startTransaction();
      await expect(tx.savepoint('invalid-name')).rejects.toThrow('Invalid savepoint name');
      await tx.rollback();
    });

    it('throws when a completed transaction is reused', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.query.mockResolvedValue([[], []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const tx = await client.startTransaction();
      await tx.commit();
      await expect(tx.query('SELECT 1')).rejects.toThrow('Transaction has already been completed');
    });

    it('allows Buffer parameters inside transactions', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.execute.mockResolvedValueOnce([{ affectedRows: 1 } as unknown as ResultSetHeader, []]);

      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const tx = await client.startTransaction();
      await expect(
        tx.execute('UPDATE users SET avatar = ? WHERE id = 1', [Buffer.from('x')] as unknown as any)
      ).resolves.toMatchObject({ affectedRows: 1 });
      expect(transactionConnection.execute).toHaveBeenCalledWith('UPDATE users SET avatar = ? WHERE id = 1', [
        Buffer.from('x')
      ]);
      await tx.rollback();
    });
  });

  describe('Resilience and Observability', () => {
    it('middleware wraps query execution and receives result context', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1 }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const log: string[] = [];

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      client.use(async (ctx, next) => {
        log.push(`before:${ctx.kind}`);
        await next();
        log.push(`after:${ctx.kind}:${JSON.stringify(ctx.result)}`);
      });

      await client.query('SELECT 1');

      expect(log[0]).toBe('before:query');
      expect(log[1]).toContain('after:query');
    });

    it('multiple middleware run in registration order', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[{ id: 1 }] as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const order: string[] = [];

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      client.use(async (_ctx, next) => {
        order.push('A:before');
        await next();
        order.push('A:after');
      });
      client.use(async (_ctx, next) => {
        order.push('B:before');
        await next();
        order.push('B:after');
      });

      await client.query('SELECT 1');

      expect(order).toEqual(['A:before', 'B:before', 'B:after', 'A:after']);
    });

    it('middleware receives error context when query fails', async () => {
      const primaryConnection = createMockConnection();
      const failure = new Error('db down');
      primaryConnection.query.mockRejectedValue(failure);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      let capturedError: unknown;

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      // error:query event carries the error context
      client.on('error:query', (e: { error: unknown }) => {
        capturedError = e.error;
      });

      await expect(client.query('SELECT 1')).rejects.toThrow('db down');
      expect(capturedError).toBe(failure);
    });

    it('use() is chainable', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const returned = client.use(async (_ctx, next) => next());
      expect(returned).toBe(client);
    });

    it('throws when middleware calls next() multiple times', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[{ id: 1 }] as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      client.use(async (_ctx, next) => {
        await next();
        await next();
      });

      await expect(client.query('SELECT 1')).rejects.toThrow('next() called multiple times');
      expect(primaryConnection.query).toHaveBeenCalledTimes(1);
    });

    it('covers internal cancellation wrapper branch with timeout cleanup', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const controller = new AbortController();
      const promise = (
        client as unknown as {
          withTimeoutAndCancellation: <T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal) => Promise<T>;
        }
      ).withTimeoutAndCancellation(
        new Promise<string>(() => {
          setTimeout(() => controller.abort(), 0);
        }),
        1000,
        controller.signal
      );

      await expect(promise).rejects.toThrow('aborted');
    });

    it('covers cancellation wrapper rejection cleanup when timeout and signal are both present', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const controller = new AbortController();
      const failure = new Error('failed inside promise');
      const promise = (
        client as unknown as {
          withTimeoutAndCancellation: <T>(promise: Promise<T>, timeoutMs?: number, signal?: AbortSignal) => Promise<T>;
        }
      ).withTimeoutAndCancellation(Promise.reject(failure), 1000, controller.signal);

      await expect(promise).rejects.toThrow('failed inside promise');
    });

    it('covers internal retry helper branches for non-Error and jitter delay', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        retry: { baseDelayMs: 1, jitter: true, maxDelayMs: 16, maxRetries: 1 }
      });

      const internals = client as unknown as {
        isRetryableError: (error: unknown) => boolean;
        getRetryDelayMs: (attempt: number) => number;
        createAbortError: () => Error;
      };

      expect(internals.isRetryableError('not-an-error')).toBe(false);
      const jitterDelay = internals.getRetryDelayMs(3);
      expect(jitterDelay).toBeGreaterThanOrEqual(1);
      expect(jitterDelay).toBeLessThanOrEqual(4);

      const abortError = internals.createAbortError();
      expect(abortError.name).toBe('AbortError');
      expect(abortError.message).toBe('Query was aborted');
    });

    it('retries transient deadlock errors for idempotent execute calls', async () => {
      const primaryConnection = createMockConnection();
      const deadlockError = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });
      const successResult = { affectedRows: 1, insertId: 0 } as ResultSetHeader;

      primaryConnection.execute.mockRejectedValueOnce(deadlockError).mockResolvedValueOnce([successResult, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        retry: { baseDelayMs: 0, jitter: false, maxRetries: 2 }
      });

      await expect(
        client.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1], { idempotent: true })
      ).resolves.toMatchObject({ result: successResult });

      expect(primaryConnection.execute).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-idempotent execute calls by default', async () => {
      const primaryConnection = createMockConnection();
      const deadlockError = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

      primaryConnection.execute.mockRejectedValue(deadlockError);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        retry: { baseDelayMs: 0, jitter: false, maxRetries: 2 }
      });

      await expect(client.execute('INSERT INTO users(name) VALUES(?)', ['Alice'])).rejects.toThrow(deadlockError);
      expect(primaryConnection.execute).toHaveBeenCalledTimes(1);
    });

    it('supports query timeouts', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolved to trigger timeout path.
          })
      );
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.query('SELECT * FROM users', [], { timeoutMs: 5 })).rejects.toThrow('timed out');
      expect(primaryConnection.destroy).toHaveBeenCalledTimes(1);
    });

    it('supports abort signals for cancellation', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const controller = new AbortController();
      controller.abort();

      await expect(client.query('SELECT * FROM users', [], { signal: controller.signal })).rejects.toThrow('aborted');
      expect(primaryConnection.query).not.toHaveBeenCalled();
    });

    it('aborts in-flight query and clears timeout when both signal and timeout are provided', async () => {
      const primaryConnection = createMockConnection();
      const controller = new AbortController();
      primaryConnection.query.mockImplementation(
        () =>
          new Promise(() => {
            setTimeout(() => controller.abort(), 0);
          })
      );
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.query('SELECT * FROM users', [], { signal: controller.signal, timeoutMs: 1000 })
      ).rejects.toThrow('aborted');
      expect(primaryConnection.destroy).toHaveBeenCalledTimes(1);
    });

    it('handles abort while query is in-flight', async () => {
      const primaryConnection = createMockConnection();
      const controller = new AbortController();
      primaryConnection.query.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolved; controlled by AbortSignal.
            setTimeout(() => controller.abort(), 0);
          })
      );
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const queryPromise = client.query('SELECT * FROM users', [], { signal: controller.signal });

      await expect(queryPromise).rejects.toThrow('aborted');
    });

    it('does not retry when retry option is disabled per call', async () => {
      const primaryConnection = createMockConnection();
      const deadlockError = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

      primaryConnection.query.mockRejectedValue(deadlockError);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        retry: { baseDelayMs: 0, jitter: false, maxRetries: 2 }
      });

      await expect(client.query('SELECT * FROM users', [], { retry: false })).rejects.toThrow(deadlockError);
      expect(primaryConnection.query).toHaveBeenCalledTimes(1);
    });

    it('emits query event after successful query', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1 }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const events: unknown[] = [];
      client.on('query', e => events.push(e));

      await client.query('SELECT * FROM users');
      expect(events).toHaveLength(1);
      expect((events[0] as { rows: unknown }).rows).toEqual(rows);
    });

    it('emits execute event after successful execute', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 1, insertId: 0 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const events: unknown[] = [];
      client.on('execute', e => events.push(e));

      await client.execute('UPDATE users SET active = 1');
      expect(events).toHaveLength(1);
      expect((events[0] as { result: unknown }).result).toEqual(result);
    });

    it('emits error:query event on failure', async () => {
      const primaryConnection = createMockConnection();
      const failure = new Error('db down');
      primaryConnection.query.mockRejectedValue(failure);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const errors: unknown[] = [];
      client.on('error:query', e => errors.push(e));

      await expect(client.query('SELECT * FROM users')).rejects.toThrow('db down');
      expect(errors).toHaveLength(1);
      expect((errors[0] as { error: unknown }).error).toBe(failure);
    });

    it('retries query once and receives result on success', async () => {
      const primaryConnection = createMockConnection();
      const transient = Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
      const rows = [{ id: 99 }] as RowDataPacket[];

      primaryConnection.query.mockRejectedValueOnce(transient).mockResolvedValueOnce([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        retry: { baseDelayMs: 0, jitter: false, maxRetries: 1 }
      });

      const result = await client.query('SELECT * FROM users');
      expect(result.rows).toEqual(rows);
      expect(result.attempt).toBe(1);
      expect(primaryConnection.query).toHaveBeenCalledTimes(2);
    });

    it('compiles named params and executes queryNamed', async () => {
      const primaryConnection = createMockConnection();
      const rows = [{ id: 1, name: 'Alice' }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.queryNamed('SELECT * FROM users WHERE id = :id AND status = :status', { id: 1, status: 'active' })
      ).resolves.toMatchObject({ rows });

      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ? AND status = ?', [
        1,
        'active'
      ]);
    });

    it('compiles named params and executes executeNamed', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 1, insertId: 0 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.executeNamed('UPDATE users SET status = :status WHERE id = :id', { id: 1, status: 'inactive' })
      ).resolves.toMatchObject({ result });

      expect(primaryConnection.execute).toHaveBeenCalledWith('UPDATE users SET status = ? WHERE id = ?', [
        'inactive',
        1
      ]);
    });

    it('throws for missing executeNamed parameter', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.executeNamed('UPDATE users SET status = :status WHERE id = :id', { id: 1 })).rejects.toThrow(
        'Missing named SQL parameter: :status'
      );
    });

    it('throws when named parameter is missing', () => {
      expect(() => compileNamedParameters('SELECT * FROM users WHERE id = :id', {})).toThrow(
        'Missing named SQL parameter: :id'
      );
    });

    it('does not replace placeholders inside quotes or comments', () => {
      const compiled = compileNamedParameters(
        "SELECT ':id' AS literal, name FROM users -- :ignored\nWHERE id = :id AND note = ':ok'",
        { id: 42 }
      );

      expect(compiled.sql).toContain("':id'");
      expect(compiled.sql).toContain('-- :ignored');
      expect(compiled.sql).toContain('WHERE id = ?');
      expect(compiled.parameters).toEqual([42]);
    });

    it('does not replace placeholders in backticks, # comments, or block comments', () => {
      const compiled = compileNamedParameters(
        'SELECT `:id` as c /* :skip */ FROM t # :skip\nWHERE id = :id AND code = ":literal"',
        { id: 9 }
      );

      expect(compiled.sql).toContain('`:id`');
      expect(compiled.sql).toContain('/* :skip */');
      expect(compiled.sql).toContain('# :skip');
      expect(compiled.sql).toContain('id = ?');
      expect(compiled.parameters).toEqual([9]);
    });

    it('supports escaped quote styles without replacing placeholders inside strings', () => {
      const compiled = compileNamedParameters(`SELECT ':keep''it', "x""y" FROM t WHERE id = :id`, { id: 11 });

      expect(compiled.sql).toContain("':keep''it'");
      expect(compiled.sql).toContain('"x""y"');
      expect(compiled.parameters).toEqual([11]);
    });

    it('does not treat a dash expression as line comment without whitespace', () => {
      const compiled = compileNamedParameters('SELECT 1- -1 AS diff, :id AS id', { id: 5 });
      expect(compiled.sql).toContain('1- -1');
      expect(compiled.parameters).toEqual([5]);
    });

    it('does not treat double dash without trailing whitespace as line comment', () => {
      const compiled = compileNamedParameters('SELECT --foo, :id AS id', { id: 5 });
      expect(compiled.sql).toBe('SELECT --foo, ? AS id');
      expect(compiled.parameters).toEqual([5]);
    });

    it('correctly handles strings ending with escaped backslashes', () => {
      const compiled = compileNamedParameters(
        'SELECT * FROM files WHERE dir = \'C:\\\\\' AND user_id = :id AND ext = "foo\\\\" AND active = :active',
        { id: 10, active: true }
      );

      expect(compiled.sql).toBe(
        'SELECT * FROM files WHERE dir = \'C:\\\\\' AND user_id = ? AND ext = "foo\\\\" AND active = ?'
      );
      expect(compiled.parameters).toEqual([10, true]);
    });
  });

  describe('Connection Pooling', () => {
    it('terminates pooled in-flight query connection on timeout', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();
      pooledConnection.release = jest.fn();
      pooledConnection.query.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolved to trigger timeout path.
          })
      );

      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      await expect(client.query('SELECT * FROM users', [], { timeoutMs: 5 })).rejects.toThrow('timed out');

      expect(pool.getConnection).toHaveBeenCalledTimes(1);
      expect(pooledConnection.destroy).toHaveBeenCalledTimes(1);
      expect(pooledConnection.release).not.toHaveBeenCalled();

      await client.close();
    });

    it('terminates pooled in-flight execute connection on timeout', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();
      pooledConnection.release = jest.fn();
      pooledConnection.execute.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolved to trigger timeout path.
          })
      );

      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      await expect(
        client.execute('UPDATE users SET active = 1', [], { idempotent: true, timeoutMs: 5 })
      ).rejects.toThrow('timed out');

      expect(pool.getConnection).toHaveBeenCalledTimes(1);
      expect(pooledConnection.destroy).toHaveBeenCalledTimes(1);
      expect(pooledConnection.release).not.toHaveBeenCalled();

      await client.close();
    });

    it('clears single primary connection after execute cancellation and reconnects on next call', async () => {
      const firstConnection = createMockConnection();
      const secondConnection = createMockConnection();
      secondConnection.query.mockResolvedValue([[{ id: 1 }] as RowDataPacket[], []]);

      firstConnection.execute.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolved to trigger timeout path.
          })
      );

      mockedCreateConnection
        .mockResolvedValueOnce(firstConnection as unknown as Connection)
        .mockResolvedValueOnce(secondConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.execute('UPDATE users SET active = 1', [], { idempotent: true, timeoutMs: 5 })
      ).rejects.toThrow('timed out');
      await expect(client.query('SELECT * FROM users')).resolves.toMatchObject({ rows: [{ id: 1 }] });

      expect(firstConnection.destroy).toHaveBeenCalledTimes(1);
      expect(mockedCreateConnection).toHaveBeenCalledTimes(2);
      expect(secondConnection.query).toHaveBeenCalledTimes(1);
    });

    it('covers pooled getPrimaryConnection compatibility path', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();
      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const manager = new ConnectionManager(
        {
          database: 'test',
          host: 'localhost',
          password: 'password',
          user: 'root'
        },
        true
      );

      const connection = await manager.getPrimaryConnection();
      expect(connection).toBe(pooledConnection);
      expect(pool.getConnection).toHaveBeenCalledTimes(1);

      const secondCall = await manager.getPrimaryConnection();
      expect(secondCall).toBe(pooledConnection);
      expect(pool.getConnection).toHaveBeenCalledTimes(1);

      manager.invalidatePrimaryConnection();
      await manager.getPrimaryConnection();
      expect(pool.getConnection).toHaveBeenCalledTimes(2);

      await manager.close();
    });

    it('covers TransactionClient releaseSavepoint query branch directly', async () => {
      const connection = createMockConnection();
      connection.query.mockResolvedValue([[], []]);

      const tx = new TransactionClient(connection as unknown as Connection);
      await tx.releaseSavepoint('direct_sp');

      expect(connection.query).toHaveBeenCalledWith('RELEASE SAVEPOINT `direct_sp`');
    });

    it('covers TransactionClient result-shape fallback branches', async () => {
      const connection = createMockConnection();
      connection.query.mockResolvedValueOnce([[{ id: 1 }] as unknown as RowDataPacket[], []]);
      connection.execute
        .mockResolvedValueOnce([{ affectedRows: 0, insertId: 0 } as unknown as ResultSetHeader, []])
        .mockResolvedValueOnce([{ affectedRows: 3 } as unknown as ResultSetHeader, []])
        .mockResolvedValueOnce([{ affectedRows: 4 } as unknown as ResultSetHeader, []]);

      const tx = new TransactionClient(connection as unknown as Connection);
      await expect(tx.all('SELECT * FROM users')).resolves.toEqual([{ id: 1 }]);
      await expect(tx.insert('INSERT INTO users(name) VALUES(?)', ['A'])).resolves.toBe(0);
      await expect(tx.update('UPDATE users SET active = 1')).resolves.toBe(3);
      await expect(tx.delete('DELETE FROM users WHERE id > 0')).resolves.toBe(4);
    });

    it('exposes pool mode flag as true for pooled clients', async () => {
      const pool = createMockPool();
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      const manager = (client as unknown as { connectionManager: { isPoolMode: () => boolean } }).connectionManager;
      expect(manager.isPoolMode()).toBe(true);
    });

    it('uses pool.query for non-transactional read operations', async () => {
      const pool = createMockPool();
      const rows = [{ id: 1 }] as RowDataPacket[];

      pool.query.mockResolvedValue([rows, []]);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      await expect(client.query('SELECT * FROM users')).resolves.toMatchObject({ rows });

      expect(mockedCreatePool).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledWith('SELECT * FROM users', []);
      expect(pool.getConnection).not.toHaveBeenCalled();

      await client.close();
      expect(pool.end).toHaveBeenCalledTimes(1);
    });

    it('uses pool.execute for non-transactional write operations', async () => {
      const pool = createMockPool();
      const result = { affectedRows: 1, insertId: 0 } as ResultSetHeader;

      pool.execute.mockResolvedValue([result, []]);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      await expect(client.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1])).resolves.toMatchObject({
        result
      });

      expect(pool.execute).toHaveBeenCalledWith('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
      expect(pool.getConnection).not.toHaveBeenCalled();

      await client.close();
      expect(pool.end).toHaveBeenCalledTimes(1);
    });

    it('uses pooled connections for transactions and releases them', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();
      pooledConnection.release = jest.fn();

      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      const tx = await client.startTransaction();
      await tx.commit();

      expect(pool.getConnection).toHaveBeenCalledTimes(1);
      expect(pooledConnection.beginTransaction).toHaveBeenCalledTimes(1);
      expect(pooledConnection.commit).toHaveBeenCalledTimes(1);
      expect(pooledConnection.release).toHaveBeenCalledTimes(1);
      expect(pooledConnection.end).not.toHaveBeenCalled();

      await client.close();
      expect(pool.end).toHaveBeenCalledTimes(1);
    });

    it('releases pooled connection when beginTransaction fails', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();
      const failure = new Error('begin failed');
      pooledConnection.release = jest.fn();
      pooledConnection.beginTransaction.mockRejectedValue(failure);

      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      await expect(client.startTransaction()).rejects.toThrow(failure);
      expect(pooledConnection.release).toHaveBeenCalledTimes(1);
      expect(pooledConnection.end).not.toHaveBeenCalled();
    });

    it('creates pooled transactional connections directly from manager', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();

      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        connectionLimit: 10
      });

      const manager = (
        client as unknown as { connectionManager: { createTransactionalConnection: () => Promise<Connection> } }
      ).connectionManager;
      const txConn = await manager.createTransactionalConnection();

      expect(txConn).toBe(pooledConnection);
      expect(pool.getConnection).toHaveBeenCalledTimes(1);
    });

    it('close is a no-op for single mode when primary connection was never created', async () => {
      const managerModule = await import('../src/ConnectionManager');
      const manager = new managerModule.ConnectionManager({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(manager.close()).resolves.toBeUndefined();
    });

    it('covers terminateConnection fallback branch for nested driver connection objects', async () => {
      const manager = new ConnectionManager(
        {
          database: 'test',
          host: 'localhost',
          password: 'password',
          user: 'root'
        },
        false
      );

      const nestedDestroy = jest.fn();
      (
        manager as unknown as {
          terminateConnection: (connection: Connection) => void;
        }
      ).terminateConnection({ connection: { destroy: nestedDestroy } } as unknown as Connection);

      expect(nestedDestroy).toHaveBeenCalledTimes(1);
    });

    it('covers pooled executeCancelable cancel branch directly on manager', async () => {
      const pool = createMockPool();
      const pooledConnection = createMockConnection();
      pooledConnection.release = jest.fn();
      pooledConnection.execute.mockResolvedValue([{ affectedRows: 1 } as unknown as ResultSetHeader, []]);

      pool.getConnection.mockResolvedValue(pooledConnection as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const manager = new ConnectionManager(
        {
          database: 'test',
          host: 'localhost',
          password: 'password',
          user: 'root'
        },
        true
      );

      await expect(
        manager.executeCancelable('UPDATE users SET active = 1', [], cancel => {
          cancel();
        })
      ).resolves.toEqual({ affectedRows: 1 });

      expect(pooledConnection.execute).toHaveBeenCalledTimes(1);
      expect(pooledConnection.destroy).toHaveBeenCalledTimes(1);
      expect(pooledConnection.release).not.toHaveBeenCalled();
    });

    it('covers single executeCancelable cancel branch directly on manager', async () => {
      const firstConnection = createMockConnection();
      const secondConnection = createMockConnection();
      firstConnection.execute.mockResolvedValue([{ affectedRows: 1 } as unknown as ResultSetHeader, []]);

      mockedCreateConnection
        .mockResolvedValueOnce(firstConnection as unknown as Connection)
        .mockResolvedValueOnce(secondConnection as unknown as Connection);

      const manager = new ConnectionManager({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await manager.getPrimaryConnection();

      await expect(
        manager.executeCancelable('UPDATE users SET active = 1', [], cancel => {
          cancel();
        })
      ).resolves.toEqual({ affectedRows: 1 });

      const refreshed = await manager.getPrimaryConnection();
      expect(refreshed).toBe(secondConnection);
      expect(firstConnection.destroy).toHaveBeenCalledTimes(1);
      expect(firstConnection.execute).toHaveBeenCalledTimes(1);
      expect(mockedCreateConnection).toHaveBeenCalledTimes(2);
    });
  });

  describe('withAdvisoryLock', () => {
    it('validates lock name parameter', async () => {
      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.withAdvisoryLock('', 10, async () => {})).rejects.toThrow(
        /Lock name must be a non-empty string of at most 64 characters/
      );

      await expect(client.withAdvisoryLock('a'.repeat(65), 10, async () => {})).rejects.toThrow(
        /Lock name must be a non-empty string of at most 64 characters/
      );

      await expect(client.withAdvisoryLock(123 as unknown as string, 10, async () => {})).rejects.toThrow(
        /Lock name must be a non-empty string of at most 64 characters/
      );
    });

    it('validates timeoutSeconds parameter', async () => {
      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.withAdvisoryLock('test_lock', -1, async () => {})).rejects.toThrow(
        /Lock timeout must be a non-negative integer/
      );

      await expect(client.withAdvisoryLock('test_lock', 1.5, async () => {})).rejects.toThrow(
        /Lock timeout must be a non-negative integer/
      );

      await expect(client.withAdvisoryLock('test_lock', '10' as unknown as number, async () => {})).rejects.toThrow(
        /Lock timeout must be a non-negative integer/
      );
    });

    it('fails when GET_LOCK returns 0 (timeout)', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query.mockResolvedValueOnce([[{ lockAcquired: 0 }] as RowDataPacket[], []]);

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.withAdvisoryLock('test_lock', 5, async () => 'ok')).rejects.toThrow(
        'Failed to acquire advisory lock "test_lock" within 5s'
      );

      expect(mockConn.release).toHaveBeenCalledTimes(1);
    });

    it('fails when GET_LOCK returns null or empty', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.withAdvisoryLock('test_lock', 5, async () => 'ok')).rejects.toThrow(
        'Failed to acquire advisory lock "test_lock" within 5s'
      );

      expect(mockConn.release).toHaveBeenCalledTimes(1);
    });

    it('successfully acquires lock, runs callback with pinned lockedClient, and releases lock', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query
        .mockResolvedValueOnce([[{ lockAcquired: 1 }] as RowDataPacket[], []])
        .mockResolvedValueOnce([[{ released: 1 }] as RowDataPacket[], []]);

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root',
        retry: { maxRetries: 3 }
      });

      let capturedClient: SqlClient | undefined;
      const result = await client.withAdvisoryLock('migration_lock', 30, async locked => {
        capturedClient = locked;
        await locked.close(); // No-op, should not close or release
        return 'executed';
      });

      expect(result).toBe('executed');
      expect(mockConn.query).toHaveBeenNthCalledWith(1, 'SELECT GET_LOCK(?, ?) AS lockAcquired', [
        'migration_lock',
        30
      ]);
      expect(mockConn.query).toHaveBeenNthCalledWith(2, 'SELECT RELEASE_LOCK(?) AS released', ['migration_lock']);
      expect(mockConn.release).toHaveBeenCalledTimes(1);

      // Verify locked client restrictions
      expect(capturedClient).toBeDefined();
      if (capturedClient) {
        await expect(capturedClient.startTransaction()).rejects.toThrow(
          'startTransaction() is not permitted inside an advisory lock callback'
        );
        await expect(capturedClient.transaction(async () => {})).rejects.toThrow(
          'transaction() is not permitted inside an advisory lock callback'
        );
        await expect(capturedClient.withAdvisoryLock('inner', 10, async () => {})).rejects.toThrow(
          'withAdvisoryLock() is not permitted inside an advisory lock callback'
        );
      }
    });

    it('terminates connection when RELEASE_LOCK returns 0 (not released)', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query
        .mockResolvedValueOnce([[{ lockAcquired: 1 }] as RowDataPacket[], []])
        .mockResolvedValueOnce([[{ released: 0 }] as RowDataPacket[], []]);

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.withAdvisoryLock('migration_lock', 30, async () => 'data')).rejects.toThrow(
        'Failed to release advisory lock "migration_lock" (RELEASE_LOCK returned 0)'
      );

      // Must be destroyed, not released to pool
      expect(mockConn.destroy).toHaveBeenCalledTimes(1);
      expect(mockConn.release).not.toHaveBeenCalled();
    });

    it('attaches releaseError to callback error when callback fails and lock release fails', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query
        .mockResolvedValueOnce([[{ lockAcquired: 1 }] as RowDataPacket[], []])
        .mockRejectedValueOnce(new Error('Network failure on release'));

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const callbackErr = new Error('Callback failed');
      await expect(
        client.withAdvisoryLock('migration_lock', 30, async () => {
          throw callbackErr;
        })
      ).rejects.toThrow('Callback failed');

      expect((callbackErr as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect(((callbackErr as Error & { cause?: Error }).cause as Error).message).toBe('Network failure on release');
      expect((callbackErr as Error & { releaseError?: unknown }).releaseError).toBeInstanceOf(Error);
      expect(mockConn.destroy).toHaveBeenCalledTimes(1);
      expect(mockConn.release).not.toHaveBeenCalled();
    });

    it('wraps non-Error callback rejection when release fails', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query
        .mockResolvedValueOnce([[{ lockAcquired: 1 }] as RowDataPacket[], []])
        .mockRejectedValueOnce(new Error('Network failure on release'));

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.withAdvisoryLock('migration_lock', 30, async () => {
          return Promise.reject('non-error string failure');
        })
      ).rejects.toThrow(/Advisory lock callback failed with non-Error: non-error string failure/);

      expect(mockConn.destroy).toHaveBeenCalledTimes(1);
    });

    it('preserves cleanup failure when connection release throws', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn().mockImplementation(() => {
        throw new Error('Connection release threw');
      });
      mockConn.query
        .mockResolvedValueOnce([[{ lockAcquired: 1 }] as RowDataPacket[], []])
        .mockResolvedValueOnce([[{ released: 1 }] as RowDataPacket[], []]);

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.withAdvisoryLock('migration_lock', 30, async () => 'data')).rejects.toThrow(
        'Connection release threw'
      );
      expect(mockConn.destroy).toHaveBeenCalledTimes(1);
    });

    it('prevents silent reconnection or session switching when pinned connection fails', async () => {
      const pool = createMockPool();
      const mockConn = createMockConnection();
      mockConn.release = jest.fn();
      mockConn.query
        .mockResolvedValueOnce([[{ lockAcquired: 1 }] as RowDataPacket[], []])
        .mockRejectedValueOnce(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET', fatal: true }))
        .mockResolvedValueOnce([[{ released: 1 }] as RowDataPacket[], []]);

      pool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(pool as unknown as Pool);

      const client = SqlClient.createPool({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        client.withAdvisoryLock('migration_lock', 30, async locked => {
          // First query triggers fatal connection reset
          await expect(locked.query('SELECT 1')).rejects.toThrow('Connection reset');
          // Subsequent query must fail and NOT reconnect
          await expect(locked.query('SELECT 2')).rejects.toThrow('Pinned connection has been closed or terminated.');
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('Helpers, Configuration, and Driver Escape Hatches', () => {
    it('safely escapes values and identifiers using instance and static helpers', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      // Escape values
      expect(client.escape("O'Reilly")).toBe("'O\\'Reilly'");
      expect(SqlClient.escape("O'Reilly")).toBe("'O\\'Reilly'");
      expect(client.escape(123)).toBe('123');

      // Escape identifiers
      expect(client.escapeId('user_table')).toBe('`user_table`');
      expect(SqlClient.escapeId('user_table')).toBe('`user_table`');
      expect(client.escapeId(['col_a', 'col_b'])).toBe('`col_a`, `col_b`');
      expect(SqlClient.escapeId(['col_a', 'col_b'])).toBe('`col_a`, `col_b`');

      // Format SQL
      expect(client.format('SELECT * FROM ?? WHERE id = ?', ['users', 42])).toBe('SELECT * FROM `users` WHERE id = 42');
      expect(SqlClient.format('SELECT * FROM ?? WHERE id = ?', ['users', 42])).toBe(
        'SELECT * FROM `users` WHERE id = 42'
      );
    });

    it('throws error when getPool() is called in single connection mode', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const singleClient = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      expect(() => singleClient.getPool()).toThrow(
        'getPool() is only available when SqlClient is configured in pool mode (e.g. via SqlClient.createPool()).'
      );
    });

    it('formats unquoted SQL expressions using raw and rawSql helpers', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      expect(client.format('UPDATE users SET updated_at = ? WHERE id = ?', [client.rawSql('NOW()'), 1])).toBe(
        'UPDATE users SET updated_at = NOW() WHERE id = 1'
      );

      expect(SqlClient.format('SELECT ? AS today', [SqlClient.raw('CURRENT_DATE()')])).toBe(
        'SELECT CURRENT_DATE() AS today'
      );
    });

    it('immediately destroys connection and pool via destroy()', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      client.destroy();
      expect(primaryConnection.destroy).toHaveBeenCalledTimes(1);

      const mockPool = createMockPool();
      mockedCreatePool.mockReturnValue(mockPool as unknown as Pool);

      const poolClient = SqlClient.createPool({
        database: 'test',
        host: 'localhost'
      });
      poolClient.getPool();

      poolClient.destroy();
      expect(mockPool.destroy).toHaveBeenCalledTimes(1);
    });

    it('unprepares cached statements on primary connection', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      client.unprepare('SELECT 1');
      expect(primaryConnection.unprepare).toHaveBeenCalledWith('SELECT 1');
    });

    it('supports changeUser and reset on single connection mode and rejects in pool mode', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const singleClient = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      await singleClient.changeUser({ user: 'admin', database: 'other_db' });
      expect(primaryConnection.changeUser).toHaveBeenCalledWith({ user: 'admin', database: 'other_db' });

      await singleClient.reset();
      expect(primaryConnection.reset).toHaveBeenCalledTimes(1);

      const mockPool = createMockPool();
      mockedCreatePool.mockReturnValue(mockPool as unknown as Pool);

      const poolClient = SqlClient.createPool({
        database: 'test',
        host: 'localhost'
      });

      await expect(poolClient.changeUser({ user: 'admin' })).rejects.toThrow(
        /changeUser\(\) cannot be invoked directly on a pooled SqlClient/
      );
      await expect(poolClient.reset()).rejects.toThrow(/reset\(\) cannot be invoked directly on a pooled SqlClient/);
    });

    it('forwards pool lifecycle events from underlying pool to SqlClient', () => {
      const mockPool = createMockPool();
      let connectionHandler: ((...args: unknown[]) => void) | undefined;
      let acquireHandler: ((...args: unknown[]) => void) | undefined;
      let releaseHandler: ((...args: unknown[]) => void) | undefined;
      let enqueueHandler: ((...args: unknown[]) => void) | undefined;

      mockPool.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'connection') connectionHandler = handler;
        if (event === 'acquire') acquireHandler = handler;
        if (event === 'release') releaseHandler = handler;
        if (event === 'enqueue') enqueueHandler = handler;
        return mockPool as unknown as Pool;
      });

      mockedCreatePool.mockReturnValue(mockPool as unknown as Pool);

      const poolClient = SqlClient.createPool({
        database: 'test',
        host: 'localhost'
      });
      poolClient.getPool();

      const onConnection = jest.fn();
      const onAcquire = jest.fn();
      const onRelease = jest.fn();
      const onEnqueue = jest.fn();

      poolClient.on('connection', onConnection);
      poolClient.on('acquire', onAcquire);
      poolClient.on('release', onRelease);
      poolClient.on('enqueue', onEnqueue);

      const dummyConn = {} as PoolConnection;
      connectionHandler?.(dummyConn);
      acquireHandler?.(dummyConn);
      releaseHandler?.(dummyConn);
      enqueueHandler?.();

      expect(onConnection).toHaveBeenCalledWith(dummyConn);
      expect(onAcquire).toHaveBeenCalledWith(dummyConn);
      expect(onRelease).toHaveBeenCalledWith(dummyConn);
      expect(onEnqueue).toHaveBeenCalledTimes(1);
    });

    it('acquires and releases connection on pool and single connection clients', async () => {
      const mockConn = createMockConnection();
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const singleClient = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      const singleConn = await singleClient.getConnection();
      expect(singleConn).toBeDefined();
      singleClient.releaseConnection(singleConn);

      const mockPool = createMockPool();
      mockPool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(mockPool as unknown as Pool);

      const poolClient = SqlClient.createPool({
        database: 'test',
        host: 'localhost'
      });

      const poolConn = await poolClient.getConnection();
      expect(poolConn).toBeDefined();
      mockConn.release = jest.fn();
      poolClient.releaseConnection(poolConn);
      expect(mockConn.release).toHaveBeenCalled();
    });

    it('calls reset on single connection client', async () => {
      const mockConn = createMockConnection();
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const singleClient = await SqlClient.create({
        database: 'test',
        host: 'localhost'
      });

      await singleClient.reset();
      expect(mockConn.reset).toHaveBeenCalledTimes(1);
    });
  });

  describe('TransactionClient Savepoints & Lifecycle', () => {
    it('creates savepoints with generated and custom names, rolls back, and releases them', async () => {
      const mockConn = createMockConnection();
      const tx = new TransactionClient(mockConn as unknown as Connection);

      const generatedName = await tx.savepoint();
      expect(generatedName).toBe('sp_1');
      expect(mockConn.query).toHaveBeenCalledWith('SAVEPOINT `sp_1`');

      const customName = await tx.savepoint('step_alpha');
      expect(customName).toBe('step_alpha');
      expect(mockConn.query).toHaveBeenCalledWith('SAVEPOINT `step_alpha`');

      await tx.rollbackTo('step_alpha');
      expect(mockConn.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT `step_alpha`');

      await tx.releaseSavepoint('step_alpha');
      expect(mockConn.query).toHaveBeenCalledWith('RELEASE SAVEPOINT `step_alpha`');

      await tx.rollback();
      expect(mockConn.rollback).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid savepoint names', async () => {
      const mockConn = createMockConnection();
      const tx = new TransactionClient(mockConn as unknown as Connection);

      await expect(tx.savepoint('123_invalid')).rejects.toThrow('Invalid savepoint name: "123_invalid"');
      await expect(tx.rollbackTo('invalid-dash')).rejects.toThrow('Invalid savepoint name: "invalid-dash"');
      await expect(tx.releaseSavepoint('invalid space')).rejects.toThrow('Invalid savepoint name: "invalid space"');
    });
  });

  describe('Advisory Locks & Timeout/Cancellation Edge Cases', () => {
    it('executes callback inside advisory lock and pins connection client', async () => {
      const mockConn = createMockConnection();
      mockConn.query.mockImplementation(async (sql: string | { sql: string }) => {
        const queryStr = typeof sql === 'string' ? sql : sql.sql;
        if (queryStr.includes('GET_LOCK')) {
          return [[{ lockAcquired: 1 }] as RowDataPacket[], []];
        }
        if (queryStr.includes('RELEASE_LOCK')) {
          return [[{ released: 1 }] as RowDataPacket[], []];
        }
        return [[{ val: 1 }] as RowDataPacket[], []];
      });

      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);
      const client = await SqlClient.create({ database: 'test', host: 'localhost' });

      const result = await client.withAdvisoryLock('test_lock', 10, async lockedClient => {
        // Locked connection client operations
        await lockedClient.close(); // No-op
        lockedClient.destroy(); // No-op
        await expect(lockedClient.reset()).rejects.toThrow(/advisory lock/i);
        await expect(lockedClient.changeUser({})).rejects.toThrow(/advisory lock/i);

        return 'success';
      });

      expect(result).toBe('success');
    });

    it('validates advisory lock arguments and throws if lock acquisition fails', async () => {
      const mockConn = createMockConnection();
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);
      const client = await SqlClient.create({ database: 'test', host: 'localhost' });

      await expect(client.withAdvisoryLock('', 10, async () => {})).rejects.toThrow(
        /Lock name must be a non-empty string/
      );
      await expect(client.withAdvisoryLock('a'.repeat(65), 10, async () => {})).rejects.toThrow(
        /Lock name must be a non-empty string/
      );
      await expect(client.withAdvisoryLock('valid', -1, async () => {})).rejects.toThrow(
        /Lock timeout must be a non-negative integer/
      );

      mockConn.query.mockResolvedValueOnce([[{ lockAcquired: 0 }] as RowDataPacket[], []]);
      await expect(client.withAdvisoryLock('failed_lock', 5, async () => {})).rejects.toThrow(
        'Failed to acquire advisory lock "failed_lock" within 5s'
      );
    });

    it('terminates connection when advisory lock release fails', async () => {
      const mockConn = createMockConnection();
      mockConn.query.mockImplementation(async (sql: string | { sql: string }) => {
        const queryStr = typeof sql === 'string' ? sql : sql.sql;
        if (queryStr.includes('GET_LOCK')) {
          return [[{ lockAcquired: 1 }] as RowDataPacket[], []];
        }
        if (queryStr.includes('RELEASE_LOCK')) {
          return [[{ released: 0 }] as RowDataPacket[], []];
        }
        return [[{ val: 1 }] as RowDataPacket[], []];
      });

      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);
      const client = await SqlClient.create({ database: 'test', host: 'localhost' });

      await expect(client.withAdvisoryLock('failing_release', 5, async () => 'done')).rejects.toThrow(
        /Failed to release advisory lock/
      );
      expect(mockConn.destroy).toHaveBeenCalled();
    });

    it('cleans up connection when startTransaction fails', async () => {
      const mockConn = createMockConnection();
      mockConn.beginTransaction.mockRejectedValue(new Error('Tx start failed'));
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });
      await expect(client.startTransaction()).rejects.toThrow('Tx start failed');
      expect(mockConn.end).toHaveBeenCalled();
    });

    it('throws AbortError when signal is already aborted', async () => {
      const mockConn = createMockConnection();
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });
      const controller = new AbortController();
      controller.abort();

      await expect(client.query('SELECT 1', [], { signal: controller.signal })).rejects.toThrow('Query was aborted');
    });

    it('times out and invokes cancellation when query exceeds timeoutMs', async () => {
      const mockConn = createMockConnection();
      mockConn.query.mockImplementation(() => new Promise(() => {})); // Hangs
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });
      await expect(client.query('SELECT 1', [], { timeoutMs: 10 })).rejects.toThrow('Query timed out after 10ms');
    });

    it('covers execute, delete, executeNamed, destroy, and config on single connection client', async () => {
      const mockConn = createMockConnection();
      mockConn.execute.mockResolvedValue([{ affectedRows: 1, insertId: 0 } as ResultSetHeader, []]);
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test_db', host: 'localhost', user: 'root' });

      // config
      expect(client.config.database).toBe('test_db');

      // execute
      const res = await client.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
      expect(res.result.affectedRows).toBe(1);

      // delete
      const delCount = await client.delete('DELETE FROM users WHERE id = ?', [1]);
      expect(delCount).toBe(1);

      // executeNamed with options
      const namedRes = await client.executeNamed(
        'UPDATE users SET name = :name WHERE id = :id',
        { name: 'Alice', id: 1 },
        { idempotent: true }
      );
      expect(namedRes.result.affectedRows).toBe(1);

      // destroy
      client.destroy();
      expect(mockConn.destroy).toHaveBeenCalled();
    });

    it('throws when advisory lock returns empty rows array', async () => {
      const mockConn = createMockConnection();
      mockConn.query.mockResolvedValue([[] as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });
      await expect(client.withAdvisoryLock('empty_row_lock', 5, async () => {})).rejects.toThrow(
        'Failed to acquire advisory lock "empty_row_lock" within 5s'
      );
    });

    it('handles query resolution and rejection branches with timeoutMs and signal', async () => {
      const mockConn = createMockConnection();
      mockConn.query.mockResolvedValue([[{ num: 1 }] as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });

      // 1. Success with timeoutMs
      const r1 = await client.query('SELECT 1', [], { timeoutMs: 5000 });
      expect(r1.rows).toHaveLength(1);

      // 2. Success with signal
      const c1 = new AbortController();
      const r2 = await client.query('SELECT 1', [], { signal: c1.signal });
      expect(r2.rows).toHaveLength(1);

      // 3. Error with timeoutMs
      mockConn.query.mockRejectedValueOnce(new Error('Syntax error'));
      await expect(client.query('INVALID SQL', [], { timeoutMs: 5000 })).rejects.toThrow('Syntax error');

      // 4. Error with signal
      mockConn.query.mockRejectedValueOnce(new Error('Syntax error'));
      const c2 = new AbortController();
      await expect(client.query('INVALID SQL', [], { signal: c2.signal })).rejects.toThrow('Syntax error');
    });

    it('cancels queries and executions in pooled mode when aborted', async () => {
      const mockPool = createMockPool();
      const mockConn = createMockConnection();
      mockPool.getConnection.mockResolvedValue(mockConn as unknown as PoolConnection);
      mockedCreatePool.mockReturnValue(mockPool as unknown as Pool);

      const poolClient = SqlClient.createPool({ database: 'test', host: 'localhost' });

      // query cancellation in pooled mode: trigger abort while query is in-flight
      const queryController = new AbortController();
      mockConn.query.mockImplementationOnce(() => {
        queryController.abort();
        return new Promise(() => {});
      });
      const qPromise = poolClient.query('SELECT SLEEP(1)', [], { signal: queryController.signal });
      await expect(qPromise).rejects.toThrow('Query was aborted');
      expect(mockConn.destroy).toHaveBeenCalled();

      // execute cancellation in pooled mode: trigger abort while execute is in-flight
      const execController = new AbortController();
      mockConn.execute.mockImplementationOnce(() => {
        execController.abort();
        return new Promise(() => {});
      });
      const ePromise = poolClient.execute('UPDATE users SET name = ?', ['X'], { signal: execController.signal });
      await expect(ePromise).rejects.toThrow('Query was aborted');
    });

    it('handles convenience methods (insert, update, exists, count, ping, get, all)', async () => {
      const mockConn = createMockConnection();
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });

      // insert
      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 2, insertId: 10 } as ResultSetHeader, []]);
      expect(await client.insert('INSERT INTO users(name) VALUES(?)', ['Alice'])).toBe(2);

      // update affectedRows and changedRows
      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 3, changedRows: 1 } as unknown as ResultSetHeader, []]);
      expect(await client.update('UPDATE users SET name = ?', ['Bob'], false)).toBe(3);

      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 3, changedRows: 1 } as unknown as ResultSetHeader, []]);
      expect(await client.update('UPDATE users SET name = ?', ['Bob'], true)).toBe(1);

      // exists
      mockConn.query.mockResolvedValueOnce([[{ id: 1 }] as RowDataPacket[], []]);
      expect(await client.exists('SELECT 1 FROM users WHERE id = ?', [1])).toBe(true);

      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      expect(await client.exists('SELECT 1 FROM users WHERE id = ?', [999])).toBe(false);

      // count
      mockConn.query.mockResolvedValueOnce([[{ total: 42 }] as RowDataPacket[], []]);
      expect(await client.count('SELECT COUNT(*) AS total FROM users')).toBe(42);

      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      expect(await client.count('SELECT COUNT(*) AS total FROM users WHERE 1 = 0')).toBe(0);

      // ping
      mockConn.query.mockResolvedValueOnce([[{ '1': 1 }] as RowDataPacket[], []]);
      expect(await client.ping()).toBe(true);

      mockConn.query.mockRejectedValueOnce(new Error('Connection dead'));
      expect(await client.ping()).toBe(false);

      // get & all
      mockConn.query.mockResolvedValueOnce([[{ id: 1, name: 'Alice' }] as RowDataPacket[], []]);
      expect(await client.get('SELECT * FROM users WHERE id = ?', [1])).toEqual({ id: 1, name: 'Alice' });

      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      expect(await client.get('SELECT * FROM users WHERE id = ?', [999])).toBeNull();

      mockConn.query.mockResolvedValueOnce([[{ id: 1 }, { id: 2 }] as RowDataPacket[], []]);
      expect(await client.all('SELECT * FROM users')).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('covers all TransactionClient convenience and named query methods', async () => {
      const mockConn = createMockConnection();
      const tx = new TransactionClient(mockConn as unknown as Connection);

      // insert
      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 5 } as ResultSetHeader, []]);
      expect(await tx.insert('INSERT INTO users VALUES(?)', ['X'])).toBe(1);

      // update
      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 4, changedRows: 2 } as unknown as ResultSetHeader, []]);
      expect(await tx.update('UPDATE users SET x = 1', [], false)).toBe(4);

      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 4, changedRows: 2 } as unknown as ResultSetHeader, []]);
      expect(await tx.update('UPDATE users SET x = 1', [], true)).toBe(2);

      // delete
      mockConn.execute.mockResolvedValueOnce([{ affectedRows: 3 } as ResultSetHeader, []]);
      expect(await tx.delete('DELETE FROM users')).toBe(3);

      // exists
      mockConn.query.mockResolvedValueOnce([[{ id: 1 }] as RowDataPacket[], []]);
      expect(await tx.exists('SELECT 1')).toBe(true);

      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      expect(await tx.exists('SELECT 1')).toBe(false);

      // count
      mockConn.query.mockResolvedValueOnce([[{ count: '10' }] as RowDataPacket[], []]);
      expect(await tx.count('SELECT COUNT(*)')).toBe(10);

      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      expect(await tx.count('SELECT COUNT(*)')).toBe(0);

      // get & all
      mockConn.query.mockResolvedValueOnce([[{ id: 7 }] as RowDataPacket[], []]);
      expect(await tx.get('SELECT * FROM users WHERE id = 7')).toEqual({ id: 7 });

      mockConn.query.mockResolvedValueOnce([[] as RowDataPacket[], []]);
      expect(await tx.get('SELECT * FROM users WHERE id = 999')).toBeNull();

      mockConn.query.mockResolvedValueOnce([[{ id: 1 }] as RowDataPacket[], []]);
      expect(await tx.all('SELECT * FROM users')).toEqual([{ id: 1 }]);

      // commit
      await tx.commit();
      expect(mockConn.commit).toHaveBeenCalled();
    });

    it('automatically retries query on retryable protocol errors', async () => {
      const mockConn = createMockConnection();
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 }
      });

      const retryableError = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
      mockConn.query
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce([[{ success: 1 }] as RowDataPacket[], []]);

      const res = await client.query('SELECT 1');
      expect(res.rows[0].success).toBe(1);
      expect(res.attempt).toBe(1);
    });

    it('handles rollback failure when transaction callback throws', async () => {
      const mockConn = createMockConnection();
      mockConn.beginTransaction.mockResolvedValue(undefined);
      mockConn.rollback.mockRejectedValue(new Error('Rollback failed'));
      mockedCreateConnection.mockResolvedValue(mockConn as unknown as Connection);

      const client = await SqlClient.create({ database: 'test', host: 'localhost' });

      let caughtError: (Error & { rollbackError?: Error }) | undefined;
      try {
        await client.transaction(async () => {
          throw new Error('Callback business logic error');
        });
      } catch (err) {
        caughtError = err as Error & { rollbackError?: Error };
      }

      expect(caughtError?.message).toBe('Callback business logic error');
      expect(caughtError?.rollbackError?.message).toBe('Rollback failed');
    });
  });
});
