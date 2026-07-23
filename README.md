# @catbee/mysql

A lightweight, type-safe MySQL client for Node.js with comprehensive transaction support, connection pooling, and a fluent query builder.

<div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0;">
  <img src="https://github.com/catbee-technologies/catbee-mysql/actions/workflows/ci.yml/badge.svg?label=Build" alt="Build Status" />
  <img src="https://codecov.io/gh/catbee-technologies/catbee-mysql/graph/badge.svg?token=XAJHK6R1OQ" alt="Coverage" />
  <img src="https://img.shields.io/node/v/@catbee/mysql" alt="Node Version" />
  <img src="https://img.shields.io/npm/v/@catbee/mysql" alt="NPM Version" />
  <!-- <img src="https://img.shields.io/npm/v/@catbee/mysql/rc" alt="NPM RC Version" />
  <img src="https://img.shields.io/npm/v/@catbee/mysql/next" alt="NPM Next Version" /> -->
  <img src="https://img.shields.io/npm/dt/@catbee/mysql" alt="NPM Downloads" />
  <img src="https://img.shields.io/npm/types/@catbee/mysql" alt="TypeScript Types" />
  <img src="https://img.shields.io/maintenance/yes/2050" alt="Maintenance" />
  <img src="https://snyk.io/test/github/catbee-technologies/catbee-mysql/badge.svg" alt="Snyk Vulnerabilities" />
  <img src="https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-mysql&metric=alert_status&token=93da835f2d48d37b41fa628cc7fc764c873bd700" alt="Quality Gate Status" />
  <img src="https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-mysql&metric=ncloc&token=93da835f2d48d37b41fa628cc7fc764c873bd700" alt="Lines of Code" />
  <img src="https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-mysql&metric=security_rating&token=93da835f2d48d37b41fa628cc7fc764c873bd700" alt="Security Rating" />
  <img src="https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-mysql&metric=sqale_rating&token=93da835f2d48d37b41fa628cc7fc764c873bd700" alt="Maintainability Rating" />
  <img src="https://sonarcloud.io/api/project_badges/measure?project=catbee-technologies_catbee-mysql&metric=vulnerabilities&token=93da835f2d48d37b41fa628cc7fc764c873bd700" alt="Vulnerabilities" />
  <img src="https://img.shields.io/npm/l/@catbee/mysql" alt="License" />
</div>

---

## Features

- ✨ **Type-safe**: Full TypeScript support with proper typing for queries, results, and transactions
- 🔄 **Transaction support**: Both manual and automatic transaction handling with rollback on error
- 🧩 **Nested transactions**: Savepoints with rollback-to and release helpers
- 🚀 **Connection pooling**: Built-in connection pool support for high-concurrency scenarios
- 🔨 **Query builder**: Fluent SQL builder for common operations
- 🏷️ **Named parameters**: Safe `:name` placeholders compiled to positional parameters
- 📈 **Resilience controls**: Retry policy, timeout, and cancellation support
- 👀 **Middleware & events**: composable `db.use()` middleware chain and `EventEmitter` for observability
- 🎯 **Convenience methods**: `get()`, `all()`, `insert()`, `update()`, `delete()` helpers
- 📦 **Lightweight**: Thin wrapper around `mysql2/promise` with minimal overhead

## Installation

```bash
npm install @catbee/mysql
```

## Quick Start

### Create a client

```ts
import { SqlClient } from '@catbee/mysql';

// Single connection mode
const db = await SqlClient.create({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'myapp'
});

// Or use connection pooling for high-concurrency apps
const db = SqlClient.createPool({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'myapp',
  connectionLimit: 10
});
```

## Usage Examples

### Simple Queries

```ts
// Get all users
const users = await db.query('SELECT * FROM users');
// users.rows  → the array of rows
// users.sql   → the SQL string
// users.durationMs → round-trip time

// Get a single user
const user = await db.get('SELECT * FROM users WHERE id = ?', [1]);

// Get all matching rows
const activeUsers = await db.all('SELECT * FROM users WHERE active = ?', [true]);
```

### Execute Statements

