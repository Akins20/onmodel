/**
 * `onmodel motion --spec crow.motion.json`: one timeline written for every place it plays.
 *
 * The spec's timeline is drawn here frame by frame and written as an Android animated vector
 * drawable, Lottie JSON and an animated SVG, and as a GIF, an APNG, an MP4 (when ffmpeg is installed)
 * and a poster frame. Then it is checked the way everything else onmodel makes is checked, from what
 * landed on disk: the vector files are read back the way each player reads them and drawn again
 * against the timeline's own frames, the last frame is held to the artwork at rest, and the video
 * is probed for its frame count and size. Nothing is painted, so a run costs nothing.
 */

import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadMotion, pose, restPose, drawPose, unsettled, frameTimes, frameDiff, walk } from "./motion.mjs";
import { androidAVD, lottieJSON, animatedSVG } from "./motionout.mjs";
import { readAVD, readLottie, readSVG } from "./motionread.mjs";
import { encodePNG } from "./png.mjs";
import { encodeAPNG, encodeGIF } from "./anim.mjs";
import { slug } from "./generate.mjs";
import { renderMotionHTML } from "./html.mjs";

export const FORMATS = ["android", "lottie", "svg", "gif", "apng", "mp4", "poster"];
/** The GIF rates whose frame delay is a whole number of hundredths of a second, which is all a GIF can hold. */
export const GIF_RATES = [10, 20, 25, 50];
const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 16);

/** ffmpeg and ffprobe, from ONMODEL_FFMPEG or the PATH; null when there is none. */
export function findFfmpeg(env = process.env) {
  const candidates = env.ONMODEL_FFMPEG ? [env.ONMODEL_FFMPEG] : ["ffmpeg"];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (r.status === 0) {
      const probe = bin.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace("ffmpeg", "ffprobe"));
      return { ffmpeg: bin, ffprobe: probe, version: /ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? "unknown" };
    }
  }
  return null;
}

/**
 * Draws a scene read back from a file and the timeline at the same moments and reports the worst
 * difference: the largest channel gap and the share of pixels more than 8 levels apart.
 */
export function compareScenes(scene, other, { scale, times }) {
  let max = 0;
  let share = 0;
  let worstAt = 0;
  for (const t of times) {
    const a = drawPose(pose(scene, t), scene, scale, { background: null });
    // A format that shows nothing at this moment (a Lottie layer past its out point) draws empty.
    const b = drawPose(other.hiddenAt?.(t) ? [] : pose(other, t), { ...other, width: scene.width, height: scene.height }, scale, { background: null });
    const d = frameDiff(a, b);
    if (d.max > max || d.share > share) worstAt = t;
    max = Math.max(max, d.max);
    share = Math.max(share, d.share);
  }
  return { max, share: +share.toFixed(6), worstAt: Math.round(worstAt) };
}

/** A read-back is faithful when no pixel moved more than a rounding step's worth anywhere. */
export const faithful = (d) => d.share <= 0.0005 && d.max <= 48;

/** Up to about 40 of the timeline's frames, spread evenly, always ending on the last. */
export function checkTimes(scene) {
  const all = frameTimes(scene.duration, scene.fps);
  const every = Math.max(1, Math.ceil(all.length / 40));
  const picked = all.filter((_, k) => k % every === 0);
  if (picked[picked.length - 1] !== scene.duration) picked.push(scene.duration);
  return picked;
}

