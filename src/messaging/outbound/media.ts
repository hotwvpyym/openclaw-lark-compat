/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Media handling for the Lark/Feishu channel plugin.
 *
 * Provides functions for downloading images and file resources from
 * Feishu messages, uploading media to the Feishu IM storage, and
 * sending image / file messages to chats.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { LarkClient } from '../../core/lark-client';
import { normalizeFeishuTarget, resolveReceiveIdType } from '../../core/targets';
import { larkLogger } from '../../core/lark-logger';
import {
  isLocalMediaPath,
  normalizeMediaUrlInput,
  resolveFileNameFromMediaUrl,
  safeFileUrlToPath,
  validateLocalMediaRoots,
} from './media-url-utils';

const log = larkLogger('outbound/media');

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

/** HTTP status codes that are safe to retry (transient server errors). */
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

/** Maximum number of retry attempts for transient failures. */
const MEDIA_RETRY_MAX = 2;

/** Base delay (ms) between retries — actual delay = base * attempt. */
const MEDIA_RETRY_DELAY_MS = 1000;

/**
 * Run an async operation with bounded retries for transient HTTP errors.
 *
 * Only retries when the error carries a recognised retryable HTTP status
 * code. All other errors are thrown immediately.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MEDIA_RETRY_MAX,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = extractHttpStatus(err);
      if (status == null || !RETRYABLE_STATUS_CODES.has(status) || attempt >= maxRetries) {
        throw err;
      }
      const delay = MEDIA_RETRY_DELAY_MS * (attempt + 1);
      log.warn(
        `${label}: HTTP ${status}, retrying (${attempt + 1}/${maxRetries}) after ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Best-effort extraction of an HTTP status code from an unknown error.
 * Returns `undefined` when the error does not carry status information.
 */