```ts
// Insert a user
const insertedRows = await db.insert('INSERT INTO users(name, email) VALUES(?, ?)', ['Alice', 'alice@example.com']);

// Update users
const affectedRows = await db.update('UPDATE users SET active = ? WHERE id = ?', [true, 1]);

// Delete users
const deletedCount = await db.delete('DELETE FROM users WHERE id = ?', [1]);
```

### Manual Transactions

```ts
const transaction = await db.startTransaction();

try {
  // Execute statements within the transaction
  await transaction.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);

  await transaction.execute('INSERT INTO audit_logs(action, user_id) VALUES(?, ?)', ['activate', 1]);

  // Commit the transaction
  await transaction.commit();
} catch (error) {
  // Rollback on error
  await transaction.rollback();
  throw error;
}
```

### Automatic Transactions

```ts
// Automatically commits on success, rolls back on error
await db.transaction(async tx => {
  await tx.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);

  await tx.execute('INSERT INTO audit_logs(action, user_id) VALUES(?, ?)', ['activate', 1]);
});
```

### Query Builder

Build SQL queries fluently:

```ts
import { buildQuery } from '@catbee/mysql';

// SELECT queries
const query1 = buildQuery()
  .select('id', 'name', 'email')
  .from('users')
  .where('age', '>', 18)
  .and('active', '=', true)
  .orderBy('name', 'ASC')
  .limit(10);

const { sql, parameters } = query1.build();
const { rows: users } = await db.query(sql, parameters);

// INSERT queries
const query2 = buildQuery().insert('users', {
  name: 'Bob',
  email: 'bob@example.com',
  age: 30
});

const { sql: insertSql, parameters: insertParams } = query2.build();
await db.execute(insertSql, insertParams);

// UPDATE queries with WHERE clause
const query3 = buildQuery().update('users', { active: true }).where('age', '>', 18);

const { sql: updateSql, parameters: updateParams } = query3.build();
await db.execute(updateSql, updateParams);

// Complex SELECT with JOINs
const query4 = buildQuery()
  .select('u.id', 'u.name', 'p.title')
  .from('users u')
  .join('INNER', 'posts p', 'u.id = p.user_id')
  .where('u.active', '=', true)
  .groupBy('u.id')
  .having('post_count', '>', 5)
  .orderBy('p.created_at', 'DESC');

const { sql: selectSql, parameters: selectParams } = query4.build();
const { rows: results } = await db.query(selectSql, selectParams);

// IN / BETWEEN helpers
const query5 = buildQuery()
  .select('*')
  .from('users')
  .whereIn('role', ['admin', 'editor'])
  .andBetween('age', 18, 40);
```

### Convenience Methods in Transactions

```ts
await db.transaction(async tx => {
  // All convenience methods work in transactions too
  const user = await tx.get('SELECT * FROM users WHERE id = ?', [1]);
  const userId = user?.id;

  const insertedRows = await tx.insert('INSERT INTO users(name) VALUES(?)', ['Charlie']);

  if (userId) {
    const affected = await tx.update('UPDATE users SET last_login = NOW() WHERE id = ?', [userId]);
    console.log({ insertedRows, affected });
  }
});
```

## API Reference

### SqlClient

#### Static Methods

- `create(options: SqlClientOptions): Promise<SqlClient>` - Create a client with a single connection
- `createPool(options: PoolOptions): SqlClient` - Create a client with connection pooling

#### Instance Methods

- `use(fn: MiddlewareFn): this` - Register middleware (chainable)
- `query<T>(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<SqlQueryResult<T>>` - Execute a SELECT query
- `execute<T>(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<SqlExecuteResult<T>>` - Execute an INSERT/UPDATE/DELETE
- `raw<T>(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<T>` - Execute any SQL and return raw mysql2 result
- `queryNamed<T>(sql: string, namedParameters: Record<string, SqlValue>, options?: QueryExecutionOptions): Promise<SqlQueryResult<T>>` - SELECT with named params
- `executeNamed<T>(sql: string, namedParameters: Record<string, SqlValue>, options?: QueryExecutionOptions): Promise<SqlExecuteResult<T>>` - Statement with named params
- `get<T>(sql: string, parameters?: SqlParameters): Promise<T | null>` - Get a single row or null
- `all<T>(sql: string, parameters?: SqlParameters): Promise<T[]>` - Get all matching rows
- `exists(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<boolean>` - Return true if any rows match
- `count(sql: string, parameters?: SqlParameters, options?: QueryExecutionOptions): Promise<number>` - Return aggregate numeric value (COUNT, SUM, etc.)
- `insert(sql: string, parameters?: SqlParameters): Promise<number>` - Insert and get affected row count
- `update(sql: string, parameters?: SqlParameters, returnChangedRows?: boolean): Promise<number>` - Update and get affected count
- `delete(sql: string, parameters?: SqlParameters): Promise<number>` - Delete and get affected count
- `startTransaction(): Promise<SqlTransaction>` - Start a manual transaction
- `transaction<T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T>` - Execute callback in automatic transaction
- `ping(): Promise<boolean>` - Check connection health
- `close(): Promise<void>` - Close the connection/pool

