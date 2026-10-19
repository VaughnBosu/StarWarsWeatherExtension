#!/usr/bin/env bash
# Shared defaults and AWS helpers for the backend operator scripts. Source only.

# Local operator settings (gitignored): AWS_PROFILE and BACKEND_AWS_ACCOUNT_ID.
lib_env_file="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)/.env"
if [[ -f "$lib_env_file" ]]; then
  # shellcheck source=/dev/null
  source "$lib_env_file"
fi

profile=${AWS_PROFILE:-default}
region=us-east-1
stack_name=star-wars-weather-prod
expected_account_id=${BACKEND_AWS_ACCOUNT_ID:-}

# Every script refuses other regions; the production stack lives in us-east-1.
require_us_east_1() {
  if [[ "$region" != us-east-1 ]]; then
    printf '%s\n' "${1:-Region must be us-east-1 for this operational stack.}" >&2
    exit 2
  fi
}

# Sets caller_account and refuses to continue against any other account.
require_backend_account() {
  local action=${1:-operation}
  if [[ -z "$expected_account_id" ]]; then
    printf 'Refusing %s: set BACKEND_AWS_ACCOUNT_ID in backend/.env.\n' "$action" >&2
    exit 2
  fi
  caller_account=$(aws sts get-caller-identity \
    --profile "$profile" --region "$region" --query Account --output text)
  if [[ "$caller_account" != "$expected_account_id" ]]; then
    printf 'Refusing %s: profile %s resolves to account %s, expected %s.\n' \
      "$action" "$profile" "$caller_account" "$expected_account_id" >&2
    exit 2
  fi
}

# Prints one describe-stacks response so callers can read several outputs from a single call.
describe_stack_json() {
  aws cloudformation describe-stacks \
    --profile "$profile" --region "$region" --stack-name "$1" --output json
}

# stack_output STACK_JSON KEY: prints the output value, or nothing when absent.
stack_output() {
  node -e '
    const [json, key] = process.argv.slice(1);
    const outputs = JSON.parse(json).Stacks?.[0]?.Outputs ?? [];
    const match = outputs.find((output) => output.OutputKey === key);
    if (match?.OutputValue) process.stdout.write(match.OutputValue);
  ' "$1" "$2"
}

# stack_parameter STACK_JSON KEY: prints the deployed parameter value, or nothing when absent.
stack_parameter() {
  node -e '
    const [json, key] = process.argv.slice(1);
    const parameters = JSON.parse(json).Stacks?.[0]?.Parameters ?? [];
    const match = parameters.find((parameter) => parameter.ParameterKey === key);
    if (match?.ParameterValue) process.stdout.write(match.ParameterValue);
  ' "$1" "$2"
}
