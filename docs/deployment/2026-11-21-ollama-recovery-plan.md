# SEP 知识库 Ollama 恢复部署方案

日期：2026-11-21。状态：方案，尚未部署。适用服务器：`121.37.128.126`。

实施调整（2026-11-21）：首次恢复经 Quality Gates 后在服务器拉取镜像时，既有 Docker 镜像加速站连续出现 TLS handshake timeout，尚未启动 Ollama。因此实际实现改为 Actions 从官方 Docker Hub 获取已核实的稳定版 `ollama/ollama:0.40.16` 与 Node 22，记录 registry digest / image ID，导出后通过校验的归档传输。服务器导入并核对 image ID，Compose 使用包含完整 image ID 的独立本地标签，加 `--pull never`，不再经服务器镜像站下载软件镜像，也不覆盖其他服务使用的通用标签。BGE-M3 仍由服务器从官方模型仓库下载，模型摘要和别名保持不变。下文第 5 节保留最初直接拉取方案用于对照，执行以 `deploy/embedding/prepare-image-bundle.sh`、`upload.sh` 和 `manage.sh` 的实现为准；不得直接照用旧候选版本进行重装。

部署原则：模型服务与 SEP 应用独立管理。首次恢复后保持长期运行；SEP 日常发布只更新应用，不触发 Ollama 安装、模型下载、服务重建或模型升级。只有明确的模型服务维护任务才运行独立工作流。

CPU 兼容调整：服务器虚拟 CPU 未暴露 AVX/AVX2。软件镜像和权重导入后，标准 Ollama 0.40.16 在隔离推理时出现 SIGILL，未接入生产。实际部署通过 `Dockerfile.cpu` 保留官方 Ollama 服务程序，按官方固定源代码提交重新编译不使用 AVX/FMA/F16C 的 CPU runner，带 OpenBLAS。权重、模型名称和摘要保持不变。最终自建镜像使用内容 ID 派生标签和 SHA256 传输校验；不把“官方基础镜像 digest”冒充“自建镜像上游 digest”。

## 1. 目标与历史依据

恢复新文档向量化和向量检索，沿用平台已经配置的模型、1024 维向量、tokenizer 和 cosine 距离。

- `2026-11-03-SEP完整迁移部署手册.md` 第 2 节记录：旧站没有发现 Ollama 运行/停止容器及相关模型卷。
- `2026-11-03-SEP迁移部署执行记录.md` 后续事项第 4 条记录：迁移前服务已缺失，迁移没有额外部署；保留知识库数据、已有向量和分词资源。
- `embedding-service.md` 固定了模型摘要和 tokenizer；该文档的 `/opt/sep` 是旧部署目录。当前应用在 `/www/sep`，本方案将独立模型服务放在 `/www/sep-embedding`。
- 当前后端仍配置为调用 `http://sep-ollama:11434`，但服务不存在。名称解析失败是缺少服务的结果，不应通过修改公共 DNS 解决。
- 当前核心健康检查不执行 embedding 推理；核心健康正常不能作为本次成功标准。

本次不升级业务代码、不迁移数据库、不修改历史向量、不重新上传原件，不顺带清理镜像。恢复服务后，选定文档的人工重试会通过平台正常流程产生数据库写入；不能将这部分称为只读验收。

## 2. 已核实的基线

| 项目 | 当前情况或部署目标 |
| --- | --- |
| 服务器架构 | x86_64，8 个逻辑 CPU，约 30 GiB 内存 |
| 检查时可用内存 | 约 28 GiB，执行前重查，不代表持续保证 |
| 数据盘 | `/www`，检查时可用约 779 GiB |
| 当前生产提交 | `9309ea6b09659538d06fdfae5f5edac3b047b4fb`，执行时记录实际值 |
| 后端容器 | `sep-green-backend` |
| 生产网络 | `sep-migration-net`，已存在的 Docker bridge 网络 |
| 新服务名 | `sep-ollama` |
| Ollama 配置目录 | `/www/sep-embedding/deploy` |
| 模型持久目录 | `/www/sep-embedding/data`，挂载至容器 `/root/.ollama` |
| 部署证据目录 | `/www/sep-embedding/backups/<时间>`，root 专用 |
| 发布状态目录 | `/www/sep-embedding/state`，记录独立配置版本与镜像、模型摘要 |
| 模型服务部署锁 | `/www/sep-embedding/.deploy.lock`，与应用部署锁独立 |
| 模型来源标签 | `bge-m3:567m-fp16` |
| 平台使用别名 | `bge-m3:sep-790764642607` |
| 模型 manifest 摘要 | `7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab` |
| 模型权重摘要 | `daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c` |
| 模型权重体积 | 官方 manifest 记录 `1157671200` 字节，另需容器镜像和运行空间 |
| tokenizer 标识 | `BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181` |
| tokenizer 容器目录 | `/app/tokenizers/bge-m3/5617a9f61b028005a4858fdac845db406aefb181` |
| 初始资源限制 | CPU 上限 4 核，内存上限 8 GiB，单模型、并发 1 |
| 公网入口 | 无；不配置 ports，不修改 Caddy、不新增域名 |

