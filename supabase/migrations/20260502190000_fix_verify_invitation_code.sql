-- 邀请码验证：与「额度型」生图一致，不再用 is_used 一次性封死；有剩余额度即可进入首页
CREATE OR REPLACE FUNCTION public.verify_invitation_code(code_to_check text, client_ip text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.invitation_codes%rowtype;
BEGIN
  SELECT * INTO v_row
  FROM public.invitation_codes
  WHERE code = code_to_check
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('valid', false, 'message', '邀请码无效');
  END IF;

  IF NOT v_row.is_active THEN
    RETURN json_build_object('valid', false, 'message', '邀请码已禁用');
  END IF;

  IF (v_row.generation_quota - v_row.used_count) < 1 THEN
    RETURN json_build_object('valid', false, 'message', '生图额度已用完');
  END IF;

  UPDATE public.invitation_codes
  SET used_by_ip = coalesce(client_ip, used_by_ip)
  WHERE id = v_row.id;

  RETURN json_build_object(
    'valid', true,
    'message', '验证成功',
    'remaining_quota', (v_row.generation_quota - v_row.used_count)
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
