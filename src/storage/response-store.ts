/*
 * File: response-store.ts
 * Project: qwenproxy
 * Persistent Responses API metadata for Codex-compatible continuations.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface StoredResponseRecord {
  id: string;
  chatId: string;
  createdAt: string;
  updatedAt: string;
  request: unknown;
  response: unknown;
  inputItems: unknown[];
}

const DATA_DIR = path.resolve(process.env.QWENPROXY_DATA_DIR || 'qwen_data');
const RESPONSE_DIR = path.join(DATA_DIR, 'responses');

function encodeResponseId(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function filePathForResponse(responseId: string): string {
  return path.join(RESPONSE_DIR, `${encodeResponseId(responseId)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ensureStorageDir(): Promise<void> {
  await fs.mkdir(RESPONSE_DIR, { recursive: true });
}

export async function getStoredResponse(responseId: string): Promise<StoredResponseRecord | null> {
  try {
    const raw = await fs.readFile(filePathForResponse(responseId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredResponseRecord>;
    if (!parsed.id || !parsed.chatId) return null;
    return {
      id: parsed.id,
      chatId: parsed.chatId,
      createdAt: parsed.createdAt || nowIso(),
      updatedAt: parsed.updatedAt || nowIso(),
      request: parsed.request || null,
      response: parsed.response || null,
      inputItems: Array.isArray(parsed.inputItems) ? parsed.inputItems : []
    };
  } catch {
    return null;
  }
}

export async function saveStoredResponse(record: StoredResponseRecord): Promise<StoredResponseRecord> {
  await ensureStorageDir();
  const next: StoredResponseRecord = {
    ...record,
    updatedAt: nowIso()
  };
  const filePath = filePathForResponse(record.id);
  const tmpPath = `${filePath}.${uuidv4()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
  return next;
}

export async function deleteStoredResponse(responseId: string): Promise<boolean> {
  try {
    await fs.unlink(filePathForResponse(responseId));
    return true;
  } catch {
    return false;
  }
}