function extractHttpStatus(err: unknown): number | undefined {
  if (err != null && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    // Some SDK wrappers embed status in the message string.
    if (typeof obj.message === 'string') {
      const m = obj.message.match(/\b(50[2-4])\b/);
      if (m) return Number(m[1]);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of downloading an image from Feishu.
 */
export interface DownloadImageResult {
  /** The raw image bytes. */
  buffer: Buffer;
  /** The MIME type of the image (e.g. "image/png"), if known. */
  contentType?: string;
}

/**
 * Result of downloading a message resource (image or file) from Feishu.
 */
export interface DownloadMessageResourceResult {
  /** The raw file bytes. */
  buffer: Buffer;
  /** The MIME type of the resource, if known. */
  contentType?: string;
  /** The original file name, if available. */
  fileName?: string;
}

/**
 * Result of uploading an image to Feishu.
 */
export interface UploadImageResult {
  /** The image_key assigned by Feishu, used to reference the image. */
  imageKey: string;
}

/**
 * Result of uploading a file to Feishu.
 */
export interface UploadFileResult {
  /** The file_key assigned by Feishu, used to reference the file. */
  fileKey: string;
}

/**
 * Result of sending a media (image or file) message.
 */
export interface SendMediaResult {
  /** Platform-assigned message ID. */
  messageId: string;
  /** Chat ID where the media was sent. */
  chatId: string;
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a Buffer from various SDK response formats.
 *
 * The Feishu Node SDK can return binary data in several shapes depending
 * on the runtime environment and SDK version:
 *   - A Buffer directly
 *   - An ArrayBuffer
 *   - A response object with a `.data` property
 *   - A response object with `.getReadableStream()`
 *   - A response object with `.writeFile(path)`
 *   - An async iterable / iterator
 *   - A Node.js Readable stream
 *
 * This helper normalises all of those into a single Buffer.
 */
async function extractBufferFromResponse(response: unknown): Promise<{ buffer: Buffer; contentType?: string }> {
  // Direct Buffer
  if (Buffer.isBuffer(response)) {
    return { buffer: response };
  }

  // ArrayBuffer
  if (response instanceof ArrayBuffer) {
    return { buffer: Buffer.from(response) };
  }

  // Null / undefined guard
  if (response == null) {
    throw new Error('[feishu-media] Received null/undefined response');
  }

  const resp = response as Record<string, any>;
  const contentType: string | undefined = resp.headers?.['content-type'] ?? resp.contentType ?? undefined;

  // Response with .data as Buffer or ArrayBuffer
  if (resp.data != null) {
    if (Buffer.isBuffer(resp.data)) {
      return { buffer: resp.data, contentType };
    }
    if (resp.data instanceof ArrayBuffer) {
      return { buffer: Buffer.from(resp.data), contentType };
    }
    // .data might itself be a readable stream
    if (typeof resp.data.pipe === 'function') {
      const buf = await streamToBuffer(resp.data as Readable);
      return { buffer: buf, contentType };
    }
  }

  // Response with .getReadableStream()
  if (typeof resp.getReadableStream === 'function') {
    const stream = await resp.getReadableStream();
    const buf = await streamToBuffer(stream);
    return { buffer: buf, contentType };
  }

  // Response with .writeFile(path) -- write to a temp file and read back.
  if (typeof resp.writeFile === 'function') {
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `feishu-media-${Date.now()}`);
    try {
      await resp.writeFile(tmpFile);
      const buf = fs.readFileSync(tmpFile);
      return { buffer: buf, contentType };
    } finally {
      // Clean up the temp file.
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  // Async iterable / iterator (e.g. response body chunks)
  if (typeof (resp as any)[Symbol.asyncIterator] === 'function' || typeof (resp as any).next === 'function') {
    const chunks: Buffer[] = [];
    const iterable =
      typeof (resp as any)[Symbol.asyncIterator] === 'function'
        ? (resp as AsyncIterable<Uint8Array>)
        : asyncIteratorToIterable(resp as AsyncIterator<Uint8Array>);

    for await (const chunk of iterable) {
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), contentType };
  }

  // Node.js Readable stream
  if (typeof resp.pipe === 'function') {
    const buf = await streamToBuffer(resp as Readable);
    return { buffer: buf, contentType };
  }

  throw new Error('[feishu-media] Unable to extract binary data from response: unrecognised format');
}

/**
 * Consume a Readable stream into a Buffer.
 */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Wrap an AsyncIterator into an AsyncIterable.
 */
async function* asyncIteratorToIterable<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    yield value;
  }
}

// ---------------------------------------------------------------------------
// downloadMessageResourceFeishu
// ---------------------------------------------------------------------------

/**
 * Download a resource (image or file) attached to a specific message.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.messageId - The message the resource belongs to.
 * @param params.fileKey   - The file_key or image_key of the resource.
 * @param params.type      - Whether the resource is an "image" or "file".
 * @param params.accountId - Optional account identifier.
 * @returns The resource buffer, content type, and file name.
 */
export async function downloadMessageResourceFeishu(params: {
  cfg: OpenClawConfig;
  messageId: string;
  fileKey: string;
  type: 'image' | 'file';
  accountId?: string;
}): Promise<DownloadMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  const response = await withRetry(
    () =>
      client.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type,
        },
      }),
    `downloadMessageResource(${fileKey})`,
  );

  const { buffer, contentType } = await extractBufferFromResponse(response);

  // Attempt to extract file name from response headers.
  let fileName: string | undefined;
  if (response && typeof response === 'object') {
    const resp = response as Record<string, any>;
    const disposition = resp.headers?.['content-disposition'] ?? resp.headers?.['Content-Disposition'];
    if (typeof disposition === 'string') {
      const match = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      if (match) {
        fileName = decodeURIComponent(match[1].trim());
      }
    }
  }

  return { buffer, contentType, fileName };
}

// ---------------------------------------------------------------------------
// uploadImageLark
// ---------------------------------------------------------------------------

/**
 * Upload an image to Feishu IM storage.
 *
 * Accepts either a Buffer containing the raw image bytes or a file
 * system path to read from.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.image     - A Buffer or local file path for the image.
 * @param params.imageType - The image usage type: "message" (default) or "avatar".
 * @param params.accountId - Optional account identifier.
 * @returns The assigned image_key.
 */
export async function uploadImageLark(params: {
  cfg: OpenClawConfig;
  image: Buffer | string;
  imageType?: 'message' | 'avatar';
  accountId?: string;
}): Promise<UploadImageResult> {
  const { cfg, image, imageType = 'message', accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const imageStream = Buffer.isBuffer(image) ? Readable.from(image) : fs.createReadStream(image);

  const response = await client.im.image.create({
    data: { image_type: imageType, image: imageStream as any },
  });

  const imageKey = (response as any)?.data?.image_key ?? (response as any)?.image_key;
  if (!imageKey) {
    throw new Error(
      '[feishu-media] Image upload failed: no image_key in response. ' +
        `Check that the image is a valid format (JPEG/PNG/GIF/BMP/WEBP). ` +
        `Response: ${JSON.stringify(response).slice(0, 200)}`,
    );
  }

  return { imageKey };
}

// ---------------------------------------------------------------------------
// uploadFileLark
// ---------------------------------------------------------------------------

/**
 * Upload a file to Feishu IM storage.
 *
 * @param params.cfg       - Plugin configuration.
 * @param params.file      - A Buffer or local file path.
 * @param params.fileName  - The display name of the file.
 * @param params.fileType  - Feishu file type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream".
 * @param params.duration  - Duration in milliseconds (for audio/video files).
 * @param params.accountId - Optional account identifier.
 * @returns The assigned file_key.
 */
export async function uploadFileLark(params: {
  cfg: OpenClawConfig;
  file: Buffer | string;
  fileName: string;
  fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
  duration?: number;
  accountId?: string;
}): Promise<UploadFileResult> {
  const { cfg, file, fileName, fileType, duration, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const fileStream = Buffer.isBuffer(file) ? Readable.from(file) : fs.createReadStream(file);

  const response = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file: fileStream,
      ...(duration !== undefined ? { duration: String(duration) } : {}),
    } as any,
  });

  const fileKey = (response as any)?.data?.file_key ?? (response as any)?.file_key;
  if (!fileKey) {
    throw new Error(
      `[feishu-media] File upload failed: no file_key in response for "${fileName}" (type=${fileType}). ` +
        `Response: ${JSON.stringify(response).slice(0, 200)}`,
    );
  }

  return { fileKey };
}

