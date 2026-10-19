#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
# shellcheck source=lib.sh
source "$script_dir/lib.sh"
hours=24
infra_queries="$script_dir/../infra/backend-metric-queries.json"

usage() {
  cat <<'EOF'
Usage: backend-status.sh [--profile NAME] [--region us-east-1] [--stack NAME] [--hours N]

Shows deployment/alarm state and exact gateway/backend/cache/provider totals and rates.
Also shows deployed HTTP API throttles and privacy-safe gateway outcomes.
EOF
}

while (($#)); do
  case "$1" in
    --profile) profile=${2:?missing profile}; shift 2 ;;
    --region) region=${2:?missing region}; shift 2 ;;
    --stack) stack_name=${2:?missing stack}; shift 2 ;;
    --hours) hours=${2:?missing hours}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

require_us_east_1 'Region must be us-east-1.'
if [[ ! "$hours" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Hours must be a positive integer.\n' >&2
  exit 2
fi
require_backend_account 'status request'

# One describe call feeds the summary, the alarm prefix, and every output read below.
stack_json=$(describe_stack_json "$stack_name")

printf 'Stack and outputs\n'
node - "$stack_json" <<'NODE'
const stack = JSON.parse(process.argv[2]).Stacks?.[0] ?? {};
console.log(`${'Status'.padEnd(28)} ${stack.StackStatus ?? 'unknown'}`);
console.log(`${'Updated'.padEnd(28)} ${stack.LastUpdatedTime ?? stack.CreationTime ?? 'unknown'}`);
for (const output of stack.Outputs ?? []) {
  console.log(`${output.OutputKey.padEnd(28)} ${output.OutputValue}`);
}
NODE

# Alarm names come from the stack's ProjectName/Environment parameters.
alarm_prefix="$(stack_parameter "$stack_json" ProjectName)-$(stack_parameter "$stack_json" Environment)-"
printf '\nAlarms\n'
aws cloudwatch describe-alarms \
  --profile "$profile" --region "$region" \
  --alarm-name-prefix "$alarm_prefix" \
  --query 'MetricAlarms[].{Alarm:AlarmName,State:StateValue,Reason:StateReason}' --output table

http_api_log_group=
http_api_id=$(stack_output "$stack_json" HttpApiId)
if [[ -z "$http_api_id" ]]; then
  printf 'HTTP API stack did not return HttpApiId.\n' >&2
  exit 1
fi
stage_json=$(aws apigatewayv2 get-stage \
  --profile "$profile" --region "$region" \
  --api-id "$http_api_id" --stage-name '$default' --output json)
printf '\nHTTP API default-stage and per-route throttles\n'
node - "$stage_json" <<'NODE'
const stage = JSON.parse(process.argv[2]);
console.log(JSON.stringify({ Default: stage.DefaultRouteSettings, Routes: stage.RouteSettings }, null, 2));
NODE
http_api_log_group_arn=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).AccessLogSettings?.DestinationArn ?? "")' "$stage_json")
if [[ -n "$http_api_log_group_arn" ]]; then
  http_api_log_group=${http_api_log_group_arn#*:log-group:}
  http_api_log_group=${http_api_log_group%:*}
fi

end_time=$(node -e 'process.stdout.write(new Date().toISOString())')
start_time=$(node -e "process.stdout.write(new Date(Date.now()-(${hours}*60*60*1000)).toISOString())")
metric_output=$(mktemp "${TMPDIR:-/tmp}/star-wars-weather-metrics.XXXXXX")
log_query_output=$(mktemp "${TMPDIR:-/tmp}/star-wars-weather-log-query.XXXXXX")
gateway_log_query_output=$(mktemp "${TMPDIR:-/tmp}/star-wars-weather-gateway-log-query.XXXXXX")
cleanup() { rm -f -- "$metric_output" "$log_query_output" "$gateway_log_query_output"; }
trap cleanup EXIT

gateway_metric_total() {
  aws cloudwatch get-metric-statistics \
    --profile "$profile" --region "$region" \
    --namespace AWS/ApiGateway --metric-name "$1" \
    --dimensions "Name=ApiId,Value=$http_api_id" 'Name=Stage,Value=$default' \
    --start-time "$start_time" --end-time "$end_time" \
    --period 3600 --statistics Sum \
    --query 'sum(Datapoints[].Sum)' --output text
}
gateway_requests=$(gateway_metric_total Count)
gateway_4xx=$(gateway_metric_total 4xx)
gateway_5xx=$(gateway_metric_total 5xx)
printf '\nHTTP API native totals and percentages (%s hours)\n' "$hours"
node - "$gateway_requests" "$gateway_4xx" "$gateway_5xx" <<'NODE'
const [requests, client4xx, server5xx] = process.argv.slice(2).map((value) => Number(value) || 0);
const pct = (numerator) => requests > 0 ? `${(100 * numerator / requests).toFixed(3)}%` : 'n/a';
for (const [label, value] of [
  ['Gateway requests', requests],
  ['Gateway 4xx', client4xx],
  ['Gateway 5xx', server5xx],
  ['Gateway 4xx %', pct(client4xx)],
  ['Gateway 5xx %', pct(server5xx)]
]) console.log(`${label.padEnd(28)} ${value}`);
NODE

aws cloudwatch get-metric-data \
  --profile "$profile" --region "$region" \
  --start-time "$start_time" --end-time "$end_time" \
  --scan-by TimestampDescending \
  --metric-data-queries "file://$infra_queries" \
  --output json > "$metric_output"

printf '\nExact backend totals and percentages (%s hours)\n' "$hours"
node - "$metric_output" <<'NODE'
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const totals = Object.fromEntries(input.MetricDataResults.map((result) => [
  result.Id,
  (result.Values ?? []).reduce((sum, value) => sum + value, 0)
]));
const pct = (numerator, denominator) => denominator > 0
  ? `${(100 * numerator / denominator).toFixed(3)}%`
  : 'n/a';
const rows = [
  ['Backend requests', totals.backend ?? 0],
  ['Fresh cache hits', totals.fresh ?? 0],
  ['Stale responses served', totals.stale ?? 0],
  ['Upstream attempts', totals.attempts ?? 0],
  ['Upstream successes', totals.success ?? 0],
  ['Provider 429 responses', totals.provider429 ?? 0],
  ['Provider auth denials', totals.authDenied ?? 0],
  ['Provider-budget refusals', totals.budgetRefused ?? 0]
];
for (const [label, value] of rows) console.log(`${label.padEnd(28)} ${value}`);
console.log(`${'Provider 429 %'.padEnd(28)} ${pct(totals.provider429 ?? 0, totals.attempts ?? 0)}`);
console.log(`${'Provider auth denied %'.padEnd(28)} ${pct(totals.authDenied ?? 0, totals.attempts ?? 0)}`);
console.log(`${'Provider success %'.padEnd(28)} ${pct(totals.success ?? 0, totals.attempts ?? 0)}`);
console.log(`${'Fresh cache / backend %'.padEnd(28)} ${pct(totals.fresh ?? 0, totals.backend ?? 0)}`);
console.log(`${'Budget refused %'.padEnd(28)} ${pct(totals.budgetRefused ?? 0, (totals.attempts ?? 0) + (totals.budgetRefused ?? 0))}`);
NODE

start_epoch=$(node -e 'process.stdout.write(String(Math.floor(Date.parse(process.argv[1]) / 1000)))' "$start_time")
end_epoch=$(node -e 'process.stdout.write(String(Math.floor(Date.parse(process.argv[1]) / 1000)))' "$end_time")

# run_logs_query LOG_GROUP QUERY_STRING OUTPUT_FILE
# Starts one Logs Insights query and polls it for up to 15 seconds. Prints the final
# query status; returns non-zero when the query could not even be started.
run_logs_query() {
  local log_group=$1 query_string=$2 output_file=$3 query_id status=Scheduled
  query_id=$(aws logs start-query \
    --profile "$profile" --region "$region" \
    --log-group-name "$log_group" \
    --start-time "$start_epoch" --end-time "$end_epoch" \
    --query-string "$query_string" --query queryId --output text 2>/dev/null) || return 1
  for _ in {1..15}; do
    if ! aws logs get-query-results \
      --profile "$profile" --region "$region" --query-id "$query_id" \
      --output json > "$output_file"; then
      status=Failed
      break
    fi
    status=$(node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.status)' "$output_file")
    [[ "$status" == Complete ]] && break
    case "$status" in Failed|Cancelled|Timeout|Unknown) break ;; esac
    sleep 1
  done
  printf '%s' "$status"
}

