# 更新日志

版本号规则见 [AGENTS.md](./AGENTS.md#版本号规则)：`主.中.小` 三位。

- **主**：由人决定，新增/破坏性变化时才动；
- **中**：每新增一个功能或模块 +1；
- **小**：缺陷修复与现有功能优化。

## [0.4.0] - 2026-09-24

本轮新增**镜像热度**模块。按版本规则，新增模块 → 中版本 +1。

### 新增

- **镜像热度**（新模块）：统计每个仓库与 tag 被 push / pull 的次数。
  数据来自 Distribution 原生的 `notifications` webhook，**管理服务只收事件、不进数据面**
  （`docker pull` 的字节一个包都不经过它）。按 `(天, 仓库, tag, 动作)` 聚合，默认保留 90 天。
- **热度页**：时间窗切换（7 / 30 / 90 天）、KPI 总览、按仓库与按 tag 的 Top 榜单、
  手写 SVG 的按天趋势，以及一个「最近事件」排查面板。
- **镜像列表新增热度列**：热度与最近活动时间，可排序。热度不可用时整列隐藏。
- **SQLite 存储**：用 Node 22 自带的 `node:sqlite`，**不引入任何依赖、不需要额外的数据库服务**，
  只落一个文件在数据目录里；WAL 模式，去重与计数在同一个事务里完成。
- **镜像拉取历史落库**：任务到达终态时追写一条到 SQLite，**重启不再丢失** ——
  原来任务只在内存里，重启一次就答不了"上周搬了哪些镜像"。
  运行态（排队 / 执行中 + 实时进度）仍留内存；失败 / 取消的任务保留阶段明细，
  成功任务只存汇总（20 层的拉取有 22 条 phase，存了只会把行撑胖）。
  默认保留 90 天，由 `REGISTRY_PULL_HISTORY_RETENTION_DAYS` 调整（与热度的保留期**分开配置**）。
- **`scripts/verify-pull-history.mjs`**（`pnpm verify:pull-history`）：钉住存储契约，
  其中最关键的一条是**老库（只装了热度的 `user_version=1`）升级到 v2 不丢数据**。
- **接收端可观测性**：内存里保留最近 200 条原始事件（**含未被计入的原因**），
  事件没到、口径不对时能直接看出来。
- **按天趋势做成贡献日历**（GitHub 那种方格热力图），而不是折线：折线看不出"周内高峰、
  周末低谷"这类节奏，而这才是热度真正要回答的问题。仍然是手写 SVG，**不引图表库**。
  日历**固定看近 12 个月**（≈53 列）并**按容器宽度反算格宽**，因此铺满整行 ——
  原先跟随时间窗，30 天只有 5 列，不论格子多大都缩在卡片左边、右侧一大片空白。
  没有活动的日期画成灰色方块（和 GitHub 一样）；保留期短于跨度时 caption 会说明
  "更早的灰色是已过期，不代表没有活动"，避免被读成"那段时间没人用"。
- **布局：滚动只发生在表格内部**（镜像列表、热度榜单）。原来整页一起滚 ——
  往下翻表格会把搜索框、时间窗、KPI 一起顶走，而"翻到第 30 行"和"改搜索词"
  本来就是交替发生的动作。表头粘住、分页器钉在卡片底部。
- **`scripts/verify-layout.mjs`**（`pnpm verify:layout`）：用无头 Chrome 真的滚一遍并截图，
  把"渲染结果无法靠读代码确认"变成可执行的检查。
- **`docs/design.md`**：产品设计说明，写清每个页面只该有什么、以及**哪些话刻意不写在界面上**。

### 变更

- **界面文案的规矩：只写"这里能做什么"，不写"为什么这么实现"。**
  凭据管理、代理管理、镜像热度三页的副标题原本混着实现原理（AES-256-GCM、
  `REGISTRY_CREDENTIAL_KEY`、webhook 口径、`manifest HEAD` 等），现全部收成一句话；
  原理移入 `README.md` 与 `docs/design.md`。表单提示里的算法名同样改为"加密存储"。
  两个理由：原理不该给使用者看（否则要先读懂源码才能用工具），
  而且界面上的实现细节不会随代码更新而漂移。
  同时把副标题的 `max-width` 从 720px 放宽到 880px —— 实测「镜像拉取」那句需要 825px，
  卡在 720 会折成两行且末行只剩几个字；并加 `text-wrap: pretty` 防止窄屏下的孤行。
- `engines.node` 从 `>=20` 提到 **`>=22.5.0`**（`node:sqlite` 的要求）。
- 启动脚本加 `--disable-warning=ExperimentalWarning`：`node:sqlite` 在 Node 22 上仍标注实验性，
  这条噪音会盖住真正有用的告警。
- 「数据目录」语义明确化：凭据库、代理库与热度数据库共用一个目录。变量名仍是
  `REGISTRY_CREDENTIALS_DIR`，以免破坏已有部署的挂载与卷。
- 新增配置 `REGISTRY_NOTIFY_TOKEN`（只从环境变量读）、`REGISTRY_ALLOW_REGISTRY_EVENTS`、
  `REGISTRY_STATS_RETENTION_DAYS`、`REGISTRY_PULL_HISTORY_RETENTION_DAYS`。
- `REGISTRY_PULL_QUEUE_SIZE` 的含义收窄为"**内存里**保留的任务条数"；
  完整历史改由 SQLite 承担（见上）。
- **凭据与代理保持原样**（整份 AES-256-GCM 加密的独立 JSON），**刻意不进 SQLite**：
  进表会把 `name` / `registry_url` / `username` 变成明文，是从"整份不可读"退化成
  "元数据全暴露"，而且会让敏感数据与非敏感数据混进同一个备份单元。理由见 `docs/design.md` §4。

### 修复

- **热度榜单切换「按仓库 / 按 tag」时残留旧行**。`rowKey` 原本依赖聚合维度
  （`topBy === 'tag' ? repo:tag : repo`），切换时同一个 record 的 key 会变，
  React 因此无法正确协调 —— 旧行留在 DOM 里：分页器显示"共 8 项"而 DOM 里有 16 行、
  `data-row-key` 重复，界面上表现为 **Tag 列错位 / 空白**，而且每切换一次就多留一批
  （17 → 25 → 33 …）。改成与维度无关的稳定 key（`repo\u0000tag`）。
  已在 `pnpm verify:layout` 里加了浏览器回归断言（连切 6 次，校验行数=分页总数、
  无重复 rowKey、单元格数与表头一致），**回退该修复后断言必然失败**（已实测：
  报出 `domRows:16 dataRows:8 duplicateKeys:8`）。

### 文档

- 新增 `docs/pull-heat.md`：记录**全部来自真实 registry 的实测事实** ——
  一次 pull 会产生哪些事件、为什么带 tag 的是 HEAD 而不是 GET、
  push 为什么会发出假的 pull 事件、Prometheus 指标为什么拿不到仓库维度、
  以及"拿 manifest 必须带 `Accept`，否则回 404"这个坑。
- README 增补「镜像热度」一节（registry 侧配置、口径表、已知边界）。

### 已知边界

- 热度从配置生效那天开始统计，之前的历史补不回来。
- 失败的拉取（401 / 404）不产生事件，热度只反映**成功**的推送与拉取。
- 不做客户端 IP 统计：端口映射后 registry 看到的是 Docker 网桥地址，不是真实客户端。
- 无法区分"按 tag 拉"与"按 digest 拉"——每次普通 tag 拉取都会附带一条按 digest 的 GET 事件。

## [0.3.1] - 2026-09-22

### 新增

- 顶栏左侧显示**当前运行中的版本号**（如 `v0.3.1`）。
  版本由服务端从 `package.json` 读取后经 `/api/config` 下发，
  界面上**不写死**，避免与包版本漂移；读不到时不显示，不影响服务启动。

## [0.3.0] - 2026-09-22

本轮相对 0.2.0 新增了**两个模块**（凭据管理、代理管理）与数项新能力，按规则中版本 +1。

### 新增

- **凭据管理**（新模块）：外部 registry 的 basic auth 凭据库，AES-256-GCM 加密落盘，
  密钥由 `REGISTRY_CREDENTIAL_KEY` 经 scrypt 派生；密码不回显、不进任务历史。
- **代理管理**（新模块）：外部源 HTTP 代理库（地址 + 可选账号密码），
  并支持**连通性测试**（实际穿过代理访问目标，报告状态码与耗时）。
- **Bearer 令牌认证**：支持 Docker Hub / ghcr.io / quay.io / 华为 SWR 等
  以 `WWW-Authenticate: Bearer` 认证的 registry，匿名即可拉公开镜像；
  token 按 scope 缓存复用。此前只支持 basic auth，这类源一律报"要求认证"。
- **创建任务前预览**：列出解析后的全部字段并做只读预检 —— 源是否可达、
  源 tag 是否存在、目标 tag 是新建 / 已一致 / 将被替换（附替换前后 digest）。
- **任务级来源代理**：可选"不用 / 代理库 / 临时输入"，临时输入不落库。
- **任务级源认证**：可选"不用 / 凭据库 / 临时输入账号密码"。
- **拉取失败区分源端 / 目的端**：错误码带 `origin`，提示文案针对性强。
- **目标镜像名可编辑**：本仓库地址以固定文本呈现（不可编辑），后半段可改，
  例如把 `library/alpine:3.19` 落成 `alpine:3.19`。
- **Docker Hub 官方镜像自动补 `library/` 前缀**：`nginx:latest` → `library/nginx:latest`，
  与 `docker pull` 行为一致；`docker.io` / `index.docker.io` 等别名也归一到
  `registry-1.docker.io`。

### 变更

- **认证与代理按作用对象分两处**：本 registry 自身的认证与代理属部署级配置
  （`registry.config.json` / `REGISTRY_USERNAME`、`REGISTRY_PASSWORD`、`REGISTRY_PROXY`），
  因为它们缺失时连镜像列表都打不开；凭据库与代理库只服务**外部源**，
  因此凭据/代理都不再有"用途"维度。
- 拉取表单只保留「源镜像名」一个必填项，目标引用自动补全。
- 任务列表所有行均可展开（成功/进行中也能看阶段详情）；首屏收起，
  之后新出现的失败任务自动展开一次。
- 加密存储的数据目录在启动时**主动探测可写性**，不再等首次写入才失败。
- `REGISTRY_PROXY=` 显式置空现在能覆盖配置文件里的代理值。

### 修复

- **流式 PATCH 缺 `duplex: half`**：请求根本发不出去，每一次真实拉取都失败
  （表现为"目的 PATCH 失败"但服务端没收到请求）。
- **目的端凭据未回写 `destClient`**：mount 与上传全是裸请求。
- **上传会话 `Location` 跨主机时 PUT 被拼成畸形 URL**：表现为
  "manifest 已读取但目的 PUT 404"。
- **`/v2/` 探测把"需要认证"误判为"源不可达"**：预览因此禁用入队按钮，
  而带 scope 的读取其实完全正常（ghcr.io / quay.io 实测触发）。
- **空 scope 的令牌申请被直接放弃**：Docker Hub 的 `/v2/` 挑战不带 scope，
  导致探测永远失败。
- **镜像站的网站被当成 registry**：这类地址返回 nginx 的 `Basic realm`
  且无 registry 版本头，现在报 `NOT_A_REGISTRY` 并说明原因，
  而不是让用户去配一个永远配不对的凭据。
- **任务行展开后收不回去**：AntD `expandedRowKeys` 是受控属性，缺 `onExpandedRowsChange`。
- **数据目录"存在但不可写"时静默成功**：直到新增凭据才失败，且错误与权限无关。
- **凭据库初始化失败被误报成"未配置 KEY"**：把已配好密钥的人引向错误方向。
- **容器内 `/app/data` 未预建**：非 root 用户无法在 `/app` 下创建，镜像已预建并交给 `node`。
- **令牌申请失败被误报成 `CONNECTION_FAILED`**：掩盖真实认证失败。
- **示例地址泄漏真实内网 IP 与组织名**：示例统一改用 RFC 5737 文档地址与 `example.com`。

### 文档

- README 增补：认证/代理分工、凭据与代理管理、Bearer 令牌流程、
  上传 `Location` 跨主机、数据目录排障、创建前预检。
- 新增非破坏性回归脚本（`pnpm verify`）与真实 registry 验证（`pnpm verify:real`）。
- 说明 `REGISTRY_CREDENTIAL_KEY` 与凭据文件需**一起备份**，同时丢失不可恢复。

## [0.2.0] - 2026-09-22

### 新增

- **镜像拉取**：从外部 registry 拉取镜像落到当前仓库。
  单并发 + FIFO 队列；优先走 cross-repo mount，未开启时回落流式 PATCH，
  数据始终在两个 registry 之间流式搬运，不经过进程内存。
- **优雅取消**：标记 `cancelled` 后立即让源/目的流停止传输，
  当前正在写的 chunk 写完才退出，目的端不会留下半截 manifest。
- 任务级来源代理（手填地址）。
- 拉取任务列表：状态、进度、阶段明细，失败原因默认展开。

### 变更

- 新增 `allowPull` / `pullQueueSize` 配置。

## [0.1.0] - 2026-09-22

### 新增

- 初始版本：浏览与管理 CNCF Distribution（Docker Registry HTTP API V2）镜像。
- 镜像列表（搜索、按体积/构建时间排序）、镜像详情（digest、架构、层数、体积、
  构建时间、复制 `docker pull`）。
- 按 digest 删除 manifest，删除前列出同一 digest 下的全部 tag。
- 清单概览与连接自检。
- 连接配置：`REGISTRY_URL` / `REGISTRY_PROXY` / `REGISTRY_ALLOW_DELETE`，
  支持环境变量与 `registry.config.json`（环境变量优先）。
- 三阶段 Dockerfile，非 root 运行。
