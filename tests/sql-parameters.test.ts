import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { createConnection, type Connection } from 'mysql2/promise';
import {
  SqlClient,
  type SqlScalar,
  type SqlScalarValue,
  type SqlValue,
  type SqlParameters,
  type SqlTransaction
} from '../src';

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
  createPool: jest.fn()
}));

type MockConnection = jest.Mocked<
  Pick<Connection, 'beginTransaction' | 'commit' | 'end' | 'execute' | 'query' | 'rollback'>
>;

const mockedCreateConnection = jest.mocked(createConnection);

const createMockConnection = (): MockConnection => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  end: jest.fn().mockResolvedValue(undefined),
  execute: jest.fn(),
  query: jest.fn(),
  rollback: jest.fn().mockResolvedValue(undefined)
});

type TaskType = 'WORKORDER' | 'MONITORING';

describe('SQL Parameter Typing and Validation', () => {
  let primaryConnection: MockConnection;
  let client: SqlClient;

  beforeEach(async () => {
    jest.clearAllMocks();
    primaryConnection = createMockConnection();
    mockedCreateConnection.mockResolvedValue(primaryConnection as unknown as Connection);

    client = await SqlClient.create({
      database: 'test_db',
      host: 'localhost',
      password: 'password',
      user: 'root'
    });
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Static Type Compatibility', () => {
    it('allows scalar values as SqlScalar and SqlValue', () => {
      const strVal: SqlScalar = 'hello';
      const numVal: SqlScalar = 42;
      const boolVal: SqlScalar = true;
      const bufVal: SqlScalar = Buffer.from('test');
      const nullVal: SqlScalar = null;

      const scalarAlias: SqlScalarValue = strVal;

      const val1: SqlValue = strVal;
      const val2: SqlValue = numVal;
      const val3: SqlValue = boolVal;
      const val4: SqlValue = bufVal;
      const val5: SqlValue = nullVal;
      const val6: SqlValue = scalarAlias;

      expect([val1, val2, val3, val4, val5, val6]).toBeDefined();
    });

    it('allows 1D and 2D arrays as SqlValue and SqlParameters', () => {
      const types: TaskType[] = ['WORKORDER', 'MONITORING'];
      const readonlyTypes: readonly TaskType[] = ['WORKORDER', 'MONITORING'];
      const constTypes = ['WORKORDER', 'MONITORING'] as const;

      const values = [
        ['uuid1', 'UK', 'app', '{}'],
        ['uuid2', 'UK', 'app', '{}']
      ];
      const readonlyValues: readonly (readonly string[])[] = [
        ['uuid1', 'UK'],
        ['uuid2', 'UK']
      ];
      const constValues = [
        ['uuid1', 'UK'],
        ['uuid2', 'UK']
      ] as const;

      // SqlValue assignments
      const val1: SqlValue = types;
      const val2: SqlValue = readonlyTypes;
      const val3: SqlValue = constTypes;
      const val4: SqlValue = values;
      const val5: SqlValue = readonlyValues;
      const val6: SqlValue = constValues;

      // SqlParameters assignments
      const params1: SqlParameters = ['Alice', 123, true, null, Buffer.from('hi')];
      const params2: SqlParameters = types;
      const params3: SqlParameters = readonlyTypes;
      const params4: SqlParameters = constTypes;
      const params5: SqlParameters = [types];
      const params6: SqlParameters = [readonlyTypes];
      const params7: SqlParameters = [values];
      const params8: SqlParameters = [readonlyValues];
      const params9: SqlParameters = [constValues];
      const params10: SqlParameters = values;
      const params11: SqlParameters = [];

      expect([
        val1,
        val2,
        val3,
        val4,
        val5,
        val6,
        params1,
        params2,
        params3,
        params4,
        params5,
        params6,
        params7,
        params8,
        params9,
        params10,
        params11
      ]).toBeDefined();
    });
  });

  describe('Scalar Parameters', () => {
    it('supports scalar parameters in query()', async () => {
      const rows = [{ id: 1, name: 'Alice', active: true }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);

      const buffer = Buffer.from('payload');
      const result = await client.query(
        'SELECT * FROM users WHERE id = ? AND name = ? AND active = ? AND data = ? AND deleted_at IS ?',
        [1, 'Alice', true, buffer, null]
      );

      expect(result.rows).toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = ? AND name = ? AND active = ? AND data = ? AND deleted_at IS ?',
        [1, 'Alice', true, buffer, null]
      );
    });

    it('supports scalar parameters in execute()', async () => {
      const header = { affectedRows: 1, insertId: 42 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const result = await client.execute('UPDATE users SET name = ?, active = ? WHERE id = ?', ['Bob', false, 1]);

      expect(result.result).toEqual(header);
      expect(primaryConnection.execute).toHaveBeenCalledWith('UPDATE users SET name = ?, active = ? WHERE id = ?', [
        'Bob',
        false,
        1
      ]);
    });
  });

  describe('IN Clause Parameters', () => {
    it('supports array passed directly for multiple placeholders: WHERE type IN (?, ?)', async () => {
      const header = { affectedRows: 2, insertId: 0 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const types: TaskType[] = ['WORKORDER', 'MONITORING'];
      const affected = await client.delete('DELETE FROM tasks WHERE type IN (?, ?)', types);

      expect(affected).toBe(2);
      expect(primaryConnection.execute).toHaveBeenCalledWith('DELETE FROM tasks WHERE type IN (?, ?)', types);
    });

    it('supports array inside parameters for single placeholder: WHERE type IN (?)', async () => {
      const rows = [
        { id: 1, type: 'WORKORDER' },
        { id: 2, type: 'MONITORING' }
      ] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);

      const types: TaskType[] = ['WORKORDER', 'MONITORING'];
      const result = await client.query('SELECT * FROM tasks WHERE type IN (?)', [types]);

      expect(result.rows).toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM tasks WHERE type IN (?)', [types]);
    });

    it('supports numeric IN clause array', async () => {
      const rows = [{ id: 10 }, { id: 20 }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);

      const ids = [10, 20, 30];
      const result = await client.all('SELECT * FROM tasks WHERE id IN (?)', [ids]);

      expect(result).toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM tasks WHERE id IN (?)', [ids]);
    });
  });

  describe('Bulk INSERT ... VALUES ?', () => {
    it('supports 2D array for bulk insert', async () => {
      const header = { affectedRows: 2, insertId: 100 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const values = [
        ['uuid1', 'UK', 'app', '{}'],
        ['uuid2', 'UK', 'app', '{}']
      ];

      const affected = await client.insert(
        'INSERT INTO psx_configurations (uuid, territory, createdBy, data) VALUES ?',
        [values]
      );

      expect(affected).toBe(2);
      expect(primaryConnection.execute).toHaveBeenCalledWith(
        'INSERT INTO psx_configurations (uuid, territory, createdBy, data) VALUES ?',
        [values]
      );
    });

    it('supports mixed scalar types in 2D array rows', async () => {
      const header = { affectedRows: 2, insertId: 1 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const rows: [string, number, boolean, Buffer, null][] = [
        ['uuid1', 10, true, Buffer.from('a'), null],
        ['uuid2', 20, false, Buffer.from('b'), null]
      ];

      const affected = await client.insert(
        'INSERT INTO complex_table (uuid, count, is_ready, payload, extra) VALUES ?',
        [rows]
      );

      expect(affected).toBe(2);
      expect(primaryConnection.execute).toHaveBeenCalledWith(
        'INSERT INTO complex_table (uuid, count, is_ready, payload, extra) VALUES ?',
        [rows]
      );
    });
  });

  describe('Readonly Arrays', () => {
    it('supports readonly array for IN clause', async () => {
      const header = { affectedRows: 2, insertId: 0 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const readonlyTypes: readonly TaskType[] = ['WORKORDER', 'MONITORING'];
      const affected = await client.delete('DELETE FROM tasks WHERE type IN (?, ?)', readonlyTypes);

      expect(affected).toBe(2);
      expect(primaryConnection.execute).toHaveBeenCalledWith('DELETE FROM tasks WHERE type IN (?, ?)', readonlyTypes);
    });

    it('supports "as const" tuple for IN clause with [constTypes]', async () => {
      const rows = [{ id: 1 }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);

      const constTypes = ['WORKORDER', 'MONITORING'] as const;
      const result = await client.query('SELECT * FROM tasks WHERE type IN (?)', [constTypes]);

      expect(result.rows).toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM tasks WHERE type IN (?)', [constTypes]);
    });

    it('supports readonly 2D arrays for bulk insert', async () => {
      const header = { affectedRows: 2, insertId: 10 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const readonlyValues: readonly (readonly string[])[] = [
        ['uuid1', 'UK', 'app', '{}'],
        ['uuid2', 'UK', 'app', '{}']
      ];

      const affected = await client.insert(
        'INSERT INTO psx_configurations (uuid, territory, createdBy, data) VALUES ?',
        [readonlyValues]
      );

      expect(affected).toBe(2);
      expect(primaryConnection.execute).toHaveBeenCalledWith(
        'INSERT INTO psx_configurations (uuid, territory, createdBy, data) VALUES ?',
        [readonlyValues]
      );
    });

    it('supports "as const" 2D array for bulk insert', async () => {
      const header = { affectedRows: 2, insertId: 10 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const constValues = [
        ['uuid1', 'UK'],
        ['uuid2', 'UK']
      ] as const;

      const affected = await client.insert('INSERT INTO psx_configurations (uuid, territory) VALUES ?', [constValues]);

      expect(affected).toBe(2);
      expect(primaryConnection.execute).toHaveBeenCalledWith(
        'INSERT INTO psx_configurations (uuid, territory) VALUES ?',
        [constValues]
      );
    });
  });

  describe('Empty Arrays', () => {
    it('supports empty parameters array', async () => {
      const rows = [{ total: 5 }] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);

      const result = await client.query('SELECT count(*) FROM tasks', []);
      expect(result.rows).toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT count(*) FROM tasks', []);
    });

    it('supports empty 1D array inside parameter array: [[]]', async () => {
      const rows = [] as RowDataPacket[];
      primaryConnection.query.mockResolvedValue([rows, []]);

      const emptyList: TaskType[] = [];
      const result = await client.query('SELECT * FROM tasks WHERE type IN (?)', [emptyList]);
      expect(result.rows).toEqual(rows);
      expect(primaryConnection.query).toHaveBeenCalledWith('SELECT * FROM tasks WHERE type IN (?)', [emptyList]);
    });

    it('supports empty 2D array inside parameter array for bulk insert', async () => {
      const header = { affectedRows: 0, insertId: 0 } as ResultSetHeader;
      primaryConnection.execute.mockResolvedValue([header, []]);

      const empty2D: string[][] = [];
      const affected = await client.insert('INSERT INTO psx_configurations VALUES ?', [empty2D]);
      expect(affected).toBe(0);
      expect(primaryConnection.execute).toHaveBeenCalledWith('INSERT INTO psx_configurations VALUES ?', [empty2D]);
    });
  });

  describe('Transactions Support', () => {
    it('accepts bulk insert and IN clause parameters in SqlTransaction', async () => {
      const header = { affectedRows: 2, insertId: 50 } as ResultSetHeader;
      const rows = [{ id: 1 }] as RowDataPacket[];
      primaryConnection.execute.mockResolvedValue([header, []]);
      primaryConnection.query.mockResolvedValue([rows, []]);

      const tx: SqlTransaction = await client.startTransaction();

      const values = [
        ['uuid1', 'UK'],
        ['uuid2', 'UK']
      ];
      const inserted = await tx.insert('INSERT INTO t (uuid, territory) VALUES ?', [values]);
      expect(inserted).toBe(2);

      const types: TaskType[] = ['WORKORDER', 'MONITORING'];
      const deleted = await tx.delete('DELETE FROM tasks WHERE type IN (?, ?)', types);
      expect(deleted).toBe(2);

      const selected = await tx.query('SELECT * FROM tasks WHERE type IN (?)', [types]);
      expect(selected).toEqual(rows);

      await tx.commit();
    });
  });

  describe('Runtime Validation', () => {
    it('rejects Date parameter at top level', async () => {
      await expect(client.query('SELECT ?', [new Date()] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
    });

    it('rejects 1D array containing Date', async () => {
      await expect(
        client.query('SELECT * FROM tasks WHERE created_at IN (?)', [[new Date()]] as unknown as any)
      ).rejects.toThrow('Unsupported SQL parameter at index 0');
    });

    it('rejects 2D array containing Date', async () => {
      await expect(client.insert('INSERT INTO t VALUES ?', [[['uuid', new Date()]]] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
    });

    it('rejects 3D array exceeding 2D depth', async () => {
      await expect(client.query('SELECT ?', [[[['deep']]]] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
    });

    it('rejects plain object parameter', async () => {
      await expect(client.query('SELECT ?', [{ id: 123 }] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
    });

    it('rejects array containing plain object', async () => {
      await expect(client.query('SELECT ?', [[{ id: 123 }]] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
    });

    it('rejects undefined parameter', async () => {
      await expect(client.query('SELECT ?', [undefined] as unknown as any)).rejects.toThrow(
        'Unsupported SQL parameter at index 0'
      );
    });
  });
});
