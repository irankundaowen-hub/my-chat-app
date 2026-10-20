// Twik Chat: cleans a video before it becomes a reel.
// It removes the TikTok-style corner logo (delogo), cuts the logo screen at the end and wipes the file's hidden labels.
const { spawn } = require("child_process");
const fs = require("fs");

function ffmpegBin() {
  try { return require("@ffmpeg-installer/ffmpeg").path; } catch (e) {}
  try { const p = require("ffmpeg-static"); if (p) return p; } catch (e) {}
  return process.env.FFMPEG_PATH || "ffmpeg";
}

// run ffmpeg and collect everything it prints
function run(args, { timeoutMs = 360000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} }, timeoutMs);
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => { err += d.toString(); if (err.length > 200000) err = err.slice(-100000); });
    p.on("error", (e) => { clearTimeout(kill); resolve({ code: -1, out: Buffer.alloc(0), err: String(e) }); });
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, out: Buffer.concat(out), err }); });
  });
}

async function probe(file) {
  const r = await run(["-hide_banner", "-i", file, "-frames:v", "1", "-vf", "scale=540:-2,format=rgb24", "-f", "rawvideo", "-"]);
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.err);
  const dur = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 0;
  const H = r.out.length ? Math.round(r.out.length / (540 * 3)) : 0;
  const sm = /Stream #\d+:\d+[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(r.err);
  let sw = sm ? Number(sm[1]) : 540, sh = sm ? Number(sm[2]) : H;
  // the frame we got is already upright: if the sizes disagree about portrait/landscape, swap
  if (H && sw && sh && (H > 540) !== (sh > sw)) { const t = sw; sw = sh; sh = t; }
  return { dur, W: 540, H, srcW: sw, srcH: sh, ok: !!H };
}

function boxCount(src, W, H, r) {
  // 1 where something is within r pixels (square window)
  const tmp = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    const row = y * W;
    for (let x = 0; x < Math.min(r, W); x++) s += src[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) s += src[row + x + r];
      if (x - r - 1 >= 0) s -= src[row + x - r - 1];
      tmp[row + x] = s;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < Math.min(r, H); y++) s += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) s += tmp[(y + r) * W + x];
      if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * W + x];
      out[y * W + x] = s > 0 ? 1 : 0;
    }
  }
  return out;
}

// Looks at one picture: how dark is it, and is there a TikTok-style logo (blue-green and red edges side by side)?
function analyzeFrame(buf, W, H) {
  const n = W * H;
  const cy = new Uint8Array(n), rd = new Uint8Array(n);
  let sum = 0, dark = 0, cnt = 0;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = buf[p], g = buf[p + 1], b = buf[p + 2];
    if ((i & 3) === 0) { const l = (r * 77 + g * 150 + b * 29) >> 8; sum += l; cnt++; if (l < 45) dark++; }
    if (g - r > 28 && b - r > 28 && Math.abs(g - b) < 45) cy[i] = 1;
    else if (r - g > 40 && r - b > 25) rd[i] = 1;
  }
  const out = { mean: sum / cnt, dark: dark / cnt, det: null };
  const cyd = boxCount(cy, W, H, 3), rdd = boxCount(rd, W, H, 3);
  const F = new Uint8Array(n);
  let any = 0;
  for (let i = 0; i < n; i++) if ((cy[i] && rdd[i]) || (rd[i] && cyd[i])) { F[i] = 1; any++; }
  if (any < 30) return out;
  // 26x26 windows via an integral image
  const IW = W + 1;
  const I = new Int32Array(IW * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += F[y * W + x]; I[(y + 1) * IW + x + 1] = I[y * IW + x + 1] + row; }
  }
  const K = 26;
  let best = 0, bx = 0, by = 0;
  for (let y = 0; y + K <= H; y += 2) {
    for (let x = 0; x + K <= W; x += 2) {
      const c = I[(y + K) * IW + x + K] - I[y * IW + x + K] - I[(y + K) * IW + x] + I[y * IW + x];
      if (c > best) { best = c; bx = x; by = y; }
    }
  }
  if (best < 40) return out;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = Math.max(0, by - 24); y < Math.min(H, by + K + 24); y++) {
    for (let x = Math.max(0, bx - 24); x < Math.min(W, bx + K + 24); x++) {
      if (F[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  out.det = { x0, y0, x1, y1, count: best };
  return out;
}

async function analyze(file, info) {
  const W = info.W, H = info.H, size = W * H * 3;
  const frames = [];
  await new Promise((resolve) => {
    const p = spawn(ffmpegBin(), ["-v", "error", "-i", file, "-an", "-t", "240", "-vf", "fps=2,scale=540:-2,format=rgb24", "-f", "rawvideo", "-"], { stdio: ["ignore", "pipe", "ignore"] });
    let pending = Buffer.alloc(0);
    let idx = 0;
    const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} }, 240000);
    p.stdout.on("data", (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= size) {
        const f = analyzeFrame(pending.subarray(0, size), W, H);
        f.t = idx * 0.5;
        frames.push(f);
        idx++;
        pending = pending.subarray(size);
      }
    });
    p.on("error", () => { clearTimeout(kill); resolve(); });
    p.on("close", () => { clearTimeout(kill); resolve(); });
  });
  return frames;
}

