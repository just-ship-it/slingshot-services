#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Slingshot Services - Selective Deployment Tool
#
# Diffs changes since the last deploy, maps them to affected Sevalla services,
# and triggers redeploys only where needed.
#
# Usage:
#   ./deploy.sh                    # Auto-detect changes, deploy affected services
#   ./deploy.sh --dry-run          # Show what would be deployed without doing it
#   ./deploy.sh --services svc1,svc2  # Force deploy specific services
#   ./deploy.sh --all              # Deploy all services
#   ./deploy.sh --restart          # Restart without rebuild (uses last build artifact)
#   ./deploy.sh --since <commit>   # Diff from a specific commit instead of last deploy
#   ./deploy.sh --status           # Show deploy status (last deploy, pending changes)
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/deploy.config.json"
LAST_DEPLOY_FILE="$SCRIPT_DIR/.last-deploy"
SEVALLA_API="https://api.sevalla.com/v3"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Defaults
DRY_RUN=false
FORCE_SERVICES=""
DEPLOY_ALL=false
IS_RESTART=false
SINCE_COMMIT=""
SHOW_STATUS=false
PUSH_CODE=true
NO_PUSH=false

# ----------------------------------------------------------------------------
# Parse arguments
# ----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)     DRY_RUN=true; shift ;;
    --services)    FORCE_SERVICES="$2"; shift 2 ;;
    --all)         DEPLOY_ALL=true; shift ;;
    --restart)     IS_RESTART=true; shift ;;
    --since)       SINCE_COMMIT="$2"; shift 2 ;;
    --status)      SHOW_STATUS=true; shift ;;
    --no-push)     NO_PUSH=true; shift ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# ====/p' "$0" | grep -v '# ====' | sed 's/^# //'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Run ./deploy.sh --help for usage"
      exit 1
      ;;
  esac
done

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
log()    { echo -e "${BLUE}▸${NC} $*"; }
ok()     { echo -e "${GREEN}✓${NC} $*"; }
warn()   { echo -e "${YELLOW}⚠${NC} $*"; }
err()    { echo -e "${RED}✗${NC} $*"; }
header() { echo -e "\n${BOLD}$*${NC}"; }

read_config() {
  local key="$1"
  python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    c = json.load(f)
keys = '$key'.split('.')
val = c
for k in keys:
    if isinstance(val, dict):
        val = val.get(k, '')
    else:
        val = ''
        break
if isinstance(val, list):
    print('\n'.join(val))
elif isinstance(val, dict):
    print('\n'.join(val.keys()))
else:
    print(val)
" 2>/dev/null
}

get_service_app_id() {
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    c = json.load(f)
print(c.get('services', {}).get('$1', {}).get('app_id', ''))
" 2>/dev/null
}

get_service_dirs() {
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    c = json.load(f)
dirs = c.get('services', {}).get('$1', {}).get('directories', [])
print('\n'.join(dirs))
" 2>/dev/null
}

get_ignore_patterns() {
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    c = json.load(f)
print('\n'.join(c.get('ignore_patterns', [])))
" 2>/dev/null
}

get_shared_dirs() {
  python3 -c "
import json
with open('$CONFIG_FILE') as f:
    c = json.load(f)
print('\n'.join(c.get('shared_directories', [])))
" 2>/dev/null
}

get_all_services() {
  read_config "services"
}

# Check if a file matches any ignore pattern
is_ignored() {
  local file="$1"
  local patterns
  patterns=$(get_ignore_patterns)
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    # Handle glob patterns
    if [[ "$pattern" == */ ]]; then
      # Directory pattern
      [[ "$file" == ${pattern}* ]] && return 0
    elif [[ "$pattern" == *.* ]]; then
      # Extension/file pattern
      case "$file" in
        $pattern) return 0 ;;
      esac
    else
      [[ "$file" == "$pattern" || "$file" == "$pattern/"* ]] && return 0
    fi
  done <<< "$patterns"
  return 1
}

