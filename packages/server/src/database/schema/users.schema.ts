import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "user",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uniqueName: text("unique_name").notNull(),
    displayName: text("display_name").notNull(),
    password: text("password").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("user_unique_name_unique").on(table.uniqueName)],
);

export const userRefreshSessions = sqliteTable(
  "user_refresh_session",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_refresh_session_token_hash_unique").on(table.tokenHash),
    index("user_refresh_session_user_id_idx").on(table.userId),
    index("user_refresh_session_expires_at_idx").on(table.expiresAt),
  ],
);

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type UserRefreshSession = InferSelectModel<typeof userRefreshSessions>;
export type NewUserRefreshSession = InferInsertModel<
  typeof userRefreshSessions
>;
