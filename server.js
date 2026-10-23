// This is the "backend". It now does three jobs:
// 1. checks that each person is logged in
// 2. saves every message in the database
// 3. sends new messages to everyone who is online

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("@supabase/supabase-js");

// These secret values are NOT written in the code.
// You will paste them into Render (Environment settings).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing settings. Add SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY in Render > Environment."
  );
  process.exit(1);
}

// The server talks to the database with the secret "service" key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
const server = http.createServer(app);
const io = new Server(server);

// Safety headers on every page (like the big apps do)
let supaHost = "";
try { supaHost = new URL(SUPABASE_URL).host; } catch (e) {}
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=()");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https://" + (supaHost || "*.supabase.co") + " https://*.supabase.co wss: ws: https://cdn.jsdelivr.net",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "));
  next();
});

// Make pages and data smaller on the way to the phone (skipped quietly if the package is missing)
try { app.use(require("compression")()); } catch (e) { console.log("compression not installed, skipping"); }

// Serve the chat page from the "public" folder (the logo is cached for a day)
app.use(express.static("public", { maxAge: "1d", setHeaders: (res, file) => {
  if (file.endsWith(".html") || file.endsWith("sw.js") || file.endsWith("manifest.json")) res.setHeader("Cache-Control", "no-cache");
} }));

// The web page asks for these two PUBLIC values so it can show the login form.
// (The secret service key is never sent to the browser.)
// A tiny page that keeps the server awake (see the keep-alive at the bottom)
app.get("/healthz", (req, res) => res.type("text").send("ok"));

app.get("/config", (req, res) => {
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// ---------- Profiles and followers ----------
app.use(express.json({ limit: "1mb" }));

// Times from the database may come without a timezone. They are UTC, so say so (every phone then shows its own local clock).
const NO_TZ = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?$/;
const utc = (t) => (typeof t === "string" && NO_TZ.test(t) ? t.replace(" ", "T") + "Z" : t);
function normTimes(v) {
  if (typeof v === "string") return utc(v);
  if (Array.isArray(v)) return v.map(normTimes);
  if (v && typeof v === "object" && v.constructor === Object) { const o = {}; for (const k of Object.keys(v)) o[k] = normTimes(v[k]); return o; }
  return v;
}
app.use((req, res, next) => {
  const j = res.json.bind(res);
  res.json = (body) => j(normTimes(body));
  next();
});
app.get("/api/time", (req, res) => { res.set("Cache-Control", "no-store"); res.json({ now: new Date().toISOString() }); });

// ---------- Slow-down protection (rate limits) ----------
const rateBuckets = new Map();
function allow(key, max, ms) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + ms }; rateBuckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (b.reset < now) rateBuckets.delete(k); }, 60000).unref();
const TOO_MANY = { error: "Too many requests. Please wait a minute and try again." };
const limiter = (name, max, ms) => (req, res, next) =>
  allow(name + ":" + (req.user ? req.user.id : req.ip), max, ms) ? next() : res.status(429).json(TOO_MANY);
app.use("/api", (req, res, next) => (allow("ip:" + req.ip, 1200, 60000) ? next() : res.status(429).json(TOO_MANY)));

const validIso = (v) => (/^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)?$/.test(String(v || "")) ? String(v) : "");

// Checks the login token on every /api request
// Remember who a login token belongs to for 60 seconds, so we don't ask Supabase on every request
const authCache = new Map();
async function userFromToken(token) {
  const hit = authCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  if (authCache.size > 500) authCache.clear();
  authCache.set(token, { user: data.user, exp: Date.now() + 60 * 1000 });
  return data.user;
}

async function requireUser(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const user = await userFromToken(token);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (req.method === "POST" && !allow("w:" + user.id, 150, 60000)) return res.status(429).json(TOO_MANY);
  req.user = user;
  next();
}

// Picture/video links: made once and reused for ~a day, so the phone can keep the files in its memory
const signCache = new Map();
const SIGN_TTL = 24 * 3600;
async function signMany(paths) {
  const now = Date.now();
  const out = [];
  const need = [];
  [...new Set((paths || []).filter(Boolean))].forEach((pth) => {
    const c = signCache.get(pth);
    if (c && c.exp - now > 3600 * 1000) out.push({ path: pth, signedUrl: c.url });
    else need.push(pth);
  });
  if (need.length) {
    const { data, error } = await supabase.storage.from("reels").createSignedUrls(need, SIGN_TTL);
    if (error && !out.length) return { data: null, error };
    (data || []).forEach((x) => {
      if (x.signedUrl) { signCache.set(x.path, { url: x.signedUrl, exp: now + SIGN_TTL * 1000 }); out.push({ path: x.path, signedUrl: x.signedUrl }); }
    });
    if (signCache.size > 4000) { for (const [k, v] of signCache) if (v.exp < now) signCache.delete(k); }
  }
  return { data: out, error: null };
}

// Stops one error from freezing a request
const safe = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  });

// Gets your profile, or creates it the first time you open it
async function getOrCreateProfile(user) {
  const { data: existing } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (existing) return existing;

  const raw = (user.user_metadata && user.user_metadata.username) || String(user.email || "user").split("@")[0];
  const base = String(raw).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16) || "user";

  for (let i = 0; i < 6; i++) {
    const name = i === 0 ? base : base + Math.floor(100 + Math.random() * 900);
    const meta = user.user_metadata || {};
    const row = { id: user.id, username: name };
    if (MD_RE.test(String(meta.birthday || ""))) row.birthday = meta.birthday;
    const by = Number(meta.birth_year);
    if (Number.isInteger(by) && by >= 1920 && by <= new Date().getFullYear()) row.birth_year = by;
    let { data, error } = await supabase.from("profiles").insert(row).select().single();
    if (error && error.code !== "23505" && (row.birthday || row.birth_year)) {
      delete row.birthday; delete row.birth_year;
      ({ data, error } = await supabase.from("profiles").insert(row).select().single());
    }
    if (!error) return data;
    if (error.code !== "23505") {
      console.error("Profile error:", error.message);
      return null;
    }
    const { data: again } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (again) return again;
  }
  return null;
}

// Turns a list of user ids into picture links (only people who have a picture)
async function avatarsFor(ids) {
  const map = {};
  const uniq = [...new Set(ids)];
  if (!uniq.length) return map;
  const { data } = await supabase.from("profiles").select("id, avatar_path").in("id", uniq);
  const withPic = (data || []).filter((p) => p.avatar_path);
  if (!withPic.length) return map;
  const { data: signed } = await signMany(withPic.map((p) => p.avatar_path), 3600);
  const byPath = {};
  (signed || []).forEach((x) => { if (x.signedUrl) byPath[x.path] = x.signedUrl; });
  withPic.forEach((p) => { if (byPath[p.avatar_path]) map[p.id] = byPath[p.avatar_path]; });
  return map;
}

// Turns a list of user ids into usernames
async function namesFor(ids) {
  const map = {};
  if (!ids.length) return map;
  const { data } = await supabase.from("profiles").select("id, username").in("id", ids);
  (data || []).forEach((p) => (map[p.id] = p.username));
  return map;
}

// My profile, followers, following, and follow requests
app.get("/api/me", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const { data: inRows } = await supabase.from("follows").select("follower_id, status").eq("following_id", me.id);
  const { data: outRows } = await supabase.from("follows").select("following_id, status").eq("follower_id", me.id);
  const ins = inRows || [];
  const outs = outRows || [];
  const names = await namesFor([...ins.map((r) => r.follower_id), ...outs.map((r) => r.following_id)]);

  let avatarUrl = null;
  if (me.avatar_path) {
    const { data: signed } = await signMany([me.avatar_path]);
    avatarUrl = signed && signed[0] ? signed[0].signedUrl : null;
  }

  const { count: postCount } = await supabase.from("photo_posts").select("id", { count: "exact", head: true }).eq("user_id", me.id);
  const { count: reelCount } = await supabase.from("reels").select("id", { count: "exact", head: true }).eq("user_id", me.id);

  res.json({
    username: me.username,
    display_name: me.display_name || "",
    birthday: me.birthday || "",
    birth_year: me.birth_year || "",
    posts_count: (postCount || 0) + (reelCount || 0),
    bio: me.bio || "",
    avatar_url: avatarUrl,
    is_private: me.is_private,
    followers: ins.filter((r) => r.status === "accepted").map((r) => names[r.follower_id] || "unknown"),
    following: outs.filter((r) => r.status === "accepted").map((r) => names[r.following_id] || "unknown"),
    requests: ins
      .filter((r) => r.status === "pending")
      .map((r) => ({ id: r.follower_id, username: names[r.follower_id] || "unknown" })),
  });
}));

// Save my bio
app.post("/api/me/bio", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const bio = String(req.body.bio || "").trim().slice(0, 500);
  const update = { bio };
  if (typeof req.body.name === "string") update.display_name = req.body.name.trim().slice(0, 30);
  if (typeof req.body.birthday === "string") {
    const b = req.body.birthday.trim();
    if (b === "") update.birthday = null;
    else if (MD_RE.test(b)) update.birthday = b;
  }
  if (req.body.birth_year !== undefined) {
    const y = Number(req.body.birth_year);
    if (req.body.birth_year === "" || req.body.birth_year === null) update.birth_year = null;
    else if (Number.isInteger(y) && y >= 1920 && y <= new Date().getFullYear()) update.birth_year = y;
  }
  const { error } = await supabase.from("profiles").update(update).eq("id", me.id);
  if (error) return res.status(500).json({ error: "Could not save. Did you run the profile SQL in Supabase?" });
  res.json({ ok: true });
}));

// Someone's photos and reels, ready for a grid (viewerId decides which are "mine" / "liked")
// likes / comments / liked-by-me for a list of reel ids
async function reelExtras(ids, viewerId) {
  const likes = {}, liked = {}, comments = {}, reposts = {}, reposted = {}, saves = {}, shares = {};
  if (!ids.length) return { likes, liked, comments, reposts, reposted, saves, shares };
  const [l, c, rp, sv, sh] = await Promise.all([
    supabase.from("reel_likes").select("reel_id, user_id").in("reel_id", ids),
    supabase.from("reel_comments").select("reel_id").in("reel_id", ids),
    supabase.from("reposts").select("reel_id, user_id").in("reel_id", ids),
    supabase.from("saved_items").select("item_id").eq("kind", "reel").in("item_id", ids),
    supabase.from("dms").select("reel_id").eq("kind", "reel").in("reel_id", ids),
  ]);
  (rp.data || []).forEach((x) => { reposts[x.reel_id] = (reposts[x.reel_id] || 0) + 1; if (x.user_id === viewerId) reposted[x.reel_id] = true; });
  (sv.data || []).forEach((x) => { saves[x.item_id] = (saves[x.item_id] || 0) + 1; });
  (sh.data || []).forEach((x) => { shares[x.reel_id] = (shares[x.reel_id] || 0) + 1; });
  (l.data || []).forEach((x) => { likes[x.reel_id] = (likes[x.reel_id] || 0) + 1; if (x.user_id === viewerId) liked[x.reel_id] = true; });
  (c.data || []).forEach((x) => { comments[x.reel_id] = (comments[x.reel_id] || 0) + 1; });
  return { likes, liked, comments, reposts, reposted, saves, shares };
}

async function mediaFor(userId, viewerId) {
  const { data: pRows } = await supabase
    .from("photo_posts").select("id, username, path, caption").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(60);
  const { data: rRows } = await supabase
    .from("reels").select("id, username, path, caption, created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(60);
  const posts = pRows || [];
  const reels = rRows || [];
  const paths = [...posts.map((p) => p.path), ...reels.map((r) => r.path)];
  const urls = {};
  if (paths.length) {
    const { data: signed } = await signMany(paths);
    (signed || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
  }
  const ids = posts.map((p) => p.id);
  const likes = {}, liked = {}, comments = {};
  if (ids.length) {
    const { data: likeRows } = await supabase.from("photo_likes").select("post_id, user_id").in("post_id", ids);
    const { data: comRows } = await supabase.from("photo_comments").select("post_id").in("post_id", ids);
    (likeRows || []).forEach((l) => {
      likes[l.post_id] = (likes[l.post_id] || 0) + 1;
      if (l.user_id === viewerId) liked[l.post_id] = true;
    });
    (comRows || []).forEach((c) => { comments[c.post_id] = (comments[c.post_id] || 0) + 1; });
  }
  const mine = userId === viewerId;
  const rx = await reelExtras(reels.map((r) => r.id), viewerId);
  return {
    posts: posts.filter((p) => urls[p.path]).map((p) => ({
      id: p.id, username: p.username, avatar: null, caption: p.caption, url: urls[p.path], mine,
      likes: likes[p.id] || 0, liked: !!liked[p.id], comments: comments[p.id] || 0,
    })),
    reels: reels.filter((r) => urls[r.path]).map((r) => ({
      id: r.id, username: r.username, caption: r.caption, url: urls[r.path], mine, time: r.created_at,
      likes: rx.likes[r.id] || 0, liked: !!rx.liked[r.id], comments: rx.comments[r.id] || 0, following: true,
    })),
  };
}

// My own photos and reels (for the grid on my profile)
app.get("/api/me/media", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  res.json(await mediaFor(me.id, me.id));
}));

// ---------- Blocking ----------
const blockCache = new Map();
async function blockedIds(meId) {
  const hit = blockCache.get(meId);
  if (hit && hit.exp > Date.now()) return hit.set;
  const [a, b] = await Promise.all([
    supabase.from("blocks").select("blocked_id").eq("blocker_id", meId),
    supabase.from("blocks").select("blocker_id").eq("blocked_id", meId),
  ]);
  const set = new Set([...(a.data || []).map((r) => r.blocked_id), ...(b.data || []).map((r) => r.blocker_id)]);
  if (blockCache.size > 2000) blockCache.clear();
  blockCache.set(meId, { set, exp: Date.now() + 20000 });
  return set;
}

async function savedKeys(meId) {
  const { data } = await supabase.from("saved_items").select("kind, item_id").eq("user_id", meId).limit(1000);
  return new Set((data || []).map((r) => r.kind + ":" + r.item_id));
}

