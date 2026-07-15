/**
 * Date utilities for MySQL operations with explicit UTC handling.
 *
 * Why UTC? MySQL stores DATETIME as strings without timezone info.
 * To avoid timezone-related bugs, we:
 * 1. Always store dates in UTC format
 * 2. Always read dates assuming UTC
 * 3. Convert to local timezone only in presentation layer
 *
 * @example
 * // Store a date (will be stored as UTC in MySQL)
 * const timestamp = formatDateForMysql(new Date());
 * await db.execute(
 *   'INSERT INTO events(created_at) VALUES(?)',
 *   [timestamp]
 * );
 *
 * // Retrieve and parse back to Date
 * const event = await db.get('SELECT created_at FROM events WHERE id = ?', [1]);
 * const date = parseMysqlDateTime(event.created_at); // Back to Date object
 */

/**
 * Format a Date object as a MySQL DATETIME string in UTC.
 *
 * @param date - The Date object to format
 * @param includeMilliseconds - Include milliseconds in the output (default: false)
 * @returns MySQL DATETIME string in UTC format
 *
 * @example
 * formatDateForMysql(new Date('2024-01-15T12:30:45.123Z'))
 * // Returns: '2024-01-15 12:30:45' or '2024-01-15 12:30:45.123'
 */
export function formatDateForMysql(date: Date, includeMilliseconds = false): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  const hours = `${date.getUTCHours()}`.padStart(2, '0');
  const minutes = `${date.getUTCMinutes()}`.padStart(2, '0');
  const seconds = `${date.getUTCSeconds()}`.padStart(2, '0');

  const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

  if (includeMilliseconds) {
    const milliseconds = `${date.getUTCMilliseconds()}`.padStart(3, '0');
    return `${timestamp}.${milliseconds}`;
  }

  return timestamp;
}

/**
 * Get current time as a MySQL DATETIME string in UTC.
 *
 * @param includeMilliseconds - Include milliseconds in the output (default: false)
 * @returns Current time in MySQL DATETIME format (UTC)
 *
 * @example
 * const now = getCurrentUtcMysqlTimestamp();
 * await db.execute(
 *   'UPDATE users SET updated_at = ? WHERE id = ?',
 *   [now, userId]
 * );
 */
export function getCurrentUtcMysqlTimestamp(includeMilliseconds = false): string {
  return formatDateForMysql(new Date(), includeMilliseconds);
}

/**
 * Parse a MySQL DATETIME string back to a Date object.
 * Assumes the input is in UTC (as stored by formatDateForMysql).
 *
 * @param mysqlDatetimeString - MySQL DATETIME string (e.g., '2024-01-15 12:30:45')
 * @returns Date object in UTC
 * @throws Error if the string is not in a valid MySQL DATETIME format
 *
 * @example
 * const date = parseMysqlDateTime('2024-01-15 12:30:45');
 * console.log(date.toISOString()); // 2024-01-15T12:30:45.000Z
 */
export function parseMysqlDateTime(mysqlDatetimeString: string): Date {
  // MySQL DATETIME format: YYYY-MM-DD HH:MM:SS or YYYY-MM-DD HH:MM:SS.mmm
  const regex = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/;
  const match = mysqlDatetimeString.match(regex);

  if (!match) {
    throw new Error(
      `Invalid MySQL DATETIME format: "${mysqlDatetimeString}". Expected: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD HH:MM:SS.mmm"`
    );
  }

  const [, year, month, day, hours, minutes, seconds, milliseconds] = match;
  const yearNum = parseInt(year, 10);
  const monthNum = parseInt(month, 10);
  const dayNum = parseInt(day, 10);
  const hoursNum = parseInt(hours, 10);
  const minutesNum = parseInt(minutes, 10);
  const secondsNum = parseInt(seconds, 10);
  const millisecondsNum = parseInt((milliseconds || '000').padEnd(3, '0'), 10);

  // Validate ranges
  if (monthNum < 1 || monthNum > 12) {
    throw new Error(`Invalid month: ${monthNum}. Must be between 01 and 12.`);
  }

  if (dayNum < 1 || dayNum > 31) {
    throw new Error(`Invalid day: ${dayNum}. Must be between 01 and 31.`);
  }

  if (hoursNum < 0 || hoursNum > 23) {
    throw new Error(`Invalid hour: ${hoursNum}. Must be between 00 and 23.`);
  }

  if (minutesNum < 0 || minutesNum > 59) {
    throw new Error(`Invalid minute: ${minutesNum}. Must be between 00 and 59.`);
  }

  if (secondsNum < 0 || secondsNum > 59) {
    throw new Error(`Invalid second: ${secondsNum}. Must be between 00 and 59.`);
  }

  // Construct ISO string and parse as UTC
  const isoString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${(milliseconds || '000').padEnd(3, '0')}Z`;
  const date = new Date(isoString);

  // Verify the date is valid (Date constructor doesn't throw on invalid dates)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: "${mysqlDatetimeString}" does not represent a valid date.`);
  }

  // Prevent JS Date normalization accepting impossible calendar values.
  if (
    date.getUTCFullYear() !== yearNum ||
    date.getUTCMonth() + 1 !== monthNum ||
    date.getUTCDate() !== dayNum ||
    date.getUTCHours() !== hoursNum ||
    date.getUTCMinutes() !== minutesNum ||
    date.getUTCSeconds() !== secondsNum ||
    date.getUTCMilliseconds() !== millisecondsNum
  ) {
    throw new Error(`Invalid date: "${mysqlDatetimeString}" does not represent a valid calendar date/time.`);
  }

  return date;
}

