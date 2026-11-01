/**
 * One still out of a live HLS camera, for the plate reader.
 *
 * DelDOT's cameras publish only HLS video (`feedType: 'hls'`, no still URL),
 * so `readSnapshot` used to answer `frame-unavailable` for them. This module
 * asks the shared puller ([./stream.js](./stream.js)) for the segments already
 * buffered for a camera and puts the newest one through a single ffmpeg
 * invocation which demuxes the MPEG-TS, decodes one H.264 keyframe and encodes
 * it as JPEG on a pipe — verified end to end against a real NCAM205 segment
 * (800x450, ~30 KB). No subprocess per camera keeps its state: the puller's
 * own lease bookkeeping owns the session, and this reader releases its lease
 * as soon as a frame is in (or is not).
 *
 * Deliberate constraints, carried over from the frame route:
 *   - The stream URL is never an input: the reader is only ever pointed at a
 *     registered camera's own catalogue URL.
 *   - Everything is bounded: two segments of the puller's bounded buffers,
 *     one bounded ffmpeg run per attempt, no disk output.
 *   - An absent runtime (ffmpeg-static is an optional dependency) answers
 *     null — the caller keeps its `frame-unavailable` contract, and this is
 *     logged once rather than per read.
 * @module server/providers/cctv/hlsFrame
 */
import { spawn } from 'node:child_process';

/**
 * One normalised URL the media route itself would relay for this feed type:
 * an http(s) address whose path points at a media playlist.
 * @param {string} value
 * @returns {boolean}
 */
export function isHlsMediaUrl(value) {
  return (
    /^https?:\/\//i.test(String(value || '')) &&
    /\.m3u8(?:\?|$)/i.test(String(value || ''))
  );
}

/**
 * Decode one H.264 keyframe out of an MPEG-TS buffer into JPEG bytes.
 *
 * `-skip_frame nokey` makes ffmpeg skip everything until the first keyframe,
 * so a segment that starts mid-GOP (Wowza's DelDOT streams do) still decodes
 * a reference frame rather than artefact soup; a segment without any
 * keyframe yields nothing, and the caller falls back to the previous one.
 * `-frames:v 1` bounds the work at that first keyframe; a segment of a
 * camera's own size (~300 KB) decodes in well under a second.
 *
 * Every failure path answers `null`: the read is best-effort by contract.
 *
 * @param {string} ffmpegPath Absolute path to the ffmpeg binary.
 * @param {Buffer} tsBytes One bounded MPEG-TS segment.
 * @param {{spawnProcess?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<Buffer|null>} The JPEG frame, or `null`.
 */
export async function decodeMpegTsFrame(
  ffmpegPath,
  tsBytes,
  { spawnProcess = spawn, timeoutMs = 12_000 } = {},
) {
  if (!ffmpegPath || !Buffer.isBuffer(tsBytes) || !tsBytes.length) return null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnProcess(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'mpegts',
          '-i',
          'pipe:0',
          '-skip_frame',
          'nokey',
          '-an',
          '-sn',
          '-frames:v',
          '1',
          '-c:v',
          'mjpeg',
          '-f',
          'image2pipe',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    // Not unref'd on purpose: while a decode is the only pending work the
    // deadline is what must still fire to release the read.
    const chunks = [];
    child.stdout.on('data', (chunk) => {
      if (!settled) chunks.push(chunk);
    });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const frame = Buffer.concat(chunks);
      finish(frame.length ? frame : null);
    });
    child.stdin.on('error', () => finish(null));
    child.stdin.end(tsBytes);
  });
}

/** Resolve the runtime's ffmpeg binary, or `null` when it is not installed. */
async function resolveDefaultFfmpeg() {
  try {
    const module = await import('ffmpeg-static');
    const path = module?.default ?? module;
    return typeof path === 'string' && path ? path : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {{ensure: Function, waitReady: Function, getRecentSegments: Function,
 *   release: Function}} [options.puller] The shared HLS puller.
 * @param {Function} [options.resolveFfmpeg] Where the binary is; replaced by
 *   the tests to exercise a missing runtime without an install.
 * @param {Function} [options.spawnProcess] The child_process simmer; the
 *   tests stand a per-call fake in so no real run is measured.
 * @param {number} [options.decodeTimeoutMs] One attempt's ffmpeg deadline.
 * @param {number} [options.segmentLimit] How many buffered segments may be
 *   tried, newest first, before the camera answers without a frame.
 * @param {string} [options.leaseId] The puller lease owned by frame reads;
 *   distinct from a viewer's own lease so one read never evicts a viewer's
 *   session, and released as soon as the read scored (or scored nothing).
 */
export function createHlsFrameReader({
  puller,
  resolveFfmpeg = resolveDefaultFfmpeg,
  spawnProcess = spawn,
  decodeTimeoutMs = 12_000,
  segmentLimit = 2,
  leaseId = 'alpr',
} = {}) {
  let ffmpegPath = null;
  let warnedNoRuntime = false;

  const warnOnce = () => {
    if (warnedNoRuntime) return;
    warnedNoRuntime = true;
    console.warn(
      '[CCTV] HLS frame reads need ffmpeg-static (an optional dependency);' +
        ' video cameras answer frame-unavailable until it is installed',
    );
  };

  return {
    /**
     * Read one frame of a registered camera's live HLS stream.
     *
     * The puller may already be serving this camera to a panel viewer, in
     * which case `ensure` touches the session and returns at once; on a cold
     * camera it waits until at least two segments are in the buffers, which
     * the puller caps at `readyMs`. The camera answers unserved (`null`) when
     * everything on the way — session, segments, decode — fails, and the
     * caller's existing `frame-unavailable` error carries that to the panel.
     *
     * @param {{cameraId: string, url: string}} camera A registered source.
     * @returns {Promise<Buffer|null>} JPEG frame bytes, or `null`.
     */
    async read({ cameraId, url }) {
      if (typeof cameraId !== 'string' || !cameraId) return null;
      if (!isHlsMediaUrl(url)) return null;
      if (!puller) return null;
      if (ffmpegPath === null) ffmpegPath = await resolveFfmpeg();
      if (!ffmpegPath) {
        warnOnce();
        return null;
      }
      try {
        const entry = await puller.ensure(cameraId, url, leaseId);
        if (!entry || typeof entry?.token !== 'string' || !entry.token)
          return null;
        if (!(await puller.waitReady(entry))) return null;
        for (const segment of puller.getRecentSegments(
          cameraId,
          entry.token,
          leaseId,
          segmentLimit,
        )) {
          const frame = await decodeMpegTsFrame(ffmpegPath, segment, {
            spawnProcess,
            timeoutMs: decodeTimeoutMs,
          });
          if (frame) return frame;
        }
        return null;
      } catch {
        return null;
      } finally {
        try {
          puller.release(cameraId, leaseId);
        } catch {
          /* the lease may already be gone with a session nobody kept alive */
        }
      }
    },
  };
}
