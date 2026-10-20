import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import type { SqlClient } from './SqlClient';

/**
 * Migration execution state of the database.
 * - 'idle': Database is in a stable, consistent state.
 * - 'migrating': A migration or rollback step is actively running.
 * - 'failed': A migration failed. Subsequent operations are blocked until manual resolution.
 */
export type MigrationStatus = 'idle' | 'migrating' | 'failed';

/**
 * Represents a single schema migration step.
 */
export interface MigrationStep {
  /** Unique positive integer version (e.g. 1, 2, 3...) */
  version: number;
  /** Optional human-readable name describing the change */
  name?: string;
  /** Migration function to apply schema changes */
  up: (client: SqlClient) => Promise<void>;
  /** Optional rollback function to undo schema changes */
  down?: (client: SqlClient) => Promise<void>;
}

/** Alias for MigrationStep */
export type Migration = MigrationStep;

/**
 * Optional logger interface for upgrade telemetry.
 */
export interface UpgradeLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

/**
 * Snapshot schema initializer for fresh databases.
 *
 * Provides a declarative baseline of the latest database schema to bootstrap
 * brand-new databases in a single step without replaying historical migrations.
 *
 * ### Parallel Workflow with Migrations:
 * When maintaining `schemaInit` alongside incremental `migrations`:
 * - Maintain `schemaInit` as the **current target snapshot**:
 *   - Adding columns/tables: include them directly in the `CREATE TABLE` definition in `schemaInit`.
 *   - Dropping columns/tables: remove them from `schemaInit`.
 * - Maintain `migrations` as the **incremental changelog**:
 *   - Add a sequential migration step (e.g. `version: 2`) with `ALTER TABLE` or `DROP TABLE`.
 *
 * When `setup()` runs:
 * - Fresh databases run `schemaInit.create()` and jump directly to the target version.
 * - Existing databases skip `schemaInit` and apply only pending incremental migrations.
 *
 * @example
 * ```ts
 * const schemaInit: SchemaInitializer = {
 *   version: 2,
 *   create: async (db) => {
 *     await db.execute('CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL);');
 *   }
 * };
 * ```
 */
export interface SchemaInitializer {
  /** Target version this snapshot creates (defaults to highest registered migration version) */
  version?: number;
  /**
   * Function that builds the complete database schema from scratch.
   * Runs inside the distributed advisory lock on a dedicated session connection.
   */
  create: (client: SqlClient) => Promise<void>;
}

/**
 * Function or object specifying schema initialization for fresh databases.
 */
export type SchemaInitOption = SchemaInitializer | ((client: SqlClient) => Promise<void>);

/**
 * Options for configuring the UpgradeManager.
 */
export interface UpgradeManagerOptions {
  /**
   * Prefix for the version tracking table name.
   * Must contain only alphanumeric characters and underscores.
   * Default: '_version'
   */
  versionTablePrefix?: string;

  /**
   * Table suffix to be appended to the version table name (e.g. 'auth' -> '_version_auth').
   * Leading underscores are automatically stripped when joined with the prefix.
   * Must contain only alphanumeric characters and underscores.
   */
  versionTableSuffix?: string;

  /**
   * Full custom table name for tracking the database version.
   * If provided, overrides `versionTablePrefix` and `versionTableSuffix`.
   * Must contain only alphanumeric characters and underscores.
   * Default: '_version'
   */
  tableName?: string;

  /**
   * Pre-registered migration steps.
   */
  migrations?: MigrationStep[];

  /**
   * Maximum seconds to wait when acquiring the MySQL distributed advisory lock.
   * Default: 60 seconds
   */
  lockTimeoutSeconds?: number;

  /**
   * Whether to attempt running `step.down()` if `step.up()` fails during an upgrade.
   * Disabled (false) by default because MySQL DDL cannot be rolled back via transactions.
   * Default: false
   */
  autoRollbackOnFailure?: boolean;

  /**
   * Optional logger instance (console, Pino, Winston, etc.).
   */
  logger?: UpgradeLogger;

  /**
   * Optional snapshot initializer for bootstrapping fresh databases directly to current schema.
   */
  schemaInit?: SchemaInitOption;
}

/**
 * Result of an individual applied migration step.
 */
export interface UpgradeStepResult {
  version: number;
  name?: string;
  durationMs: number;
  direction: 'up' | 'down';
}

/**
 * Summary result returned after running an upgrade or downgrade.
 */
export interface UpgradeResult {
  previousVersion: number;
  currentVersion: number;
  applied: UpgradeStepResult[];
}