/**
 * Parse a MySQL DATE string (YYYY-MM-DD) back to a Date object at midnight UTC.
 *
 * @param mysqlDateString - MySQL DATE string (e.g., '2024-01-15')
 * @returns Date object at midnight UTC
 * @throws Error if the string is not in a valid MySQL DATE format
 *
 * @example
 * const date = parseMysqlDate('2024-01-15');
 * console.log(date.toISOString()); // 2024-01-15T00:00:00.000Z
 */
export function parseMysqlDate(mysqlDateString: string): Date {
  const regex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = mysqlDateString.match(regex);

  if (!match) {
    throw new Error(`Invalid MySQL DATE format: "${mysqlDateString}". Expected: "YYYY-MM-DD"`);
  }

  const [, year, month, day] = match;
  const yearNum = parseInt(year, 10);
  const monthNum = parseInt(month, 10);
  const dayNum = parseInt(day, 10);

  // Validate ranges
  if (monthNum < 1 || monthNum > 12) {
    throw new Error(`Invalid month: ${monthNum}. Must be between 01 and 12.`);
  }

  if (dayNum < 1 || dayNum > 31) {
    throw new Error(`Invalid day: ${dayNum}. Must be between 01 and 31.`);
  }

  const isoString = `${year}-${month}-${day}T00:00:00.000Z`;
  const date = new Date(isoString);

  // Verify the date is valid
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: "${mysqlDateString}" does not represent a valid date.`);
  }

  if (date.getUTCFullYear() !== yearNum || date.getUTCMonth() + 1 !== monthNum || date.getUTCDate() !== dayNum) {
    throw new Error(`Invalid date: "${mysqlDateString}" does not represent a valid calendar date.`);
  }

  return date;
}

/**
 * Parse a MySQL TIMESTAMP string back to a Date object.
 * MySQL TIMESTAMP values are automatically stored in UTC.
 *
 * @param mysqlTimestampString - MySQL TIMESTAMP string
 * @returns Date object in UTC
 * @throws Error if the string is not in a valid MySQL TIMESTAMP format
 *
 * @example
 * const date = parseMysqlTimestamp('2024-01-15 12:30:45');
 */
export function parseMysqlTimestamp(mysqlTimestampString: string): Date {
  // TIMESTAMP format is the same as DATETIME
  return parseMysqlDateTime(mysqlTimestampString);
}

/**
 * Convert a Date to a MySQL DATE string (just the date part, no time).
 *
 * @param date - The Date object to format
 * @returns MySQL DATE string in UTC
 *
 * @example
 * formatDateOnly(new Date('2024-01-15T12:30:45Z'))
 * // Returns: '2024-01-15'
 */
export function formatDateOnly(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert a Date to a MySQL TIME string (just the time part, no date).
 *
 * @param date - The Date object to extract time from
 * @param includeMilliseconds - Include milliseconds in the output (default: false)
 * @returns MySQL TIME string
 *
 * @example
 * formatTimeOnly(new Date('2024-01-15T12:30:45.123Z'))
 * // Returns: '12:30:45' or '12:30:45.123'
 */
export function formatTimeOnly(date: Date, includeMilliseconds = false): string {
  const hours = `${date.getUTCHours()}`.padStart(2, '0');
  const minutes = `${date.getUTCMinutes()}`.padStart(2, '0');
  const seconds = `${date.getUTCSeconds()}`.padStart(2, '0');

  const time = `${hours}:${minutes}:${seconds}`;

  if (includeMilliseconds) {
    const milliseconds = `${date.getUTCMilliseconds()}`.padStart(3, '0');
    return `${time}.${milliseconds}`;
  }

  return time;
}