// People who follow me AND I follow them back ("friends")
async function mutualIds(meId) {
  const [{ data: outRows }, { data: inRows }] = await Promise.all([
    supabase.from("follows").select("following_id").eq("follower_id", meId).eq("status", "accepted"),
    supabase.from("follows").select("follower_id").eq("following_id", meId).eq("status", "accepted"),
  ]);
  const iFollow = new Set((outRows || []).map((r) => r.following_id));
  const blocked = await blockedIds(meId);
  return (inRows || []).map((r) => r.follower_id).filter((id) => iFollow.has(id) && !blocked.has(id));
}

app.get("/api/friends", requireUser, safe(async (req, res) => {
  const ids = await mutualIds(req.user.id);
  if (!ids.length) return res.json({ friends: [] });
  const names = await namesFor(ids);
  const pics = await avatarsFor(ids);
  res.json({ friends: ids.map((id) => ({ id, username: names[id] || "unknown", avatar: pics[id] || null }))
    .sort((a, b) => a.username.localeCompare(b.username)) });
}));

// ---------- Notes (a short thought for 24 hours, can tag a friend on their birthday) ----------
const MD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

app.post("/api/notes", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const text = String(req.body.text || "").trim().slice(0, 120);
  if (!text) return res.json({ error: "Write something first." });

  let tagId = null;
  let tagName = null;
  const want = String(req.body.tag_username || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (want) {
    const friends = new Set(await mutualIds(me.id));
    const { data: t } = await supabase.from("profiles").select("id, username").eq("username", want).maybeSingle();
    if (t && friends.has(t.id)) { tagId = t.id; tagName = t.username; }
  }

  const { error } = await supabase.from("notes").upsert({
    user_id: me.id, username: me.username, text, song: "", artist: "", audio_path: null,
    tag_user_id: tagId, tag_username: tagName, created_at: new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: "Could not save. Did you run the notes SQL in Supabase?" });
  res.json({ ok: true });
}));

app.post("/api/notes/delete", requireUser, safe(async (req, res) => {
  await supabase.from("notes").delete().eq("user_id", req.user.id);
  res.json({ ok: true });
}));

// Notes of me + my friends, and which friends have a birthday today (?md=MM-DD from the phone's own date)
app.get("/api/notes", requireUser, safe(async (req, res) => {
  const meId = req.user.id;
  const md = MD_RE.test(String(req.query.md || "")) ? String(req.query.md) : "";
  const friendIds = await mutualIds(meId);
  const ids = [meId, ...friendIds];
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [noteRes, profRes, pics] = await Promise.all([
    supabase.from("notes").select("user_id, username, text, tag_username, created_at")
      .in("user_id", ids).gte("created_at", cutoff).order("created_at", { ascending: false }),
    supabase.from("profiles").select("id, username, birthday, birth_year").in("id", ids),
    avatarsFor(ids),
  ]);
  const list = noteRes.error ? [] : noteRes.data || [];
  const bday = {};
  const nameOf = {};
  const yearOf = {};
  const yr = Number(req.query.y) > 1900 ? Number(req.query.y) : new Date().getFullYear();
  (profRes.data || []).forEach((pr) => { nameOf[pr.id] = pr.username; if (pr.birth_year) yearOf[pr.id] = yr - pr.birth_year; if (md && pr.birthday === md) bday[pr.id] = true; });

  const notes = list.map((n) => ({
    user_id: n.user_id, username: n.username, avatar: pics[n.user_id] || null, mine: n.user_id === meId,
    text: n.text || "", tag: n.tag_username || "", birthday: !!bday[n.user_id], time: n.created_at,
  }));
  notes.sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1));
  const birthdays = friendIds.filter((id) => bday[id]).map((id) => ({ id, username: nameOf[id] || "unknown", avatar: pics[id] || null, turns: yearOf[id] || null }));
  res.json({ notes, birthdays, me_avatar: pics[meId] || null, my_birthday_today: !!bday[meId] });
}));

// ---------- Stories (disappear after 24 hours) ----------
const STORY_HOURS = 24;
let lastStoryCleanup = 0;

async function cleanupStories() {
  if (Date.now() - lastStoryCleanup < 10 * 60 * 1000) return;
  lastStoryCleanup = Date.now();
  const cutoff = new Date(Date.now() - STORY_HOURS * 3600 * 1000).toISOString();
  const { data: oldNotes } = await supabase.from("notes").select("user_id, audio_path").lt("created_at", cutoff).limit(200);
  if (oldNotes && oldNotes.length) {
    const files = oldNotes.map((n) => n.audio_path).filter(Boolean);
    if (files.length) await supabase.storage.from(REELS_BUCKET).remove(files);
    await supabase.from("notes").delete().in("user_id", oldNotes.map((n) => n.user_id));
  }
  const { data: old } = await supabase.from("stories").select("id, path").lt("created_at", cutoff).limit(200);
  if (!old || !old.length) return;
  await supabase.storage.from(REELS_BUCKET).remove(old.map((o) => o.path));
  await supabase.from("stories").delete().in("id", old.map((o) => o.id));
}

app.post("/api/stories/upload-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const wanted = String(req.body.ext || "").toLowerCase();
  const ext = ["jpg", "jpeg", "png", "webp", "gif", "mp4", "mov", "webm", "m4v"].includes(wanted) ? wanted : "jpg";
  const path = req.user.id + "/story-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: "Could not start the upload." });
  res.json({ path, token: data.token });
}));

app.post("/api/stories", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const path = String(req.body.path || "");
  if (!path.startsWith(req.user.id + "/story-") || path.includes("..")) return res.status(400).json({ error: "Bad file" });
  const kind = req.body.kind === "video" ? "video" : "image";
  const caption = String(req.body.caption || "").trim().slice(0, 500);
  const row = { user_id: me.id, username: me.username, path, kind, caption };
  if (Array.isArray(req.body.audience)) {
    const friends = new Set(await mutualIds(me.id));
    const chosen = [...new Set(req.body.audience.map(String))].filter((id) => UUID_RE.test(id) && friends.has(id));
    if (!chosen.length) return res.status(400).json({ error: "Pick at least one friend, or share with all your friends." });
    row.audience = chosen;
  }
  const { error } = await supabase.from("stories").insert(row);
  if (error) return res.status(500).json({ error: "Could not save. Did you run the stories SQL in Supabase?" });
  res.json({ ok: true });
}));

app.post("/api/stories/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const { data: st } = await supabase.from("stories").select("id, user_id, path").eq("id", id).maybeSingle();
  if (!st || st.user_id !== req.user.id) return res.json({ error: "Story not found." });
  await supabase.storage.from(REELS_BUCKET).remove([st.path]);
  await supabase.from("stories").delete().eq("id", id);
  res.json({ ok: true });
}));

// Somebody looked at a story
app.post("/api/stories/view", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const { data: st } = await supabase.from("stories").select("id, user_id").eq("id", id).maybeSingle();
  if (!st || st.user_id === req.user.id) return res.json({ ok: true });
  if (!(await mutualIds(req.user.id)).includes(st.user_id)) return res.json({ ok: true });
  await supabase.from("story_views").upsert({ story_id: id, viewer_id: req.user.id }, { onConflict: "story_id,viewer_id" });
  res.json({ ok: true });
}));

// Who looked at my story
app.get("/api/stories/:id/viewers", requireUser, safe(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const { data: st } = await supabase.from("stories").select("id, user_id").eq("id", id).maybeSingle();
  if (!st || st.user_id !== req.user.id) return res.json({ error: "Story not found." });
  const { data } = await supabase.from("story_views").select("viewer_id, created_at").eq("story_id", id).order("created_at", { ascending: false }).limit(200);
  const ids = (data || []).map((v) => v.viewer_id);
  const [names, pics] = await Promise.all([namesFor(ids), avatarsFor(ids)]);
  res.json({ viewers: (data || []).map((v) => ({ username: names[v.viewer_id] || "unknown", avatar: pics[v.viewer_id] || null, time: v.created_at })) });
}));

// My stories + stories of people I follow who follow me back
app.get("/api/stories", requireUser, safe(async (req, res) => {
  const meId = req.user.id;
  cleanupStories().catch(() => {});

  const mutual = await mutualIds(meId);
  const ids = [meId, ...mutual];

  const cutoff = new Date(Date.now() - STORY_HOURS * 3600 * 1000).toISOString();
  let q = await supabase
    .from("stories").select("id, user_id, username, path, kind, caption, created_at, audience")
    .in("user_id", ids).gte("created_at", cutoff).order("created_at", { ascending: true }).limit(1500);
  if (q.error) {
    // the "audience" column may not exist yet (SQL not run): fall back to the old query
    q = await supabase
      .from("stories").select("id, user_id, username, path, kind, caption, created_at")
      .in("user_id", ids).gte("created_at", cutoff).order("created_at", { ascending: true }).limit(1500);
  }
  if (q.error) return res.json({ groups: [] });
  const list = (q.data || []).filter((r) => r.user_id === meId || !r.audience || !r.audience.length || r.audience.includes(meId));
  if (!list.length) return res.json({ groups: [] });

  const { data: signed } = await signMany(list.map((r) => r.path), 3600);
  const urls = {};
  (signed || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
  const pics = await avatarsFor([...new Set(list.map((r) => r.user_id))]);

  const byUser = {};
  list.filter((r) => urls[r.path]).forEach((r) => {
    if (!byUser[r.user_id]) {
      byUser[r.user_id] = { user_id: r.user_id, username: r.username, avatar: pics[r.user_id] || null, mine: r.user_id === meId, stories: [] };
    }
    byUser[r.user_id].stories.push({ id: r.id, url: urls[r.path], kind: r.kind, caption: r.caption || "", time: r.created_at });
  });
  const groups = Object.values(byUser).sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return new Date(b.stories[b.stories.length - 1].time) - new Date(a.stories[a.stories.length - 1].time);
  });
  res.json({ groups });
}));

// ---------- Saved posts and reels ----------
async function shapePostRows(rows, meId) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [l, c, sg, pics] = await Promise.all([
    supabase.from("photo_likes").select("post_id, user_id").in("post_id", ids),
    supabase.from("photo_comments").select("post_id").in("post_id", ids),
    signMany(rows.map((r) => r.path)),
    avatarsFor(rows.map((r) => r.user_id)),
  ]);
  const likes = {}, liked = {}, comments = {}, urls = {};
  (l.data || []).forEach((x) => { likes[x.post_id] = (likes[x.post_id] || 0) + 1; if (x.user_id === meId) liked[x.post_id] = true; });
  (c.data || []).forEach((x) => { comments[x.post_id] = (comments[x.post_id] || 0) + 1; });
  (sg.data || []).forEach((x) => { urls[x.path] = x.signedUrl; });
  return rows.filter((r) => urls[r.path]).map((r) => ({
    kind: "post", id: r.id, username: r.username, avatar: pics[r.user_id] || null, caption: r.caption, url: urls[r.path],
    time: r.created_at, mine: r.user_id === meId, likes: likes[r.id] || 0, liked: !!liked[r.id], comments: comments[r.id] || 0, saved: true,
  }));
}
async function shapeReelRows(rows, meId, followingSet) {
  if (!rows.length) return [];
  const [rx, sg, pics] = await Promise.all([
    reelExtras(rows.map((r) => r.id), meId),
    signMany(rows.map((r) => r.path)),
    avatarsFor(rows.map((r) => r.user_id)),
  ]);
  const urls = {};
  (sg.data || []).forEach((x) => { urls[x.path] = x.signedUrl; });
  return rows.filter((r) => urls[r.path]).map((r) => ({
    kind: "reel", id: r.id, username: r.username, avatar: pics[r.user_id] || null, caption: r.caption, url: urls[r.path],
    time: r.created_at, mine: r.user_id === meId, likes: rx.likes[r.id] || 0, liked: !!rx.liked[r.id], comments: rx.comments[r.id] || 0,
    following: r.user_id === meId || followingSet.has(r.user_id), saved: true,
    reposts: rx.reposts[r.id] || 0, reposted: !!rx.reposted[r.id], saves: rx.saves[r.id] || 0, shares: rx.shares[r.id] || 0,
  }));
}

app.post("/api/save", requireUser, safe(async (req, res) => {
  const kind = req.body.kind === "reel" ? "reel" : "post";
  const id = Number(req.body.id) || 0;
  const { data: it } = await supabase.from(kind === "reel" ? "reels" : "photo_posts").select("id, user_id").eq("id", id).maybeSingle();
  if (!it || !(await canSeeUser(req.user.id, it.user_id))) return res.json({ error: "Not found." });
  const { data: ex } = await supabase.from("saved_items").select("item_id").eq("user_id", req.user.id).eq("kind", kind).eq("item_id", id).maybeSingle();
  if (ex) await supabase.from("saved_items").delete().eq("user_id", req.user.id).eq("kind", kind).eq("item_id", id);
  else {
    const { error } = await supabase.from("saved_items").insert({ user_id: req.user.id, kind, item_id: id });
    if (error) return res.status(500).json({ error: "Could not save. Did you run the v20 SQL?" });
  }
  res.json({ saved: !ex });
}));

app.get("/api/saved", requireUser, safe(async (req, res) => {
  const meId = req.user.id;
  const { data } = await supabase.from("saved_items").select("kind, item_id, created_at").eq("user_id", meId).order("created_at", { ascending: false }).limit(80);
  const rows = data || [];
  const postIds = rows.filter((r) => r.kind === "post").map((r) => r.item_id);
  const reelIds = rows.filter((r) => r.kind === "reel").map((r) => r.item_id);
  const [pr, rr, fr, blocked] = await Promise.all([
    postIds.length ? supabase.from("photo_posts").select("id, user_id, username, path, caption, created_at").in("id", postIds) : { data: [] },
    reelIds.length ? supabase.from("reels").select("id, user_id, username, path, caption, created_at").in("id", reelIds) : { data: [] },
    supabase.from("follows").select("following_id").eq("follower_id", meId).eq("status", "accepted"),
    blockedIds(meId),
  ]);
  const following = new Set((fr.data || []).map((f) => f.following_id));
  const all = [...(pr.data || []), ...(rr.data || [])];
  const authors = [...new Set(all.map((x) => x.user_id))];
  const priv = {};
  if (authors.length) {
    const { data: a } = await supabase.from("profiles").select("id, is_private").in("id", authors);
    (a || []).forEach((x) => (priv[x.id] = x.is_private));
  }
  const ok = (x) => !blocked.has(x.user_id) && (x.user_id === meId || !priv[x.user_id] || following.has(x.user_id));
  const [posts, reels] = await Promise.all([shapePostRows((pr.data || []).filter(ok), meId), shapeReelRows((rr.data || []).filter(ok), meId, following)]);
  const order = {};
  rows.forEach((r, i) => { order[r.kind + ":" + r.item_id] = i; });
  const items = [...posts, ...reels].sort((a, b) => order[a.kind + ":" + a.id] - order[b.kind + ":" + b.id]);
  res.json({ items });
}));

