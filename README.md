# 家庭食谱口述整理器

把家人嘴里"火候差不多就行""放一点点糖""揉到不粘手"这类口述，整理成**别人照着也能做出来**的食谱；同时**永久保留原始语音**，任何一条数字化结论都能一键回放到当时那句话。

依据：[`../项目文档.md`](../项目文档.md)

---

## 它解决什么

奶奶说"放一点点糖"，你说不清是多少。这套东西做的事只有一个：

> **把一句模糊的话，变成一条有依据、可复做、可追溯到原声的描述。**

关键不是"记下来"，而是"整理过程本身"：

- 每句模糊描述被抽成一条**待澄清条目**，有状态、有责任人、有下一步动作；
- 追问 + 答复（可以直接录一段语音回答）后才归纳成**可复做规格**；
- 每条规格都挂着原声片段，点一下就回到当时那句话；
- 别人按整理结果真做一遍，**失败会被打回**，重新进入整理回路。

---

## 闭环长什么样

```
录一段口述
   ↓
人工/自动转写
   ↓
在波形上框出"说不清"的那句话  ──→  生成待澄清条目
   ↓
向家人发出追问（可指定给谁）
   ↓
对方用文字或语音回答
   ↓
整理者归纳成可复做规格（数值/区间/判断标准/参照物 + 置信度）
   ↓
汇入草稿版本 → 提交 → 发布（必须写变更说明）
   ↓
另一位家人按食谱真做一遍
   ├── 成功 → 条目变成「已验证」（终态）
   └── 失败 → 按步骤逐条填偏差 → 自动定位环节、生成追问并指派人 → 回到上面继续
```

只有两个终态：**已验证** 和 **口语留白**（承认"这条真的说不清了"，也是合法结论）。所以任何条目最终都会收口，不会永远挂着。

---

## 快速开始

环境要求：**Node.js ≥ 22.5**（用到内置的 `node:sqlite`）、npm ≥ 10。

```bash
# 1. 安装依赖（npm workspaces，一次装齐前后端；
#    安装结束会自动生成 Prisma Client，无需手动执行 prisma generate）
npm install

# 2. 环境变量（默认值开箱即用，不需要任何外部服务）
cp .env.example .env

# 3. 建库 + 写入基线数据（可跳过 seed，直接注册新账号）
npm run db:migrate
npm run db:seed

# 4. 启动
npm run dev
```

打开 http://localhost:5173

用 seed 账号可以直接进去看：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `me@example.com` | `froa12345` | 所有者（整理者） |
| `nainai@example.com` | `froa12345` | 贡献者（外婆） |

也可以 `npm run setup` 一次性完成 install + generate + migrate + seed。

> 如果 5173 端口已被别的项目占用，`npm run dev` 会**直接报错退出**（而不是悄悄换端口让你打开错的应用）。
> 这时在 `.env` 里改 `WEB_DEV_PORT`，并让 `WEB_ORIGIN` 与它一致即可。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动后端（4000）与前端（5173） |
| `npm run build` | 构建前端到 `apps/web/dist` |
| `npm start` | 启动后端，并静态托管前端构建产物（单端口部署） |
| `npm run db:generate` | 生成 Prisma Client |
| `npm run db:migrate` | 执行迁移（增量、幂等） |
| `npm run db:migrate:new -- <name>` | 按 schema 变化生成新迁移 SQL |
| `npm run db:seed` | 写入基线数据 |
| `npm run db:studio` | Prisma Studio 可视化查看数据 |
| `npm run test` | 后端单元 + 接口 + 闭环集成测试 |
| `npm run test:e2e` | 浏览器端 UI 闭环测试 |
| `npm run typecheck` | 三个包全量类型检查 |
| `npm run backup` | 把数据库与音频打包成一个压缩包 |

---

## 结构

```
origin/
├─ packages/shared/          前后端共享的枚举、Zod 校验、规格校验器、模糊描述规则库
├─ apps/server/              后端：Express + Prisma + Socket.IO
│  ├─ prisma/schema.prisma   数据模型（唯一真相）
│  ├─ prisma/migrations/     迁移 SQL（由 migrate diff 从 schema 生成）
│  ├─ scripts/migrate.mjs    迁移执行器（node:sqlite，无原生依赖）
│  ├─ src/modules/           auth / workspace / recipe / version / audio / vagueItem / ...
│  └─ tests/                 spec 单测 + closed-loop 集成测试
├─ apps/web/                 前端：React 18 + Vite + TanStack Query + antd
│  ├─ src/components/        Waveform / GlobalPlayer / AudioRecorder / SpecEditor
│  ├─ src/features/          录音工作台 / 追问台 / 草稿编辑器 / 版本差异 / 复做验证
│  └─ e2e/                   Playwright 闭环用例
└─ data/                     运行时生成：app.db、audio/、backups/
```

