#!/usr/bin/env bash
# Block Clankers - sync your GitHub block lists against a community-maintained source.
#
# Supports multiple targets in one run:
#   @me      - personal account (/user/blocks)
#   @auto    - @me plus every org where the token's user is an admin
#   <name>   - a specific org (/orgs/<name>/blocks)
#
# Gentle on the GitHub API:
#   - Diffs source vs. current blocks per target; only writes the delta.
#   - Shared global throttle + write cap across all targets.
#   - Retries 429 / 403-secondary-limit / 5xx with Retry-After + exp backoff + jitter.
#   - Watches x-ratelimit-remaining and pauses until reset when nearly depleted.

set -euo pipefail

# ---- Inputs / defaults -------------------------------------------------------

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${SOURCE_URL:?SOURCE_URL is required}"
TARGETS="${TARGETS:-@me}"
DRY_RUN="${DRY_RUN:-false}"
UNBLOCK_REMOVED="${UNBLOCK_REMOVED:-false}"

WRITE_DELAY_MS="${WRITE_DELAY_MS:-1100}"
MAX_WRITES_PER_RUN="${MAX_WRITES_PER_RUN:-200}"
MAX_RETRIES="${MAX_RETRIES:-6}"
BASE_BACKOFF_SECS="${BASE_BACKOFF_SECS:-2}"
MAX_BACKOFF_SECS="${MAX_BACKOFF_SECS:-60}"
RATE_LIMIT_FLOOR="${RATE_LIMIT_FLOOR:-100}"
REQUEST_TIMEOUT_SECS="${REQUEST_TIMEOUT_SECS:-30}"

# ---- Preflight ---------------------------------------------------------------

for cmd in curl jq gh awk; do
  command -v "$cmd" >/dev/null || { echo "missing required command: $cmd" >&2; exit 1; }
done

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
headers="$tmpdir/headers"
wanted="$tmpdir/wanted.txt"

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

sleep_secs() { awk -v s="$1" 'BEGIN { system(sprintf("sleep %.3f", s)) }'; }
sleep_ms()   { awk -v ms="$1" 'BEGIN { system(sprintf("sleep %.3f", ms/1000)) }'; }

backoff_sleep() {
  local attempt="$1"
  local secs
  secs=$(awk -v b="$BASE_BACKOFF_SECS" -v a="$attempt" -v c="$MAX_BACKOFF_SECS" '
    BEGIN { v=b*(2^(a-1)); if(v>c) v=c; srand(); printf "%.2f", v+rand() }')
  log "  backoff sleep ${secs}s (attempt $attempt)"
  sleep_secs "$secs"
}

header_value() {
  local name="$1" file="$2"
  [ -s "$file" ] || return 0
  awk -v n="$name" 'BEGIN { IGNORECASE=1 }
       tolower($1)==tolower(n)":" { sub(/^[^:]+: */,""); sub(/\r$/,""); print; exit }' "$file"
}

respect_primary_rate_limit() {
  local remaining reset now sleep_for
  remaining="$(header_value 'x-ratelimit-remaining' "$headers" || true)"
  reset="$(header_value 'x-ratelimit-reset' "$headers" || true)"
  [ -z "$remaining" ] && return 0
  if [ "$remaining" -lt "$RATE_LIMIT_FLOOR" ]; then
    now=$(date +%s)
    sleep_for=$(( ${reset:-$now} - now + 5 ))
    [ $sleep_for -lt 1 ] && sleep_for=1
    [ $sleep_for -gt 900 ] && sleep_for=900
    log "  primary rate limit low ($remaining left); sleeping ${sleep_for}s until reset"
    sleep "$sleep_for"
  fi
}

# api_request METHOD PATH
# Returns 0 success, 2 skip (404/422), 1 terminal failure.
api_request() {
  local method="$1" path="$2"
  local attempt=0 status retry_after body

  while : ; do
    attempt=$((attempt + 1))
    : > "$headers"

    if body=$(GH_TOKEN="$GH_TOKEN" timeout "$REQUEST_TIMEOUT_SECS" \
                gh api -X "$method" "$path" --cache 0 -i 2>&1); then
      printf '%s\n' "$body" | awk 'BEGIN{h=1} /^\r?$/{h=0; next} h{print}' > "$headers"
      respect_primary_rate_limit
      return 0
    fi

    printf '%s\n' "$body" | awk 'BEGIN{h=1} /^\r?$/{h=0; next} h{print}' > "$headers" 2>/dev/null || true
    status=$(printf '%s\n' "$body" | awk 'NR==1 && /^HTTP\//{print $2; exit}')
    status="${status:-0}"

    case "$status" in
      404)
        log "  $method $path -> 404 (skip)"
        return 2 ;;
      422)
        log "  $method $path -> 422 (already in desired state)"
        return 0 ;;
      401|403)
        retry_after="$(header_value 'retry-after' "$headers" || true)"
        if [ -n "$retry_after" ]; then
          log "  $method $path -> $status, Retry-After=${retry_after}s"
          sleep "$retry_after"
        elif printf '%s' "$body" | grep -qi 'secondary rate limit'; then
          log "  $method $path -> $status secondary rate limit"
          backoff_sleep "$attempt"
        else
          log "  $method $path -> $status (auth/permission, not retrying)"
          printf '%s\n' "$body" | head -20 >&2
          return 1
        fi ;;
      429)
        retry_after="$(header_value 'retry-after' "$headers" || true)"
        if [ -n "$retry_after" ]; then
          log "  $method $path -> 429, Retry-After=${retry_after}s"
          sleep "$retry_after"
        else
          backoff_sleep "$attempt"
        fi ;;
      500|502|503|504)
        log "  $method $path -> $status (server error)"
        backoff_sleep "$attempt" ;;
      000|0)
        log "  $method $path -> network/timeout"
        backoff_sleep "$attempt" ;;
      *)
        log "  $method $path -> $status (unexpected)"
        printf '%s\n' "$body" | head -10 >&2
        backoff_sleep "$attempt" ;;
    esac

    if [ "$attempt" -ge "$MAX_RETRIES" ]; then
      log "  $method $path -> giving up after $attempt attempts"
      return 1
    fi
  done
}