// ---------- Block and report ----------
app.post("/api/block", requireUser, limiter("blk", 30, 3600000), safe(async (req, res) => {
  const target = String(req.body.username || "").trim().toLowerCase().replace(/^@/, "");
  const { data: t } = await supabase.from("profiles").select("id, username").eq("username", target).maybeSingle();
  if (!t) return res.json({ error: "No one has that username." });
  if (t.id === req.user.id) return res.json({ error: "You can't block yourself." });
  await supabase.from("blocks").upsert({ blocker_id: req.user.id, blocked_id: t.id }, { onConflict: "blocker_id,blocked_id" });
  await supabase.from("follows").delete().or(`and(follower_id.eq.${req.user.id},following_id.eq.${t.id}),and(follower_id.eq.${t.id},following_id.eq.${req.user.id})`);
  blockCache.clear(); canMsgCache.clear();
  res.json({ ok: true });
}));

app.post("/api/unblock", requireUser, safe(async (req, res) => {
  const target = String(req.body.username || "").trim().toLowerCase().replace(/^@/, "");
  const { data: t } = await supabase.from("profiles").select("id").eq("username", target).maybeSingle();
  if (t) await supabase.from("blocks").delete().eq("blocker_id", req.user.id).eq("blocked_id", t.id);
  blockCache.clear(); canMsgCache.clear();
  res.json({ ok: true });
}));

app.get("/api/blocks", requireUser, safe(async (req, res) => {
  const { data } = await supabase.from("blocks").select("blocked_id").eq("blocker_id", req.user.id);
  const ids = (data || []).map((r) => r.blocked_id);
  const [names, pics] = await Promise.all([namesFor(ids), avatarsFor(ids)]);
  res.json({ blocked: ids.map((id) => ({ username: names[id] || "unknown", avatar: pics[id] || null })) });
}));

app.post("/api/report", requireUser, limiter("rp", 10, 3600000), safe(async (req, res) => {
  const kind = ["user", "post", "reel", "comment", "message"].includes(req.body.kind) ? req.body.kind : "user";
  const target = String(req.body.target || "").slice(0, 80);
  const reason = String(req.body.reason || "").trim().slice(0, 200);
  if (!target) return res.json({ error: "Nothing to report." });
  const { error } = await supabase.from("reports").insert({ reporter_id: req.user.id, kind, target_id: target, reason });
  if (error) return res.status(500).json({ error: "Could not send the report. Did you run the v20 SQL?" });
  res.json({ ok: true });
}));

// ---------- Delete my account for good ----------
app.post("/api/me/delete", requireUser, limiter("del", 3, 3600000), safe(async (req, res) => {
  if (req.body.confirm !== "DELETE") return res.json({ error: "Type DELETE to confirm." });
  const id = req.user.id;
  const quiet = async (fn) => { try { await fn(); } catch (e) {} };
  await quiet(async () => {
    const { data: files } = await supabase.storage.from(REELS_BUCKET).list(id, { limit: 1000 });
    if (files && files.length) await supabase.storage.from(REELS_BUCKET).remove(files.map((f) => id + "/" + f.name));
  });
  const { data: ps } = await supabase.from("photo_posts").select("id").eq("user_id", id);
  const { data: rs } = await supabase.from("reels").select("id").eq("user_id", id);
  const pIds = (ps || []).map((x) => x.id), rIds = (rs || []).map((x) => x.id);
  if (pIds.length) { await quiet(() => supabase.from("photo_likes").delete().in("post_id", pIds)); await quiet(() => supabase.from("photo_comments").delete().in("post_id", pIds)); }
  if (rIds.length) { await quiet(() => supabase.from("reel_likes").delete().in("reel_id", rIds)); await quiet(() => supabase.from("reel_comments").delete().in("reel_id", rIds)); }
  const del = (t, c) => quiet(() => supabase.from(t).delete().eq(c, id));
  await Promise.all([
    del("photo_posts", "user_id"), del("reels", "user_id"), del("photo_likes", "user_id"), del("photo_comments", "user_id"),
    del("reel_likes", "user_id"), del("reel_comments", "user_id"), del("notes", "user_id"), del("stories", "user_id"),
    del("story_views", "viewer_id"), del("saved_items", "user_id"), del("blocks", "blocker_id"), del("blocks", "blocked_id"),
    del("group_members", "user_id"), del("reports", "reporter_id"), del("follows", "follower_id"), del("follows", "following_id"),
    del("dms", "sender_id"), del("dms", "receiver_id"),
  ]);
  await del("profiles", "id");
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) return res.status(500).json({ error: "Your data was removed but the login could not be deleted. Contact support." });
  authCache.clear();
  res.json({ ok: true });
}));

// ---------- Notifications (built from follows, likes and comments) ----------
async function buildNotifications(me) {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const items = [];

  const { data: fRows } = await supabase
    .from("follows").select("follower_id, status, created_at")
    .eq("following_id", me.id).gte("created_at", since).order("created_at", { ascending: false }).limit(40);
  const { data: myPosts } = await supabase.from("photo_posts").select("id").eq("user_id", me.id);
  const postIds = (myPosts || []).map((p) => p.id);

  let likeRows = [];
  let comRows = [];
  if (postIds.length) {
    const l = await supabase.from("photo_likes").select("post_id, user_id, created_at")
      .in("post_id", postIds).neq("user_id", me.id).gte("created_at", since).order("created_at", { ascending: false }).limit(40);
    likeRows = l.data || [];
    const c = await supabase.from("photo_comments").select("post_id, user_id, username, text, created_at")
      .in("post_id", postIds).neq("user_id", me.id).gte("created_at", since).order("created_at", { ascending: false }).limit(40);
    comRows = c.data || [];
  }

  const names = await namesFor([...new Set([...(fRows || []).map((f) => f.follower_id), ...likeRows.map((l) => l.user_id)])]);
  const actorIds = [...new Set([...(fRows || []).map((f) => f.follower_id), ...likeRows.map((l) => l.user_id), ...comRows.map((c) => c.user_id)].filter(Boolean))];
  const pics = await avatarsFor(actorIds);

  // Do I already follow these people back?
  const rel = {};
  const followerIds = (fRows || []).map((f) => f.follower_id);
  if (followerIds.length) {
    const { data: mine } = await supabase
      .from("follows").select("following_id, status").eq("follower_id", me.id).in("following_id", followerIds);
    (mine || []).forEach((m) => (rel[m.following_id] = m.status === "pending" ? "pending" : "following"));
  }

  (fRows || []).forEach((f) => items.push({
    actor_id: f.follower_id, relation: rel[f.follower_id] || "none",
    type: f.status === "pending" ? "request" : "follow", username: names[f.follower_id] || "someone",
    avatar: pics[f.follower_id] || null, text: f.status === "pending" ? "wants to follow you" : "started following you", time: f.created_at,
  }));
  likeRows.forEach((l) => items.push({
    type: "like", username: names[l.user_id] || "someone", avatar: pics[l.user_id] || null, text: "liked your photo", time: l.created_at,
  }));
  comRows.forEach((c) => items.push({
    type: "comment", username: c.username || "someone", avatar: pics[c.user_id] || null,
    text: "commented: " + String(c.text || "").slice(0, 80), time: c.created_at,
  }));

  const { data: tagRows } = await supabase.from("notes").select("user_id, username, created_at")
    .eq("tag_user_id", me.id).gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  (tagRows || []).forEach((t) => items.push({
    type: "mention", username: t.username, avatar: null, text: "tagged you in a note 🎂", time: t.created_at,
  }));

  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  const seen = me.notif_seen_at ? new Date(me.notif_seen_at).getTime() : 0;
  items.forEach((i) => { i.is_new = new Date(i.time).getTime() > seen; });
  return items.slice(0, 50);
}

app.get("/api/notifications", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const items = await buildNotifications(me);
  res.json({ items, unread: items.filter((i) => i.is_new).length });
}));

app.get("/api/notifications/count", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.json({ unread: 0 });
  const items = await buildNotifications(me);
  res.json({ unread: items.filter((i) => i.is_new).length });
}));

app.post("/api/notifications/seen", requireUser, safe(async (req, res) => {
  const { error } = await supabase.from("profiles").update({ notif_seen_at: new Date().toISOString() }).eq("id", req.user.id);
  if (error) return res.status(500).json({ error: "Could not save. Did you run the notifications SQL in Supabase?" });
  res.json({ ok: true });
}));

// Find people by username (empty search shows the newest people)
app.get("/api/search", requireUser, safe(async (req, res) => {
  const q = String(req.query.q || "").toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_]/g, "").slice(0, 20);
  let query = supabase.from("profiles").select("id, username, display_name, avatar_path, is_private").neq("id", req.user.id);
  query = q ? query.ilike("username", "%" + q + "%") : query.order("created_at", { ascending: false });
  const { data } = await query.limit(20);
  const blockedS = await blockedIds(req.user.id);
  const list = (data || []).filter((p) => !blockedS.has(p.id));
  const pics = await avatarsFor(list.map((p) => p.id));
  const { data: fRows } = list.length
    ? await supabase.from("follows").select("following_id, status").eq("follower_id", req.user.id).in("following_id", list.map((p) => p.id))
    : { data: [] };
  const rel = {};
  (fRows || []).forEach((f) => (rel[f.following_id] = f.status === "pending" ? "pending" : "following"));
  res.json({
    people: list.map((p) => ({
      username: p.username, display_name: p.display_name || "", avatar: pics[p.id] || null,
      is_private: !!p.is_private, relation: rel[p.id] || "none",
    })),
  });
}));

// Someone else's profile page
app.get("/api/users/:username", requireUser, safe(async (req, res) => {
  const name = String(req.params.username || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  const { data: u } = await supabase.from("profiles").select("*").eq("username", name).maybeSingle();
  if (!u) return res.json({ error: "No one has that username." });
  const meId = req.user.id;
  if (u.id === meId) return res.json({ is_me: true });
  if ((await blockedIds(meId)).has(u.id)) return res.json({ error: "No one has that username." });

  const pics = await avatarsFor([u.id]);
  const { data: rel } = await supabase
    .from("follows").select("status").eq("follower_id", meId).eq("following_id", u.id).maybeSingle();
  const { count: followers } = await supabase.from("follows").select("follower_id", { count: "exact", head: true }).eq("following_id", u.id).eq("status", "accepted");
  const { count: following } = await supabase.from("follows").select("following_id", { count: "exact", head: true }).eq("follower_id", u.id).eq("status", "accepted");
  const { count: pc } = await supabase.from("photo_posts").select("id", { count: "exact", head: true }).eq("user_id", u.id);
  const { count: rc } = await supabase.from("reels").select("id", { count: "exact", head: true }).eq("user_id", u.id);

  const canSee = await canSeeUser(meId, u.id);
  const media = canSee ? await mediaFor(u.id, meId) : { posts: [], reels: [] };
  res.json({
    id: u.id, username: u.username, display_name: u.display_name || "", bio: u.bio || "", avatar: pics[u.id] || null,
    is_private: !!u.is_private, relation: rel ? (rel.status === "pending" ? "pending" : "following") : "none",
    can_see: canSee, followers: followers || 0, following: following || 0, posts_count: (pc || 0) + (rc || 0),
    posts: media.posts, reels: media.reels,
  });
}));

// Profile picture: get an upload spot, then save it
app.post("/api/me/avatar-url", requireUser, safe(async (req, res) => {
  const wanted = String(req.body.ext || "").toLowerCase();
  const ext = ["jpg", "jpeg", "png", "webp", "gif"].includes(wanted) ? wanted : "jpg";
  const path = req.user.id + "/avatar-" + Date.now() + "." + ext;
  const { data, error } = await supabase.storage.from("reels").createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: "Could not start the upload." });
  res.json({ path, token: data.token });
}));

app.post("/api/me/avatar", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const path = String(req.body.path || "");
  if (!path.startsWith(req.user.id + "/avatar-") || path.includes("..")) {
    return res.status(400).json({ error: "Bad picture" });
  }
  if (me.avatar_path && me.avatar_path !== path) {
    await supabase.storage.from("reels").remove([me.avatar_path]);
  }
  const { error } = await supabase.from("profiles").update({ avatar_path: path }).eq("id", me.id);
  if (error) return res.status(500).json({ error: "Could not save. Did you run the profile SQL in Supabase?" });
  res.json({ ok: true });
}));

// Switch between public and private (easy, any time)
app.post("/api/me/privacy", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const isPrivate = !!req.body.is_private;
  await supabase.from("profiles").update({ is_private: isPrivate }).eq("id", me.id);
  // Going public: everyone waiting is accepted automatically
  if (!isPrivate) {
    await supabase.from("follows").update({ status: "accepted" }).eq("following_id", me.id).eq("status", "pending");
  }
  res.json({ ok: true });
}));

// Follow someone by username
app.post("/api/follow", requireUser, limiter("fl", 40, 60000), safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const target = String(req.body.username || "").trim().toLowerCase().replace(/^@/, "");
  if (!target) return res.json({ message: "Type a username first." });

  const { data: t } = await supabase
    .from("profiles").select("id, username, is_private").eq("username", target).maybeSingle();
  if (!t) return res.json({ message: "No one has that username." });
  if (t.id === me.id) return res.json({ message: "That's you!" });
  if ((await blockedIds(me.id)).has(t.id)) return res.json({ message: "You can't follow this account." });

  const { data: already } = await supabase
    .from("follows").select("status").eq("follower_id", me.id).eq("following_id", t.id).maybeSingle();
  if (already) {
    return res.json({ message: already.status === "pending" ? "Request already sent." : "You already follow them." });
  }

  const status = t.is_private ? "pending" : "accepted";
  await supabase.from("follows").insert({ follower_id: me.id, following_id: t.id, status });
  pushIfAway(t.id, status === "pending" ? "Follow request" : "New follower", "@" + me.username + (status === "pending" ? " wants to follow you" : " started following you"), { type: "follow" });
  res.json({ message: status === "pending" ? "Request sent to @" + t.username : "You now follow @" + t.username });
}));

