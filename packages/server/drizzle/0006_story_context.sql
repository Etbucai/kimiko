ALTER TABLE `storyline_segment` ADD `previous_context_json` text;
--> statement-breakpoint
CREATE TABLE `storyline_context` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storyline_id` integer NOT NULL,
	`context_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`storyline_id`) REFERENCES `storyline`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storyline_context_storyline_id_unique` ON `storyline_context` (`storyline_id`);
