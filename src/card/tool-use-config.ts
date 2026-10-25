/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Resolution logic for Feishu tool-use display.
 *
 * The source of truth is OpenClaw's effective verbose state:
 * inline `/verbose` override > session store override > config default.
 * Feishu channel config only retains UI-level detail (`showFullPaths`).
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';
import type { FeishuConfig } from '../core/types';
import { larkLogger } from '../core/lark-logger';
import { directReadSessionEntryViaSqlite, getSessionEntryCompat } from './session-store-compat';

const log = larkLogger('card/tool-use-config');

export type ToolUseMode = 'off' | 'on' | 'full';

export interface ToolUseDisplayConfig {
  mode: ToolUseMode;
  showToolUse: boolean;
  showToolResultDetails: boolean;
  showFullPaths: boolean;
}

export async function resolveToolUseDisplayConfig(params: {
  cfg: OpenClawConfig;
  feishuCfg: FeishuConfig | undefined;
  agentId: string;
  sessionKey: string;
  body?: string;
}): Promise<ToolUseDisplayConfig> {
  const mode = await resolveEffectiveVerboseMode(params);
  return {
    mode,
    showToolUse: mode !== 'off',
    showToolResultDetails: mode === 'full',
    showFullPaths: params.feishuCfg?.toolUseDisplay?.showFullPaths === true,
  };
}

async function resolveEffectiveVerboseMode(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  body?: string;
}): Promise<ToolUseMode> {
  const inline = extractInlineVerboseMode(params.body);
  if (inline) return inline;
  const sessionMode = await resolveSessionVerboseMode(params.cfg, params.sessionKey, params.agentId);
  if (sessionMode) return sessionMode;
  return normalizeToolUseMode(params.cfg.agents?.defaults?.verboseDefault) ?? 'off';
}

async function resolveSessionVerboseMode(
  cfg: OpenClawConfig,
  sessionKey: string,
  agentId: string,
): Promise<ToolUseMode | undefined> {
  const cfgWithSession = cfg as { session?: { store?: string }; sessions?: { store?: string } };
  const sessionStorePath = cfgWithSession.session?.store ?? cfgWithSession.sessions?.store;
  const storePath = resolveStorePath(sessionStorePath, { agentId });
  const candidateKeys = resolveCandidateSessionKeys(cfg, sessionKey);

  for (const candidateKey of candidateKeys) {
    // v7：直读优先（双路径表名探测，10.4+ session_nodes / ≤10.3 session_entries）。
    // verboseLevel 落在 entry_json 内，直读稳定；直读失败（如库不存在/权限/格式）
    // 单独捕获后继续走 SDK 兼容层兜底，不吞掉回退路径。
    let directEntry: Record<string, unknown> | undefined;
    try {
      directEntry = directReadSessionEntryViaSqlite(storePath, candidateKey);
    } catch (err) {
      log.warn('directReadSessionEntryViaSqlite failed, falling back to compat layer', {
        error: String(err),
      });
    }
    if (directEntry) {
      const mode = normalizeToolUseMode(directEntry.verboseLevel);
      if (mode) return mode;
      return undefined;
    }
    const existing = await getSessionEntryCompat({ agentId, storePath, sessionKey: candidateKey });
    const mode = normalizeToolUseMode(existing?.verboseLevel);
    if (mode) return mode;
    if (existing) return undefined;
  }
  return undefined;
}

function resolveCandidateSessionKeys(cfg: OpenClawConfig, sessionKey: string): string[] {
  const key = sessionKey.trim().toLowerCase();
  let defaultAgentId: string | undefined;
  try {
    defaultAgentId = resolveDefaultAgentId(cfg as Record<string, unknown>);
  } catch (err) {
    // v7：explicit 多 Agent 归属下 resolveDefaultAgentId 必然抛 AgentSelectionRequiredError，
    // 与 streaming-card-controller 保持一致：回退为 undefined（仅保留原始 key）。
    log.warn('resolveDefaultAgentId failed in resolveCandidateSessionKeys, using primary key only', {
      error: String(err),
    });
  }
  const fallbackKey = defaultAgentId ? key.replace(/^(agent):[^:]+:/, `$1:${defaultAgentId}:`) : key;
  return fallbackKey !== key ? [key, fallbackKey] : [key];
}

function extractInlineVerboseMode(body?: string): ToolUseMode | undefined {
  if (!body) return undefined;
  const matches = body.matchAll(/(?:^|\s)\/(?:verbose|v)(?::|\s+)(on|off|full)\b/gi);
  let last: ToolUseMode | undefined;
  for (const match of matches) {
    last = normalizeToolUseMode(match[1]);
  }
  return last;
}

function normalizeToolUseMode(value: unknown): ToolUseMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'on' || normalized === 'full') {
    return normalized;
  }
  return undefined;
}
