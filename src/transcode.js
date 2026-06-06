// In-process video transcoder. Shrinks oversized source videos so the
// final MP4 fits under WhatsApp's ~16 MB inline-video cap.
//
// Why a temp file instead of stdout: +faststart needs to seek the
// output to rewrite the moov atom at the front. ffmpeg can't seek a
// pipe. Disk I/O on a ~15 MB file is negligible compared to the
// encode itself.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeFetch } from './safe-url.js';

const TARGET_OUTPUT_BYTES = 15 * 1024 * 1024;
const TARGET_OUTPUT_BITS = TARGET_OUTPUT_BYTES * 8;
const AUDIO_BITRATE_KBPS = 96;
const VIDEO_BITRATE_MIN_KBPS = 250;
const VIDEO_BITRATE_MAX_KBPS = 2500;
const MAX_HEIGHT = 720;
const DEFAULT_DEADLINE_MS = 120_000;

export class TranscodeTimeout extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'TranscodeTimeout';
  }
}

export class TranscodeError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'TranscodeError';
  }
}

async function probeDurationSec(url, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', url],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => reject(new TranscodeError(`ffprobe spawn: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        return reject(new TranscodeError(`ffprobe exit ${code}: ${stderr.trim().slice(0, 200)}`));
      }
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return reject(new TranscodeError(`ffprobe duration parse: ${stdout.trim()}`));
      }
      resolve(seconds);
    });
  });
}

function computeVideoBitrateKbps(durationSec) {
  const audioBits = AUDIO_BITRATE_KBPS * 1000 * durationSec;
  const videoBits = TARGET_OUTPUT_BITS - audioBits;
  if (videoBits <= 0) {
    return VIDEO_BITRATE_MIN_KBPS;
  }
  const kbps = Math.floor(videoBits / 1000 / durationSec);
  return Math.max(VIDEO_BITRATE_MIN_KBPS, Math.min(VIDEO_BITRATE_MAX_KBPS, kbps));
}

function runFfmpeg(sourceUrl, outputPath, videoKbps, signal) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', sourceUrl,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-profile:v', 'high',
      '-level', '4.0',
      '-b:v', `${videoKbps}k`,
      '-maxrate', `${videoKbps}k`,
      '-bufsize', `${videoKbps * 2}k`,
      '-vf', `scale='min(${MAX_HEIGHT},ih)*iw/ih':'min(${MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-c:a', 'aac',
      '-b:a', `${AUDIO_BITRATE_KBPS}k`,
      '-ac', '2',
      '-movflags', '+faststart',
      '-fs', `${TARGET_OUTPUT_BYTES}`,
      '-f', 'mp4',
      outputPath,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));

    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => reject(new TranscodeError(`ffmpeg spawn: ${err.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        return reject(new TranscodeError(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`));
      }
      resolve();
    });
  });
}

export async function transcodeVideo(
  sourceUrl,
  { logger, deadlineMs = DEFAULT_DEADLINE_MS, signal: externalSignal } = {},
) {
  const ctrl = new AbortController();
  const deadlineTimer = setTimeout(
    () => ctrl.abort(new TranscodeTimeout(`transcode exceeded ${deadlineMs}ms`)),
    deadlineMs,
  );
  const onExternalAbort = () => {
    const reason = externalSignal?.reason;
    ctrl.abort(reason instanceof Error ? reason : new TranscodeError('externally aborted'));
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const workDir = await mkdtemp(path.join(tmpdir(), 'wp-transcode-'));
  const outPath = path.join(workDir, 'out.mp4');
  const startedAt = Date.now();

  try {
    // Download through the SSRF-safe fetch (manual-redirect, re-validated) to
    // a local file, then hand ffmpeg/ffprobe the FILE — never the remote URL,
    // which they would otherwise re-fetch and follow redirects on themselves.
    const sourcePath = path.join(workDir, 'source');
    const response = await safeFetch(sourceUrl, { signal: ctrl.signal });
    if (!response.ok || !response.body) {
      throw new TranscodeError(`source fetch returned ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(sourcePath));

    const duration = await probeDurationSec(sourcePath, ctrl.signal);
    const videoKbps = computeVideoBitrateKbps(duration);
    logger?.info({ duration, videoKbps }, 'transcode planned');

    await runFfmpeg(sourcePath, outPath, videoKbps, ctrl.signal);

    const buf = await readFile(outPath);
    if (buf.length > 16 * 1024 * 1024) {
      throw new TranscodeError(
        `output is ${(buf.length / 1024 / 1024).toFixed(1)} MB, still > 16 MB`,
      );
    }
    logger?.info(
      { sizeMb: (buf.length / 1024 / 1024).toFixed(1), ms: Date.now() - startedAt },
      'transcode done',
    );
    return buf;
  } catch (err) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof TranscodeTimeout) {
      throw ctrl.signal.reason;
    }
    if (err instanceof TranscodeTimeout || err instanceof TranscodeError) {
      throw err;
    }
    throw new TranscodeError(String(err?.message ?? err));
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
