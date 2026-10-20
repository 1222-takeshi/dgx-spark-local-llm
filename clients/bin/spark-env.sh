# Shared config loader for the spark-* wrappers (sourced, not executed).
# Reads KEY=VALUE lines without evaluating them and checks file modes.
# Sets: SPARK_CONFIG_DIR, SPARK_TOKEN_FILE, SPARK_BASE_URL, SPARK_MODEL, SPARK_DENY_READ

spark_die() { echo "${0##*/}: $*" >&2; exit 2; }

spark_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

spark_load_env() {
  SPARK_CONFIG_DIR="${SPARK_LLM_CONFIG_DIR:-$HOME/.config/spark-llm}"
  SPARK_TOKEN_FILE="$SPARK_CONFIG_DIR/token"
  local env_file="$SPARK_CONFIG_DIR/env" key value
  [[ -f "$env_file" ]] || spark_die "missing $env_file (set SPARK_LLM_BASE_URL there)"
  [[ "$(spark_mode "$env_file")" == 600 ]] || spark_die "$env_file must be mode 600"
  [[ -s "$SPARK_TOKEN_FILE" ]] || spark_die "missing or empty $SPARK_TOKEN_FILE"
  [[ "$(spark_mode "$SPARK_TOKEN_FILE")" == 600 ]] || spark_die "$SPARK_TOKEN_FILE must be mode 600"

  SPARK_BASE_URL="" SPARK_MODEL="ornith-1.5-35b-a3b-nvfp4" SPARK_DENY_READ=""
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    case "$key" in
      SPARK_LLM_BASE_URL) SPARK_BASE_URL="$value" ;;
      SPARK_LLM_MODEL) SPARK_MODEL="$value" ;;
      SPARK_LLM_DENY_READ) SPARK_DENY_READ="$value" ;;
    esac
  done < "$env_file"

  [[ "$SPARK_BASE_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || spark_die "invalid SPARK_LLM_BASE_URL"
  [[ "$SPARK_MODEL" =~ ^[A-Za-z0-9._/-]+$ ]] || spark_die "invalid SPARK_LLM_MODEL"
  [[ -z "$SPARK_DENY_READ" || "$SPARK_DENY_READ" =~ ^/[A-Za-z0-9._/:+-]*$ ]] || spark_die "invalid SPARK_LLM_DENY_READ"
}
