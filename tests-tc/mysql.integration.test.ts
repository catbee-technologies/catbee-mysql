import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { SqlClient, buildQuery, parseMysqlDateTime } from '../src';
import type { RowDataPacket } from 'mysql2';

describe('MySQL Testcontainers Integration', () => {
  jest.setTimeout(180_000);

  let container: StartedMySqlContainer;
  let client: SqlClient;

  beforeAll(async () => {
    container = await new MySqlContainer('mysql:8.4')
      .withDatabase('testdb')
      .withUsername('testuser')
      .withUserPassword('testpass')
      .start();

    client = await SqlClient.create({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
      enforceStatementKinds: true
    });

    await client.execute(`
      CREATE TABLE IF NOT EXISTS test_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at DATETIME(6) NOT NULL,
        metadata JSON NULL
      ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (container) {
      await container.stop();
    }
  });

  beforeEach(async () => {
    await client.execute('TRUNCATE TABLE test_users;');
  });

  it('verifies ping and basic connection', async () => {
    const isAlive = await client.ping();
    expect(isAlive).toBe(true);
  });

  it('performs CRUD operations with type safety and affected rows', async () => {
    // 1. INSERT
    const insertId = await client.insert(
      'INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)',
      ['Alice', 'alice@example.com', 150.5, true, '2026-10-21 10:00:00.123456']
    );
    expect(insertId).toBe(1);

    // 2. GET
    const user = await client.get<RowDataPacket & { id: number; name: string; email: string; balance: string }>(
      'SELECT * FROM test_users WHERE id = ?',
      [insertId]
    );
    expect(user).not.toBeNull();
    expect(user?.name).toBe('Alice');
    expect(user?.email).toBe('alice@example.com');
    expect(Number(user?.balance)).toBe(150.5);

    // 3. EXISTS
    const existsAlice = await client.exists('SELECT 1 FROM test_users WHERE email = ?', ['alice@example.com']);
    const existsNonExistent = await client.exists('SELECT 1 FROM test_users WHERE email = ?', ['nobody@example.com']);
    expect(existsAlice).toBe(true);
    expect(existsNonExistent).toBe(false);

    // 4. COUNT
    const count = await client.count('SELECT COUNT(*) FROM test_users WHERE active = ?', [true]);
    expect(count).toBe(1);

    // 5. UPDATE
    const affected = await client.update('UPDATE test_users SET balance = ? WHERE id = ?', [200.75, insertId]);
    expect(affected).toBe(1);

    // 6. ALL
    const allUsers = await client.all('SELECT * FROM test_users');
    expect(allUsers).toHaveLength(1);

    // 7. DELETE
    const deleted = await client.delete('DELETE FROM test_users WHERE id = ?', [insertId]);
    expect(deleted).toBe(1);

    const countAfterDelete = await client.count('SELECT COUNT(*) FROM test_users');
    expect(countAfterDelete).toBe(0);
  });

  it('executes named parameter queries with complex values', async () => {
    await client.executeNamed(
      'INSERT INTO test_users(name, email, balance, active, created_at) VALUES(:name, :email, :balance, :active, :created_at)',
      {
        name: 'Bob',
        email: 'bob@example.com',
        balance: 75.25,
        active: true,
        created_at: '2026-10-21 11:15:30.000000'
      }
    );

    const result = await client.queryNamed<RowDataPacket[]>(
      'SELECT * FROM test_users WHERE name = :name AND active = :active',
      { name: 'Bob', active: true }
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].email).toBe('bob@example.com');
  });

  it('executes CTE queries with enforceStatementKinds: true', async () => {
    await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
      'Charlie',
      'charlie@example.com',
      500,
      true,
      '2026-10-21 12:00:00'
    ]);

    const cteSql = `
      WITH high_balance AS (
        SELECT * FROM test_users WHERE balance >= ?
      )
      SELECT name, email FROM high_balance WHERE name = ?;
    `;

    const result = await client.query<RowDataPacket[]>(cteSql, [100, 'Charlie']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Charlie');
  });

  it('integrates with QueryBuilder for table alias and chained where clauses', async () => {
    await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
      'Diana',
      'diana@example.com',
      350,
      true,
      '2026-10-21 13:00:00'
    ]);

    const query = buildQuery()
      .select('u.id', 'u.name', 'u.email')
      .from('test_users AS u')
      .where('u.active', '=', true)
      .where('u.balance', '>', 100);

    const { sql, parameters } = query.build();
    const result = await client.query<RowDataPacket[]>(sql, parameters);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Diana');
  });

  describe('Transactions & Savepoints on live InnoDB', () => {
    it('commits managed transactions successfully', async () => {
      await client.transaction(async tx => {
        await tx.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
          'Edward',
          'edward@example.com',
          100,
          true,
          '2026-10-21 14:00:00'
        ]);
      });

      const exists = await client.exists('SELECT 1 FROM test_users WHERE email = ?', ['edward@example.com']);
      expect(exists).toBe(true);
    });

    it('rolls back managed transactions when an error is thrown', async () => {
      await expect(
        client.transaction(async tx => {
          await tx.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
            'Fiona',
            'fiona@example.com',
            100,
            true,
            '2026-10-21 14:00:00'
          ]);
          throw new Error('Simulated failure inside transaction');
        })
      ).rejects.toThrow('Simulated failure inside transaction');

      const exists = await client.exists('SELECT 1 FROM test_users WHERE email = ?', ['fiona@example.com']);
      expect(exists).toBe(false);
    });

    it('supports savepoints and partial rollback within active transactions', async () => {
      await client.transaction(async tx => {
        await tx.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
          'George',
          'george@example.com',
          100,
          true,
          '2026-10-21 15:00:00'
        ]);

        const sp = await tx.savepoint('step2');

        await tx.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
          'Hannah',
          'hannah@example.com',
          200,
          true,
          '2026-10-21 15:00:00'
        ]);

        // Roll back step 2
        await tx.rollbackTo(sp);
      });

      const existsGeorge = await client.exists('SELECT 1 FROM test_users WHERE email = ?', ['george@example.com']);
      const existsHannah = await client.exists('SELECT 1 FROM test_users WHERE email = ?', ['hannah@example.com']);

      expect(existsGeorge).toBe(true);
      expect(existsHannah).toBe(false);
    });

    it('supports full suite of convenience methods and releaseSavepoint in transactions', async () => {
      await client.transaction(async tx => {
        const id = await tx.insert(
          'INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)',
          ['TxUser', 'tx@example.com', 150, true, '2026-10-21 14:00:00']
        );

        const user = await tx.get<RowDataPacket & { name: string }>('SELECT name FROM test_users WHERE id = ?', [id]);
        expect(user?.name).toBe('TxUser');

        const all = await tx.all('SELECT * FROM test_users WHERE id = ?', [id]);
        expect(all).toHaveLength(1);

        const exists = await tx.exists('SELECT 1 FROM test_users WHERE email = ?', ['tx@example.com']);
        expect(exists).toBe(true);

        const count = await tx.count('SELECT COUNT(*) FROM test_users WHERE id = ?', [id]);
        expect(count).toBe(1);

        const updated = await tx.update('UPDATE test_users SET balance = ? WHERE id = ?', [300, id]);
        expect(updated).toBe(1);

        const sp = await tx.savepoint('temp_sp');
        await tx.releaseSavepoint(sp);

        const deleted = await tx.delete('DELETE FROM test_users WHERE id = ?', [id]);
        expect(deleted).toBe(1);
      });
    });

    it('applies transaction isolation levels and read-only mode', async () => {
      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'Ian',
        'ian@example.com',
        50,
        true,
        '2026-10-21 16:00:00'
      ]);

      const rows = await client.transaction(
        async tx => {
          return await tx.query<RowDataPacket[]>('SELECT * FROM test_users WHERE name = ?', ['Ian']);
        },
        { isolationLevel: 'READ COMMITTED', readOnly: true }
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Ian');
    });

    it('demonstrates MVCC consistent snapshot in REPEATABLE READ vs READ COMMITTED', async () => {
      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'SnapshotUser',
        'snapshot@example.com',
        100.0,
        true,
        '2026-10-21 12:00:00'
      ]);

      const writerClient = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      try {
        // Test 1: REPEATABLE READ (Snapshot remains frozen even when writer commits)
        const txRR = await client.startTransaction({ isolationLevel: 'REPEATABLE READ' });
        const read1 = await txRR.get<RowDataPacket & { balance: string }>(
          'SELECT balance FROM test_users WHERE email = ?',
          ['snapshot@example.com']
        );
        expect(Number(read1?.balance)).toBe(100.0);

        // Writer updates and commits
        await writerClient.update('UPDATE test_users SET balance = ? WHERE email = ?', [200.0, 'snapshot@example.com']);

        // In REPEATABLE READ, txRR must still see 100.0
        const read2 = await txRR.get<RowDataPacket & { balance: string }>(
          'SELECT balance FROM test_users WHERE email = ?',
          ['snapshot@example.com']
        );
        expect(Number(read2?.balance)).toBe(100.0);
        await txRR.commit();

        // Outside txRR, new read sees 200.0
        const readAfter = await client.get<RowDataPacket & { balance: string }>(
          'SELECT balance FROM test_users WHERE email = ?',
          ['snapshot@example.com']
        );
        expect(Number(readAfter?.balance)).toBe(200.0);

        // Test 2: READ COMMITTED (sees committed updates immediately)
        const txRC = await client.startTransaction({ isolationLevel: 'READ COMMITTED' });
        const readRC1 = await txRC.get<RowDataPacket & { balance: string }>(
          'SELECT balance FROM test_users WHERE email = ?',
          ['snapshot@example.com']
        );
        expect(Number(readRC1?.balance)).toBe(200.0);

        // Writer updates to 300.0 and commits
        await writerClient.update('UPDATE test_users SET balance = ? WHERE email = ?', [300.0, 'snapshot@example.com']);

        // In READ COMMITTED, txRC immediately sees 300.0
        const readRC2 = await txRC.get<RowDataPacket & { balance: string }>(
          'SELECT balance FROM test_users WHERE email = ?',
          ['snapshot@example.com']
        );
        expect(Number(readRC2?.balance)).toBe(300.0);
        await txRC.commit();
      } finally {
        await writerClient.close();
      }
    });

    it('blocks concurrent updates with row-level locks (FOR UPDATE)', async () => {
      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'LockedUser',
        'locked@example.com',
        100.0,
        true,
        '2026-10-21 12:00:00'
      ]);

      const lockerClient = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      const waiterClient = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      try {
        const tx = await lockerClient.startTransaction();
        await tx.query('SELECT * FROM test_users WHERE email = ? FOR UPDATE', ['locked@example.com']);

        let waiterResolved = false;
        const waiterPromise = waiterClient
          .update('UPDATE test_users SET balance = ? WHERE email = ?', [999.0, 'locked@example.com'])
          .then(res => {
            waiterResolved = true;
            return res;
          });

        await new Promise(resolve => setTimeout(resolve, 100));
        expect(waiterResolved).toBe(false);

        await tx.commit();

        const affected = await waiterPromise;
        expect(affected).toBe(1);
        expect(waiterResolved).toBe(true);

        const finalBalance = await client.get<RowDataPacket & { balance: string }>(
          'SELECT balance FROM test_users WHERE email = ?',
          ['locked@example.com']
        );
        expect(Number(finalBalance?.balance)).toBe(999.0);
      } finally {
        await lockerClient.close();
        await waiterClient.close();
      }
    });
  });

  describe('Advanced Engine Features', () => {
    it('stores and retrieves DATETIME(6) with full microsecond precision and UTC timezone', async () => {
      const microsecondString = '2026-10-21 15:45:30.987654';

      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'PreciseTimeUser',
        'time@example.com',
        10.0,
        true,
        microsecondString
      ]);

      const user = await client.get<RowDataPacket & { created_at: string }>(
        'SELECT DATE_FORMAT(created_at, "%Y-%m-%d %H:%i:%s.%f") AS created_at FROM test_users WHERE email = ?',
        ['time@example.com']
      );

      expect(user?.created_at).toBe(microsecondString);

      const parsed = parseMysqlDateTime(user!.created_at);
      expect(parsed).not.toBeNull();
      expect(parsed?.getUTCFullYear()).toBe(2026);
      expect(parsed?.getUTCMilliseconds()).toBe(987);
    });

    it('supports recursive CTE queries (WITH RECURSIVE) under enforceStatementKinds: true', async () => {
      const recursiveSql = `
        WITH RECURSIVE countdown(n) AS (
          SELECT 3
          UNION ALL
          SELECT n - 1 FROM countdown WHERE n > 1
        )
        SELECT n FROM countdown;
      `;

      const result = await client.query<RowDataPacket[]>(recursiveSql);
      expect(result.rows.map(r => r.n)).toEqual([3, 2, 1]);
    });

    it('recovers transparently when server severs connection (KILL CONNECTION_ID)', async () => {
      const resilientClient = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase(),
        retry: {
          maxRetries: 2,
          baseDelayMs: 20
        }
      });

      const adminClient = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      try {
        const res = await resilientClient.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS cid');
        const cid = Number(res.rows[0].cid);

        await adminClient.raw(`KILL ${cid}`);

        const alive = await resilientClient.query<RowDataPacket[]>('SELECT 12345 AS num, CONNECTION_ID() AS new_cid');
        expect(alive.rows[0].num).toBe(12345);
        expect(Number(alive.rows[0].new_cid)).not.toBe(cid);
      } finally {
        await resilientClient.close();
        await adminClient.close();
      }
    });

    it('preserves full 4-byte utf8mb4 unicode, emojis, and symbols without truncation', async () => {
      const complexText = 'Alice 🐱🐝 🚀 🧑‍💻 𠮷野家 カタカナ';
      const insertId = await client.insert(
        'INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)',
        [complexText, 'emoji@example.com', 77.77, true, '2026-10-21 12:00:00']
      );

      const user = await client.get<RowDataPacket & { name: string }>('SELECT name FROM test_users WHERE id = ?', [
        insertId
      ]);
      expect(user?.name).toBe(complexText);
    });

    it('performs native 2D array bulk insert with execute() and 1D array IN (?) expansion with query()', async () => {
      const bulkRows = [
        ['Bulk 1', 'bulk1@example.com', 10.0, true, '2026-10-21 10:00:00.000000'],
        ['Bulk 2', 'bulk2@example.com', 20.0, true, '2026-10-21 10:00:00.000000'],
        ['Bulk 3', 'bulk3@example.com', 30.0, true, '2026-10-21 10:00:00.000000']
      ];

      const res = await client.execute('INSERT INTO test_users(name, email, balance, active, created_at) VALUES ?', [
        bulkRows
      ]);
      expect(res.result.affectedRows).toBe(3);

      const inQuery = await client.query<RowDataPacket[]>(
        'SELECT email, balance FROM test_users WHERE email IN (?) ORDER BY email ASC',
        [['bulk1@example.com', 'bulk3@example.com']]
      );
      expect(inQuery.rows).toHaveLength(2);
      expect(inQuery.rows.map(r => r.email)).toEqual(['bulk1@example.com', 'bulk3@example.com']);
    });

    it('supports native JSON columns, serialization, and JSON extraction (->>)', async () => {
      const metadata = JSON.stringify({
        department: 'Engineering',
        tags: ['backend', 'database'],
        preferences: { theme: 'dark', notifications: true }
      });

      await client.insert(
        'INSERT INTO test_users(name, email, balance, active, created_at, metadata) VALUES(?, ?, ?, ?, ?, ?)',
        ['JsonUser', 'json@example.com', 120.0, true, '2026-10-21 12:00:00', metadata]
      );

      const user = await client.get<RowDataPacket & { theme: string; dept: string }>(
        'SELECT metadata->>"$.preferences.theme" AS theme, metadata->>"$.department" AS dept FROM test_users WHERE email = ?',
        ['json@example.com']
      );
      expect(user?.theme).toBe('dark');
      expect(user?.dept).toBe('Engineering');
    });

    it('enforces engine lock wait timeout (ER_LOCK_WAIT_TIMEOUT) and handles timeout rejection', async () => {
      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'TimeoutUser',
        'timeout@example.com',
        50.0,
        true,
        '2026-10-21 12:00:00'
      ]);

      const locker = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      const waiter = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      try {
        const tx = await locker.startTransaction();
        await tx.query('SELECT * FROM test_users WHERE email = ? FOR UPDATE', ['timeout@example.com']);

        // Set session lock wait timeout to 1 second
        await waiter.raw('SET SESSION innodb_lock_wait_timeout = 1');

        await expect(
          waiter.update('UPDATE test_users SET balance = 999 WHERE email = ?', ['timeout@example.com'])
        ).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });

        await tx.commit();
      } finally {
        await locker.close();
        await waiter.close();
      }
    });

    it('detects cyclic InnoDB deadlocks and surfaces ER_LOCK_DEADLOCK', async () => {
      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'UserA',
        'deadlock_a@example.com',
        100.0,
        true,
        '2026-10-21 12:00:00'
      ]);
      await client.insert('INSERT INTO test_users(name, email, balance, active, created_at) VALUES(?, ?, ?, ?, ?)', [
        'UserB',
        'deadlock_b@example.com',
        200.0,
        true,
        '2026-10-21 12:00:00'
      ]);

      const clientA = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      const clientB = await SqlClient.create({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase()
      });

      try {
        const txA = await clientA.startTransaction();
        const txB = await clientB.startTransaction();

        // txA locks row A; txB locks row B
        await txA.update('UPDATE test_users SET balance = 111 WHERE email = ?', ['deadlock_a@example.com']);
        await txB.update('UPDATE test_users SET balance = 222 WHERE email = ?', ['deadlock_b@example.com']);

        // txA attempts to lock row B (waiting for txB)
        let txAResolved = false;
        let txAError: unknown;
        const promiseA = txA
          .update('UPDATE test_users SET balance = 333 WHERE email = ?', ['deadlock_b@example.com'])
          .then(res => {
            txAResolved = true;
            return res;
          })
          .catch(err => {
            txAError = err;
            throw err;
          });

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(txAResolved).toBe(false);

        // txB attempts to lock row A (creates cycle: InnoDB deadlock detection triggers immediately)
        let txBError: unknown;
        try {
          await txB.update('UPDATE test_users SET balance = 444 WHERE email = ?', ['deadlock_a@example.com']);
          await txB.commit();
        } catch (err) {
          txBError = err;
          await txB.rollback().catch(() => {});
        }

        await promiseA.catch(() => {});
        await txA.rollback().catch(() => {});

        const victimError = (txAError || txBError) as { code?: string };
        expect(victimError).toBeDefined();
        expect(victimError.code).toBe('ER_LOCK_DEADLOCK');
      } finally {
        await clientA.close();
        await clientB.close();
      }
    });
  });

  describe('Connection Pooling', () => {
    it('handles concurrent queries across connection pool', async () => {
      const poolClient = SqlClient.createPool({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase(),
        connectionLimit: 5
      });

      try {
        const queries = Array.from({ length: 15 }, (_, i) => poolClient.query<RowDataPacket[]>('SELECT ? AS num', [i]));

        const results = await Promise.all(queries);
        expect(results).toHaveLength(15);
        results.forEach((res, i) => {
          expect(res.rows[0].num).toBe(i);
        });
      } finally {
        await poolClient.close();
      }
    });

    it('enforces pool queueLimit and rejects excess requests when queue overflows', async () => {
      const strictPool = SqlClient.createPool({
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getUserPassword(),
        database: container.getDatabase(),
        connectionLimit: 1,
        queueLimit: 1,
        waitForConnections: true
      });

      try {
        const q1 = strictPool.query('SELECT SLEEP(0.2)');
        const q2 = strictPool.query('SELECT 2 AS num');
        const q3Promise = strictPool.query('SELECT 3 AS num');

        await expect(q3Promise).rejects.toThrow(/Queue limit reached/i);

        await Promise.all([q1, q2]);
      } finally {
        await strictPool.close();
      }
    });
  });
});