# ---- Resolve targets ---------------------------------------------------------

resolve_targets() {
  local raw="$1"
  printf '%s\n' "$raw" \
    | tr ',' '\n' \
    | awk '{gsub(/^[[:space:]]+|[[:space:]]+$/,""); if (length) print}' \
    | sort -u
}

expand_targets() {
  local list="$1"
  local out="$tmpdir/targets.txt"
  : > "$out"
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    case "$t" in
      "@auto")
        echo "@me" >> "$out"
        log "Discovering orgs where the authenticated user is admin..."
        if ! gh api --paginate "/user/memberships/orgs?state=active" \
              -q '.[] | select(.role=="admin") | .organization.login' >> "$out" 2>/dev/null; then
          log "WARNING: could not enumerate orgs (token may lack read:org)"
        fi
        ;;
      "@me"|*)
        echo "$t" >> "$out"
        ;;
    esac
  done < <(printf '%s\n' "$list")
  awk 'NF' "$out" | sort -u
}

# blocks_endpoint TARGET -> path for GET (paginated) / PUT-DELETE base
blocks_endpoint() {
  local t="$1"
  if [ "$t" = "@me" ]; then echo "/user/blocks"; else echo "/orgs/$t/blocks"; fi
}

# ---- Fetch source list -------------------------------------------------------

log "Fetching source list from $SOURCE_URL"
if ! curl --fail --silent --show-error --location \
        --max-time "$REQUEST_TIMEOUT_SECS" \
        --retry 3 --retry-delay 2 --retry-all-errors \
        --user-agent "block-clankers-action" \
        "$SOURCE_URL" \
     | jq -e -r '
         if type != "array" then error("source is not a JSON array") else . end
         | .[] | select(.username) | .username
       ' \
     | awk 'NF' | sort -u > "$wanted"; then
  echo "Failed to fetch or parse source list" >&2
  exit 1
fi

wanted_count=$(wc -l < "$wanted" | tr -d ' ')
log "Source list has $wanted_count usernames"
if [ "$wanted_count" -eq 0 ]; then
  log "Source list is empty - refusing to proceed (likely upstream error)"
  exit 1
fi

# ---- Resolve & loop over targets --------------------------------------------