gateway_query='fields status, integrationStatus, gatewayResponseType | stats count(*) as requests by status, integrationStatus, gatewayResponseType'
if [[ -n "$http_api_log_group" ]] && \
  gateway_query_status=$(run_logs_query "$http_api_log_group" "$gateway_query" "$gateway_log_query_output"); then
  if [[ "$gateway_query_status" == Complete ]]; then
    printf '\nExact status-only gateway outcomes (%s hours)\n' "$hours"
    node - "$gateway_log_query_output" <<'NODE'
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let requests = 0, client4xx = 0, server5xx = 0, gateway429 = 0;
for (const fields of input.results ?? []) {
  const row = Object.fromEntries(fields.map(({ field, value }) => [field, value]));
  const count = Number(row.requests) || 0;
  const status = Number(row.status) || 0;
  const integrationStatus = row.integrationStatus;
  const gatewayGenerated = !integrationStatus || integrationStatus === '-';
  requests += count;
  if (status >= 400 && status < 500) client4xx += count;
  if (status >= 500) server5xx += count;
  if (status === 429 && gatewayGenerated) gateway429 += count;
}
const pct = (numerator) => requests > 0 ? `${(100 * numerator / requests).toFixed(3)}%` : 'n/a';
for (const [label, value] of [
  ['Status-log requests', requests],
  ['All 4xx responses', client4xx],
  ['All 5xx responses', server5xx],
  ['Gateway-generated 429', gateway429],
  ['All 4xx %', pct(client4xx)],
  ['All 5xx %', pct(server5xx)],
  ['Gateway-generated 429 %', pct(gateway429)]
]) console.log(`${label.padEnd(28)} ${value}`);
NODE
  else
    printf '\nGateway status-log query did not complete (status: %s).\n' "$gateway_query_status" >&2
  fi
