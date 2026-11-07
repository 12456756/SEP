# 硅基员工平台 (Silicon Employee Platform)

> **企业 AI 员工管理平台** —— 像招聘员工一样订阅 AI，为企业提供即插即用的数字员工服务

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10-red)](https://nestjs.com/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org/)
[![License](https://img.shields.io/badge/License-MIT-green)]()

---

## 📖 项目概述

硅基员工平台（SEP）是一个面向企业的 AI 员工管理和调用平台。企业可以在平台上：
- **招聘 AI 员工**：从人才市场浏览、试用、订阅适合的数字员工
- **组织管理**：建立部门、分配成员、授权员工使用权限
- **按量计费**：统一的算力账户，按实际调用量计费
- **客户端调用**：通过桌面客户端（sep-client）与 AI 员工对话，完成业务任务

---

## ✨ 核心功能

### 企业端（企业用户）
- 🏢 **企业组织管理**：部门、成员、角色权限
- 🤖 **AI 员工市场**：浏览、搜索、订阅数字员工
- 👥 **员工实例管理**：创建实例、配置、授权给部门/成员
- 💰 **算力账户**：充值、消费记录、余额预警
- 📊 **数据看板** ✅：关键指标、消费趋势图、热门员工、最近活动
- 🎴 **我的员工** ✅：卡片布局、搜索筛选、在线状态、快捷操作
- 🎯 **新手引导** ✅：5步 Onboarding（创建部门→邀请成员→招聘员工）

### 运营端（平台管理员）
- 🏭 **企业管理** ✅：查看企业详情、充值/扣减算力、冻结/解冻
- 💳 **算力管理** ✅：全平台充值/消费记录、筛选导出 CSV
- 👨‍💼 **员工管理** ✅：创建员工、发布上架、审核流程（支持开发者提交）
- 🔗 **能力绑定** ✅：多对多绑定、拖拽排序、启用/禁用、JSON 配置
- 📈 **数据看板**：平台级统计、Top 10、异常监控（待开发）

### 客户端（桌面应用 sep-client）
- 🔐 **设备登录**：邮箱密码 + 设备指纹，生成 refresh token
- 📋 **实例列表**：获取当前用户被授权的 AI 员工实例
- 🎫 **实例令牌**：用 refresh token 换取实例级短期令牌（15分钟）
- 💬 **模型网关**：通过网关调用 AI 模型，自动计费

---

## 🚀 快速开始

### 前置依赖

- **Node.js** ≥ 20
- **pnpm** ≥ 9
- **Docker** + **Docker Compose**（本地数据库）
- **PostgreSQL** 16+（如果不用 Docker）

### 1. 克隆仓库

```bash
git clone <repository-url>
cd SEP
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

复制示例文件：
```bash
cp backend/.env.example backend/.env
cp web/.env.local.example web/.env.local
```

编辑 `backend/.env`，填写必要配置：
```env
DATABASE_URL="postgresql://sep_user:sep_pass@localhost:5432/sep_platform"
JWT_SECRET="your-secret-key-change-in-production"

# sub2api 配置（AI 模型中转站）
SUB2API_BASE_URL="https://ai.longdaoec.com/v1"
SUB2API_API_KEY="sk-your-key"
SUB2API_DEFAULT_MODEL="gpt-3.5-turbo"

# Embedding 服务配置（知识库向量化）
# 本地与生产统一使用 Ollama 的 OpenAI-compatible 接口
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL="http://127.0.0.1:11434/v1"
EMBEDDING_MODEL="bge-m3:latest"
EMBEDDING_API_KEY="ollama-local"
EMBEDDING_DIMENSION=1024
EMBEDDING_BATCH_SIZE=32
EMBEDDING_TIMEOUT_MS=120000
```

> **📚 Embedding 服务说明**：知识库向量化依赖独立部署的 Ollama 服务和 `bge-m3:latest`。后端通过 Ollama 的 OpenAI-compatible `/v1/embeddings` 接口访问；容器部署时将 `EMBEDDING_BASE_URL` 设置为 Ollama 在 Docker 网络中的服务地址。详见 [Embedding 服务部署指南](docs/deployment/embedding-service.md)。


### 4. 启动数据库

```bash
docker-compose up -d
```

### 5. 初始化数据库

```bash
cd backend
npx prisma migrate deploy  # 应用迁移
npx prisma generate         # 生成 Prisma Client
npx prisma db seed          # 写入种子数据（可选，加 -- --reset 先清库）
```

### 6. 启动服务

**后端（端口 3001）**：
```bash
cd backend
npm run dev
```

**前端（端口 3000）**：
```bash
cd web
npm run dev
```

### 7. 访问应用

- **前端**: http://localhost:3000
- **后端 API**: http://localhost:3001
- **Swagger 文档**: http://localhost:3001/api
- **Prisma Studio**: `npx prisma studio`（端口 5555）

---

## 🧪 测试

### 后端测试

```bash
cd backend
npm test                    # 运行全部测试（168 个单元测试）
npm run test:watch          # Watch 模式
npm run test:cov            # 测试覆盖率
```

### 前端测试

```bash
cd web
npm test                    # Jest + React Testing Library（待补充）
```

---

## 📁 项目结构

```
SEP/
├── backend/                   # 后端 API（NestJS）
│   ├── prisma/
│   │   ├── schema.prisma      # 数据库 Schema
│   │   ├── migrations/        # 迁移文件
│   │   └── seed/              # 种子数据（统一入口 seed/index.ts）
│   ├── src/
│   │   ├── modules/           # 业务模块
│   │   │   ├── auth/          # 用户认证（JWT）
│   │   │   ├── enterprise/    # 企业组织管理
│   │   │   ├── digital-employee/  # 员工模板与包
│   │   │   ├── subscription/  # 订阅管理
│   │   │   ├── client/        # 客户端接入（P4）
│   │   │   ├── gateway/       # 模型网关（P4.3）
│   │   │   ├── admin/         # 运营端管理
│   │   │   └── ...
│   │   ├── shared/            # 共享类型、DTO、工具函数
│   │   ├── common/            # 通用组件（guards、decorators、pipes）
│   │   └── main.ts
│   └── package.json
│
├── web/                       # 前端（Next.js 15 App Router）
│   ├── src/
│   │   ├── app/
│   │   │   ├── (market)/      # 公开市场页（落地页、员工市场）
│   │   │   ├── (dashboard)/   # 企业用户端
│   │   │   └── (platform)/    # 运营端
│   │   ├── components/
│   │   │   ├── ui/            # 基础 UI 组件
│   │   │   └── ...
│   │   ├── features/          # 功能模块（hooks + API）
│   │   └── lib/               # 工具函数、API Client
│   └── package.json
│
├── docs/                      # 文档
│   ├── architecture/          # 架构设计文档
│   ├── plans/                 # 开发计划
│   ├──对接/                  # 对接文档（客户端、API）
│   └── progress/              # 开发日志
│
├── docker-compose.yml         # PostgreSQL 16
├── pnpm-workspace.yaml        # pnpm monorepo 配置
└── package.json               # 根 package.json
```

---

## 🗄️ 数据库

### 核心表结构

| 表名 | 说明 |
|-----|------|
| `users` | 用户基础信息 |
| `enterprises` | 企业组织 |
| `enterprise_members` | 企业成员（关联 user ↔ enterprise）|
| `departments` | 部门 |
| `digital_employees` | 员工模板（由开发者创建）|
| `employee_packages` | 员工包（版本化发布）|
| `employee_instances` | 员工实例（企业订阅后创建）|
| `employee_grants` | 授权记录（实例 → 部门/成员）|
| `compute_transactions` | 算力交易记录 |
| `devices` | 客户端设备（P4.1）|
| `platform_models` | 平台支持的 AI 模型 |
| `system_settings` | 系统配置（KV 存储）|

### 数据库命令

```bash
# 创建新迁移
npx prisma migrate dev --name your_migration_name

# 应用迁移（生产环境）
npx prisma migrate deploy

# 重置数据库（⚠️ 仅开发环境）
npx prisma migrate reset

# 可视化管理
npx prisma studio
```

---

## 🔌 API 文档

### 核心端点

#### 用户认证
- `POST /auth/register` - 注册
- `POST /auth/login` - 登录
- `POST /auth/refresh` - 刷新令牌
- `GET /auth/me` - 当前用户信息

#### 企业管理
- `GET /enterprise/my` - 我的企业信息
- `GET /enterprise/members` - 成员列表
- `POST /enterprise/members/invite` - 邀请成员
- `GET /enterprise/departments` - 部门列表

#### 员工市场
- `GET /marketplace` - 员工列表
- `GET /marketplace/:id` - 员工详情
- `POST /subscriptions` - 订阅员工
- `GET /subscriptions` - 我的订阅

#### 员工实例
- `GET /enterprise/instances` - 实例列表
- `POST /enterprise/instances` - 创建实例
- `GET /enterprise/instances/:id` - 实例详情
- `PATCH /enterprise/instances/:id` - 更新实例
- `POST /enterprise/instances/:id/grants` - 授权

#### 客户端接入（P4）
- `POST /client/auth/login` - 客户端登录
- `POST /client/auth/token` - 换取实例令牌
- `GET /client/instances` - 客户端实例列表
- `POST /gateway/v1/chat/completions` - 模型网关（OpenAI 兼容）

#### 运营端
- `GET /admin/enterprises` - 企业列表
- `GET /admin/enterprises/:id` - 企业详情
- `POST /admin/enterprises/:id/credit` - 充值/扣减
- `GET /admin/enterprises/compute/transactions` - 算力交易记录

完整 API 文档见：[/docs/对接/SEP客户端API文档.md](./docs/对接/SEP客户端API文档.md)

---

## 🛠️ 技术栈

### 后端
- **框架**: NestJS 10
- **ORM**: Prisma 6
- **数据库**: PostgreSQL 16
- **认证**: JWT (passport-jwt)
- **验证**: Zod
- **测试**: Jest + Supertest

### 前端
- **框架**: Next.js 15 (App Router)
- **语言**: TypeScript 5.3
- **样式**: Tailwind CSS 3.4
- **UI**: shadcn/ui + 自定义组件
- **状态管理**: TanStack Query (React Query)
- **表单**: React Hook Form
- **图表**: recharts（待集成）

### 基础设施
- **容器化**: Docker + Docker Compose
- **CI/CD**: 待配置
- **监控**: 待配置

---

## 📋 开发路线图

### ✅ 已完成

- [x] **P0-P2**: 企业组织基座 + 员工模板/实例 + 订阅授权
- [x] **P3**: 员工包管理（packageRef + ZIP 双模式）
- [x] **P4**: 客户端接入层（登录、令牌、实例列表、模型网关）
- [x] **UI**: 落地页 + 员工市场视觉优化
- [x] **运营端**: 企业管理 + 算力管理（充值/扣减、交易记录）

### 🚧 进行中（本周）

- [ ] **B.1**: Dashboard 数据可视化（图表、关键指标）
- [ ] **B.2**: 我的员工页卡片化
- [ ] **B.4**: 新手引导流程

### 📅 计划中

- [ ] **B.3**: 订阅管理优化（续费提醒、套餐对比）
- [ ] **A.1**: 运营端 Dashboard（平台级统计）
- [ ] **A.4**: 员工审核流程
- [ ] **E**: 知识库功能（差异化）
- [ ] **C**: 部署准备（Docker、日志、监控）

详见：[下一阶段开发计划](./docs/plans/下一阶段开发计划-企业端+运营端+知识库.md)

---

## 🤝 贡献指南

### Git 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新功能
fix: Bug 修复
docs: 文档更新
style: 代码格式（不影响功能）
refactor: 重构
test: 测试相关
chore: 构建/工具链
```

示例：
```bash
git commit -m "feat(admin): 企业管理+充值功能"
git commit -m "fix(gateway): 修复流式响应中断问题"
git commit -m "docs: 更新 README 和 API 文档"
```

### 开发流程

1. 从 `main` 分支创建功能分支
2. 开发 + 测试（确保测试通过）
3. 提交 PR，描述清楚改动内容
4. Code Review 通过后合并

---

## 📄 许可证

MIT License

---

## 📞 联系方式

- **文档**: `docs/` 目录
- **Issues**: GitHub Issues
- **API 文档**: http://localhost:3001/api（启动后端后访问）

---

## 🙏 致谢

本项目由 Claude Code (Opus 4.8) 辅助开发。

---

**最后更新**: 2026-07-30
