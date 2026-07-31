ALTER TABLE `storyline_context` ADD `extracted_through_order_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `storyline_segment` ADD `previous_context_order_index` integer;--> statement-breakpoint
UPDATE `storyline_context`
SET `extracted_through_order_index` = COALESCE((
	SELECT MAX(`segment`.`order_index`)
	FROM `storyline_segment` AS `segment`
	WHERE `segment`.`storyline_id` = `storyline_context`.`storyline_id`
		AND `segment`.`type` = 'generated'
		AND NOT (
			`segment`.`generation_mode` = 'dialogue'
			AND TRIM(`segment`.`text`) = '无事发生'
		)
), 0);--> statement-breakpoint
UPDATE `storyline_segment` AS `current`
SET `previous_context_order_index` = COALESCE((
	SELECT MAX(`previous`.`order_index`)
	FROM `storyline_segment` AS `previous`
	WHERE `previous`.`storyline_id` = `current`.`storyline_id`
		AND `previous`.`order_index` < `current`.`order_index`
		AND `previous`.`type` = 'generated'
		AND NOT (
			`previous`.`generation_mode` = 'dialogue'
			AND TRIM(`previous`.`text`) = '无事发生'
		)
), 0)
WHERE `current`.`type` = 'generated';
