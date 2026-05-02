-- 去掉过宽 RLS；收回 anon 对 invitation_codes / generation_tasks 的 SELECT；敏感 RPC 仅 service_role/postgres
DROP POLICY IF EXISTS "generation_tasks_select" ON public.generation_tasks;
DROP POLICY IF EXISTS "允许用户查看自己的任务" ON public.generation_tasks;

DROP POLICY IF EXISTS "Allow anon to read invitation_codes" ON public.invitation_codes;
DROP POLICY IF EXISTS "invitation_codes_select" ON public.invitation_codes;

REVOKE SELECT ON TABLE public.generation_tasks FROM anon;
REVOKE SELECT ON TABLE public.generation_tasks FROM authenticated;

REVOKE SELECT ON TABLE public.invitation_codes FROM anon;

REVOKE ALL ON FUNCTION public.increment_invitation_used_if_fits(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_invitation_used_if_fits(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.increment_invitation_used_if_fits(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_invitation_used_if_fits(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_invitation_used_if_fits(text, integer) TO postgres;

REVOKE ALL ON FUNCTION public.use_generation_quota(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.use_generation_quota(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.use_generation_quota(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.use_generation_quota(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.use_generation_quota(text, integer) TO postgres;

REVOKE ALL ON FUNCTION public.invoke_poll_image_tasks_from_cron() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_poll_image_tasks_from_cron() FROM anon;
REVOKE ALL ON FUNCTION public.invoke_poll_image_tasks_from_cron() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_poll_image_tasks_from_cron() TO postgres;

NOTIFY pgrst, 'reload schema';