两份 tokenizer 已在当前后端读取并验证，SHA256 为：

```text
tokenizer.json
21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08
tokenizer_config.json
a62b2b6784f990259fddef5f16388693a8043be4f69179e6a5257eeb3f9abac4
```

资源限制是试运行保护，不是吞吐承诺；初期先顺序处理文档，测试后再决定是否扩容。CPU-only 方案不需要安装 GPU 驱动或重启 Docker。

## 3. 架构和执行方式

```text
准备阶段：隔离网络 sep-embedding-stage
  验收探针 -> sep-ollama -> 持久模型目录
  此时生产后端无法通过生产网络访问新服务

接入阶段：额外加入已有 sep-migration-net
  SEP 后端 -> sep-ollama:11434 -> BGE-M3
      |
      +-> 现有 PostgreSQL / pgvector
```

用独立 Compose 项目 `sep-embedding` 管理新服务，避免执行主平台 Compose 的整体 up/down。镜像、模型准备和隔离验收成功后，才通过一个 Compose override 接入生产网络。

### 3.1 生命周期隔离

| 操作 | SEP 应用发布 | 模型服务维护 |
| --- | --- | --- |
| Actions 入口 | 现有 `Deploy to Production` | 独立手动 `Manage Embedding Service` |
| 触发方式 | 应用发布时手动触发 | 仅首次安装、显式升级或修复时手动触发 |
| Compose 项目 | 现有 SEP 应用项目 | `sep-embedding` |
| 配置、状态、数据 | `/www/sep` 下的应用专属目录 | `/www/sep-embedding` 下的独立目录 |
| 镜像版本 | 跟随应用代码版本 | 固定 Ollama digest，按独立发布记录维护 |
| BGE-M3 权重 | 不打进应用镜像，不随应用更新 | 一次下载，持久保存，显式升级才变更 |
| 停止、回滚、清理 | 只操作应用及其产物 | 只操作 Ollama 及其产物 |
| 应用发布时对模型的操作 | 最多执行只读检查 | 不重启、不 pull、不重建、不覆盖配置 |

隔离的是部署与维护生命周期，不要求现在拆成另一台服务器或另一个 Git 仓库。部署文件可放同一仓库的独立 `deploy/embedding/`；主应用发布脚本不读取、上传或应用该目录。模型维护有自己固定的配置提交/发布版本，不因 main 的业务提交推进而更新。

共享内网只是让后端访问 HTTP 服务，不表示共享 Compose 生命周期。SEP 发布不能删除共享网络、执行模型服务 Compose、清理模型镜像/目录；模型维护不能重建前后端、重启数据库或修改应用 release.env。模型停服会影响知识库能力，独立部署不能消除这项业务依赖；同机 CPU、内存和磁盘仍共享，需要保留资源限制。

### 3.2 独立发布入口

正式执行继续经 GitHub Actions：新增独立手动工作流 `Manage Embedding Service`（建议文件名 `deploy-embedding.yml`），不得直接复用会重建前后端的现有 `Deploy to Production`。该工作流属于后续实施内容，当前仓库还没有。要求如下：

