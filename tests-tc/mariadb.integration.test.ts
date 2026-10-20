import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb';
import { SqlClient, buildQuery, parseMysqlDateTime } from '../src';
import type { RowDataPacket } from 'mysql2';

describe('MariaDB Testcontainers Integration', () => {
  jest.setTimeout(180_000);

  let container: StartedMariaDbContainer;
  let client: SqlClient;

  beforeAll(async () => {
    container = await new MariaDbContainer('mariadb:11.4')
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
      CREATE TABLE IF NOT EXISTS test_products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        sku VARCHAR(50) UNIQUE NOT NULL,
        price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        in_stock BOOLEAN NOT NULL DEFAULT TRUE,
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
    await client.execute('TRUNCATE TABLE test_products;');
  });

  it('verifies ping and basic connection to MariaDB', async () => {
    const isAlive = await client.ping();
    expect(isAlive).toBe(true);
  });

  it('performs CRUD operations with type safety on MariaDB', async () => {
    const insertId = await client.insert(
      'INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)',
      ['Laptop', 'SKU-001', 999.99, true, '2026-10-21 10:00:00.000000']
    );
    expect(insertId).toBe(1);

    const product = await client.get<RowDataPacket & { id: number; title: string; price: string }>(
      'SELECT * FROM test_products WHERE id = ?',
      [insertId]
    );
    expect(product).not.toBeNull();
    expect(product?.title).toBe('Laptop');
    expect(Number(product?.price)).toBe(999.99);

    const exists = await client.exists('SELECT 1 FROM test_products WHERE sku = ?', ['SKU-001']);
    expect(exists).toBe(true);

    const count = await client.count('SELECT COUNT(*) FROM test_products WHERE in_stock = ?', [true]);
    expect(count).toBe(1);

    const updated = await client.update('UPDATE test_products SET price = ? WHERE id = ?', [899.99, insertId]);
    expect(updated).toBe(1);

    const deleted = await client.delete('DELETE FROM test_products WHERE id = ?', [insertId]);
    expect(deleted).toBe(1);
  });

  it('supports CTE queries on MariaDB', async () => {
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'Monitor',
      'SKU-002',
      299.99,
      true,
      '2026-10-21 11:00:00'
    ]);

    const cteSql = `
      WITH active_items AS (
        SELECT * FROM test_products WHERE in_stock = 1
      )
      SELECT title, sku FROM active_items WHERE sku = ?;
    `;

    const result = await client.query<RowDataPacket[]>(cteSql, ['SKU-002']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('Monitor');
  });

  it('supports QueryBuilder on MariaDB', async () => {
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'Keyboard',
      'SKU-003',
      49.99,
      true,
      '2026-10-21 12:00:00'
    ]);

    const query = buildQuery()
      .select('p.id', 'p.title', 'p.price')
      .from('test_products AS p')
      .where('p.in_stock', '=', true)
      .where('p.price', '<', 100);

    const { sql, parameters } = query.build();
    const result = await client.query<RowDataPacket[]>(sql, parameters);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('Keyboard');
  });

  it('executes transactions with isolation levels and savepoints on MariaDB', async () => {
    await client.transaction(
      async tx => {
        await tx.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
          'Mouse',
          'SKU-004',
          29.99,
          true,
          '2026-10-21 13:00:00'
        ]);

        const sp = await tx.savepoint('sp_temp');
        await tx.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
          'Headphones',
          'SKU-005',
          79.99,
          true,
          '2026-10-21 13:00:00'
        ]);
        await tx.rollbackTo(sp);
      },
      { isolationLevel: 'READ COMMITTED' }
    );

    const existsMouse = await client.exists('SELECT 1 FROM test_products WHERE sku = ?', ['SKU-004']);
    const existsHeadphones = await client.exists('SELECT 1 FROM test_products WHERE sku = ?', ['SKU-005']);

    expect(existsMouse).toBe(true);
    expect(existsHeadphones).toBe(false);
  });

  it('supports connection pooling on MariaDB', async () => {
    const poolClient = SqlClient.createPool({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
      connectionLimit: 4
    });

    try {
      const queries = Array.from({ length: 8 }, (_, i) => poolClient.query<RowDataPacket[]>('SELECT ? AS idx', [i]));

      const results = await Promise.all(queries);
      expect(results).toHaveLength(8);
      results.forEach((res, i) => {
        expect(res.rows[0].idx).toBe(i);
      });
    } finally {
      await poolClient.close();
    }
  });

  it('supports recursive CTE queries on MariaDB', async () => {
    const recursiveSql = `
      WITH RECURSIVE seq(x) AS (
        SELECT 1
        UNION ALL
        SELECT x + 1 FROM seq WHERE x < 4
      )
      SELECT x FROM seq;
    `;

    const result = await client.query<RowDataPacket[]>(recursiveSql);
    expect(result.rows.map(r => r.x)).toEqual([1, 2, 3, 4]);
  });

  it('stores and retrieves DATETIME(6) with microseconds on MariaDB', async () => {
    const timestamp = '2026-10-21 16:30:00.654321';
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'Webcam',
      'SKU-006',
      59.99,
      true,
      timestamp
    ]);

    const product = await client.get<RowDataPacket & { created_at: string }>(
      'SELECT DATE_FORMAT(created_at, "%Y-%m-%d %H:%i:%s.%f") AS created_at FROM test_products WHERE sku = ?',
      ['SKU-006']
    );

    expect(product?.created_at).toBe(timestamp);
    const parsed = parseMysqlDateTime(product!.created_at);
    expect(parsed).not.toBeNull();
    expect(parsed?.getUTCMilliseconds()).toBe(654);
  });

  it('demonstrates MVCC consistent snapshot on MariaDB', async () => {
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'Speaker',
      'SKU-007',
      40.0,
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
      const txRR = await client.startTransaction({ isolationLevel: 'REPEATABLE READ' });
      const read1 = await txRR.get<RowDataPacket & { price: string }>('SELECT price FROM test_products WHERE sku = ?', [
        'SKU-007'
      ]);
      expect(Number(read1?.price)).toBe(40.0);

      await writerClient.update('UPDATE test_products SET price = ? WHERE sku = ?', [80.0, 'SKU-007']);

      // Snapshot remains 40.0
      const read2 = await txRR.get<RowDataPacket & { price: string }>('SELECT price FROM test_products WHERE sku = ?', [
        'SKU-007'
      ]);
      expect(Number(read2?.price)).toBe(40.0);
      await txRR.commit();

      const readAfter = await client.get<RowDataPacket & { price: string }>(
        'SELECT price FROM test_products WHERE sku = ?',
        ['SKU-007']
      );
      expect(Number(readAfter?.price)).toBe(80.0);
    } finally {
      await writerClient.close();
    }
  });

  it('blocks concurrent updates with row-level locks (FOR UPDATE) on MariaDB', async () => {
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'LockItem',
      'SKU-LOCK',
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
      await tx.query('SELECT * FROM test_products WHERE sku = ? FOR UPDATE', ['SKU-LOCK']);

      let waiterResolved = false;
      const waiterPromise = waiterClient
        .update('UPDATE test_products SET price = ? WHERE sku = ?', [999.0, 'SKU-LOCK'])
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

      const finalPrice = await client.get<RowDataPacket & { price: string }>(
        'SELECT price FROM test_products WHERE sku = ?',
        ['SKU-LOCK']
      );
      expect(Number(finalPrice?.price)).toBe(999.0);
    } finally {
      await lockerClient.close();
      await waiterClient.close();
    }
  });

  it('recovers transparently when MariaDB severs connection (KILL CONNECTION_ID)', async () => {
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

      const alive = await resilientClient.query<RowDataPacket[]>('SELECT 99999 AS num, CONNECTION_ID() AS new_cid');
      expect(alive.rows[0].num).toBe(99999);
      expect(Number(alive.rows[0].new_cid)).not.toBe(cid);
    } finally {
      await resilientClient.close();
      await adminClient.close();
    }
  });

  it('enforces pool queueLimit and rejects excess requests on MariaDB', async () => {
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

  it('preserves full 4-byte utf8mb4 unicode, emojis, and symbols on MariaDB', async () => {
    const complexTitle = 'Keyboard 🐱🐝 🚀 🧑‍💻 𠮷野家 カタカナ';
    const insertId = await client.insert(
      'INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)',
      [complexTitle, 'SKU-EMOJI', 45.0, true, '2026-10-21 12:00:00']
    );

    const product = await client.get<RowDataPacket & { title: string }>(
      'SELECT title FROM test_products WHERE id = ?',
      [insertId]
    );
    expect(product?.title).toBe(complexTitle);
  });

  it('performs native 2D array bulk insert with execute() and 1D array IN (?) expansion on MariaDB', async () => {
    const bulkRows = [
      ['Bulk Product 1', 'SKU-B1', 10.0, true, '2026-10-21 10:00:00.000000'],
      ['Bulk Product 2', 'SKU-B2', 20.0, true, '2026-10-21 10:00:00.000000'],
      ['Bulk Product 3', 'SKU-B3', 30.0, true, '2026-10-21 10:00:00.000000']
    ];

    const res = await client.execute('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES ?', [
      bulkRows
    ]);
    expect(res.result.affectedRows).toBe(3);

    const inQuery = await client.query<RowDataPacket[]>(
      'SELECT sku FROM test_products WHERE sku IN (?) ORDER BY sku ASC',
      [['SKU-B1', 'SKU-B3']]
    );
    expect(inQuery.rows).toHaveLength(2);
    expect(inQuery.rows.map(r => r.sku)).toEqual(['SKU-B1', 'SKU-B3']);
  });

  it('supports native JSON columns, serialization, and JSON extraction on MariaDB', async () => {
    const metadata = JSON.stringify({
      category: 'Electronics',
      specs: { wireless: true, batteryHours: 24 }
    });

    await client.insert(
      'INSERT INTO test_products(title, sku, price, in_stock, created_at, metadata) VALUES(?, ?, ?, ?, ?, ?)',
      ['SmartDevice', 'SKU-SMART', 199.99, true, '2026-10-21 12:00:00', metadata]
    );

    const product = await client.get<RowDataPacket & { category: string; wireless: string }>(
      "SELECT JSON_VALUE(metadata, '$.category') AS category, JSON_VALUE(metadata, '$.specs.wireless') AS wireless FROM test_products WHERE sku = ?",
      ['SKU-SMART']
    );
    expect(product?.category).toBe('Electronics');
    expect(product?.wireless === '1' || product?.wireless === 'true').toBe(true);
  });

  it('enforces engine lock wait timeout (ER_LOCK_WAIT_TIMEOUT) on MariaDB', async () => {
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'LockTimeoutProd',
      'SKU-TIMEOUT',
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
      await tx.query('SELECT * FROM test_products WHERE sku = ? FOR UPDATE', ['SKU-TIMEOUT']);

      // Set session lock wait timeout to 1 second
      await waiter.raw('SET SESSION innodb_lock_wait_timeout = 1');

      await expect(
        waiter.update('UPDATE test_products SET price = 999 WHERE sku = ?', ['SKU-TIMEOUT'])
      ).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });

      await tx.commit();
    } finally {
      await locker.close();
      await waiter.close();
    }
  });

  it('detects cyclic InnoDB deadlocks and surfaces ER_LOCK_DEADLOCK on MariaDB', async () => {
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'ProductA',
      'SKU-DEADLOCK-A',
      10.0,
      true,
      '2026-10-21 12:00:00'
    ]);
    await client.insert('INSERT INTO test_products(title, sku, price, in_stock, created_at) VALUES(?, ?, ?, ?, ?)', [
      'ProductB',
      'SKU-DEADLOCK-B',
      20.0,
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

      // txA locks product A; txB locks product B
      await txA.update('UPDATE test_products SET price = 11 WHERE sku = ?', ['SKU-DEADLOCK-A']);
      await txB.update('UPDATE test_products SET price = 22 WHERE sku = ?', ['SKU-DEADLOCK-B']);

      // txA attempts to lock product B (waiting for txB)
      let txAResolved = false;
      let txAError: unknown;
      const promiseA = txA
        .update('UPDATE test_products SET price = 33 WHERE sku = ?', ['SKU-DEADLOCK-B'])
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

      // txB attempts to lock product A (creates deadlock cycle)
      let txBError: unknown;
      try {
        await txB.update('UPDATE test_products SET price = 44 WHERE sku = ?', ['SKU-DEADLOCK-A']);
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