// ---------------------------------------------------------------------------
// Shared media message sender
// ---------------------------------------------------------------------------

/**
 * Unified media message sender — handles both reply and create paths for
 * image / file / audio `msg_type` values.
 *
 * Mirrors {@link sendImMessage} in `deliver.ts` (which covers "post" and
 * "interactive"), extracted here to avoid a cross-module dependency.
 */
async function sendMediaMessage(params: {
  client: ReturnType<typeof LarkClient.fromCfg>['sdk'];
  to: string;
  content: string;
  msgType: 'image' | 'file' | 'audio' | 'media';
  replyToMessageId?: string;
  replyInThread?: boolean;
}): Promise<SendMediaResult> {
  const { client, to, content, msgType, replyToMessageId, replyInThread } = params;

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: { content, msg_type: msgType, reply_in_thread: replyInThread },
    });
    return {
      messageId: response?.data?.message_id ?? '',
      chatId: response?.data?.chat_id ?? '',
    };
  }

  const target = normalizeFeishuTarget(to);
  if (!target) {
    throw new Error(
      `[feishu-media] Cannot send ${msgType} message: "${to}" is not a valid target. ` +
        `Expected a chat_id (oc_*), open_id (ou_*), or user_id.`,
    );
  }

  const receiveIdType = resolveReceiveIdType(target);
  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType as any },
    data: { receive_id: target, msg_type: msgType, content },
  });

  return {
    messageId: response?.data?.message_id ?? '',
    chatId: response?.data?.chat_id ?? '',
  };
}

// ---------------------------------------------------------------------------
// sendImageLark
// ---------------------------------------------------------------------------

/**
 * Send an image message to a chat or user.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.imageKey         - The image_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendImageLark(params: {
  cfg: OpenClawConfig;
  to: string;
  imageKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendImageLark: target=${to}, imageKey=${imageKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ image_key: imageKey });
  return sendMediaMessage({ client, to, content, msgType: 'image', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// sendFileLark
// ---------------------------------------------------------------------------

/**
 * Send a file message to a chat or user.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.fileKey          - The file_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendFileLark(params: {
  cfg: OpenClawConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendFileLark: target=${to}, fileKey=${fileKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ file_key: fileKey });
  return sendMediaMessage({ client, to, content, msgType: 'file', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// sendVideoLark
// ---------------------------------------------------------------------------

/**
 * Send a video message to a chat or user.
 *
 * Uses `msg_type: "media"` so Feishu renders the message as a playable
 * video instead of a file attachment.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.fileKey          - The file_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendVideoLark(params: {
  cfg: OpenClawConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendVideoLark: target=${to}, fileKey=${fileKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ file_key: fileKey });
  return sendMediaMessage({ client, to, content, msgType: 'media', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// sendAudioLark
// ---------------------------------------------------------------------------

/**
 * Send an audio message to a chat or user.
 *
 * Uses `msg_type: "audio"` so Feishu renders the message as a playable
 * voice bubble instead of a file attachment.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.fileKey          - The file_key from a previous upload.
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.replyInThread    - When true, reply appears in thread.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function sendAudioLark(params: {
  cfg: OpenClawConfig;
  to: string;
  fileKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  log.info(`sendAudioLark: target=${to}, fileKey=${fileKey}`);

  const client = LarkClient.fromCfg(cfg, accountId).sdk;
  const content = JSON.stringify({ file_key: fileKey });
  return sendMediaMessage({ client, to, content, msgType: 'audio', replyToMessageId, replyInThread });
}

// ---------------------------------------------------------------------------
// detectFileType
// ---------------------------------------------------------------------------

/** Known image extensions. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif', '.heic']);

/** Extension-to-Feishu-file-type mapping. */
const EXTENSION_TYPE_MAP: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
  '.opus': 'opus',
  '.ogg': 'opus',
  '.mp4': 'mp4',
  '.mov': 'mp4',
  '.avi': 'mp4',
  '.mkv': 'mp4',
  '.webm': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.csv': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

