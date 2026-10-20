// Main exports
export { SqlClient } from './SqlClient';

// Types
export type {
  SqlClientOptions,
  PoolOptions,
  SqlScalar,
  SqlScalarValue,
  SqlValue,
  SqlParameters,
  QueryExecutionOptions,
  RetryOptions,
  MiddlewareContext,
  MiddlewareFn,
  SqlQueryResult,
  SqlExecuteResult,
  QueryRows,
  SqlTransaction,
  TransactionIsolationLevel,
  TransactionOptions,
  SqlClientBase
} from './types';

// Named parameter compiler
export { compileNamedParameters } from './NamedParameters';
export type { NamedSqlParameters, CompiledNamedQuery } from './NamedParameters';

// Connection management
export { ConnectionManager } from './ConnectionManager';

// Transaction client
export { TransactionClient } from './TransactionClient';

// Query builder
export { QueryBuilder, buildQuery } from './QueryBuilder';

// Date utilities (for UTC handling)
export {
  formatDateForMysql,
  getCurrentUtcMysqlTimestamp,
  parseMysqlDateTime,
  parseMysqlDate,
  parseMysqlTimestamp,
  formatDateOnly,
  formatTimeOnly
} from './DateUtils';

// Upgrade manager for schema migrations
export {
  UpgradeManager,
  type MigrationStep,
  type Migration,
  type MigrationStatus,
  type UpgradeManagerOptions,
  type UpgradeLogger,
  type UpgradeResult,
  type UpgradeStepResult,
  type UpgradeStatus,
  type SchemaInitializer,
  type SchemaInitOption
} from './UpgradeManager';
