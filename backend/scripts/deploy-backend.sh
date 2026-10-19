#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
backend_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
infra_dir="$backend_dir/infra"
# shellcheck source=lib.sh
source "$script_dir/lib.sh"

bootstrap_stack=star-wars-weather-artifacts
alert_email=
provider_key_file=
reuse_retained_provider_key=false
skip_smoke_test=false
cors_origins=('*')
cors_origins_explicit=false
client_rate_pepper=

usage() {
  cat <<'EOF'
Usage: deploy-backend.sh [options]

Options:
  --profile NAME             AWS profile (default: $AWS_PROFILE, else default)
  --region REGION            Must be us-east-1 for this operational stack
  --stack NAME               Main stack name
  --bootstrap-stack NAME     Artifact bucket stack name
  --cors-origin ORIGIN       Exact HTTP API CORS origin; repeat as needed
                             (default: * for browser-extension origins)
  --alert-email EMAIL        Optional SNS alarm email (confirmation required)
  --provider-key-file FILE   File containing only the upstream key
  --reuse-retained-provider-key
                             Keep the populated secret from an existing stack
  --skip-smoke-test          Do not make the public smoke requests after deploy
  -h, --help                 Show this help

Provider-key options are mutually exclusive. If all are omitted, the script
securely prompts on /dev/tty. Reusing a retained key requires an existing stack.
The key is sent to Secrets Manager from a file, never as a CloudFormation
parameter or command-line value.
EOF
}

while (($#)); do
  case "$1" in
    --profile) profile=${2:?missing profile}; shift 2 ;;
    --region) region=${2:?missing region}; shift 2 ;;
    --stack) stack_name=${2:?missing stack}; shift 2 ;;
    --bootstrap-stack) bootstrap_stack=${2:?missing bootstrap stack}; shift 2 ;;
    --cors-origin)
      if [[ "$cors_origins_explicit" == false ]]; then
        cors_origins=()
        cors_origins_explicit=true
      fi
      cors_origins+=("${2:?missing CORS origin}")
      shift 2
      ;;
    --alert-email) alert_email=${2:?missing email}; shift 2 ;;
    --provider-key-file) provider_key_file=${2:?missing provider key file}; shift 2 ;;
    --reuse-retained-provider-key) reuse_retained_provider_key=true; shift ;;
    --skip-smoke-test) skip_smoke_test=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

require_us_east_1 "Refusing region $region: this operational stack is fixed to us-east-1."

