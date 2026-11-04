# SEP 独立服务器部署配置

本目录保存 2026-11-03 迁移到 `121.37.128.126` 后的实际 Compose 和 Caddy 配置。首次迁移复用原生产版本 `42fc2644a38b0e21566d28cd1f528f6e91321044` 的镜像，没有发布本地后续业务改动。

2026-11-03 后续将正式访问入口调整为 `https://sep.longdaoec.com`。Web 基于同一生产提交和既有依赖重新构建，更新构建时写入的 WebSocket 地址，镜像为 `sep-green-web:42fc2644a38b-domain-20261103`；后端保持原镜像。域名切换过程见 [域名切换记录](../../docs/deployment/2026-11-03-SEP域名切换记录.md)。

服务器配置目录为 `/www/sep/deploy`，业务数据位于 1TB 数据盘 `/www`。旧的 `deploy/production/sep-deploy.sh` 和 GitHub 部署工作流仍针对旧服务器共享基础设施；不要直接改 `SERVER_HOST` 后运行旧脚本。本目录新增的 `sep-deploy.sh` 是独立服务器发布入口，旧脚本仅作为生命周期函数库复用。

## 独立服务器发布

在本地将待发布提交归档，加入本目录已验证的部署文件，传到 `root@121.37.128.126:/www/sep/releases/<sha>/`，核对完整归档 SHA256 后解压至该目录的 `source/`。业务代码来自固定提交，不在服务器执行 git pull。部署脚本及配置若为待提交修订，须另行记录文件哈希。

```bash
cd /www/sep/releases/<sha>/source
SEP_RELEASE_SHA=<完整40位提交> bash deploy/standalone/sep-deploy.sh check
SEP_RELEASE_SHA=<完整40位提交> bash deploy/standalone/sep-deploy.sh deploy
```

如发布包含待提交修复，必须归档基线提交与全部修复文件，记录归档 SHA256，并使用 `SEP_RELEASE_TAG=<提交前12位>-<归档SHA256前12位>` 区分该构建；`SEP_RELEASE_SHA` 仍记录真实基线提交。`check` 和 `deploy` 使用同一组变量。脚本拒绝覆盖已存在的镜像标签；实际构建标签记录在备份的 `release-tag` 和 `/www/sep/.deploy/active-artifact` 中。

脚本固定使用新机 `/www/sep`、独立 Docker 网络和新域名；先检查健康、有效中转计费契约、队列及依赖基线，再构建。当前发布 Dockerfile 只适用于锁文件和全部 workspace package.json 与 `/www/sep/source` 原生产归档完全相同的版本；依赖变化会拒绝发布，届时应改用完整 Dockerfile 安装依赖。

构建成功后，SEP 短暂返回 503 和 Retry-After，客户端下载及线上 `LONGDAO-AI` 标记区块保持服务；排空并仅 TERM 停止旧应用后备份 PostgreSQL、Redis 和业务文件，应用增量迁移，再替换前后端。失败时先隔离新流量、确认新进程退出，按旧镜像恢复应用及持久配置；不反向迁移数据库，不恢复旧备份覆盖新数据。停止超时会保留维护状态，禁止强杀或启动第二套 Worker。

成功后镜像指针和显式功能开关保存于 `/www/sep/deploy/release.env`，版本记录位于 `/www/sep/.deploy/active-release`，备份保存在 `/www/sep/backups/release-*`。本机 Skills 导入默认关闭；正式客户端 0.4.0 测试配置为 `SKILL_IMPORT_ENABLED=true`、`SKILL_IMPORT_INSTANCE_ID=sep-default` 和 `SKILL_IMPORT_MIN_CLIENT_VERSION=0.4.0`。实例 ID 必须与客户端受信站点配置完全一致，不能只满足格式校验后任意命名，否则客户端会拒绝深链接。部署脚本会校验并保留这些设置。关闭时将开关改回 `false`，并排空、重建后端容器。

## 配置与数据

| 路径 | 用途 |
| --- | --- |
| `/www/sep/deploy/compose.yaml` | 与本目录相同的实际 Compose 配置 |
| `/www/sep/deploy/Caddyfile` | 与本目录相同的实际站点配置 |
| `/www/sep/deploy/.env` | 新 PostgreSQL 管理员和应用密码、`SEP_DATABASE_URL`；仅服务器保存 |
| `/www/sep/deploy/backend.env` | 从旧生产容器保留的完整环境变量；仅服务器保存 |
| `/www/sep/postgres` | PostgreSQL 实际 PGDATA |
| `/www/sep/redis` | 独立 Redis 持久化数据；SEP 使用 DB1 |
| `/www/sep/uploads` | 上传文件 |
| `/www/sep/packages` | 技能包文件 |
| `/www/sep/knowledge` | 知识库原始文件 |
| `/www/sep/downloads/sep-client/stable` | 客户端安装包和更新清单，下载入口与主站共用域名 |
| `/www/sep/tokenizers` | 只读分词资源 |
| `/www/sep/caddy/data` | Caddy 自动管理的站点证书和状态 |
| `/www/sep/backups` | 镜像、源码、数据库、文件和校验记录 |
| `/www/sep/source` | 原生产提交的源码归档，无 Git 工作区 |

Docker 镜像、构建缓存和容器日志使用系统盘 `/var/lib/docker`。数据库和业务文件通过显式 bind mount 存放在数据盘。PostgreSQL 18 镜像还会声明父目录匿名卷，实际 `PGDATA` 已明确设为并挂载到 `/www/sep/postgres`，不使用该匿名卷保存数据库。

