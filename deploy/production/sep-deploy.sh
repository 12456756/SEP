#!/usr/bin/env bash
# =============================================================================
# sep-deploy.sh — SEP 生产部署脚本
# 用法: ./sep-deploy.sh <command> [options]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/opt/sep/.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BLUE_GREEN_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.blue-green.yml"
STATE_DIR="${SEP_DEPLOY_STATE_DIR:-/opt/sep/.deploy}"
ACTIVE_COLOR_FILE="$STATE_DIR/active-color"
# SEP 的站点配置已从龙道主 Caddyfile 拆出来单独成文件（主 Caddyfile 用 import 引入），
# 两个应用的发布流程不再改同一个文件。
CADDYFILE="${SEP_CADDYFILE:-/opt/longdao/deploy/production/conf.d/sep.caddy}"
CADDY_CONTAINER="${SEP_CADDY_CONTAINER:-longdao-caddy}"
# 切换前的配置备份放在 SEP 自己的目录，不要落在龙道仓库里 ——
# 那边 build_production_image.sh 有干净工作区检查（REL-002），多一个文件就构建失败。
CADDY_BACKUP_DIR="${SEP_CADDY_BACKUP_DIR:-/opt/sep/backups/caddy}"
LOCK_FILE="${SEP_DEPLOY_LOCK_FILE:-/opt/sep/.deploy.lock}"
SHARED_NETWORK="${SEP_SHARED_NETWORK:-longdao-network}"

# docker compose 统一入口，始终带 --env-file
dc() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

dc_bg() {
  docker compose --project-name sep-blue-green --env-file "$ENV_FILE" -f "$BLUE_GREEN_COMPOSE_FILE" "$@"
}

# ── 颜色输出 ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[SEP]${NC} $*"; }
success() { echo -e "${GREEN}[SEP]${NC} $*"; }
warn()    { echo -e "${YELLOW}[SEP]${NC} $*"; }
error()   { echo -e "${RED}[SEP]${NC} $*" >&2; }

# ── 前置检查 ──────────────────────────────────────────────────────────────────
check_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    error "env 文件不存在: $ENV_FILE"
    exit 1
  fi
  check_auth_env
}