# ----------------------------------------------------------------------------
# Validate prerequisites
# ----------------------------------------------------------------------------
if [[ ! -f "$CONFIG_FILE" ]]; then
  err "Config file not found: $CONFIG_FILE"
  exit 1
fi

# Get API key
API_KEY_ENV=$(read_config "sevalla_api_key_env")
API_KEY="${!API_KEY_ENV:-}"

if [[ -z "$API_KEY" && "$DRY_RUN" == false && "$SHOW_STATUS" == false ]]; then
  warn "No Sevalla API key found in \$$API_KEY_ENV"
  warn "Set it with: export SEVALLA_API_KEY=your_key_here"
  warn "Continuing in dry-run mode..."
  DRY_RUN=true
fi

# ----------------------------------------------------------------------------
# Determine the base commit to diff from
# ----------------------------------------------------------------------------
get_base_commit() {
  if [[ -n "$SINCE_COMMIT" ]]; then
    echo "$SINCE_COMMIT"
    return
  fi

  if [[ -f "$LAST_DEPLOY_FILE" ]]; then
    cat "$LAST_DEPLOY_FILE"
    return
  fi

  # Fallback: diff the last push to production
  local remote
  remote=$(read_config "git_remote")
  local prod_branch
  prod_branch=$(read_config "production_branch")

  local prod_ref="${remote}/${prod_branch}"
  if git rev-parse --verify "$prod_ref" &>/dev/null; then
    git rev-parse "$prod_ref"
    return
  fi

  err "No base commit found. Use --since <commit> to specify one, or deploy --all first."
  exit 1
}

# ----------------------------------------------------------------------------
# Map changed files to affected services
# ----------------------------------------------------------------------------
map_changes_to_services() {
  local base_commit="$1"
  local changed_files
  changed_files=$(git diff --name-only "$base_commit"..HEAD 2>/dev/null || true)

  if [[ -z "$changed_files" ]]; then
    echo ""
    return
  fi

  local affected_services=()
  local shared_changed=false
  local shared_dirs
  shared_dirs=$(get_shared_dirs)

  # Check if shared directories were modified
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    is_ignored "$file" && continue
    while IFS= read -r sdir; do
      [[ -z "$sdir" ]] && continue
      if [[ "$file" == "$sdir/"* ]]; then
        shared_changed=true
        break 2
      fi
    done <<< "$shared_dirs"
  done <<< "$changed_files"

  # If shared changed, all services are affected
  if [[ "$shared_changed" == true ]]; then
    get_all_services
    return
  fi

  # Map each changed file to its service(s)
  local all_services
  all_services=$(get_all_services)

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    is_ignored "$file" && continue

    while IFS= read -r svc; do
      [[ -z "$svc" ]] && continue
      local dirs
      dirs=$(get_service_dirs "$svc")
      while IFS= read -r dir; do
        [[ -z "$dir" ]] && continue
        if [[ "$file" == "$dir/"* || "$file" == "$dir" ]]; then
          # Add if not already in list
          local already=false
          for a in "${affected_services[@]+"${affected_services[@]}"}"; do
            [[ "$a" == "$svc" ]] && already=true && break
          done
          if [[ "$already" == false ]]; then
            affected_services+=("$svc")
          fi
        fi
      done <<< "$dirs"
    done <<< "$all_services"
  done <<< "$changed_files"

  printf '%s\n' "${affected_services[@]+"${affected_services[@]}"}"
}

