import { createConnection, createPool, type Connection, type Pool } from 'mysql2/promise';

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
  createPool: jest.fn()
}));

type MockConnection = jest.Mocked<
  Pick<Connection, 'beginTransaction' | 'commit' | 'end' | 'execute' | 'query' | 'rollback'>
> & {
  changeUser: jest.Mock;
  destroy: jest.Mock;
  release?: jest.Mock;
  reset: jest.Mock;
  unprepare: jest.Mock;
};

type MockPool = jest.Mocked<Pick<Pool, 'end' | 'execute' | 'getConnection' | 'query'>> & {
  destroy: jest.Mock;
  on: jest.Mock;
};

export const createMockConnection = (): MockConnection => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  changeUser: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  execute: jest.fn(),
  query: jest.fn(),
  reset: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  unprepare: jest.fn()
});

export const createMockPool = (): MockPool => ({
  destroy: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  on: jest.fn().mockReturnThis(),
  query: jest.fn()
});

export const mockedCreateConnection = jest.mocked(createConnection);
export const mockedCreatePool = jest.mocked(createPool);
