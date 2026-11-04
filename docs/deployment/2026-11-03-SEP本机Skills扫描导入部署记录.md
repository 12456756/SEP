# SEP 本机 Skills 扫描导入部署记录

部署时间：2026-11-03 17:56（Asia/Shanghai）。目标服务器：`121.37.128.126`，站点：`https://sep.longdaoec.com`。

## 部署版本

- 应用源码提交：`156111539e42d4b6ff6edc51383e003e623ef14d`。
- 后端镜像：`sep-green-backend:156111539e42`，Image ID `sha256:2c3a20a40d075d0e3729c83bf88a47ecd548582aa900890877c970bb5b1f9209`。
- Web 镜像：`sep-green-web:156111539e42`，Image ID `sha256:a8522f806feaedddd381b0893d6607e083d7f0c3b40fa8fea2040093ac8833aa`。
- 本次采用独立服务器发布脚本和依赖复用 Dockerfile；部署适配文件的服务器端校验和保存在 `/www/sep/releases/156111539e42/deploy-overlay.sha256`。旧生产 GitHub Actions 与 `/opt/sep` 发布脚本没有用于这次部署。
- 源码压缩归档 SHA256：`05e1f6afc19ad71cde0330ab093a3c943988347a41e1b8a07570cdf95b73bf95`。

## 执行与回退保护

构建在服务器进行。第一次构建遇到 Docker 默认桥接设备缺失；第二次 Web 构建遇到容器 Corepack 试图联网取 pnpm。服务未进入维护。将构建设为无网络，并调整 Web Dockerfile 直接调用镜像内现有 npm 后重试，构建成功。

镜像完成后进入短暂维护：SEP 正式站点临时返回 503，`/sep-client/*` 下载入口和 Caddy 中既有 `LONGDAO-AI` 站点区块保持可用；等待 Gateway 请求与 BullMQ 队列空闲，以 TERM 停止旧进程。先备份，再执行数据库迁移与替换应用。备份和配置快照位于：

`/www/sep/backups/release-20261103-175634-156111539e42`

数据库 dump、业务文件归档和 Redis RDB 的 SHA256 校验全部通过。迁移前置检查确认实际生效的 sub2api billing endpoint 返回 HTTP 200，契约匹配；避免上线包含模型倍率计费改动后才发现模型调用不可用。两项新增 Prisma 迁移应用成功，`prisma migrate status` 显示 97 migrations、数据库 schema up to date。没有执行 down migration 或从旧备份覆盖新数据库。

## 部署后验证

- `sep-green-backend`、`sep-green-web`、PostgreSQL、Redis、Caddy 和 downloads 容器均健康；应用容器 RestartCount 为 0，重启策略为 `unless-stopped`。
- `/api/health/ready` 返回 200；Gateway 为 `ready`、未排空、活动请求为 0。公开域名首页和 readiness 均返回 200。
- `/sep-client/stable/latest.yml` 与 `latest-mac.yml` 返回 200。
- 无凭据 `/api/auth/me` 返回 401。Skills connector pairing 返回 503，运行配置 `SKILL_IMPORT_ENABLED=false`；未启用本机扫描导入。
- Caddy 的 SEP 入口恢复，旧的 `LONGDAO-AI` 配置区块与备份逐字一致。
- 部署前后有效计费契约检查均返回 HTTP 200；部署前运行计费服务、模型服务、计算额度及企业模型配置相关回归，共 4 个套件、85 项测试通过。
- 独立部署脚本模拟测试覆盖构建失败、迁移失败、开放流量后的失败恢复、TERM 超时；`deploy/production/test-sep-drain.sh` 通过。
- 未验证真实 SEP 客户端的本机目录扫描或实际安装包；本次部署不代表 Skill Import 已完成真实桌面端联调。

部署执行日志保存在服务器 `/www/sep/releases/156111539e42/deploy-final.log`。仅部署至新服务器，未对旧服务器共享基础设施执行操作。

## 2026-11-04 开启测试与实例 ID 修正