### SqlTransaction

`SqlTransaction` supports SQL execution helpers and transaction controls.

Supported SQL helpers:

- `query<T>(sql: string, parameters?: SqlParameters): Promise<T>`
- `execute<T>(sql: string, parameters?: SqlParameters): Promise<T>`
- `get<T>(sql: string, parameters?: SqlParameters): Promise<T | null>`
- `all<T>(sql: string, parameters?: SqlParameters): Promise<T[]>`
- `insert(sql: string, parameters?: SqlParameters): Promise<number>`
- `update(sql: string, parameters?: SqlParameters, returnChangedRows?: boolean): Promise<number>`
- `delete(sql: string, parameters?: SqlParameters): Promise<number>`

- `exists(sql: string, parameters?: SqlParameters): Promise<boolean>` - Return true if any rows match
- `count(sql: string, parameters?: SqlParameters): Promise<number>` - Return aggregate numeric value
- `commit(): Promise<void>` - Commit the transaction
- `rollback(): Promise<void>` - Rollback the transaction
- `savepoint(name?: string): Promise<string>` - Create a transaction savepoint
- `rollbackTo(name: string): Promise<void>` - Roll back to a savepoint
- `releaseSavepoint(name: string): Promise<void>` - Release a savepoint

Not part of `SqlTransaction`: `use`, `raw`, `queryNamed`, `executeNamed`, `ping`, `startTransaction`, `transaction`, `close`.

### QueryBuilder

```ts
buildQuery()
  .select(...columns) // SELECT
  .insert(table, data) // INSERT
  .update(table, data) // UPDATE
  .delete(table) // DELETE
  .from(table) // FROM
  .where(column, operator, value) // WHERE
  .whereIn(column, values) // WHERE ... IN (...)
  .whereBetween(column, lower, upper) // WHERE ... BETWEEN ? AND ?
  .and(column, operator, value) // AND
  .andIn(column, values) // AND ... IN (...)
  .andBetween(column, lower, upper) // AND ... BETWEEN ? AND ?
  .or(column, operator, value) // OR
  .orIn(column, values) // OR ... IN (...)
  .orBetween(column, lower, upper) // OR ... BETWEEN ? AND ?
  .join(type, table, on, ...params) // JOIN
  .groupBy(...columns) // GROUP BY
  .having(column, operator, value) // HAVING
  .havingIn(column, values) // HAVING ... IN (...)
  .havingBetween(column, lower, upper) // HAVING ... BETWEEN ? AND ?
  .orderBy(column, direction) // ORDER BY
  .limit(count) // LIMIT
  .offset(count) // OFFSET
  .build() // Returns { sql, parameters }
  .getSql() // Returns SQL only
  .getParameters() // Returns parameters only
  .reset(); // Clear and start over
```

Notes:

- `operator` is one of `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`.
- `join(type, ...)` supports `INNER`, `LEFT`, and `RIGHT`.
- `whereIn`/`andIn`/`orIn`/`havingIn` require at least one value.

## Middleware

All `query()` and `execute()` calls pass through a composable middleware chain. Register middleware with `db.use()`:

```ts
// Timing
db.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  console.log(`${ctx.kind} took ${Date.now() - start}ms`);
});

// Error observability
db.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    myErrorTracker.capture(err, { sql: ctx.sql });
    throw err;
  }
});
```

The `MiddlewareContext` object is:

| Field        | Available      | Description              |
| ------------ | -------------- | ------------------------ |
| `kind`       | always         | `'query'` or `'execute'` |
| `sql`        | always         | SQL string               |
| `parameters` | always         | Bound values             |
| `attempt`    | always         | Retry attempt (0-based)  |
| `timeoutMs`  | always         | Active timeout if set    |
| `result`     | after `next()` | Raw DB result            |
| `durationMs` | after `next()` | Round-trip milliseconds  |
| `error`      | on failure     | The thrown error         |

## Events

`SqlClient` extends `EventEmitter`. Subscribe to query lifecycle events:

```ts
// After every successful query
db.on('query', result => {
  metrics.histogram('db.query.duration', result.durationMs);
});

// After every successful execute
db.on('execute', result => {
  metrics.histogram('db.execute.duration', result.durationMs);
});

// On any query/execute failure
db.on('error:query', ctx => {
  logger.error('DB error', { sql: ctx.sql, error: ctx.error });
});
```

## Query Result Objects

`query()` returns `SqlQueryResult<T>`:

```ts
const result = await db.query('SELECT * FROM users WHERE id = ?', [1]);
result.rows       // T — the returned rows
result.sql        // string — the SQL that was executed
result.parameters // SqlParameters — bound values
result.durationMs // number — round-trip time in ms
result.attempt    // number — retry attempt (0 = first try)
```

`execute()` returns `SqlExecuteResult<T>`:

```ts
const result = await db.execute('UPDATE users SET active = ? WHERE id = ?', [true, 1]);
result.result     // T — ResultSetHeader (affectedRows, insertId, etc.)
result.sql        // string
result.parameters // SqlParameters
result.durationMs // number
result.attempt    // number
```

## Resilience

- Retries are disabled by default (`retry.maxRetries = 0`).
- Retries can be enabled globally with `retry.maxRetries > 0`.
- `execute(...)` retries only when `{ idempotent: true }` is provided.
- Per-call retries can be disabled with `{ retry: false }`.
- Timeout and abort signal both trigger active connection termination for server-side cancellation.
- Optional strict statement enforcement is available with `enforceStatementKinds: true`:
  - `query(...)` accepts only `SELECT`
  - `execute(...)`/`executeNamed(...)` reject `SELECT`
  - `raw(...)` remains the any-SQL escape hatch

## Connection Options

All standard MySQL connection options are supported:

```ts
interface SqlClientOptions extends ConnectionOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  defaultQueryTimeoutMs?: number;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
    retryableErrorCodes?: readonly string[];
  };
  enforceStatementKinds?: boolean;
  // ... other mysql2 options
}

interface PoolOptions extends ConnectionOptions {
  defaultQueryTimeoutMs?: number;
  retry?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: boolean;
    retryableErrorCodes?: readonly string[];
  };
  enforceStatementKinds?: boolean;
  // Pool settings like connectionLimit/waitForConnections/queueLimit
  // are inherited from mysql2 ConnectionOptions.
}
```

## Date Handling

`SqlValue` allows `string | number | boolean | Buffer | null`.
`Date` parameter values are rejected at runtime.
Use `Buffer` for `BLOB`/`VARBINARY` columns.

**Important**: MySQL stores date/time values without full timezone context in common schemas. This client defaults MySQL connection timezone to `Z` (UTC). Use explicit UTC strings via date utilities for date/time columns.

### Why UTC?

- MySQL DATETIME columns don't store timezone info
- JavaScript `Date` values can be serialized differently when connection timezone is overridden
- Different environments (dev, staging, prod) may have different timezones
- **Result**: Dates stored without UTC handling become inconsistent across environments

### Using Date Utilities

Convert Date objects to UTC MySQL strings before writing, and parse strings when reading:

```ts
import { formatDateForMysql, parseMysqlDateTime, getCurrentUtcMysqlTimestamp } from '@catbee/mysql';

// Store a timestamp
const createdAt = formatDateForMysql(new Date());
await db.execute('INSERT INTO users(name, created_at) VALUES(?, ?)', ['Alice', createdAt]);

// Get current time for updates
const updatedAt = getCurrentUtcMysqlTimestamp();
await db.execute('UPDATE users SET updated_at = ? WHERE id = ?', [updatedAt, 1]);

// Retrieve and parse back to Date
const user = await db.get('SELECT * FROM users WHERE id = ?', [1]);
const createdDate = parseMysqlDateTime(user.created_at); // Now a Date object
console.log(createdDate.toISOString()); // UTC ISO string
```

