CREATE TABLE `storyline_context` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storyline_id` integer NOT NULL,
	`context_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`storyline_id`) REFERENCES `storyline`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storyline_context_storyline_id_unique` ON `storyline_context` (`storyline_id`);--> statement-breakpoint
CREATE TABLE `storyline_segment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storyline_id` integer NOT NULL,
	`order_index` integer NOT NULL,
	`type` text NOT NULL,
	`generation_mode` text DEFAULT 'append' NOT NULL,
	`text` text NOT NULL,
	`instruction` text,
	`model` text,
	`elapsed_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`target_length` integer,
	`previous_context_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`storyline_id`) REFERENCES `storyline`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storyline_segment_storyline_order_unique` ON `storyline_segment` (`storyline_id`,`order_index`);--> statement-breakpoint
CREATE INDEX `storyline_segment_storyline_id_idx` ON `storyline_segment` (`storyline_id`);--> statement-breakpoint
CREATE TABLE `storyline` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `storyline_user_id_updated_at_idx` ON `storyline` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `system_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_refresh_session` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_refresh_session_token_hash_unique` ON `user_refresh_session` (`token_hash`);--> statement-breakpoint
CREATE INDEX `user_refresh_session_user_id_idx` ON `user_refresh_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_refresh_session_expires_at_idx` ON `user_refresh_session` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`unique_name` text NOT NULL,
	`display_name` text NOT NULL,
	`password` text NOT NULL,
	`avatar_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_unique_name_unique` ON `user` (`unique_name`);