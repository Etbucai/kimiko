ALTER TABLE `storyline_segment` ADD `chapter_index` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
WITH `chapter_number` AS (
	SELECT
		`id`,
		SUM(
			CASE
				WHEN `type` = 'initial' OR `generation_mode` = 'append' THEN 1
				ELSE 0
			END
		) OVER (
			PARTITION BY `storyline_id`
			ORDER BY `order_index`
		) AS `chapter_index`
	FROM `storyline_segment`
)
UPDATE `storyline_segment`
SET `chapter_index` = (
	SELECT `chapter_number`.`chapter_index`
	FROM `chapter_number`
	WHERE `chapter_number`.`id` = `storyline_segment`.`id`
);--> statement-breakpoint
CREATE INDEX `storyline_segment_storyline_chapter_order_idx` ON `storyline_segment` (`storyline_id`,`chapter_index`,`order_index`);