# Categorize changed files by directory for display
categorize_changes() {
  local base_commit="$1"
  local changed_files
  changed_files=$(git diff --name-only "$base_commit"..HEAD 2>/dev/null || true)

  [[ -z "$changed_files" ]] && return

  declare -A dir_counts
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    local top_dir="${file%%/*}"
    dir_counts[$top_dir]=$(( ${dir_counts[$top_dir]:-0} + 1 ))
  done <<< "$changed_files"

  for dir in $(echo "${!dir_counts[@]}" | tr ' ' '\n' | sort); do
    local count="${dir_counts[$dir]}"
    local marker=""
    # Mark shared dirs
    local shared_dirs
    shared_dirs=$(get_shared_dirs)
    while IFS= read -r sdir; do
      [[ "$dir" == "$sdir" ]] && marker=" ${YELLOW}(affects ALL services)${NC}"
    done <<< "$shared_dirs"
    # Mark ignored dirs
    if is_ignored "$dir/"; then
      marker=" ${DIM}(ignored)${NC}"
    fi
    echo -e "  ${CYAN}${dir}/${NC}  ${count} file(s)${marker}"
  done
}

# ----------------------------------------------------------------------------
# Sevalla API calls
# ----------------------------------------------------------------------------
sevalla_deploy() {
  local app_id="$1"
  local restart="$2"

  local body="{}"
  if [[ "$restart" == true ]]; then
    body='{"is_restart": true}'
  fi

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${SEVALLA_API}/applications/${app_id}/deployments" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>&1)

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body_response
  body_response=$(echo "$response" | sed '$d')

  if [[ "$http_code" =~ ^2 ]]; then
    local deploy_id
    deploy_id=$(echo "$body_response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('deployment',{}).get('id', d.get('id','unknown')))" 2>/dev/null || echo "unknown")
    echo "$deploy_id"
    return 0
  else
    echo "$body_response"
    return 1
  fi
}

# ----------------------------------------------------------------------------
# Status command
# ----------------------------------------------------------------------------
if [[ "$SHOW_STATUS" == true ]]; then
  header "Deployment Status"

  if [[ -f "$LAST_DEPLOY_FILE" ]]; then
    local_last=$(cat "$LAST_DEPLOY_FILE")
    local_date=$(git log -1 --format="%ci" "$local_last" 2>/dev/null || echo "unknown")
    local_msg=$(git log -1 --format="%s" "$local_last" 2>/dev/null || echo "unknown")
    echo -e "  Last deploy: ${GREEN}${local_last:0:7}${NC} ${DIM}${local_date}${NC}"
    echo -e "  Commit msg:  ${local_msg}"
  else
    warn "No deploy marker found (.last-deploy)"
    log "Will use origin/production as baseline"
  fi

  echo ""
  base=$(get_base_commit)
  current=$(git rev-parse HEAD)

  if [[ "$base" == "$current" ]]; then
    ok "No pending changes to deploy"
  else
    commit_count=$(git rev-list --count "$base"..HEAD)
    echo -e "  Pending:     ${YELLOW}${commit_count} commit(s)${NC} since last deploy"
    echo -e "  Range:       ${DIM}${base:0:7}..${current:0:7}${NC}"
    echo ""
    header "Changed directories:"
    categorize_changes "$base"
    echo ""
    header "Affected services:"
    affected=$(map_changes_to_services "$base")
    if [[ -z "$affected" ]]; then
      echo -e "  ${DIM}(no service-affecting changes detected)${NC}"
    else
      while IFS= read -r svc; do
        local aid
        aid=$(get_service_app_id "$svc")
        if [[ -n "$aid" ]]; then
          echo -e "  ${GREEN}●${NC} ${svc}  ${DIM}(${aid:0:8}...)${NC}"
        else
          echo -e "  ${YELLOW}●${NC} ${svc}  ${DIM}(no app_id configured)${NC}"
        fi
      done <<< "$affected"
    fi
  fi
  exit 0
fi

# ============================================================================
# Main deploy flow
# ============================================================================
header "Slingshot Deploy"
echo ""

# Step 1: Determine what to deploy
if [[ "$DEPLOY_ALL" == true ]]; then
  services_to_deploy=$(get_all_services)
  log "Deploying ALL services (--all flag)"