// Stop following someone
app.post("/api/unfollow", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const target = String(req.body.username || "").trim().toLowerCase();
  const { data: t } = await supabase.from("profiles").select("id").eq("username", target).maybeSingle();
  if (t) await supabase.from("follows").delete().eq("follower_id", me.id).eq("following_id", t.id);
  res.json({ ok: true });
}));

// Accept or decline a follow request
app.post("/api/requests/respond", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const who = String(req.body.follower_id || "");
  if (req.body.accept) {
    await supabase.from("follows").update({ status: "accepted" })
      .eq("follower_id", who).eq("following_id", me.id).eq("status", "pending");
  } else {
    await supabase.from("follows").delete()
      .eq("follower_id", who).eq("following_id", me.id).eq("status", "pending");
  }
  res.json({ ok: true });
}));

// ---------- Private one-to-one chats ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// You can message someone if their account is public, if they already
// messaged you, or if one of you follows the other
const canMsgCache = new Map();
async function canMessage(meId, targetId) {
  const key = meId + ">" + targetId;
  const hit = canMsgCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.ok;
  const ok = await canMessageSlow(meId, targetId);
  if (canMsgCache.size > 2000) canMsgCache.clear();
  canMsgCache.set(key, { ok, exp: Date.now() + (ok ? 60000 : 5000) });
  return ok;
}
async function canMessageSlow(meId, targetId) {
  if (!UUID_RE.test(String(targetId)) || meId === targetId) return false;
  if ((await blockedIds(meId)).has(targetId)) return false;
  const { data: t } = await supabase.from("profiles").select("is_private").eq("id", targetId).maybeSingle();
  if (!t) return false;
  if (!t.is_private) return true;

  const { data: prior } = await supabase
    .from("dms").select("id").eq("sender_id", targetId).eq("receiver_id", meId).limit(1);
  if (prior && prior.length) return true;

  const { data: rows } = await supabase
    .from("follows").select("status")
    .or(`and(follower_id.eq.${meId},following_id.eq.${targetId}),and(follower_id.eq.${targetId},following_id.eq.${meId})`)
    .eq("status", "accepted");
  return !!(rows && rows.length);
}

// The list of people you chat with (latest message from each)
app.get("/api/dms", requireUser, safe(async (req, res) => {
  const me = req.user.id;
  const [{ data }, { data: outRows }] = await Promise.all([
    supabase.from("dms").select("sender_id, receiver_id, text, kind, created_at")
      .or(`sender_id.eq.${me},receiver_id.eq.${me}`).order("created_at", { ascending: false }).limit(3000),
    supabase.from("follows").select("following_id").eq("follower_id", me).eq("status", "accepted"),
  ]);

  const blockedD = await blockedIds(me);
  const seen = {};
  const iSentTo = new Set();
  (data || []).forEach((m) => { if (m.sender_id === me) iSentTo.add(m.receiver_id); });
  const iFollow = new Set((outRows || []).map((r) => r.following_id));
  const chats = [];
  (data || []).forEach((m) => {
    const peer = m.sender_id === me ? m.receiver_id : m.sender_id;
    if (!seen[peer] && !blockedD.has(peer)) {
      seen[peer] = true;
      const preview = m.kind === "image" ? "📷 Photo" : m.kind === "audio" ? "🎤 Voice message" : m.kind === "video" ? "🎥 Video" : m.kind === "gif" ? "GIF" : m.kind === "sticker" ? m.text : m.kind === "reel" ? "🎬 Reel" : m.kind === "post" ? "📷 Post" : m.text || "";
      // A "request" = someone I don't follow and have never written to
      chats.push({ peer_id: peer, text: preview, time: m.created_at, mine: m.sender_id === me, request: !iFollow.has(peer) && !iSentTo.has(peer) });
    }
  });
  const [names, pics] = await Promise.all([namesFor(chats.map((c) => c.peer_id)), avatarsFor(chats.map((c) => c.peer_id))]);
  res.json({ chats: chats.map((c) => ({ ...c, username: names[c.peer_id] || "unknown", avatar: pics[c.peer_id] || null })) });
}));

// Start a chat with someone by username
app.post("/api/dms/start", requireUser, safe(async (req, res) => {
  const target = String(req.body.username || "").trim().toLowerCase().replace(/^@/, "");
  if (!target) return res.json({ message: "Type a username first." });
  const { data: t } = await supabase.from("profiles").select("id, username").eq("username", target).maybeSingle();
  if (!t) return res.json({ message: "No one has that username." });
  if (t.id === req.user.id) return res.json({ message: "That's you!" });
  if (!(await canMessage(req.user.id, t.id))) {
    return res.json({ message: "@" + t.username + " has a private account. Follow them first, and once they accept you can message them." });
  }
  res.json({ user: { id: t.id, username: t.username } });
}));

// The messages between you and one person (newest 60; ?before=ISO loads older ones)
app.get("/api/dms/:peer", requireUser, safe(async (req, res) => {
  const me = req.user.id;
  const peer = String(req.params.peer);
  if (!UUID_RE.test(peer)) return res.status(400).json({ error: "Bad request" });
  const before = validIso(req.query.before);
  let q = supabase
    .from("dms")
    .select("*")
    .or(`and(sender_id.eq.${me},receiver_id.eq.${peer}),and(sender_id.eq.${peer},receiver_id.eq.${me})`)
    .order("created_at", { ascending: false })
    .limit(61);
  if (before) q = q.lt("created_at", before);
  const { data } = await q;
  const rows = data || [];
  const more = rows.length > 60;
  const shaped = await shapeDms(rows.slice(0, 60).reverse());
  res.json({ messages: shaped, more });
  if (!before) {
    // the other person's messages are now "seen"
    supabase.from("dms").update({ read_at: new Date().toISOString() })
      .eq("sender_id", peer).eq("receiver_id", me).is("read_at", null)
      .then((r) => { if (!r.error) io.to("u:" + peer).emit("dm seen", { by: me }); }, () => {});
  }
}));

// React to a message with an emoji (same emoji again takes it back)
app.post("/api/dms/react", requireUser, limiter("rx", 120, 60000), safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const emoji = String(req.body.emoji || "").slice(0, 8);
  const { data: m } = await supabase.from("dms").select("id, sender_id, receiver_id").eq("id", id).maybeSingle();
  if (!m || (m.sender_id !== req.user.id && m.receiver_id !== req.user.id)) return res.json({ error: "Message not found." });
  const { data: ex } = await supabase.from("dm_reactions").select("emoji").eq("dm_id", id).eq("user_id", req.user.id).maybeSingle();
  if (ex && (ex.emoji === emoji || !emoji)) await supabase.from("dm_reactions").delete().eq("dm_id", id).eq("user_id", req.user.id);
  else if (emoji) await supabase.from("dm_reactions").upsert({ dm_id: id, user_id: req.user.id, emoji });
  const { data: all } = await supabase.from("dm_reactions").select("user_id, emoji").eq("dm_id", id);
  const reactions = (all || []).map((r) => ({ emoji: r.emoji, mine: r.user_id === req.user.id, by: r.user_id }));
  const other = m.sender_id === req.user.id ? m.receiver_id : m.sender_id;
  io.to("u:" + other).emit("dm react", { id, reactions: reactions.map((r) => ({ emoji: r.emoji, by: r.by })) });
  res.json({ ok: true, reactions });
}));

// Take back (unsend) a message you sent
app.post("/api/dms/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const { data: m } = await supabase.from("dms").select("id, sender_id, receiver_id, media_path").eq("id", id).maybeSingle();
  if (!m || m.sender_id !== req.user.id) return res.json({ error: "Message not found." });
  await supabase.from("dms").delete().eq("id", id);
  if (m.media_path) await supabase.storage.from(REELS_BUCKET).remove([m.media_path]);
  io.to("u:" + m.receiver_id).emit("dm deleted", { id });
  io.to("u:" + m.sender_id).emit("dm deleted", { id });
  res.json({ ok: true });
}));

// ---------- Reels (short videos) ----------
const REELS_BUCKET = "reels";

// Step 1 of posting: get a safe place to upload the video
app.post("/api/reels/upload-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const wanted = String(req.body.ext || "").toLowerCase();
  const ext = ["mp4", "mov", "webm", "m4v"].includes(wanted) ? wanted : "mp4";
  const path = req.user.id + "/" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) {
    console.error("Upload URL error:", error.message);
    return res.status(500).json({ error: "Could not start the upload. Is the 'reels' bucket created in Supabase?" });
  }
  res.json({ path, token: data.token });
}));

// Step 2 of posting: save the reel with its caption
app.post("/api/reels", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  const path = String(req.body.path || "");
  if (!me || !path.startsWith(req.user.id + "/") || path.includes("..")) return res.status(400).json({ error: "Bad request" });
  const caption = String(req.body.caption || "").trim().slice(0, 2200);
  const { error } = await supabase.from("reels").insert({ user_id: me.id, username: me.username, path, caption });
  if (error) {
    console.error("Reel save error:", error.message);
    return res.status(500).json({ error: "Could not save the reel." });
  }
  res.json({ ok: true });
}));

// The reels you are allowed to watch: yours, public accounts, and people you follow
const reelsHandler = safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const before = validIso(req.query.before);
  const blockedR = await blockedIds(me.id);
  const savedR = await savedKeys(me.id);

  let rq = supabase
    .from("reels")
    .select("id, user_id, username, path, caption, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (before) rq = rq.lt("created_at", before);
  const { data: rows } = await rq;
  let list = rows || [];

  // "Friends" tab: reels from people I follow, plus reels they reposted
  const friendsMode = req.query.friends === "1";
  const repostedBy = {};
  if (friendsMode) {
    const { data: fr } = await supabase.from("follows").select("following_id").eq("follower_id", me.id).eq("status", "accepted");
    const fset = new Set((fr || []).map((x) => x.following_id));
    const { data: rps } = fset.size ? await supabase.from("reposts").select("reel_id, user_id, created_at").in("user_id", [...fset]).order("created_at", { ascending: false }).limit(60) : { data: [] };
    const extraIds = (rps || []).map((x) => x.reel_id).filter((id) => !list.some((r) => r.id === id));
    (rps || []).forEach((x) => { if (!repostedBy[x.reel_id]) repostedBy[x.reel_id] = x.user_id; });
    if (extraIds.length) {
      const { data: more } = await supabase.from("reels").select("id, user_id, username, path, caption, created_at").in("id", extraIds);
      list = list.concat(more || []);
    }
    list = list.filter((r) => r.user_id === me.id || fset.has(r.user_id) || repostedBy[r.reel_id || r.id]);
  }

  const authorIds = [...new Set(list.map((r) => r.user_id))];
  const priv = {};
  if (authorIds.length) {
    const { data: authors } = await supabase.from("profiles").select("id, is_private").in("id", authorIds);
    (authors || []).forEach((a) => (priv[a.id] = a.is_private));
  }
  const { data: fRows } = await supabase
    .from("follows").select("following_id").eq("follower_id", me.id).eq("status", "accepted");
  const following = new Set((fRows || []).map((r) => r.following_id));

  const allowed = list
    .filter((r) => !blockedR.has(r.user_id) && (r.user_id === me.id || !priv[r.user_id] || following.has(r.user_id)))
    .slice(0, 20);
  if (!allowed.length) return res.json({ reels: [] });

  const { data: signed, error } = await signMany(allowed.map((r) => r.path), 3600);
  if (error) {
    console.error("Signed URL error:", error.message);
    return res.status(500).json({ error: "Could not load videos." });
  }
  const urlByPath = {};
  (signed || []).forEach((s) => { if (s.signedUrl) urlByPath[s.path] = s.signedUrl; });

  const [rx, pics] = await Promise.all([reelExtras(allowed.map((r) => r.id), me.id), avatarsFor([...new Set(allowed.map((r) => r.user_id))])]);
  const rbNames = Object.keys(repostedBy).length ? await namesFor([...new Set(Object.values(repostedBy))]) : {};
  res.json({
    reels: allowed
      .filter((r) => urlByPath[r.path])
      .map((r) => ({
        id: r.id,
        username: r.username,
        avatar: pics[r.user_id] || null,
        caption: r.caption,
        url: urlByPath[r.path],
        mine: r.user_id === me.id,
        time: r.created_at,
        likes: rx.likes[r.id] || 0,
        liked: !!rx.liked[r.id],
        comments: rx.comments[r.id] || 0,
        following: r.user_id === me.id || following.has(r.user_id),
        saved: savedR.has("reel:" + r.id),
        reposts: rx.reposts[r.id] || 0,
        reposted: !!rx.reposted[r.id],
        saves: rx.saves[r.id] || 0,
        shares: rx.shares[r.id] || 0,
        reposted_by: repostedBy[r.id] ? rbNames[repostedBy[r.id]] || null : null,
      })),
  });
});
app.get("/api/reels", requireUser, reelsHandler);

// Delete one of your own reels
app.post("/api/reels/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id);
  const { data: r } = await supabase.from("reels").select("id, user_id, path").eq("id", id).maybeSingle();
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: "Not found" });
  await supabase.storage.from(REELS_BUCKET).remove([r.path]);
  await supabase.from("reels").delete().eq("id", id);
  await supabase.from("reel_likes").delete().eq("reel_id", id);
  await supabase.from("reel_comments").delete().eq("reel_id", id);
  res.json({ ok: true });
}));

// Like or unlike a reel
app.post("/api/reels/like", requireUser, safe(async (req, res) => {
  const id = Number(req.body.reel_id) || 0;
  const { data: r } = await supabase.from("reels").select("id, user_id").eq("id", id).maybeSingle();
  if (!r || !(await canSeeUser(req.user.id, r.user_id))) return res.json({ error: "Reel not found." });
  const { data: ex } = await supabase.from("reel_likes").select("reel_id").eq("reel_id", id).eq("user_id", req.user.id).maybeSingle();
  if (ex) await supabase.from("reel_likes").delete().eq("reel_id", id).eq("user_id", req.user.id);
  else await supabase.from("reel_likes").insert({ reel_id: id, user_id: req.user.id });
  const { count } = await supabase.from("reel_likes").select("reel_id", { count: "exact", head: true }).eq("reel_id", id);
  res.json({ liked: !ex, likes: count || 0 });
}));