1. 首次从经审查的 origin 提交检出，记录独立模型服务配置版本；本地校验和工作流内专项检查覆盖 Compose、镜像固定、模型摘要与探针，不要求每次业务发布重跑模型部署。应用 Quality Gates 不调用模型维护工作流。
2. 使用独立并发组 `sep-embedding-deploy`，`cancel-in-progress: false`；模型服务升级串行执行，与应用发布没有相互触发或完成依赖。
3. 复用现有 SERVER_HOST / SERVER_USER / SERVER_PORT / SERVER_SSH_KEY，固定服务器及 known_hosts，不输出密钥或完整环境变量。
4. 将已审查的配置和探针上传至独立目录；服务器主动拉取固定版本的 Ollama 镜像和指定模型；超时只停止准备，不切生产网络。
5. 远程使用独立 `/www/sep-embedding/.deploy.lock` 的 flock 独占锁，覆盖准备、验收和接入；应用脚本不获取该锁。首次恢复若发现已有容器、配置或模型，则停止核查，不能覆盖已有模型。需要中断知识库能力的后续维护另选低峰窗口，避免与应用切换同时进行；不通过共用发布流程实现协调。
6. 分阶段记录开始、结束、耗时和失败原因；避免在切换时强制取消。拉取重试只能重试网络下载，不允许无限重复接入、文档重试或改写别名。
7. GitHub Summary 报告镜像 digest、模型 digest、验收结果和服务器证据目录，不上传文档内容、私有配置或原件。
8. 本文第 4 至 11 节属于首次恢复流程；安装成功后不能原样重跑作为日常发布。日后分别设计显式的状态检查、Ollama 软件升级和模型升级入口，默认只读，不因重复点击检查而重新拉模型。

下面是该工作流需要执行的服务器操作规范。不是要求用户现在手动绕过 Actions 上线。

## 4. 预检查与证据保留

以下 Bash 命令均在目标服务器 root 会话中执行，`set -euo pipefail` 表示任何检查失败就停止。先确认没有其他部署占用锁，再执行写操作。

```bash
set -euo pipefail
test "$(id -u)" = 0
test "$(findmnt -n -o SOURCE /www)" = /dev/sdb1
docker network inspect sep-migration-net >/dev/null
install -d -m 700 /www/sep-embedding
exec 9>/www/sep-embedding/.deploy.lock
flock -n 9
if docker container inspect sep-ollama >/dev/null 2>&1; then
  printf 'Existing sep-ollama container requires investigation\n' >&2
  exit 1
fi
for target in /www/sep-embedding/deploy /www/sep-embedding/data; do
  if test -e "$target"; then
    printf 'Existing deployment path requires investigation: %s\n' "$target" >&2
    exit 1
  fi
done
df -h /www
free -h
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
cat /www/sep/.deploy/active-release
```

如果已存在 Ollama 容器、目录或部署配置，应先查明归属与状态，转入维护/续跑流程，不删除目录后强行重做。上述 CPU、内存、磁盘以执行当时值判断：预留镜像下载、模型、日志和正常业务空间；不因“磁盘够”而忽略运行内存。

部署记录保存：当前提交、当前健康状态、容器镜像名/ID、网络名、本次配置/探针 SHA256、操作者与时间。只备份本次会修改的独立配置，不把主平台 .env 或 backend.env 输出到日志。失败文档的人工重试前使用现有数据库备份策略留存备份，不恢复旧数据覆盖新写入。

## 5. 选择并固定 Ollama 镜像

首个候选为 `ollama/ollama:0.33.1`，原因是项目曾用该版本做本地测试，不表示当前 Linux 容器已经验收。该版本的官方 release 存在；最终镜像摘要需要实际拉取后获取，方案不编造 SHA256。

```bash
docker pull ollama/ollama:0.33.1
OLLAMA_IMAGE_PIN=$(docker image inspect ollama/ollama:0.33.1 --format '{{index .RepoDigests 0}}')
[[ "$OLLAMA_IMAGE_PIN" =~ ^ollama/ollama@sha256:[a-f0-9]{64}$ ]]
printf '%s\n' "$OLLAMA_IMAGE_PIN"
docker pull node:22-bookworm-slim
PROBE_NODE_IMAGE_PIN=$(docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}')
[[ "$PROBE_NODE_IMAGE_PIN" =~ ^node@sha256:[a-f0-9]{64}$ ]]
printf '%s\n' "$PROBE_NODE_IMAGE_PIN"
```

将结果写入独立配置目录的 `.env`，内容只有非敏感镜像引用：

```dotenv
OLLAMA_IMAGE=ollama/ollama@sha256:<上一步实际获取的64位摘要>
PROBE_NODE_IMAGE=node@sha256:<独立探针镜像实际获取的64位摘要>
```