服务器安装了本目录的 `docker.service.d/sep-data-mount.conf` 至 `/etc/systemd/system/docker.service.d/sep-data-mount.conf`，令 Docker 启动依赖 `/www` 数据盘挂载。安装后执行了 `systemctl daemon-reload` 并核验 `www.mount` 依赖，没有重启生产 Docker 或服务器。

`backend.env` 的 `JWT_SECRET`、`ACCESS_JWT_SECRET`、`REFRESH_TOKEN_PEPPER` 保留旧值，确保加密配置和已有认证数据兼容。Compose 显式覆盖 `DATABASE_URL`、`REDIS_URL`，应用数据库用户 `sep_app` 不具备超级用户权限。`.env`、`backend.env` 均应保持权限 `600`，不得提交到 Git。

后端容器名保持 `sep-green-backend`，因为原 Web 镜像的 API 转发目标已在构建时固化。更改容器名需要重新核对 Web 的转发配置。

## 日常查看

```bash
cd /www/sep/deploy
docker compose --env-file .env --env-file release.env -f compose.yaml --profile edge ps
docker compose --env-file .env --env-file release.env -f compose.yaml logs --tail 100 backend web
curl --fail --resolve sep.longdaoec.com:443:127.0.0.1 https://sep.longdaoec.com/api/health/ready
```

PostgreSQL、Redis、后端和前端均不向公网发布端口；Caddy 发布 80/443。不要把包含密码的 `docker compose config` 或环境变量完整输出粘贴到日志、聊天或 Git；检查配置语法使用 `docker compose --env-file .env --env-file release.env -f compose.yaml --profile edge config -q`。首次发布前尚无 `release.env` 时省略第二个 env-file 参数。

生产停止/重启需要先完成 Gateway 排空、等待活动请求归零，再发送 TERM；迁移时使用原生产脚本的生命周期函数完成。直接重建应用容器可能中断长请求，后续自动发布适配需要保留该机制。

## 客户端下载

下载服务使用 `downloads` 容器，只在内部网络监听，通过主站的 `/sep-client/*` 路径代理。入口为 `https://sep.longdaoec.com/sep-client/stable/`，无需新增 DNS；实际文件位于数据盘 `/www/sep/downloads/sep-client/stable/<version>/`，更新清单位于 `stable/latest.yml` 和 `stable/latest-mac.yml`。

只发布新版安装包，不迁移历史安装包。发布顺序为：干净源码快照构建、检查包内 API/Gateway/feed 和版本、上传到私有暂存目录、校验文件哈希、公开版本目录，最后原子替换两个更新清单。官网直链配置在 `web/src/config/client-releases.ts`；构建必须与已部署源码基线保持一致，不能随本次下载迁移发布工作区的其他业务修改。

当前发布版本 `0.3.3`；官网 Web 镜像为 `sep-green-web:42fc2644a38b-download-0.3.3`。旧下载域名通过 HTTPS 代理兼容更新检查。实际发布路径、构建来源与验证结果见 [客户端下载迁移与 0.3.3 发布](../../docs/deployment/2026-11-03-SEP客户端下载迁移与0.3.3发布.md)。

## 证书与旧入口

Caddy 使用域名自动 HTTPS，迁移时只将 `longdaosep.cn` 的既有证书、私钥和证书元数据导入新服务器的管理目录，没有迁移其他站点或共享 ACME 账户。导入证书到期时间为 **2027-01-14 12:24:10（Asia/Shanghai）**。后续自动续期需要域名公网解析与 80/443 的验证请求可以到达新 Caddy。

切换完成时 DNS 仍指向 `64.83.39.223`。旧服务器仅将 SEP 站点通过校验服务器证书的 HTTPS 代理到新服务器；新 Caddy 仅信任这个固定旧 IP 提供的代理来源信息。DNS 改为新 IP 后直连新服务器，确认缓存过渡完成后可以移除旧 SEP 入口及新配置中的旧 IP 信任项。

模型中转的当前有效设置为 `https://ai.longdaoec.com/v1`，由新服务器上的独立 sub2api 提供，Caddy 的 `LONGDAO-AI` 区块由该服务维护。SEP 发布必须读取并保留线上区块，不能覆盖为本地旧端口。旧机其余服务是否可释放需单独核查。

## 恢复与回滚边界

实际备份、校验结果和操作时间见 [迁移执行记录](../../docs/deployment/2026-11-03-SEP迁移部署执行记录.md)。迁移脚本和证据保存于服务器 `/www/sep/deploy`、`/www/sep/.migration` 及对应备份目录。

恢复时使用相同 PostgreSQL 18.4/pgvector 0.8.1 镜像和原应用版本，先恢复数据库与文件，核对表内容摘要、文件 SHA256 和 Redis 过期时间，再启动 Worker。

旧 SEP 应用已停止且禁止自动重启，旧 `sep_prod` 已设为 `ALLOW_CONNECTIONS false`。切勿仅启动旧容器或解除数据库限制来回滚。新站接受写入后，旧数据库已不再代表最新数据：需要先维护并排空新站，备份新站的数据库/Redis/文件，再设计数据回迁。服务器上保留的旧环境恢复脚本只负责进程和入口恢复，不执行数据回迁。

嵌入服务 `sep-ollama` 在迁移前即不存在，本次保留其原配置和知识库数据，没有部署模型或宣称嵌入能力恢复。未执行付费模型生成、实际邮件发送、支付或真实用户登录测试。