else
  printf '\nGateway status-log totals unavailable (access log may be new).\n' >&2
fi

backend_log_group=$(stack_output "$stack_json" BackendLogGroupName)
client_query='fields BackendRequest, BackendRejectedRequest, ClientErrorResponse, ServerErrorResponse, ClientUpstreamReservation, ClientUpstreamRateRefused, ClientRateStoreError, ClientIdentityMissing | stats sum(BackendRequest) as backendRequests, sum(BackendRejectedRequest) as backendRejected, sum(ClientErrorResponse) as clientErrors, sum(ServerErrorResponse) as serverErrors, sum(ClientUpstreamReservation) as clientRateAllowed, sum(ClientUpstreamRateRefused) as clientRateRefused, sum(ClientRateStoreError) as clientRateStoreErrors, sum(ClientIdentityMissing) as clientIdentityMissing'
if [[ -n "$backend_log_group" ]] && \
  query_status=$(run_logs_query "$backend_log_group" "$client_query" "$log_query_output"); then
  if [[ "$query_status" == Complete ]]; then
    printf '\nExact backend rejection and client-limiter outcomes (%s hours)\n' "$hours"
    node - "$log_query_output" <<'NODE'
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const row = Object.fromEntries((input.results?.[0] ?? []).map(({ field, value }) => [field, value]));
const value = (field) => Number(row[field]) || 0;
const backendRequests = value('backendRequests');
const clientDecisions = value('clientRateAllowed') + value('clientRateRefused');
const pct = (numerator, denominator) => denominator > 0
  ? `${(100 * numerator / denominator).toFixed(3)}%`
  : 'n/a';
for (const [label, output] of [
  ['Backend requests', backendRequests],
  ['Backend validation rejects', value('backendRejected')],
  ['Backend client-error replies', value('clientErrors')],
  ['Backend server-error replies', value('serverErrors')],
  ['Client miss-limit allowed', value('clientRateAllowed')],
  ['Client miss-limit refusals', value('clientRateRefused')],
  ['Client rate-store errors', value('clientRateStoreErrors')],
  ['Missing client identities', value('clientIdentityMissing')],
  ['Backend validation reject %', pct(value('backendRejected'), backendRequests)],
  ['Backend client-error %', pct(value('clientErrors'), backendRequests)],
  ['Backend server-error %', pct(value('serverErrors'), backendRequests)],
  ['Client miss-limit refusal %', pct(value('clientRateRefused'), clientDecisions)]
]) console.log(`${label.padEnd(30)} ${output}`);
NODE
  else
    printf '\nClient limiter Logs Insights query did not complete (status: %s).\n' "$query_status" >&2
  fi
else
  printf '\nClient limiter Logs Insights totals unavailable (log group may be new).\n' >&2
fi
