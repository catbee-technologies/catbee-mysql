import { createMockConnection, mockedCreateConnection } from './__mocks__/connection.mock';
import { buildQuery, SqlClient } from '../src';
import type { Connection } from 'mysql2/promise';

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
    const query = buildQuery().select('*').from('users').reset().insert('posts', { title: 'Hello', content: 'World' });

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

  it('supports table references with optional AS keyword for alias', () => {
    const { sql: sqlFrom } = buildQuery().select('*').from('users AS u').build();
    expect(sqlFrom).toBe('SELECT * FROM `users` `u`');

    const { sql: sqlJoin } = buildQuery()
      .select('u.id', 'p.title')
      .from('schema.users as u')
      .join('LEFT', 'schema.posts AS p', 'u.id = p.user_id')
      .build();
    expect(sqlJoin).toBe(
      'SELECT u.id, p.title FROM `schema`.`users` `u` LEFT JOIN `schema`.`posts` `p` ON u.id = p.user_id'
    );
  });

  it('automatically uses AND when where(), whereIn(), or whereBetween() are called repeatedly', () => {
    const query = buildQuery()
      .select('*')
      .from('users')
      .where('age', '>', 18)
      .where('active', '=', true)
      .whereIn('role', ['admin', 'editor'])
      .whereBetween('score', 80, 100);

    const { sql, parameters } = query.build();
    expect(sql).toBe(
      'SELECT * FROM `users` WHERE `age` > ? AND `active` = ? AND `role` IN (?, ?) AND `score` BETWEEN ? AND ?'
    );
    expect(parameters).toEqual([18, true, 'admin', 'editor', 80, 100]);
  });
});
