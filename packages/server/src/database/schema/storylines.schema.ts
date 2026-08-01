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

export const storySettings = sqliteTable(
  "story_setting",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index("story_setting_user_id_created_at_idx").on(
      table.userId,
      table.createdAt,
    ),
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
    chapterIndex: integer("chapter_index").notNull().default(1),
    type: text("type", { enum: ["initial", "generated"] }).notNull(),
    generationMode: text("generation_mode", {
      enum: ["append", "dialogue"],
    })
      .notNull()
      .default("append"),
    text: text("text").notNull(),
    instruction: text("instruction"),
    model: text("model"),
    elapsedMs: integer("elapsed_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    targetLength: integer("target_length"),
    previousContextJson: text("previous_context_json"),
    previousContextOrderIndex: integer("previous_context_order_index"),
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
    index("storyline_segment_storyline_chapter_order_idx").on(
      table.storylineId,
      table.chapterIndex,
      table.orderIndex,
    ),
  ],
);

export const storylineContexts = sqliteTable(
  "storyline_context",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    contextJson: text("context_json").notNull(),
    extractedThroughOrderIndex: integer("extracted_through_order_index")
      .notNull()
      .default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("storyline_context_storyline_id_unique").on(table.storylineId),
  ],
);

export type Storyline = InferSelectModel<typeof storylines>;
export type NewStoryline = InferInsertModel<typeof storylines>;
export type StorySetting = InferSelectModel<typeof storySettings>;
export type NewStorySetting = InferInsertModel<typeof storySettings>;
export type StorylineSegment = InferSelectModel<typeof storylineSegments>;
export type NewStorylineSegment = InferInsertModel<typeof storylineSegments>;
export type StorylineContext = InferSelectModel<typeof storylineContexts>;
export type NewStorylineContext = InferInsertModel<typeof storylineContexts>;
