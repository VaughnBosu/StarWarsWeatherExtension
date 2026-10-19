const isConditionalFailure = (error) => error?.name === 'ConditionalCheckFailedException';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Fixed-window start shared by the client fingerprint and the bucket key so they cannot drift. */
export const clientWindowStart = (nowEpochSeconds, windowSeconds) =>
  Math.floor(nowEpochSeconds / windowSeconds) * windowSeconds;

const utcBuckets = (epochSeconds) => {
  const date = new Date(epochSeconds * 1000);
  const iso = date.toISOString();
  return {
    minute: iso.slice(0, 16),
    day: iso.slice(0, 10),
    month: iso.slice(0, 7)
  };
};

/** DynamoDB adapter. `commands` is injected so application tests need no AWS SDK install. */
export class DynamoStore {
  constructor({ tableName, client, commands, quotaRetries = 12, sleep = pause, random = Math.random }) {
    this.tableName = tableName;
    this.client = client;
    this.commands = commands;
    this.quotaRetries = quotaRetries;
    this.sleep = sleep;
    this.random = random;
  }

  send(Command, input) {
    return this.client.send(new Command(input));
  }

  async getCache(key, consistent = false) {
    const result = await this.send(this.commands.GetCommand, {
      TableName: this.tableName,
      Key: { pk: key },
      ConsistentRead: consistent
    });
    return result.Item ?? null;
  }

