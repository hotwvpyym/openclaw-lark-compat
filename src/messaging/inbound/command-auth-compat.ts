/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Command-authorization compatibility shim for OpenClaw 10.x.
 *
 * OpenClaw 2026.10.x removed the `openclaw/plugin-sdk/command-auth` subpath
 * export.  Its functions had been deprecated since 2026.9.7 in favour of
 * `openclaw/plugin-sdk/channel-ingress-runtime` (which exists on every line
 * from 2026.9.6 through 2026.10.x).  This shim keeps one code path:
 *
 *   - Legacy lines (2026.9.x and earlier): the original
 *     `resolveSenderCommandAuthorization` from `command-auth` is used, so the
 *     behaviour on already-released OpenClaw versions is unchanged.
 *   - New line (2026.10.x): `resolveChannelMessageIngress` from
 *     `channel-ingress-runtime` computes the equivalent command decision.
 *
 * The legacy subpath is loaded through a variable-keyed dynamic import so the
 * module still type-checks against OpenClaw 10.x dev dependencies (where the
 * subpath no longer exists).
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
} from 'openclaw/plugin-sdk/channel-ingress-runtime';

export interface ResolveSenderCommandAuthorizationCompatParams {
  rawBody: string;
  cfg: OpenClawConfig;
  isGroup: boolean;
  dmPolicy: string;
  configuredAllowFrom: string[];
  configuredGroupAllowFrom?: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  readAllowFromStore: () => Promise<string[]>;
  /** Chat id of the inbound message (used as the ingress channel id). */
  channelId: string;
  /** Account id scoped to this channel instance. */
  accountId: string;
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

export interface ResolveSenderCommandAuthorizationCompatResult {
  commandAuthorized?: boolean;
};

interface LegacyCommandAuthModule {
  resolveSenderCommandAuthorization: (params: Record<string, unknown>) => Promise<ResolveSenderCommandAuthorizationCompatResult>;
};

/**
 * Resolve whether a sender may run slash/control commands.
 *
 * Prefers the legacy `command-auth` subpath when the running OpenClaw exports
 * it; falls back to the channel-ingress runtime on OpenClaw 10.x.
 */
export async function resolveSenderCommandAuthorizationCompat(
  params: ResolveSenderCommandAuthorizationCompatParams,
): Promise<ResolveSenderCommandAuthorizationCompatResult> {
  const legacy = await tryLoadLegacyCommandAuth();
  if (legacy) {
    return legacy.resolveSenderCommandAuthorization({
      rawBody: params.rawBody,
      cfg: params.cfg,
      isGroup: params.isGroup,
      dmPolicy: params.dmPolicy,
      configuredAllowFrom: params.configuredAllowFrom,
      configuredGroupAllowFrom: params.configuredGroupAllowFrom,
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
      readAllowFromStore: params.readAllowFromStore,
      shouldComputeCommandAuthorized: params.shouldComputeCommandAuthorized,
      resolveCommandAuthorizedFromAuthorizers: params.resolveCommandAuthorizedFromAuthorizers,
    });
  }
  return resolveCommandAuthorizationViaIngress(params);
}

async function tryLoadLegacyCommandAuth(): Promise<LegacyCommandAuthModule | null> {
  // Variable-keyed dynamic import: TypeScript cannot resolve the module id,
  // which keeps this file type-checking on OpenClaw 10.x dev dependencies.
  const legacyPath = 'openclaw/plugin-sdk/command-auth';
  try {
    const mod = (await import(legacyPath)) as Partial<LegacyCommandAuthModule>;
    if (typeof mod?.resolveSenderCommandAuthorization === 'function') {
      return mod as LegacyCommandAuthModule;
    }
  } catch {
    // OpenClaw 10.x removed the subpath — fall through to the ingress runtime.
  }
  return null;
}

/**
 * 合并命令 owner 白名单：账号级 allowFrom ∪ 全局 commands.ownerAllowFrom。
 *
 * OpenClaw 配对（pairing）成功后会把已批准的主人写入顶层 commands.ownerAllowFrom，
 * 条目形如 "feishu:ou_xxx"（channel:senderId）。若只传账号级 configuredAllowFrom，
 * 未显式配置 allowFrom 的 paired 主人会被 ingress 判为 command_unauthorized，
 * 导致系统命令静默结束（delivered=false）。此处按本 channel 前缀归一化为纯
 * senderId 后并入，其他 channel 的 owner 条目不影响 feishu 授权。
 */
export function mergeCommandOwnerAllowFrom(
  configuredAllowFrom: string[],
  cfg?: { commands?: { ownerAllowFrom?: unknown } },
): string[] {
  const globalCommandOwners = Array.isArray(cfg?.commands?.ownerAllowFrom)
    ? (cfg.commands.ownerAllowFrom as unknown[])
    : [];
  const feishuCommandOwners = globalCommandOwners
    .map((entry) => String(entry))
    .filter((entry) => /^feishu:/i.test(entry))
    .map((entry) => entry.replace(/^feishu:/i, ''))
    .filter(Boolean);
  return Array.from(new Set([...configuredAllowFrom, ...feishuCommandOwners]));
}

async function resolveCommandAuthorizationViaIngress(
  params: ResolveSenderCommandAuthorizationCompatParams,
): Promise<ResolveSenderCommandAuthorizationCompatResult> {
  const shouldCompute = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  if (!shouldCompute) {
    return { commandAuthorized: undefined };
  }

  // 与 legacy command-auth 一致：空 senderId 一律不授权。
  // ingress runtime 会把空 sender 归一化为 null 后仍可能被通配 allowFrom ('*') 放行，
  // 而 legacy 注入的 isSenderAllowed 对空 sender 恒返回 false —— 这里保持同等安全边界。
  if (!params.senderId) {
    return { commandAuthorized: false };
  }

  // 命令 owner 白名单 = 账号级 allowFrom ∪ 全局 commands.ownerAllowFrom
  // （配对成功时 OpenClaw 会把主人写入顶层 commands.ownerAllowFrom，条目形如
  //  "feishu:ou_xxx"；未并入时 paired 主人未配 allowFrom 会被 ingress 静默拒绝）。
  const commandOwnerAllowFrom = mergeCommandOwnerAllowFrom(
    params.configuredAllowFrom,
    params.cfg as { commands?: { ownerAllowFrom?: unknown } },
  );

  const ingress = await resolveChannelMessageIngress({
    channelId: params.channelId,
    accountId: params.accountId,
    identity: defineStableChannelIngressIdentity({
      key: 'senderId',
      normalize: (value: string) => (value.length > 0 ? value : null),
      authentication: 'verified',
    }),
    subject: { stableId: params.senderId },
    conversation: { kind: params.isGroup ? 'group' : 'direct', id: params.channelId },
    event: { kind: 'message', authMode: 'inbound', mayPair: false },
    policy: {
      dmPolicy: params.dmPolicy as 'open' | 'pairing' | 'allowlist' | 'disabled',
      groupPolicy: 'allowlist',
      activation: { requireMention: false, allowTextCommands: true },
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
        modeWhenAccessGroupsOff: 'configured',
      },
    },
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: params.configuredGroupAllowFrom,
    readStoreAllowFrom: async ({ dmPolicy }) =>
      !params.isGroup && dmPolicy !== 'allowlist' && dmPolicy !== 'open'
        ? ((await params.readAllowFromStore().catch(() => [])) as (string | number)[])
        : [],
    command: {
      useAccessGroups: true,
      allowTextCommands: true,
      hasControlCommand: true,
      modeWhenAccessGroupsOff: 'configured',
      commandOwnerAllowFrom,
      groupOwnerAllowFrom: 'configured',
      directGroupAllowFrom: 'none',
    },
  });

  return { commandAuthorized: ingress.commandAccess?.authorized };
}
