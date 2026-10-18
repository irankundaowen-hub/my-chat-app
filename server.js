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
const server = http.createServer(app);
const io = new Server(server);

// Serve the chat page from the "public" folder
app.use(express.static("public"));

// The web page asks for these two PUBLIC values so it can show the login form.
// (The secret service key is never sent to the browser.)
app.get("/config", (req, res) => {
  res.json({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
});

// ---------- Profiles and followers ----------
app.use(express.json());

// Checks the login token on every /api request
async function requireUser(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Not logged in" });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return res.status(401).json({ error: "Not logged in" });
  req.user = data.user;
  next();
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
    const { data, error } = await supabase
      .from("profiles")
      .insert({ id: user.id, username: name })
      .select()
      .single();
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
  const { data: signed } = await supabase.storage.from("reels").createSignedUrls(withPic.map((p) => p.avatar_path), 3600);
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
    const { data: signed } = await supabase.storage.from("reels").createSignedUrl(me.avatar_path, 3600);
    avatarUrl = signed ? signed.signedUrl : null;
  }

  const { count: postCount } = await supabase.from("photo_posts").select("id", { count: "exact", head: true }).eq("user_id", me.id);
  const { count: reelCount } = await supabase.from("reels").select("id", { count: "exact", head: true }).eq("user_id", me.id);

  res.json({
    username: me.username,
    display_name: me.display_name || "",
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
  const bio = String(req.body.bio || "").trim().slice(0, 150);
  const update = { bio };
  if (typeof req.body.name === "string") update.display_name = req.body.name.trim().slice(0, 30);
  const { error } = await supabase.from("profiles").update(update).eq("id", me.id);
  if (error) return res.status(500).json({ error: "Could not save. Did you run the profile SQL in Supabase?" });
  res.json({ ok: true });
}));

// Someone's photos and reels, ready for a grid (viewerId decides which are "mine" / "liked")
async function mediaFor(userId, viewerId) {
  const { data: pRows } = await supabase
    .from("photo_posts").select("id, username, path, caption").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(60);
  const { data: rRows } = await supabase
    .from("reels").select("id, username, path, caption").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(60);
  const posts = pRows || [];
  const reels = rRows || [];
  const paths = [...posts.map((p) => p.path), ...reels.map((r) => r.path)];
  const urls = {};
  if (paths.length) {
    const { data: signed } = await supabase.storage.from(REELS_BUCKET).createSignedUrls(paths, 3600);
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
  return {
    posts: posts.filter((p) => urls[p.path]).map((p) => ({
      id: p.id, username: p.username, avatar: null, caption: p.caption, url: urls[p.path], mine,
      likes: likes[p.id] || 0, liked: !!liked[p.id], comments: comments[p.id] || 0,
    })),
    reels: reels.filter((r) => urls[r.path]).map((r) => ({
      id: r.id, username: r.username, caption: r.caption, url: urls[r.path], mine,
    })),
  };
}

// My own photos and reels (for the grid on my profile)
app.get("/api/me/media", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  res.json(await mediaFor(me.id, me.id));
}));

// ---------- Stories (disappear after 24 hours) ----------
const STORY_HOURS = 24;
let lastStoryCleanup = 0;

async function cleanupStories() {
  if (Date.now() - lastStoryCleanup < 10 * 60 * 1000) return;
  lastStoryCleanup = Date.now();
  const cutoff = new Date(Date.now() - STORY_HOURS * 3600 * 1000).toISOString();
  const { data: old } = await supabase.from("stories").select("id, path").lt("created_at", cutoff).limit(200);
  if (!old || !old.length) return;
  await supabase.storage.from(REELS_BUCKET).remove(old.map((o) => o.path));
  await supabase.from("stories").delete().in("id", old.map((o) => o.id));
}

