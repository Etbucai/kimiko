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