import * as sqlite from 'sqlite3';
import {escapeSQLiteIdentifier} from '@databases/escape-identifier';
import sql, {SQLQuery, isSqlQuery, FormatConfig} from '@databases/sql';
import Mutex from './Mutex';
const Queue = require('then-queue');

export type {SQLQuery};
export {sql, isSqlQuery};

const sqliteFormat: FormatConfig = {
  escapeIdentifier: (str) => escapeSQLiteIdentifier(str),
  formatValue: (value) => ({placeholder: '?', value}),
};

export enum DatabaseConnectionMode {
  ReadOnly = sqlite.OPEN_READONLY,
  ReadWrite = sqlite.OPEN_READWRITE,
  // tslint:disable-next-line:no-bitwise
  ReadWriteCreate = sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE,
  // tslint:disable-next-line:no-bitwise
  ReadCreate = sqlite.OPEN_READONLY | sqlite.OPEN_CREATE,
  Create = sqlite.OPEN_CREATE,
}

export interface DatabaseConnectionOptions {
  /**
   * Sets the busy timeout. Must be a postive integer if provided.
   *
   * @see https://www.sqlite.org/c3ref/busy_timeout.html
   */
  busyTimeout?: number;
  /**
   * Defaults to DatabaseConnectionMode.ReadWriteCreate
   */
  mode?: DatabaseConnectionMode;
  /**
   * Enable long stack traces for debugging. This is global
   * and cannot be disabled once enabled.
   */
  verbose?: boolean;
}

export interface DatabaseTransaction {
  query(query: SQLQuery): Promise<any[]>;

  /**
   * @deprecated use queryStream
   */
  stream(query: SQLQuery): AsyncIterableIterator<any>;
  queryStream(query: SQLQuery): AsyncIterableIterator<any>;
}
export interface DatabaseConnection extends DatabaseTransaction {
  tx<T>(fn: (db: DatabaseTransaction) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}
class DatabaseTransactionImplementation implements DatabaseTransaction {
  private readonly _database: sqlite.Database;
  constructor(database: sqlite.Database) {
    this._database = database;
  }
  async query(query: SQLQuery) {
    if (!isSqlQuery(query)) {
      throw new Error('Expected query to be an SQLQuery');
    }
    return runQuery(query, this._database, async (fn) => fn());
  }

  /**
   * @deprecated use queryStream
   */
  stream(query: SQLQuery): AsyncIterableIterator<any> {
    return this.queryStream(query);
  }
  queryStream(query: SQLQuery): AsyncIterableIterator<any> {
    if (!isSqlQuery(query)) {
      throw new Error('Expected query to be an SQLQuery');
    }
    return runQueryStream(query, this._database, async (fn) => fn());
  }
}

export const IN_MEMORY = ':memory:';
class DatabaseConnectionImplementation implements DatabaseConnection {
  private readonly _database: sqlite.Database;
  private readonly _mutex = new Mutex();
  constructor(filename: string, options: DatabaseConnectionOptions = {}) {
    this._database = new sqlite.Database(filename, options.mode);
    if (options.verbose) {
      sqlite.verbose();
    }
    if (options.busyTimeout !== undefined) {
      this._database.configure('busyTimeout', options.busyTimeout);
    }
  }
  async query(query: SQLQuery) {
    if (!isSqlQuery(query)) {
      throw new Error('Expected query to be an SQLQuery');
    }
    return runQuery(query, this._database, async (fn) =>
      this._mutex.readLock(fn),
    );
  }

  /**
   * @deprecated use queryStream
   */
  stream(query: SQLQuery): AsyncIterableIterator<any> {
    return this.queryStream(query);
  }
  queryStream(query: SQLQuery): AsyncIterableIterator<any> {
    if (!isSqlQuery(query)) {
      throw new Error('Expected query to be an SQLQuery');
    }
    return runQueryStream(query, this._database, async (fn) =>
      this._mutex.readLock(fn),
    );
  }

  async tx<T>(fn: (db: DatabaseTransaction) => Promise<T>): Promise<T> {
    return this._mutex.writeLock(async () => {
      await new Promise<void>((resolve, reject) => {
        this._database.run('BEGIN', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      try {
        const result = fn(
          new DatabaseTransactionImplementation(this._database),
        );
        await new Promise<void>((resolve, reject) => {
          this._database.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return result;
      } catch (ex) {
        await new Promise<void>((resolve, reject) => {
          this._database.run('ROLLBACK', (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        throw ex;
      }
    });
  }

  async dispose() {
    await new Promise<void>((resolve, reject) => {
      this._database.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export default function connect(
  filename: string = IN_MEMORY,
  options: DatabaseConnectionOptions = {},
): DatabaseConnection {
  return new DatabaseConnectionImplementation(filename, options);
}
module.exports = Object.assign(connect, {
  default: connect,
  DatabaseConnectionMode,
  IN_MEMORY,
  sql,
  isSqlQuery,
});

async function runQuery(
  query: SQLQuery,
  database: sqlite.Database,
  lock: <T>(fn: () => Promise<T>) => Promise<T>,
) {
  const {text, values} = query.format(sqliteFormat);
  return lock(async () => {
    return await new Promise<any[]>((resolve, reject) => {
      database.all(text, values, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  });
}

interface Queue<T> {
  push(item: T): void;
  pop(): Promise<T>;
  /**
   * Amount of items in the queue
   * This can be negative if pop has been called more times than push.
   */
  length: number;
}
async function* runQueryStream(
  query: SQLQuery,
  database: sqlite.Database,
  lock: <T>(fn: () => Promise<T>) => Promise<T>,
): AsyncIterableIterator<any> {
  const queue: Queue<{done: false; value: any} | {done: true; err: any}> =
    new Queue();
  const {text, values} = query.format(sqliteFormat);
  lock(async () => {
    await new Promise<void>((releaseMutex) => {
      database.each(
        text,
        values,
        (err, row) => {
          if (err) queue.push({done: true, err});
          else queue.push({done: false, value: row});
        },
        (err) => {
          releaseMutex();
          queue.push({done: true, err});
        },
      );
    });
  }).catch((ex) => {
    setImmediate(() => {
      throw ex;
    });
  });
  let value = await queue.pop();
  while (!value.done) {
    yield value.value;
    value = await queue.pop();
  }
}