---

## 几个设计决定

**音频永远是证据，文字只是结论。** 音频只增不删（删除是软删除），入库时算 SHA-256，并提供完整性巡检（`INTEGRITY_SCAN_INTERVAL_MIN`，默认关闭）。数据库里删了，文件还在；文件丢了，巡检会报出来。

**结论必须能追溯，否则写不进去。** 每条可复做规格都要有证据：关联一个原声片段，或记录一位答复人。客户端和服务端用的是同一份校验器（`packages/shared/src/spec.ts`），规则只有一处。

**"暂定"的结论不允许发布。** 归纳规格时如果置信度是"暂定"，发布会被拦下来，必须先确认或标记为口语留白。这样版本历史里不会混进没核实过的数字。

**复做失败不是终点，是回路。** 复做出偏差时按**步骤**逐条填（哪一步、哪类问题、问谁），每条偏差会自动定位到具体环节：识别分类（复用模糊描述规则库）、生成追问话术、指派给这一步上次的答复人或原声提供者并发通知，直接生成一条"追问中"的待澄清条目；无法定位步骤的偏差则挂在整道菜层面。只有**受影响步骤**上的旧结论会被降级为"暂定"，没出问题的步骤不被牵连。复核没问题可以一键"重新确认"。

**已经发布的版本不可修改。** 要改就派生新草稿，改动会记进版本差异。发布必须写变更说明。当"谁在什么时候把'一点糖'改成了 3g、为什么"成为硬性要求，版本历史才有意义。

**贡献者不给下结论。** 家人（贡献者）可以录音、回答追问、提交复做验证，但不能改规格、不能发布版本 —— 避免多人同时改数字。这条如果不符合你的家庭习惯，改 `apps/server/src/services/access.ts` 里的角色要求即可。

**转写是加速器，不是必需品。** 默认 `ASR_PROVIDER=manual`：不调用任何外部服务，转写由人工录入，全流程照样跑通。想省事可以切 `whisper-local`（本机装 whisper）或 `openai`（需要 API Key）。

**参照物登记。** 先把"外婆家那只白瓷勺 = 一平勺 8g"量化一次存进空间，之后所有"半勺""一勺"都能换算成克。这是把模糊用量变成数值最有效的手段。

**并发编辑不会互相覆盖。** 步骤、用量、待澄清条目、版本都带 `updatedAt`。前端提交时回传它读到的时间戳；如果这期间别人改过，服务端返回 `409 EDIT_CONFLICT` 并附上最新内容，而不是静默覆盖。不传该字段时退化为"最后写入者胜"，方便脚本与旧客户端接入。

**数据和鉴权都不靠前端自觉。** 音频列表不指定食谱时只返回"我参与的空间"的数据；追问对象、@提醒对象必须是本空间成员；步骤引用的音频片段、用量引用的待澄清条目必须属于同一张食谱；食谱不能被 PATCH 搬到别的空间。这些都是服务端强校验，前端越权也拿不到。

**凡是接受 id 的写接口，都必须确认那个 id 属于调用者可访问的食谱。** 这是最容易被漏掉的一类漏洞：只要少校验一处，"整理结论时顺手写回用量"就能变成"改掉别人家的用量"。项目里有一个专门的回归用例，把 20 多个跨空间写入尝试逐一打一遍（详见 `regression.test.ts` 的「跨空间写入必须全面被拒」）。

**软删除只影响"看得见"，不影响"能回放"。** 从语音库删掉的音频仍然可以被引用它的结论回放 —— 否则"原始语音永久保留、结论永远能追溯到原声"就成了空话。完整性巡检同样会检查这些被隐藏的文件。

**口令入口有频次限制。** 登录与注册各自按 IP 做了 15 分钟 20 次的固定窗口限流（超限返回 `429 RATE_LIMITED`）。只限这两个入口，不影响 `/auth/me` 与 `/auth/refresh` —— 一家人常常共用出口 IP，限太宽会误伤自己人。

---

## 与《项目文档.md》的差异

实现过程中有三处主动偏离，都是为了"在本机真的能跑起来"：