`<...>` 必须替换为实际值，不得照抄。digest 固定的是 Ollama 软件镜像；后面验证的模型 manifest digest 固定的是 BGE-M3 模型，两者不是同一个东西。候选镜像无法拉取或验收失败时停止，另行选定版本并重新验证，不自动切换 latest 或陌生镜像站。

Node 镜像仅用于临时验收探针，固定 digest 后使用，任务结束即删除临时容器，不是模型服务的运行依赖。隔离验收不借用 SEP 后端镜像或构建工具；SEP 以后升级或清理镜像不会破坏模型服务的部署工具。

若服务器访问官方仓库太慢，可在可信构建机拉取同一镜像，docker save 后传输、校验 SHA256，再 load；保存上游 digest 和 image ID 的对照，验证导入结果，不只相信文件名。只传递 Ollama 镜像，不整体覆盖服务器镜像库。

## 6. 隔离配置

实施时创建 `/www/sep-embedding/deploy`（权限 0700）和全新的 `/www/sep-embedding/data`（权限 0700），确认是本次目标路径，不能覆盖现有目录。Compose 文件由仓库独立的 `deploy/embedding/` 经模型服务 Actions 传送，不在日志中拼接秘密，不放进会被应用发布覆盖的配置文件。

`compose.yaml` 内容：

```yaml
name: sep-embedding
services:
  ollama:
    image: ${OLLAMA_IMAGE:?Set the verified immutable image digest}
    container_name: sep-ollama
    restart: unless-stopped
    cpus: "4.0"
    mem_limit: 8g
    memswap_limit: 8g
    environment:
      OLLAMA_HOST: 0.0.0.0:11434
      OLLAMA_NUM_PARALLEL: "1"
      OLLAMA_MAX_LOADED_MODELS: "1"
      OLLAMA_MAX_QUEUE: "16"
      OLLAMA_NO_CLOUD: "1"
    volumes:
      - /www/sep-embedding/data:/root/.ollama
    networks:
      stage: {}
    healthcheck:
      test: [CMD, ollama, list]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
  probe:
    image: ${PROBE_NODE_IMAGE:?Set the verified immutable probe image digest}
    profiles: [tools]
    entrypoint: [node]
    restart: "no"
    networks:
      stage: {}
networks:
  stage:
    name: sep-embedding-stage
  sep:
    name: sep-migration-net
    external: true
```

`compose.production.yaml` 内容（此阶段先不启用）：

```yaml
services:
  ollama:
    networks:
      sep:
        aliases: [sep-ollama]
```

两份配置合并后保留 stage 网络，并额外加入 sep 网络。只执行第一份配置时不会接入生产。stage 网络允许出站下载；不使用 internal 网络阻断模型下载。没有 ports，宿主机和公网不发布 11434。生产同网络的容器可以访问服务，这不是细粒度权限隔离，后续网络隔离可单独设计。

`ollama list` 健康检查只代表 API 能响应；模型与向量能力由后续探针判断。

```bash
cd /www/sep-embedding/deploy
docker compose --env-file .env -f compose.yaml config -q
docker compose --env-file .env -f compose.yaml -f compose.production.yaml config -q
docker compose --env-file .env -f compose.yaml up -d --no-deps ollama
docker inspect sep-ollama --format '{{.State.Health.Status}}'
docker logs --tail 60 sep-ollama
```

等待健康后，确认 `docker port sep-ollama` 没有输出，生产网络中暂时没有 sep-ollama。冷启动失败或 OOM 时先查日志和容器状态，不把资源限制无限放大。

## 7. 准备模型并核验

```bash
docker exec sep-ollama ollama pull bge-m3:567m-fp16
docker exec sep-ollama ollama list
```

下载完成后必须核验完整模型摘要。使用独立 Node 镜像临时启动探针容器，不借用 SEP 后端镜像、不挂载业务目录、不读取生产 .env：

```bash
cd /www/sep-embedding/deploy
docker compose --env-file .env -f compose.yaml run --rm -T --no-deps probe - <<'NODE'
const assert = require('node:assert/strict');
(async () => {
  const r = await fetch('http://sep-ollama:11434/api/tags', { signal: AbortSignal.timeout(10000) });
  assert.ok(r.ok, `tags HTTP ${r.status}`);
  const data = await r.json();
  const model = data.models?.find(m => m.name === 'bge-m3:567m-fp16');
  assert.equal(model?.digest, '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab');
  console.log('PASS: source model manifest matches the platform baseline');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
NODE
```

