import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { createConnection, createPool, PoolConnection, type Connection, type Pool } from 'mysql2/promise';
import { SqlClient, buildQuery, compileNamedParameters } from '../src';
import { ConnectionManager } from '../src/ConnectionManager';
import { TransactionClient } from '../src/TransactionClient';

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
  createPool: jest.fn()
}));

type MockConnection = jest.Mocked<
  Pick<Connection, 'beginTransaction' | 'commit' | 'end' | 'execute' | 'query' | 'rollback'>
> & {
  destroy?: jest.Mock;
  release?: jest.Mock;
};

type MockPool = jest.Mocked<Pick<Pool, 'end' | 'execute' | 'getConnection' | 'query'>>;

const mockedCreateConnection = jest.mocked(createConnection);
const mockedCreatePool = jest.mocked(createPool);

const createMockConnection = (): MockConnection => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  execute: jest.fn(),
  query: jest.fn(),
  rollback: jest.fn().mockResolvedValue(undefined)
});

const createMockPool = (): MockPool => ({
  execute: jest.fn(),
  getConnection: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  query: jest.fn()
});

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

    it('gets a single row with convenience method', async () => {
      const primaryConnection = createMockConnection();
      const row = { id: 1, name: 'Alice' } as RowDataPacket;

      primaryConnection.query.mockResolvedValue([[row], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.get('SELECT * FROM users WHERE id = ?', [1])).resolves.toEqual(row);
    });

    it('gets all rows with convenience method', async () => {
      const primaryConnection = createMockConnection();
      const rows = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' }
      ] as RowDataPacket[];

      primaryConnection.query.mockResolvedValue([rows, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.all('SELECT * FROM users')).resolves.toEqual(rows);
    });

    it('inserts with convenience method returning affectedRows', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 1, insertId: 42 } as unknown as ResultSetHeader;

      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.insert('INSERT INTO users(name, age) VALUES(?, ?)', ['Alice', 25])).resolves.toBe(1);
    });

    it('updates with convenience method returning affectedRows', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 5, changedRows: 3 } as unknown as ResultSetHeader;

      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.update('UPDATE users SET active = ? WHERE age > ?', [true, 18])).resolves.toBe(5);

      // Test with returnChangedRows flag
      await expect(client.update('UPDATE users SET active = ? WHERE age > ?', [true, 18], true)).resolves.toBe(3);
    });

    it('deletes with convenience method returning affectedRows', async () => {
      const primaryConnection = createMockConnection();
      const result = { affectedRows: 2 } as unknown as ResultSetHeader;

      primaryConnection.execute.mockResolvedValue([result, []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.delete('DELETE FROM users WHERE id = ?', [1])).resolves.toBe(2);
    });

    it('exists() returns true when rows are found', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[{ 1: 1 }] as unknown as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.exists('SELECT 1 FROM users WHERE email = ?', ['alice@example.com'])).resolves.toBe(true);
    });

    it('exists() returns false when no rows are found', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[] as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.exists('SELECT 1 FROM users WHERE email = ?', ['nobody@example.com'])).resolves.toBe(false);
    });

    it('count() returns the numeric value of the first column', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[{ 'COUNT(*)': 42 }] as unknown as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.count('SELECT COUNT(*) FROM users WHERE active = ?', [true])).resolves.toBe(42);
    });

    it('count() returns 0 when no rows are returned', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[] as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.count('SELECT COUNT(*) FROM users WHERE 1 = 0')).resolves.toBe(0);
    });

    it('ping() returns true when connection is healthy', async () => {
      const primaryConnection = createMockConnection();
      primaryConnection.query.mockResolvedValue([[{ 1: 1 }] as unknown as RowDataPacket[], []]);
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(client.ping()).resolves.toBe(true);
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

    it('supports convenience methods in transactions', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();
      const rows = [{ id: 1, name: 'Alice' }] as RowDataPacket[];
      const insertResult = { affectedRows: 1, insertId: 1 } as unknown as ResultSetHeader;

      transactionConnection.query.mockResolvedValue([rows, []]);
      transactionConnection.execute.mockResolvedValue([insertResult, []]);
      mockedCreateConnection
        .mockResolvedValueOnce(primaryConnection as unknown as Connection)
        .mockResolvedValueOnce(transactionConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const affectedRows = await client.transaction(async tx => {
        const row = await tx.get('SELECT * FROM users WHERE id = ?', [1]);
        expect(row).toEqual(rows[0]);

        const count = await tx.insert('INSERT INTO users(name) VALUES(?)', ['Bob']);
        return count;
      });

      expect(affectedRows).toBe(1);
      expect(transactionConnection.commit).toHaveBeenCalledTimes(1);
    });

    it('supports savepoint lifecycle in transactions', async () => {
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
      const savepoint = await tx.savepoint();
      await tx.rollbackTo(savepoint);
      await tx.releaseSavepoint(savepoint);
      await tx.commit();

      expect(transactionConnection.query).toHaveBeenCalledWith('SAVEPOINT `sp_1`');
      expect(transactionConnection.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT `sp_1`');
      expect(transactionConnection.query).toHaveBeenCalledWith('RELEASE SAVEPOINT `sp_1`');
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

    it('supports update and delete helpers inside a transaction', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.execute
        .mockResolvedValueOnce([{ affectedRows: 3, changedRows: 2 } as unknown as ResultSetHeader, []])
        .mockResolvedValueOnce([{ affectedRows: 4, changedRows: 4 } as unknown as ResultSetHeader, []])
        .mockResolvedValueOnce([{ affectedRows: 5 } as unknown as ResultSetHeader, []]);

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
      await expect(tx.update('UPDATE users SET active = 1')).resolves.toBe(3);
      await expect(tx.update('UPDATE users SET active = 1', [], true)).resolves.toBe(4);
      await expect(tx.delete('DELETE FROM users WHERE id > 0')).resolves.toBe(5);
      await tx.rollback();
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

    it('supports exists() and count() helpers inside a transaction', async () => {
      const primaryConnection = createMockConnection();
      const transactionConnection = createMockConnection();

      transactionConnection.query
        .mockResolvedValueOnce([[{ 1: 1 }] as unknown as RowDataPacket[], []])
        .mockResolvedValueOnce([[] as RowDataPacket[], []])
        .mockResolvedValueOnce([[{ 'COUNT(*)': 7 }] as unknown as RowDataPacket[], []]);

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
      await expect(tx.exists('SELECT 1 FROM users WHERE id = ?', [1])).resolves.toBe(true);
      await expect(tx.exists('SELECT 1 FROM users WHERE id = ?', [999])).resolves.toBe(false);
      await expect(tx.count('SELECT COUNT(*) FROM users WHERE active = ?', [true])).resolves.toBe(7);
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

      client.use(async (ctx, next) => {
        order.push('A:before');
        await next();
        order.push('A:after');
      });
      client.use(async (ctx, next) => {
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

  describe('Query Builder', () => {
    it('builds SELECT queries', () => {
      const query = buildQuery()
        .select('id', 'name', 'email')
        .from('users')
        .where('age', '>', 18)
        .orderBy('name', 'ASC')
        .limit(10);

      const { sql, parameters } = query.build();
      expect(sql).toContain('SELECT id, name, email');
      expect(sql).toContain('FROM `users`');
      expect(sql).toContain('WHERE `age` > ?');
      expect(sql).toContain('ORDER BY `name` ASC');
      expect(sql).toContain('LIMIT 10');
      expect(parameters).toEqual([18]);
    });

    it('builds INSERT queries', () => {
      const query = buildQuery().insert('users', {
        name: 'Alice',
        email: 'alice@example.com',
        age: 25
      });

      const { sql, parameters } = query.build();
      expect(sql).toContain('INSERT INTO `users`');
      expect(sql).toContain('name');
      expect(sql).toContain('email');
      expect(sql).toContain('age');
      expect(parameters).toContain('Alice');
      expect(parameters).toContain('alice@example.com');
      expect(parameters).toContain(25);
    });

    it('builds UPDATE queries with WHERE clause', () => {
      const query = buildQuery().update('users', { active: true, age: 30 }).where('id', '=', 1);

      const { sql, parameters } = query.build();
      expect(sql).toContain('UPDATE `users` SET');
      expect(sql).toContain('WHERE `id` = ?');
      expect(parameters).toEqual([true, 30, 1]);
    });

    it('builds DELETE queries', () => {
      const query = buildQuery().delete('users').where('id', '>', 100);

      const { sql, parameters } = query.build();
      expect(sql).toContain('DELETE FROM `users`');
      expect(sql).toContain('WHERE `id` > ?');
      expect(parameters).toEqual([100]);
    });

    it('chains AND and OR conditions', () => {
      const query = buildQuery()
        .select('*')
        .from('users')
        .where('age', '>', 18)
        .and('active', '=', true)
        .or('role', '=', 'admin');

      const { sql, parameters } = query.build();
      expect(sql).toContain('WHERE `age` > ?');
      expect(sql).toContain('AND `active` = ?');
      expect(sql).toContain('OR `role` = ?');
      expect(parameters).toEqual([18, true, 'admin']);
    });

    it('supports GROUP BY and HAVING', () => {
      const query = buildQuery()
        .select('role', 'COUNT(*) as count')
        .from('users')
        .groupBy('role')
        .having('count', '>', 5);

      const { sql, parameters } = query.build();
      expect(sql).toContain('GROUP BY `role`');
      expect(sql).toContain('HAVING `count` > ?');
      expect(parameters).toEqual([5]);
    });

    it('supports JOINs', () => {
      const query = buildQuery()
        .select('u.id', 'u.name', 'p.title')
        .from('users u')
        .join('INNER', 'posts p', 'u.id = p.user_id');

      const { sql, parameters } = query.build();
      expect(sql).toContain('FROM `users` `u`');
      expect(sql).toContain('INNER JOIN `posts` `p` ON u.id = p.user_id');
      expect(parameters).toEqual([]);
    });

    it('escapes qualified identifiers for ORDER BY and GROUP BY', () => {
      const query = buildQuery().select('*').from('users u').orderBy('u.created_at', 'DESC').groupBy('u.role');

      const { sql } = query.build();
      expect(sql).toContain('ORDER BY `u`.`created_at` DESC');
      expect(sql).toContain('GROUP BY `u`.`role`');
    });

    it('can reset the query builder', () => {
      const query = buildQuery()
        .select('*')
        .from('users')
        .reset()
        .insert('posts', { title: 'Hello', content: 'World' });

      const { sql, parameters } = query.build();
      expect(sql).toContain('INSERT INTO `posts`');
      expect(sql).not.toContain('SELECT');
      expect(parameters).toContain('Hello');
      expect(parameters).toContain('World');
    });

    it('supports getSql and getParameters helpers', () => {
      const query = buildQuery().select('*').from('users').where('id', '=', 1).offset(5);

      expect(query.getSql()).toContain('OFFSET 5');
      expect(query.getParameters()).toEqual([1]);
    });

    it('supports typed IN and BETWEEN predicates', () => {
      const query = buildQuery()
        .select('*')
        .from('users')
        .whereIn('role', ['admin', 'editor'])
        .andBetween('age', 18, 40)
        .havingIn('role', ['admin']);

      const { sql, parameters } = query.build();
      expect(sql).toContain('WHERE `role` IN (?, ?)');
      expect(sql).toContain('AND `age` BETWEEN ? AND ?');
      expect(sql).toContain('HAVING `role` IN (?)');
      expect(parameters).toEqual(['admin', 'editor', 18, 40, 'admin']);
    });

    it('supports orIn, orBetween, and havingBetween predicates', () => {
      const query = buildQuery()
        .select('*')
        .from('users')
        .where('active', '=', true)
        .orIn('role', ['admin', 'editor'])
        .orBetween('age', 60, 90)
        .groupBy('role')
        .havingBetween('created_count', 1, 3);

      const { sql, parameters } = query.build();
      expect(sql).toContain('OR `role` IN (?, ?)');
      expect(sql).toContain('OR `age` BETWEEN ? AND ?');
      expect(sql).toContain('HAVING `created_count` BETWEEN ? AND ?');
      expect(parameters).toEqual([true, 'admin', 'editor', 60, 90, 1, 3]);
    });

    it('supports whereBetween, and, andIn predicates together', () => {
      const query = buildQuery()
        .select('*')
        .from('users')
        .whereBetween('age', 18, 30)
        .and('active', '=', true)
        .andIn('country', ['US', 'IN']);

      const { sql, parameters } = query.build();
      expect(sql).toContain('WHERE `age` BETWEEN ? AND ?');
      expect(sql).toContain('AND `active` = ?');
      expect(sql).toContain('AND `country` IN (?, ?)');
      expect(parameters).toEqual([18, 30, true, 'US', 'IN']);
    });

    it('covers SqlClient internal release fallback when end fails', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      const failingConnection = createMockConnection();
      const fallbackDestroy = jest.fn();
      failingConnection.end.mockRejectedValue(new Error('end failed'));
      failingConnection.destroy = fallbackDestroy;

      await expect(
        (
          client as unknown as {
            releaseTransactionConnection: (connection: Connection) => Promise<void>;
          }
        ).releaseTransactionConnection(failingConnection as unknown as Connection)
      ).resolves.toBeUndefined();

      expect(failingConnection.end).toHaveBeenCalledTimes(1);
      expect(fallbackDestroy).toHaveBeenCalledTimes(1);
    });

    it('covers SqlClient internal delay helper', async () => {
      const primaryConnection = createMockConnection();
      mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

      const client = await SqlClient.create({
        database: 'test',
        host: 'localhost',
        password: 'password',
        user: 'root'
      });

      await expect(
        (
          client as unknown as {
            delay: (ms: number) => Promise<void>;
          }
        ).delay(0)
      ).resolves.toBeUndefined();
    });

    it('throws when IN predicates are called with empty value lists', () => {
      expect(() => buildQuery().select('*').from('users').whereIn('id', [])).toThrow(
        'WHERE IN requires at least one value'
      );
    });

    it('throws for invalid table reference with extra tokens', () => {
      expect(() => buildQuery().select('*').from('users u extra')).toThrow('Invalid table reference');
    });

    it('escapes identifiers containing backticks', () => {
      const { sql } = buildQuery().insert('my`table', { 'na`me': 'Alice' }).build();
      expect(sql).toContain('`my``table`');
      expect(sql).toContain('`na``me`');
    });

    it('escapes table references with qualified names and alias', () => {
      const { sql } = buildQuery().select('*').from('app.users u').build();
      expect(sql).toContain('FROM `app`.`users` `u`');
    });
  });
});