/**
 * Detect the Feishu file type from a file name extension.
 *
 * Returns one of the Feishu-supported file type strings, or "stream"
 * as a catch-all for unrecognised extensions.
 *
 * @param fileName - The file name (with extension).
 * @returns The detected file type.
 */
export function detectFileType(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(fileName).toLowerCase();
  return EXTENSION_TYPE_MAP[ext] ?? 'stream';
}

/**
 * Parse the duration (in milliseconds) from an OGG/Opus audio buffer.
 *
 * Scans backward from the end of the buffer to find the last OggS page
 * header, reads the granule position (absolute sample count), and divides
 * by 48 000 (the Opus standard sample rate) then converts to milliseconds.
 *
 * Returns `undefined` when the buffer cannot be parsed (e.g. truncated or
 * not actually OGG).  This is intentionally lenient so callers can fall
 * back gracefully.
 */
export function parseOggOpusDuration(buffer: Buffer): number | undefined {
  // OggS magic bytes: 0x4f 0x67 0x67 0x53
  const OGGS = Buffer.from('OggS');

  // Scan backwards for the last OggS sync word.
  let offset = -1;
  for (let i = buffer.length - OGGS.length; i >= 0; i--) {
    if (buffer[i] === 0x4f && buffer.compare(OGGS, 0, 4, i, i + 4) === 0) {
      offset = i;
      break;
    }
  }

  if (offset < 0) return undefined;

  // Granule position is at bytes 6..13 of the page header (8 bytes, little-endian).
  const granuleOffset = offset + 6;
  if (granuleOffset + 8 > buffer.length) return undefined;

  // Read as two 32-bit LE values and combine (avoids BigInt for portability).
  const lo = buffer.readUInt32LE(granuleOffset);
  const hi = buffer.readUInt32LE(granuleOffset + 4);
  const granule = hi * 0x1_0000_0000 + lo;

  if (granule <= 0) return undefined;

  return Math.ceil(granule / 48_000) * 1000;
}

/**
 * Parse the duration (in milliseconds) from an MP4 video buffer.
 *
 * Scans top-level boxes to locate the `moov` container, then finds the
 * `mvhd` (Movie Header) box inside it.  The `mvhd` box stores:
 *   - **timescale**: number of time-units per second
 *   - **duration**: total duration in those time-units
 *
 * Supports both version-0 (32-bit fields) and version-1 (64-bit fields)
 * of the `mvhd` box.
 *
 * Returns `undefined` when the buffer cannot be parsed (e.g. truncated,
 * `moov` at end of a huge file not fully buffered, or not actually MP4).
 */
export function parseMp4Duration(buffer: Buffer): number | undefined {
  // Locate `moov` among top-level boxes.
  const moovData = findBox(buffer, 0, buffer.length, 'moov');
  if (!moovData) return undefined;

  // Locate `mvhd` inside `moov`.
  const mvhdData = findBox(buffer, moovData.dataStart, moovData.dataEnd, 'mvhd');
  if (!mvhdData) return undefined;

  const off = mvhdData.dataStart;
  if (off + 1 > buffer.length) return undefined;

  const version = buffer.readUInt8(off);

  let timescale: number;
  let duration: number;

  if (version === 0) {
    // version(1) + flags(3) + creation(4) + modification(4) + timescale(4) + duration(4) = 20 bytes
    if (off + 20 > buffer.length) return undefined;
    timescale = buffer.readUInt32BE(off + 12);
    duration = buffer.readUInt32BE(off + 16);
  } else {
    // version(1) + flags(3) + creation(8) + modification(8) + timescale(4) + duration(8) = 32 bytes
    if (off + 32 > buffer.length) return undefined;
    timescale = buffer.readUInt32BE(off + 20);
    // Read 64-bit duration as two 32-bit halves (avoids BigInt).
    const hi = buffer.readUInt32BE(off + 24);
    const lo = buffer.readUInt32BE(off + 28);
    duration = hi * 0x1_0000_0000 + lo;
  }

  if (timescale <= 0 || duration <= 0) return undefined;

  return Math.round((duration / timescale) * 1000);
}

/**
 * Find a box (atom) by its 4-character type within a range of the buffer.
 * Returns the data start/end offsets (after the 8-byte box header), or
 * `undefined` if not found.
 */
