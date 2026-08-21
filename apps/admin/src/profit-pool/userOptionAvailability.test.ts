import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userOptionAvailability } from './userOptionAvailability';

const unbound = {
  status: 'ACTIVE' as const,
  agent: null,
  binding: null,
};

test('未归属用户可以设为第一层代理', () => {
  assert.deepEqual(userOptionAvailability(unbound, 'agent'), {
    allowed: true,
    reason: '可设为第一层代理',
  });
});

test('已归属用户在建代理时仍可选，并提示将解绑', () => {
  const user = {
    ...unbound,
    binding: { agentId: 'a1', agentLabel: '老代理' },
  };
  assert.deepEqual(userOptionAvailability(user, 'agent'), {
    allowed: true,
    reason: '将从「老代理」解绑',
  });
});

test('已归属用户在绑玩家时不可选', () => {
  const user = {
    ...unbound,
    binding: { agentId: 'a1', agentLabel: '老代理' },
  };
  assert.equal(userOptionAvailability(user, 'player').allowed, false);
});

test('已经是代理的用户不能再建成第一层', () => {
  const user = {
    ...unbound,
    agent: { label: '股东' },
  };
  assert.deepEqual(userOptionAvailability(user, 'agent'), {
    allowed: false,
    reason: '已是代理：股东',
  });
});
