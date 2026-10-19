// Static imports so the SDK loads in the Lambda init phase, not the first invoke.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import * as documentModule from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoStore } from './dynamo-store.js';
import { ProviderClient } from './provider.js';
import { createWeatherService } from './service.js';

let runtime;

export function createSecretLoader({ client, GetSecretValueCommand, secretId, jsonField }) {
  let cachedKey;
  let inFlight;
  const load = async () => {
    if (cachedKey) return cachedKey;
    if (!inFlight) {
      inFlight = client.send(new GetSecretValueCommand({ SecretId: secretId })).then((result) => {
        let value = result.SecretString;
        if (!value && result.SecretBinary) value = Buffer.from(result.SecretBinary).toString('utf8');
        if (!value) throw new Error('Provider secret is empty');
        if (value.trim().startsWith('{')) value = JSON.parse(value)[jsonField];
        if (typeof value !== 'string' || !value.trim()) throw new Error('Provider API key is missing');
        cachedKey = value.trim();
        return cachedKey;
      }).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
  load.invalidate = (rejectedKey) => {
    // Do not let a late 401 from an older concurrent request erase a newer key.
    if (!rejectedKey || cachedKey === rejectedKey) cachedKey = undefined;
  };
  return load;
}

export function getRuntime(config) {
  if (!runtime) runtime = buildRuntime(config);
  return runtime;
}

// Fail a hung AWS call fast instead of holding a concurrency slot until the Lambda timeout.
const DYNAMO_CLIENT_OPTIONS = Object.freeze({
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 1500 }
});
const SECRETS_CLIENT_OPTIONS = Object.freeze({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 }
});

function buildRuntime(config) {
  const dynamoClient = documentModule.DynamoDBDocumentClient.from(
    new DynamoDBClient(DYNAMO_CLIENT_OPTIONS),
    { marshallOptions: { removeUndefinedValues: true } }
  );
  const store = new DynamoStore({
    tableName: config.tableName,
    client: dynamoClient,
    commands: documentModule
  });

  let apiKeyProvider = async () => config.inlineApiKey;
  if (!config.inlineApiKey) {
    apiKeyProvider = createSecretLoader({
      client: new SecretsManagerClient(SECRETS_CLIENT_OPTIONS),
      GetSecretValueCommand,
      secretId: config.secretId,
      jsonField: config.secretJsonField
    });
  }

  const provider = new ProviderClient({
    apiKeyProvider,
    baseUrl: config.providerBaseUrl,
    timeoutMs: config.upstreamTimeoutMs,
    maximumBytes: config.upstreamMaxBytes
  });
  return createWeatherService({ store, provider, config });
}
