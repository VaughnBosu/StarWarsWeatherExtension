import { describe, expect, test } from 'bun:test';
import { DynamoStore } from '../src/dynamo-store.js';

class GetCommand { constructor(input) { this.input = input; } }
class UpdateCommand { constructor(input) { this.input = input; } }
const conditional = () => Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

function quotaClient() {
  let item = null;
  const calls = [];
  return {
    calls,
    get item() { return item; },
    async send(command) {
      calls.push(command);
      const input = command.input;
      if (command instanceof GetCommand) return { Item: item ? structuredClone(item) : undefined };
      if (input.Key.pk !== 'CONTROL#PROVIDER_QUOTA') return {};
      if (input.ExpressionAttributeValues[':cooldownUntil'] !== undefined) {
        const requested = input.ExpressionAttributeValues[':cooldownUntil'];
        if (item?.cooldownUntil >= requested) throw conditional();
        item = item ?? { pk: 'CONTROL#PROVIDER_QUOTA' };
        item.cooldownUntil = requested;
        item.updatedAt = input.ExpressionAttributeValues[':updatedAt'];
        item.version = (item.version ?? 0) + 1;
        return {};
      }
      const expected = input.ExpressionAttributeValues[':expectedVersion'];
      if (expected === undefined ? item !== null : item?.version !== expected) throw conditional();
      item = item ?? { pk: 'CONTROL#PROVIDER_QUOTA' };
      for (const [placeholder, name] of Object.entries(input.ExpressionAttributeNames)) {
        const valueKey = placeholder === '#version' ? ':nextVersion' : `:${placeholder.slice(1)}`;
        if (valueKey in input.ExpressionAttributeValues) item[name] = input.ExpressionAttributeValues[valueKey];
      }
      return {};
    }
  };
}