# The CI runner checks out the exact GitHub SHA before invoking this script.
# Never fetch or merge inside a release command: doing so can silently build a
# newer commit than the one that passed CI.
prepare_deploy_revision() {
  local current expected
  current=$(git -C "$SCRIPT_DIR/../.." rev-parse HEAD)
  if [[ -n "${DEPLOY_SHA:-}" ]]; then
    expected=$(git -C "$SCRIPT_DIR/../.." rev-parse "${DEPLOY_SHA}^{commit}") || {
      error "DEPLOY_SHA 不是当前工作树可解析的 commit: ${DEPLOY_SHA}"
      return 1
    }
    [[ "$current" == "$expected" ]] || {
      error "当前 checkout (${current}) 与 DEPLOY_SHA (${expected}) 不一致，拒绝部署"
      return 1
    }
  fi

  DEPLOY_TAG=${DEPLOY_TAG:-${current:0:12}}
  [[ "$DEPLOY_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || {
    error "DEPLOY_TAG 只能包含字母、数字、点、下划线和连字符"
    return 1
  }
  export DEPLOY_TAG
  info "使用已检出的版本：${current}（镜像标签：${DEPLOY_TAG}）"
}

# SEP intentionally uses the existing longdao network, but it must never own
# or recreate the shared PostgreSQL/Redis/Caddy services.
check_compose_scope() {
  local services
  services=$(dc config --services)
  if grep -Eq '^(postgres|redis|caddy|sub2api|sub2api-blue|sub2api-green)$' <<<"$services"; then
    error "SEP compose 包含共享 longdao 服务，已终止部署"
    return 1
  fi

  services=$(dc_bg config --services)
  if grep -Eq '^(postgres|redis|caddy|sub2api|sub2api-blue|sub2api-green)$' <<<"$services"; then
    error "SEP 蓝绿 compose 包含共享 longdao 服务，已终止部署"
    return 1
  fi
}

env_value() {
  local key=$1
  local value
  value=$(awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$ENV_FILE")
  # 只用于校验，不回显值；兼容 .env 中常见的单/双引号写法。
  value=${value#\"}; value=${value%\"}
  value=${value#\'}; value=${value%\'}
  printf '%s' "$value"
}

is_https_url() {
  [[ "$1" =~ ^https://[^[:space:]]+$ ]]
}

require_auth_env_value() {
  local key=$1 value
  value=$(env_value "$key")
  [[ -n "$value" ]] || {
    error "认证生产配置缺少 ${key}（不会输出密钥内容）"
    return 1
  }
}

# 在 Docker Compose/Node 启动前尽早阻断不完整的认证生产配置。
# 后端仍会执行同一类校验，这里只做 fail-fast，不打印任何密钥值。
check_auth_env() {
  local node_env access_secret refresh_pepper mail_enabled oauth_enabled redirect
  node_env=$(env_value NODE_ENV)
  [[ -n "$node_env" ]] || node_env=production
  [[ "$node_env" == production ]] || return 0

  require_auth_env_value JWT_SECRET
  require_auth_env_value ACCESS_JWT_SECRET
  require_auth_env_value REFRESH_TOKEN_PEPPER
  access_secret=$(env_value ACCESS_JWT_SECRET)
  refresh_pepper=$(env_value REFRESH_TOKEN_PEPPER)
  [[ ${#access_secret} -ge 32 ]] || { error 'ACCESS_JWT_SECRET 长度不足 32'; return 1; }
  [[ ${#refresh_pepper} -ge 32 ]] || { error 'REFRESH_TOKEN_PEPPER 长度不足 32'; return 1; }
  [[ "$access_secret" != "$refresh_pepper" ]] || { error 'ACCESS_JWT_SECRET 与 REFRESH_TOKEN_PEPPER 不能相同'; return 1; }

  require_auth_env_value CORS_ORIGIN
  mail_enabled=$(env_value MAIL_ENABLED)
  [[ "$mail_enabled" == true ]] || { error '生产环境必须设置 MAIL_ENABLED=true'; return 1; }
  for key in MAIL_HOST MAIL_USER MAIL_PASSWORD MAIL_FROM; do
    require_auth_env_value "$key"
  done

  for provider in WECHAT QQ; do
    oauth_enabled=$(env_value "${provider}_OAUTH_ENABLED")
    [[ "$oauth_enabled" == true ]] || continue
    if [[ "$provider" == WECHAT ]]; then
      for key in WECHAT_APP_ID WECHAT_APP_SECRET WECHAT_REDIRECT_URI; do
        require_auth_env_value "$key"
      done
      redirect=$(env_value WECHAT_REDIRECT_URI)
    else
      for key in QQ_APP_ID QQ_APP_KEY QQ_REDIRECT_URI; do
        require_auth_env_value "$key"
      done
      redirect=$(env_value QQ_REDIRECT_URI)
    fi
    is_https_url "$redirect" || { error "${provider}_REDIRECT_URI 必须使用 HTTPS"; return 1; }
  done
}

find_shared_container() {
  local service=$1
  docker ps --filter "network=$SHARED_NETWORK" \
    --filter "label=com.docker.compose.service=$service" \
    --format '{{.Names}}' | head -n 1
}

check_shared_infrastructure() {
  local postgres redis db_user
  docker network inspect "$SHARED_NETWORK" >/dev/null 2>&1 || {
    error "共享 Docker 网络不存在: $SHARED_NETWORK"
    return 1
  }

  postgres=$(find_shared_container postgres)
  [[ -n "$postgres" ]] || {
    error "共享 PostgreSQL 容器未运行，拒绝继续部署"
    return 1
  }
  db_user=$(env_value POSTGRES_USER)
  db_user=${db_user:-sub2api}
  docker exec "$postgres" pg_isready -U "$db_user" -d postgres >/dev/null 2>&1 || {
    error "共享 PostgreSQL 尚未接受连接（容器: $postgres），拒绝执行迁移"
    return 1
  }

  redis=$(find_shared_container redis)
  [[ -n "$redis" ]] || {
    error "共享 Redis 容器未运行，拒绝继续部署"
    return 1
  }

  info "共享基础设施已就绪：PostgreSQL=$postgres，Redis=$redis，网络=$SHARED_NETWORK"
}

run_migrations() {
  check_shared_infrastructure
  # 迁移镜像必须先重建：镜像里打包的是构建时刻的 migrations 目录，
  # 复用旧镜像会让新迁移永远不被执行，而容器仍然以 exit 0 结束（静默漏迁移）。
  info "重建迁移镜像（打包当前 migrations 目录）..."
  dc build sep-migrate
  info "执行数据库迁移（仅操作 SEP 迁移容器）..."
  dc up --no-deps --force-recreate sep-migrate
  local migration_exit
  migration_exit=$(docker inspect --format='{{.State.ExitCode}}' sep-migrate 2>/dev/null || echo 1)
  [[ "$migration_exit" == "0" ]] || {
    error "数据库迁移失败（exit code $migration_exit），终止部署"
    docker logs --tail=80 sep-migrate 2>&1 | sed 's/^/  /'
    return 1
  }
  success "数据库迁移完成"
}

check_knowledge_schema() {
  local postgres db_user
  postgres=$(find_shared_container postgres)
  [[ -n "$postgres" ]] || { error "找不到共享 PostgreSQL，无法检查知识库结构"; return 1; }
  db_user=$(env_value POSTGRES_USER)
  db_user=${db_user:-sub2api}
  info "检查知识库原生向量扩展、1024 维字段和有效 HNSW 索引..."
  docker exec -i "$postgres" psql -X -U "$db_user" -d sep_prod -v ON_ERROR_STOP=1 \
    --single-transaction -c 'SET TRANSACTION READ ONLY' -f - \
    < "$SCRIPT_DIR/postgres/verify-knowledge-schema.sql" || {
      error "知识库实际数据库结构不完整，拒绝启动候选或切流"
      return 1
    }
}

# ── 等待容器健康 ──────────────────────────────────────────────────────────────
wait_healthy() {
  local container=$1
  local retries=${2:-24}   # 默认最多等 2 分钟（每 5 秒一次）
  info "等待 $container 健康..."
  for i in $(seq 1 "$retries"); do
    local status
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "missing")
    case "$status" in
      healthy) success "$container 已就绪"; return 0 ;;
      missing) warn "$container 容器不存在"; return 1 ;;
    esac
    echo -ne "  [$i/$retries] $status...\r"
    sleep 5
  done
  error "$container 未能在规定时间内变为 healthy"
  docker logs --tail=20 "$container" 2>&1 | sed 's/^/  /'
  return 1
}

# =============================================================================
# 命令实现
# =============================================================================

# -- status -------------------------------------------------------------------
cmd_status() {
  echo ""
  docker ps -a --filter "name=sep-" \
    --format "table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}"
  echo ""
}

# -- logs ---------------------------------------------------------------------
cmd_logs() {
  local service="${1:-}"
  if [[ -z "$service" ]]; then
    dc logs --tail=50 -f
  else
    dc logs --tail=100 -f "$service"
  fi
}

ensure_state_dir() {
  mkdir -p "$STATE_DIR"
}

current_target() {
  if [[ -f "$ACTIVE_COLOR_FILE" ]]; then
    cat "$ACTIVE_COLOR_FILE"
  elif grep -Eq 'reverse_proxy sep-(blue|green)-web:3000' "$CADDYFILE" 2>/dev/null; then
    grep -Eo 'reverse_proxy sep-(blue|green)-web:3000' "$CADDYFILE" | head -1 | sed -E 's/^reverse_proxy (sep-(blue|green)-web):3000$/\1/'
  else
    echo "legacy"
  fi
}

color_target() {
  echo "sep-$1-web"
}

# color_target 的逆运算：sep-green-web → green。
# 状态文件里存的是完整目标名，直接 ${x#sep-} 会留下 "green-web"，
# 拼出 green-web-backend 这种不存在的服务名。
target_color() {
  local target=${1#sep-}
  echo "${target%-web}"
}

target_backend() {
  case "$1" in
    sep-blue-web) echo "sep-blue-backend" ;;
    sep-green-web) echo "sep-green-backend" ;;
    legacy|sep-web) echo "sep-backend" ;;
    *) return 1 ;;
  esac
}

wait_service_healthy() {
  local container=$1
  local retries=${2:-36}
  for i in $(seq 1 "$retries"); do
    local status
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)
    [[ "$status" == healthy ]] && return 0
    [[ "$status" == unhealthy ]] && break
    sleep 5
  done
  docker logs --tail=80 "$container" 2>&1 | sed 's/^/  /'
  return 1
}

ensure_upload_volume_permissions() {
  local image=$1
  info "检查 sep_uploads 卷权限..."
  docker run --rm --user 0:0 \
    --volume sep_uploads:/app/uploads \
    --entrypoint sh "$image" -ec '
      owner_uid=$(id -u node)
      mkdir -p /app/uploads/chat
      if [ "$(stat -c %u /app/uploads)" != "$owner_uid" ] || \
         [ "$(stat -c %u /app/uploads/chat)" != "$owner_uid" ]; then
        chown -R node:node /app/uploads
      fi
      mkdir -p /app/uploads/chat/enterprise-logos /app/uploads/chat/user-avatars
      chown node:node /app/uploads /app/uploads/chat \
        /app/uploads/chat/enterprise-logos /app/uploads/chat/user-avatars
      chmod 0750 /app/uploads /app/uploads/chat \
        /app/uploads/chat/enterprise-logos /app/uploads/chat/user-avatars
    '
  docker run --rm --user node:node \
    --volume sep_uploads:/app/uploads \
    --entrypoint node "$image" -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const root = "/app/uploads/chat";
      for (const relative of ["", "enterprise-logos", "user-avatars"]) {
        const directory = path.join(root, relative);
        const probe = path.join(directory, `.sep-write-check-${process.pid}-${Date.now()}`);
        fs.writeFileSync(probe, "ok", { flag: "wx" });
        fs.rmSync(probe);
      }
    '
  success "sep_uploads 卷可由 node 用户写入"
}

restore_caddy_backup() {
  local backup=$1
  cp "$backup" "$CADDYFILE"
  docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile >/dev/null || {
    error "恢复的 Caddy 旧配置校验失败，需要立即人工介入"
    return 1
  }
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile >/dev/null || {
    error "恢复 Caddy 旧配置后 reload 仍失败，需要立即人工介入"
    return 1
  }
}

verify_caddy_upstreams() {
  local web_target=$1 backend_target=$2 runtime
  runtime=$(docker exec "$CADDY_CONTAINER" wget -qO- http://127.0.0.1:2019/reverse_proxy/upstreams) || return 1
  grep -Fq "${web_target}:3000" <<<"$runtime" && grep -Fq "${backend_target}:3001" <<<"$runtime"
}

switch_caddy_upstream() {
  local web_target=$1 backend_target temp backup
  backend_target=$(target_backend "$web_target") || {
    error "不支持的 Caddy 发布目标: $web_target"
    return 1
  }
  [[ -f "$CADDYFILE" ]] || { error "Caddyfile 不存在: $CADDYFILE"; return 1; }
  temp=$(mktemp)
  mkdir -p "$CADDY_BACKUP_DIR"
  backup="$CADDY_BACKUP_DIR/$(basename "$CADDYFILE").$(date +%Y%m%d%H%M%S).bak"
  sed -E \
    -e "s#reverse_proxy (@sep_ws )?(sep-backend|sep-(blue|green)-backend):3001#reverse_proxy \\1${backend_target}:3001#" \
    -e "s#reverse_proxy (sep-web|sep-(blue|green)-web):3000#reverse_proxy ${web_target}:3000#" \
    "$CADDYFILE" > "$temp"
  if ! grep -Fq "reverse_proxy @sep_ws ${backend_target}:3001" "$temp" || \
     ! grep -Fq "reverse_proxy ${web_target}:3000" "$temp"; then
    rm -f "$temp"
    error "未找到可同时替换 Web 与 WebSocket 的 Caddy upstream"
    return 1
  fi
  cp "$CADDYFILE" "$backup"
  # 原地覆盖内容（不要 mv）：单文件 bind mount 时改名会让容器继续读旧 inode；
  # 现在 conf.d 是目录挂载，原地覆盖同样安全。
  cp "$temp" "$CADDYFILE"
  rm -f "$temp"
  if ! docker exec "$CADDY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile >/dev/null; then
    if ! restore_caddy_backup "$backup"; then
      error "Caddy 配置校验失败，且旧配置恢复失败"
    fi
    error "Caddy 配置校验失败，已尝试恢复旧配置"
    return 1
  fi
  if ! docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile >/dev/null; then
    error "Caddy reload 失败，尝试恢复旧配置"
    if ! restore_caddy_backup "$backup"; then
      error "Caddy reload 失败，且旧配置恢复失败"
    fi
    return 1
  fi
  # caddy reload 内部应用失败时会回滚到旧配置，但 CLI 退出码仍是 0 —— 不能只看退出码。
  # 通过 admin API 确认 Web 和 WebSocket 都切到了同一颜色。
  if ! verify_caddy_upstreams "$web_target" "$backend_target"; then
    error "reload 后 Caddy 未同时指向 ${web_target} 与 ${backend_target}，尝试恢复旧配置"
    if ! restore_caddy_backup "$backup"; then
      error "Caddy 运行态校验失败，且旧配置恢复失败"
    fi
    return 1
  fi
}

check_service_readiness() {
  local color=$1 timeout_ms=${2:-5000} backend web
  [[ "$timeout_ms" =~ ^[1-9][0-9]{0,5}$ && "$timeout_ms" -le 130000 ]] || {
    error "就绪检查超时必须为 1 至 130000 毫秒"
    return 1
  }
  if [[ "$color" == "legacy" ]]; then
    backend=sep-backend
    web=sep-web
  else
    backend="sep-${color}-backend"
    web="sep-${color}-web"
  fi

  docker exec "$backend" node -e "fetch('http://127.0.0.1:3001/api/health/ready', {signal: AbortSignal.timeout(${timeout_ms})}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || return 1
  docker exec "$backend" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.resolve(process.env.UPLOAD_LOCAL_DIR || "./uploads/chat");
    const probe = path.join(root, `.sep-write-check-${process.pid}-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(probe, "ok", { flag: "wx" });
    fs.rmSync(probe);
  ' || return 1
  docker exec "$web" node -e "fetch('http://127.0.0.1:3000/', {signal: AbortSignal.timeout(5000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || return 1
}

observe_candidate() {
  local color=$1 checks=${SEP_POST_DEPLOY_CHECKS:-} interval=${SEP_POST_DEPLOY_INTERVAL_SECONDS:-}
  local i
  [[ -n "$checks" ]] || checks=$(env_value SEP_POST_DEPLOY_CHECKS)
  [[ -n "$interval" ]] || interval=$(env_value SEP_POST_DEPLOY_INTERVAL_SECONDS)
  checks=${checks:-6}
  interval=${interval:-10}
  [[ "$checks" =~ ^[1-9][0-9]*$ && "$interval" =~ ^[0-9]+$ ]] || {
    error "发布后观察参数无效：SEP_POST_DEPLOY_CHECKS=${checks}, SEP_POST_DEPLOY_INTERVAL_SECONDS=${interval}"
    return 1
  }
  info "候选 ${color} 进入发布后观察：${checks} 次，每次间隔 ${interval}s；旧环境保持运行"
  for i in $(seq 1 "$checks"); do
    if ! check_service_readiness "$color"; then
      error "候选 ${color} 在发布后观察第 ${i}/${checks} 次检查失败"
      return 1
    fi
    [[ "$i" == "$checks" ]] || sleep "$interval"
  done
}

deployment_lock() {
  ensure_state_dir || return 1
  exec 9>"$LOCK_FILE" || return 1
  flock -n 9 || { error "已有部署正在执行"; return 1; }
}

target_web() {
  case "$1" in
    legacy|sep-web) echo sep-web ;;
    sep-blue-web|sep-green-web) echo "$1" ;;
    *) error "不支持的 SEP 目标"; return 1 ;;
  esac
}

container_state() {
  local container=$1 state names
  case "$container" in sep-backend|sep-web|sep-blue-backend|sep-blue-web|sep-green-backend|sep-green-web) ;;
    *) return 1 ;;
  esac
  if state=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null); then
    printf '%s\n' "$state"
  else
    names=$(docker container ls -a --format '{{.Names}}') || return 1
    if grep -Fxq "$container" <<<"$names"; then
      return 1
    fi
    echo missing
  fi
}

assert_target_inactive() {
  local target=$1 backend web container state names
  backend=$(target_backend "$target") || return 1
  web=$(target_web "$target") || return 1
  for container in "$backend" "$web"; do
    # Distinguish a missing candidate from an unavailable Docker daemon.
    docker info --format '{{.ServerVersion}}' >/dev/null || return 1
    if state=$(container_state "$container" 2>/dev/null); then
      [[ "$state" == exited || "$state" == created || "$state" == missing ]] || {
        error "$container 仍处于 ${state}；可能排空未完成，拒绝覆盖"; return 1;
      }
    else
      names=$(docker container ls -a --format '{{.Names}}') || return 1
      if grep -Fxq "$container" <<<"$names"; then
        error "无法确认 $container 状态，拒绝覆盖"; return 1
      fi
    fi
  done
}

# Only read lifecycle fields, never inspect or print container credentials.
gateway_snapshot() {
  local backend=$1
  case "$backend" in sep-backend|sep-blue-backend|sep-green-backend) ;; *) return 1 ;; esac
  docker exec --user node "$backend" node -e '
    const timer = setTimeout(() => process.exit(1), 6000);
    fetch("http://127.0.0.1:3001/health", {signal: AbortSignal.timeout(5000)})
      .then(async r => {
        if (!r.ok) throw new Error("liveness failed");
        const s = await r.json();
        if (!/^[a-f0-9-]{36}$/.test(s.bootId) ||
            !["ready", "draining", "stopping", "control_error"].includes(s.gatewayState) ||
            typeof s.draining !== "boolean" ||
            !Number.isSafeInteger(s.activeGatewayRequests) || s.activeGatewayRequests < 0 ||
            ![s.requestBudgetMs, s.drainGraceMs, s.drainTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0) ||
            s.drainTimeoutMs < s.requestBudgetMs + s.drainGraceMs) throw new Error("invalid lifecycle");
        console.log([s.bootId, s.gatewayState, Number(s.draining), s.activeGatewayRequests,
          s.requestBudgetMs, s.drainGraceMs, s.drainTimeoutMs].join(" "));
        clearTimeout(timer);
        process.exit(0);
      }).catch(() => process.exit(1));
  '
}

write_gateway_drain() {
  local backend=$1 boot=$2 token=$3
  docker exec --user node "$backend" node -e '
    const fs = require("node:fs");
    const [bootId, token] = process.argv.slice(1);
    const root = "/tmp/sep-runtime";
    const destination = `${root}/gateway-drain.json`;
    const temporary = `${destination}.${process.pid}.tmp`;
    const directory = fs.lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) process.exit(1);
    fs.writeFileSync(temporary, JSON.stringify({bootId, token}), {mode: 0o600, flag: "wx"});
    fs.renameSync(temporary, destination);
  ' "$boot" "$token"
}

resume_gateway() {
  local backend=$1 snapshot boot state draining active budget grace timeout
  snapshot=$(gateway_snapshot "$backend") || return 1
  read -r boot state draining active budget grace timeout <<<"$snapshot"
  [[ "$state" != stopping && "$state" != control_error ]] || {
    error "$backend 不可恢复准入：$state"; return 1;
  }
  [[ "$state" == ready && "$draining" == 0 ]] && return 0
  docker exec --user node "$backend" node -e '
    const fs = require("node:fs");
    const file = "/tmp/sep-runtime/gateway-drain.json";
    try {
      const marker = JSON.parse(fs.readFileSync(file, "utf8"));
      if (marker.bootId !== process.argv[1]) process.exit(1);
      fs.unlinkSync(file);
    } catch (e) { if (e.code !== "ENOENT") process.exit(1); }
  ' "$boot" || return 1
  snapshot=$(gateway_snapshot "$backend") || return 1
  [[ "$snapshot" == "$boot ready 0 "* ]] || return 1
}

drain_gateway() {
  local backend=$1 snapshot boot state draining active budget grace runtime_timeout
  local timeout=${SEP_DRAIN_TIMEOUT_SECONDS:-} poll=${SEP_DRAIN_POLL_SECONDS:-1} deadline token current_boot
  snapshot=$(gateway_snapshot "$backend") || { error "$backend 排空状态不可读；保留容器"; return 1; }
  read -r boot state draining active budget grace runtime_timeout <<<"$snapshot"
  [[ "$state" == ready || "$state" == draining ]] || { error "$backend 状态 $state 不允许排空"; return 1; }
  timeout=${timeout:-$(((runtime_timeout + 999) / 1000))}
  [[ "$timeout" =~ ^[1-9][0-9]*$ && ${#timeout} -le 7 && "$poll" =~ ^[1-9][0-9]*$ && ${#poll} -le 4 ]] || {
    error "排空等待参数无效"; return 1;
  }
  ((timeout * 1000 >= budget + grace && timeout * 1000 >= runtime_timeout)) || {
    error "SEP_DRAIN_TIMEOUT_SECONDS 必须覆盖实例请求预算、grace 与排空配置"; return 1;
  }
  deadline=$((SECONDS + timeout))
  token="${DEPLOY_TAG:-local}-$$-$SECONDS"
  write_gateway_drain "$backend" "$boot" "$token" || { error "排空标记写入失败；保留容器"; return 1; }
  while :; do
    snapshot=$(gateway_snapshot "$backend") || { error "排空状态读取失败；保留容器"; return 1; }
    read -r current_boot state draining active budget grace runtime_timeout <<<"$snapshot"
    [[ "$current_boot" == "$boot" && "$state" == draining && "$draining" == 1 ]] || {
      error "排空期间进程身份或状态变化；保留容器"; return 1;
    }
    ((SECONDS < deadline)) || { error "$backend 排空超时（activeGatewayRequests=${active}）；保留旧容器，不硬杀"; return 1; }
    [[ "$active" == 0 ]] && return 0
    local remaining=$((deadline - SECONDS))
    ((poll < remaining)) && sleep "$poll" || sleep "$remaining"
  done
}

# docker stop/restart automatically SIGKILL on timeout. Send TERM only and retain
# a process that does not exit within the explicit stop observation window.
disable_restart_for_stop() {
  local container=$1 policy file
  ensure_state_dir || return 1
  file="$STATE_DIR/$container.restart-policy"
  if [[ ! -f "$file" ]]; then
    policy=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$container") || return 1
    case "$policy" in no|unless-stopped|always) ;; *) error "不支持的容器重启策略；拒绝停止"; return 1 ;; esac
    printf '%s\n' "$policy" > "$file" || return 1
  fi
  # Keep the policy disabled on every failure, including a stop timeout. A later
  # rollback/restart restores it only after readiness succeeds.
  docker update --restart=no "$container" >/dev/null || return 1
}

restore_restart_policy() {
  local container=$1 policy file="$STATE_DIR/$1.restart-policy"
  [[ -f "$file" ]] || return 0
  policy=$(cat "$file") || return 1
  case "$policy" in no|unless-stopped|always) ;; *) error "保存的容器重启策略无效"; return 1 ;; esac
  docker update "--restart=$policy" "$container" >/dev/null || return 1
  rm -f "$file"
}

signal_and_wait_stopped() {
  local container=$1 timeout=${SEP_STOP_GRACE_SECONDS:-30} state deadline
  [[ "$timeout" =~ ^[1-9][0-9]*$ && ${#timeout} -le 4 ]] || { error "停止观察预算无效"; return 1; }
  state=$(container_state "$container") || return 1
  [[ "$state" == exited || "$state" == created || "$state" == missing ]] && return 0
  [[ "$state" == running ]] || { error "$container 状态不可停止：$state"; return 1; }
  disable_restart_for_stop "$container" || return 1
  deadline=$((SECONDS + timeout))
  docker kill --signal=SIGTERM "$container" >/dev/null || return 1
  while :; do
    state=$(container_state "$container") || return 1
    [[ "$state" == exited ]] && return 0
    ((SECONDS < deadline)) || { error "$container 停止超时；保留容器，不发送 SIGKILL"; return 1; }
    sleep 1
  done
}

retire_target() {
  local target=$1 backend web state
  backend=$(target_backend "$target") || return 1
  web=$(target_web "$target") || return 1
  state=$(container_state "$backend") || return 1
  if [[ "$state" == running ]]; then
    drain_gateway "$backend" || return 1
    signal_and_wait_stopped "$backend" || return 1
  elif [[ "$state" != exited && "$state" != created && "$state" != missing ]]; then
    error "$backend 状态不明确，保留环境"; return 1
  fi
  signal_and_wait_stopped "$web" || return 1
}

stop_legacy() { retire_target legacy; }

stop_color() {
  case "$1" in blue|green) retire_target "sep-$1-web" ;; *) return 1 ;; esac
}

restore_target_ready() {
  local target=$1 backend web color container state
  backend=$(target_backend "$target") || return 1
  web=$(target_web "$target") || return 1
  for container in "$backend" "$web"; do
    state=$(container_state "$container") || return 1
    case "$state" in
      exited|created) docker start "$container" >/dev/null || return 1 ;;
      running) ;;
      *) error "$container 状态不允许恢复：$state"; return 1 ;;
    esac
  done
  wait_service_healthy "$backend" || return 1
  wait_service_healthy "$web" || return 1
  resume_gateway "$backend" || return 1
  color=$([[ "$target" == legacy || "$target" == sep-web ]] && echo legacy || target_color "$target")
  # The first embedding check can load Ollama's model; steady checks remain 5s.
  check_service_readiness "$color" 130000 || return 1
  restore_restart_policy "$backend" || return 1
  restore_restart_policy "$web" || return 1
}

restart_target() {
  local target=$1 backend snapshot boot state draining active budget grace timeout
  backend=$(target_backend "$target") || return 1
  if restore_target_ready "$target"; then return 0; fi
  # Readiness requires temporarily resuming admission. If any recovery stage
  # fails, fence the current boot again; never blindly delete an old marker.
  if snapshot=$(gateway_snapshot "$backend"); then
    read -r boot state draining active budget grace timeout <<<"$snapshot"
    if [[ "$state" == ready || "$state" == draining ]]; then
      if write_gateway_drain "$backend" "$boot" "recovery-failed-$$-$SECONDS"; then
        snapshot=$(gateway_snapshot "$backend") || snapshot=
        [[ "$snapshot" == "$boot draining 1 "* ]] || error "$backend 恢复失败且无法确认排空标记生效，需人工介入"
      else
        error "$backend 恢复失败且无法重新写入排空标记，需人工介入"
      fi
    fi
  else
    error "$backend 恢复失败且状态不可读；不清理排空标记，需人工介入"
  fi
  error "$target 恢复失败；保留容器与可确认的排空状态"
  return 1
}

# 构建失败时 BuildKit 缓存可能占满生产机磁盘，导致下一次发布在
# pnpm deploy 或 Next.js 类型检查阶段以 ENOSPC 失败。只清理未被容器
# 使用的构建缓存，不触碰运行中的容器、镜像、数据卷或共享基础设施。
prune_build_cache() {
  if [[ "${SEP_PRUNE_BUILDER_CACHE:-true}" != "true" ]]; then
    info "已跳过 Docker 构建缓存清理（SEP_PRUNE_BUILDER_CACHE != true）"
    return 0
  fi
  info "清理较旧 Docker 构建缓存，保留近期缓存和存储预算..."
  docker builder prune --all --force \
    --filter "until=${SEP_BUILD_CACHE_AGE:-48h}" \
    --keep-storage "${SEP_BUILD_CACHE_KEEP_STORAGE:-20GB}"
}

cmd_deploy_bluegreen() {
  check_env || return 1
  check_compose_scope || return 1
  prepare_deploy_revision || return 1
  deployment_lock || return 1

  local active candidate previous target
  active=$(current_target)
  target_backend "$active" >/dev/null || { error "活动目标状态无效"; return 1; }
  if [[ "$active" == "sep-blue-web" ]]; then
    candidate=green
    previous=blue
  elif [[ "$active" == "sep-green-web" ]]; then
    candidate=blue
    previous=green
  else
    candidate=blue
    previous=legacy
  fi
  target=$(color_target "$candidate")
  assert_target_inactive "$target" || return 1

  info "蓝绿发布：当前=${active}，候选=${candidate}，版本=${DEPLOY_TAG}"

  prune_build_cache || return 1
  info "构建候选后端和前端镜像..."
  dc_bg build "${candidate}-backend" "${candidate}-web" || return 1
  ensure_upload_volume_permissions "sep-${candidate}-backend:${DEPLOY_TAG}" || return 1

  run_migrations || return 1
  check_knowledge_schema || return 1

  info "启动候选环境..."
  # Cleanup is safe only before the first Caddy switch attempt. Partial starts
  # still use the normal lifecycle drain and TERM-only retirement path.
  # Recreated containers discard retired policy records and use Compose's policy.
  if ! dc_bg up -d --force-recreate "${candidate}-backend" "${candidate}-web" ||
     ! rm -f "$STATE_DIR/sep-$candidate-backend.restart-policy" "$STATE_DIR/sep-$candidate-web.restart-policy" ||
     ! wait_service_healthy "sep-${candidate}-backend" ||
     ! wait_service_healthy "sep-${candidate}-web" ||
     ! check_service_readiness "$candidate" 130000; then
    error "候选启动或切流前检查失败；退役明确未切流的 ${target}"
    if retire_target "$target"; then
      info "候选已安全退役；修复失败原因后可重试普通部署"
    else
      error "候选退役失败；保留容器与排空状态，需人工介入，不能直接覆盖重试"
    fi
    return 1
  fi

  info "切换 Caddy 到 ${target}..."
  if ! switch_caddy_upstream "$target"; then
    error "Caddy 切换失败；保留两色容器，不能假定配置恢复成功"
    return 1
  fi

  if ! observe_candidate "$candidate"; then
    error "候选观察失败，自动切回 ${active}；旧环境仍在运行"
    if [[ "$active" == "legacy" ]]; then
      if ! switch_caddy_upstream sep-web; then
        error "自动切回 legacy 失败，候选环境保持运行以便人工排障"
        return 1
      fi
    else
      if ! switch_caddy_upstream "$active"; then
        error "自动切回 ${active} 失败，候选环境保持运行以便人工排障"
        return 1
      fi
    fi
    stop_color "$candidate" || return 1
    return 1
  fi

  printf '%s\n' "$active" > "$STATE_DIR/previous-target" || return 1
  printf '%s\n' "$target" > "$ACTIVE_COLOR_FILE" || return 1

  # 只有候选完整通过有界观察期后，才排空并停止旧环境。
  if [[ "$active" == "legacy" ]]; then
    stop_legacy || return 1
  elif [[ "$active" == sep-blue-web || "$active" == sep-green-web ]]; then
    stop_color "$previous" || return 1
  fi
  success "蓝绿发布完成：${target}"
  cmd_status
}

cmd_rollback_bluegreen() {
  check_env || return 1
  check_compose_scope || return 1
  deployment_lock || return 1
  local active previous
  active=$(current_target)
  previous=$(cat "$STATE_DIR/previous-target" 2>/dev/null || true)
  [[ -n "$previous" && "$previous" != "$active" ]] || { error "没有可回滚版本"; return 1; }
  target_backend "$previous" >/dev/null || return 1
  # Start the retained containers, not a compose definition with today's image tag.
  restart_target "$previous" || return 1
  local previous_target
  previous_target=$([[ "$previous" == legacy ]] && echo sep-web || echo "$previous")
  switch_caddy_upstream "$previous_target" || {
    error "回滚时 Caddy 切换失败；保留当前流量与已启动的 previous 环境，需人工介入"
    return 1
  }
  printf '%s\n' "$previous" > "$ACTIVE_COLOR_FILE" || return 1
  printf '%s\n' "$active" > "$STATE_DIR/previous-target" || return 1
  retire_target "$active" || return 1
  success "已回滚到 ${previous}"
}

# -- deploy-web ---------------------------------------------------------------
# 兼容入口：前后端成对蓝绿发布，保护仍经旧 Web 转发的模型请求。
cmd_deploy_web() {
  info "deploy-web 使用成对蓝绿发布，避免重建 Web 截断 Gateway 代理流"
  cmd_deploy_bluegreen
}

# -- deploy-backend -----------------------------------------------------------
# 兼容入口：前后端成对蓝绿发布。
cmd_deploy_backend() {
  info "deploy-backend 使用成对蓝绿发布与 Gateway 排空"
  cmd_deploy_bluegreen
}

# -- deploy -------------------------------------------------------------------
# 全量部署：校验 checkout → 构建 → 迁移 → 切流 → 排空。
cmd_deploy() {
  info "deploy 使用成对蓝绿发布与 Gateway 排空"
  cmd_deploy_bluegreen
}

# -- restart ------------------------------------------------------------------
# 重启容器（不重建镜像，用于恢复崩溃的服务）
cmd_restart() {
  local service="${1:-all}"
  check_env || return 1
  case "$service" in
    all|sep-backend|sep-web) ;;
    *)
      error "只允许重启 SEP 服务：sep-backend、sep-web 或 all"
      return 1
      ;;
  esac
  deployment_lock || return 1
  local target backend web state
  target=$(current_target)
  backend=$(target_backend "$target") || return 1
  web=$(target_web "$target") || return 1
  state=$(container_state "$backend") || return 1
  if [[ "$state" == running ]]; then
    drain_gateway "$backend" || return 1
  elif [[ "$state" != exited && "$state" != created ]]; then
    error "无法确认后端状态，拒绝重启"; return 1
  fi
  if [[ "$service" == all || "$service" == sep-backend ]]; then
    signal_and_wait_stopped "$backend" || return 1
  fi
  if [[ "$service" == all || "$service" == sep-web ]]; then
    signal_and_wait_stopped "$web" || return 1
  fi
  restart_target "$target" || return 1
  success "重启完成 ✓"
  cmd_status
}

cmd_stop() {
  check_env || return 1
  deployment_lock || return 1
  local target
  target=$(current_target) || return 1
  retire_target "$target" || return 1
  success "当前 SEP 应用已排空并停止（保留容器和镜像）"
}

# =============================================================================
# 入口
# =============================================================================
usage() {
  cat <<EOF

用法: $(basename "$0") <command> [options]

命令:
  deploy           成对蓝绿发布（构建 + 迁移 + 切流 + 排空）
  deploy-web       成对蓝绿发布的兼容别名
  deploy-backend   成对蓝绿发布的兼容别名
  deploy-bluegreen 成对蓝绿发布
  rollback-bluegreen 回滚保留版本并排空离任实例
  restart [svc]    排空当前活动色后重启，不重建镜像（svc 默认 all）
  stop             排空当前活动色后停止，超时保留容器
  status           显示所有容器状态
  logs [svc]       跟踪日志（svc 不指定则跟踪所有）

示例:
  ./sep-deploy.sh deploy-web          # 前端代码有更新
  ./sep-deploy.sh deploy-backend      # 后端代码有更新
  ./sep-deploy.sh restart sep-backend # 后端崩溃，快速重启
  ./sep-deploy.sh logs sep-web        # 查看前端日志

EOF
}

if [[ "${SEP_DEPLOY_LIBRARY:-false}" != "true" ]]; then
  error 'Legacy shared-host deployment is retired; use deploy/standalone/sep-deploy.sh'
  exit 2
fi
