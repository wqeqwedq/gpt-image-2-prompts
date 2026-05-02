-- pg_cron + pg_net：定时 POST 调用 Edge Function poll-image-tasks
--
-- 【一次性】在 SQL Editor 中先写入与 Edge Secrets 中 CRON_SECRET 相同的值（勿提交到 Git）：
--
--   SELECT vault.create_secret(
--     '这里填与 Edge 里 CRON_SECRET 完全相同的字符串',
--     'poll_image_tasks_cron',
--     'x-cron-secret for poll-image-tasks Edge Function',
--     NULL::uuid
--   );
--
-- 若 create_secret 的第四个参数不允许 NULL，可改为 Dashboard → Vault 里创建同名密钥。

CREATE OR REPLACE FUNCTION public.invoke_poll_image_tasks_from_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  secret text;
  req bigint;
BEGIN
  SELECT ds.decrypted_secret
  INTO secret
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'poll_image_tasks_cron'
  LIMIT 1;

  IF secret IS NULL OR btrim(secret) = '' THEN
    RAISE WARNING 'vault.decrypted_secrets: missing name poll_image_tasks_cron — run vault.create_secret first';
    RETURN;
  END IF;

  SELECT net.http_post(
    'https://vqubaohredxnfsbgstur.supabase.co/functions/v1/poll-image-tasks',
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    25000
  ) INTO req;
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_poll_image_tasks_from_cron() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invoke_poll_image_tasks_from_cron() TO postgres;

-- 幂等：先卸旧任务再注册
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'invoke-poll-image-tasks'
  LOOP
    PERFORM cron.unschedule(r.jobid);
  END LOOP;
END $$;

-- 每分钟一次（pg_cron 粒度一般为分钟；需要更高频可另开第二条错开 job 或改用外部调度）
SELECT cron.schedule(
  'invoke-poll-image-tasks',
  '* * * * *',
  $$SELECT public.invoke_poll_image_tasks_from_cron();$$
);