function findBox(
  buffer: Buffer,
  start: number,
  end: number,
  type: string,
): { dataStart: number; dataEnd: number } | undefined {
  let offset = start;
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);

    // size == 0 means box extends to the end; size == 1 means 64-bit extended size.
    let boxEnd: number;
    let dataStart: number;
    if (size === 0) {
      boxEnd = end;
      dataStart = offset + 8;
    } else if (size === 1) {
      if (offset + 16 > end) break;
      const hi = buffer.readUInt32BE(offset + 8);
      const lo = buffer.readUInt32BE(offset + 12);
      boxEnd = offset + hi * 0x1_0000_0000 + lo;
      dataStart = offset + 16;
    } else {
      if (size < 8) break; // invalid
      boxEnd = offset + size;
      dataStart = offset + 8;
    }

    if (boxType === type) {
      return { dataStart, dataEnd: Math.min(boxEnd, end) };
    }

    offset = boxEnd;
  }
  return undefined;
}

/**
 * Check whether a file name has an image extension.
 */
function isImageFileName(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// uploadAndSendMediaLark
// ---------------------------------------------------------------------------

/**
 * Upload and send a media file (image or general file) in one step.
 *
 * Accepts either a URL (remote or local `file://`) or a raw Buffer.
 * The function determines whether the media is an image (by extension)
 * and uses the appropriate upload/send path.
 *
 * @param params.cfg              - Plugin configuration.
 * @param params.to               - Target identifier.
 * @param params.mediaUrl         - URL of the media (http/https or local path).
 * @param params.mediaBuffer      - Raw bytes of the media (alternative to URL).
 * @param params.fileName         - File name (used for type detection and display).
 * @param params.replyToMessageId - Optional message ID for threaded reply.
 * @param params.accountId        - Optional account identifier.
 * @returns The send result.
 */
export async function uploadAndSendMediaLark(params: {
  cfg: OpenClawConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
  /** Allowed root directories for local file access (SSRF prevention). */
  mediaLocalRoots?: readonly string[];
}): Promise<SendMediaResult> {
  const { cfg, to, mediaUrl, mediaBuffer, fileName, replyToMessageId, replyInThread, accountId, mediaLocalRoots } =
    params;

  log.info(
    `uploadAndSendMediaLark: target=${to}, ` +
      `source=${mediaBuffer ? 'buffer' : (mediaUrl ?? '(none)')}, fileName=${fileName ?? '(auto)'}`,
  );

  // Resolve the media to a Buffer.
  let buffer: Buffer;
  let resolvedFileName = fileName ?? 'file';

  if (mediaBuffer) {
    buffer = mediaBuffer;
    log.debug(`using provided buffer: ${buffer.length} bytes`);
  } else if (mediaUrl) {
    buffer = await fetchMediaBuffer(mediaUrl, mediaLocalRoots);
    log.debug(`fetched media: ${buffer.length} bytes from "${mediaUrl}"`);

    // Derive a file name from the URL if none was provided.
    if (!fileName) {
      const derivedFileName = resolveFileNameFromMediaUrl(mediaUrl);
      if (derivedFileName) {
        resolvedFileName = derivedFileName;
      }
    }
  } else {
    throw new Error(
      '[feishu-media] uploadAndSendMediaLark requires either mediaUrl or mediaBuffer. ' +
        'Provide a URL (http/https/file://) or a raw Buffer to send media.',
    );
  }

  // Decide whether to send as image or file based on the extension.
  const isImage = isImageFileName(resolvedFileName);
  log.info(`resolved: fileName="${resolvedFileName}", ` + `type=${isImage ? 'image' : 'file'}, size=${buffer.length}`);

  if (isImage) {
    // Upload as image, then send image message.
    const { imageKey } = await uploadImageLark({
      cfg,
      image: buffer,
      imageType: 'message',
      accountId,
    });
    log.debug(`image uploaded: imageKey=${imageKey}`);

    return sendImageLark({
      cfg,
      to,
      imageKey,
      replyToMessageId,
      replyInThread,
      accountId,
    });
  }

  // Upload as file, then send as file or audio message.
  const fileType = detectFileType(resolvedFileName);
  const isAudio = fileType === 'opus';
  const isVideo = fileType === 'mp4';
  const duration = isAudio ? parseOggOpusDuration(buffer) : isVideo ? parseMp4Duration(buffer) : undefined;

  const { fileKey } = await uploadFileLark({
    cfg,
    file: buffer,
    fileName: resolvedFileName,
    fileType,
    duration,
    accountId,
  });
  log.debug(
    `file uploaded: fileKey=${fileKey}, ` +
      `fileType=${fileType}${isAudio || isVideo ? `, duration=${duration ?? 'unknown'}ms` : ''}`,
  );

  if (isAudio) {
    return sendAudioLark({ cfg, to, fileKey, replyToMessageId, replyInThread, accountId });
  }

  if (isVideo) {
    return sendVideoLark({ cfg, to, fileKey, replyToMessageId, replyInThread, accountId });
  }

  return sendFileLark({
    cfg,
    to,
    fileKey,
    replyToMessageId,
    replyInThread,
    accountId,
  });
}

// ---------------------------------------------------------------------------
// fetchRemoteImageBuffer — public wrapper for remote-only image downloads
// ---------------------------------------------------------------------------

/**
 * Fetch remote image bytes by URL (http/https only).
 * Local file access is denied. Includes SSRF protection.
 */
export async function fetchRemoteImageBuffer(url: string): Promise<Buffer> {
  return fetchMediaBuffer(url, undefined);
}

// ---------------------------------------------------------------------------
// SSRF protection — CIDR-based private/reserved IP filtering
// ---------------------------------------------------------------------------

/** Maximum remote-media download size (25 MB). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Max concurrent remote-media downloads (bounded gate). */
const MAX_MEDIA_CONCURRENCY = 4;
let activeMediaDownloads = 0;
const mediaDownloadWaitQueue: Array<() => void> = [];

async function acquireMediaSlot(): Promise<() => void> {
  if (activeMediaDownloads >= MAX_MEDIA_CONCURRENCY) {
    await new Promise<void>((resolve) => mediaDownloadWaitQueue.push(resolve));
  }
  activeMediaDownloads += 1;
  return () => {
    activeMediaDownloads -= 1;
    const next = mediaDownloadWaitQueue.shift();
    next?.();
  };
}

// ---- IPv4 CIDR matching (numeric, not string-prefix) ----

function ipv4ToLong(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  );
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask);
}

