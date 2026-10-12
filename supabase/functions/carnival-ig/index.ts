// Carnival IG Auto — publishing engine (Instagram API with Instagram Login)
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const BUCKET = "carnival-ig-media";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-key, x-cron-key, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const text = (t: string, s = 200) =>
  new Response(t, { status: s, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });

async function kv(k: string): Promise<string | null> {
  const { data } = await sb.from("cig_kv").select("v").eq("k", k).maybeSingle();
  return data?.v ?? null;
}
async function setKv(k: string, v: string) {
  await sb.from("cig_kv").upsert({ k, v, updated_at: new Date().toISOString() });
}
async function log(msg: string, level = "info") {
  await sb.from("cig_log").insert({ msg: msg.slice(0, 2000), level });
}

// ---------- Graph API ----------
async function graph(path: string, method = "GET", body?: Record<string, unknown>, tokenOverride?: string) {
  const token = tokenOverride ?? (await kv("ig_token"));
  if (!token) throw new Error("Instagram token set केलेला नाही");
  const ver = (await kv("graph_version")) ?? "v25.0";
  const url = new URL(`https://graph.instagram.com/${ver}/${path}`);
  url.searchParams.set("access_token", token);
  if (method === "GET" && body) for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" && body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j as any).error) throw new Error((j as any).error?.message ?? `HTTP ${r.status}`);
  return j as any;
}

async function refreshTokenIfNeeded() {
  const token = await kv("ig_token");
  const at = await kv("token_set_at");
  if (!token || !at) return;
  const ageDays = (Date.now() - Date.parse(at)) / 86400000;
  if (ageDays < 20) return;
  const r = await fetch(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  );
  const j = await r.json();
  if (j.access_token) {
    await setKv("ig_token", j.access_token);
    await setKv("token_set_at", new Date().toISOString());
    await log("Token refreshed");
  } else await log("Token refresh failed: " + JSON.stringify(j.error ?? j), "error");
}

// ---------- Publishing ----------
const isVideo = (u: string) => /\.(mp4|mov)(\?|$)/i.test(u);

async function startPost(p: any) {
  const igId = await kv("ig_user_id");
  if (p.media_type === "REELS") {
    const c = await graph(`${igId}/media`, "POST", {
      media_type: "REELS", video_url: p.media_urls[0], caption: p.caption, share_to_feed: true,
    });
    return { container_id: c.id, status: "processing" };
  }
  if (p.media_type === "STORIES") {
    const u = p.media_urls[0];
    const c = await graph(`${igId}/media`, "POST",
      isVideo(u) ? { media_type: "STORIES", video_url: u } : { media_type: "STORIES", image_url: u });
    return { container_id: c.id, status: "processing" };
  }
  if (p.media_type === "IMAGE") {
    const c = await graph(`${igId}/media`, "POST", { image_url: p.media_urls[0], caption: p.caption });
    return { container_id: c.id, status: "processing" };
  }
  // CAROUSEL: children first, parent created once all children finished
  const ids: string[] = [];
  for (const u of p.media_urls.slice(0, 10)) {
    const c = await graph(`${igId}/media`, "POST",
      isVideo(u) ? { media_type: "VIDEO", video_url: u, is_carousel_item: true } : { image_url: u, is_carousel_item: true });
    ids.push(c.id);
  }
  return { child_ids: ids, status: "processing" };
}