### Date Utility Functions

- **`formatDateForMysql(date, includeMilliseconds?)`** - Convert Date to MySQL DATETIME string
- **`getCurrentUtcMysqlTimestamp(includeMilliseconds?)`** - Get current time as MySQL string
- **`parseMysqlDateTime(string)`** - Convert MySQL DATETIME string back to Date
- **`parseMysqlDate(string)`** - Parse MySQL DATE (date-only) strings
- **`parseMysqlTimestamp(string)`** - Parse MySQL TIMESTAMP strings
- **`formatDateOnly(date)`** - Format Date as MySQL DATE (YYYY-MM-DD)
- **`formatTimeOnly(date, includeMilliseconds?)`** - Format Date as MySQL TIME

### Examples

```ts
import {
  formatDateForMysql,
  formatDateOnly,
  formatTimeOnly,
  parseMysqlDateTime,
  getCurrentUtcMysqlTimestamp
} from '@catbee/mysql';

// Different date formats
const now = new Date('2024-01-15T12:30:45.789Z');

formatDateForMysql(now); // '2024-01-15 12:30:45'
formatDateForMysql(now, true); // '2024-01-15 12:30:45.789'
formatDateOnly(now); // '2024-01-15'
formatTimeOnly(now); // '12:30:45'
formatTimeOnly(now, true); // '12:30:45.789'

// Store with transaction
await db.transaction(async tx => {
  const insertedRows = await tx.insert('INSERT INTO users(name, created_at, email_verified_at) VALUES(?, ?, ?)', [
    'Bob',
    getCurrentUtcMysqlTimestamp(),
    formatDateForMysql(verificationDate, true)
  ]);

  return insertedRows;
});

// Retrieve and use
const user = await db.get('SELECT * FROM users WHERE id = ?', [1]);
const createdAt = parseMysqlDateTime(user.created_at);
const verifiedAt = user.email_verified_at ? parseMysqlDateTime(user.email_verified_at) : null;

// Convert to local timezone for display (only in presentation layer)
console.log(new Date(createdAt).toLocaleString()); // Local timezone display
```

### Best Practices

1. **Convert Date values before binding** - Use `formatDateForMysql()` instead of passing Date directly
2. **Use explicit UTC strings for writes** - Prefer UTC for `DATETIME`/`TIMESTAMP` consistency
3. **Parse when retrieving** - Use `parseMysqlDateTime()` when reading date/time strings
4. **Convert to local timezone only for display** - Not for storage or business logic
5. **Use milliseconds only when needed** - Most timestamps do not require them

---

1. **Always use parameterized queries** - Prevent SQL injection:

   ```ts
   // ✅ Good
   await db.query('SELECT * FROM users WHERE id = ?', [userId]);

   // ❌ Bad
   await db.query(`SELECT * FROM users WHERE id = ${userId}`);
   ```

2. **Use connection pooling in production** - Better resource utilization:

   ```ts
  const db = SqlClient.createPool({
     host: 'localhost',
     user: 'root',
     password: 'password',
     database: 'myapp',
     connectionLimit: 10
   });
   ```

3. **Close the connection when done**:

   ```ts
   await db.close();
   ```

4. **Use automatic transactions for safety** - Auto-rollback on error:

   ```ts
   // Preferred
   await db.transaction(async (tx) => {
     await tx.execute(...);
     await tx.execute(...);
   });

   // Manual if you need more control
   const tx = await db.startTransaction();
   try {
     // ...
     await tx.commit();
   } catch (e) {
     await tx.rollback();
     throw e;
   }
   ```

---

## 📚 Documentation

Full documentation and examples are available at:

<https://catbee.in/docs/@catbee/mysql/intro>

---

## Contributing

Contributions are welcome! Please see `CONTRIBUTING.md` for development setup, testing, and PR guidance.

---

## 📜 License

MIT © Catbee Technologies
