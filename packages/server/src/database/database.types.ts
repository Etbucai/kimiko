import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema";

export type DrizzleDatabase = BetterSQLite3Database<typeof schema>;