| 项目 | 文档写的 | 实际实现 | 原因 |
| --- | --- | --- | --- |
| 波形组件 | WaveSurfer.js | 自研 canvas 波形（`Waveform.tsx`） | 峰值已存在数据库里，自绘更可控，少一个版本敏感依赖；框选片段的能力不变 |
| 迁移执行 | `prisma migrate deploy` | `prisma migrate diff` 生成 SQL + `node:sqlite` 执行器 | 本机 Prisma schema engine 无法启动；SQL 仍由 schema.prisma 生成，DDL 不会漂移。写入的是标准 `_prisma_migrations` 表，日后可用 `prisma migrate deploy` 接管 |
| 语言环境 | Node ≥ 20 | Node ≥ 22.5 | 迁移执行器用了内置 `node:sqlite`，换来零原生编译依赖 |
| 通知类型 | — | 增加 `verification_passed` | 复做成功原本复用了 `published`，通知里会显示成"版本动态"，语义不对 |

另外新增了一个文档里没有的接口 `POST /api/vague-items/:id/confirm`：复做失败后把降级为"暂定"的结论重新确认回"已确认"。没有它，那条闸门会把流程堵死。

---

## 测试

**接口层闭环**（`apps/server/tests/closed-loop.test.ts`，19 个断言组）覆盖：
建空间 → 邀人加入 → 建食谱（自动建草稿）→ 上传语音 → 框选片段 → 生成待澄清条目 → 规则识别 → 追问 → 语音回答 → 规格校验（缺证据/缺单位被拒）→ 权限边界 → 发布（缺变更说明被拒）→ 已发布版本不可改 → 复做失败自动打回 → 重新整理 → 草稿被"暂定"闸门拦下 → 复核确认 → 再发布 → 复做成功 → 终态 → 导出 Markdown → 越权访问被拒 → 音频软删除仍保留证据。

**回归测试**（`apps/server/tests/regression.test.ts`，30 个断言组）针对每一个修过的缺陷：
跨家庭音频隔离、跨空间写入全面拦截（20+ 个按 id 的越权尝试）、软删除音频仍可回放、版本差异能反映结论变化、`includeDeleted` 布尔解析、运维端点鉴权、乐观锁 409（含"冲突时不覆盖别人改动"）、食谱不可搬迁、导出链接带令牌、登录限流、跨食谱引用校验、空间外指派与 @ 被拒、以及 Prisma 错误码映射（改不存在的成员返回 404 而不是 500）。

**UI 层闭环**（`apps/web/e2e/closed-loop.spec.ts`）：在真实 Chrome 里从注册走到发布，包含在波形上拖拽框选片段，最后验证导出真的能下载。

```bash
npm run test        # 后端 60 个测试
npm run test:e2e    # 浏览器端 4 条用例（默认用系统 Chrome）
```

浏览器端除了闭环，还有两条覆盖面更广的用例：

- `all-pages.spec.ts`：把**每一个路由**分别在"整理者"和"只读旁观者"两种角色下打开一遍，
  断言页面渲染正常且控制台零报错 —— 按角色分支渲染最容易出问题；
- `recording.spec.ts`：用 Chrome 虚拟麦克风跑**真实录音**（MediaRecorder → Web Audio 解码出波形与时长 → 上传），
  确认时长不为 0、峰值已生成、校验和已落库。

> e2e 会自己起一个独立的服务实例（端口 4100、独立数据库 `data/e2e.db`），不会碰到你的开发数据。
> 如果机器上没有 Chrome：`npx playwright install chromium`，然后去掉 `playwright.config.ts` 里的 `channel: 'chrome'`。

---

## 部署

### 单机（推荐）

```bash
npm run build
NODE_ENV=production \
JWT_SECRET="$(openssl rand -hex 32)" \
WEB_ORIGIN=https://your.domain \
npm start
```

后端会同时托管前端构建产物，只需要开一个端口。

### Docker

```bash
docker compose up --build
# 数据持久化在 ./data，容器启动前会自动执行迁移
```

### 切换到 PostgreSQL

`apps/server/prisma/schema.prisma` 的 datasource 改为 `provider = "postgresql"`，然后：

```bash
DATABASE_URL="postgresql://user:pass@host:5432/froa" npm run db:generate
DATABASE_URL="postgresql://user:pass@host:5432/froa" \
  npm --workspace @froa/server run db:push
```

（自建迁移执行器只处理 SQLite；PostgreSQL 用 `db:push` 或标准 `prisma migrate`。）

### 生产环境必须设置

```env
NODE_ENV=production
JWT_SECRET=<强随机值>          # 默认值启动时会有告警
DATABASE_URL=file:./data/app.db
STORAGE_DIR=/var/lib/froa/audio
WEB_ORIGIN=https://your.domain
# 建议打开音频完整性巡检
INTEGRITY_SCAN_INTERVAL_MIN=1440
```

---

## 隐私

家庭语音是私密数据。这套系统默认**不把任何内容发往外部**：转写默认人工，存储默认本地磁盘，没有埋点、没有第三方 SDK。如果切到 `ASR_PROVIDER=openai`，音频会上传到对应服务，请自行评估。
