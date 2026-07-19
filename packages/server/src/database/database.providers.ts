import type { Provider } from "@nestjs/common";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ensureServerDirectoryForPath, Env, resolveServerPath } from "../env";
import { DRIZZLE_DB } from "./database.constants";
import type { DrizzleDatabase } from "./database.types";
import * as schema from "./schema";

function resolveDatabasePath(): string {
  if (Env.databaseUrl === ":memory:") {
    return Env.databaseUrl;
  }

  return resolveServerPath(Env.databaseUrl);
}

function createDatabase(): DrizzleDatabase {
  const databasePath = resolveDatabasePath();
  const migrationsFolder = resolveServerPath("drizzle");

  ensureServerDirectoryForPath(databasePath);

  const db = drizzle({
    connection: {
      source: databasePath,
    },
    schema,
  });

  migrate(db, { migrationsFolder });

  return db;
}

export const databaseProviders: Provider[] = [
  {
    provide: DRIZZLE_DB,
    useFactory: (): DrizzleDatabase => createDatabase(),
  },
];