async function continuePost(p: any) {
  const igId = await kv("ig_user_id");
  if (!p.container_id && p.child_ids?.length) {
    for (const cid of p.child_ids) {
      const s = await graph(cid, "GET", { fields: "status_code" });
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Carousel item ${cid}: ${s.status_code}`);
      if (s.status_code !== "FINISHED") return {}; // wait for next run
    }
    const c = await graph(`${igId}/media`, "POST", { media_type: "CAROUSEL", children: p.child_ids.join(","), caption: p.caption });
    return { container_id: c.id };
  }
  const s = await graph(p.container_id, "GET", { fields: "status_code" });
  if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Container ${s.status_code}`);
  if (s.status_code !== "FINISHED") return {};
  const pub = await graph(`${igId}/media_publish`, "POST", { creation_id: p.container_id });
  let permalink = null;
  try { permalink = (await graph(pub.id, "GET", { fields: "permalink" })).permalink; } catch { /* ignore */ }
  return { status: "published", ig_media_id: pub.id, permalink, published_at: new Date().toISOString() };
}

async function runPublishing() {
  const out: string[] = [];
  // 1) posts already in progress
  const { data: inprog } = await sb.from("cig_posts").select("*").eq("status", "processing").limit(5);
  for (const p of inprog ?? []) {
    try {
      const upd = await continuePost(p);
      const tooOld = Date.now() - Date.parse(p.scheduled_at) > 3 * 3600000;
      if (!upd.status && tooOld) throw new Error("3 तासात processing पूर्ण झाले नाही");
      if (Object.keys(upd).length) await sb.from("cig_posts").update(upd).eq("id", p.id);
      if (upd.status === "published") { out.push(`published ${p.id}`); await log(`Published ${p.id} ${upd.permalink ?? ""}`); }
    } catch (e) {
      await sb.from("cig_posts").update({ status: "failed", error: String(e) }).eq("id", p.id);
      await log(`Failed ${p.id}: ${e}`, "error");
    }
  }
  // 2) newly due approved posts
  const { data: due } = await sb.from("cig_posts").select("*").eq("status", "approved")
    .lte("scheduled_at", new Date().toISOString()).order("scheduled_at").limit(3);
  for (const p of due ?? []) {
    try {
      const upd = await startPost(p);
      await sb.from("cig_posts").update({ ...upd, attempts: p.attempts + 1 }).eq("id", p.id);
      out.push(`started ${p.id}`);
    } catch (e) {
      const attempts = p.attempts + 1;
      await sb.from("cig_posts").update({ attempts, error: String(e), status: attempts >= 3 ? "failed" : "approved" }).eq("id", p.id);
      await log(`Start failed ${p.id} (try ${attempts}): ${e}`, "error");
    }
  }
  return out;
}

// ---------- Keyword comment automation ----------
async function runComments() {
  const keyword = ((await kv("keyword")) ?? "QUOTE").toLowerCase();
  const igId = await kv("ig_user_id");
  const me = await kv("ig_username");
  const dm = await kv("dm_text");
  const pub = await kv("public_reply");
  const media = await graph("me/media", "GET", { fields: "id,timestamp", limit: 8 });
  let handled = 0;
  for (const m of media.data ?? []) {
    if (Date.now() - Date.parse(m.timestamp) > 30 * 86400000) continue;
    const cs = await graph(`${m.id}/comments`, "GET", { fields: "id,text,username,timestamp", limit: 50 });
    for (const c of cs.data ?? []) {
      if (!c.text?.toLowerCase().includes(keyword) || c.username === me) continue;
      if (Date.now() - Date.parse(c.timestamp) > 7 * 86400000) continue;
      const { data: seen } = await sb.from("cig_comments").select("comment_id").eq("comment_id", c.id).maybeSingle();
      if (seen) continue;
      const actions: string[] = [];
      try { if (dm) { await graph(`${igId}/messages`, "POST", { recipient: { comment_id: c.id }, message: { text: dm } }); actions.push("dm"); } }
      catch (e) { actions.push("dm_fail:" + String(e).slice(0, 80)); }
      try { if (pub) { await graph(`${c.id}/replies`, "POST", { message: pub }); actions.push("reply"); } }
      catch (e) { actions.push("reply_fail:" + String(e).slice(0, 80)); }
      await sb.from("cig_comments").insert({ comment_id: c.id, media_id: m.id, username: c.username, text: c.text, action: actions.join(",") });
      await sb.from("cig_leads").insert({ source: "instagram_comment", ig_username: c.username, requirement: c.text });
      handled++;
    }
  }
  return handled;
}

// ---------- HTTP ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  const action = url.searchParams.get("action") ?? body.action;

  try {
    // Approve link (from Claude-made drafts emailed to Manoj)
    if (action === "approve") {
      const id = url.searchParams.get("id"), t = url.searchParams.get("t");
      const { data: p } = await sb.from("cig_posts").select("id,status,approve_token,scheduled_at").eq("id", id).maybeSingle();
      if (!p || p.approve_token !== t) return text("❌ Link चुकीची आहे.", 403);
      if (p.status !== "draft") return text(`ही post आधीच "${p.status}" आहे.`);
      await sb.from("cig_posts").update({ status: "approved" }).eq("id", id);
      return text(`✅ Approved. ही post ${new Date(p.scheduled_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} ला Instagram वर जाईल.`);
    }

    if (action === "cancel_link") {
      const id = url.searchParams.get("id"), t = url.searchParams.get("t");
      const { data: p } = await sb.from("cig_posts").select("id,status,approve_token").eq("id", id).maybeSingle();
      if (!p || p.approve_token !== t) return text("❌ Link चुकीची आहे.", 403);
      if (!["draft", "approved"].includes(p.status)) return text(`ही post आधीच "${p.status}" आहे, आता रद्द करता येणार नाही.`);
      await sb.from("cig_posts").update({ status: "cancelled" }).eq("id", id);
      return text("🛑 रद्द केली. ही post Instagram वर जाणार नाही.");
    }

    // Cron
    if (action === "cron") {
      if (req.headers.get("x-cron-key") !== (await kv("cron_key"))) return json({ error: "forbidden" }, 403);
      if (!(await kv("ig_token"))) return json({ ok: true, skipped: "no token" });
      await refreshTokenIfNeeded();
      const published = await runPublishing();
      let comments = 0;
      try { comments = await runComments(); } catch (e) { await log("Comments: " + e, "error"); }
      return json({ ok: true, published, comments });
    }

    // Everything below needs the admin key
    const key = req.headers.get("x-admin-key") ?? body.key;
    if (!key || key !== (await kv("admin_key"))) return json({ error: "चुकीचा access key" }, 403);

    if (action === "status") {
      const tokenSet = !!(await kv("ig_token"));
      let limit = null;
      if (tokenSet) {
        try { limit = (await graph(`${await kv("ig_user_id")}/content_publishing_limit`, "GET", { fields: "quota_usage,config" })).data?.[0]; } catch { /* ignore */ }
      }
      const { data: posts } = await sb.from("cig_posts").select("id,created_at,scheduled_at,media_type,media_urls,caption,status,permalink,error,source")
        .order("scheduled_at", { ascending: false }).limit(40);
      const { data: logs } = await sb.from("cig_log").select("at,level,msg").order("at", { ascending: false }).limit(15);
      const { data: comments } = await sb.from("cig_comments").select("username,text,action,created_at").order("created_at", { ascending: false }).limit(15);
      const { count: footageUnused } = await sb.from("cig_footage").select("id", { count: "exact", head: true }).eq("used_in", "{}");
      const { count: leadsNew } = await sb.from("cig_leads").select("id", { count: "exact", head: true }).eq("status", "new");
      return json({
        footageUnused, leadsNew,
        tokenSet, username: await kv("ig_username"), tokenSetAt: await kv("token_set_at"), limit, posts, logs, comments,
        settings: { keyword: await kv("keyword"), public_reply: await kv("public_reply"), dm_text: await kv("dm_text") },
      });
    }

    if (action === "set_token") {
      const tok = String(body.token ?? "").trim();
      if (tok.length < 20) return json({ error: "Token खूप लहान आहे" }, 400);
      const me = await graph("me", "GET", { fields: "user_id,username,account_type" }, tok);
      await setKv("ig_token", tok);
      await setKv("ig_user_id", String(me.user_id ?? me.id));
      await setKv("ig_username", me.username ?? "");
      await setKv("token_set_at", new Date().toISOString());
      await log(`Token set for @${me.username}`);
      return json({ ok: true, username: me.username, account_type: me.account_type });
    }

    if (action === "save_settings") {
      for (const k of ["keyword", "public_reply", "dm_text"]) if (typeof body[k] === "string") await setKv(k, body[k]);
      return json({ ok: true });
    }

    if (action === "sign_upload") {
      const ext = String(body.ext ?? "mp4").replace(/[^a-z0-9]/gi, "").toLowerCase();
      const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) throw error;
      const publicUrl = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      return json({ path, token: data.token, signedUrl: data.signedUrl, publicUrl });
    }

    if (action === "create_post") {
      const mt = String(body.media_type);
      const urls: string[] = Array.isArray(body.media_urls) ? body.media_urls : [];
      if (!["REELS", "IMAGE", "CAROUSEL", "STORIES"].includes(mt) || !urls.length) return json({ error: "Media नाही" }, 400);
      if (mt === "CAROUSEL" && (urls.length < 2 || urls.length > 10)) return json({ error: "Carousel ला 2–10 फोटो लागतात" }, 400);
      const caption = String(body.caption ?? "").slice(0, 2200);
      if ((caption.match(/#/g) ?? []).length > 5) return json({ error: "जास्तीत जास्त 5 hashtags" }, 400);
      const { data, error } = await sb.from("cig_posts").insert({
        media_type: mt, media_urls: urls, caption,
        scheduled_at: body.scheduled_at ?? new Date().toISOString(),
        status: body.approved === false ? "draft" : "approved", source: body.source ?? "upload",
        title: body.title ?? null, theme: body.theme ?? null,
      }).select("id,approve_token").single();
      if (error) throw error;
      if (Array.isArray(body.footage_ids) && body.footage_ids.length) {
        for (const fid of body.footage_ids) {
          const { data: f } = await sb.from("cig_footage").select("used_in").eq("id", fid).maybeSingle();
          if (f) await sb.from("cig_footage").update({ used_in: [...(f.used_in ?? []), data.id] }).eq("id", fid);
        }
      }
      const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/carnival-ig`;
      return json({ ok: true, id: data.id,
        approve_url: `${fnUrl}?action=approve&id=${data.id}&t=${data.approve_token}`,
        cancel_url: `${fnUrl}?action=cancel_link&id=${data.id}&t=${data.approve_token}` });
    }

    if (action === "cancel") {
      await sb.from("cig_posts").update({ status: "cancelled" }).eq("id", body.id).in("status", ["draft", "approved", "failed"]);
      return json({ ok: true });
    }
    if (action === "retry_now") {
      await sb.from("cig_posts").update({ status: "approved", scheduled_at: new Date().toISOString(), attempts: 0, error: null, container_id: null, child_ids: null })
        .eq("id", body.id).in("status", ["draft", "approved", "failed"]);
      return json({ ok: true });
    }
    if (action === "run_now") {
      if (!(await kv("ig_token"))) return json({ error: "आधी token set करा" }, 400);
      const published = await runPublishing();
      return json({ ok: true, published });
    }

    // ---------- footage inbox ----------
    if (action === "register_footage") {
      const { data, error } = await sb.from("cig_footage").insert({
        url: body.url, kind: body.kind === "image" ? "image" : "video", site: body.site ?? null,
        stage: body.stage ?? "other", note: body.note ?? null,
      }).select("id").single();
      if (error) throw error;
      return json({ ok: true, id: data.id });
    }
    if (action === "list_footage") {
      let q = sb.from("cig_footage").select("*").order("created_at", { ascending: false }).limit(Number(body.limit ?? 60));
      const { data } = await q;
      const rows = (data ?? []).filter((r: any) => !body.unused_only || !(r.used_in?.length));
      return json({ ok: true, footage: rows });
    }

    // ---------- leads ----------
    if (action === "add_lead") {
      const row: any = {};
      for (const k of ["source", "name", "phone", "ig_username", "area_sqft", "location", "requirement", "status", "value_inr", "notes"]) if (body[k] !== undefined) row[k] = body[k];
      const { data, error } = await sb.from("cig_leads").insert(row).select("id").single();
      if (error) throw error;
      return json({ ok: true, id: data.id });
    }
    if (action === "update_lead") {
      const row: any = { updated_at: new Date().toISOString() };
      for (const k of ["name", "phone", "area_sqft", "location", "requirement", "status", "value_inr", "notes"]) if (body[k] !== undefined) row[k] = body[k];
      await sb.from("cig_leads").update(row).eq("id", body.id);
      return json({ ok: true });
    }
    if (action === "list_leads") {
      const { data } = await sb.from("cig_leads").select("*").order("created_at", { ascending: false }).limit(200);
      return json({ ok: true, leads: data });
    }

    // ---------- insights ----------
    if (action === "collect_insights") {
      const media = await graph("me/media", "GET", { fields: "id,media_type,media_product_type,permalink,timestamp,caption,like_count,comments_count", limit: Number(body.limit ?? 30) });
      const out: any[] = [];
      for (const m of media.data ?? []) {
        const row: any = { media_id: m.id, media_type: m.media_product_type ?? m.media_type, permalink: m.permalink, posted_at: m.timestamp,
          caption: (m.caption ?? "").slice(0, 300), likes: m.like_count ?? null, comments: m.comments_count ?? null };
        try {
          let ins;
          try { ins = await graph(`${m.id}/insights`, "GET", { metric: "reach,saved,shares,views,profile_visits" }); }
          catch { ins = await graph(`${m.id}/insights`, "GET", { metric: "reach,saved,shares,views" }); }
          for (const d of ins.data ?? []) {
            const v = d.values?.[0]?.value ?? d.total_value?.value ?? null;
            if (d.name === "reach") row.reach = v; if (d.name === "saved") row.saved = v; if (d.name === "shares") row.shares = v;
            if (d.name === "views") row.views = v; if (d.name === "profile_visits") row.profile_visits = v;
          }
        } catch (e) { row.insights_error = String(e).slice(0, 120); }
        const { insights_error, ...dbRow } = row;
        await sb.from("cig_insights").upsert(dbRow);
        out.push(row);
      }
      return json({ ok: true, media: out });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    await log(`${action}: ${e}`, "error");
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
