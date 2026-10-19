# Backend

The extension uses a small Lambda API for weather and location requests. It keeps the provider key out of the extension and shares recent results between users.

## Routes

```text
GET /v1/weather?lat=42.332&lon=-83.046
GET /v1/locations/reverse?lat=42.33&lon=-83.05
GET /v1/locations/search?q=Detroit%2C%20MI&limit=5
```

Weather is cached for 20 minutes and can fall back to a recent result when the provider is unavailable. Place lookups are cached longer. Request limits and a refresh lease prevent one client or a burst of identical requests from exhausting the provider quota: each source IP gets a short-window and a UTC-day budget of cache misses. Once the shared daily or monthly provider budget is spent, each warm Lambda container refuses misses until the budget resets or a stack update replaces the container.

The extension calls the backend at most about once an hour per user (sooner after travel, or 15 minutes after a stale result) and backs off across tabs when the API returns 429/5xx with `Retry-After`.

## Development

Run the backend tests from the repository root:

```sh
bun test backend/tests
```

The runtime settings are in `src/config.js`; production defaults are in `infra/template.yaml`.

## Deployment

The helper packages the Lambda, updates the CloudFormation stacks, preserves the existing provider secret, and runs a smoke test.

```sh
backend/scripts/deploy-backend.sh --provider-key-file /absolute/path/to/provider-key.txt
```

For an existing deployment:

```sh
backend/scripts/deploy-backend.sh --reuse-retained-provider-key
backend/scripts/backend-status.sh --hours 24
```

The scripts read `AWS_PROFILE` and `BACKEND_AWS_ACCOUNT_ID` from `backend/.env` (gitignored) and refuse to run against any other account:

```sh
AWS_PROFILE=your-profile
BACKEND_AWS_ACCOUNT_ID=123456789012
```

Both scripts accept `--profile`, `--region`, and `--stack` options. Run either script with `--help` for the full list.