if ((${#cors_origins[@]} == 0)); then
  printf 'At least one --cors-origin value is required.\n' >&2
  exit 2
fi
for origin in "${cors_origins[@]}"; do
  if [[ "$origin" == '*' ]]; then
    if ((${#cors_origins[@]} != 1)); then
      printf 'Wildcard CORS origin cannot be combined with exact origins.\n' >&2
      exit 2
    fi
  elif [[ ! "$origin" =~ ^(https?|chrome-extension|moz-extension)://[^/[:space:],]+$ ]]; then
    printf 'Invalid exact CORS origin: %s\n' "$origin" >&2
    exit 2
  fi
done
cors_origins_parameter=$(IFS=,; printf '%s' "${cors_origins[*]}")

temporary_key_file=
cleanup() {
  unset client_rate_pepper
  if [[ -n "$temporary_key_file" && -f "$temporary_key_file" ]]; then
    rm -f -- "$temporary_key_file"
  fi
}
trap cleanup EXIT

credential_option_count=0
if [[ -n "$provider_key_file" ]]; then
  credential_option_count=$((credential_option_count + 1))
fi
if [[ "$reuse_retained_provider_key" == true ]]; then
  credential_option_count=$((credential_option_count + 1))
fi
if (( credential_option_count > 1 )); then
  printf '%s\n' 'Provider-key options are mutually exclusive.' >&2
  exit 2
fi

if [[ "$reuse_retained_provider_key" == true ]]; then
  provider_key_file=
elif [[ -n "$provider_key_file" ]]; then
  if [[ ! -s "$provider_key_file" ]]; then
    printf 'Provider key file is missing or empty: %s\n' "$provider_key_file" >&2
    exit 2
  fi
else
  if [[ ! -r /dev/tty ]]; then
    printf 'No interactive terminal; pass --provider-key-file or --reuse-retained-provider-key.\n' >&2
    exit 2
  fi
  printf 'Upstream API key (hidden): ' > /dev/tty
  IFS= read -r -s provider_key < /dev/tty
  printf '\n' > /dev/tty
  if [[ -z "$provider_key" ]]; then
    printf 'Provider key cannot be empty.\n' >&2
    exit 2
  fi
  temporary_key_file=$(mktemp "${TMPDIR:-/tmp}/star-wars-weather-provider-key.XXXXXX")
  chmod 600 "$temporary_key_file"
  printf '%s' "$provider_key" > "$temporary_key_file"
  unset provider_key
  provider_key_file=$temporary_key_file
fi

require_backend_account deployment

if [[ "$reuse_retained_provider_key" == true ]]; then
  if ! existing_stack_json=$(describe_stack_json "$stack_name" 2>/dev/null); then
    printf '%s\n' '--reuse-retained-provider-key requires an existing deployed stack.' >&2
    exit 2
  fi
  retained_provider_secret_arn=$(stack_output "$existing_stack_json" ProviderSecretArn)
  if [[ -z "$retained_provider_secret_arn" ]]; then
    printf '%s\n' 'Existing stack did not return ProviderSecretArn.' >&2
    exit 2
  fi
  if ! aws secretsmanager get-secret-value \
    --profile "$profile" --region "$region" \
    --secret-id "$retained_provider_secret_arn" \
    --query VersionId --output text >/dev/null; then
    printf '%s\n' 'The retained provider secret has no readable current value.' >&2
    exit 2
  fi
fi

printf 'Deploying bootstrap stack %s in account %s (%s)...\n' "$bootstrap_stack" "$caller_account" "$region"
aws cloudformation deploy \
  --profile "$profile" \
  --region "$region" \
  --stack-name "$bootstrap_stack" \
  --template-file "$infra_dir/bootstrap.yaml" \
  --no-fail-on-empty-changeset \
  --tags Project=star-wars-weather Environment=prod ManagedBy=CloudFormation

artifact_bucket=$(stack_output "$(describe_stack_json "$bootstrap_stack")" ArtifactBucketName)
if [[ -z "$artifact_bucket" ]]; then
  printf 'Bootstrap stack did not return ArtifactBucketName.\n' >&2
  exit 1
fi

artifact_path="$infra_dir/dist/star-wars-weather-backend.zip"
"$script_dir/package-backend.sh" "$artifact_path"
artifact_hash=$(shasum -a 256 "$artifact_path" | awk '{print $1}')
artifact_key="lambda/$artifact_hash.zip"

printf 'Uploading content-addressed artifact s3://%s/%s...\n' "$artifact_bucket" "$artifact_key"
aws s3 cp "$artifact_path" "s3://$artifact_bucket/$artifact_key" \
  --profile "$profile" --region "$region" --only-show-errors

parameter_overrides=(
  "ArtifactBucket=$artifact_bucket"
  "ArtifactKey=$artifact_key"
  "CorsAllowedOrigins=$cors_origins_parameter"
  # Passed explicitly: `cloudformation deploy` keeps a parameter's previous value
  # even when the template default changes.
  "DynamoMaxReadRequestUnits=25"
  "DynamoMaxWriteRequestUnits=40"
  "ClientUpstreamLimit=60"
  "ClientUpstreamWindowSeconds=300"
  "ClientUpstreamDailyLimit=300"
  "HttpApiStageRateLimit=0.5"
  "HttpApiStageBurstLimit=5"
  "HttpApiWeatherRateLimit=5"
  "HttpApiWeatherBurstLimit=6"
  "HttpApiReverseRateLimit=1"
  "HttpApiReverseBurstLimit=2"
  "HttpApiSearchRateLimit=0.5"
  "HttpApiSearchBurstLimit=2"
)
if [[ -n "$alert_email" ]]; then
  parameter_overrides+=("AlertEmail=$alert_email")
fi

# New client-bucket hashing pepper on every deployment (NoEcho, never printed).
client_rate_pepper=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
if [[ ! "$client_rate_pepper" =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Could not generate a valid client rate-limit pepper.\n' >&2
  exit 1
fi
parameter_overrides+=("ClientRatePepper=$client_rate_pepper")

printf 'Deploying backend stack %s...\n' "$stack_name"
aws cloudformation deploy \
  --profile "$profile" \
  --region "$region" \
  --stack-name "$stack_name" \
  --template-file "$infra_dir/template.yaml" \
  --s3-bucket "$artifact_bucket" \
  --s3-prefix cloudformation \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${parameter_overrides[@]}" \
  --no-fail-on-empty-changeset \
  --tags Project=star-wars-weather Environment=prod ManagedBy=CloudFormation
unset client_rate_pepper

# The API hostname cannot be recreated once deleted.
aws cloudformation update-termination-protection \
  --profile "$profile" --region "$region" \
  --stack-name "$stack_name" \
  --enable-termination-protection >/dev/null

deployed_stack_json=$(describe_stack_json "$stack_name")
provider_secret_arn=$(stack_output "$deployed_stack_json" ProviderSecretArn)
api_base_url=$(stack_output "$deployed_stack_json" ApiBaseUrl)
dashboard_url=$(stack_output "$deployed_stack_json" DashboardUrl)

if [[ "$reuse_retained_provider_key" == true ]]; then
  if [[ "$provider_secret_arn" != "$retained_provider_secret_arn" ]]; then
    printf '%s\n' 'Provider secret identity changed unexpectedly; refusing to continue.' >&2
    exit 1
  fi
  printf 'Preserved retained Secrets Manager credential.\n'
else
  printf 'Seeding retained Secrets Manager credential...\n'
  aws secretsmanager put-secret-value \
    --profile "$profile" --region "$region" \
    --secret-id "$provider_secret_arn" \
    --secret-string "file://$provider_key_file" \
    --query VersionId --output text >/dev/null
fi

if [[ "$skip_smoke_test" == false ]]; then
  printf 'Checking HTTP API CORS preflight...\n'
  smoke_origin=${cors_origins[0]}
  [[ "$smoke_origin" == '*' ]] && smoke_origin=chrome-extension://hjphhfkijdmkgknigodnakpeemgcdlka
  curl --fail-with-body --silent --show-error \
    --request OPTIONS \
    --header "Origin: $smoke_origin" \
    --header 'Access-Control-Request-Method: GET' \
    "$api_base_url/v1/weather" >/dev/null
  printf 'Running one public weather smoke request...\n'
  curl --fail-with-body --silent --show-error \
    --retry 3 --retry-all-errors --retry-delay 2 \
    "$api_base_url/v1/weather?lat=42.3319&lon=-83.0458" >/dev/null

  # A random open-ocean cell is almost always a cache miss, so this reaches the
  # provider and fails when the stored key is wrong.
  probe_lat=$(printf '%d.%02d' $((RANDOM % 20 - 10)) $((RANDOM % 100)))
  probe_lon=$(printf -- '-%d.%02d' $((RANDOM % 20 + 140)) $((RANDOM % 100)))
  printf 'Checking the provider key with an uncached weather cell...\n'
  curl --fail-with-body --silent --show-error \
    --retry 2 --retry-delay 6 \
    "$api_base_url/v1/weather?lat=$probe_lat&lon=$probe_lon" >/dev/null
fi

printf '\nDeployment complete.\nAPI: %s\nDashboard: %s\n' "$api_base_url" "$dashboard_url"
