-- 触发器 trg_invitation_codes_updated_at 调用 set_updated_at()，依赖列 updated_at
ALTER TABLE public.invitation_codes
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.invitation_codes
SET updated_at = coalesce(used_at, now())
WHERE updated_at IS NULL;
