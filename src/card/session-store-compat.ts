/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Session-store 兼容层（OpenClaw 8.1 ~ 10.x）。
 *
 * 背景：
 * 1. OpenClaw 10.4+ 把会话主表从 `session_entries` 迁移为 `session_nodes`（entry_json 列结构不变）；
 *    9.x/10.3 及更早仍为 `session_entries`。直读 SQL 需双路径探测表名。
 * 2. plugin-sdk 同步 API `getSessionEntry` 已标记 @deprecated，官方计划在下一 Plugin SDK major 移除
 *    （提示退役时间 2026-12-31）；10.4+ 提供异步替代 `getSessionEntryAsync`。运行时探测：
 *    存在异步 API 走异步，否则回退同步（≤10.3 无异步 API）。
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
// eslint-disable-next-line n/no-unsupported-features/node-builtins
import { DatabaseSync } from 'node:sqlite';
import * as sessionStoreRuntime from 'openclaw/plugin-sdk/session-store-runtime';

/** 10.4+ 会话主表；9.x/10.3 旧表。按此顺序探测。 */
const SESSION_ENTRY_TABLES = ['session_nodes', 'session_entries'] as const;

/**
 * 从 sessions.json store 路径推导 per-agent SQLite 库路径。
 * 与 openclaw 9.7+ 内部 resolveUnsuffixedSqliteTargetFromSessionStorePath 逻辑一致
 * （10.5 paths-CUpF8edW.mjs 相同推导）：
 * <stateDir>/agents/<agentId>/sessions/sessions.json → <stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite
 */
export function resolveSqlitePathFromStorePath(storePath: string): string {
  const resolvedPath = resolve(storePath);
  if (resolvedPath.endsWith('.sqlite')) return resolvedPath;
  const sessionsDir = dirname(resolvedPath);
  if (basename(resolvedPath) !== 'sessions.json') return join(sessionsDir, 'openclaw-agent.sqlite');
  if (basename(sessionsDir) !== 'sessions') return join(sessionsDir, 'openclaw-agent.sqlite');
  const agentDir = dirname(sessionsDir);
  if (basename(dirname(agentDir)) !== 'agents') return join(sessionsDir, 'openclaw-agent.sqlite');
  return join(agentDir, 'agent', 'openclaw-agent.sqlite');
}

/**
 * 直读会话库（绕开 SDK 快照复制机制）——双路径表名探测。
 * 9.x 的 getSessionEntry 内部把源库复制到临时目录做只读快照，宿主高频写活库时快照反复失败；
 * node:sqlite 只读直读主库（SQLite WAL 并发读安全）稳定可靠。
 * 10.4+ 主表 session_nodes，9.x/10.3 主表 session_entries：按序探测，命中即读。
 */
export function directReadSessionEntryViaSqlite(
  storePath: string,
  sessionKey: string,
): Record<string, unknown> | undefined {
  try {
    const sqlitePath = resolveSqlitePathFromStorePath(storePath);
    if (!existsSync(sqlitePath)) return undefined;
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      let row: { entry_json?: unknown } | undefined;
      for (const table of SESSION_ENTRY_TABLES) {
        try {
          row = db
            .prepare(`SELECT entry_json FROM ${table} WHERE session_key = ?`)
            .get(sessionKey) as { entry_json?: unknown } | undefined;
        } catch {
          row = undefined; // 表不存在（新旧 schema 差异），尝试下一张表
        }
        if (row) break;
      }
      if (!row || typeof row.entry_json !== 'string' || !row.entry_json) return undefined;
      const parsed: unknown = JSON.parse(row.entry_json);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } finally {
      try {
        db.close();
      } catch {
        // 忽略关闭异常
      }
    }
  } catch {
    // 由调用方记录日志；此处静默返回 undefined 走 SDK 兜底
    return undefined;
  }
}

/**
 * getSessionEntry 双路径兼容层：10.4+ 有异步 API 走异步（同步版将于 2026-12-31 退役），
 * ≤10.3 无异步 API 回退同步。参数与返回结构与 SDK getSessionEntry 一致。
 */
export async function getSessionEntryCompat(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
}): Promise<Record<string, unknown> | undefined> {
  const runtime = sessionStoreRuntime as unknown as {
    getSessionEntryAsync?: (p: unknown) => Promise<unknown>;
    getSessionEntry: (p: unknown) => unknown;
  };
  if ('getSessionEntryAsync' in runtime && typeof runtime.getSessionEntryAsync === 'function') {
    return (await runtime.getSessionEntryAsync(params)) as Record<string, unknown> | undefined;
  }
  return runtime.getSessionEntry(params) as Record<string, unknown> | undefined;
}