mapfile -t target_list < <(expand_targets "$(resolve_targets "$TARGETS")")
if [ "${#target_list[@]}" -eq 0 ]; then
  echo "No targets resolved from input: $TARGETS" >&2
  exit 1
fi
log "Targets: ${target_list[*]}"

{
  echo "## Block Clankers run"
  echo ""
  echo "| Field | Value |"
  echo "|---|---|"
  echo "| Source | $SOURCE_URL |"
  echo "| Source list size | $wanted_count |"
  echo "| Targets | ${target_list[*]} |"
  echo "| Dry run | $DRY_RUN |"
  echo "| Unblock removed | $UNBLOCK_REMOVED |"
  echo "| Write delay | ${WRITE_DELAY_MS}ms |"
  echo "| Cap per run | $MAX_WRITES_PER_RUN |"
} >> "$summary"

writes=0
total_blocked=0
total_unblocked=0
total_skipped=0
total_failed=0

do_write() {
  local method="$1" path="$2" target="$3" user="$4" verb past
  if [ "$method" = "PUT" ]; then verb="block"; past="blocked"; else verb="unblock"; past="unblocked"; fi

  if [ "$writes" -ge "$MAX_WRITES_PER_RUN" ]; then
    total_skipped=$((total_skipped + 1))
    return 0
  fi

  if [ "$DRY_RUN" = "true" ]; then
    log "[dry-run] would $verb $user on $target"
    return 0
  fi

  if api_request "$method" "$path"; then
    log "$past $user on $target"
    if [ "$method" = "PUT" ]; then total_blocked=$((total_blocked + 1));
                              else total_unblocked=$((total_unblocked + 1)); fi
  else
    rc=$?
    if [ "$rc" -eq 2 ]; then total_skipped=$((total_skipped + 1));
                        else total_failed=$((total_failed + 1)); fi
  fi

  writes=$((writes + 1))
  sleep_ms "$WRITE_DELAY_MS"
}

for target in "${target_list[@]}"; do
  endpoint="$(blocks_endpoint "$target")"
  log ""
  log "=== Target: $target ($endpoint) ==="

  current="$tmpdir/current_${target//[^a-zA-Z0-9_-]/_}.txt"
  if ! gh api --paginate "$endpoint" -q '.[].login' \
       | awk 'NF' | sort -u > "$current" 2>/dev/null; then
    log "WARNING: failed to list blocks for $target (insufficient scope?), skipping target"
    total_failed=$((total_failed + 1))
    continue
  fi

  to_block="$tmpdir/to_block_${target//[^a-zA-Z0-9_-]/_}.txt"
  to_unblock="$tmpdir/to_unblock_${target//[^a-zA-Z0-9_-]/_}.txt"
  comm -23 "$wanted" "$current" > "$to_block"
  comm -13 "$wanted" "$current" > "$to_unblock"

  block_count=$(wc -l < "$to_block" | tr -d ' ')
  unblock_count=$(wc -l < "$to_unblock" | tr -d ' ')
  current_count=$(wc -l < "$current" | tr -d ' ')

  log "currently blocked=$current_count  to_block=$block_count  to_unblock=$unblock_count"
  {
    echo ""
    echo "### $target"
    echo "- currently blocked: $current_count"
    echo "- to block: $block_count"
    echo "- to unblock: $unblock_count"
  } >> "$summary"

  while IFS= read -r user; do
    [ -z "$user" ] && continue
    do_write PUT "$endpoint/$user" "$target" "$user"
  done < "$to_block"

  if [ "$UNBLOCK_REMOVED" = "true" ]; then
    while IFS= read -r user; do
      [ -z "$user" ] && continue
      do_write DELETE "$endpoint/$user" "$target" "$user"
    done < "$to_unblock"
  fi
done

# ---- Report ------------------------------------------------------------------

{
  echo ""
  echo "### Totals"
  echo ""
  echo "- Blocked: $total_blocked"
  echo "- Unblocked: $total_unblocked"
  echo "- Skipped (cap/404): $total_skipped"
  echo "- Failed: $total_failed"
  echo "- Writes performed: $writes"
} >> "$summary"

log ""
log "Done. blocked=$total_blocked unblocked=$total_unblocked skipped=$total_skipped failed=$total_failed writes=$writes"

[ "$total_failed" -eq 0 ] || exit 1
