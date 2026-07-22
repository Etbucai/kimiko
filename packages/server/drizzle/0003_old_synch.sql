CREATE TABLE `storyline_summary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storyline_id` integer NOT NULL,
	`characters_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`storyline_id`) REFERENCES `storyline`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storyline_summary_storyline_id_unique` ON `storyline_summary` (`storyline_id`);