/**
 * Current migration status of the database.
 */
export interface UpgradeStatus {
  currentVersion: number;
  targetVersion: number;
  isUpToDate: boolean;
  status: MigrationStatus;
  inProgressVersion: number | null;
  lastError: string | null;
  pending: Pick<MigrationStep, 'version' | 'name'>[];
}

interface VersionRecord {
  id: number;
  value: number;
  status: MigrationStatus;
  in_progress_version: number | null;
  last_error: string | null;
  updated_at?: Date | string;
}

type VersionRow = RowDataPacket & VersionRecord;

/**
 * Production-grade database upgrade and migration manager for MySQL & MariaDB.
 *
 * Coordinates schema migrations with:
 * - Distributed advisory locking (`GET_LOCK`) to prevent multi-instance race conditions
 * - Single dedicated connection for all migration steps and lock lifecycle (no pool deadlocks)
 * - Single-row `_version` table with `CHECK (id = 1)` constraint
 * - Resilient state tracking ('idle', 'migrating', 'failed') preventing cascading DDL retries
 * - Strict sequential integer versioning (1, 2, 3...) with full gap and target validation
 * - Atomic rollback and downgrade execution via `step.down` callbacks under single-lock acquisition
 * - Collision-free SHA-256 hashed advisory lock names for arbitrarily long table names
 *
 * ### Recovery Contract for MySQL DDL:
 * In MySQL and MariaDB, DDL statements (`CREATE TABLE`, `ALTER TABLE`, etc.) trigger an implicit
 * commit and CANNOT be rolled back inside transactions. If a migration step throws an error or
 * if a process dies mid-migration, the database remains in 'failed' or 'migrating' state.
 *
 * When an upgrade fails:
 * 1. Inspect the reported `lastError` and check the real schema state in the database.
 * 2. Manually complete or revert any partially applied DDL changes.
 * 3. Call `upgradeManager.resetFailedState(verifiedVersion)` to return the status to 'idle'
 *    before proceeding with further migrations.
 */
export class UpgradeManager {
  private readonly client: SqlClient;
  private readonly tableName: string;
  private readonly escapedTableName: string;
  private readonly versionTablePrefix: string;
  private readonly versionTableSuffix?: string;
  private readonly lockName: string;
  private readonly lockTimeoutSeconds: number;
  private readonly autoRollbackOnFailure: boolean;
  private readonly logger: UpgradeLogger;
  private readonly migrations = new Map<number, MigrationStep>();
  private schemaInit?: SchemaInitializer;

  public constructor(client: SqlClient, options: UpgradeManagerOptions = {}) {
    this.client = client;

    const tablePrefix = options.versionTablePrefix ?? '_version';
    const rawSuffix = options.versionTableSuffix;
    const tableSuffix = rawSuffix?.replace(/^_+/, '') ?? '';

    const tableName = options.tableName ?? (tableSuffix ? `${tablePrefix}_${tableSuffix}` : tablePrefix);

    if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
      throw new TypeError(
        `Invalid version table name: "${tableName}". Only alphanumeric characters and underscores are allowed.`
      );
    }

    this.tableName = tableName;
    this.escapedTableName = `\`${tableName}\``;
    this.versionTablePrefix = options.versionTablePrefix ?? options.tableName ?? '_version';
    this.versionTableSuffix = rawSuffix;
    this.lockName = this.computeLockName(tableName);
    this.lockTimeoutSeconds = options.lockTimeoutSeconds ?? 60;
    this.autoRollbackOnFailure = options.autoRollbackOnFailure ?? false;
    this.logger = options.logger ?? {};

    if (options.migrations) {
      this.addMigrations(options.migrations);
    }

