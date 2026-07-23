import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./users.schema";

export const storylines = sqliteTable(
  "storyline",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("storyline_user_id_updated_at_idx").on(table.userId, table.updatedAt),
  ],
);

export const storylineSegments = sqliteTable(
  "storyline_segment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    orderIndex: integer("order_index").notNull(),
    type: text("type", { enum: ["initial", "generated"] }).notNull(),
    text: text("text").notNull(),
    instruction: text("instruction"),
    model: text("model"),
    elapsedMs: integer("elapsed_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    previousSummaryJson: text("previous_summary_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("storyline_segment_storyline_order_unique").on(
      table.storylineId,
      table.orderIndex,
    ),
    index("storyline_segment_storyline_id_idx").on(table.storylineId),
  ],
);

export const storylineSummaries = sqliteTable(
  "storyline_summary",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    charactersJson: text("characters_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("storyline_summary_storyline_id_unique").on(table.storylineId),
  ],
);

export type Storyline = InferSelectModel<typeof storylines>;
export type NewStoryline = InferInsertModel<typeof storylines>;
export type StorylineSegment = InferSelectModel<typeof storylineSegments>;
export type NewStorylineSegment = InferInsertModel<typeof storylineSegments>;
export type StorylineSummary = InferSelectModel<typeof storylineSummaries>;
export type NewStorylineSummary = InferInsertModel<typeof storylineSummaries>;
