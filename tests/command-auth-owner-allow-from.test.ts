import { describe, expect, it } from 'vitest';
import { mergeCommandOwnerAllowFrom } from '../src/messaging/inbound/command-auth-compat';

describe('mergeCommandOwnerAllowFrom', () => {
  it('无全局 ownerAllowFrom 时仅返回账号级 allowFrom（行为不变）', () => {
    expect(mergeCommandOwnerAllowFrom(['ou_a', 'ou_b'], undefined)).toEqual(['ou_a', 'ou_b']);
    expect(mergeCommandOwnerAllowFrom(['ou_a'], {})).toEqual(['ou_a']);
  });

  it('并入 feishu 前缀 owner 条目并归一化为纯 senderId', () => {
    const cfg = { commands: { ownerAllowFrom: ['feishu:ou_owner1'] } };
    expect(mergeCommandOwnerAllowFrom([], cfg)).toEqual(['ou_owner1']);
  });

  it('账号级 allowFrom 与全局 feishu owner 合并、去重', () => {
    const cfg = {
      commands: { ownerAllowFrom: ['feishu:ou_owner1', 'feishu:ou_owner2', 'feishu:ou_owner1'] },
    };
    expect(mergeCommandOwnerAllowFrom(['ou_owner1', 'ou_cfg'], cfg)).toEqual([
      'ou_owner1',
      'ou_cfg',
      'ou_owner2',
    ]);
  });

  it('忽略其他 channel 的 owner 条目（slack 等不并入 feishu 授权）', () => {
    const cfg = {
      commands: { ownerAllowFrom: ['slack:U123', 'feishu:ou_owner1'] },
    };
    expect(mergeCommandOwnerAllowFrom([], cfg)).toEqual(['ou_owner1']);
  });

  it('大小写不敏感处理 feishu: 前缀，空条目被过滤', () => {
    const cfg = {
      commands: { ownerAllowFrom: ['FEISHU:ou_owner1', 'feishu:', '', 'slack:U1'] },
    };
    expect(mergeCommandOwnerAllowFrom([], cfg)).toEqual(['ou_owner1']);
  });

  it('ownerAllowFrom 非数组（异常配置）时安全回退为仅账号级', () => {
    const cfg = { commands: { ownerAllowFrom: 'feishu:ou_x' as unknown } };
    expect(mergeCommandOwnerAllowFrom(['ou_a'], cfg)).toEqual(['ou_a']);
  });
});
