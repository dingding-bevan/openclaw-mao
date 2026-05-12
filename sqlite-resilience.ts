import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SqliteHandle {
  db: Database.Database;
  path: string;
}

export function openDb(path: string): SqliteHandle {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return { db, path };
}

export function migrate(handle: SqliteHandle, statements: string[]): void {
  const { db } = handle;
  db.exec("CREATE TABLE IF NOT EXISTS _mao_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = (db.prepare("SELECT MAX(version) AS v FROM _mao_schema").get() as { v: number | null }).v ?? 0;
  for (let i = current; i < statements.length; i++) {
    db.transaction(() => {
      db.exec(statements[i]);
      db.prepare("INSERT INTO _mao_schema (version, applied_at) VALUES (?, ?)").run(i + 1, new Date().toISOString());
    })();
  }
}