// Decides what to remove
function makePlan(frames, dur, W, H) {
  const plan = { trimAt: null, boxes: [], notes: [] };
  if (frames.length < 3) return plan;
  const last = frames[frames.length - 1].t + 0.5;
  const total = Math.max(dur || 0, last);

  // 1) a dark logo screen at the very end
  let k = frames.length;
  while (k > 0 && frames[k - 1].mean < 75 && frames[k - 1].dark > 0.75) k--;
  if (k < frames.length && k >= 2) {
    const before = frames[k - 1].mean, after = frames[k].mean;
    let earlier = 0;
    for (let i = 0; i < k; i++) earlier = Math.max(earlier, frames[i].mean);
    if (before - after > 25 && earlier > 60 && total - frames[k].t <= 15) {
      plan.trimAt = Math.max(1, frames[k - 1].t + 0.15);
      plan.notes.push("end screen cut at " + plan.trimAt.toFixed(1) + "s");
    }
  }

  // 2) a logo that sits in one place for a while
  const lim = plan.trimAt == null ? Infinity : plan.trimAt;
  const clusters = [];
  frames.filter((f) => f.det && f.t < lim).forEach((f) => {
    const d = f.det;
    const cx = (d.x0 + d.x1) / 2, cyy = (d.y0 + d.y1) / 2;
    // a real logo stays in exactly the same place
    const c = clusters.find((q) => Math.abs(q.cx - cx) < 10 && Math.abs(q.cy - cyy) < 10 && f.t - q.t1 <= 1.1);
    if (c) { c.t1 = f.t; c.n++; c.str = Math.max(c.str, d.count); c.x0 = Math.min(c.x0, d.x0); c.y0 = Math.min(c.y0, d.y0); c.x1 = Math.max(c.x1, d.x1); c.y1 = Math.max(c.y1, d.y1); }
    else clusters.push({ cx, cy: cyy, t0: f.t, t1: f.t, n: 1, str: d.count, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 });
  });
  const good = clusters.filter((c) => c.n >= 5 || (c.n >= 3 && c.str >= 90));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const addBox = (x0, y0, x1, y1, a, b) => {
    x0 = clamp(Math.round(x0), 6, W - 14); y0 = clamp(Math.round(y0), 6, H - 14);
    x1 = clamp(Math.round(x1), x0 + 8, W - 6); y1 = clamp(Math.round(y1), y0 + 8, H - 6);
    plan.boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, a: Math.max(0, a), b });
  };
  good.sort((p, q) => p.t0 - q.t0).forEach((c, i) => {
    const bw = 0.4 * W, bh = 0.15 * W;
    addBox(c.x0 - 0.04 * W, c.y0 - 0.05 * W, c.x0 - 0.04 * W + bw, c.y0 - 0.05 * W + bh, c.t0 - 0.7, c.t1 + 0.7);
    plan.notes.push("logo at " + Math.round(c.cx) + "," + Math.round(c.cy) + " " + c.t0 + "-" + c.t1 + "s");
    // TikTok starts in a top corner and later moves to the opposite bottom corner
    if (i === 0 && c.t0 <= 3 && c.cy < H * 0.25 && c.t1 < total * 0.9) {
      const end = plan.trimAt == null ? total + 1 : plan.trimAt;
      const fromRight = c.cx < W / 2;
      if (fromRight) addBox(W * 0.62, H * 0.915, W * 0.955, H * 0.985, c.t1 - 0.5, end);
      else addBox(W * 0.045, H * 0.915, W * 0.38, H * 0.985, c.t1 - 0.5, end);
      plan.notes.push("logo moves to the opposite corner");
    }
  });
  return plan;
}