首次开启时实例 ID 配置为 `sep-prod-12137128126`，与正式客户端 0.4.0 内置受信配置 `sep-default` 不匹配，客户端在深链接解析时直接拒绝，Web 停留在“等待客户端”。已核对本机已安装安装包的版本、`sep-import` 协议注册及包内 `https://sep.longdaoec.com/api` 站点配置。

2026-11-04 09:52（Asia/Shanghai）将服务器 `/www/sep/deploy/release.env` 修正为：

```env
SKILL_IMPORT_ENABLED=true
SKILL_IMPORT_INSTANCE_ID=sep-default
SKILL_IMPORT_MIN_CLIENT_VERSION=0.4.0
```

变更前配置保存在 `/www/sep/backups/skill-import-instance-fix-20261104-095248/release.env`。持有部署锁，等待 Gateway 排空，以 TERM 停止旧后端，再仅重建后端；没有重建 Web、数据库、Redis、Caddy 或 sub2api。容器健康、容器内 `/api/health/ready` 与公网 readiness 均通过。

旧扫描会话的深链接仍包含旧实例 ID，必须取消并重新发起。当前 Web 的“扫描本机”创建会话后，用户还需点击“打开 SEP 客户端”才能唤起；随后客户端显示本机授权和配对码，网页才显示设备确认。配置核验不代表真实扫描上传已通过，本次未代替用户确认本机目录授权或上传文件。

## 2026-11-04 原生配对被 CSRF 拒绝修复

10:00:20 的后端日志确认正式客户端已发起 `POST /api/skill-import/connector/pairings`，返回 403。无 Origin 的原生诊断请求在容器内和公网均复现 `Missing Origin or Referer header`，因此这次故障发生在全局 CSRF Guard，尚未进入配对业务。客户端当时隐藏连接状态，又未显示通用配对失败，表现为没有反应。本机客户端当前未提交的原有变更仅涉及定时任务 UI，与该故障无关。

服务端仅对明确列出的 connector 方法和路径，在同时缺少 Origin/Referer 时交给既有签名、配对或 grant 协议验证；携带浏览器来源时仍校验来源。Web 的创建会话、确认设备、撤销设备等接口保持来源检查。增加生产 CSRF + 真实 Redis 的配对 HTTP 回归，覆盖原生配对成功、恶意来源拒绝和缺少 grant 拒绝。

- 服务端回归：CSRF 与 Skills HTTP 两套、85 项测试通过；本地 Nest 构建通过。
- 镜像基于线上归档 `156111539e42-ef16e10df141` 加入单独 CSRF 修复，未混入本地其他业务变更；新镜像 `sep-green-backend:156111539e42-skill-csrf-50bc60d1f458`。
- 服务器源码与构建日志位于 `/www/sep/releases/156111539e42-skill-csrf-50bc60d1f458/`；Guard 源码 SHA256 为 `50bc60d1f458de1c250fb6fbd107602720dbb9ea0b5733ba542b08d33726c838`。
- 10:21 首次发布因探针对不存在会话的错误码预期写为 `SESSION_NOT_FOUND`，而契约实际返回 `404 SESSION_EXPIRED`，触发自动回滚。修正探针后于 10:23 成功发布，配置备份 `/www/sep/backups/skill-import-csrf-20261104-102313/`。
- 持有发布锁、排空 Gateway 并以 TERM 停止后，仅替换后端。Web 容器 ID 未改变，未重建数据库、Redis、Caddy 或 sub2api。
- 上线验证：健康与公网 readiness 正常；原生未知会话配对返回协议层 `404 SESSION_EXPIRED`；恶意 Origin 返回 403；无 grant 命令返回 401。没有扫描或上传用户本机文件，真实授权页仍需用户操作验证。

客户端仓库另补充了首次配对不可重试失败时显示错误页的修复，20 项服务测试通过；正常后台扫描和可重试网络请求保持原行为。该改动当前仅在源码，尚未打包进入已安装的 0.4.0；现有 0.4.0 可继续测试服务端修复。