// Repost a reel (like Instagram's repost button)
app.post("/api/reels/repost", requireUser, limiter("rp", 60, 60000), safe(async (req, res) => {
  const id = Number(req.body.reel_id) || 0;
  const { data: r } = await supabase.from("reels").select("id, user_id").eq("id", id).maybeSingle();
  if (!r || !(await canSeeUser(req.user.id, r.user_id))) return res.json({ error: "Reel not found." });
  if (r.user_id === req.user.id) return res.json({ error: "You can't repost your own reel." });
  const { data: ex } = await supabase.from("reposts").select("reel_id").eq("reel_id", id).eq("user_id", req.user.id).maybeSingle();
  if (ex) await supabase.from("reposts").delete().eq("reel_id", id).eq("user_id", req.user.id);
  else {
    const { error } = await supabase.from("reposts").insert({ reel_id: id, user_id: req.user.id });
    if (error) return res.json({ error: "Could not repost. Run the new SQL first." });
  }
  const { count } = await supabase.from("reposts").select("reel_id", { count: "exact", head: true }).eq("reel_id", id);
  res.json({ reposted: !ex, reposts: count || 0 });
}));

app.get("/api/reels/:id/comments", requireUser, safe(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const { data: r } = await supabase.from("reels").select("id, user_id").eq("id", id).maybeSingle();
  if (!r || !(await canSeeUser(req.user.id, r.user_id))) return res.json({ error: "Reel not found." });
  const { data } = await supabase.from("reel_comments").select("id, user_id, username, text, created_at").eq("reel_id", id)
    .order("created_at", { ascending: true }).limit(100);
  const bl = await blockedIds(req.user.id);
  res.json({ comments: (data || []).filter((c) => !bl.has(c.user_id)).map((c) => ({ id: c.id, username: c.username, text: c.text, created_at: c.created_at, mine: c.user_id === req.user.id, can_delete: c.user_id === req.user.id || r.user_id === req.user.id })) });
}));

app.post("/api/reels/comment", requireUser, limiter("cm", 60, 60000), safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const id = Number(req.body.reel_id) || 0;
  const text = String(req.body.text || "").trim().slice(0, 2200);
  if (!text) return res.json({ error: "Write a comment first." });
  const { data: r } = await supabase.from("reels").select("id, user_id").eq("id", id).maybeSingle();
  if (!r || !(await canSeeUser(me.id, r.user_id))) return res.json({ error: "Reel not found." });
  const { error } = await supabase.from("reel_comments").insert({ reel_id: id, user_id: me.id, username: me.username, text });
  if (error) { console.error("Reel comment error:", error.message); return res.status(500).json({ error: "Could not post the comment. Did you run the v18 SQL?" }); }
  res.json({ ok: true });
}));

// ---------- Photos and shared reels in private chats ----------
// Turns saved messages into what the page needs (with safe, temporary links for photos and videos)
async function shapeDms(rows) {
  const reelIds = [...new Set(rows.filter((r) => r.reel_id).map((r) => r.reel_id))];
  const reelMap = {};
  if (reelIds.length) {
    const { data } = await supabase.from("reels").select("id, username, caption, path").in("id", reelIds);
    (data || []).forEach((r) => (reelMap[r.id] = r));
  }
  const postIdsD = [...new Set(rows.filter((r) => r.post_id).map((r) => r.post_id))];
  const postMap = {};
  if (postIdsD.length) {
    const { data } = await supabase.from("photo_posts").select("id, username, caption, path").in("id", postIdsD);
    (data || []).forEach((p) => (postMap[p.id] = p));
  }
  const replyIds = [...new Set(rows.filter((r) => r.reply_to).map((r) => r.reply_to))];
  const replyMap = {};
  if (replyIds.length) {
    const { data } = await supabase.from("dms").select("id, sender_id, text, kind").in("id", replyIds);
    (data || []).forEach((r) => (replyMap[r.id] = r));
  }
  const reactMap = {};
  if (rows.length) {
    const { data } = await supabase.from("dm_reactions").select("dm_id, user_id, emoji").in("dm_id", rows.map((r) => r.id));
    (data || []).forEach((r) => { (reactMap[r.dm_id] = reactMap[r.dm_id] || []).push({ emoji: r.emoji, by: r.user_id }); });
  }
  const paths = [...rows.map((r) => r.media_path), ...Object.values(reelMap).map((r) => r.path), ...Object.values(postMap).map((p) => p.path)].filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data } = await signMany([...new Set(paths)]);
    (data || []).forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }
  return rows.map((m) => {
    const reel = m.reel_id ? reelMap[m.reel_id] : null;
    const post = m.post_id ? postMap[m.post_id] : null;
    return {
      id: m.id,
      vanish: !!m.vanish,
      read: !!m.read_at,
      post: post ? { id: post.id, username: post.username, caption: post.caption, url: urls[post.path] || null } : null,
      from: m.sender_id,
      to: m.receiver_id,
      kind: m.kind || "text",
      text: m.text || "",
      time: m.created_at,
      image: m.media_path && m.kind === "image" ? urls[m.media_path] || null : null,
      video: m.media_path && m.kind === "video" ? urls[m.media_path] || null : null,
      audio: m.media_path && m.kind === "audio" ? urls[m.media_path] || null : null,
      reactions: reactMap[m.id] || [],
      reply: m.reply_to && replyMap[m.reply_to] ? { id: m.reply_to, from: replyMap[m.reply_to].sender_id, kind: replyMap[m.reply_to].kind || "text", text: String(replyMap[m.reply_to].text || "").slice(0, 80) } : null,
      secs: m.kind === "audio" ? parseInt(String(m.text || "0"), 10) || 0 : 0,
      peaks: m.kind === "audio" && String(m.text || "").indexOf("|") > 0 ? String(m.text).split("|")[1] : "",
      reel: reel ? { id: reel.id, username: reel.username, caption: reel.caption, url: urls[reel.path] || null } : null,
    };
  });
}

// Step 1 of sending a photo: get a safe place to upload it
app.post("/api/dms/video-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const ext = String(req.body.ext || "").toLowerCase();
  if (!["mp4", "mov", "webm", "m4v"].includes(ext)) return res.json({ error: "Unsupported video." });
  const path = req.user.id + "/vid-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: "Could not start the upload." });
  res.json({ path, token: data.token });
}));
app.post("/api/dms/voice-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const ext = String(req.body.ext || "").toLowerCase();
  if (!["webm", "mp4", "m4a", "ogg", "wav"].includes(ext)) return res.json({ error: "Unsupported audio." });
  const path = req.user.id + "/voice-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: "Could not start the upload." });
  res.json({ path, token: data.token });
}));
app.post("/api/dms/upload-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const ext = String(req.body.ext || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return res.json({ error: "Please use a JPG, PNG, GIF or WEBP photo." });
  }
  const path = req.user.id + "/chat-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) {
    console.error("Chat photo URL error:", error.message);
    return res.status(500).json({ error: "Could not start the upload." });
  }
  res.json({ path, token: data.token });
}));

// Step 2: send a photo or a reel to one person
app.post("/api/dms/send", requireUser, limiter("ds", 120, 60000), safe(async (req, res) => {
  const me = req.user.id;
  const to = String(req.body.to || "");
  if (!(await canMessage(me, to))) return res.json({ error: "You can't message this person." });

  const kind = String(req.body.kind || "");
  const row = { sender_id: me, receiver_id: to, kind, text: "" };

  if (kind === "image") {
    const path = String(req.body.path || "");
    if (!path.startsWith(me + "/chat-")) return res.json({ error: "Bad photo." });
    row.media_path = path;
  } else if (kind === "video") {
    const path = String(req.body.path || "");
    if (!path.startsWith(me + "/vid-")) return res.json({ error: "Bad video." });
    row.media_path = path;
  } else if (kind === "gif") {
    const u = String(req.body.text || "");
    let ok = false;
    try { const x = new URL(u); ok = x.protocol === "https:" && /(^|\.)giphy\.com$|(^|\.)tenor\.com$/.test(x.hostname); } catch (e) {}
    if (!ok) return res.json({ error: "Bad GIF." });
    row.text = u;
  } else if (kind === "sticker") {
    const em = String(req.body.text || "").trim();
    if (!em || em.length > 12) return res.json({ error: "Bad sticker." });
    row.text = em;
  } else if (kind === "audio") {
    const path = String(req.body.path || "");
    if (!path.startsWith(me + "/voice-")) return res.json({ error: "Bad voice message." });
    row.media_path = path;
    const peaks = String(req.body.peaks || "").replace(/[^0-9]/g, "").slice(0, 60);
    row.text = String(Math.max(1, Math.min(3600, Number(req.body.secs) || 1))) + (peaks.length >= 10 ? "|" + peaks : "");
  } else if (kind === "reel") {
    const { data: reel } = await supabase
      .from("reels").select("id, user_id").eq("id", Number(req.body.reel_id) || 0).maybeSingle();
    if (!reel) return res.json({ error: "That reel no longer exists." });
    // A private account's reel can go to the owner, or to someone who follows the owner
    if (reel.user_id !== me && reel.user_id !== to) {
      const { data: author } = await supabase.from("profiles").select("is_private").eq("id", reel.user_id).maybeSingle();
      if (author && author.is_private) {
        const { data: allowed } = await supabase
          .from("follows").select("status")
          .eq("follower_id", to).eq("following_id", reel.user_id).eq("status", "accepted").limit(1);
        if (!(allowed && allowed.length)) {
          return res.json({ error: "That reel is from a private account, and this person doesn't follow it, so they can't see it." });
        }
      }
    }
    row.reel_id = reel.id;
  } else if (kind === "post") {
    const { data: post } = await supabase.from("photo_posts").select("id, user_id").eq("id", Number(req.body.post_id) || 0).maybeSingle();
    if (!post) return res.json({ error: "That post no longer exists." });
    if (!(await canSeeUser(me, post.user_id))) return res.json({ error: "You can't share this post." });
    if (post.user_id !== me && post.user_id !== to) {
      const { data: author } = await supabase.from("profiles").select("is_private").eq("id", post.user_id).maybeSingle();
      if (author && author.is_private) {
        const { data: allowed } = await supabase.from("follows").select("status")
          .eq("follower_id", to).eq("following_id", post.user_id).eq("status", "accepted").limit(1);
        if (!(allowed && allowed.length)) return res.json({ error: "That post is from a private account, and this person doesn't follow it." });
      }
    }
    row.post_id = post.id;
  } else {
    return res.json({ error: "Unknown message type." });
  }

  const replyTo = Number(req.body.reply_to) || 0;
  if (replyTo) row.reply_to = replyTo;
  if (req.body.vanish) row.vanish = true;
  let { data: saved, error } = await supabase.from("dms").insert(row).select("*").single();
  if (error && (row.reply_to || row.vanish)) { delete row.reply_to; delete row.vanish; ({ data: saved, error } = await supabase.from("dms").insert(row).select("*").single()); }
  if (error) {
    console.error("DM media save error:", error.message);
    return res.status(500).json({ error: "Could not send that." });
  }
  const [payload] = await shapeDms([saved]);
  io.to("u:" + to).emit("dm", payload);
  io.to("u:" + me).emit("dm", payload);
  pushIfAway(to, "@" + (req.user.user_metadata && req.user.user_metadata.username || "new message"), kind === "audio" ? "🎤 Voice message" : kind === "image" ? "📷 Photo" : kind === "video" ? "🎥 Video" : kind === "gif" ? "GIF" : kind === "sticker" ? row.text : "Sent you something", { type: "dm", from: me });
  res.json({ ok: true });
}));

// ---------- Photo posts, likes and comments ----------
// Can this person see that author's posts? (themselves, public accounts, or people they follow)
async function canSeeUser(meId, authorId) {
  if (meId === authorId) return true;
  if ((await blockedIds(meId)).has(authorId)) return false;
  const { data: a } = await supabase.from("profiles").select("is_private").eq("id", authorId).maybeSingle();
  if (!a) return false;
  if (!a.is_private) return true;
  const { data: f } = await supabase
    .from("follows").select("status")
    .eq("follower_id", meId).eq("following_id", authorId).eq("status", "accepted").limit(1);
  return !!(f && f.length);
}

// Step 1 of posting: a safe place to upload the photo
app.post("/api/posts/upload-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const ext = String(req.body.ext || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return res.json({ error: "Please use a JPG, PNG, GIF or WEBP photo." });
  }
  const path = req.user.id + "/post-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) {
    console.error("Post upload URL error:", error.message);
    return res.status(500).json({ error: "Could not start the upload." });
  }
  res.json({ path, token: data.token });
}));

// Step 2: save the post with its caption
app.post("/api/posts", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  const path = String(req.body.path || "");
  if (!me || !path.startsWith(req.user.id + "/post-")) return res.status(400).json({ error: "Bad request" });
  const caption = String(req.body.caption || "").trim().slice(0, 2200);
  const { error } = await supabase.from("photo_posts").insert({ user_id: me.id, username: me.username, path, caption });
  if (error) {
    console.error("Post save error:", error.message);
    return res.status(500).json({ error: "Could not save the post." });
  }
  res.json({ ok: true });
}));

