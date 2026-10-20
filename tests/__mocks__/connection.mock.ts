import { createConnection, createPool, type Connection, type Pool } from 'mysql2/promise';

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
  createPool: jest.fn()
}));

type MockConnection = jest.Mocked<
  Pick<Connection, 'beginTransaction' | 'commit' | 'end' | 'execute' | 'query' | 'rollback'>
> & {
  destroy?: jest.Mock;
  release?: jest.Mock;
};

type MockPool = jest.Mocked<Pick<Pool, 'end' | 'execute' | 'getConnection' | 'query'>>;

export const createMockConnection = (): MockConnection => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  execute: jest.fn(),
  query: jest.fn(),
  rollback: jest.fn().mockResolvedValue(undefined)
});

export const createMockPool = (): MockPool => ({
  execute: jest.fn(),
  getConnection: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  query: jest.fn()
});

export const mockedCreateConnection = jest.mocked(createConnection);
export const mockedCreatePool = jest.mocked(createPool);