elif [[ -n "$FORCE_SERVICES" ]]; then
  services_to_deploy=$(echo "$FORCE_SERVICES" | tr ',' '\n')
  log "Deploying specified services: $FORCE_SERVICES"
else
  base_commit=$(get_base_commit)
  current_commit=$(git rev-parse HEAD)

  if [[ "$base_commit" == "$current_commit" ]]; then
    ok "No changes since last deploy (${current_commit:0:7})"
    exit 0
  fi

  commit_count=$(git rev-list --count "$base_commit"..HEAD)
  log "Analyzing ${commit_count} commit(s) since last deploy (${base_commit:0:7})..."
  echo ""

  header "Changed directories:"
  categorize_changes "$base_commit"
  echo ""

  services_to_deploy=$(map_changes_to_services "$base_commit")

  if [[ -z "$services_to_deploy" ]]; then
    ok "No service-affecting changes detected"
    echo -e "${DIM}  (only ignored files were modified)${NC}"
    exit 0
  fi
fi

# Step 2: Display plan
service_count=$(echo "$services_to_deploy" | grep -c . || true)
header "Services to deploy (${service_count}):"

missing_ids=false
while IFS= read -r svc; do
  [[ -z "$svc" ]] && continue
  app_id=$(get_service_app_id "$svc")
  if [[ -n "$app_id" ]]; then
    mode="redeploy"
    [[ "$IS_RESTART" == true ]] && mode="restart"
    echo -e "  ${GREEN}●${NC} ${svc}  → ${mode}  ${DIM}(${app_id:0:8}...)${NC}"
  else
    echo -e "  ${YELLOW}●${NC} ${svc}  → ${RED}no app_id configured${NC}"
    missing_ids=true
  fi
done <<< "$services_to_deploy"

if [[ "$missing_ids" == true ]]; then
  echo ""
  warn "Some services are missing app_id in deploy.config.json"
  warn "Get your app IDs from: https://app.sevalla.com or via:"
  warn "  curl -H 'Authorization: Bearer \$SEVALLA_API_KEY' ${SEVALLA_API}/applications | python3 -m json.tool"
fi

# Dry run exits here
if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo -e "${YELLOW}── DRY RUN ── No changes were made ──${NC}"
  exit 0
fi

# Step 3: Confirm
echo ""
read -p "Proceed with deployment? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  warn "Aborted."
  exit 1
fi

# Step 4: Push code to production
if [[ "$NO_PUSH" == false ]]; then
  echo ""
  header "Pushing code to production..."
  remote=$(read_config "git_remote")
  prod_branch=$(read_config "production_branch")

  log "git push ${remote} master:${prod_branch}"
  git push "${remote}" "master:${prod_branch}" 2>&1 | sed 's/^/  /'
  ok "Code pushed to ${prod_branch}"
fi

# Step 5: Trigger deploys
echo ""
header "Triggering deployments..."

deploy_failures=0
while IFS= read -r svc; do
  [[ -z "$svc" ]] && continue
  app_id=$(get_service_app_id "$svc")
  [[ -z "$app_id" ]] && continue

  log "Deploying ${svc}..."
  if result=$(sevalla_deploy "$app_id" "$IS_RESTART"); then
    ok "${svc} → deployment triggered (id: ${result:0:12})"
  else
    err "${svc} → FAILED: ${result}"
    deploy_failures=$((deploy_failures + 1))
  fi
done <<< "$services_to_deploy"

# Step 6: Save deploy marker
echo ""
current_commit=$(git rev-parse HEAD)
echo "$current_commit" > "$LAST_DEPLOY_FILE"
ok "Deploy marker saved: ${current_commit:0:7}"

if [[ $deploy_failures -gt 0 ]]; then
  echo ""
  err "${deploy_failures} deployment(s) failed. Check Sevalla dashboard."
  exit 1
fi

echo ""
ok "All deployments triggered successfully!"
echo -e "${DIM}  Monitor at: https://app.sevalla.com${NC}"