// The feed: your posts, public accounts, and people you follow
const postsHandler = safe(async (req, res) => {
  const meId = req.user.id;
  const before = validIso(req.query.before);
  const [blocked, savedP] = await Promise.all([blockedIds(meId), savedKeys(meId)]);
  let pq = supabase.from("photo_posts").select("id, user_id, username, path, caption, created_at")
    .order("created_at", { ascending: false }).limit(100);
  if (before) pq = pq.lt("created_at", before);
  const [{ data: rows }, { data: fRows }] = await Promise.all([
    pq,
    supabase.from("follows").select("following_id").eq("follower_id", meId).eq("status", "accepted"),
  ]);
  const list = rows || [];
  const following = new Set((fRows || []).map((r) => r.following_id));

  const authorIds = [...new Set(list.map((r) => r.user_id))];
  const priv = {};
  if (authorIds.length) {
    const { data: authors } = await supabase.from("profiles").select("id, is_private").in("id", authorIds);
    (authors || []).forEach((a) => (priv[a.id] = a.is_private));
  }

  const allowed = list
    .filter((r) => !blocked.has(r.user_id) && (r.user_id === meId || !priv[r.user_id] || following.has(r.user_id)))
    .slice(0, 30);
  if (!allowed.length) return res.json({ posts: [] });

  const ids = allowed.map((r) => r.id);
  const [{ data: likeRows }, { data: comRows }, signedRes, pics] = await Promise.all([
    supabase.from("photo_likes").select("post_id, user_id").in("post_id", ids),
    supabase.from("photo_comments").select("post_id").in("post_id", ids),
    signMany(allowed.map((r) => r.path)),
    avatarsFor(allowed.map((r) => r.user_id)),
  ]);
  const likes = {};
  const liked = {};
  const comments = {};
  (likeRows || []).forEach((l) => {
    likes[l.post_id] = (likes[l.post_id] || 0) + 1;
    if (l.user_id === meId) liked[l.post_id] = true;
  });
  (comRows || []).forEach((c) => { comments[c.post_id] = (comments[c.post_id] || 0) + 1; });

  if (signedRes.error) {
    console.error("Post signed URL error:", signedRes.error.message);
    return res.status(500).json({ error: "Could not load photos." });
  }
  const urls = {};
  (signedRes.data || []).forEach((x) => { urls[x.path] = x.signedUrl; });

  res.json({
    posts: allowed
      .filter((r) => urls[r.path])
      .map((r) => ({
        id: r.id,
        username: r.username,
        avatar: pics[r.user_id] || null,
        caption: r.caption,
        url: urls[r.path],
        time: r.created_at,
        mine: r.user_id === meId,
        likes: likes[r.id] || 0,
        liked: !!liked[r.id],
        comments: comments[r.id] || 0,
        following: following.has(r.user_id),
        saved: savedP.has("post:" + r.id),
      })),
  });
});
app.get("/api/posts", requireUser, postsHandler);

// Run one of the handlers above and hand back what it would have sent
function callHandler(handler, req) {
  return new Promise((resolve) => {
    const fake = { status() { return fake; }, json(x) { resolve(x); return fake; } };
    handler(req, fake);
  });
}

// Home feed in ONE request: photos and videos together, newest first, page by page
app.get("/api/feed", requireUser, safe(async (req, res) => {
  const [p, r] = await Promise.all([callHandler(postsHandler, req), callHandler(reelsHandler, req)]);
  if (p.error && r.error) return res.json({ error: p.error });
  const items = (p.posts || []).map((x) => ({ ...x, kind: "post" }))
    .concat((r.reels || []).map((x) => ({ ...x, kind: "reel" })));
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  const PAGE = 12;
  const page = items.slice(0, PAGE);
  res.json({ items: page, next: items.length > PAGE ? page[page.length - 1].time : null });
}));

// Explore: popular posts and videos from people you don't follow yet
app.get("/api/explore", requireUser, safe(async (req, res) => {
  const [p, r] = await Promise.all([callHandler(postsHandler, req), callHandler(reelsHandler, req)]);
  const items = (p.posts || []).map((x) => ({ ...x, kind: "post" }))
    .concat((r.reels || []).map((x) => ({ ...x, kind: "reel" })))
    .filter((x) => !x.mine);
  const score = (x) => (x.likes || 0) + (x.comments || 0) * 2 + (x.following ? 0 : 5);
  items.sort((a, b) => score(b) - score(a) || new Date(b.time) - new Date(a.time));
  res.json({ items: items.slice(0, 30) });
}));

// Like or unlike a post
app.post("/api/posts/like", requireUser, safe(async (req, res) => {
  const id = Number(req.body.post_id) || 0;
  const { data: p } = await supabase.from("photo_posts").select("id, user_id").eq("id", id).maybeSingle();
  if (!p || !(await canSeeUser(req.user.id, p.user_id))) return res.json({ error: "Post not found." });

  const { data: ex } = await supabase
    .from("photo_likes").select("post_id").eq("post_id", id).eq("user_id", req.user.id).maybeSingle();
  if (ex) await supabase.from("photo_likes").delete().eq("post_id", id).eq("user_id", req.user.id);
  else await supabase.from("photo_likes").insert({ post_id: id, user_id: req.user.id });

  const { count } = await supabase
    .from("photo_likes").select("post_id", { count: "exact", head: true }).eq("post_id", id);
  res.json({ liked: !ex, likes: count || 0 });
}));

// The comments on a post
app.get("/api/posts/:id/comments", requireUser, safe(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const { data: p } = await supabase.from("photo_posts").select("id, user_id").eq("id", id).maybeSingle();
  if (!p || !(await canSeeUser(req.user.id, p.user_id))) return res.json({ error: "Post not found." });
  const { data } = await supabase
    .from("photo_comments")
    .select("id, user_id, username, text, created_at")
    .eq("post_id", id)
    .order("created_at", { ascending: true })
    .limit(100);
  const bl = await blockedIds(req.user.id);
  res.json({ comments: (data || []).filter((c) => !bl.has(c.user_id)).map((c) => ({ id: c.id, username: c.username, text: c.text, created_at: c.created_at, mine: c.user_id === req.user.id, can_delete: c.user_id === req.user.id || p.user_id === req.user.id })) });
}));

// Add a comment
app.post("/api/posts/comment", requireUser, limiter("cm", 60, 60000), safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const id = Number(req.body.post_id) || 0;
  const text = String(req.body.text || "").trim().slice(0, 2200);
  if (!text) return res.json({ error: "Write a comment first." });
  const { data: p } = await supabase.from("photo_posts").select("id, user_id").eq("id", id).maybeSingle();
  if (!p || !(await canSeeUser(me.id, p.user_id))) return res.json({ error: "Post not found." });
  const { error } = await supabase
    .from("photo_comments").insert({ post_id: id, user_id: me.id, username: me.username, text });
  if (error) {
    console.error("Comment error:", error.message);
    return res.status(500).json({ error: "Could not post the comment." });
  }
  res.json({ ok: true });
}));

// ---------- Comments (Instagram style): replies, likes, pictures and GIFs ----------
const CKIND = {
  reel: { t: "reel_comments", fk: "reel_id", item: "reels" },
  post: { t: "photo_comments", fk: "post_id", item: "photo_posts" },
};
app.get("/api/comments/:kind/:id", requireUser, safe(async (req, res) => {
  const k = CKIND[req.params.kind];
  const id = Number(req.params.id) || 0;
  if (!k) return res.status(400).json({ error: "Bad request" });
  const { data: it } = await supabase.from(k.item).select("id, user_id").eq("id", id).maybeSingle();
  if (!it || !(await canSeeUser(req.user.id, it.user_id))) return res.json({ error: "Not found." });
  let q = await supabase.from(k.t).select("id, user_id, username, text, created_at, parent_id, media_path").eq(k.fk, id).order("created_at", { ascending: true }).limit(1500);
  if (q.error) q = await supabase.from(k.t).select("id, user_id, username, text, created_at").eq(k.fk, id).order("created_at", { ascending: true }).limit(1500);
  const bl = await blockedIds(req.user.id);
  const rows = (q.data || []).filter((c) => !bl.has(c.user_id));
  const ids = rows.map((c) => c.id);
  const likes = {}, liked = {};
  if (ids.length) {
    const { data: lk } = await supabase.from("comment_likes").select("comment_id, user_id").eq("kind", req.params.kind).in("comment_id", ids);
    (lk || []).forEach((x) => { likes[x.comment_id] = (likes[x.comment_id] || 0) + 1; if (x.user_id === req.user.id) liked[x.comment_id] = true; });
  }
  const pics = await avatarsFor([...new Set(rows.map((c) => c.user_id))]);
  const own = rows.map((c) => c.media_path).filter((p) => p && !/^https:/.test(p));
  const urls = {};
  if (own.length) { const { data: sg } = await signMany(own); (sg || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; }); }
  res.json({
    comments: rows.map((c) => ({
      id: c.id, parent_id: c.parent_id || null, username: c.username, avatar: pics[c.user_id] || null, text: c.text || "",
      created_at: c.created_at, likes: likes[c.id] || 0, liked: !!liked[c.id], mine: c.user_id === req.user.id,
      can_delete: c.user_id === req.user.id || it.user_id === req.user.id, by_owner: c.user_id === it.user_id,
      media: c.media_path ? (/^https:/.test(c.media_path) ? c.media_path : urls[c.media_path] || null) : null,
    })),
  });
}));
app.post("/api/comments", requireUser, limiter("cm", 60, 60000), safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  const k = CKIND[req.body.kind];
  const id = Number(req.body.id) || 0;
  if (!me || !k) return res.status(400).json({ error: "Bad request" });
  const text = String(req.body.text || "").trim().slice(0, 2200);
  let media = String(req.body.media || "");
  if (media) {
    let ok = media.startsWith(me.id + "/cm-");
    if (!ok) { try { const u = new URL(media); ok = u.protocol === "https:" && /(^|\.)giphy\.com$|(^|\.)tenor\.com$/.test(u.hostname); } catch (e) {} }
    if (!ok) media = "";
  }
  if (!text && !media) return res.json({ error: "Write a comment first." });
  const { data: it } = await supabase.from(k.item).select("id, user_id").eq("id", id).maybeSingle();
  if (!it || !(await canSeeUser(me.id, it.user_id))) return res.json({ error: "Not found." });
  const row = { [k.fk]: id, user_id: me.id, username: me.username, text };
  let parent = Number(req.body.parent_id) || 0;
  if (parent) {
    const { data: pc } = await supabase.from(k.t).select("id, parent_id").eq("id", parent).maybeSingle();
    parent = pc ? (pc.parent_id || pc.id) : 0; // replies stay one level deep, like Instagram
    if (parent) row.parent_id = parent;
  }
  if (media) row.media_path = media;
  let { error } = await supabase.from(k.t).insert(row);
  if (error && (row.parent_id || row.media_path)) { console.error("Comment error:", error.message); return res.json({ error: "Could not post that. Run the new SQL in Supabase first." }); }
  if (error) return res.status(500).json({ error: "Could not post the comment." });
  res.json({ ok: true });
}));
app.post("/api/comments/like", requireUser, limiter("cl", 200, 60000), safe(async (req, res) => {
  const kind = req.body.kind === "reel" ? "reel" : "post";
  const id = Number(req.body.id) || 0;
  const { data: ex } = await supabase.from("comment_likes").select("comment_id").eq("user_id", req.user.id).eq("kind", kind).eq("comment_id", id).maybeSingle();
  if (ex) await supabase.from("comment_likes").delete().eq("user_id", req.user.id).eq("kind", kind).eq("comment_id", id);
  else { const { error } = await supabase.from("comment_likes").insert({ user_id: req.user.id, kind, comment_id: id }); if (error) return res.json({ error: "Run the new SQL first." }); }
  const { count } = await supabase.from("comment_likes").select("comment_id", { count: "exact", head: true }).eq("kind", kind).eq("comment_id", id);
  res.json({ liked: !ex, likes: count || 0 });
}));
app.post("/api/comments/upload-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const ext = String(req.body.ext || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return res.json({ error: "Please use a JPG, PNG, GIF or WEBP picture." });
  const path = req.user.id + "/cm-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: "Could not start the upload." });
  res.json({ path, token: data.token });
}));
// GIF search (turns on when you add GIPHY_API_KEY in Render's Environment settings)
app.get("/api/gifs", requireUser, limiter("gif", 60, 60000), safe(async (req, res) => {
  const key = process.env.GIPHY_API_KEY;
  if (!key) return res.json({ enabled: false, gifs: [] });
  const q = String(req.query.q || "").trim().slice(0, 60);
  const url = q
    ? "https://api.giphy.com/v1/gifs/search?api_key=" + encodeURIComponent(key) + "&q=" + encodeURIComponent(q) + "&limit=30&rating=pg-13"
    : "https://api.giphy.com/v1/gifs/trending?api_key=" + encodeURIComponent(key) + "&limit=30&rating=pg-13";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    res.json({ enabled: true, gifs: (j.data || []).map((g) => ({ url: g.images && g.images.fixed_height && g.images.fixed_height.url, preview: g.images && g.images.fixed_height_small && g.images.fixed_height_small.url })).filter((g) => g.url) });
  } catch (e) { res.json({ enabled: true, gifs: [] }); }
}));

// Delete a comment (your own, or any comment on your own post / reel)
app.post("/api/comments/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const isReel = req.body.kind === "reel";
  const ctable = isReel ? "reel_comments" : "photo_comments";
  const { data: c } = await supabase.from(ctable).select("id, user_id, " + (isReel ? "reel_id" : "post_id")).eq("id", id).maybeSingle();
  if (!c) return res.json({ error: "Comment not found." });
  let ownsItem = false;
  if (c.user_id !== req.user.id) {
    const { data: it } = await supabase.from(isReel ? "reels" : "photo_posts").select("user_id").eq("id", isReel ? c.reel_id : c.post_id).maybeSingle();
    ownsItem = !!(it && it.user_id === req.user.id);
  }
  if (c.user_id !== req.user.id && !ownsItem) return res.status(403).json({ error: "Not allowed." });
  await supabase.from(ctable).delete().eq("parent_id", id);
  await supabase.from(ctable).delete().eq("id", id);
  res.json({ ok: true });
}));

// Delete one of your own posts
app.post("/api/posts/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const { data: p } = await supabase.from("photo_posts").select("id, user_id, path").eq("id", id).maybeSingle();
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: "Not found" });
  await supabase.storage.from(REELS_BUCKET).remove([p.path]);
  await supabase.from("photo_posts").delete().eq("id", id);
  res.json({ ok: true });
}));

// Every connection must prove who it is BEFORE it can chat
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error("Not logged in"));

    const user = await userFromToken(token);
    if (!user) return next(new Error("Not logged in"));

    const name =
      (user.user_metadata && user.user_metadata.username) ||
      String(user.email || "user").split("@")[0];

    socket.data.userId = user.id;
    socket.data.username = String(name).slice(0, 20);
    next();
  } catch (e) {
    next(new Error("Not logged in"));
  }
});

