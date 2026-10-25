import type { FieldPacket, QueryOptions, QueryResult, ResultSetHeader, RowDataPacket } from 'mysql2';
import { createConnection, type Connection } from 'mysql2/promise';
import { SqlClient, UpgradeManager, type MigrationStatus, type MigrationStep, type UpgradeLogger } from '../src';

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

describe('UpgradeManager Unit Tests', () => {
  let primaryConnection: MockConnection;
  let client: SqlClient;
  let currentDbVersion: number;
  let currentDbStatus: MigrationStatus;
  let currentInProgressVersion: number | null;
  let currentLastError: string | null;
  let existingUserTables: string[];
  let tableExists: boolean;

  beforeEach(async () => {
    jest.clearAllMocks();
    currentDbVersion = 0;
    currentDbStatus = 'idle';
    currentInProgressVersion = null;
    currentLastError = null;
    existingUserTables = [];
    tableExists = true;
    primaryConnection = createMockConnection();

    // Default query behavior
    primaryConnection.query.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
      const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;

      if (sql.includes('GET_LOCK')) {
        return [[{ lockAcquired: 1 }] as RowDataPacket[], [] as FieldPacket[]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        return [[{ released: 1, releaseLock: 1 }] as RowDataPacket[], [] as FieldPacket[]];
      }
      if (sql.includes('information_schema.tables')) {
        return [existingUserTables.map(t => ({ tableName: t }) as unknown as RowDataPacket), [] as FieldPacket[]];
      }
      if (sql.includes('SELECT') && (sql.includes('`value`') || sql.includes('`id`'))) {
        if (!tableExists) {
          const err = Object.assign(new Error("Table '_version' doesn't exist"), {
            code: 'ER_NO_SUCH_TABLE',
            errno: 1146
          });
          throw err;
        }
        return [
          [
            {
              id: 1,
              value: currentDbVersion,
              status: currentDbStatus,
              in_progress_version: currentInProgressVersion,
              last_error: currentLastError
            }
          ] as RowDataPacket[],
          [] as FieldPacket[]
        ];
      }

      return [[] as RowDataPacket[], [] as FieldPacket[]];
    });

    // Default execute behavior
    primaryConnection.execute.mockImplementation(async (sqlOrOptions: string | QueryOptions, params?: unknown) => {
      const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
      if (sql.includes('CREATE TABLE')) {
        tableExists = true;
      }
      if (sql.includes('UPDATE')) {
        if (sql.includes("`status` = 'migrating'") && Array.isArray(params)) {
          currentDbStatus = 'migrating';
          currentInProgressVersion = typeof params[0] === 'number' ? params[0] : null;
        } else if (sql.includes("`status` = 'failed'") && Array.isArray(params)) {
          currentDbStatus = 'failed';
          currentLastError = typeof params[0] === 'string' ? params[0] : null;
        } else if (sql.includes("`status` = 'idle'")) {
          currentDbStatus = 'idle';
          currentInProgressVersion = null;
          currentLastError = null;
          if (Array.isArray(params)) {
            if (typeof params[0] === 'number') {
              currentDbVersion = params[0];
            } else if (typeof params[0] === 'string') {
              currentLastError = params[0];
            }
          }
        }
      }
      const header = {
        affectedRows: 1,
        changedRows: 0,
        insertId: 0,
        warningStatus: 0,
        fieldCount: 0,
        info: '',
        serverStatus: 2
      } as unknown as ResultSetHeader;
      return [header, [] as FieldPacket[]] as [QueryResult, FieldPacket[]];
    });

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

  describe('Constructor & Lock Name Generation', () => {
    it('initializes with default _version table', () => {
      const manager = new UpgradeManager(client);
      expect(manager.getTableName()).toBe('_version');
      expect(manager.getLockName()).toBe('catbee_upg__version');
      expect(manager.getVersionTablePrefix()).toBe('_version');
      expect(manager.getVersionTableSuffix()).toBeUndefined();
    });

    it('accepts a custom versionTablePrefix', () => {
      const manager = new UpgradeManager(client, { versionTablePrefix: 'app_version' });
      expect(manager.getTableName()).toBe('app_version');
      expect(manager.getLockName()).toBe('catbee_upg_app_version');
      expect(manager.getVersionTablePrefix()).toBe('app_version');
      expect(manager.getVersionTableSuffix()).toBeUndefined();
    });

    it('accepts a custom versionTableSuffix with default prefix', () => {
      const manager = new UpgradeManager(client, { versionTableSuffix: 'auth' });
      expect(manager.getTableName()).toBe('_version_auth');
      expect(manager.getLockName()).toBe('catbee_upg__version_auth');
      expect(manager.getVersionTablePrefix()).toBe('_version');
      expect(manager.getVersionTableSuffix()).toBe('auth');
    });

    it('trims leading underscores from versionTableSuffix', () => {
      const manager = new UpgradeManager(client, { versionTableSuffix: '_billing' });
      expect(manager.getTableName()).toBe('_version_billing');
      expect(manager.getLockName()).toBe('catbee_upg__version_billing');
      expect(manager.getVersionTablePrefix()).toBe('_version');
    });

    it('combines custom versionTablePrefix and versionTableSuffix', () => {
      const manager = new UpgradeManager(client, {
        versionTablePrefix: 'custom_migrations',
        versionTableSuffix: 'users'
      });
      expect(manager.getTableName()).toBe('custom_migrations_users');
      expect(manager.getLockName()).toBe('catbee_upg_custom_migrations_users');
      expect(manager.getVersionTablePrefix()).toBe('custom_migrations');
      expect(manager.getVersionTableSuffix()).toBe('users');
    });

    it('accepts tableName for backwards compatibility and overrides prefix and suffix', () => {
      const manager = new UpgradeManager(client, { tableName: 'app_schema_version' });
      expect(manager.getTableName()).toBe('app_schema_version');
      expect(manager.getLockName()).toBe('catbee_upg_app_schema_version');

      const managerOverride = new UpgradeManager(client, {
        tableName: 'override_version',
        versionTablePrefix: 'ignored_prefix',
        versionTableSuffix: 'ignored_suffix'
      });
      expect(managerOverride.getTableName()).toBe('override_version');
    });

    it('rejects invalid table names with special characters or spaces', () => {
      expect(() => new UpgradeManager(client, { tableName: 'bad table; drop' })).toThrow(TypeError);
      expect(() => new UpgradeManager(client, { tableName: 'bad-table' })).toThrow(TypeError);
      expect(() => new UpgradeManager(client, { versionTablePrefix: 'bad prefix!' })).toThrow(TypeError);
      expect(() => new UpgradeManager(client, { versionTableSuffix: 'bad suffix;' })).toThrow(TypeError);
      expect(() => new UpgradeManager(client, { versionTablePrefix: '' })).toThrow(TypeError);
    });

    it('hashes long table names to ensure lock name is <= 64 characters and unique', () => {
      const longNameA = 'app_billing_subscriptions_and_invoices_partition_schema_shard_alpha_01';
      const longNameB = 'app_billing_subscriptions_and_invoices_partition_schema_shard_alpha_02';

      const managerA = new UpgradeManager(client, { versionTablePrefix: longNameA });
      const managerB = new UpgradeManager(client, { versionTablePrefix: longNameB });

      expect(managerA.getLockName().length).toBeLessThanOrEqual(64);
      expect(managerB.getLockName().length).toBeLessThanOrEqual(64);
      // Ensure different long table names do not collide
      expect(managerA.getLockName()).not.toBe(managerB.getLockName());
    });

    it('pre-registers migrations passed in options', () => {
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, up: jest.fn() }
        ]
      });

      expect(manager.getRegisteredMigrations().map(m => m.version)).toEqual([1, 2]);
    });

    it('rejects non-integer, zero, or negative migration versions', () => {
      const manager = new UpgradeManager(client);
      expect(() => manager.addMigration({ version: 0, up: jest.fn() })).toThrow(TypeError);
      expect(() => manager.addMigration({ version: -1, up: jest.fn() })).toThrow(TypeError);
      expect(() => manager.addMigration({ version: 1.5, up: jest.fn() })).toThrow(TypeError);
    });

    it('rejects migrations with missing up functions', () => {
      const manager = new UpgradeManager(client);
      expect(() => manager.addMigration({ version: 1 } as unknown as MigrationStep)).toThrow(TypeError);
    });

    it('rejects duplicate migration versions', () => {
      const manager = new UpgradeManager(client);
      manager.addMigration({ version: 1, up: jest.fn() });
      expect(() => manager.addMigration({ version: 1, up: jest.fn() })).toThrow(Error);
    });

    it('sorts registered migrations ascending by version regardless of insertion order', () => {
      const manager = new UpgradeManager(client);
      manager.addMigration({ version: 3, up: jest.fn() });
      manager.addMigration({ version: 1, up: jest.fn() });
      manager.addMigration({ version: 2, up: jest.fn() });

      expect(manager.getRegisteredMigrations().map(m => m.version)).toEqual([1, 2, 3]);
    });
  });

  describe('Current Version & Status', () => {
    it('reads current version from database under advisory lock', async () => {
      currentDbVersion = 5;
      const manager = new UpgradeManager(client);

      const version = await manager.getCurrentVersion();
      expect(version).toBe(5);
    });

    it('retrieves status with pending migrations list and idle status', async () => {
      currentDbVersion = 1;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, name: 'init', up: jest.fn() },
          { version: 2, name: 'add_col', up: jest.fn() },
          { version: 3, name: 'add_table', up: jest.fn() }
        ]
      });

      const status = await manager.getStatus();
      expect(status.currentVersion).toBe(1);
      expect(status.targetVersion).toBe(3);
      expect(status.isUpToDate).toBe(false);
      expect(status.status).toBe('idle');
      expect(status.pending).toEqual([
        { version: 2, name: 'add_col' },
        { version: 3, name: 'add_table' }
      ]);
    });

    it('returns isUpToDate = true when current version equals target version', async () => {
      currentDbVersion = 2;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, up: jest.fn() }
        ]
      });

      const status = await manager.getStatus();
      expect(status.isUpToDate).toBe(true);
      expect(status.pending).toHaveLength(0);
    });

    it('retrieves live status showing migrating state and inProgressVersion while migration is active', async () => {
      currentDbVersion = 1;
      currentDbStatus = 'migrating';
      currentInProgressVersion = 2;

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, up: jest.fn() }
        ]
      });

      const status = await manager.getStatus();
      expect(status.currentVersion).toBe(1);
      expect(status.status).toBe('migrating');
      expect(status.inProgressVersion).toBe(2);
      expect(status.isUpToDate).toBe(false);
    });

    it('returns default version 0 and idle status when version table does not exist', async () => {
      tableExists = false;
      const manager = new UpgradeManager(client);

      const version = await manager.getCurrentVersion();
      expect(version).toBe(0);

      const status = await manager.getStatus();
      expect(status.currentVersion).toBe(0);
      expect(status.status).toBe('idle');
      expect(status.inProgressVersion).toBeNull();
    });

    it('returns targetVersion 0 when no migrations and no schemaInit are registered', async () => {
      const manager = new UpgradeManager(client);
      const status = await manager.getStatus();
      expect(status.targetVersion).toBe(0);
      expect(status.isUpToDate).toBe(true);
    });

    it('uses schemaInit.version as targetVersion in getStatus when greater than migrations', async () => {
      const manager = new UpgradeManager(client, {
        schemaInit: { version: 5, create: jest.fn() },
        migrations: [{ version: 1, up: jest.fn() }]
      });
      const status = await manager.getStatus();
      expect(status.targetVersion).toBe(5);
    });
  });

  describe('Migration Gap & Target Validation', () => {
    it('throws error when next migration does not immediately follow current version', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client, {
        migrations: [{ version: 2, up: jest.fn() }] // version 1 missing!
      });

      await expect(manager.upgrade()).rejects.toThrow(
        'Migration gap detected: database is currently at version 0, but the next available migration is 2. Missing migration version 1.'
      );
    });

    it('throws error when intermediate migration is missing', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 3, up: jest.fn() } // version 2 missing!
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow(
        'Migration gap detected: migration version 2 is missing between version 1 and 3.'
      );
    });

    it('throws error when registered migrations do not reach the requested target version', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, up: jest.fn() }
        ]
      });

      await expect(manager.upgrade(3)).rejects.toThrow(
        'Target version mismatch: requested target version is 3, but registered migrations only reach version 2. Missing migration version 3.'
      );
    });

    it('throws error when no migrations exist to reach target version', async () => {
      currentDbVersion = 1;
      const manager = new UpgradeManager(client);

      await expect(manager.upgrade(2)).rejects.toThrow(
        'No registered migrations found to upgrade from version 1 to target version 2.'
      );
    });

    it('returns cleanly when database version equals target and no migrations exist', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client);
      const result = await manager.upgrade(0);
      expect(result.applied).toEqual([]);
      expect(result.currentVersion).toBe(0);
    });
  });

  describe('Upgrade Execution', () => {
    it('applies all pending migrations in ascending order from version 0', async () => {
      const executionOrder: number[] = [];
      const manager = new UpgradeManager(client, {
        migrations: [
          {
            version: 2,
            name: 'step_2',
            up: async () => {
              executionOrder.push(2);
            }
          },
          {
            version: 1,
            name: 'step_1',
            up: async () => {
              executionOrder.push(1);
            }
          }
        ]
      });

      const result = await manager.upgrade();

      expect(executionOrder).toEqual([1, 2]);
      expect(result.previousVersion).toBe(0);
      expect(result.currentVersion).toBe(2);
      expect(result.applied).toHaveLength(2);
      expect(result.applied[0].version).toBe(1);
      expect(result.applied[0].direction).toBe('up');
      expect(result.applied[1].version).toBe(2);
      expect(result.applied[1].direction).toBe('up');
      expect(currentDbVersion).toBe(2);
      expect(currentDbStatus).toBe('idle');
    });

    it('applies partial upgrade up to a specified targetVersion', async () => {
      const step1 = jest.fn().mockResolvedValue(undefined);
      const step2 = jest.fn().mockResolvedValue(undefined);
      const step3 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: step1 },
          { version: 2, up: step2 },
          { version: 3, up: step3 }
        ]
      });

      const result = await manager.upgrade(2);

      expect(step1).toHaveBeenCalledTimes(1);
      expect(step2).toHaveBeenCalledTimes(1);
      expect(step3).not.toHaveBeenCalled();
      expect(result.currentVersion).toBe(2);
      expect(currentDbVersion).toBe(2);
    });

    it('returns empty applied list and does not execute migrations if already up to date', async () => {
      currentDbVersion = 2;
      const step = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: step },
          { version: 2, up: step }
        ]
      });

      const result = await manager.upgrade();

      expect(step).not.toHaveBeenCalled();
      expect(result.previousVersion).toBe(2);
      expect(result.currentVersion).toBe(2);
      expect(result.applied).toEqual([]);
    });

    it('rejects invalid target versions', async () => {
      const manager = new UpgradeManager(client);
      await expect(manager.upgrade(-1)).rejects.toThrow(TypeError);
      await expect(manager.upgrade(1.5)).rejects.toThrow(TypeError);
    });

    it('rejects downgrade in upgrade() when database version is newer than target version', async () => {
      currentDbVersion = 5;
      const manager = new UpgradeManager(client, {
        migrations: [{ version: 2, up: jest.fn() }]
      });

      await expect(manager.upgrade(3)).rejects.toThrow(
        'Database version (5) is newer than target version (3). Downgrades are not supported in upgrade(); use downgrade() instead.'
      );
    });

    it('throws when advisory lock cannot be acquired within timeout', async () => {
      primaryConnection.query.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
        const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
        if (sql.includes('GET_LOCK')) {
          return [[{ lockAcquired: 0 }] as RowDataPacket[], [] as FieldPacket[]];
        }
        return [[] as RowDataPacket[], [] as FieldPacket[]];
      });

      const manager = new UpgradeManager(client, {
        lockTimeoutSeconds: 5,
        migrations: [{ version: 1, up: jest.fn() }]
      });

      await expect(manager.upgrade()).rejects.toThrow('Failed to acquire advisory lock');
    });

    it('calls custom logger with migration progress', async () => {
      const logger: UpgradeLogger = {
        info: jest.fn(),
        debug: jest.fn()
      };

      const manager = new UpgradeManager(client, {
        logger,
        migrations: [{ version: 1, name: 'init_schema', up: jest.fn() }]
      });

      await manager.upgrade();

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Applying migration step 1 ("init_schema")'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully applied migration step 1'));
    });

    it('supports non-Error thrown from up() when autoRollbackOnFailure is false', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client, {
        migrations: [
          {
            version: 1,
            up: jest.fn().mockRejectedValue('String DDL failure')
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toBe('String DDL failure');
      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toBe('String DDL failure');
    });

    it('handles database error during failure status update gracefully', async () => {
      const logger: UpgradeLogger = { error: jest.fn() };
      let failNextExecute = false;

      primaryConnection.execute.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
        const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
        if (failNextExecute && sql.includes("`status` = 'failed'")) {
          throw new Error('Connection lost while saving failure status');
        }
        return [{ affectedRows: 1 } as unknown as ResultSetHeader, [] as FieldPacket[]];
      });

      const manager = new UpgradeManager(client, {
        logger,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockImplementation(async () => {
              failNextExecute = true;
              throw new Error('Primary migration failure');
            })
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Primary migration failure');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update failure status in version table')
      );
    });

    it('reports unknown for in_progress_version and none for last_error when null in failed state', async () => {
      currentDbVersion = 1;
      currentDbStatus = 'failed';
      currentInProgressVersion = null;
      currentLastError = null;

      const manager = new UpgradeManager(client, {
        migrations: [{ version: 2, up: jest.fn() }]
      });

      await expect(manager.upgrade()).rejects.toThrow(
        'Database is in a FAILED migration state at version unknown. Last error: "none". Manual inspection is required before running further migrations. Once resolved, call resetFailedState().'
      );
    });

    it('reports unknown for in_progress_version when null in migrating state', async () => {
      currentDbVersion = 1;
      currentDbStatus = 'migrating';
      currentInProgressVersion = null;

      const manager = new UpgradeManager(client, {
        migrations: [{ version: 2, up: jest.fn() }]
      });

      await expect(manager.upgrade()).rejects.toThrow(
        'Database is in an incomplete MIGRATING state at version unknown. A previous process may have terminated unexpectedly mid-migration. Inspect database schema and call resetFailedState().'
      );
    });
  });

  describe('Partial DDL Failure, State Tracking & Remediation', () => {
    it('records failed state when up() throws and preserves last successful version', async () => {
      currentDbVersion = 0;
      const step1 = jest.fn().mockResolvedValue(undefined);
      const step2 = jest.fn().mockRejectedValue(new Error('Syntax error in migration 2'));
      const step3 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: step1 },
          { version: 2, up: step2 },
          { version: 3, up: step3 }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Syntax error in migration 2');

      expect(step1).toHaveBeenCalledTimes(1);
      expect(step2).toHaveBeenCalledTimes(1);
      expect(step3).not.toHaveBeenCalled();
      expect(currentDbVersion).toBe(1);
      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toBe('Syntax error in migration 2');
    });

    it('blocks subsequent upgrade runs when database is in a failed state', async () => {
      currentDbVersion = 1;
      currentDbStatus = 'failed';
      currentInProgressVersion = 2;
      currentLastError = 'Table accounts already exists';

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, up: jest.fn() }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow(
        'Database is in a FAILED migration state at version 2. Last error: "Table accounts already exists". Manual inspection is required before running further migrations. Once resolved, call resetFailedState().'
      );
    });

    it('blocks subsequent upgrade runs when database is in a migrating state from a crashed process', async () => {
      currentDbVersion = 1;
      currentDbStatus = 'migrating';
      currentInProgressVersion = 2;

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, up: jest.fn() }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Database is in an incomplete MIGRATING state at version 2');
    });

    it('allows clearing failed state via resetFailedState and updating version', async () => {
      currentDbVersion = 1;
      currentDbStatus = 'failed';
      currentInProgressVersion = 2;
      currentLastError = 'Some error';

      const manager = new UpgradeManager(client);
      await manager.resetFailedState(2);

      expect(currentDbStatus).toBe('idle');
      expect(currentDbVersion).toBe(2);
      expect(currentLastError).toBeNull();
    });

    it('attempts automated rollback if autoRollbackOnFailure is true and down function exists', async () => {
      currentDbVersion = 0;
      const downMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockRejectedValue(new Error('DDL failed midway')),
            down: downMock
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('DDL failed midway');
      expect(downMock).toHaveBeenCalledTimes(1);
      expect(currentDbStatus).toBe('idle');
    });

    it('attaches rollbackError to cause when autoRollbackOnFailure rollback also fails', async () => {
      currentDbVersion = 0;
      const upErr = new Error('Step up failed');
      const downErr = new Error('Step down rollback also failed');

      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockRejectedValue(upErr),
            down: jest.fn().mockRejectedValue(downErr)
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Step up failed');
      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toContain('Step up failed. Rollback also failed: Step down rollback also failed');
      expect((upErr as Error & { rollbackError?: unknown }).rollbackError).toBe(downErr);
      expect((upErr as Error & { cause?: unknown }).cause).toBe(downErr);
    });

    it('allows clearing failed state via resetFailedState() without arguments, preserving current version', async () => {
      currentDbVersion = 3;
      currentDbStatus = 'failed';
      currentInProgressVersion = 4;
      currentLastError = 'Some error';

      const manager = new UpgradeManager(client);
      await manager.resetFailedState();

      expect(currentDbStatus).toBe('idle');
      expect(currentDbVersion).toBe(3);
      expect(currentInProgressVersion).toBeNull();
      expect(currentLastError).toBeNull();
    });

    it('rejects invalid newVersion in resetFailedState', async () => {
      const manager = new UpgradeManager(client);
      await expect(manager.resetFailedState(-1)).rejects.toThrow(TypeError);
      await expect(manager.resetFailedState(2.5)).rejects.toThrow(TypeError);
    });

    it('resets status to idle with last_error notice when autoRollbackOnFailure rollback succeeds', async () => {
      currentDbVersion = 0;
      const downMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockRejectedValue(new Error('Syntax error on table create')),
            down: downMock
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Syntax error on table create');
      expect(downMock).toHaveBeenCalledTimes(1);
      expect(currentDbStatus).toBe('idle');
      expect(currentLastError).toContain('Rollback succeeded after failure in step 1: Syntax error on table create');
    });

    it('handles database error when updating status after successful auto-rollback', async () => {
      const logger: UpgradeLogger = { error: jest.fn() };
      let failNextExecute = false;

      primaryConnection.execute.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
        const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
        if (failNextExecute && sql.includes("`status` = 'idle'")) {
          throw new Error('Connection lost updating status after rollback');
        }
        return [{ affectedRows: 1 } as unknown as ResultSetHeader, [] as FieldPacket[]];
      });

      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        logger,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockImplementation(async () => {
              failNextExecute = true;
              throw new Error('Step 1 failed');
            }),
            down: jest.fn().mockResolvedValue(undefined)
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Step 1 failed');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update status after successful rollback')
      );
    });

    it('handles database error when updating status after failed auto-rollback', async () => {
      const logger: UpgradeLogger = { error: jest.fn() };
      let failNextExecute = false;

      primaryConnection.execute.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
        const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
        if (failNextExecute && sql.includes("`status` = 'failed'")) {
          throw new Error('Connection lost updating status after failed rollback');
        }
        return [{ affectedRows: 1 } as unknown as ResultSetHeader, [] as FieldPacket[]];
      });

      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        logger,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockImplementation(async () => {
              failNextExecute = true;
              throw new Error('Up failed');
            }),
            down: jest.fn().mockRejectedValue(new Error('Down also failed'))
          }
        ]
      });

      await expect(manager.upgrade()).rejects.toThrow('Up failed');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update failure status in version table')
      );
    });

    it('wraps non-Error in Error with cause and rollbackError when both up() and down() fail', async () => {
      currentDbVersion = 0;
      const downErr = new Error('Step down also failed');

      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockRejectedValue('Raw string up failure'),
            down: jest.fn().mockRejectedValue(downErr)
          }
        ]
      });

      let thrownError: unknown;
      try {
        await manager.upgrade();
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(Error);
      const error = thrownError as Error & { cause?: unknown; rollbackError?: unknown };
      expect(error.message).toContain('Migration step 1 failed (Raw string up failure) and rollback also failed');
      expect(error.cause).toBe('Raw string up failure');
      expect(error.rollbackError).toBe(downErr);
    });

    it('wraps non-Error in Error when up throws non-Error and down also throws non-Error string', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client, {
        autoRollbackOnFailure: true,
        migrations: [
          {
            version: 1,
            up: jest.fn().mockRejectedValue('Raw string up failure'),
            down: jest.fn().mockRejectedValue('Raw string down failure')
          }
        ]
      });

      let thrownError: unknown;
      try {
        await manager.upgrade();
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(Error);
      const error = thrownError as Error & { cause?: unknown; rollbackError?: unknown };
      expect(error.message).toContain(
        'Migration step 1 failed (Raw string up failure) and rollback also failed (Raw string down failure)'
      );
      expect(error.cause).toBe('Raw string up failure');
      expect(error.rollbackError).toBe('Raw string down failure');
    });
  });

  describe('Downgrade & Rollback Execution', () => {
    it('executes down functions in reverse order down to targetVersion', async () => {
      currentDbVersion = 3;
      const down3 = jest.fn().mockResolvedValue(undefined);
      const down2 = jest.fn().mockResolvedValue(undefined);
      const down1 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: down1 },
          { version: 2, up: jest.fn(), down: down2 },
          { version: 3, up: jest.fn(), down: down3 }
        ]
      });

      const result = await manager.downgrade(1);

      expect(down3).toHaveBeenCalledTimes(1);
      expect(down2).toHaveBeenCalledTimes(1);
      expect(down1).not.toHaveBeenCalled();
      expect(result.previousVersion).toBe(3);
      expect(result.currentVersion).toBe(1);
      expect(result.applied).toHaveLength(2);
      expect(result.applied[0].version).toBe(3);
      expect(result.applied[0].direction).toBe('down');
      expect(result.applied[1].version).toBe(2);
      expect(result.applied[1].direction).toBe('down');
      expect(currentDbVersion).toBe(1);
    });

    it('rolls back single version using rollback() helper', async () => {
      currentDbVersion = 2;
      const down2 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 2, up: jest.fn(), down: down2 }
        ]
      });

      const result = await manager.rollback();

      expect(down2).toHaveBeenCalledTimes(1);
      expect(result.currentVersion).toBe(1);
      expect(currentDbVersion).toBe(1);
    });

    it('throws error if a migration in downgrade chain does not provide a down function', async () => {
      currentDbVersion = 2;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 2, name: 'irreversible_migration', up: jest.fn() } // no down!
        ]
      });

      await expect(manager.downgrade(1)).rejects.toThrow(
        "Cannot downgrade: migration step 2 (irreversible_migration) does not provide a 'down' function."
      );
    });

    it('rejects downgrade when targetVersion is >= currentVersion', async () => {
      currentDbVersion = 2;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 2, up: jest.fn(), down: jest.fn() }
        ]
      });

      await expect(manager.downgrade(2)).rejects.toThrow(
        'Database version (2) is already less than or equal to target version (2).'
      );
    });

    it('rejects rollback when database is already at version 0', async () => {
      currentDbVersion = 0;
      const manager = new UpgradeManager(client);
      await expect(manager.rollback()).rejects.toThrow('Cannot rollback: database is already at version 0.');
    });

    it('rejects invalid target versions in downgrade', async () => {
      const manager = new UpgradeManager(client);
      await expect(manager.downgrade(-1)).rejects.toThrow(TypeError);
      await expect(manager.downgrade(1.5)).rejects.toThrow(TypeError);
    });

    it('blocks downgrade when database is in a failed state', async () => {
      currentDbVersion = 2;
      currentDbStatus = 'failed';
      currentInProgressVersion = 2;
      currentLastError = 'Migration crashed';

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 2, up: jest.fn(), down: jest.fn() }
        ]
      });

      await expect(manager.downgrade(1)).rejects.toThrow(
        'Database is in a FAILED migration state at version 2. Last error: "Migration crashed". Call resetFailedState() before attempting downgrade.'
      );
    });

    it('blocks downgrade when database is in a migrating state', async () => {
      currentDbVersion = 2;
      currentDbStatus = 'migrating';
      currentInProgressVersion = 2;

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 2, up: jest.fn(), down: jest.fn() }
        ]
      });

      await expect(manager.downgrade(1)).rejects.toThrow(
        'Database is in an incomplete MIGRATING state at version 2. Inspect database schema and call resetFailedState().'
      );
    });

    it('throws error when no migrations exist to roll back to targetVersion', async () => {
      currentDbVersion = 2;
      const manager = new UpgradeManager(client);

      await expect(manager.downgrade(0)).rejects.toThrow(
        'No registered migrations found to roll back from version 2 to target version 0.'
      );
    });

    it('throws error when migration gap is detected during rollback (non-consecutive)', async () => {
      currentDbVersion = 3;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 3, up: jest.fn(), down: jest.fn() }
        ]
      });

      await expect(manager.downgrade(0)).rejects.toThrow(
        'Migration gap detected during rollback: expected version 2, but found version 1. Missing migration definition.'
      );
    });

    it('throws error when migrations do not reach the downgrade target version', async () => {
      currentDbVersion = 3;
      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 2, up: jest.fn(), down: jest.fn() },
          { version: 3, up: jest.fn(), down: jest.fn() }
        ]
      });

      await expect(manager.downgrade(0)).rejects.toThrow(
        'Migration gap detected during rollback: missing migration definitions down to target 0.'
      );
    });

    it('records failed state when down() throws during downgrade', async () => {
      currentDbVersion = 2;
      const logger: UpgradeLogger = { error: jest.fn() };

      const manager = new UpgradeManager(client, {
        logger,
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 2, up: jest.fn(), down: jest.fn().mockRejectedValue(new Error('Rollback failed in step 2')) }
        ]
      });

      await expect(manager.downgrade(1)).rejects.toThrow('Rollback failed in step 2');
      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toContain('Rollback failed at step 2: Rollback failed in step 2');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Rollback step 2 failed: Rollback failed in step 2')
      );
    });

    it('records failed state when down() throws a non-Error during downgrade', async () => {
      currentDbVersion = 2;

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: jest.fn() },
          { version: 2, up: jest.fn(), down: jest.fn().mockRejectedValue('String rollback failure') }
        ]
      });

      await expect(manager.downgrade(1)).rejects.toBe('String rollback failure');
      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toContain('Rollback failed at step 2: String rollback failure');
    });
  });

  describe('Bootstrap & Schema Initialization (New Database Workflow)', () => {
    it('configures schemaInit via options or setSchemaInit', () => {
      const initFn = jest.fn();
      const manager1 = new UpgradeManager(client, { schemaInit: initFn });
      expect(manager1).toBeDefined();

      const manager2 = new UpgradeManager(client);
      manager2.setSchemaInit(initFn, 5);
      expect(manager2).toBeDefined();

      const manager3 = new UpgradeManager(client);
      manager3.setSchemaInit({ version: 3, create: initFn });
      expect(manager3).toBeDefined();
    });

    it('rejects invalid schemaInit arguments', () => {
      const manager = new UpgradeManager(client);
      expect(() => manager.setSchemaInit(123 as unknown as () => Promise<void>)).toThrow(TypeError);
      expect(() => manager.setSchemaInit({} as unknown as { create: () => Promise<void> })).toThrow(TypeError);
      expect(() => manager.setSchemaInit({ version: 0, create: jest.fn() })).toThrow(
        /Schema initializer version must be a positive integer/
      );
      expect(() => manager.setSchemaInit({ version: -1, create: jest.fn() })).toThrow(
        /Schema initializer version must be a positive integer/
      );
      expect(() => manager.setSchemaInit({ version: 1.5, create: jest.fn() })).toThrow(
        /Schema initializer version must be a positive integer/
      );
      expect(() => manager.setSchemaInit(jest.fn(), 0)).toThrow(
        /Schema initializer version must be a positive integer/
      );
    });

    it('propagates database error when listUserTables fails and does not falsely treat database as empty', async () => {
      primaryConnection.query.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
        const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
        if (sql.includes('GET_LOCK')) {
          return [[{ lockAcquired: 1 }] as RowDataPacket[], [] as FieldPacket[]];
        }
        if (sql.includes('RELEASE_LOCK')) {
          return [[{ released: 1 }] as RowDataPacket[], [] as FieldPacket[]];
        }
        if (sql.includes('information_schema.tables')) {
          throw new Error('Access denied on information_schema');
        }
        return [[] as RowDataPacket[], [] as FieldPacket[]];
      });

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: jest.fn() }
      });

      await expect(manager.isFreshDatabase()).rejects.toThrow('Access denied on information_schema');
      await expect(manager.bootstrap()).rejects.toThrow('Access denied on information_schema');
    });

    it('isFreshDatabase returns true on empty database and false if tables or version > 0 exist', async () => {
      const manager = new UpgradeManager(client);

      // Empty database, version 0, idle
      currentDbVersion = 0;
      currentDbStatus = 'idle';
      existingUserTables = [];
      expect(await manager.isFreshDatabase()).toBe(true);

      // Existing application tables
      existingUserTables = ['users', 'orders'];
      expect(await manager.isFreshDatabase()).toBe(false);
      existingUserTables = [];

      // Initialized version > 0
      currentDbVersion = 1;
      expect(await manager.isFreshDatabase()).toBe(false);

      // Failed state
      currentDbVersion = 0;
      currentDbStatus = 'failed';
      expect(await manager.isFreshDatabase()).toBe(false);
    });

    it('bootstrap throws if no schemaInit is configured', async () => {
      const manager = new UpgradeManager(client);
      await expect(manager.bootstrap()).rejects.toThrow('Cannot bootstrap database: no schema initializer configured.');
    });

    it('bootstrap throws if target version cannot be determined', async () => {
      const manager = new UpgradeManager(client, {
        schemaInit: jest.fn()
      });
      await expect(manager.bootstrap()).rejects.toThrow('Target version for bootstrap could not be determined.');
    });

    it('bootstrap rejects if database is in failed or migrating state', async () => {
      currentDbVersion = 0;
      currentDbStatus = 'failed';
      currentInProgressVersion = 1;
      currentLastError = 'Previous failure';

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: jest.fn() }
      });

      await expect(manager.bootstrap()).rejects.toThrow('Cannot bootstrap database: database is in a FAILED state');

      currentDbStatus = 'migrating';
      await expect(manager.bootstrap()).rejects.toThrow(
        'Cannot bootstrap database: database is in an incomplete MIGRATING state'
      );
    });

    it('bootstrap rejects if database is already initialized (version > 0)', async () => {
      currentDbVersion = 2;
      const manager = new UpgradeManager(client, {
        schemaInit: { version: 3, create: jest.fn() }
      });

      await expect(manager.bootstrap()).rejects.toThrow(
        'Cannot bootstrap database: database is already initialized at schema version 2. Use upgrade() to evolve an existing database.'
      );
    });

    it('bootstrap rejects if database already contains application tables', async () => {
      currentDbVersion = 0;
      existingUserTables = ['legacy_accounts'];

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: jest.fn() }
      });

      await expect(manager.bootstrap()).rejects.toThrow(
        'Cannot bootstrap database: database already contains existing application tables (legacy_accounts).'
      );
    });

    it('bootstrap successfully constructs schema and sets version to targetVersion', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const createMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 5, create: createMock }
      });

      const result = await manager.bootstrap();

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(result.previousVersion).toBe(0);
      expect(result.currentVersion).toBe(5);
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0].version).toBe(5);
      expect(result.applied[0].name).toBe('bootstrap_schema');
      expect(currentDbVersion).toBe(5);
      expect(currentDbStatus).toBe('idle');
    });

    it('bootstrap records failed state with last_error when schemaInit.create throws', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const createMock = jest.fn().mockRejectedValue(new Error('Syntax error in DDL table creation'));

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 3, create: createMock }
      });

      await expect(manager.bootstrap()).rejects.toThrow('Syntax error in DDL table creation');

      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toBe('Syntax error in DDL table creation');
      expect(currentInProgressVersion).toBe(3);
    });

    it('setup calls bootstrap on fresh database and upgrade on initialized database', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const bootstrapMock = jest.fn().mockResolvedValue(undefined);
      const migrationMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: bootstrapMock },
        migrations: [{ version: 2, up: migrationMock }]
      });

      // 1. Fresh database -> bootstrap is called
      const setupResult1 = await manager.setup();
      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      expect(setupResult1.currentVersion).toBe(1);

      // 2. Existing database at version 1 -> upgrade to version 2
      const setupResult2 = await manager.setup();
      expect(migrationMock).toHaveBeenCalledTimes(1);
      expect(setupResult2.currentVersion).toBe(2);
    });

    it('acquires the advisory lock only once during setup()', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const lockSpy = jest.spyOn(client, 'withAdvisoryLock');

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: jest.fn().mockResolvedValue(undefined) }
      });

      await manager.setup();
      expect(lockSpy).toHaveBeenCalledTimes(1);
    });

    it('handles concurrent setup() calls gracefully without startup failures', async () => {
      currentDbVersion = 0;
      existingUserTables = [];

      let firstBootstrapDone = false;
      const bootstrapMock = jest.fn().mockImplementation(async () => {
        // While bootstrapping, tables are created
        existingUserTables = ['users', 'orders'];
        firstBootstrapDone = true;
      });

      const instance1 = new UpgradeManager(client, {
        schemaInit: { version: 1, create: bootstrapMock }
      });
      const instance2 = new UpgradeManager(client, {
        schemaInit: { version: 1, create: bootstrapMock }
      });

      // Instance 1 bootstraps the database
      const res1 = await instance1.setup();
      expect(res1.currentVersion).toBe(1);
      expect(res1.applied).toHaveLength(1);
      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      expect(firstBootstrapDone).toBe(true);

      // Instance 2 runs setup against the now-initialized database
      // Under the advisory lock, it sees database is no longer fresh and does not attempt bootstrap
      const res2 = await instance2.setup();
      expect(res2.currentVersion).toBe(1);
      expect(res2.previousVersion).toBe(1);
      expect(res2.applied).toHaveLength(0);
      expect(bootstrapMock).toHaveBeenCalledTimes(1); // not called again
    });

    it('rejects invalid targetVersion in bootstrap()', async () => {
      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: jest.fn() }
      });

      await expect(manager.bootstrap(0)).rejects.toThrow(TypeError);
      await expect(manager.bootstrap(-1)).rejects.toThrow(TypeError);
      await expect(manager.bootstrap(1.5)).rejects.toThrow(TypeError);
    });

    it('uses registered migrations highest version when schemaInit.version is not specified', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const createMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        schemaInit: { create: createMock },
        migrations: [
          { version: 1, up: jest.fn() },
          { version: 4, up: jest.fn() }
        ]
      });

      const res = await manager.bootstrap();
      expect(res.currentVersion).toBe(4);
      expect(currentDbVersion).toBe(4);
    });

    it('allows explicit targetVersion in bootstrap(version)', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const createMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 2, create: createMock }
      });

      const res = await manager.bootstrap(10);
      expect(res.currentVersion).toBe(10);
      expect(currentDbVersion).toBe(10);
    });

    it('handles non-Error thrown from schemaInit.create', async () => {
      currentDbVersion = 0;
      existingUserTables = [];

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 2, create: jest.fn().mockRejectedValue('Custom string bootstrap failure') }
      });

      await expect(manager.bootstrap()).rejects.toBe('Custom string bootstrap failure');
      expect(currentDbStatus).toBe('failed');
      expect(currentLastError).toBe('Custom string bootstrap failure');
    });

    it('handles database error when updating status after bootstrap failure', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const logger: UpgradeLogger = { error: jest.fn() };
      let failNextExecute = false;

      primaryConnection.execute.mockImplementation(async (sqlOrOptions: string | QueryOptions) => {
        const sql = typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
        if (failNextExecute && sql.includes("`status` = 'failed'")) {
          throw new Error('Connection lost while recording bootstrap failure');
        }
        return [{ affectedRows: 1 } as unknown as ResultSetHeader, [] as FieldPacket[]];
      });

      const manager = new UpgradeManager(client, {
        logger,
        schemaInit: {
          version: 2,
          create: jest.fn().mockImplementation(async () => {
            failNextExecute = true;
            throw new Error('Bootstrap create failed');
          })
        }
      });

      await expect(manager.bootstrap()).rejects.toThrow('Bootstrap create failed');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update failure status in version table')
      );
    });

    it('reports unknown version and none for lastError when null in bootstrap failed/migrating states', async () => {
      currentDbVersion = 0;
      currentDbStatus = 'failed';
      currentInProgressVersion = null;
      currentLastError = null;

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: jest.fn() }
      });

      await expect(manager.bootstrap()).rejects.toThrow(
        'Cannot bootstrap database: database is in a FAILED state at version unknown. Last error: "none". Manual inspection is required before proceeding. Once resolved or cleaned up, call resetFailedState().'
      );

      currentDbStatus = 'migrating';
      await expect(manager.bootstrap()).rejects.toThrow(
        'Cannot bootstrap database: database is in an incomplete MIGRATING state at version unknown. A previous process may have terminated mid-operation. Inspect schema and call resetFailedState().'
      );
    });

    it('setup falls back to upgrade directly when schemaInit is not configured', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const step1 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [{ version: 1, up: step1 }]
      });

      const res = await manager.setup();
      expect(step1).toHaveBeenCalledTimes(1);
      expect(res.currentVersion).toBe(1);
    });

    it('setup falls back to upgrade when database already has user tables even if version is 0', async () => {
      currentDbVersion = 0;
      existingUserTables = ['pre_existing_table'];
      const bootstrapMock = jest.fn();
      const step1 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: bootstrapMock },
        migrations: [{ version: 1, up: step1 }]
      });

      const res = await manager.setup();
      expect(bootstrapMock).not.toHaveBeenCalled();
      expect(step1).toHaveBeenCalledTimes(1);
      expect(res.currentVersion).toBe(1);
    });

    it('setup accepts and respects targetVersion', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const bootstrapMock = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        schemaInit: { version: 1, create: bootstrapMock }
      });

      const res = await manager.setup(3);
      expect(bootstrapMock).toHaveBeenCalledTimes(1);
      expect(res.currentVersion).toBe(3);
      expect(currentDbVersion).toBe(3);
    });

    it('calls custom logger during bootstrap execution', async () => {
      currentDbVersion = 0;
      existingUserTables = [];
      const logger: UpgradeLogger = { info: jest.fn() };

      const manager = new UpgradeManager(client, {
        logger,
        schemaInit: { version: 1, create: jest.fn().mockResolvedValue(undefined) }
      });

      await manager.bootstrap();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Bootstrapping database schema directly to version 1')
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Successfully bootstrapped database schema to version 1')
      );
    });

    it('throws error when bootstrap is called without schemaInit configured', async () => {
      const manager = new UpgradeManager(client, {});
      await expect(manager.bootstrap()).rejects.toThrow('Cannot bootstrap database: no schema initializer configured');
    });

    it('downgrades migrations cleanly to target version including unnamed steps', async () => {
      currentDbVersion = 2;
      const downMock2 = jest.fn().mockResolvedValue(undefined);
      const downMock1 = jest.fn().mockResolvedValue(undefined);

      const manager = new UpgradeManager(client, {
        migrations: [
          { version: 1, up: jest.fn(), down: downMock1 },
          { version: 2, name: 'step2', up: jest.fn(), down: downMock2 }
        ]
      });

      const res = await manager.downgrade(0);
      expect(res.currentVersion).toBe(0);
      expect(downMock2).toHaveBeenCalledTimes(1);
      expect(downMock1).toHaveBeenCalledTimes(1);
    });
  });
});