const BLOCKED_V4_CIDRS: readonly string[] = [
  '0.0.0.0/8',          // "this" network
  '10.0.0.0/8',         // private
  '100.64.0.0/10',      // CGNAT
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local / cloud metadata
  '172.16.0.0/12',      // private
  '192.0.0.0/24',       // IETF protocol assignments
  '192.0.2.0/24',       // TEST-NET-1
  '192.88.99.0/24',     // 6to4 relay anycast
  '192.168.0.0/16',     // private
  '198.18.0.0/15',      // benchmarking
  '198.51.100.0/24',    // TEST-NET-2
  '203.0.113.0/24',     // TEST-NET-3
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4',        // reserved (future use)
  '255.255.255.255/32', // broadcast
];

// ---- IPv6 CIDR matching (BigInt) ----

function expandIpv6(ip: string): string | null {
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    ip = [...leftParts, ...Array(missing).fill('0'), ...rightParts].join(':');
  }
  const parts = ip.split(':');
  if (parts.length !== 8) return null;
  return parts.join(':');
}

function ipv6ToBigInt(ip: string): bigint | null {
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  let result = 0n;
  for (const p of expanded.split(':')) {
    const val = parseInt(p || '0', 16);
    if (Number.isNaN(val)) return null;
    result = (result << 16n) + BigInt(val);
  }
  return result;
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipBig = ipv6ToBigInt(ip);
  const baseBig = ipv6ToBigInt(base);
  if (ipBig === null || baseBig === null) return false;
  const fullMask = (1n << 128n) - 1n;
  const shift = BigInt(128 - bits);
  const maskV = shift >= 128 ? 0n : fullMask ^ ((1n << shift) - 1n);
  return (ipBig & maskV) === (baseBig & maskV);
}

const BLOCKED_V6_CIDRS: readonly string[] = [
  '::/128',         // unspecified
  '::1/128',        // loopback
  '::ffff:0:0/96',  // IPv4-mapped (handled separately but block as belt-suspenders)
  '100::/64',       // discard prefix
  'fc00::/7',       // ULA
  'fe80::/10',      // link-local
  'ff00::/8',       // multicast
  '2001:db8::/32',  // documentation
];

/**
 * Unwrap an IPv4-mapped IPv6 address (e.g. ::ffff:10.1.2.3 or ::ffff:7f00:1)
 * and return the embedded IPv4 dotted-quad, if any.
 */
