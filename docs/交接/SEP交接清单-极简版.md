# SEP 交接清单（极简版）

交接人：姚瑞泉　|　日期：2026-11-04　|　详细版在 docs/交接/SEP项目交接文档.md，这份只放必需的。

## 一、地址

- **正式站**：https://sep.longdaoec.com（企业端、运营端同一个站，登录后按角色进不同界面）
- **接口文档**：https://sep.longdaoec.com/api/docs
- **客户端下载**：https://sep.longdaoec.com/sep-client/stable/
- **代码仓库**：github.com/yaoruiquan/SEP
- **服务器**：121.37.128.126，数据都在 /www/sep，配置在 /www/sep/deploy
- **模型中转**：https://ai.longdaoec.com/v1（同机独立服务，SEP 的模型调用都走它）

## 二、账号密码

| 名称 | 账号 | 密码 | 说明 |
|---|---|---|---|
| 平台运营账号 | （手填） | （手填） | 登录正式站进运营端；拿到先改密码 |
| 服务器 root | root | （手填） | SSH 登录 121.37.128.126 |
| 演示账号（本地） | 见种子文件 | Demo123456 | 跑 pnpm db:seed 生成，只用于本地演示；账号清单在 backend/prisma/seed/01-accounts.ts |
| 数据库等其他密码 | 不用记 | 不用记 | 都在服务器 /www/sep/deploy/.env 和 backend.env 里，要用上服务器看 |

⚠️ 真密码手填完，这份文件就别往群里发了。

## 三、怎么用

- **运营**：登录 → 企业管理（开企业、充值）→ 员工管理（上架员工）→ 算力管理（对账）。
- **企业管理员**：建部门、邀成员 → 市场订阅员工 → 建实例 → 授权给部门或成员 → 看钱包和用量。
- **普通成员**：登录 → 我的员工 → 点开用（聊天/任务）。用不了先找管理员查授权和余额，不是 bug。
- **本地跑起来**：pnpm install → docker-compose up -d → backend 里跑 prisma migrate deploy 和 db seed → 根目录 pnpm dev（前端 3000，后端 3001）。

## 四、部署（一句话）

新版打包传到服务器 /www/sep/releases/，用 deploy/standalone/sep-deploy.sh 先 check 再 deploy。备份在 /www/sep/backups。deploy/production/ 是旧脚本，不要用。

## 五、千万别动（3 条）

- **JWT 密钥别换**——换了全员登录和加密数据全废。
- **停服务先排空再停**，别强杀，别起第二套。
- **旧服务器 64.83.39.223 别碰**——已停用，不能拿它回滚。

## 六、还没完的事（2 件）

- **本机技能导入**：已开启，但真实扫描上传还没验完，别说已完成。
- **知识库向量化**：服务没部署，知识库传新文档建不了向量，要恢复看 docs/deployment/embedding-service.md。

## 七、出事了

- **先看健康检查**：https://sep.longdaoec.com/api/health/ready，不通就上服务器看 /www/sep/deploy 的容器状态和日志。
- **成员用不了员工**：九成是没授权或没余额，按第三部分查。
