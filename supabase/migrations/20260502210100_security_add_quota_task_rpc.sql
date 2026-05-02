-- 新增：按邀请码读额度、按任务 id+邀请码读任务状态（SECURITY DEFINER）
CREATE OR REPLACE FUNCTION public.get_generation_task_for_invitation(
  p_task_id uuid,
  p_invitation_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  c text := nullif(trim(p_invitation_code), '');
BEGIN
  IF p_task_id IS NULL OR c IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing parameters');
  END IF;

  SELECT gt.status, gt.image_url, gt.error_message, gt.progress
  INTO r
  FROM public.generation_tasks gt
  WHERE gt.id = p_task_id
    AND gt.invitation_code = c;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not found or access denied');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'status', r.status,
    'image_url', r.image_url,
    'error_message', r.error_message,
    'progress', r.progress
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_generation_task_for_invitation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_generation_task_for_invitation(uuid, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_generation_task_for_invitation(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_invitation_code_quota(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.invitation_codes%ROWTYPE;
  c text := nullif(trim(p_code), '');
BEGIN
  IF c IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing code');
  END IF;

  SELECT * INTO r FROM public.invitation_codes WHERE code = c;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'generation_quota', r.generation_quota,
    'used_count', r.used_count,
    'is_active', r.is_active
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_invitation_code_quota(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invitation_code_quota(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_invitation_code_quota(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