// Tries to read hidden labels from the start / end of the file
function hasMarkers(file) {
  const MARK = ["tiktok", "douyin", "musical.ly", "bytedance", "snaptik", "ssstik", "tikmate", "musicaldown", "savetik", "snapinsta", "instagram", "kuaishou", "likee", "snackvideo", "com.zhiliaoapp"];
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, 1048576);
    const a = Buffer.alloc(n), b = Buffer.alloc(n);
    fs.readSync(fd, a, 0, n, 0);
    fs.readSync(fd, b, 0, n, Math.max(0, size - n));
    fs.closeSync(fd);
    const t = a.toString("latin1").toLowerCase() + b.toString("latin1").toLowerCase();
    return MARK.some((m) => t.includes(m));
  } catch (e) {
    return false;
  }
}

// input -> output.mp4. Returns { changed, notes }.  If nothing needed removing, the file is left alone.
async function cleanVideo(input, output) {
  const info = await probe(input);
  if (!info.ok) return { changed: false, notes: ["could not read the video"] };
  const frames = await analyze(input, info);
  const plan = makePlan(frames, info.dur, info.W, info.H);
  const marked = hasMarkers(input);
  const notes = plan.notes.slice();
  if (!plan.boxes.length && plan.trimAt == null && !marked) return { changed: false, notes };

  const outW = Math.max(2, Math.min(720, info.srcW || 720)) & ~1;
  const sc = outW / info.W;
  const outH = Math.round(info.H * sc) & ~1;
  let graph = "[0:v:0]scale=" + outW + ":" + outH;
  let cur = "s0";
  graph += "[s0]";
  let j = 0;
  plan.boxes.forEach((b) => {
    const fx = Math.max(1, Math.round(b.x * sc)), fy = Math.max(1, Math.round(b.y * sc));
    const fw = Math.min(Math.round(b.w * sc), outW - fx - 2), fh = Math.min(Math.round(b.h * sc), outH - fy - 2);
    if (fw < 8 || fh < 8) return;
    const en = "enable='between(t," + b.a.toFixed(2) + "," + b.b.toFixed(2) + ")'";
    j++;
    graph += ";[" + cur + "]delogo=x=" + fx + ":y=" + fy + ":w=" + fw + ":h=" + fh + ":" + en + "[d" + j + "]";
    graph += ";[d" + j + "]split=2[bg" + j + "][fg" + j + "]";
    graph += ";[fg" + j + "]crop=" + fw + ":" + fh + ":" + fx + ":" + fy + ",gblur=sigma=7:steps=2[bl" + j + "]";
    graph += ";[bg" + j + "][bl" + j + "]overlay=" + fx + ":" + fy + ":" + en + "[c" + j + "]";
    cur = "c" + j;
  });
  graph += ";[" + cur + "]format=yuv420p[vout]";
  const args = ["-y", "-v", "error", "-i", input];
  if (plan.trimAt != null) args.push("-t", plan.trimAt.toFixed(2));
  args.push("-filter_complex", graph, "-map", "[vout]", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-c:a", "aac", "-b:a", "128k",
    "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    "-movflags", "+faststart", output);
  const r = await run(args, { timeoutMs: 420000 });
  if (r.code !== 0 || !fs.existsSync(output) || fs.statSync(output).size < 1000) {
    return { changed: false, failed: true, notes: notes.concat(["encode failed: " + r.err.slice(-300)]) };
  }
  return { changed: true, notes, plan };
}

module.exports = { cleanVideo, makePlan, analyze, probe, ffmpegBin };