function extractEmbeddedIpv6Mapped(ip: string): string | null {
  // Dotted form: ::ffff:a.b.c.d
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  // Hex form: ::ffff:0:7f00:1 → split last two groups as IPv4
  const expanded = expandIpv6(ip.toLowerCase());
  if (!expanded) return null;
  const parts = expanded.split(':');
  // ::ffff:0:0:7f00:1 → parts[4..7] = mapped v4
  if (parts[0] === '0' && parts[1] === '0' && parts[2] === '0' && parts[3] === 'ffff') {
    const a = parseInt(parts[4], 16);
    const b = parseInt(parts[5], 16);
    const c = parseInt(parts[6], 16);
    const d = parseInt(parts[7], 16);
    if ([a, b, c, d].every((n) => !Number.isNaN(n) && n >= 0 && n <= 255)) {
      return `${a}.${b}.${c}.${d}`;
    }
  }
  return null;
}

/**
 * Check whether an IP address belongs to a private or reserved range.
 *
 * Uses CIDR numeric matching (not string-prefix heuristics) for both IPv4
 * and IPv6. IPv4-mapped IPv6 addresses are unwrapped before checking.
 */
function isBlockedIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();

  // Unwrap IPv4-mapped IPv6 first
  const mappedV4 = extractEmbeddedIpv6Mapped(v);
  if (mappedV4) {
    return BLOCKED_V4_CIDRS.some((cidr) => ipv4InCidr(mappedV4, cidr));
  }

  if (net.isIPv4(v)) {
    return BLOCKED_V4_CIDRS.some((cidr) => ipv4InCidr(v, cidr));
  }
  if (net.isIPv6(v)) {
    return BLOCKED_V6_CIDRS.some((cidr) => ipv6InCidr(v, cidr));
  }
  return false;
}

/**
 * Resolve a hostname to ALL of its IP addresses (A + AAAA) and validate
 * each one against blocked ranges. Returns the list of approved public
 * IPs the caller may pin to.
 *
 * Fails closed: any resolution error or any blocked address rejects the
 * whole request (we do not silently continue with a different record).
 */
async function resolveAndValidateHost(hostname: string): Promise<string[]> {
  // Literal IP — validate directly.
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error(`[feishu-media] Blocked IP "${hostname}" (SSRF protection).`);
    }
    return [hostname];
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    // all:true returns both A and AAAA; verbatim:true preserves DNS order.
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(
      `[feishu-media] DNS resolution failed for "${hostname}": ${String(err)}. ` +
        `Refusing to fetch (SSRF protection: ambiguous resolution is rejected).`,
      { cause: err },
    );
  }

  if (resolved.length === 0) {
    throw new Error(
      `[feishu-media] Hostname "${hostname}" resolved to no addresses (SSRF protection).`,
    );
  }

  const approved: string[] = [];
  for (const rec of resolved) {
    if (isBlockedIp(rec.address)) {
      throw new Error(
        `[feishu-media] Hostname "${hostname}" resolves to blocked address "${rec.address}" (SSRF protection).`,
      );
    }
    approved.push(rec.address);
  }
  return approved;
}

/**
 * Validate that a remote URL does not target private/reserved IP addresses.
 * Returns the list of approved IP addresses the caller should pin to.
 * Rejects non-http(s) protocols.
 */
async function validateRemoteUrl(raw: string): Promise<{ url: URL; approvedIps: string[] }> {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `[feishu-media] Unsupported protocol "${parsed.protocol}" in URL "${raw}". ` +
        `Only http:// and https:// are allowed for remote media.`,
    );
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const approvedIps = await resolveAndValidateHost(hostname);
  return { url: parsed, approvedIps };
}

// ---------------------------------------------------------------------------
// Pinned HTTP fetch (eliminates DNS-rebinding TOCTOU)
// ---------------------------------------------------------------------------

interface PinnedFetchResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Perform an HTTP(S) request pinned to an already-validated IP address.
 *
 * TCP connects to `approvedIp` directly (no re-resolution), while TLS
 * SNI and the Host header use the original hostname so virtual-hosting
 * and certificate validation continue to work. Enforces a hard byte cap
 * on the response body — over-limit responses abort immediately.
 */
