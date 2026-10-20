import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { SqlClient, UpgradeManager, type MigrationStep } from '../src';
import type { RowDataPacket } from 'mysql2';

describe('UpgradeManager Testcontainers Integration', () => {
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
    // Clean up any test tables before each test
    await client.execute('DROP TABLE IF EXISTS test_accounts;');
    await client.execute('DROP TABLE IF EXISTS `_version`;');
    await client.execute('DROP TABLE IF EXISTS `_custom_version`;');
  });

  it('runs step-by-step migrations from fresh database to target version', async () => {
    const migrations: MigrationStep[] = [
      {
        version: 1,
        name: 'create_accounts_table',
        up: async db => {
          await db.execute(`
            CREATE TABLE test_accounts (
              id INT AUTO_INCREMENT PRIMARY KEY,
              username VARCHAR(50) NOT NULL
            ) ENGINE=InnoDB CHARACTER SET utf8mb4;
          `);
        }
      },
      {
        version: 2,
        name: 'add_email_column',
        up: async db => {
          await db.execute('ALTER TABLE test_accounts ADD COLUMN email VARCHAR(100) NULL UNIQUE;');
        }
      },
      {
        version: 3,
        name: 'insert_seed_account',
        up: async db => {
          await db.execute("INSERT INTO test_accounts(username, email) VALUES('admin', 'admin@example.com');");
        }
      }
    ];

    const manager = new UpgradeManager(client, { migrations });

    // Initial status
    const initialStatus = await manager.getStatus();
    expect(initialStatus.currentVersion).toBe(0);
    expect(initialStatus.targetVersion).toBe(3);
    expect(initialStatus.isUpToDate).toBe(false);
    expect(initialStatus.pending).toHaveLength(3);

    // Run upgrade
    const result = await manager.upgrade();
    expect(result.previousVersion).toBe(0);
    expect(result.currentVersion).toBe(3);
    expect(result.applied).toHaveLength(3);

    // Verify _version table directly in database
    const versionRow = await client.get<RowDataPacket & { value: number }>('SELECT `value` FROM `_version` LIMIT 1;');
    expect(versionRow?.value).toBe(3);

    // Verify created table and inserted data
    const account = await client.get<RowDataPacket & { username: string; email: string }>(
      'SELECT username, email FROM test_accounts WHERE id = 1;'
    );
    expect(account?.username).toBe('admin');
    expect(account?.email).toBe('admin@example.com');

    // Subsequent run is idempotent
    const secondRun = await manager.upgrade();
    expect(secondRun.applied).toHaveLength(0);
    expect(secondRun.currentVersion).toBe(3);
  });

  it('supports partial upgrades and incremental future migrations', async () => {
    const manager = new UpgradeManager(client, {
      migrations: [
        {
          version: 1,
          name: 'step1',
          up: async db => {
            await db.execute('CREATE TABLE test_accounts (id INT AUTO_INCREMENT PRIMARY KEY);');
          }
        },
        {
          version: 2,
          name: 'step2',
          up: async db => {
            await db.execute('ALTER TABLE test_accounts ADD COLUMN bio TEXT NULL;');
          }
        }
      ]
    });

    // Upgrade only to version 1
    const partialResult = await manager.upgrade(1);
    expect(partialResult.currentVersion).toBe(1);
    expect(partialResult.applied).toHaveLength(1);

    const versionAfterPartial = await manager.getCurrentVersion();
    expect(versionAfterPartial).toBe(1);

    // Later: upgrade to version 2
    const completeResult = await manager.upgrade(2);
    expect(completeResult.previousVersion).toBe(1);
    expect(completeResult.currentVersion).toBe(2);
    expect(completeResult.applied).toHaveLength(1);
    expect(completeResult.applied[0].version).toBe(2);

    expect(await manager.getCurrentVersion()).toBe(2);
  });

  it('supports custom table name', async () => {
    const manager = new UpgradeManager(client, {
      tableName: '_custom_version',
      migrations: [
        {
          version: 1,
          name: 'init',
          up: async db => {
            await db.execute('CREATE TABLE test_accounts (id INT AUTO_INCREMENT PRIMARY KEY);');
          }
        }
      ]
    });

    await manager.upgrade();

    const versionRow = await client.get<RowDataPacket & { value: number }>(
      'SELECT `value` FROM `_custom_version` LIMIT 1;'
    );
    expect(versionRow?.value).toBe(1);
  });

  it('coordinates concurrent instances via advisory lock without race conditions', async () => {
    let migrationRunCount = 0;

    const migrationStep: MigrationStep = {
      version: 1,
      name: 'create_table',
      up: async db => {
        migrationRunCount++;
        // Simulate real DDL work
        await db.execute('CREATE TABLE test_accounts (id INT AUTO_INCREMENT PRIMARY KEY);');
      }
    };

    const clientA = client;
    const clientB = await SqlClient.create({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
      enforceStatementKinds: true
    });

    try {
      const managerA = new UpgradeManager(clientA, { migrations: [migrationStep] });
      const managerB = new UpgradeManager(clientB, { migrations: [migrationStep] });

      // Run both concurrently
      const [resA, resB] = await Promise.all([managerA.upgrade(), managerB.upgrade()]);

      // Exactly one manager applied the migration; the other waited and cleanly saw it up to date
      expect(migrationRunCount).toBe(1);

      const totalApplied = resA.applied.length + resB.applied.length;
      expect(totalApplied).toBe(1);
      expect(resA.currentVersion).toBe(1);
      expect(resB.currentVersion).toBe(1);
    } finally {
      await clientB.close();
    }
  });

  it('handles partial DDL failure, enters failed state, and recovers via resetFailedState', async () => {
    const manager = new UpgradeManager(client, {
      migrations: [
        {
          version: 1,
          name: 'step1_create_accounts',
          up: async db => {
            await db.execute('CREATE TABLE test_accounts (id INT AUTO_INCREMENT PRIMARY KEY);');
          }
        },
        {
          version: 2,
          name: 'step2_broken_migration',
          up: async db => {
            await db.execute('ALTER TABLE test_accounts ADD COLUMN bio TEXT NULL;');
            // Invalid SQL to trigger partial DDL failure
            await db.execute('THIS IS INVALID SQL STATEMENT AND WILL FAIL;');
          }
        }
      ]
    });

    // Step 2 fails halfway
    await expect(manager.upgrade()).rejects.toThrow();

    // Verify database state: version remains at 1, status is 'failed'
    const status = await manager.getStatus();
    expect(status.currentVersion).toBe(1);
    expect(status.status).toBe('failed');
    expect(status.inProgressVersion).toBe(2);
    expect(status.lastError).toContain('INVALID SQL');

    // Calling upgrade again without manual reset is blocked
    await expect(manager.upgrade()).rejects.toThrow('Database is in a FAILED migration state at version 2');

    // Manually clean up partial DDL change and reset state
    await client.execute('ALTER TABLE test_accounts DROP COLUMN bio;');
    await manager.resetFailedState(1);

    const recoveredStatus = await manager.getStatus();
    expect(recoveredStatus.status).toBe('idle');
    expect(recoveredStatus.currentVersion).toBe(1);
  });

  it('supports rollback and downgrade in live MySQL', async () => {
    const manager = new UpgradeManager(client, {
      migrations: [
        {
          version: 1,
          name: 'step1_create_table',
          up: async db => {
            await db.execute('CREATE TABLE test_accounts (id INT PRIMARY KEY);');
          },
          down: async db => {
            await db.execute('DROP TABLE IF EXISTS test_accounts;');
          }
        },
        {
          version: 2,
          name: 'step2_add_email',
          up: async db => {
            await db.execute('ALTER TABLE test_accounts ADD COLUMN email VARCHAR(100) NULL;');
          },
          down: async db => {
            await db.execute('ALTER TABLE test_accounts DROP COLUMN email;');
          }
        }
      ]
    });

    // Upgrade to version 2
    await manager.upgrade();
    expect(await manager.getCurrentVersion()).toBe(2);

    // Rollback 1 step (to version 1)
    const rollbackResult = await manager.rollback();
    expect(rollbackResult.previousVersion).toBe(2);
    expect(rollbackResult.currentVersion).toBe(1);
    expect(rollbackResult.applied).toHaveLength(1);
    expect(rollbackResult.applied[0].direction).toBe('down');
    expect(await manager.getCurrentVersion()).toBe(1);

    // Downgrade to 0
    const downgradeResult = await manager.downgrade(0);
    expect(downgradeResult.previousVersion).toBe(1);
    expect(downgradeResult.currentVersion).toBe(0);
    expect(downgradeResult.applied).toHaveLength(1);
    expect(await manager.getCurrentVersion()).toBe(0);
  });

  it('enforces single-row check constraint in _version table', async () => {
    const manager = new UpgradeManager(client);
    await manager.getCurrentVersion(); // Initializes _version table

    // Attempting to insert a row where id != 1 violates CHECK (id = 1)
    await expect(
      client.execute('INSERT INTO `_version` (`id`, `value`, `status`) VALUES (2, 99, "idle");')
    ).rejects.toThrow();
  });

  it('handles lock-acquisition timeout between concurrent clients in live database', async () => {
    const clientB = await SqlClient.create({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase()
    });

    try {
      let clientAHoldingLock = false;
      const clientAPromise = client.withAdvisoryLock('test_tc_timeout_lock', 10, async () => {
        clientAHoldingLock = true;
        await new Promise(resolve => setTimeout(resolve, 1500));
        return 'clientA_done';
      });

      // Wait until Client A holds the lock
      while (!clientAHoldingLock) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Client B attempts to acquire with 1 second timeout
      await expect(clientB.withAdvisoryLock('test_tc_timeout_lock', 1, async () => 'clientB_done')).rejects.toThrow(
        /Failed to acquire advisory lock "test_tc_timeout_lock" within 1s/
      );

      // Client A finishes successfully
      await expect(clientAPromise).resolves.toBe('clientA_done');

      // Now Client B can acquire the lock cleanly
      await expect(clientB.withAdvisoryLock('test_tc_timeout_lock', 5, async () => 'clientB_success')).resolves.toBe(
        'clientB_success'
      );
    } finally {
      await clientB.close();
    }
  });

  it('guarantees lock release in live MySQL even when callback throws an error', async () => {
    const lockName = 'test_tc_error_release_lock';

    await expect(
      client.withAdvisoryLock(lockName, 5, async () => {
        throw new Error('Intentional callback error');
      })
    ).rejects.toThrow('Intentional callback error');

    // Verify lock is immediately available for subsequent operations
    const acquired = await client.withAdvisoryLock(lockName, 5, async () => 'acquired_after_error');
    expect(acquired).toBe('acquired_after_error');
  });

  it('works with pooled SqlClient connection lifecycle under high concurrent advisory lock demand', async () => {
    const poolClient = SqlClient.createPool({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
      connectionLimit: 5
    });

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          poolClient.withAdvisoryLock(`test_tc_pool_lock_${i}`, 10, async locked => {
            const row = await locked.get<RowDataPacket & { num: number }>('SELECT ? AS num', [i]);
            return row?.num;
          })
        )
      );

      expect(results).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await poolClient.close();
    }
  });

  it('bootstraps fresh database directly to latest version without running historical migrations', async () => {
    let step1Called = false;
    let step2Called = false;

    const manager = new UpgradeManager(client, {
      migrations: [
        {
          version: 1,
          name: 'step1_add_accounts',
          up: async () => {
            step1Called = true;
          }
        },
        {
          version: 2,
          name: 'step2_add_profiles',
          up: async () => {
            step2Called = true;
          }
        }
      ],
      schemaInit: {
        version: 2,
        create: async db => {
          await db.execute(`
            CREATE TABLE test_accounts (
              id INT AUTO_INCREMENT PRIMARY KEY,
              email VARCHAR(255) NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB;
          `);
        }
      }
    });

    expect(await manager.isFreshDatabase()).toBe(true);

    const result = await manager.bootstrap();
    expect(result.previousVersion).toBe(0);
    expect(result.currentVersion).toBe(2);
    expect(step1Called).toBe(false);
    expect(step2Called).toBe(false);

    // Verify database status is up to date at version 2
    const status = await manager.getStatus();
    expect(status.currentVersion).toBe(2);
    expect(status.isUpToDate).toBe(true);
    expect(status.status).toBe('idle');

    // Verify table test_accounts was created
    const rows = await client.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = "test_accounts"'
    );
    expect(rows.rows).toHaveLength(1);

    // Attempting to bootstrap again on already initialized database fails
    await expect(manager.bootstrap()).rejects.toThrow(/Cannot bootstrap database/);
  });

  it('rejects bootstrap if application tables already exist in the database', async () => {
    // Pre-create an application table
    await client.execute('CREATE TABLE test_accounts (id INT PRIMARY KEY);');

    const manager = new UpgradeManager(client, {
      schemaInit: {
        version: 1,
        create: async () => {}
      }
    });

    expect(await manager.isFreshDatabase()).toBe(false);
    await expect(manager.bootstrap()).rejects.toThrow(
      /Cannot bootstrap database: database already contains existing application tables/
    );
  });

  it('setup() automatically bootstraps fresh database and subsequently applies new migrations', async () => {
    let bootstrapRun = false;
    let v2Run = false;

    const manager = new UpgradeManager(client, {
      schemaInit: {
        version: 1,
        create: async db => {
          bootstrapRun = true;
          await db.execute('CREATE TABLE test_accounts (id INT PRIMARY KEY);');
        }
      },
      migrations: [
        {
          version: 2,
          name: 'add_role',
          up: async db => {
            v2Run = true;
            await db.execute('ALTER TABLE test_accounts ADD COLUMN role VARCHAR(50) DEFAULT "user";');
          }
        }
      ]
    });

    // 1. First setup run on fresh database -> bootstraps to version 1
    const res1 = await manager.setup(1);
    expect(bootstrapRun).toBe(true);
    expect(v2Run).toBe(false);
    expect(res1.currentVersion).toBe(1);

    // 2. Second setup run -> upgrades to version 2
    const res2 = await manager.setup(2);
    expect(v2Run).toBe(true);
    expect(res2.currentVersion).toBe(2);
    expect(await manager.getCurrentVersion()).toBe(2);
  });

  it('concurrent setup() calls across multiple instances on a fresh database succeed without startup failures', async () => {
    let bootstrapRunCount = 0;

    const manager1 = new UpgradeManager(client, {
      tableName: '_version_concurrent',
      schemaInit: {
        version: 1,
        create: async db => {
          bootstrapRunCount++;
          await db.execute('CREATE TABLE IF NOT EXISTS test_concurrent_startup (id INT PRIMARY KEY);');
        }
      }
    });

    const manager2 = new UpgradeManager(client, {
      tableName: '_version_concurrent',
      schemaInit: {
        version: 1,
        create: async db => {
          bootstrapRunCount++;
          await db.execute('CREATE TABLE IF NOT EXISTS test_concurrent_startup (id INT PRIMARY KEY);');
        }
      }
    });

    // Run both simultaneously
    const [res1, res2] = await Promise.all([manager1.setup(), manager2.setup()]);

    expect(bootstrapRunCount).toBe(1);
    expect(res1.currentVersion).toBe(1);
    expect(res2.currentVersion).toBe(1);

    // One applied the bootstrap, the other observed it was already up to date
    const totalApplied = res1.applied.length + res2.applied.length;
    expect(totalApplied).toBe(1);
  });
});
