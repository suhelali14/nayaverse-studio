import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { env } from "../config/env.js";
import type { FootageRecord } from "./store.js";

/**
 * Taking footage off the wire and putting it on disk.
 *
 * Three rules, all of them load-bearing:
 *
 *   1. **The cap is enforced by the parser, not by us.** 200 MB is passed
 *      to `@fastify/multipart` as a stream limit, so a 4 GB upload is cut
 *      off at 200 MB rather than being written to disk and measured
 *      afterwards. Checking a size after the fact is not a cap, it is a
 *      report on how much disk somebody just used.
 *   2. **Only video and image.** An allowlist by prefix, because the thing
 *      to stop is a .html or .svg being served back from our origin later
 *      and running as script against a logged-in session.
 *   3. **The client's filename is never used for anything.** Not for the
 *      stored name, not for the extension, not even recorded. `../../` in
 *      a filename is the oldest file-upload bug there is, and the only
 *      reliable defence is to not have the string in your hand at all. We
 *      generate a UUID and take the extension from the mimetype we already
 *      had to check.
 */

/** Matches the limit handed to `@fastify/multipart` in `app.ts`. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Extension by mimetype. Cosmetic only -- nothing reads it to decide what
 * a file is -- so an unrecognised video subtype becoming `.bin` is fine.
 */
const EXTENSION: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
  "video/x-msvideo": "avi",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const isAllowed = (mimetype: string): boolean =>
  mimetype.startsWith("video/") || mimetype.startsWith("image/");

export type SaveResult =
  | { ok: true; footage: FootageRecord }
  | { ok: false; status: number; error: string; field?: string };

export const footagePath = (storedName: string): string => join(env.UPLOAD_DIR, storedName);

/**
 * `seconds` as the browser reported it, or null.
 *
 * Read from a multipart field rather than measured, because measuring it
 * needs a demuxer and this API deliberately has no ffmpeg dependency --
 * see `Provider.probe` in `worker.ts` for where a real measurement goes.
 *
 * **This value is client-controlled and dubbing is billed by the second.**
 * A client that reports 0 dubs for free. It is accepted because the
 * alternative today is every project having a duration of zero, which
 * breaks the usage screen for everyone to stop a hole nobody can reach
 * without a token; it is clamped, and it is recorded as
 * `secondsSource: "client"` so that the day a probe exists, every row
 * billed on a self-reported duration can be found.
 */
const parseSeconds = (raw: unknown): number | null => {
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "value" in raw && typeof raw.value === "string"
        ? raw.value
        : null;
  if (text === null) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  // Four hours. Past that it is not a reel, it is a mistake or a lie.
  return Math.min(Math.round(value), 4 * 60 * 60);
};

export async function saveFootage(
  file: MultipartFile,
): Promise<SaveResult & { seconds: number | null }> {
  if (file.fieldname !== "file") {
    // Drained first: an unread multipart stream leaves the connection
    // hanging until the client gives up, so every rejection below
    // consumes the body before replying.
    file.file.resume();
    return {
      ok: false,
      status: 400,
      error: "Send the upload in a field named `file`.",
      field: "file",
      seconds: null,
    };
  }

  if (!isAllowed(file.mimetype)) {
    file.file.resume();
    return {
      ok: false,
      status: 415,
      error:
        "That file is a " +
        file.mimetype +
        ". Upload a video or an image -- nothing else can be cut into a reel.",
      field: "file",
      seconds: null,
    };
  }

  const extension = EXTENSION[file.mimetype] ?? "bin";
  const storedName = randomUUID() + "." + extension;
  const destination = footagePath(storedName);

  await mkdir(env.UPLOAD_DIR, { recursive: true });

  let bytes = 0;
  file.file.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });

  try {
    await pipeline(file.file, createWriteStream(destination));
  } catch (cause) {
    await unlink(destination).catch(() => undefined);
    throw cause;
  }

  // `truncated` is the parser telling us it stopped at the limit. The
  // partial file is removed rather than kept: half a video is not footage,
  // and leaving it would let a loop of cut-off uploads fill the disk.
  if (file.file.truncated) {
    await unlink(destination).catch(() => undefined);
    return {
      ok: false,
      status: 413,
      error:
        "That file is over the " +
        Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)) +
        " MB limit. Trim it or export it smaller and upload again.",
      field: "file",
      seconds: null,
    };
  }

  return {
    ok: true,
    footage: {
      storedName,
      bytes,
      mimetype: file.mimetype,
      uploadedAt: new Date().toISOString(),
    },
    seconds: parseSeconds((file.fields as Record<string, unknown>)["seconds"]),
  };
}

/** Best-effort. A project row that outlived its file is a nuisance; a
 *  failed delete that breaks the request is worse. */
export const removeFootage = async (storedName: string): Promise<void> => {
  await unlink(footagePath(storedName)).catch(() => undefined);
};
