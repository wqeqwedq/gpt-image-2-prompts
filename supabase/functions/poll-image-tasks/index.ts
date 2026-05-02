// @ts-nocheck Deno Edge — 由 Supabase CLI 部署校验
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** 每 30s 一次 cron；40 次 ≈ 20 分钟（改为 60 则约 30 分钟） */
const MAX_POLL_ATTEMPTS = 40;
const BATCH_LIMIT = 20;
const NEXT_INTERVAL_MS = 30_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractImageUrl(data: Record<string, unknown>): string | null {
  const result = data?.result as Record<string, unknown> | undefined;
  const images = result?.images as unknown[] | undefined;
  if (!images?.[0]) return null;
  const img0 = images[0] as Record<string, unknown>;
  const urlArr = img0?.url as unknown[] | undefined;
  if (urlArr?.[0] && typeof urlArr[0] === "string") return urlArr[0];
  return null;
}

/** 新版 Default secrets 用 SUPABASE_SECRET_KEYS；旧版为 SUPABASE_SERVICE_ROLE_KEY */
function getServiceRoleKey(): string | null {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy?.trim()) return legacy.trim();

  const single = Deno.env.get("SUPABASE_SECRET_KEY");
  if (single?.trim()) return single.trim();

  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw?.trim()) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    if (obj.default?.trim()) return obj.default.trim();
    const v = Object.values(obj).find((x) => typeof x === "string" && String(x).trim());
    return v ? String(v).trim() : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const header = req.headers.get("x-cron-secret");
  if (!cronSecret || header !== cronSecret) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const apimartKey = Deno.env.get("APIMART_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getServiceRoleKey();

  if (!apimartKey || !supabaseUrl || !serviceKey) {
    const missing: string[] = [];
    if (!apimartKey) missing.push("APIMART_API_KEY");
    if (!supabaseUrl) missing.push("SUPABASE_URL");
    if (!serviceKey) {
      missing.push(
        "SUPABASE_SERVICE_ROLE_KEY（旧）或 SUPABASE_SECRET_KEYS / SUPABASE_SECRET_KEY（新）",
      );
    }
    return jsonResponse(
      {
        ok: false,
        error: "Server misconfiguration",
        missing_secrets: missing,
        hint: "新密钥体系：平台会注入 SUPABASE_SECRET_KEYS（JSON）；一般无需手写。若仍缺，到 Project Settings → API 创建 secret key，并自建 Secret SUPABASE_SECRET_KEY=sb_secret_... 或沿用旧 SERVICE_ROLE（不推荐）",
      },
      500,
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowIso = new Date().toISOString();

  const { data: rows, error: selErr } = await admin
    .from("generation_tasks")
    .select("*")
    .in("status", ["pending", "submitted", "processing"])
    .not("api_task_id", "is", null)
    .lte("next_poll_at", nowIso)
    .lt("retry_count", MAX_POLL_ATTEMPTS)
    .order("next_poll_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (selErr) {
    console.error("poll select error", selErr);
    return jsonResponse({ ok: false, error: selErr.message }, 500);
  }

  const processed: string[] = [];
  const errors: string[] = [];

  for (const row of rows ?? []) {
    const id = row.id as string;
    const apiTaskId = row.api_task_id as string;
    const invitationCode = row.invitation_code as string;
    const requiredQuota = row.required_quota as number;

    try {
      const taskUrl =
        `https://api.apimart.ai/v1/tasks/${encodeURIComponent(apiTaskId)}`;
      const apimartRes = await fetch(taskUrl, {
        headers: {
          Authorization: `Bearer ${apimartKey}`,
          Accept: "application/json",
        },
      });
      const body = await apimartRes.json().catch(() => ({}));
      const data = body?.data as Record<string, unknown> | undefined;
      const pStatus = (data?.status as string) ?? "";
      const progress = typeof data?.progress === "number" ? data.progress : null;
      const actualTime = typeof data?.actual_time === "number"
        ? data.actual_time
        : null;

      if (!apimartRes.ok || (body as { code?: number })?.code !== 200) {
        const msg =
          (body as { error?: { message?: string } })?.error?.message ||
          `HTTP ${apimartRes.status}`;
        await admin
          .from("generation_tasks")
          .update({
            status: "failed",
            error_message: msg,
            finished_at: new Date().toISOString(),
            last_polled_at: nowIso,
            provider_status: pStatus || null,
          })
          .eq("id", id);
        processed.push(id);
        continue;
      }

      if (pStatus === "completed") {
        const imageUrl = data ? extractImageUrl(data) : null;
        if (!imageUrl) {
          await admin
            .from("generation_tasks")
            .update({
              status: "failed",
              error_message: "完成但未解析到图片 URL",
              finished_at: new Date().toISOString(),
              last_polled_at: nowIso,
              provider_status: pStatus,
            })
            .eq("id", id);
          processed.push(id);
          continue;
        }

        const { data: updatedRows, error: updTaskErr } = await admin
          .from("generation_tasks")
          .update({
            status: "completed",
            image_url: imageUrl,
            progress: progress ?? 100,
            actual_time: actualTime,
            completed_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            last_polled_at: nowIso,
            provider_status: pStatus,
          })
          .eq("id", id)
          .in("status", ["pending", "submitted", "processing"])
          .select("id");

        if (updTaskErr) {
          errors.push(`${id}: ${updTaskErr.message}`);
          continue;
        }
        if (!updatedRows?.length) {
          processed.push(id);
          continue;
        }

        const { data: quotaRes, error: quotaErr } = await admin.rpc(
          "increment_invitation_used_if_fits",
          { p_code: invitationCode, p_delta: requiredQuota },
        );

        let qr = quotaRes as Record<string, unknown> | null;
        if (typeof qr === "string") {
          try {
            qr = JSON.parse(qr) as Record<string, unknown>;
          } catch {
            qr = null;
          }
        }

        if (quotaErr || !qr || qr.success !== true) {
          console.error(
            "quota increment after completion failed",
            quotaErr,
            quotaRes,
          );
          await admin
            .from("generation_tasks")
            .update({
              error_message:
                (quotaRes as { message?: string } | null)?.message ||
                "任务已完成但额度同步失败，请联系管理员",
            })
            .eq("id", id);
        }

        processed.push(id);
        continue;
      }

      if (pStatus === "failed") {
        const errMsg =
          (data?.error as { message?: string } | undefined)?.message ||
          "第三方任务失败";
        await admin
          .from("generation_tasks")
          .update({
            status: "failed",
            error_message: errMsg,
            finished_at: new Date().toISOString(),
            last_polled_at: nowIso,
            provider_status: pStatus,
          })
          .eq("id", id);
        processed.push(id);
        continue;
      }

      const nextPoll = new Date(Date.now() + NEXT_INTERVAL_MS).toISOString();
      const newRetry = (row.retry_count as number) + 1;

      if (newRetry >= MAX_POLL_ATTEMPTS) {
        await admin
          .from("generation_tasks")
          .update({
            status: "failed",
            error_message: "轮询超时，请稍后重试或联系管理员",
            finished_at: new Date().toISOString(),
            last_polled_at: nowIso,
            retry_count: newRetry,
            provider_status: pStatus,
          })
          .eq("id", id);
      } else {
        let dbStatus = row.status as string;
        if (pStatus === "processing") dbStatus = "processing";
        else if (pStatus === "submitted") dbStatus = "submitted";

        await admin
          .from("generation_tasks")
          .update({
            status: dbStatus,
            progress: progress ?? (row.progress as number) ?? 0,
            actual_time: actualTime ?? (row.actual_time as number | null),
            last_polled_at: nowIso,
            next_poll_at: nextPoll,
            retry_count: newRetry,
            provider_status: pStatus,
          })
          .eq("id", id);
      }
      processed.push(id);
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message}`);
    }
  }

  return jsonResponse({
    ok: true,
    scanned: rows?.length ?? 0,
    processed,
    errors: errors.length ? errors : undefined,
  });
});