// Runs every time a logged-in person opens the chat
io.on("connection", async (socket) => {
  // Each person gets a private "mailbox" so only they receive their messages
  socket.join("u:" + socket.data.userId);

  // "…is typing" and "seen"
  socket.on("typing", (msg) => {
    const to = String((msg && msg.to) || "");
    if (!UUID_RE.test(to) || !allow("ty:" + socket.data.userId, 20, 10000)) return;
    io.to("u:" + to).emit("typing", { from: socket.data.userId });
  });
  socket.on("dm read", async (msg) => {
    const peer = String((msg && msg.peer) || "");
    if (!UUID_RE.test(peer) || !allow("rd:" + socket.data.userId, 60, 10000)) return;
    const r = await supabase.from("dms").update({ read_at: new Date().toISOString() })
      .eq("sender_id", peer).eq("receiver_id", socket.data.userId).is("read_at", null);
    if (!r.error) io.to("u:" + peer).emit("dm seen", { by: socket.data.userId });
  });

  // Vanish mode: when someone leaves the chat, messages that were seen disappear
  socket.on("vanish clear", async (msg) => {
    try {
      const peer = String((msg && msg.peer) || "");
      const me = socket.data.userId;
      if (!UUID_RE.test(peer) || !allow("vc:" + me, 30, 10000)) return;
      const { data: rows } = await supabase.from("dms").select("id, sender_id, receiver_id, read_at, media_path")
        .eq("vanish", true)
        .or(`and(sender_id.eq.${peer},receiver_id.eq.${me}),and(sender_id.eq.${me},receiver_id.eq.${peer})`).limit(500);
      const gone = (rows || []).filter((r) => r.receiver_id === me || r.read_at);
      if (!gone.length) return;
      const files = gone.map((r) => r.media_path).filter(Boolean);
      if (files.length) await supabase.storage.from(REELS_BUCKET).remove(files);
      await supabase.from("dm_reactions").delete().in("dm_id", gone.map((r) => r.id));
      await supabase.from("dms").delete().in("id", gone.map((r) => r.id));
      gone.forEach((r) => { io.to("u:" + me).to("u:" + peer).emit("dm deleted", { id: r.id }); });
    } catch (e) { console.error(e); }
  });

  // A private message to one person
  socket.on("dm", async (msg) => {
    try {
      const to = String((msg && msg.to) || "");
      const text = String((msg && msg.text) || "").slice(0, 4000);
      if (!text.trim() || !UUID_RE.test(to)) return;

      if (!(await canMessage(socket.data.userId, to))) {
        socket.emit("dm error", "You can't message this person.");
        return;
      }
      if (!allow("dm:" + socket.data.userId, 40, 10000)) {
        socket.emit("dm error", "Slow down a little.");
        return;
      }
      const replyTo = Number(msg && msg.reply_to) || 0;
      const ins = { sender_id: socket.data.userId, receiver_id: to, text };
      if (replyTo) ins.reply_to = replyTo;
      const vanish = !!(msg && msg.vanish);
      if (vanish) ins.vanish = true;
      let { data: saved, error } = await supabase.from("dms").insert(ins).select("id, created_at").single();
      if (error && (replyTo || vanish)) { delete ins.reply_to; delete ins.vanish; ({ data: saved, error } = await supabase.from("dms").insert(ins).select("id, created_at").single()); }
      if (error) {
        console.error("DM save error:", error.message);
        socket.emit("dm error", "Could not send that message.");
        return;
      }
      const cid = String((msg && msg.cid) || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
      let reply = null;
      if (ins.reply_to) {
        const { data: rm } = await supabase.from("dms").select("id, sender_id, text, kind").eq("id", ins.reply_to).maybeSingle();
        if (rm) reply = { id: rm.id, from: rm.sender_id, kind: rm.kind || "text", text: String(rm.text || "").slice(0, 80) };
      }
      const payload = { id: saved.id, from: socket.data.userId, to, text, time: utc(saved.created_at), cid, reply, reactions: [], vanish: !!ins.vanish };
      io.to("u:" + to).emit("dm", payload);
      io.to("u:" + socket.data.userId).emit("dm", payload);
      pushIfAway(to, "@" + (socket.data.username || "new message"), ins.vanish ? "Vanish message" : text, { type: "dm", from: socket.data.userId });
    } catch (e) {
      console.error(e);
    }
  });
});

// ---------- Push notifications (Firebase). Optional: needs FIREBASE_SERVICE_ACCOUNT on Render ----------
let fbAdmin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require("firebase-admin");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    fbAdmin = admin;
    console.log("Push notifications: ON");
  }
} catch (e) { console.error("Push setup failed:", e.message); }

async function pushTo(userId, title, body, data) {
  if (!fbAdmin) return;
  try {
    const { data: rows } = await supabase.from("push_tokens").select("token").eq("user_id", userId).limit(10);
    if (!rows || !rows.length) return;
    const tokens = rows.map((r) => r.token);
    const out = await fbAdmin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: String(title).slice(0, 80), body: String(body).slice(0, 160) },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
      android: { priority: "high", notification: { channelId: "default", sound: "default" } },
    });
    const dead = [];
    out.responses.forEach((r, i) => { if (!r.success && r.error && /registration-token-not-registered|invalid-argument|invalid-registration/.test(r.error.code || "")) dead.push(tokens[i]); });
    if (dead.length) await supabase.from("push_tokens").delete().in("token", dead);
  } catch (e) { console.error("push error:", e.message); }
}
const pushIfAway = (userId, title, body, data) => { if (!onlineCount.get(userId)) pushTo(userId, title, body, data); };

app.post("/api/push/register", requireUser, safe(async (req, res) => {
  const token = String(req.body.token || "").slice(0, 500);
  if (token.length < 20) return res.json({ error: "Bad token" });
  await supabase.from("push_tokens").upsert({ token, user_id: req.user.id, platform: String(req.body.platform || "").slice(0, 20) }, { onConflict: "token" });
  res.json({ ok: true, push: !!fbAdmin });
}));
app.post("/api/push/unregister", requireUser, safe(async (req, res) => {
  await supabase.from("push_tokens").delete().eq("token", String(req.body.token || "")).eq("user_id", req.user.id);
  res.json({ ok: true });
}));

// ---------- Call relay (TURN) so calls work on every network ----------
app.get("/api/rtc-config", requireUser, (req, res) => {
  const ice = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  const urls = String(process.env.TURN_URLS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (urls.length) ice.push({ urls, username: process.env.TURN_USERNAME || "", credential: process.env.TURN_CREDENTIAL || "" });
  res.set("Cache-Control", "no-store");
  res.json({ iceServers: ice, turn: urls.length > 0 });
});

// ---------- Story highlights ----------
app.get("/api/highlights/:uid", requireUser, safe(async (req, res) => {
  const uid = String(req.params.uid || "");
  if (!UUID_RE.test(uid)) return res.json({ highlights: [] });
  if (uid !== req.user.id && !(await canSeeUser(req.user.id, uid))) return res.json({ highlights: [] });
  const { data: hs, error } = await supabase.from("highlights").select("id, title, created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(50);
  if (error || !hs || !hs.length) return res.json({ highlights: [] });
  const { data: items } = await supabase.from("highlight_items").select("id, highlight_id, path, kind, caption, created_at").in("highlight_id", hs.map((h) => h.id)).order("created_at", { ascending: true }).limit(1000);
  const { data: signed } = await signMany([...new Set((items || []).map((i) => i.path))], 3600);
  const urls = {};
  (signed || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
  res.json({ highlights: hs.map((h) => ({ id: h.id, title: h.title, mine: uid === req.user.id, items: (items || []).filter((i) => i.highlight_id === h.id && urls[i.path]).map((i) => ({ id: i.id, url: urls[i.path], kind: i.kind, caption: i.caption || "", time: i.created_at })) })).filter((h) => h.items.length) });
}));
app.post("/api/highlights", requireUser, limiter("hl", 40, 60000), safe(async (req, res) => {
  const me = req.user.id;
  const { data: st } = await supabase.from("stories").select("id, user_id, path, kind, caption").eq("id", Number(req.body.story_id) || 0).maybeSingle();
  if (!st || st.user_id !== me) return res.json({ error: "Story not found." });
  let hid = Number(req.body.highlight_id) || 0;
  if (hid) {
    const { data: h } = await supabase.from("highlights").select("id").eq("id", hid).eq("user_id", me).maybeSingle();
    if (!h) return res.json({ error: "Highlight not found." });
  } else {
    const title = String(req.body.title || "").trim().slice(0, 40) || "Highlights";
    const { data: h, error } = await supabase.from("highlights").insert({ user_id: me, title }).select("id").single();
    if (error) return res.json({ error: "Run the v25 SQL in Supabase first." });
    hid = h.id;
  }
  const ext = (st.path.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5);
  const np = me + "/hl-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const cp = await supabase.storage.from(REELS_BUCKET).copy(st.path, np);
  if (cp.error) return res.json({ error: "Could not save that story." });
  await supabase.from("highlight_items").insert({ highlight_id: hid, path: np, kind: st.kind, caption: st.caption || "" });
  res.json({ ok: true, id: hid });
}));
app.post("/api/highlights/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const { data: h } = await supabase.from("highlights").select("id").eq("id", id).eq("user_id", req.user.id).maybeSingle();
  if (!h) return res.json({ error: "Not found." });
  const { data: items } = await supabase.from("highlight_items").select("path").eq("highlight_id", id);
  if (items && items.length) await supabase.storage.from(REELS_BUCKET).remove(items.map((i) => i.path));
  await supabase.from("highlight_items").delete().eq("highlight_id", id);
  await supabase.from("highlights").delete().eq("id", id);
  res.json({ ok: true });
}));
app.post("/api/highlights/item-delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const { data: it } = await supabase.from("highlight_items").select("id, path, highlight_id").eq("id", id).maybeSingle();
  if (!it) return res.json({ error: "Not found." });
  const { data: h } = await supabase.from("highlights").select("id").eq("id", it.highlight_id).eq("user_id", req.user.id).maybeSingle();
  if (!h) return res.json({ error: "Not found." });
  await supabase.storage.from(REELS_BUCKET).remove([it.path]);
  await supabase.from("highlight_items").delete().eq("id", id);
  res.json({ ok: true });
}));

// ---------- Private groups ----------
async function isMember(groupId, userId) {
  const { data } = await supabase
    .from("group_members").select("user_id").eq("group_id", groupId).eq("user_id", userId).maybeSingle();
  return !!data;
}

// You can only add people you follow, or who follow you
async function isConnected(a, b) {
  const { data } = await supabase
    .from("follows")
    .select("status")
    .or(`and(follower_id.eq.${a},following_id.eq.${b}),and(follower_id.eq.${b},following_id.eq.${a})`)
    .eq("status", "accepted")
    .limit(1);
  return !!(data && data.length);
}

async function addMembers(groupId, me, usernames) {
  const notes = [];
  for (const raw of usernames) {
    const name = String(raw).trim().toLowerCase().replace(/^@/, "");
    if (!name) continue;
    const { data: t } = await supabase.from("profiles").select("id, username").eq("username", name).maybeSingle();
    if (!t) { notes.push("@" + name + " not found"); continue; }
    if (t.id === me.id) continue;
    if (!(await isConnected(me.id, t.id))) {
      notes.push("@" + name + ": you can only add people you follow or who follow you");
      continue;
    }
    await supabase.from("group_members").upsert({ group_id: groupId, user_id: t.id }, { onConflict: "group_id,user_id" });
    notes.push("@" + name + " added");
  }
  return notes;
}

// My groups
app.get("/api/groups", requireUser, safe(async (req, res) => {
  const { data: mem } = await supabase.from("group_members").select("group_id").eq("user_id", req.user.id);
  const ids = (mem || []).map((m) => m.group_id);
  if (!ids.length) return res.json({ groups: [] });
  let gq = await supabase.from("chat_groups").select("id, name, owner_id, avatar_path").in("id", ids).order("created_at", { ascending: false });
  if (gq.error) gq = await supabase.from("chat_groups").select("id, name, owner_id").in("id", ids).order("created_at", { ascending: false });
  const gs = gq.data || [];
  const withPic = gs.filter((g) => g.avatar_path);
  const urls = {};
  if (withPic.length) {
    const { data: sg } = await signMany(withPic.map((g) => g.avatar_path), 3600);
    (sg || []).forEach((x) => { if (x.signedUrl) urls[x.path] = x.signedUrl; });
  }
  res.json({ groups: gs.map((g) => ({ id: g.id, name: g.name, mine: g.owner_id === req.user.id, avatar: g.avatar_path ? urls[g.avatar_path] || null : null })) });
}));
app.post("/api/groups/upload-url", requireUser, limiter("up", 80, 60000), safe(async (req, res) => {
  const ext = String(req.body.ext || "").toLowerCase();
  if (!["jpg", "jpeg", "png", "webp"].includes(ext)) return res.json({ error: "Please use a JPG, PNG or WEBP photo." });
  const path = req.user.id + "/group-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
  const { data, error } = await supabase.storage.from(REELS_BUCKET).createSignedUploadUrl(path);
  if (error) return res.status(500).json({ error: "Could not start the upload." });
  res.json({ path, token: data.token });
}));
app.post("/api/groups/picture", requireUser, safe(async (req, res) => {
  const gid = Number(req.body.group_id) || 0;
  const path = String(req.body.path || "");
  const { data: g } = await supabase.from("chat_groups").select("id, owner_id").eq("id", gid).maybeSingle();
  if (!g || g.owner_id !== req.user.id) return res.json({ error: "Only the person who made the group can change its picture." });
  if (!path.startsWith(req.user.id + "/group-")) return res.status(400).json({ error: "Bad request" });
  const { error } = await supabase.from("chat_groups").update({ avatar_path: path }).eq("id", gid);
  if (error) return res.json({ error: "Could not save the picture. Run the new SQL first." });
  res.json({ ok: true });
}));
app.post("/api/groups", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const name = String(req.body.name || "").trim().slice(0, 60);
  if (!name) return res.json({ message: "Give the group a name." });

  const pic = String(req.body.picture || "");
  const row = { name, owner_id: me.id };
  if (pic && pic.startsWith(me.id + "/group-")) row.avatar_path = pic;
  let { data: g, error } = await supabase.from("chat_groups").insert(row).select().single();
  if (error && row.avatar_path) { delete row.avatar_path; ({ data: g, error } = await supabase.from("chat_groups").insert(row).select().single()); }
  if (error) {
    console.error("Group error:", error.message);
    return res.status(500).json({ error: "Could not create the group." });
  }
  await supabase.from("group_members").insert({ group_id: g.id, user_id: me.id });
  const notes = await addMembers(g.id, me, String(req.body.usernames || "").split(","));
  res.json({ id: g.id, message: ("Group created. " + notes.join("; ")).trim() });
}));

