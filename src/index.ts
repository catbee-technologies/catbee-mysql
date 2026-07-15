// Main exports
export { SqlClient } from './SqlClient';

// Types
export type {
  SqlClientOptions,
  PoolOptions,
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