    if (options.schemaInit) {
      this.setSchemaInit(options.schemaInit);
    }
  }

  /**
   * Configure the snapshot schema initializer for fresh database bootstrapping.
   *
   * @param initializer - Function or object containing a `create` function
   * @param version - Optional target version (overrides initializer.version)
   * @returns This instance for chaining
   */
  public setSchemaInit(initializer: SchemaInitOption, version?: number): this {
    if (typeof initializer === 'function') {
      if (version !== undefined && (!Number.isInteger(version) || version <= 0)) {
        throw new TypeError(`Schema initializer version must be a positive integer, received: ${version}`);
      }
      this.schemaInit = {
        version,
        create: initializer
      };
    } else if (typeof initializer === 'object' && initializer !== null) {
      if (typeof initializer.create !== 'function') {
        throw new TypeError("Schema initializer must provide a 'create' function.");
      }
      const effectiveVersion = version ?? initializer.version;
      if (effectiveVersion !== undefined && (!Number.isInteger(effectiveVersion) || effectiveVersion <= 0)) {
        throw new TypeError(`Schema initializer version must be a positive integer, received: ${effectiveVersion}`);
      }
      this.schemaInit = {
        version: effectiveVersion,
        create: initializer.create
      };
    } else {
      throw new TypeError("Schema initializer must be a function or an object with a 'create' function.");
    }
    return this;
  }

  /**
   * Register a new migration step.
   *
   * @param migration - The migration step to register
   * @returns This instance for chaining
   * @throws TypeError if version is not a positive integer or up is not a function
   * @throws Error if a migration with this version is already registered
   */
  public addMigration(migration: MigrationStep): this {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new TypeError(`Migration version must be a positive integer, received: ${migration.version}`);
    }

    if (typeof migration.up !== 'function') {
      throw new TypeError(`Migration ${migration.version} must provide an 'up' function.`);
    }

    if (this.migrations.has(migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }

    this.migrations.set(migration.version, migration);
    return this;
  }

  /**
   * Register multiple migration steps.
   *
   * @param migrations - Array of migration steps
   * @returns This instance for chaining
   */
  public addMigrations(migrations: MigrationStep[]): this {
    for (const migration of migrations) {
      this.addMigration(migration);
    }
    return this;
  }

  /**
   * Returns all registered migration steps sorted in ascending order by version.
   */
  public getRegisteredMigrations(): readonly MigrationStep[] {
    return Array.from(this.migrations.values()).sort((a, b) => a.version - b.version);
  }

  /**
   * Reads the current schema version from the database.
   * Returns 0 if the version table does not yet exist.
   *
   * @returns Promise resolving to the current integer version
   */
  public async getCurrentVersion(): Promise<number> {
    const row = await this.readVersionRow(this.client);
    return row.value;
  }

  /**
   * Retrieves the current migration status and lists any pending migrations.
   *
   * Reads directly from the version table without acquiring an exclusive lock,
   * enabling live inspection of database status even while a migration is actively running.
   * Note: The reported status is a live snapshot and may change immediately after read.
   *
   * @param targetVersion - Optional target version to inspect (defaults to highest registered migration)
   * @returns Promise resolving to the current UpgradeStatus
   */
  public async getStatus(targetVersion?: number): Promise<UpgradeStatus> {
    const effectiveTarget = this.resolveTargetVersion(targetVersion);
    const row = await this.readVersionRow(this.client);

    const pending = this.getRegisteredMigrations()
      .filter(m => m.version > row.value && m.version <= effectiveTarget)
      .map(m => ({ version: m.version, name: m.name }));

    return {
      currentVersion: row.value,
      targetVersion: effectiveTarget,
      isUpToDate: row.value === effectiveTarget && row.status === 'idle',
      status: row.status,
      inProgressVersion: row.in_progress_version,
      lastError: row.last_error,
      pending
    };
  }

  /**
   * Runs all pending migrations up to the target version in ascending order.
   *
   * Under a distributed advisory lock:
   * 1. Ensures the `_version` table exists on the locked connection
   * 2. Checks database status; halts if previous migration failed or crashed
   * 3. Validates contiguous sequential versions and verifies target version is reached
   * 4. Applies each pending migration step sequentially on the locked connection
   * 5. Advances the `_version` table immediately after each step succeeds
   *
   * @param targetVersion - Optional target version (defaults to highest registered migration)
   * @returns Promise resolving to the UpgradeResult summary
   * @throws Error if database is in a failed/migrating state
   * @throws Error if migration gaps are detected or registered migrations cannot reach target
   * @throws Error if lock acquisition times out or any migration step throws
   */
  public async upgrade(targetVersion?: number): Promise<UpgradeResult> {
    const effectiveTarget = this.resolveTargetVersion(targetVersion);

    return this.client.withAdvisoryLock(this.lockName, this.lockTimeoutSeconds, async lockedClient => {
      await this.ensureVersionTable(lockedClient);
      const row = await this.readVersionRow(lockedClient);
      return this.executeUpgrade(effectiveTarget, row, lockedClient);
    });
  }

  /**
   * Bootstrap a fresh database directly to the target version without replaying historical migrations.
   *
   * Under a distributed advisory lock:
   * 1. Ensures the database is completely fresh (no user tables, version 0, idle)
   * 2. Marks the database as 'migrating' with `in_progress_version` set to the target version
   * 3. Runs the registered `schemaInit.create()` function on the locked session connection
   * 4. Updates the version table to `targetVersion` in 'idle' status
   *
   * @param targetVersion - Optional target version (defaults to schemaInit.version or highest registered migration)
   * @returns Promise resolving to the UpgradeResult summary
   * @throws Error if no schemaInit is configured
   * @throws Error if the database is already initialized or contains existing tables
   * @throws Error if lock acquisition times out or schemaInit fails
   */
  public async bootstrap(targetVersion?: number): Promise<UpgradeResult> {
    if (!this.schemaInit) {
      throw new Error(
        'Cannot bootstrap database: no schema initializer configured. Provide schemaInit in options or call setSchemaInit().'
      );
    }

    const effectiveTarget = this.resolveBootstrapTargetVersion(targetVersion);

    return this.client.withAdvisoryLock(this.lockName, this.lockTimeoutSeconds, async lockedClient => {
      await this.ensureVersionTable(lockedClient);
      const row = await this.readVersionRow(lockedClient);
      return this.executeBootstrap(effectiveTarget, row, lockedClient, false);
    });
  }

  /**
   * Checks whether the current database is fresh and eligible for schema bootstrapping.
   *
   * A database is fresh if:
   * 1. No application tables exist (excluding the optional `_version` table).
   * 2. The `_version` table (if present) is at version 0 in 'idle' status.
   *
   * @param client - Optional client (e.g. locked connection) to execute checks against. Defaults to this.client.
   * @returns Promise resolving to true if database is fresh, false otherwise
   */
  public async isFreshDatabase(client: SqlClient = this.client): Promise<boolean> {
    const userTables = await this.listUserTables(client);
    if (userTables.length > 0) {
      return false;
    }

    const row = await this.readVersionRow(client);
    return row.value === 0 && row.status === 'idle';
  }

  /**
   * Unified deployment entrypoint: automatically bootstraps a fresh database
   * or upgrades an existing database to the target version.
   *
   * Executes under a single distributed advisory lock acquisition to eliminate
   * multi-pod startup race conditions. Inside the lock:
   * - If `schemaInit` is configured and the database is completely fresh, bootstraps the database.
   * - Otherwise, executes pending migrations or confirms the database is already up to date.
   *
   * @param targetVersion - Optional target version
   * @returns Promise resolving to the UpgradeResult
   */
  public async setup(targetVersion?: number): Promise<UpgradeResult> {
    return this.client.withAdvisoryLock(this.lockName, this.lockTimeoutSeconds, async lockedClient => {
      await this.ensureVersionTable(lockedClient);
      const row = await this.readVersionRow(lockedClient);

      if (this.schemaInit && row.value === 0 && row.status === 'idle') {
        const userTables = await this.listUserTables(lockedClient);
        if (userTables.length === 0) {
          const effectiveBootstrapTarget = this.resolveBootstrapTargetVersion(targetVersion);
          return this.executeBootstrap(effectiveBootstrapTarget, row, lockedClient, true);
        }
      }

      const effectiveUpgradeTarget = this.resolveTargetVersion(targetVersion);
      return this.executeUpgrade(effectiveUpgradeTarget, row, lockedClient);
    });
  }

  private async executeUpgrade(
    effectiveTarget: number,
    row: VersionRecord,
    lockedClient: SqlClient
  ): Promise<UpgradeResult> {
    if (row.status === 'failed') {
      throw new Error(
        `Database is in a FAILED migration state at version ${row.in_progress_version ?? 'unknown'}. ` +
          `Last error: "${row.last_error ?? 'none'}". ` +
          `Manual inspection is required before running further migrations. Once resolved, call resetFailedState().`
      );
    }

    if (row.status === 'migrating') {
      throw new Error(
        `Database is in an incomplete MIGRATING state at version ${row.in_progress_version ?? 'unknown'}. ` +
          `A previous process may have terminated unexpectedly mid-migration. Inspect database schema and call resetFailedState().`
      );
    }

    if (row.value > effectiveTarget) {
      throw new Error(
        `Database version (${row.value}) is newer than target version (${effectiveTarget}). Downgrades are not supported in upgrade(); use downgrade() instead.`
      );
    }

    if (row.value === effectiveTarget) {
      this.logger.info?.(`Database is already up to date at version ${row.value}.`);
      return {
        previousVersion: row.value,
        currentVersion: row.value,
        applied: []
      };
    }

    const pending = this.getRegisteredMigrations().filter(m => m.version > row.value && m.version <= effectiveTarget);

    this.validateSequence(pending, row.value, effectiveTarget);

    const applied: UpgradeStepResult[] = [];
    let activeVersion = row.value;

    for (const step of pending) {
      const stepDescription = step.name ? `${step.version} ("${step.name}")` : `${step.version}`;
      this.logger.info?.(`Applying migration step ${stepDescription}...`);

      await lockedClient.execute(
        `UPDATE ${this.escapedTableName} SET \`status\` = 'migrating', \`in_progress_version\` = ? WHERE \`id\` = 1`,
        [step.version]
      );

      const startTime = Date.now();
      try {
        await step.up(lockedClient);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error?.(`Migration step ${stepDescription} failed: ${errorMessage}`);
        let rollbackError: unknown;

        if (this.autoRollbackOnFailure && typeof step.down === 'function') {
          try {
            this.logger.warn?.(`Attempting rollback for failed migration step ${stepDescription}...`);
            await step.down(lockedClient);
            try {
              await lockedClient.execute(
                `UPDATE ${this.escapedTableName} SET \`status\` = 'idle', \`in_progress_version\` = NULL, \`last_error\` = ? WHERE \`id\` = 1`,
                [`Rollback succeeded after failure in step ${step.version}: ${errorMessage}`]
              );
            } catch (statusErr) {
              this.logger.error?.(`Failed to update status after successful rollback: ${String(statusErr)}`);
            }
          } catch (rbErr) {
            rollbackError = rbErr;
            const rollbackMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
            this.logger.error?.(`Rollback for step ${stepDescription} also failed: ${rollbackMsg}`);
            try {
              await lockedClient.execute(
                `UPDATE ${this.escapedTableName} SET \`status\` = 'failed', \`last_error\` = ? WHERE \`id\` = 1`,
                [`Upgrade failed: ${errorMessage}. Rollback also failed: ${rollbackMsg}`]
              );
            } catch (statusErr) {
              this.logger.error?.(`Failed to update failure status in version table: ${String(statusErr)}`);
            }
          }
        } else {
          try {
            await lockedClient.execute(
              `UPDATE ${this.escapedTableName} SET \`status\` = 'failed', \`last_error\` = ? WHERE \`id\` = 1`,
              [errorMessage]
            );
          } catch (statusErr) {
            this.logger.error?.(`Failed to update failure status in version table: ${String(statusErr)}`);
          }
        }

        if (rollbackError) {
          if (error instanceof Error) {
            const enriched = error as Error & { cause?: unknown; rollbackError?: unknown };
            if (enriched.cause === undefined) {
              enriched.cause = rollbackError;
            }
            enriched.rollbackError = rollbackError;
            throw enriched;
          }

          const wrapped = new Error(
            `Migration step ${stepDescription} failed (${String(error)}) and rollback also failed (${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            })`
          );
          const enriched = wrapped as Error & { cause?: unknown; rollbackError?: unknown };
          enriched.cause = error;
          enriched.rollbackError = rollbackError;
          throw wrapped;
        }

        throw error;
      }

      const durationMs = Date.now() - startTime;

      await lockedClient.execute(
        `UPDATE ${this.escapedTableName} SET \`value\` = ?, \`status\` = 'idle', \`in_progress_version\` = NULL, \`last_error\` = NULL WHERE \`id\` = 1`,
        [step.version]
      );
      activeVersion = step.version;

      this.logger.info?.(`Successfully applied migration step ${stepDescription} in ${durationMs}ms.`);

      applied.push({
        version: step.version,
        name: step.name,
        durationMs,
        direction: 'up'
      });
    }

    return {
      previousVersion: row.value,
      currentVersion: activeVersion,
      applied
    };
  }

  private async executeBootstrap(
    effectiveTarget: number,
    row: VersionRecord,
    lockedClient: SqlClient,
    skipFreshnessCheck = false
  ): Promise<UpgradeResult> {
    if (row.status === 'failed') {
      throw new Error(
        `Cannot bootstrap database: database is in a FAILED state at version ${row.in_progress_version ?? 'unknown'}. ` +
          `Last error: "${row.last_error ?? 'none'}". ` +
          `Manual inspection is required before proceeding. Once resolved or cleaned up, call resetFailedState().`
      );
    }

    if (row.status === 'migrating') {
      throw new Error(
        `Cannot bootstrap database: database is in an incomplete MIGRATING state at version ${row.in_progress_version ?? 'unknown'}. ` +
          `A previous process may have terminated mid-operation. Inspect schema and call resetFailedState().`
      );
    }

    if (!skipFreshnessCheck) {
      if (row.value > 0) {
        throw new Error(
          `Cannot bootstrap database: database is already initialized at schema version ${row.value}. ` +
            `Use upgrade() to evolve an existing database.`
        );
      }

      const existingTables = await this.listUserTables(lockedClient);
      if (existingTables.length > 0) {
        throw new Error(
          `Cannot bootstrap database: database already contains existing application tables (${existingTables.join(
            ', '
          )}). ` + `Bootstrap can only be performed on a fresh database.`
        );
      }
    }

    this.logger.info?.(`Bootstrapping database schema directly to version ${effectiveTarget}...`);

    await lockedClient.execute(
      `UPDATE ${this.escapedTableName} SET \`status\` = 'migrating', \`in_progress_version\` = ? WHERE \`id\` = 1`,
      [effectiveTarget]
    );

    const startTime = Date.now();
    try {
      await this.schemaInit!.create(lockedClient);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error?.(`Database bootstrap failed: ${errorMessage}`);

      try {
        await lockedClient.execute(
          `UPDATE ${this.escapedTableName} SET \`status\` = 'failed', \`last_error\` = ? WHERE \`id\` = 1`,
          [errorMessage]
        );
      } catch (statusErr) {
        this.logger.error?.(`Failed to update failure status in version table: ${String(statusErr)}`);
      }

      throw error;
    }

    const durationMs = Date.now() - startTime;

    await lockedClient.execute(
      `UPDATE ${this.escapedTableName} SET \`value\` = ?, \`status\` = 'idle', \`in_progress_version\` = NULL, \`last_error\` = NULL WHERE \`id\` = 1`,
      [effectiveTarget]
    );

    this.logger.info?.(`Successfully bootstrapped database schema to version ${effectiveTarget} in ${durationMs}ms.`);

    return {
      previousVersion: 0,
      currentVersion: effectiveTarget,
      applied: [
        {
          version: effectiveTarget,
          name: 'bootstrap_schema',
          durationMs,
          direction: 'up'
        }
      ]
    };
  }

  /**
   * Rolls back applied migrations in descending order down to the target version.
   *
   * @param targetVersion - The target version to roll back to (non-negative integer)
   * @returns Promise resolving to the UpgradeResult summary
   * @throws TypeError if targetVersion is invalid
   * @throws Error if current version is <= targetVersion or any step lacks a 'down' function
   */
  public async downgrade(targetVersion: number): Promise<UpgradeResult> {
    if (!Number.isInteger(targetVersion) || targetVersion < 0) {
      throw new TypeError(`Target version must be a non-negative integer, received: ${targetVersion}`);
    }

    return this.client.withAdvisoryLock(this.lockName, this.lockTimeoutSeconds, async lockedClient => {
      await this.ensureVersionTable(lockedClient);
      const row = await this.readVersionRow(lockedClient);
      return this.executeDowngrade(targetVersion, row, lockedClient);
    });
  }

  /**
   * Convenience method to roll back the single most recently applied migration step.
   * Executes under a single advisory lock acquisition to eliminate concurrency race conditions.
   *
   * @returns Promise resolving to the UpgradeResult summary
   */
  public async rollback(): Promise<UpgradeResult> {
    return this.client.withAdvisoryLock(this.lockName, this.lockTimeoutSeconds, async lockedClient => {
      await this.ensureVersionTable(lockedClient);
      const row = await this.readVersionRow(lockedClient);

      if (row.value <= 0) {
        throw new Error('Cannot rollback: database is already at version 0.');
      }

      return this.executeDowngrade(row.value - 1, row, lockedClient);
    });
  }

  /**
   * Resets the version table's status from 'failed' or 'migrating' back to 'idle'.
   * Use this after manually inspecting the schema and resolving partial DDL failures.
   *
   * @param newVersion - Optional verified version integer to record
   */
  public async resetFailedState(newVersion?: number): Promise<void> {
    if (newVersion !== undefined && (!Number.isInteger(newVersion) || newVersion < 0)) {
      throw new TypeError(`Target version must be a non-negative integer, received: ${newVersion}`);
    }

    await this.client.withAdvisoryLock(this.lockName, this.lockTimeoutSeconds, async lockedClient => {
      await this.ensureVersionTable(lockedClient);
      if (newVersion !== undefined) {
        await lockedClient.execute(
          `UPDATE ${this.escapedTableName} SET \`value\` = ?, \`status\` = 'idle', \`in_progress_version\` = NULL, \`last_error\` = NULL WHERE \`id\` = 1`,
          [newVersion]
        );
      } else {
        await lockedClient.execute(
          `UPDATE ${this.escapedTableName} SET \`status\` = 'idle', \`in_progress_version\` = NULL, \`last_error\` = NULL WHERE \`id\` = 1`
        );
      }
    });
  }

  /**
   * Returns the configured table name for tracking schema versions.
   */
  public getTableName(): string {
    return this.tableName;
  }

  /**
   * Returns the prefix used for the version tracking table name.
   */
  public getVersionTablePrefix(): string {
    return this.versionTablePrefix;
  }

  /**
   * Returns the optional suffix appended to the version tracking table name, if configured.
   */
  public getVersionTableSuffix(): string | undefined {
    return this.versionTableSuffix;
  }

  /**
   * Returns the distributed advisory lock name used for this upgrade manager.
   */
  public getLockName(): string {
    return this.lockName;
  }

  private async executeDowngrade(
    targetVersion: number,
    row: VersionRecord,
    lockedClient: SqlClient
  ): Promise<UpgradeResult> {
    if (row.status === 'failed') {
      throw new Error(
        `Database is in a FAILED migration state at version ${row.in_progress_version ?? 'unknown'}. ` +
          `Last error: "${row.last_error ?? 'none'}". Call resetFailedState() before attempting downgrade.`
      );
    }

    if (row.status === 'migrating') {
      throw new Error(
        `Database is in an incomplete MIGRATING state at version ${row.in_progress_version ?? 'unknown'}. ` +
          `Inspect database schema and call resetFailedState().`
      );
    }

    if (row.value <= targetVersion) {
      throw new Error(
        `Database version (${row.value}) is already less than or equal to target version (${targetVersion}).`
      );
    }

    const registered = this.getRegisteredMigrations();
    const stepsToRollback = registered
      .filter(m => m.version <= row.value && m.version > targetVersion)
      .sort((a, b) => b.version - a.version);

    if (stepsToRollback.length === 0) {
      throw new Error(
        `No registered migrations found to roll back from version ${row.value} to target version ${targetVersion}.`
      );
    }

    let expected = row.value;
    for (const step of stepsToRollback) {
      if (step.version !== expected) {
        throw new Error(
          `Migration gap detected during rollback: expected version ${expected}, but found version ${step.version}. Missing migration definition.`
        );
      }
      expected--;
    }
    if (expected !== targetVersion) {
      throw new Error(
        `Migration gap detected during rollback: missing migration definitions down to target ${targetVersion}.`
      );
    }

    for (const step of stepsToRollback) {
      if (typeof step.down !== 'function') {
        throw new Error(
          `Cannot downgrade: migration step ${step.version} (${step.name ?? 'unnamed'}) does not provide a 'down' function.`
        );
      }
    }

    const applied: UpgradeStepResult[] = [];
    let activeVersion = row.value;

    for (const step of stepsToRollback) {
      const stepDescription = step.name ? `${step.version} ("${step.name}")` : `${step.version}`;
      this.logger.info?.(`Rolling back migration step ${stepDescription}...`);

      await lockedClient.execute(
        `UPDATE ${this.escapedTableName} SET \`status\` = 'migrating', \`in_progress_version\` = ? WHERE \`id\` = 1`,
        [step.version]
      );

      const startTime = Date.now();
      try {
        await step.down!(lockedClient);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error?.(`Rollback step ${stepDescription} failed: ${errorMessage}`);
        await lockedClient.execute(
          `UPDATE ${this.escapedTableName} SET \`status\` = 'failed', \`last_error\` = ? WHERE \`id\` = 1`,
          [`Rollback failed at step ${step.version}: ${errorMessage}`]
        );
        throw error;
      }

      const durationMs = Date.now() - startTime;
      const newVersion = step.version - 1;

      await lockedClient.execute(
        `UPDATE ${this.escapedTableName} SET \`value\` = ?, \`status\` = 'idle', \`in_progress_version\` = NULL, \`last_error\` = NULL WHERE \`id\` = 1`,
        [newVersion]
      );
      activeVersion = newVersion;

      this.logger.info?.(`Successfully rolled back migration step ${stepDescription} in ${durationMs}ms.`);

      applied.push({
        version: step.version,
        name: step.name,
        durationMs,
        direction: 'down'
      });
    }

    return {
      previousVersion: row.value,
      currentVersion: activeVersion,
      applied
    };
  }

  private computeLockName(tableName: string): string {
    const base = `catbee_upg_${tableName}`;
    if (base.length <= 64) {
      return base;
    }
    const hash = createHash('sha256').update(tableName).digest('hex').slice(0, 32);
    return `catbee_upg_${tableName.slice(0, 20)}_${hash}`;
  }

  private resolveTargetVersion(targetVersion?: number): number {
    if (targetVersion !== undefined) {
      if (!Number.isInteger(targetVersion) || targetVersion < 0) {
        throw new TypeError(`Target version must be a non-negative integer, received: ${targetVersion}`);
      }
      return targetVersion;
    }

    const all = this.getRegisteredMigrations();
    const highestMigration = all.length > 0 ? all[all.length - 1].version : 0;
    const schemaInitVersion = this.schemaInit?.version ?? 0;
    return Math.max(highestMigration, schemaInitVersion);
  }

  private validateSequence(pending: MigrationStep[], currentVersion: number, effectiveTarget: number): void {
    if (pending.length === 0) {
      if (currentVersion !== effectiveTarget) {
        throw new Error(
          `No registered migrations found to upgrade from version ${currentVersion} to target version ${effectiveTarget}.`
        );
      }
      return;
    }

    if (pending[0].version !== currentVersion + 1) {
      throw new Error(
        `Migration gap detected: database is currently at version ${currentVersion}, but the next available migration is ${pending[0].version}. Missing migration version ${currentVersion + 1}.`
      );
    }

    for (let i = 1; i < pending.length; i++) {
      const prev = pending[i - 1].version;
      const curr = pending[i].version;
      if (curr !== prev + 1) {
        throw new Error(
          `Migration gap detected: migration version ${prev + 1} is missing between version ${prev} and ${curr}.`
        );
      }
    }

    const last = pending[pending.length - 1].version;
    if (last !== effectiveTarget) {
      throw new Error(
        `Target version mismatch: requested target version is ${effectiveTarget}, but registered migrations only reach version ${last}. Missing migration version ${last + 1}.`
      );
    }
  }

  private async ensureVersionTable(client: SqlClient): Promise<void> {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${this.escapedTableName} (
        \`id\` INT NOT NULL PRIMARY KEY CHECK (\`id\` = 1),
        \`value\` INT NOT NULL,
        \`status\` VARCHAR(20) NOT NULL DEFAULT 'idle',
        \`in_progress_version\` INT NULL,
        \`last_error\` TEXT NULL,
        \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB CHARACTER SET utf8mb4;
    `);

    await client.execute(`
      INSERT INTO ${this.escapedTableName} (\`id\`, \`value\`, \`status\`)
      VALUES (1, 0, 'idle')
      ON DUPLICATE KEY UPDATE \`id\` = \`id\`;
    `);
  }

  private resolveBootstrapTargetVersion(targetVersion?: number): number {
    const rawVersion = targetVersion ?? this.schemaInit?.version;
    if (rawVersion !== undefined) {
      if (!Number.isInteger(rawVersion) || rawVersion <= 0) {
        throw new TypeError(`Bootstrap target version must be a positive integer, received: ${rawVersion}`);
      }
      return rawVersion;
    }

    const all = this.getRegisteredMigrations();
    if (all.length > 0) {
      return all[all.length - 1].version;
    }

    throw new Error(
      'Target version for bootstrap could not be determined. Please specify targetVersion, configure schemaInit.version, or register migrations.'
    );
  }

  private async listUserTables(client: SqlClient): Promise<string[]> {
    const { rows } = await client.query<RowDataPacket[]>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_type = 'BASE TABLE'
         AND table_name != ?`,
      [this.tableName]
    );
    return (rows as unknown as { tableName: string }[]).map(r => r.tableName);
  }

  private isTableNotFoundError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const err = error as { code?: string; errno?: number; message?: string };
    return (
      err.code === 'ER_NO_SUCH_TABLE' ||
      err.errno === 1146 ||
      (typeof err.message === 'string' && err.message.includes("doesn't exist"))
    );
  }

  private async readVersionRow(client: SqlClient): Promise<VersionRecord> {
    try {
      const row = await client.get<VersionRow>(
        `SELECT \`id\`, \`value\`, \`status\`, \`in_progress_version\`, \`last_error\` FROM ${this.escapedTableName} WHERE \`id\` = 1`
      );
      return (
        row ?? {
          id: 1,
          value: 0,
          status: 'idle',
          in_progress_version: null,
          last_error: null
        }
      );
    } catch (error) {
      if (this.isTableNotFoundError(error)) {
        return {
          id: 1,
          value: 0,
          status: 'idle',
          in_progress_version: null,
          last_error: null
        };
      }
      throw error;
    }
  }
}
