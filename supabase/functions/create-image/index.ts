// @ts-nocheck Deno Edge — 由 Supabase CLI 部署校验
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APIMART_URL = "https://api.apimart.ai/v1/images/generations";
const FOUR_K_ALLOWED = new Set([
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "21:9",
  "9:21",
]);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeResolution(raw: string): "1k" | "2k" | "4k" {
  const r = (raw || "1k").toLowerCase().trim();
  if (r === "4k" || r === "2k" || r === "1k") return r;
  return "1k";
}

function requiredQuota(res: "1k" | "2k" | "4k"): number {
  if (res === "4k") return 3;
  if (res === "2k") return 2;
  return 1;
}

/** Apimart `size`：固定比例或 `auto`（由服务端自动选比例） */
function normalizeSize(aspect: string): string {
  const raw = (aspect || "1:1").trim();
  if (!raw) return "1:1";
  const lower = raw.toLowerCase();
  if (lower === "auto") return "auto";
  return raw;
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
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
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
        success: false,
        error: "Server misconfiguration",
        missing_secrets: missing,
        hint: "新密钥：平台注入 SUPABASE_SECRET_KEYS；或自建 SUPABASE_SECRET_KEY=sb_secret_...",
      },
      500,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const invitationCode = String(body.invitationCode ?? "").trim();
  const prompt = String(body.prompt ?? "").trim();
  const resolutionRaw = String(body.resolution ?? "1k");
  const aspectRatio = normalizeSize(String(body.aspectRatio ?? "1:1"));
  const imageUrls = Array.isArray(body.imageUrls)
    ? (body.imageUrls as unknown[]).filter((u) => typeof u === "string") as string[]
    : [];

  if (!invitationCode) {
    return jsonResponse({ success: false, error: "缺少 invitationCode" }, 400);
  }
  if (!prompt) {
    return jsonResponse({ success: false, error: "缺少 prompt" }, 400);
  }

  const resolution = normalizeResolution(resolutionRaw);
  const rq = requiredQuota(resolution);

  if (
    resolution === "4k" &&
    aspectRatio !== "auto" &&
    !FOUR_K_ALLOWED.has(aspectRatio)
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "4K 仅支持比例：16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21；或使用 auto 由模型自动选择",
      },
      400,
    );
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: invite, error: invErr } = await admin
    .from("invitation_codes")
    .select("code, generation_quota, used_count, is_active")
    .eq("code", invitationCode)
    .maybeSingle();

  if (invErr || !invite) {
    return jsonResponse({ success: false, error: "邀请码无效" }, 400);
  }
  if (!invite.is_active) {
    return jsonResponse({ success: false, error: "邀请码已被禁用" }, 400);
  }

  const remaining = invite.generation_quota - invite.used_count;
  if (remaining < rq) {
    return jsonResponse(
      {
        success: false,
        error: `额度不足：需要 ${rq} 点，当前剩余 ${remaining}`,
      },
      400,
    );
  }

  const apimartPayload: Record<string, unknown> = {
    model: "gpt-image-2",
    prompt,
    n: 1,
    size: aspectRatio,
    resolution,
  };
  if (imageUrls.length > 0) {
    apimartPayload.image_urls = imageUrls.slice(0, 16);
  }

  const apimartRes = await fetch(APIMART_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apimartKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(apimartPayload),
  });

  const apimartJson = await apimartRes.json().catch(() => ({}));

  if (!apimartRes.ok || apimartJson?.code !== 200) {
    const msg =
      apimartJson?.error?.message ||
      apimartJson?.message ||
      `Apimart 错误 HTTP ${apimartRes.status}`;
    return jsonResponse(
      {
        success: false,
        error: msg,
        code: apimartJson?.error?.code ?? apimartRes.status,
      },
      400,
    );
  }

  const first = Array.isArray(apimartJson?.data)
    ? apimartJson.data[0]
    : null;
  const taskId = first?.task_id as string | undefined;
  if (!taskId) {
    return jsonResponse(
      { success: false, error: "Apimart 未返回 task_id" },
      502,
    );
  }

  const nextPoll = new Date(Date.now() + 40_000).toISOString();

  // 参考图已在请求体中发给 Apimart；不落库，避免 data URL/base64 撑爆数据库
  const { data: inserted, error: insErr } = await admin
    .from("generation_tasks")
    .insert({
      invitation_code: invitationCode,
      prompt,
      resolution,
      aspect_ratio: aspectRatio,
      image_urls: null,
      api_task_id: taskId,
      status: "submitted",
      required_quota: rq,
      retry_count: 0,
      progress: 0,
      provider: "apimart",
      provider_status: first?.status ?? "submitted",
      next_poll_at: nextPoll,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insErr || !inserted?.id) {
    console.error("insert generation_tasks failed", insErr);
    return jsonResponse(
      { success: false, error: "写入任务失败，请稍后重试" },
      500,
    );
  }

  return jsonResponse({
    success: true,
    code: 200,
    dbTaskId: inserted.id,
    apimartTaskId: taskId,
    remainingQuota: remaining,
    quotaNote: "额度在任务成功完成后扣除；若失败不扣点",
    message: "任务已提交",
    data: [{ status: "submitted", task_id: taskId }],
  });
});
