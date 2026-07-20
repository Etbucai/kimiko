CREATE TABLE `storyline_segment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storyline_id` integer NOT NULL,
	`order_index` integer NOT NULL,
	`type` text NOT NULL,
	`text` text NOT NULL,
	`instruction` text,
	`model` text,
	`elapsed_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
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
CREATE INDEX `storyline_user_id_updated_at_idx` ON `storyline` (`user_id`,`updated_at`);