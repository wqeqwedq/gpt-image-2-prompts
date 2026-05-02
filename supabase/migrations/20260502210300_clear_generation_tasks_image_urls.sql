-- 历史数据：曾将参考图 base64 写入 image_urls，清空以释放空间（新任务由 Edge 不再写入）
UPDATE public.generation_tasks
SET image_urls = NULL
WHERE image_urls IS NOT NULL;
