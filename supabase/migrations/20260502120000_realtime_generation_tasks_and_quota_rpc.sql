-- Realtime：前端可订阅 generation_tasks（幂等）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'generation_tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.generation_tasks;
  END IF;
END $$;

-- 任务完成后原子增加 used_count（仅当仍不超过 generation_quota）
CREATE OR REPLACE FUNCTION public.increment_invitation_used_if_fits(
  p_code text,
  p_delta integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used int;
  v_quota int;
BEGIN
  IF p_delta IS NULL OR p_delta < 1 THEN
    RETURN jsonb_build_object('success', false, 'message', 'invalid delta');
  END IF;

  UPDATE invitation_codes ic
  SET used_count = ic.used_count + p_delta
  WHERE ic.code = p_code
    AND ic.is_active = true
    AND ic.used_count + p_delta <= ic.generation_quota
  RETURNING ic.used_count, ic.generation_quota INTO v_used, v_quota;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'message', 'quota insufficient or code invalid');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'used_count', v_used,
    'generation_quota', v_quota,
    'remaining', v_quota - v_used
  );
END;
$$;

REVOKE ALL ON FUNCTION public.increment_invitation_used_if_fits(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_invitation_used_if_fits(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_invitation_used_if_fits(text, integer) TO postgres;