// Add a member (only the person who made the group can do this)
app.post("/api/groups/add", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const gid = Number(req.body.group_id);
  const { data: g } = await supabase.from("chat_groups").select("id").eq("id", gid).eq("owner_id", me.id).maybeSingle();
  if (!g) return res.status(403).json({ error: "Only the group owner can add people." });
  const notes = await addMembers(gid, me, [req.body.username]);
  res.json({ message: notes.join("; ") || "Type a username first." });
}));

// Group members and the last 50 messages (members only)
app.get("/api/groups/:id/messages", requireUser, safe(async (req, res) => {
  const gid = Number(req.params.id);
  if (!(await isMember(gid, req.user.id))) return res.status(403).json({ error: "You are not in this group." });

  const { data } = await supabase
    .from("group_messages")
    .select("user_id, username, text, created_at")
    .eq("group_id", gid)
    .order("created_at", { ascending: false })
    .limit(50);
  const { data: mem } = await supabase.from("group_members").select("user_id").eq("group_id", gid);
  const names = await namesFor((mem || []).map((m) => m.user_id));

  res.json({
    members: Object.values(names),
    messages: (data || []).reverse().map((m) => ({ uid: m.user_id, user: m.username, text: m.text, time: m.created_at })),
  });
}));

// ---------- Languages: translate the app's words (cached, so it is fast) ----------
const i18nCache = new Map();
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
async function gtx(lang, text, sl) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + (sl || "en") + "&tl=" + encodeURIComponent(lang) + "&dt=t&q=" + encodeURIComponent(text);
  const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error("translate " + r.status);
  const j = await r.json();
  return (j[0] || []).map((x) => x[0]).join("");
}
async function translateMany(lang, strings, sl) {
  const out = {};
  const todo = [];
  strings.forEach((t) => {
    const hit = i18nCache.get(lang + "|" + (sl || "") + "|" + t);
    if (hit) out[t] = hit; else todo.push(t);
  });
  const chunks = [];
  for (let i = 0; i < todo.length; i += 25) chunks.push(todo.slice(i, i + 25));
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const res = await gtx(lang, chunk.join("\n"), sl);
      const parts = res.split("\n");
      if (parts.length === chunk.length) {
        chunk.forEach((t, i) => { const v = parts[i].trim(); if (v) { out[t] = v; i18nCache.set(lang + "|" + (sl || "") + "|" + t, v); } });
        return;
      }
      for (const t of chunk) {
        try { const v = (await gtx(lang, t, sl)).trim(); if (v) { out[t] = v; i18nCache.set(lang + "|" + (sl || "") + "|" + t, v); } } catch (e) {}
      }
    } catch (e) {}
  }));
  return out;
}
app.post("/api/i18n", requireUser, limiter("i18n", 40, 60000), safe(async (req, res) => {
  const lang = String((req.body && req.body.lang) || "");
  if (!LANG_RE.test(lang)) return res.status(400).json({ error: "Bad language" });
  const strings = (Array.isArray(req.body && req.body.strings) ? req.body.strings : [])
    .filter((t) => typeof t === "string" && t.length > 0 && t.length <= 300 && !t.includes("\n")).slice(0, 400);
  res.json({ lang, map: await translateMany(lang, strings, req.body && req.body.auto ? "auto" : "") });
}));

// ---------- Live video (people go live, friends watch) ----------
const lives = new Map(); // userId -> { username, audience, sid, viewers:Set }
async function canWatchLive(viewerId, hostId, audience) {
  if (viewerId === hostId) return true;
  if ((await blockedIds(viewerId)).has(hostId) || (await blockedIds(hostId)).has(viewerId)) return false;
  const { data } = await supabase.from("follows").select("status").eq("follower_id", viewerId).eq("following_id", hostId).eq("status", "accepted").maybeSingle();
  if (!data) return false;
  if (audience !== "friends") return true;
  const { data: back } = await supabase.from("follows").select("status").eq("follower_id", hostId).eq("following_id", viewerId).eq("status", "accepted").maybeSingle();
  return !!back;
}
app.get("/api/live", requireUser, safe(async (req, res) => {
  const out = [];
  for (const [uid, l] of lives) {
    if (uid === req.user.id) continue;
    if (await canWatchLive(req.user.id, uid, l.audience)) {
      const pics = await avatarsFor([uid]);
      out.push({ id: uid, username: l.username, avatar: pics[uid] || null, viewers: l.viewers.size });
    }
  }
  res.json({ lives: out });
}));
function endLive(uid, reason) {
  const l = lives.get(uid);
  if (!l) return;
  lives.delete(uid);
  io.to("live:" + uid).emit("live ended", { host: uid, reason: reason || "ended" });
  io.in("live:" + uid).socketsLeave("live:" + uid);
}
io.on("connection", (socket) => {
  const uid = socket.data.userId;
  socket.on("live start", (msg) => {
    if (!allow("lv:" + uid, 5, 60000)) return;
    endLive(uid);
    lives.set(uid, { username: socket.data.username, audience: msg && msg.audience === "friends" ? "friends" : "all", sid: socket.id, viewers: new Set() });
    socket.emit("live started", { ok: true });
  });
  socket.on("live stop", () => endLive(uid));
  socket.on("live join", async (msg) => {
    const host = String((msg && msg.host) || "");
    const l = lives.get(host);
    if (!UUID_RE.test(host) || !l || !allow("lj:" + uid, 20, 60000)) return socket.emit("live ended", { host, reason: "gone" });
    if (!(await canWatchLive(uid, host, l.audience))) return socket.emit("live ended", { host, reason: "private" });
    socket.join("live:" + host);
    l.viewers.add(socket.id);
    io.to(l.sid).emit("live viewer", { viewer: socket.id, username: socket.data.username });
    io.to("live:" + host).to(l.sid).emit("live count", { host, n: l.viewers.size });
  });
  socket.on("live leave", (msg) => {
    const host = String((msg && msg.host) || "");
    const l = lives.get(host);
    socket.leave("live:" + host);
    if (l) { l.viewers.delete(socket.id); io.to("live:" + host).to(l.sid).emit("live count", { host, n: l.viewers.size }); }
  });
  socket.on("live signal", (msg) => {
    const to = String((msg && msg.to) || "");
    if (!to || !allow("ls:" + uid, 400, 10000)) return;
    io.to(to).emit("live signal", { from: socket.id, data: msg.data });
  });
  socket.on("live chat", (msg) => {
    const host = String((msg && msg.host) || "");
    const l = lives.get(host);
    const text = String((msg && msg.text) || "").trim().slice(0, 200);
    if (!l || !text || !allow("lc:" + uid, 20, 10000)) return;
    if (host !== uid && !l.viewers.has(socket.id)) return;
    io.to("live:" + host).to(l.sid).emit("live chat", { host, user: socket.data.username, text });
  });
  socket.on("disconnect", () => {
    if (lives.has(uid) && lives.get(uid).sid === socket.id) endLive(uid, "ended");
    lives.forEach((l, host) => { if (l.viewers.delete(socket.id)) io.to("live:" + host).to(l.sid).emit("live count", { host, n: l.viewers.size }); });
  });
});

// ---------- Calls: voice and video, 1-to-1 and groups ----------
const callRooms = new Map(); // room -> Map(socketId -> { uid, username })
const CALL_MAX = 8;
async function callRoomInfo(uid, room) {
  room = String(room || "");
  let m = room.match(/^dm:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
  if (m) {
    if (uid !== m[1] && uid !== m[2]) return null;
    const other = uid === m[1] ? m[2] : m[1];
    if (!(await canMessage(uid, other)) && !(await canMessage(other, uid))) return null;
    return { kind: "dm", targets: [other], name: null };
  }
  m = room.match(/^g:(\d+)$/);
  if (m) {
    const gid = Number(m[1]);
    if (!(await isMember(gid, uid))) return null;
    const { data: mem } = await supabase.from("group_members").select("user_id").eq("group_id", gid);
    const { data: g } = await supabase.from("chat_groups").select("name").eq("id", gid).maybeSingle();
    return { kind: "group", targets: (mem || []).map((x) => x.user_id).filter((x) => x !== uid), name: g ? g.name : "Group" };
  }
  return null;
}
function callLeave(socket, room) {
  const r = callRooms.get(room);
  if (!r || !r.has(socket.id)) return;
  r.delete(socket.id);
  socket.leave("call:" + room);
  io.to("call:" + room).emit("call left", { room, sid: socket.id });
  if (!r.size) callRooms.delete(room);
}
io.on("connection", (socket) => {
  const uid = socket.data.userId;
  const joined = new Set();
  socket.on("call ring", async (msg) => {
    try {
      if (!allow("cr:" + uid, 12, 60000)) return;
      const room = String((msg && msg.room) || "");
      const info = await callRoomInfo(uid, room);
      if (!info) return;
      info.targets.forEach((t) => { io.to("u:" + t).emit("call incoming", { room, from: uid, username: socket.data.username, video: !!(msg && msg.video), group: info.name }); pushIfAway(t, "📞 " + (socket.data.username || "Someone") + " is calling", msg && msg.video ? "Video call" : "Voice call", { type: "call", room }); });
    } catch (e) {}
  });
  socket.on("call cancel", async (msg) => {
    try {
      const room = String((msg && msg.room) || "");
      const info = await callRoomInfo(uid, room);
      if (info) info.targets.forEach((t) => io.to("u:" + t).emit("call cancelled", { room }));
    } catch (e) {}
  });
  socket.on("call decline", (msg) => {
    const to = String((msg && msg.to) || "");
    if (UUID_RE.test(to)) io.to("u:" + to).emit("call declined", { room: String((msg && msg.room) || ""), username: socket.data.username });
  });
  socket.on("call join", async (msg) => {
    try {
      if (!allow("cj:" + uid, 20, 60000)) return;
      const room = String((msg && msg.room) || "");
      const info = await callRoomInfo(uid, room);
      if (!info) return socket.emit("call error", { error: "You can't join this call." });
      let r = callRooms.get(room);
      if (!r) { r = new Map(); callRooms.set(room, r); }
      if (r.size >= CALL_MAX && !r.has(socket.id)) return socket.emit("call error", { error: "This call is full." });
      const peers = [...r.entries()].filter(([sid]) => sid !== socket.id).map(([sid, p]) => ({ sid, uid: p.uid, username: p.username }));
      r.set(socket.id, { uid, username: socket.data.username });
      socket.join("call:" + room);
      joined.add(room);
      socket.emit("call peers", { room, peers });
    } catch (e) {}
  });
  socket.on("call signal", (msg) => {
    const to = String((msg && msg.to) || "");
    if (!to || !allow("cs:" + uid, 600, 10000)) return;
    io.to(to).emit("call signal", { from: socket.id, username: socket.data.username, uid, data: msg.data });
  });
  socket.on("call leave", (msg) => {
    const room = String((msg && msg.room) || "");
    joined.delete(room);
    callLeave(socket, room);
  });
  socket.on("disconnect", () => { joined.forEach((room) => callLeave(socket, room)); });
});

// ---------- Who is online ----------
const onlineCount = new Map();
const lastSeenMap = new Map();
io.on("connection", (socket) => {
  const uid = socket.data.userId;
  onlineCount.set(uid, (onlineCount.get(uid) || 0) + 1);
  socket.on("disconnect", () => {
    const n = (onlineCount.get(uid) || 1) - 1;
    if (n <= 0) {
      onlineCount.delete(uid);
      const now = new Date().toISOString();
      lastSeenMap.set(uid, now);
      supabase.from("profiles").update({ last_seen: now }).eq("id", uid).then(() => {}, () => {});
    } else onlineCount.set(uid, n);
  });
});
app.get("/api/presence/:id", requireUser, safe(async (req, res) => {
  const id = String(req.params.id || "");
  if (!UUID_RE.test(id)) return res.json({ online: false });
  if (!(await canMessage(req.user.id, id)) && !(await canMessage(id, req.user.id))) return res.json({ online: false });
  if (onlineCount.has(id)) return res.json({ online: true });
  let last = lastSeenMap.get(id) || null;
  if (!last) { const { data } = await supabase.from("profiles").select("last_seen").eq("id", id).maybeSingle(); last = data && data.last_seen ? new Date(data.last_seen).toISOString() : null; }
  res.json({ online: false, last });
}));

// ---------- Edit a caption ----------
app.post("/api/posts/edit", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const caption = String(req.body.caption || "").trim().slice(0, 2200);
  const { error } = await supabase.from("photo_posts").update({ caption }).eq("id", id).eq("user_id", req.user.id);
  res.json(error ? { error: "Could not save." } : { ok: true });
}));
app.post("/api/reels/edit", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id) || 0;
  const caption = String(req.body.caption || "").trim().slice(0, 2200);
  const { error } = await supabase.from("reels").update({ caption }).eq("id", id).eq("user_id", req.user.id);
  res.json(error ? { error: "Could not save." } : { ok: true });
}));

// Live group chat
io.on("connection", (socket) => {
  socket.on("group join", async (msg) => {
    const gid = Number(msg && msg.groupId);
    if (gid && (await isMember(gid, socket.data.userId))) socket.join("group:" + gid);
  });

  socket.on("group message", async (msg) => {
    const gid = Number(msg && msg.groupId);
    const text = String((msg && msg.text) || "").slice(0, 4000);
    if (!gid || !text.trim()) return;
    if (!(await isMember(gid, socket.data.userId))) return;

    const { data: saved, error } = await supabase
      .from("group_messages")
      .insert({ group_id: gid, user_id: socket.data.userId, username: socket.data.username, text })
      .select("created_at")
      .single();
    if (error) { console.error("Group message error:", error.message); return; }

    io.to("group:" + gid).emit("group message", {
      groupId: gid,
      uid: socket.data.userId,
      user: socket.data.username,
      text,
      time: utc(saved.created_at),
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat app running on port ${PORT}`);
});

// Render's free plan puts the app to sleep after ~15 minutes without visitors, and waking it up is the slow part.
// Visiting our own address every 9 minutes keeps it awake.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + "/healthz").catch(() => {}); }, 9 * 60 * 1000).unref();
}