function pinnedRequest(
  targetUrl: URL,
  approvedIp: string,
  timeoutMs: number,
): Promise<PinnedFetchResult> {
  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;
  const originalHost = targetUrl.hostname.replace(/^\[|\]$/g, '');

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        // Connect to the validated IP directly — no DNS re-lookup.
        host: approvedIp,
        port,
        method: 'GET',
        path: targetUrl.pathname + targetUrl.search,
        headers: {
          host: targetUrl.host,
          accept: '*/*',
        },
        // Preserve TLS certificate validation against the original hostname.
        servername: isHttps ? originalHost : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        const statusCode = res.statusCode ?? 502;
        const headers = res.headers;

        // Redirect: hand back without consuming body so caller can follow.
        if (statusCode >= 300 && statusCode < 400) {
          // Drain and discard the redirect body.
          res.resume();
          resolve({ statusCode, headers, body: Buffer.alloc(0) });
          return;
        }

        // Early reject based on Content-Length.
        const contentLength = Number(headers['content-length'] ?? 0);
        if (contentLength > MAX_MEDIA_BYTES) {
          res.resume();
          reject(
            new Error(
              `[feishu-media] Response body ${contentLength} bytes exceeds ${MAX_MEDIA_BYTES} byte limit (SSRF/memory protection).`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          total += chunk.length;
          if (total > MAX_MEDIA_BYTES) {
            aborted = true;
            req.destroy();
            reject(
              new Error(
                `[feishu-media] Response body exceeded ${MAX_MEDIA_BYTES} byte limit mid-stream (memory protection).`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          resolve({ statusCode, headers, body: Buffer.concat(chunks) });
        });
        res.on('error', (err) => {
          if (!aborted) reject(err);
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`[feishu-media] Request timed out after ${timeoutMs}ms.`));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// fetchMediaBuffer
// ---------------------------------------------------------------------------

/**
 * Fetch media bytes from a URL or local file path.
 *
 * Supports:
 * - `http://` and `https://` URLs (fetched via the global `fetch` API)
 * - `file://` URLs and bare file system paths (read from disk, gated
 *   by `localRoots` for path-traversal prevention)
 */
async function fetchMediaBuffer(urlOrPath: string, localRoots?: readonly string[]): Promise<Buffer> {
  const raw = normalizeMediaUrlInput(urlOrPath);

  // Local file path (absolute or relative, or file:// URL).
  if (isLocalMediaPath(raw)) {
    const filePath = raw.startsWith('file://') ? safeFileUrlToPath(raw) : raw;

    if (localRoots !== undefined) {
      // Explicit allowlist configured — enforce path restriction.
      validateLocalMediaRoots(filePath, localRoots);
    } else {
      // Deny by default: unconfigured mediaLocalRoots must not allow
      // arbitrary local file reads.
      throw new Error(
        `[feishu-media] Local file access denied for "${filePath}": ` +
          `mediaLocalRoots is not configured. ` +
          `Configure mediaLocalRoots to explicitly allow local file access.`,
      );
    }

    const buf = fs.readFileSync(filePath);
    log.debug(`local file read: "${filePath}", ${buf.length} bytes`);
    return buf;
  }

  // Remote URL — validate against SSRF, then pin each connection.
  const FETCH_TIMEOUT_MS = 30_000;
  /** Max redirect hops — each hop is re-validated and re-pinned. */
  const MAX_MEDIA_REDIRECTS = 5;
  log.info(`fetching remote media: ${raw}`);

  const releaseSlot = await acquireMediaSlot();
  try {
    const arrayBuffer = await withRetry(async () => {
      let currentUrlStr = raw;
      for (let hop = 0; hop <= MAX_MEDIA_REDIRECTS; hop++) {
        // Validate current target and get approved IPs (A+AAAA all checked).
        const { url: currentUrl, approvedIps } = await validateRemoteUrl(currentUrlStr);
        // Pin to the first approved IP — TCP never re-resolves DNS.
        const pinnedIp = approvedIps[0];

        const resp = await pinnedRequest(currentUrl, pinnedIp, FETCH_TIMEOUT_MS);
        const location = resp.headers['location'];

        if (resp.statusCode >= 300 && resp.statusCode < 400 && location) {
          if (hop >= MAX_MEDIA_REDIRECTS) {
            throw new Error(
              `[feishu-media] Too many redirects (>${MAX_MEDIA_REDIRECTS}) while fetching "${raw}".`,
            );
          }
          const nextUrl = new URL(Array.isArray(location) ? location[0] : location, currentUrl).toString();
          log.debug(`redirect hop ${hop + 1}: ${currentUrlStr} -> ${nextUrl}`);
          // Next loop iteration re-validates and re-pins the new target.
          currentUrlStr = nextUrl;
          continue;
        }

        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          const err: Error & { status?: number } = new Error(
            `[feishu-media] Failed to fetch media from "${currentUrlStr}": ` +
              `HTTP ${resp.statusCode}. Verify the URL is accessible and returns a valid media resource.`,
          );
          err.status = resp.statusCode;
          throw err;
        }

        return resp.body;
      }
      // Unreachable (loop guard above always throws or returns).
      throw new Error(`[feishu-media] Unreachable state while fetching "${raw}".`);
    }, `fetchMedia(${raw})`);

    log.debug(`remote media fetched: ${raw}, ${arrayBuffer.byteLength} bytes`);
    return arrayBuffer;
  } finally {
    releaseSlot();
  }
}