同时在宿主机模型存储目录中核验权重文件：

```bash
printf '%s  %s\n' \
  daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c \
  /www/sep-embedding/data/models/blobs/sha256-daec91ffb5dd0c27411bd71f29932917c49cf529a641d0168496c3a501e3062c \
  | sha256sum --check
```

两项通过后才创建发布别名：

```bash
docker exec sep-ollama ollama cp bge-m3:567m-fp16 bge-m3:sep-790764642607
```

禁止在已经运行的生产服务上随意 pull 覆盖发布别名。摘要变化应使用新别名、兼容性验证和索引发布方案，不能只改数据库模型字段。

## 8. 隔离验收

下面探针实施时保存为配置目录中的 `verify-embedding.cjs`，纳入 Git 审查。只输出状态、耗时和向量维度，不输出原始向量、用户资料或密钥。

```javascript
const assert = require('node:assert/strict');
const base = 'http://sep-ollama:11434';
const model = 'bge-m3:sep-790764642607';
const digest = '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab';
async function embed(input) {
  const started = Date.now();
  const response = await fetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model, input, truncate: false, keep_alive: '5m' }),
  });
  return { response, elapsedMs: Date.now() - started };
}
async function check(input) {
  const { response, elapsedMs } = await embed(input);
  assert.ok(response.ok, `embed HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.model, model);
  const expectedCount = Array.isArray(input) ? input.length : 1;
  assert.equal(body.embeddings?.length, expectedCount);
  for (const v of body.embeddings) {
    assert.equal(v.length, 1024);
    assert.ok(v.every(n => typeof n === 'number' && Number.isFinite(n)));
    assert.ok(v.some(n => n !== 0));
  }
  console.log(JSON.stringify({ check: 'embed', count: expectedCount, dimension: 1024, elapsedMs, status: 'passed' }));
}
(async () => {
  const tags = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10000) });
  assert.ok(tags.ok, `tags HTTP ${tags.status}`);
  const list = await tags.json();
  assert.equal(list.models?.find(m => m.name === model)?.digest, digest);
  await check('知识库服务部署验证');
  await check(['员工可以查询企业知识库。', '出差申请需要主管审批。']);
  await check(Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段合成部署验收文本。`));
  const oversized = await embed('test '.repeat(20000));
  assert.equal(oversized.response.status, 400, 'Oversized input must be rejected as an input error');
  const failure = await oversized.response.text();
  assert.match(failure, /context|length|token|input.*long/i);
  console.log(JSON.stringify({ check: 'oversized-input', status: 'passed' }));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
```

注意：超长输入探针不修改生产上下文配置，要求返回明确的输入超限错误，不能将超时、连接失败或 5xx 当成通过。若候选模型的真实上下文上限发生变化，停止核对模型配置与摘要，调整合成超长输入后重新验收，不能直接删掉此项宣称通过。仅验证维度不等于已经验证真实语义准确率。

```bash
cd /www/sep-embedding/deploy
docker compose --env-file .env -f compose.yaml run --rm -T --no-deps probe - < verify-embedding.cjs
docker stats --no-stream sep-ollama sep-green-backend sep-green-web
docker inspect sep-ollama --format 'OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}}'
```

增加 8 段接近实际切片上限的合成中文文本批次测试，并记录冷启动、热请求耗时；不使用企业原件。初步接入门槛为各请求不超过现有 120 秒超时且无 OOM/重启。性能目标需根据实际查询体验另定，不能用“低于 120 秒”表示交互延迟合格。

## 9. 接入生产前最后核对

再次检查后端生效环境，只读白名单字段，不打印全部环境：

```bash
docker exec sep-green-backend printenv \
  EMBEDDING_PROVIDER EMBEDDING_BASE_URL EMBEDDING_MODEL EMBEDDING_MODEL_DIGEST \
  EMBEDDING_TOKENIZER EMBEDDING_TOKENIZER_PATH EMBEDDING_DIMENSION EMBEDDING_DISTANCE \
  EMBEDDING_BATCH_SIZE EMBEDDING_TIMEOUT_MS
```

预期为 ollama、sep-ollama 地址、固定别名/摘要、当前 tokenizer、1024/cosine、batch=8、timeout=120000。tokenizer 校验按第 2 节已知值重做；只读检查数据库扩展、vector(1024) 列和有效 HNSW 索引，优先使用该线上提交的 `deploy/production/postgres/verify-knowledge-schema.sql`，不运行修复 SQL 或迁移。

以下读取现有 tokenizer 文件校验值，由操作者与第 2 节比较；不会下载或覆盖文件：

```bash
docker exec sep-green-backend sha256sum \
  /app/tokenizers/bge-m3/5617a9f61b028005a4858fdac845db406aefb181/tokenizer.json \
  /app/tokenizers/bge-m3/5617a9f61b028005a4858fdac845db406aefb181/tokenizer_config.json
SEP_ACTIVE_SHA=$(cat /www/sep/.deploy/active-release)
[[ "$SEP_ACTIVE_SHA" =~ ^[a-f0-9]{40}$ ]]
SEP_SCHEMA_CHECK="/www/sep/releases/$SEP_ACTIVE_SHA/source/deploy/production/postgres/verify-knowledge-schema.sql"
test -s "$SEP_SCHEMA_CHECK"
docker exec -i sep-postgres psql -X -U sep_admin -d sep_prod \
  -v ON_ERROR_STOP=1 --single-transaction -c 'SET TRANSACTION READ ONLY' -f - < "$SEP_SCHEMA_CHECK"
```

若线上源码目录不存在，使用经审核且与线上提交匹配的检查 SQL；不改生产数据来让检查通过。

如果环境不匹配则停止。不要为了本次恢复顺带更改模型、tokenizer 或数据库结构。

## 10. 接入生产网络

安排低业务时段，确认没有待执行的知识库作业会在接入后意外开始大量处理；若有待处理作业，先确认范围和负载。此刻新服务将开始对生产查询和自动重试作业可见。

```bash
cd /www/sep-embedding/deploy
docker compose --env-file .env -f compose.yaml -f compose.production.yaml up -d --no-deps ollama
docker inspect sep-ollama --format '{{json .NetworkSettings.Networks}}'
docker port sep-ollama
docker exec -i sep-green-backend node - < verify-embedding.cjs
```

执行时 Compose 可能因网络配置变化重建新 Ollama 容器，这是预计行为；持久模型目录保持不变。探针会重新验证冷加载和真实后端网络。若探针失败立即隔离新服务，不让用户反复点击重试。

后端地址、模型配置均未变化时，无需重启前后端。不要执行主平台的 `docker compose down`。若后续排查确实需要重启后端，按已有 Gateway 排空和受控发布流程单独处理，不能直接强制重建 Worker。

## 11. 业务验收

1. 先用授权测试账号上传一份无敏感内容的合成 TXT，记录文档 ID，确认 PENDING -> PROCESSING -> READY；不以“切分完成”作为成功。
2. 在数据库只读核对该文档已发布的版本、profile、切片总数、embeddingModel、向量非空数量；不把正文、文件名或企业信息发到 CI 日志。
3. 在该测试账号授权的范围检索合成内容，确认向量或混合检索未降级为纯词法、引用来自该文档；无权限账号不能访问来源。
4. 顺序重试用户已确认的两份失败 TXT，等待第一份完成后再处理第二份。重试会重新运行正常处理流程，不要求重新上传，切片数量以实际重处理结果为准。
5. 失败新版本不得删除旧生效版本；若返回模型/profile 不匹配，停止调查，不修改历史字段绕过校验。
6. 不重建全部历史索引、不批量重试无关企业文档。合成文档清理由后续明确约定执行。

服务稳定观察至少 30 分钟，记录 CPU、内存、重启次数、embedding 错误数、处理用时和查询延迟；至少覆盖一次模型从内存卸载后的冷加载。生产机器重启演练另安排窗口，不为验证新服务随意重启整机。

## 12. 失败回退

隔离阶段失败：新服务还没有接入生产网络，停止独立 Compose 服务，保留模型与日志供排查，主平台保持原状态。

接入后故障：先记录当前任务和日志，再停止新 Ollama 服务，阻止继续占用资源或提供错误结果：

```bash
cd /www/sep-embedding/deploy
docker compose --env-file .env -f compose.yaml -f compose.production.yaml stop ollama
```

回退目标是回到本次部署前“向量化不可用”的状态，不是自动获得另一个可用向量服务。队列中的正常任务可能重试/失败，需记录并后续按版本流程恢复。已成功发布的文档和新增向量保留，不恢复旧数据库覆盖它们。

需要彻底断开生产网络时，在容器停止后用 Compose 仅第一份配置重建到 stage 网络；不要全局删网络、删卷、清空模型目录或运行 `docker system prune`。排查完成前保留镜像、模型和验收记录。

## 13. 后续维护与防复发

- 独立服务配置、验收探针、Actions 工作流提交到 origin；镜像 pin 纳入审核，服务器对应文件记录 SHA256。可同仓保存，但独立发布记录不跟随应用镜像标签。
- 两套服务分别使用自己的 Compose 项目、目录、发布状态、部署锁与 Actions 并发组。应用发布流程不调用模型工作流，不更新模型配置或权重。模型首次安装后可长期运行，不随每次应用发布重建。
- 只读监测与部署分开：SEP 发布时发现模型不可用应报告知识库状态，不能自动执行安装、拉取、升级或重启来修复。显式模型维护才操作该服务。
- Docker 健康检查只验证 API 存活；另设独立知识库告警，短探测检查 DNS、/api/tags 和模型摘要，较低频率用合成文本验证真实向量化。监控使用私网入口，不开放公网服务。
- 发布时明确列出“核心服务健康”和“知识库向量化验收”两项结果；专项探测失败应报告能力降级，不把整个应用 liveness 改成失败引发重启循环。
- 监控配置需实际接入公司现有告警接收渠道后才算完成；本方案不假设目前已有告警平台。
- 模型目录纳入备份/重建策略，保存固定 manifest、权重摘要、镜像 digest 和配置。首次验收后安排低峰离线复制/校验模型存储，备份需覆盖 .ollama 下的完整结构并限制权限。
- 新镜像与新模型是两种升级：分别验证，不自动追随 latest，不定时覆盖发布别名，不为清理镜像删除当前 Ollama 镜像或所需回退产物。

## 14. 最终交付和通过条件

| 交付项 | 完成标准 |
| --- | --- |
| 服务 | sep-ollama 运行健康、资源受限、日志轮转、可自动重启 |
| 暴露范围 | 无公网 11434、无新增域名，后端经 Docker 私网访问 |
| 持久化 | 模型位于 /www/sep-embedding/data，容器重建后仍可使用 |
| 生命周期隔离 | SEP 发布、回滚和清理均不操作模型服务；模型发布不重建 SEP 应用 |
| 可追溯性 | 软件镜像 digest、模型 manifest/权重 digest、配置提交与 SHA256 留档 |
| 技术验收 | 摘要、单条/批量 1024 维有限向量、超限拒绝、冷加载及资源检查通过 |
| 数据层 | 原有 tokenizer 校验、向量列和索引只读检查通过 |
| 业务验收 | 合成文档 READY、向量检索有效、来源权限正确、指定失败文档恢复 |
| 稳定性 | 观察期无 OOM/反复重启，无持续 embedding 错误；延迟实测记录 |
| 运维 | 独立 Actions 可追溯，告警接入和模型备份有结果或明确未完成项 |

实施前还没有验证的内容：候选 Ollama Docker 镜像在服务器的实际拉取和 digest、CPU 吞吐、真实向量输出、业务文档恢复、告警接收和模型备份恢复。不得将本方案或已有 tokenizer 校验视为这些事项已经通过。

## 15. 来源

- [迁移执行记录](2026-11-03-SEP迁移部署执行记录.md)
- [完整迁移手册](2026-11-03-SEP完整迁移部署手册.md)
- [项目 Embedding 指南](embedding-service.md)
- Ollama 官方仓库 `docs/docker.mdx`、`docs/faq.mdx`，2026-11-21 查阅，确认 CPU 容器、持久模型目录和配置项；部署时仍核对所选版本支持情况。
- 官方 `v0.33.1` release 元数据已查询；不据此宣称同版本生产镜像已测试。
- 官方模型 registry 的 `library/bge-m3/manifests/567m-fp16` 已重新获取并计算 SHA256，与项目基线一致；执行时再次核验。
