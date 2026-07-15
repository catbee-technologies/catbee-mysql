import {
  formatDateForMysql,
  getCurrentUtcMysqlTimestamp,
  parseMysqlDateTime,
  parseMysqlDate,
  parseMysqlTimestamp,
  formatDateOnly,
  formatTimeOnly
} from '../src';

describe('Date Utilities', () => {
  describe('formatDateForMysql', () => {
    it('formats a Date object to MySQL DATETIME string without milliseconds', () => {
      const date = new Date('2024-01-15T12:30:45.123Z');
      const result = formatDateForMysql(date);
      expect(result).toBe('2024-01-15 12:30:45');
    });

    it('formats a Date object to MySQL DATETIME string with milliseconds', () => {
      const date = new Date('2024-01-15T12:30:45.456Z');
      const result = formatDateForMysql(date, true);
      expect(result).toBe('2024-01-15 12:30:45.456');
    });

    it('handles dates at midnight UTC', () => {
      const date = new Date('2024-01-15T00:00:00.000Z');
      const result = formatDateForMysql(date);
      expect(result).toBe('2024-01-15 00:00:00');
    });

    it('handles dates at end of year', () => {
      const date = new Date('2024-12-31T23:59:59.999Z');
      const result = formatDateForMysql(date, true);
      expect(result).toBe('2024-12-31 23:59:59.999');
    });

    it('pads single-digit months and days with zero', () => {
      const date = new Date('2024-01-05T09:05:03.000Z');
      const result = formatDateForMysql(date);
      expect(result).toBe('2024-01-05 09:05:03');
    });
  });

  describe('getCurrentUtcMysqlTimestamp', () => {
    it('returns current time in MySQL DATETIME format', () => {
      const now = new Date();
      const result = getCurrentUtcMysqlTimestamp();

      // Should match the pattern YYYY-MM-DD HH:MM:SS
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      // Should be close to current time (within 1 second)
      const parsed = parseMysqlDateTime(result);
      const diff = Math.abs(now.getTime() - parsed.getTime());
      expect(diff).toBeLessThan(1000);
    });

    it('returns current time with milliseconds when requested', () => {
      const result = getCurrentUtcMysqlTimestamp(true);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    });
  });

  describe('parseMysqlDateTime', () => {
    it('parses MySQL DATETIME string to Date object', () => {
      const mysqlString = '2024-01-15 12:30:45';
      const result = parseMysqlDateTime(mysqlString);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-01-15T12:30:45.000Z');
    });

    it('parses MySQL DATETIME string with milliseconds', () => {
      const mysqlString = '2024-01-15 12:30:45.789';
      const result = parseMysqlDateTime(mysqlString);

      expect(result.toISOString()).toBe('2024-01-15T12:30:45.789Z');
    });

    it('throws error for invalid format', () => {
      expect(() => parseMysqlDateTime('2024-01-15')).toThrow('Invalid MySQL DATETIME format');
      expect(() => parseMysqlDateTime('not a date')).toThrow('Invalid MySQL DATETIME format');
      expect(() => parseMysqlDateTime('2024-13-01 12:30:45')).toThrow('Invalid month');
    });

    it('throws error for impossible calendar dates', () => {
      expect(() => parseMysqlDateTime('2024-02-30 12:30:45')).toThrow('Invalid date');
      expect(() => parseMysqlDateTime('2023-02-29 00:00:00')).toThrow('Invalid date');
    });

    it('throws error for out-of-range time components', () => {
      expect(() => parseMysqlDateTime('2024-01-15 24:00:00')).toThrow('Invalid hour');
      expect(() => parseMysqlDateTime('2024-01-15 12:60:00')).toThrow('Invalid minute');
      expect(() => parseMysqlDateTime('2024-01-15 12:30:60')).toThrow('Invalid second');
    });

    it('throws error when day is below 1', () => {
      expect(() => parseMysqlDateTime('2024-01-00 12:30:45')).toThrow('Invalid day');
    });

    it('handles edge case dates', () => {
      const midnight = parseMysqlDateTime('2024-01-01 00:00:00');
      expect(midnight.toISOString()).toBe('2024-01-01T00:00:00.000Z');

      const endOfYear = parseMysqlDateTime('2024-12-31 23:59:59');
      expect(endOfYear.toISOString()).toBe('2024-12-31T23:59:59.000Z');
    });
  });

  describe('parseMysqlDate', () => {
    it('parses MySQL DATE string to Date at midnight UTC', () => {
      const mysqlString = '2024-01-15';
      const result = parseMysqlDate(mysqlString);

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('throws error for invalid DATE format', () => {
      expect(() => parseMysqlDate('2024-01-15 12:30:45')).toThrow('Invalid MySQL DATE format');
      expect(() => parseMysqlDate('15-01-2024')).toThrow('Invalid MySQL DATE format');
    });

    it('throws error for impossible calendar DATE values', () => {
      expect(() => parseMysqlDate('2024-02-30')).toThrow('Invalid date');
      expect(() => parseMysqlDate('2023-02-29')).toThrow('Invalid date');
    });

    it('throws error for out-of-range DATE month/day values', () => {
      expect(() => parseMysqlDate('2024-00-15')).toThrow('Invalid month');
      expect(() => parseMysqlDate('2024-13-15')).toThrow('Invalid month');
      expect(() => parseMysqlDate('2024-01-00')).toThrow('Invalid day');
      expect(() => parseMysqlDate('2024-01-32')).toThrow('Invalid day');
    });
  });

  describe('parseMysqlTimestamp', () => {
    it('parses MySQL TIMESTAMP string to Date object', () => {
      const mysqlString = '2024-01-15 12:30:45';
      const result = parseMysqlTimestamp(mysqlString);

      expect(result.toISOString()).toBe('2024-01-15T12:30:45.000Z');
    });

    it('is equivalent to parseMysqlDateTime for TIMESTAMP format', () => {
      const mysqlString = '2024-06-15 18:45:30.123';
      const fromTimestamp = parseMysqlTimestamp(mysqlString);
      const fromDateTime = parseMysqlDateTime(mysqlString);

      expect(fromTimestamp.getTime()).toBe(fromDateTime.getTime());
    });
  });

  describe('formatDateOnly', () => {
    it('formats Date to MySQL DATE string (date part only)', () => {
      const date = new Date('2024-01-15T12:30:45.123Z');
      const result = formatDateOnly(date);
      expect(result).toBe('2024-01-15');
    });

    it('pads single-digit months and days', () => {
      const date = new Date('2024-03-05T12:30:45.000Z');
      const result = formatDateOnly(date);
      expect(result).toBe('2024-03-05');
    });

    it('handles year boundaries', () => {
      const date = new Date('2024-12-31T23:59:59.999Z');
      const result = formatDateOnly(date);
      expect(result).toBe('2024-12-31');
    });
  });

  describe('formatTimeOnly', () => {
    it('formats Date to MySQL TIME string without milliseconds', () => {
      const date = new Date('2024-01-15T12:30:45.123Z');
      const result = formatTimeOnly(date);
      expect(result).toBe('12:30:45');
    });

    it('formats Date to MySQL TIME string with milliseconds', () => {
      const date = new Date('2024-01-15T12:30:45.789Z');
      const result = formatTimeOnly(date, true);
      expect(result).toBe('12:30:45.789');
    });

    it('handles midnight', () => {
      const date = new Date('2024-01-15T00:00:00.000Z');
      const result = formatTimeOnly(date);
      expect(result).toBe('00:00:00');
    });

    it('handles end of day', () => {
      const date = new Date('2024-01-15T23:59:59.999Z');
      const result = formatTimeOnly(date, true);
      expect(result).toBe('23:59:59.999');
    });

    it('pads single-digit hours, minutes, and seconds', () => {
      const date = new Date('2024-01-15T09:05:03.000Z');
      const result = formatTimeOnly(date);
      expect(result).toBe('09:05:03');
    });
  });

  describe('Round-trip conversion', () => {
    it('converts Date → MySQL DATETIME → Date preserves UTC time', () => {
      const original = new Date('2024-06-15T14:30:45.123Z');
      const mysqlString = formatDateForMysql(original, true);
      const parsed = parseMysqlDateTime(mysqlString);

      expect(parsed.getTime()).toBe(original.getTime());
    });

    it('handles various dates without data loss', () => {
      const testDates = [
        new Date('2024-01-01T00:00:00.000Z'),
        new Date('2024-06-15T12:30:45.456Z'),
        new Date('2024-12-31T23:59:59.999Z'),
        new Date('2000-02-29T10:15:30.100Z') // Leap year
      ];

      for (const original of testDates) {
        const mysqlString = formatDateForMysql(original, true);
        const parsed = parseMysqlDateTime(mysqlString);
        expect(parsed.getTime()).toBe(original.getTime());
      }
    });
  });

  describe('Integration with database operations', () => {
    it('demonstrates storing and retrieving dates', () => {
      // Simulate storing
      const userCreatedAt = new Date('2024-01-15T10:30:00.500Z');
      const storedValue = formatDateForMysql(userCreatedAt, true);
      expect(storedValue).toBe('2024-01-15 10:30:00.500');

      // Simulate retrieving
      const retrieved = parseMysqlDateTime(storedValue);
      expect(retrieved.getTime()).toBe(userCreatedAt.getTime());
      expect(retrieved.toISOString()).toBe('2024-01-15T10:30:00.500Z');
    });

    it('works with query builder for current timestamp', () => {
      // Simulating: INSERT INTO users (name, created_at) VALUES (?, ?)
      const createdAt = getCurrentUtcMysqlTimestamp();

      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      // When retrieved, can be parsed back
      const parsed = parseMysqlDateTime(createdAt);
      expect(parsed).toBeInstanceOf(Date);
    });
  });
});