app.post("/api/stories/upload-url", requireUser, safe(async (req, res) => {
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
  const caption = String(req.body.caption || "").trim().slice(0, 120);
  const { error } = await supabase.from("stories").insert({ user_id: me.id, username: me.username, path, kind, caption });
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

// My stories + stories of people I follow who follow me back
app.get("/api/stories", requireUser, safe(async (req, res) => {
  const meId = req.user.id;
  cleanupStories().catch(() => {});

  const { data: outRows } = await supabase.from("follows").select("following_id").eq("follower_id", meId).eq("status", "accepted");
  const { data: inRows } = await supabase.from("follows").select("follower_id").eq("following_id", meId).eq("status", "accepted");
  const iFollow = new Set((outRows || []).map((r) => r.following_id));
  const mutual = (inRows || []).map((r) => r.follower_id).filter((id) => iFollow.has(id));
  const ids = [meId, ...mutual];

  const cutoff = new Date(Date.now() - STORY_HOURS * 3600 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from("stories").select("id, user_id, username, path, kind, caption, created_at")
    .in("user_id", ids).gte("created_at", cutoff).order("created_at", { ascending: true }).limit(300);
  if (error) return res.json({ groups: [] });
  const list = rows || [];
  if (!list.length) return res.json({ groups: [] });

  const { data: signed } = await supabase.storage.from(REELS_BUCKET).createSignedUrls(list.map((r) => r.path), 3600);
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
  const list = data || [];
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
    username: u.username, display_name: u.display_name || "", bio: u.bio || "", avatar: pics[u.id] || null,
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
app.post("/api/follow", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const target = String(req.body.username || "").trim().toLowerCase().replace(/^@/, "");
  if (!target) return res.json({ message: "Type a username first." });

  const { data: t } = await supabase
    .from("profiles").select("id, username, is_private").eq("username", target).maybeSingle();
  if (!t) return res.json({ message: "No one has that username." });
  if (t.id === me.id) return res.json({ message: "That's you!" });

  const { data: already } = await supabase
    .from("follows").select("status").eq("follower_id", me.id).eq("following_id", t.id).maybeSingle();
  if (already) {
    return res.json({ message: already.status === "pending" ? "Request already sent." : "You already follow them." });
  }

  const status = t.is_private ? "pending" : "accepted";
  await supabase.from("follows").insert({ follower_id: me.id, following_id: t.id, status });
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
async function canMessage(meId, targetId) {
  if (!UUID_RE.test(String(targetId)) || meId === targetId) return false;
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
  const { data } = await supabase
    .from("dms")
    .select("sender_id, receiver_id, text, kind, created_at")
    .or(`sender_id.eq.${me},receiver_id.eq.${me}`)
    .order("created_at", { ascending: false })
    .limit(200);

  const seen = {};
  const chats = [];
  (data || []).forEach((m) => {
    const peer = m.sender_id === me ? m.receiver_id : m.sender_id;
    if (!seen[peer]) {
      seen[peer] = true;
      const preview = m.kind === "image" ? "📷 Photo" : m.kind === "reel" ? "🎬 Reel" : m.text || "";
      chats.push({ peer_id: peer, text: preview, time: m.created_at });
    }
  });
  const names = await namesFor(chats.map((c) => c.peer_id));
  const pics = await avatarsFor(chats.map((c) => c.peer_id));
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

// The messages between you and one person
app.get("/api/dms/:peer", requireUser, safe(async (req, res) => {
  const me = req.user.id;
  const peer = String(req.params.peer);
  if (!UUID_RE.test(peer)) return res.status(400).json({ error: "Bad request" });
  const { data } = await supabase
    .from("dms")
    .select("*")
    .or(`and(sender_id.eq.${me},receiver_id.eq.${peer}),and(sender_id.eq.${peer},receiver_id.eq.${me})`)
    .order("created_at", { ascending: false })
    .limit(100);
  res.json({ messages: await shapeDms((data || []).reverse()) });
}));

// ---------- Reels (short videos) ----------
const REELS_BUCKET = "reels";

// Step 1 of posting: get a safe place to upload the video
app.post("/api/reels/upload-url", requireUser, safe(async (req, res) => {
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
  if (!me || !path.startsWith(req.user.id + "/")) return res.status(400).json({ error: "Bad request" });
  const caption = String(req.body.caption || "").trim().slice(0, 150);
  const { error } = await supabase.from("reels").insert({ user_id: me.id, username: me.username, path, caption });
  if (error) {
    console.error("Reel save error:", error.message);
    return res.status(500).json({ error: "Could not save the reel." });
  }
  res.json({ ok: true });
}));

// The reels you are allowed to watch: yours, public accounts, and people you follow
app.get("/api/reels", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });

  const { data: rows } = await supabase
    .from("reels")
    .select("id, user_id, username, path, caption, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const list = rows || [];

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
    .filter((r) => r.user_id === me.id || !priv[r.user_id] || following.has(r.user_id))
    .slice(0, 20);
  if (!allowed.length) return res.json({ reels: [] });

  const { data: signed, error } = await supabase.storage
    .from(REELS_BUCKET)
    .createSignedUrls(allowed.map((r) => r.path), 3600);
  if (error) {
    console.error("Signed URL error:", error.message);
    return res.status(500).json({ error: "Could not load videos." });
  }
  const urlByPath = {};
  (signed || []).forEach((s) => { if (s.signedUrl) urlByPath[s.path] = s.signedUrl; });

  res.json({
    reels: allowed
      .filter((r) => urlByPath[r.path])
      .map((r) => ({
        id: r.id,
        username: r.username,
        caption: r.caption,
        url: urlByPath[r.path],
        mine: r.user_id === me.id,
      })),
  });
}));

// Delete one of your own reels
app.post("/api/reels/delete", requireUser, safe(async (req, res) => {
  const id = Number(req.body.id);
  const { data: r } = await supabase.from("reels").select("id, user_id, path").eq("id", id).maybeSingle();
  if (!r || r.user_id !== req.user.id) return res.status(404).json({ error: "Not found" });
  await supabase.storage.from(REELS_BUCKET).remove([r.path]);
  await supabase.from("reels").delete().eq("id", id);
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
  const paths = [...rows.map((r) => r.media_path), ...Object.values(reelMap).map((r) => r.path)].filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data } = await supabase.storage.from(REELS_BUCKET).createSignedUrls([...new Set(paths)], 3600);
    (data || []).forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  }
  return rows.map((m) => {
    const reel = m.reel_id ? reelMap[m.reel_id] : null;
    return {
      from: m.sender_id,
      to: m.receiver_id,
      kind: m.kind || "text",
      text: m.text || "",
      time: m.created_at,
      image: m.media_path ? urls[m.media_path] || null : null,
      reel: reel ? { username: reel.username, caption: reel.caption, url: urls[reel.path] || null } : null,
    };
  });
}

// Step 1 of sending a photo: get a safe place to upload it
app.post("/api/dms/upload-url", requireUser, safe(async (req, res) => {
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
app.post("/api/dms/send", requireUser, safe(async (req, res) => {
  const me = req.user.id;
  const to = String(req.body.to || "");
  if (!(await canMessage(me, to))) return res.json({ error: "You can't message this person." });

  const kind = String(req.body.kind || "");
  const row = { sender_id: me, receiver_id: to, kind, text: "" };

  if (kind === "image") {
    const path = String(req.body.path || "");
    if (!path.startsWith(me + "/chat-")) return res.json({ error: "Bad photo." });
    row.media_path = path;
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
  } else {
    return res.json({ error: "Unknown message type." });
  }

  const { data: saved, error } = await supabase.from("dms").insert(row).select("*").single();
  if (error) {
    console.error("DM media save error:", error.message);
    return res.status(500).json({ error: "Could not send that." });
  }
  const [payload] = await shapeDms([saved]);
  io.to("u:" + to).emit("dm", payload);
  io.to("u:" + me).emit("dm", payload);
  res.json({ ok: true });
}));

// ---------- Photo posts, likes and comments ----------
// Can this person see that author's posts? (themselves, public accounts, or people they follow)
async function canSeeUser(meId, authorId) {
  if (meId === authorId) return true;
  const { data: a } = await supabase.from("profiles").select("is_private").eq("id", authorId).maybeSingle();
  if (!a) return false;
  if (!a.is_private) return true;
  const { data: f } = await supabase
    .from("follows").select("status")
    .eq("follower_id", meId).eq("following_id", authorId).eq("status", "accepted").limit(1);
  return !!(f && f.length);
}

// Step 1 of posting: a safe place to upload the photo
app.post("/api/posts/upload-url", requireUser, safe(async (req, res) => {
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
  const caption = String(req.body.caption || "").trim().slice(0, 200);
  const { error } = await supabase.from("photo_posts").insert({ user_id: me.id, username: me.username, path, caption });
  if (error) {
    console.error("Post save error:", error.message);
    return res.status(500).json({ error: "Could not save the post." });
  }
  res.json({ ok: true });
}));

// The feed: your posts, public accounts, and people you follow
app.get("/api/posts", requireUser, safe(async (req, res) => {
  const meId = req.user.id;
  const { data: rows } = await supabase
    .from("photo_posts")
    .select("id, user_id, username, path, caption, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const list = rows || [];

  const authorIds = [...new Set(list.map((r) => r.user_id))];
  const priv = {};
  if (authorIds.length) {
    const { data: authors } = await supabase.from("profiles").select("id, is_private").in("id", authorIds);
    (authors || []).forEach((a) => (priv[a.id] = a.is_private));
  }
  const { data: fRows } = await supabase
    .from("follows").select("following_id").eq("follower_id", meId).eq("status", "accepted");
  const following = new Set((fRows || []).map((r) => r.following_id));

  const allowed = list
    .filter((r) => r.user_id === meId || !priv[r.user_id] || following.has(r.user_id))
    .slice(0, 30);
  if (!allowed.length) return res.json({ posts: [] });

  const ids = allowed.map((r) => r.id);
  const { data: likeRows } = await supabase.from("photo_likes").select("post_id, user_id").in("post_id", ids);
  const { data: comRows } = await supabase.from("photo_comments").select("post_id").in("post_id", ids);
  const likes = {};
  const liked = {};
  const comments = {};
  (likeRows || []).forEach((l) => {
    likes[l.post_id] = (likes[l.post_id] || 0) + 1;
    if (l.user_id === meId) liked[l.post_id] = true;
  });
  (comRows || []).forEach((c) => { comments[c.post_id] = (comments[c.post_id] || 0) + 1; });

  const { data: signed, error } = await supabase.storage
    .from(REELS_BUCKET)
    .createSignedUrls(allowed.map((r) => r.path), 3600);
  if (error) {
    console.error("Post signed URL error:", error.message);
    return res.status(500).json({ error: "Could not load photos." });
  }
  const urls = {};
  (signed || []).forEach((s) => { if (s.signedUrl) urls[s.path] = s.signedUrl; });
  const pics = await avatarsFor(allowed.map((r) => r.user_id));

  res.json({
    posts: allowed
      .filter((r) => urls[r.path])
      .map((r) => ({
        id: r.id,
        username: r.username,
        avatar: pics[r.user_id] || null,
        caption: r.caption,
        url: urls[r.path],
        mine: r.user_id === meId,
        likes: likes[r.id] || 0,
        liked: !!liked[r.id],
        comments: comments[r.id] || 0,
      })),
  });
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
    .select("username, text, created_at")
    .eq("post_id", id)
    .order("created_at", { ascending: true })
    .limit(100);
  res.json({ comments: data || [] });
}));

// Add a comment
app.post("/api/posts/comment", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const id = Number(req.body.post_id) || 0;
  const text = String(req.body.text || "").trim().slice(0, 300);
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

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return next(new Error("Not logged in"));

    const user = data.user;
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

  // A private message to one person
  socket.on("dm", async (msg) => {
    try {
      const to = String((msg && msg.to) || "");
      const text = String((msg && msg.text) || "").slice(0, 500);
      if (!text.trim() || !UUID_RE.test(to)) return;

      if (!(await canMessage(socket.data.userId, to))) {
        socket.emit("dm error", "You can't message this person.");
        return;
      }
      const { data: saved, error } = await supabase
        .from("dms")
        .insert({ sender_id: socket.data.userId, receiver_id: to, text })
        .select("created_at")
        .single();
      if (error) {
        console.error("DM save error:", error.message);
        socket.emit("dm error", "Could not send that message.");
        return;
      }
      const payload = { from: socket.data.userId, to, text, time: saved.created_at };
      io.to("u:" + to).emit("dm", payload);
      io.to("u:" + socket.data.userId).emit("dm", payload);
    } catch (e) {
      console.error(e);
    }
  });

  // Send the last 50 saved messages to the person who just joined
  const { data, error } = await supabase
    .from("messages")
    .select("user_id, username, text, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("Could not load history:", error.message);
  } else {
    const history = data.reverse().map((m) => ({
      uid: m.user_id,
      user: m.username,
      text: m.text,
      time: m.created_at,
    }));
    socket.emit("history", history);
  }

  // When this person sends a message...
  socket.on("chat message", async (msg) => {
    const text = String((msg && msg.text) || "").slice(0, 500);
    if (!text.trim()) return; // ignore empty messages

    // The name comes from the login, so nobody can pretend to be someone else
    const row = {
      user_id: socket.data.userId,
      username: socket.data.username,
      text,
    };

    // ...save it in the database...
    const { data: saved, error: saveError } = await supabase
      .from("messages")
      .insert(row)
      .select("created_at")
      .single();

    if (saveError) {
      console.error("Could not save message:", saveError.message);
      return;
    }

    // ...and send it to EVERYONE connected
    io.emit("chat message", {
      uid: row.user_id,
      user: row.username,
      text: row.text,
      time: saved.created_at,
    });
  });
});

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
  const { data: gs } = await supabase
    .from("chat_groups").select("id, name, owner_id").in("id", ids).order("created_at", { ascending: false });
  res.json({ groups: (gs || []).map((g) => ({ id: g.id, name: g.name, mine: g.owner_id === req.user.id })) });
}));

// Create a group (and add people by username)
app.post("/api/groups", requireUser, safe(async (req, res) => {
  const me = await getOrCreateProfile(req.user);
  if (!me) return res.status(500).json({ error: "Could not load profile" });
  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name) return res.json({ message: "Give the group a name." });

  const { data: g, error } = await supabase.from("chat_groups").insert({ name, owner_id: me.id }).select().single();
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

// Live group chat
io.on("connection", (socket) => {
  socket.on("group join", async (msg) => {
    const gid = Number(msg && msg.groupId);
    if (gid && (await isMember(gid, socket.data.userId))) socket.join("group:" + gid);
  });

  socket.on("group message", async (msg) => {
    const gid = Number(msg && msg.groupId);
    const text = String((msg && msg.text) || "").slice(0, 500);
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
      time: saved.created_at,
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat app running on port ${PORT}`);
});