  async tryAcquireLease({ key, owner, nowEpochSeconds, leaseSeconds, retainUntilEpochSeconds }) {
    try {
      await this.send(this.commands.UpdateCommand, {
        TableName: this.tableName,
        Key: { pk: key },
        UpdateExpression: 'SET #leaseOwner = :owner, #leaseUntil = :until, #expiresAt = :leaseExpiry',
        ConditionExpression: '(attribute_not_exists(#leaseUntil) OR #leaseUntil < :now OR #leaseOwner = :owner) AND (attribute_not_exists(#freshUntil) OR #freshUntil <= :now)',
        ExpressionAttributeNames: {
          '#leaseOwner': 'leaseOwner',
          '#leaseUntil': 'leaseUntil',
          '#expiresAt': 'expiresAt',
          '#freshUntil': 'freshUntil'
        },
        ExpressionAttributeValues: {
          ':owner': owner,
          ':until': nowEpochSeconds + leaseSeconds,
          ':now': nowEpochSeconds,
          ':leaseExpiry': Math.max(retainUntilEpochSeconds ?? 0, nowEpochSeconds + leaseSeconds + 60)
        }
      });
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async putCache({ key, owner, payload, negative, freshUntil, staleUntil }) {
    try {
      await this.send(this.commands.UpdateCommand, {
        TableName: this.tableName,
        Key: { pk: key },
        UpdateExpression: 'SET #payload = :payload, #negative = :negative, #freshUntil = :freshUntil, #staleUntil = :staleUntil, #expiresAt = :expiresAt REMOVE #leaseOwner, #leaseUntil',
        ConditionExpression: '#leaseOwner = :owner',
        ExpressionAttributeNames: {
          '#payload': 'payload',
          '#negative': 'negative',
          '#freshUntil': 'freshUntil',
          '#staleUntil': 'staleUntil',
          '#expiresAt': 'expiresAt',
          '#leaseOwner': 'leaseOwner',
          '#leaseUntil': 'leaseUntil'
        },
        ExpressionAttributeValues: {
          ':owner': owner,
          ':payload': payload,
          ':negative': negative,
          ':freshUntil': freshUntil,
          ':staleUntil': staleUntil,
          ':expiresAt': staleUntil + 3600
        }
      });
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async releaseLease({ key, owner }) {
    try {
      await this.send(this.commands.UpdateCommand, {
        TableName: this.tableName,
        Key: { pk: key },
        UpdateExpression: 'REMOVE #leaseOwner, #leaseUntil',
        ConditionExpression: '#leaseOwner = :owner',
        ExpressionAttributeNames: { '#leaseOwner': 'leaseOwner', '#leaseUntil': 'leaseUntil' },
        ExpressionAttributeValues: { ':owner': owner }
      });
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  /**
   * Atomically limits upstream-producing cache misses per short-lived client
   * fingerprint. The caller supplies a one-way HMAC, never a raw IP address.
   */
  async reserveClientUpstream({ fingerprint, limit, windowSeconds, nowEpochSeconds }) {
    const windowStart = clientWindowStart(nowEpochSeconds, windowSeconds);
    const windowEnd = windowStart + windowSeconds;
    try {
      await this.send(this.commands.UpdateCommand, {
        TableName: this.tableName,
        // The window length is part of the key: the 5-minute window opening at UTC
        // midnight shares its start with the daily window.
        Key: { pk: `CONTROL#CLIENT_UPSTREAM#${windowSeconds}#${windowStart}#${fingerprint}` },
        UpdateExpression: 'SET #expiresAt = :expiresAt, #windowStart = :windowStart ADD #count :one',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: {
          '#count': 'count',
          '#expiresAt': 'expiresAt',
          '#windowStart': 'windowStart'
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': limit,
          ':windowStart': windowStart,
          ':expiresAt': windowEnd + 3600
        }
      });
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, windowEnd - nowEpochSeconds)
      };
    }
  }

  /** Atomically consumes a rolling rate token and increments UTC day/month totals. */
  async reserveQuota({ limits, nowEpochSeconds }) {
    const requestedBuckets = utcBuckets(nowEpochSeconds);

    for (let attempt = 0; attempt < this.quotaRetries; attempt += 1) {
      const result = await this.send(this.commands.GetCommand, {
        TableName: this.tableName,
        Key: { pk: 'CONTROL#PROVIDER_QUOTA' },
        ConsistentRead: true
      });
      const current = result.Item ?? null;
      if (Number.isFinite(current?.cooldownUntil) && current.cooldownUntil > nowEpochSeconds) {
        return {
          allowed: false,
          deniedWindow: 'cooldown',
          cooldownUntil: current.cooldownUntil,
          retryAfterSeconds: Math.max(1, Math.ceil(current.cooldownUntil - nowEpochSeconds)),
          buckets: requestedBuckets
        };
      }

      const next = {};
      // Lambda clocks differ, so a reservation can carry an earlier time than the last
      // write. Never move the stored buckets or refill clock backward.
      const lastUpdatedAt = Number.isFinite(current?.rateUpdatedAt) ? current.rateUpdatedAt : null;
      if (limits.minute > 0) {
        const capacity = Number.isFinite(limits.burst)
          ? limits.burst
          : Math.max(1, Math.ceil(limits.minute / 4));
        const previouslyInitialized = Number.isFinite(current?.rateTokens) && Number.isFinite(current?.rateUpdatedAt);
        const priorTokens = previouslyInitialized ? current.rateTokens : capacity;
        const elapsedSeconds = previouslyInitialized
          ? Math.max(0, nowEpochSeconds - current.rateUpdatedAt)
          : 0;
        const availableTokens = Math.min(capacity, priorTokens + (elapsedSeconds * limits.minute / 60));
        if (availableTokens < 1) {
          return {
            allowed: false,
            deniedWindow: 'rate',
            retryAfterSeconds: Math.max(1, Math.ceil((1 - availableTokens) * 60 / limits.minute)),
            buckets: requestedBuckets
          };
        }
        next.rateTokens = availableTokens - 1;
        next.rateUpdatedAt = lastUpdatedAt === null ? nowEpochSeconds : Math.max(lastUpdatedAt, nowEpochSeconds);
      }

      for (const window of ['day', 'month']) {
        const limit = limits[window];
        if (!(limit > 0)) continue;
        const storedBucket = current?.[`${window}Bucket`];
        // ISO day/month strings sort chronologically; a newer stored bucket wins.
        const bucket = typeof storedBucket === 'string' && storedBucket > requestedBuckets[window]
          ? storedBucket
          : requestedBuckets[window];
        const count = storedBucket === bucket && Number.isSafeInteger(current?.[`${window}Count`])
          ? current[`${window}Count`]
          : 0;
        if (count >= limit) return { allowed: false, deniedWindow: window, buckets: requestedBuckets };
        next[`${window}Bucket`] = bucket;
        next[`${window}Count`] = count + 1;
      }

      if (Object.keys(next).length === 0) return { allowed: true, buckets: requestedBuckets };

      const expectedVersion = current?.version;
      const nextVersion = Number.isSafeInteger(expectedVersion) ? expectedVersion + 1 : 1;
      const names = { '#version': 'version', '#updatedAt': 'updatedAt' };
      const values = { ':nextVersion': nextVersion, ':updatedAt': nowEpochSeconds };
      const assignments = ['#version = :nextVersion', '#updatedAt = :updatedAt'];
      for (const [name, value] of Object.entries(next)) {
        names[`#${name}`] = name;
        values[`:${name}`] = value;
        assignments.push(`#${name} = :${name}`);
      }
      if (expectedVersion !== undefined) values[':expectedVersion'] = expectedVersion;

      try {
        await this.send(this.commands.UpdateCommand, {
          TableName: this.tableName,
          Key: { pk: 'CONTROL#PROVIDER_QUOTA' },
          UpdateExpression: `SET ${assignments.join(', ')}`,
          ConditionExpression: expectedVersion === undefined
            ? 'attribute_not_exists(#version)'
            : '#version = :expectedVersion',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values
        });
        return { allowed: true, buckets: requestedBuckets };
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
      // Every failed conditional write is still a billed write against the table's
      // ceiling; a short jittered pause stops concurrent misses retrying in lockstep.
      await this.sleep(Math.floor((5 + this.random() * 20) * (attempt + 1)));
    }
    throw new Error('quota_contention');
  }

  /**
   * A provider 429 opens a shared cooldown and increments the optimistic-lock
   * version so quota reservations read before the 429 cannot commit afterward.
   */
  async startProviderCooldown({ nowEpochSeconds, cooldownSeconds }) {
    const cooldownUntil = nowEpochSeconds + cooldownSeconds;
    try {
      await this.send(this.commands.UpdateCommand, {
        TableName: this.tableName,
        Key: { pk: 'CONTROL#PROVIDER_QUOTA' },
        UpdateExpression: 'SET #cooldownUntil = :cooldownUntil, #updatedAt = :updatedAt ADD #version :one',
        ConditionExpression: 'attribute_not_exists(#cooldownUntil) OR #cooldownUntil < :cooldownUntil',
        ExpressionAttributeNames: {
          '#cooldownUntil': 'cooldownUntil',
          '#updatedAt': 'updatedAt',
          '#version': 'version'
        },
        ExpressionAttributeValues: {
          ':cooldownUntil': cooldownUntil,
          ':updatedAt': nowEpochSeconds,
          ':one': 1
        }
      });
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }
}