describe('DynamoDB store', () => {
  test('a rolling token bucket prevents a fixed-minute boundary burst', async () => {
    const client = quotaClient();
    const store = new DynamoStore({
      tableName: 'cache', client, commands: { GetCommand, UpdateCommand }
    });
    const limits = { minute: 48, burst: 2, day: 2, month: 3 };
    const first = Date.parse('2026-08-29T23:59:59Z') / 1000;
    expect(await store.reserveQuota({ limits, nowEpochSeconds: first }))
      .toMatchObject({ allowed: true });
    expect(await store.reserveQuota({ limits, nowEpochSeconds: first }))
      .toMatchObject({ allowed: true });
    expect(await store.reserveQuota({ limits, nowEpochSeconds: first }))
      .toMatchObject({ allowed: false, deniedWindow: 'rate' });

    // Crossing 00:00 only refills 0.8 token; it does not open another fixed bucket.
    expect(await store.reserveQuota({ limits, nowEpochSeconds: first + 1 }))
      .toMatchObject({ allowed: false, deniedWindow: 'rate', retryAfterSeconds: 1 });
    expect(await store.reserveQuota({ limits, nowEpochSeconds: first + 2 }))
      .toMatchObject({ allowed: true });
    expect(client.item).toMatchObject({ dayCount: 1, monthCount: 3 });
    expect(client.item.rateTokens).toBeCloseTo(0.6, 8);

    const nextMonth = Date.parse('2026-09-01T00:00:01Z') / 1000;
    expect(await store.reserveQuota({ limits, nowEpochSeconds: nextMonth }))
      .toMatchObject({ allowed: true });
    expect(client.item).toMatchObject({ dayCount: 1, monthCount: 1, rateTokens: 1 });
  });

  test('disabled quota windows are omitted', async () => {
    const client = quotaClient();
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    await store.reserveQuota({ limits: { minute: 2, burst: 1, day: 0, month: 0 }, nowEpochSeconds: 1000 });
    expect(client.item).toHaveProperty('rateTokens', 0);
    expect(client.item).not.toHaveProperty('dayCount');
    expect(client.item).not.toHaveProperty('monthCount');
  });

  test('preserves atomic UTC day and month hard caps alongside the token bucket', async () => {
    const client = quotaClient();
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const limits = { minute: 0, burst: 1, day: 1, month: 2 };
    const dayOne = Date.parse('2026-08-01T12:00:00Z') / 1000;
    expect(await store.reserveQuota({ limits, nowEpochSeconds: dayOne })).toMatchObject({ allowed: true });
    expect(await store.reserveQuota({ limits, nowEpochSeconds: dayOne + 1 }))
      .toMatchObject({ allowed: false, deniedWindow: 'day' });
    const dayTwo = Date.parse('2026-08-02T12:00:00Z') / 1000;
    expect(await store.reserveQuota({ limits, nowEpochSeconds: dayTwo })).toMatchObject({ allowed: true });
    const dayThree = Date.parse('2026-08-03T12:00:00Z') / 1000;
    expect(await store.reserveQuota({ limits, nowEpochSeconds: dayThree }))
      .toMatchObject({ allowed: false, deniedWindow: 'month' });
  });

  test('a reservation stamped before UTC midnight cannot roll the stored day back', async () => {
    const client = quotaClient();
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const limits = { minute: 0, burst: 1, day: 3, month: 100 };
    const afterMidnight = Date.parse('2026-09-01T00:00:01Z') / 1000;
    await store.reserveQuota({ limits, nowEpochSeconds: afterMidnight });
    await store.reserveQuota({ limits, nowEpochSeconds: afterMidnight });

    // A slower request (or a Lambda with a lagging clock) stamped one second earlier.
    expect(await store.reserveQuota({ limits, nowEpochSeconds: afterMidnight - 2 }))
      .toMatchObject({ allowed: true });
    expect(client.item).toMatchObject({ dayBucket: '2026-09-01', dayCount: 3, monthBucket: '2026-09', monthCount: 3 });
    expect(await store.reserveQuota({ limits, nowEpochSeconds: afterMidnight + 1 }))
      .toMatchObject({ allowed: false, deniedWindow: 'day' });
  });

  test('an earlier-stamped reservation does not move the refill clock backward', async () => {
    const client = quotaClient();
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const limits = { minute: 60, burst: 2, day: 0, month: 0 };
    await store.reserveQuota({ limits, nowEpochSeconds: 1000 });
    await store.reserveQuota({ limits, nowEpochSeconds: 999 });
    expect(client.item.rateUpdatedAt).toBe(1000);
    expect(client.item.rateTokens).toBeCloseTo(0, 8);
  });

  test('optimistic-lock retries pause with jitter instead of spinning', async () => {
    const client = quotaClient();
    const pauses = [];
    let conflicts = 2;
    const send = client.send.bind(client);
    client.send = async (command) => {
      if (command instanceof UpdateCommand && conflicts > 0) {
        conflicts -= 1;
        throw conditional();
      }
      return send(command);
    };
    const store = new DynamoStore({
      tableName: 'cache',
      client,
      commands: { GetCommand, UpdateCommand },
      sleep: async (milliseconds) => { pauses.push(milliseconds); },
      random: () => 0.5
    });
    expect(await store.reserveQuota({ limits: { minute: 48, burst: 6, day: 10, month: 10 }, nowEpochSeconds: 1000 }))
      .toMatchObject({ allowed: true });
    expect(pauses).toEqual([15, 30]);
  });

  test('a provider 429 creates a shared cooldown that blocks later reservations', async () => {
    const client = quotaClient();
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const limits = { minute: 48, burst: 12, day: 25000, month: 800000 };
    await store.reserveQuota({ limits, nowEpochSeconds: 1000 });
    const versionBefore = client.item.version;
    expect(await store.startProviderCooldown({ nowEpochSeconds: 1001, cooldownSeconds: 60 })).toBe(true);
    expect(client.item.version).toBe(versionBefore + 1);
    expect(await store.reserveQuota({ limits, nowEpochSeconds: 1002 })).toMatchObject({
      allowed: false,
      deniedWindow: 'cooldown',
      cooldownUntil: 1061,
      retryAfterSeconds: 59
    });
  });

  test('lease contention returns false without surfacing an exception', async () => {
    const client = { send: async () => { throw conditional(); } };
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    expect(await store.tryAcquireLease({ key: 'WX#1#2', owner: 'a', nowEpochSeconds: 10, leaseSeconds: 5 })).toBe(false);
  });

  test('a cache write is conditional on retaining the refresh lease', async () => {
    const calls = [];
    const client = { send: async (command) => { calls.push(command.input); throw conditional(); } };
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const written = await store.putCache({
      key: 'WX#1#2', owner: 'slow-owner', payload: {}, negative: false, freshUntil: 20, staleUntil: 30
    });
    expect(written).toBe(false);
    expect(calls[0]).toMatchObject({
      ConditionExpression: '#leaseOwner = :owner',
      ExpressionAttributeValues: { ':owner': 'slow-owner' }
    });
  });

  test('client upstream buckets are atomic, short-lived, and contain only a fingerprint', async () => {
    const calls = [];
    let count = 0;
    const client = {
      async send(command) {
        calls.push(command.input);
        if (count >= 2) throw conditional();
        count += 1;
        return {};
      }
    };
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const input = {
      fingerprint: 'opaque-fingerprint',
      limit: 2,
      windowSeconds: 300,
      nowEpochSeconds: 1001
    };
    expect(await store.reserveClientUpstream(input)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await store.reserveClientUpstream(input)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await store.reserveClientUpstream(input)).toEqual({ allowed: false, retryAfterSeconds: 199 });
    expect(calls[0]).toMatchObject({
      Key: { pk: 'CONTROL#CLIENT_UPSTREAM#300#900#opaque-fingerprint' },
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeValues: { ':limit': 2, ':expiresAt': 4800 }
    });
    expect(JSON.stringify(calls)).not.toContain('sourceIp');
  });

  // The service derives both fingerprints from the window start, so at 00:00-00:05 UTC
  // the short and daily windows hand the store the same fingerprint and start.
  test('short and daily client windows opening at UTC midnight keep separate counters', async () => {
    const keys = [];
    const client = { async send(command) { keys.push(command.input.Key.pk); return {}; } };
    const store = new DynamoStore({ tableName: 'cache', client, commands: { GetCommand, UpdateCommand } });
    const oneMinutePastMidnight = Date.UTC(2026, 9, 19, 0, 1) / 1000;

    for (const windowSeconds of [300, 86400]) {
      await store.reserveClientUpstream({
        fingerprint: 'same-fingerprint',
        limit: 60,
        windowSeconds,
        nowEpochSeconds: oneMinutePastMidnight
      });
    }

    expect(new Set(keys).size).toBe(2);
  });
});