export async function makeMotion({ config, specPath, name = null, size = null, formats = null, hold = 0, gifFps = 50, keepFrames = false, env = process.env, log = (s) => process.stderr.write(s) }) {
  if (!specPath) throw new Error("motion needs --spec <file.json>: the shapes and the timeline");
  const scene = await loadMotion(specPath);
  const wanted = formats ?? FORMATS;
  for (const f of wanted) if (!FORMATS.includes(f)) throw new Error(`--formats takes ${FORMATS.join(", ")}; got ${f}`);
  if (!(hold >= 0 && hold <= 10000)) throw new Error("--hold runs from 0 to 10000 milliseconds");
  if (!GIF_RATES.includes(gifFps)) throw new Error(`--gif-fps takes ${GIF_RATES.join(", ")}: a GIF's frame delay is a whole number of hundredths of a second; got ${gifFps}`);
  const label = slug(name ?? scene.name);
  const dir = path.join(config.out, label, "motion");
  await mkdir(dir, { recursive: true });
  const longest = Math.max(scene.width, scene.height);
  const pixels = size ?? Math.min(1080, Math.max(256, Math.round(longest)));
  if (!(pixels >= 16 && pixels <= 4096)) throw new Error("--size runs from 16 to 4096 pixels");
  const scale = pixels / longest;
  const checkScale = Math.min(1, 256 / longest);
  const files = {};
  const facts = {
    width: scene.width,
    height: scene.height,
    duration: scene.duration,
    fps: scene.fps,
    background: scene.background ? `#${scene.background.map((v) => v.toString(16).padStart(2, "0")).join("")}` : null,
    layers: 0,
    paths: 0,
    animations: 0,
    pixels,
  };
  walk(scene.roots, (n) => {
    facts.layers++;
    facts.paths += n.paths.length;
  });
  for (const tr of scene.tracks.values()) facts.animations += tr.segments.length;
  const failures = [];

  // It ends on the artwork: every property back at rest when the timeline stops, and the last
  // frame drawn the same as the artwork drawn still.
  if (scene.endsOn === "artwork") {
    const off = unsettled(scene);
    const end = drawPose(pose(scene, scene.duration), scene, checkScale, { background: null });
    const still = drawPose(restPose(scene), scene, checkScale, { background: null });
    const d = frameDiff(end, still, 0);
    facts.settles = { ok: !off.length && d.max === 0, off, max: d.max };
    if (!facts.settles.ok) failures.push(`it does not end on the artwork: ${off.join("; ") || `the last frame differs by up to ${d.max} levels`}`);
  } else facts.settles = { ok: true, skipped: true };

  const times = checkTimes(scene);
  const readback = {};

  if (wanted.includes("android")) {
    const { xml, problems } = androidAVD(scene);
    facts.android = { splash: Boolean(scene.android.splash), problems };
    if (problems.length) failures.push(...problems.map((p) => `Android: ${p}`));
    else {
      files.android = path.join(dir, `${label}.xml`);
      await writeFile(files.android, xml);
      readback.android = compareScenes(scene, readAVD(await readFile(files.android, "utf8")), { scale: checkScale, times });
      facts.android.bytes = Buffer.byteLength(xml);
    }
  }
  if (wanted.includes("lottie")) {
    files.lottie = path.join(dir, `${label}.lottie.json`);
    const json = JSON.stringify(lottieJSON(scene));
    await writeFile(files.lottie, json);
    readback.lottie = compareScenes(scene, readLottie(await readFile(files.lottie, "utf8")), { scale: checkScale, times });
    facts.lottieBytes = Buffer.byteLength(json);
  }
  if (wanted.includes("svg")) {
    files.svg = path.join(dir, `${label}.svg`);
    const svg = animatedSVG(scene);
    await writeFile(files.svg, svg);
    readback.svg = compareScenes(scene, readSVG(await readFile(files.svg, "utf8")), { scale: checkScale, times });
    facts.svgBytes = Buffer.byteLength(svg);
  }
  for (const [format, d] of Object.entries(readback)) {
    if (!faithful(d)) failures.push(`${format}: read back the way its player reads it, it differs from the timeline by up to ${d.max} levels over ${(d.share * 100).toFixed(2)}% of the frame at ${d.worstAt} ms`);
  }
  facts.readback = readback;

  // The raster outputs: GIF and APNG at a rate GIF's hundredths of a second keep exactly (50 a
  // second unless a long clip asks for fewer), and the video at the spec's own rate.
  const needRaster = wanted.some((f) => ["gif", "apng", "mp4", "poster"].includes(f));
  if (needRaster) {
    const posterImage = drawPose(pose(scene, scene.duration), scene, scale);
    if (wanted.includes("poster")) {
      files.poster = path.join(dir, `${label}.poster.png`);
      await writeFile(files.poster, encodePNG(posterImage));
    }
    if (wanted.includes("gif") || wanted.includes("apng")) {
      const animTimes = frameTimes(scene.duration, gifFps, hold);
      const images = animTimes.map((t) => drawPose(pose(scene, t), scene, scale));
      const frames = images.map((image) => ({ image, delayMs: 1000 / gifFps }));
      if (wanted.includes("gif")) {
        files.gif = path.join(dir, `${label}.gif`);
        // Previews loop: a GIF is watched again and again, and one that stops reads as broken.
        const gif = encodeGIF(frames, { loops: 0 });
        await writeFile(files.gif, gif);
        facts.gif = { frames: frames.length, fps: gifFps, bytes: gif.length, digest: digest(gif) };
      }
      if (wanted.includes("apng")) {
        files.apng = path.join(dir, `${label}.apng.png`);
        const apng = encodeAPNG(frames, { loops: 0 });
        await writeFile(files.apng, apng);
        facts.apng = { frames: frames.length, fps: gifFps, bytes: apng.length, digest: digest(apng) };
      }
    }
    if (wanted.includes("mp4")) {
      const tools = findFfmpeg(env);
      if (!tools) {
        facts.mp4 = { skipped: "ffmpeg was not found; install it, or set ONMODEL_FFMPEG to its path, and run again for the video" };
      } else {
        const framesDir = path.join(dir, "frames");
        await rm(framesDir, { recursive: true, force: true });
        await mkdir(framesDir, { recursive: true });
        const videoTimes = frameTimes(scene.duration, scene.fps, hold);
        const bg = scene.background ?? [0, 0, 0];
        for (let k = 0; k < videoTimes.length; k++) {
          const image = drawPose(pose(scene, videoTimes[k]), scene, scale, { background: bg });
          await writeFile(path.join(framesDir, `f${String(k).padStart(5, "0")}.png`), encodePNG(image));
        }
        files.mp4 = path.join(dir, `${label}.mp4`);
        const hexBg = `0x${bg.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        const r = spawnSync(
          tools.ffmpeg,
          ["-y", "-loglevel", "error", "-framerate", String(scene.fps), "-i", path.join(framesDir, "f%05d.png"), "-vf", `pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=${hexBg}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium", "-movflags", "+faststart", files.mp4],
          { encoding: "utf8" },
        );
        if (r.status !== 0) {
          failures.push(`the video did not encode: ${(r.stderr || "").trim().split("\n").pop()}`);
          delete files.mp4;
        } else {
          const probe = spawnSync(tools.ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,width,height,r_frame_rate", "-of", "json", files.mp4], { encoding: "utf8" });
          const stream = probe.status === 0 ? JSON.parse(probe.stdout).streams?.[0] : null;
          const mp4 = await readFile(files.mp4);
          facts.mp4 = { frames: stream ? Number(stream.nb_read_frames) : null, expected: videoTimes.length, width: stream?.width ?? null, height: stream?.height ?? null, rate: stream?.r_frame_rate ?? null, bytes: mp4.length, digest: digest(mp4), ffmpeg: tools.version };
          if (stream && Number(stream.nb_read_frames) !== videoTimes.length) failures.push(`the video holds ${stream.nb_read_frames} frames, not the ${videoTimes.length} drawn`);
        }
        if (!keepFrames) await rm(framesDir, { recursive: true, force: true });
        else files.frames = framesDir;
      }
    }
  }

  facts.verdict = failures.length ? "problems" : "good";
  facts.failures = failures;
  for (const key of ["android", "lottie", "svg"]) if (files[key]) facts[`${key}Digest`] = digest(await readFile(files[key]));
  const summary = { tool: "onmodel", kind: "motion", name: label, dir, spec: path.resolve(specPath), generatedAt: new Date().toISOString(), files, facts };
  await writeFile(path.join(dir, "motion.json"), JSON.stringify(summary, null, 2));
  const lottieData = files.lottie && facts.lottieBytes < 2_000_000 ? JSON.parse(await readFile(files.lottie, "utf8")) : null;
  await writeFile(path.join(dir, "motion.html"), renderMotionHTML(summary, dir, lottieData));
  log(`  ${label}: ${Math.round(scene.duration)} ms at ${scene.fps} fps, ${facts.paths} paths in ${facts.layers} layers, ${facts.animations} animations, ${facts.verdict}\n`);
  return summary;
}
