import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { env } from "@/lib/server/env";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

// Next.js re-evaluates modules on hot reload; keep one connection per process.
const globalForDb = globalThis as unknown as { __orsDb?: DB };

function open(): DB {
  fs.mkdirSync(env.dataDir, { recursive: true });
  const sqlite = new Database(path.join(env.dataDir, "studio.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

export function getDb(): DB {
  return (globalForDb.__orsDb ??= open());
}

export { schema };
