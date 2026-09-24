# AGENTS.md

本文件只记录本仓库特有、且会改变实现方式的约束。通用编码风格不在此重复。

## 这是什么

一个**独立**的 CNCF Distribution（Docker Registry HTTP API V2）镜像仓库管理 Web 工具：
浏览镜像、查看每个 tag 的 digest/架构/层数/体积/构建时间、复制 `docker pull`、按 digest 删除 manifest。

它**是一个自成一体的小工具**：服务端只有 Express + undici，前端是 React + Ant Design，
没有后端框架、没有 ORM、没有 i18n 体系。不要把大平台的模块、权限、国际化
或服务端框架引进来 —— 这个工具的卖点就是"小到能看懂、能单独跑起来"。

刻意不做的事：**没有登录，没有多实例配置**。一次管理一个 registry。
这些是产品决定，不是未完成项；要加先问。

关于"数据库"：产品决定是**不引入任何需要运维的数据库服务**，不是"一行 SQL 都不许写"。
`data/registry-manager.db` 里装**两类**数据：热度统计（`activity_daily` / `event_seen`）
与**拉取历史**（`pull_jobs`，只在任务到终态时写；运行态留内存）。
SQL 全部集中在 `server/db.mjs`（类名就叫 `Db`）。**不要**因此往上加 ORM，也不要换成 Postgres。

**凭据与代理刻意不进这个库**（仍是整份 AES-256-GCM 加密的独立 JSON）。
别为了"存储统一"把它们搬进去：进表会把 `name` / `registry_url` / `username` 变成明文，
是从"整份不可读"退化成"元数据全暴露"，而且会让敏感数据与非敏感数据混进同一个备份单元。
理由见 `docs/design.md` §4.1 —— **要动先问。**

**改 schema 的纪律**：`SCHEMA_VERSION` 的 +1 和对应的 `if (current < N)` 迁移分支
**必须落在同一次改动里**。中间状态（版本号已进位、分支还没写）会让**任何一个在此期间
启动过的库永久卡死**：`current === SCHEMA_VERSION` 时 `#migrate` 直接 return，
而那张表从来没被建出来，之后每次启动都报 `no such table`。
这不是假想 —— 本仓库开发 0.8.0 时就踩过：先改了版本号，迁移分支晚几笔才补上，
`node --watch` 在中间重启了一次，开发库的 `user_version` 就被写成 3 却没建表。
救援办法是 `PRAGMA user_version = 2` 让它重跑一遍（表都是 `CREATE TABLE IF NOT EXISTS`，
重跑不动数据），**不要**删库重建。

## 版本号规则

形如 `主.中.小` 三位，按下面的规则维护。

| 位 | 何时 +1 | 谁来定 |
| --- | --- | --- |
| **主**（第 1 位） | 有重大/破坏性变化时 | **必须由人明确指定**；AI 不得自行进位 |
| **中**（第 2 位） | 每新增一个**功能或模块** | 按改动性质自动判断 |
| **小**（第 3 位） | **缺陷修复**与**现有功能优化** | 按改动性质自动判断 |

判定要点：

- 新增一整个页面/模块（例如凭据管理、代理管理）→ 中版本 +1；
- 新增一项用户可感知的能力（例如支持 Bearer 令牌认证）→ 中版本 +1；
- 只是让既有功能更好用/更准确（例如提示文案、校验、交互细节）→ 小版本 +1；
- 一轮里既有新功能又有修复 → 取**最高**的那一档（即中版本 +1），
  不要按条目数累加，具体条目写进 `CHANGELOG.md` 即可；
- 纯文档、注释、脱敏等不影响行为的改动 → 通常随该轮一起发布，不单独进位。

一次改动要**同时**更新这几处（漏一处就会出现版本漂移）：

1. `package.json` 的 `version`
2. `docker-compose.yml` 的 `image: ${IMAGE:-registry-manager:X.Y.Z}`
3. `.env.example` 的 `IMAGE=`（以及同段的示例注释）
4. `README.md` 里所有 `docker build/tag/push` 示例
5. `CHANGELOG.md` 新增一节

`CHANGELOG.md` 按 [Keep a Changelog](https://keepachangelog.com/) 的分组写
（新增 / 变更 / 修复 / 文档），**新版本写在最上面**，条目要写"改了什么、
为什么、表现是什么"，不要只写"修复 bug"。

## 为什么必须有服务端

这不是可以去掉的中间层，去掉就散架：

1. **registry 不下发任何 CORS 头。** 浏览器无法跨域读 `/v2/`，`DELETE` 也必须同源。
2. **盘点需要服务端聚合。** 回答"有哪些镜像、多大"必须逐个 tag 读 manifest 与 image config
   （registry 没有任何聚合或容量接口）。实测 66 仓库 / 77 tag 约 1 秒、约 150 个请求。
   放到浏览器里做要几百个请求且每次开页都重扫。

所以 `server/` 既是 API 也是静态托管。重构时不要把它"简化"掉。

## registry 协议事实（都是实测，不是推断）

**删除**

- 只能按 digest 删。`DELETE /v2/<name>/manifests/<tag>` → `400 DIGEST_INVALID`。
- 删不存在的 digest → `404 MANIFEST_UNKNOWN`。
- 删存在的 digest → `201`，**真的会删掉**。
- **绝不能用 `OPTIONS /v2/<name>/manifests/<digest>` 的 `Allow` 头判断删除能力。**
  实测该 registry 在删除关闭时同样宣告 `Allow: DELETE, GET, HEAD, PUT` —— 这个头是假的。
- 删除能力由 registry 侧 `REGISTRY_STORAGE_DELETE_ENABLED` 决定，本会话期间**观测到它从关闭变成开启**。
  因此代码必须同时处理两种情况，不要假设任何一边。
- 删除 manifest 只是解除引用，**磁盘空间要运行 `registry garbage-collect` 才回收**。
- 一个 digest 可能被同仓库多个 tag 指向，删除会一次影响它们。删除前必须列出影响面。

**其它**

- `tags/list` 的分页**版本相关**：**v2.8.3 上不生效**（传 `n` 也只返回全量）、
  **v3.1.0+ 生效**（传 `n` 时在 `Link` 头给下一页，实测确认）。调用方**刻意不传 `n`**，
  因此两个版本行为一致 —— 别顺手加上分页参数。`_catalog` 的分页在两个版本都生效
  （`?n=&last=`；代码按返回条数判断是否继续，不依赖 `Link` 头）。
- **拿 manifest（`GET`/`HEAD /v2/<name>/manifests/<ref>`）必须带 `Accept`**，
  否则 registry 回 **404**（不是 400 也不是 406）。用裸 curl 探活会把"存在"读成"不存在"。
  `registry-client.mjs` 的 `MANIFEST_ACCEPT` 覆盖 OCI index/manifest 与 Docker list/v2 四种类型，
  所有 manifest 请求都必须带上。
- 没有 OCI referrers API（`/v2/<name>/referrers/<digest>` → 404）。
- **没有删除仓库的接口**，也没有删除 tag 的接口。删完 manifest 后仓库目录会留在 `_catalog`
  里、表现为 `tagCount: 0`，只能去 registry 宿主机删存储目录。
- **没有存储用量接口**。「镜像层合计」是各 manifest 中 layer 大小之和，**不是磁盘占用**
  （不同 tag 与仓库共享底层 blob）。UI 里必须保持这个措辞。
- 多架构索引本身没有 `layers`/`config`，取体积与架构必须下钻到第一个子 manifest。
- OCI 的 `created` 可能是 **9 位纳秒 + `Z`**，解析前要截断到毫秒。
- `_catalog` 里可能出现 `tags: null` 的空仓库；`readRepository` 必须容忍，且**不要把它从列表里剔除**
  —— 否则会出现"删除后消失、重新扫描又回来"的矛盾。

**认证**（公共源"不用登录也能拉"靠的就是这套，别退回只支持 basic auth）

- Docker Hub / ghcr.io / quay.io / 华为 SWR 等都走 **Bearer 令牌**：
  未认证请求先吃 `401` + `WWW-Authenticate: Bearer realm=...,service=...,scope=...`，
  客户端拿 realm 去换 token，再用 `Authorization: Bearer <token>` 重试。
  只靠 basic auth 进不去，一律表现为"要求认证"。
- **`/v2/` 的挑战不带 scope**，仓库路径上的才带。所以必须支持申请**无 scope 的 token**
  （`docker login` 验证凭据就是这么做的），否则源可达性探测对 Docker Hub 永远失败。
- **但有的 registry 拒绝无 scope 的申请**：实测 ghcr.io 回 `403`、quay.io 回 `401`。
  因此"`/v2/` 探测"不能以拿到 token 为准 —— **401 且带合法 Bearer 挑战就说明
  "可达且是 V2 registry"**（标记 `authRequired`），否则预览会误报"源不可达"、
  禁用入队按钮，而带 scope 的读取其实完全正常。
- 换 token 失败**不等于**请求失败：要把 registry 的原始 401 交回上层解读，
  并把令牌失败原因附在文案里，别包装成连接错误。
- 判定"这个地址不是 registry"：401 且**没有** `Docker-Distribution-Api-Version` 头
  → 多半是镜像站的**网站/反向代理**（nginx 默认回 `Basic realm="Authorization Required"`），
  报 `NOT_A_REGISTRY` 并说明，别让用户去配一个永远配不对的凭据。
- **Docker Hub 官方镜像是单段名 + `library/` 前缀**：`docker pull nginx` 能用是因为 CLI
  自动补了前缀；直接请求 `/v2/nginx/...` 拿不到，而 Hub 对**不存在的仓库也回 401**
  —— 极易被误读成"要认证"。`docker.io` / `index.docker.io` 等别名要归一到
  `registry-1.docker.io`（`docker.io` 本身是网站，不是 API 端点）。

**上传**

- `POST /v2/<name>/blobs/uploads/` 的 `Location` **可能是绝对 URL 且主机与配置不同**
  （配了 `REGISTRY_HTTP_HOST` / 走重定向 / 对象存储网关）。所以收尾请求必须
  "跨源原样用、同源只取 path+query"，**不能用字符串替换 baseUrl 去前缀**
  —— 否则会拼出 `http://ahttp://b/...` 这种畸形地址，表现为
  "manifest 已读取，但目的 PUT 404"。
- 收尾一律用 **PATCH 响应里最新**的 `Location`（registry 可能在其中更新会话地址）。
- **流式 body 必须显式 `duplex: 'half'`**，否则 undici 在把请求发出去之前就抛错，
  表现为"目的 PATCH 失败"但服务端根本没收到请求。
- 流式 body **不可重放**，无法"401 后换 token 重试"，要在发请求前预取 token。

**undici / 代理**

- `ProxyAgent` 走 **CONNECT 隧道**：用普通 HTTP 请求做 mock 代理测不出流量。
- `AbortController` **穿不透正在建立的 CONNECT 隧道**：代理能建 TCP 但到不了目标时，
  请求会永远挂着。超时必须用 `Promise.race` 之类硬兜底，只靠 abort 会永久卡住。

**通知 / 热度**（`notifications.endpoints`，是热度统计唯一的结构化数据源）

- Distribution 在 **manifest 的 push / pull** 时回调 webhook，**layer（blob）也会发**。
- **`action == "pull"` 不等于"有人在拉镜像"**：`docker push` 在探测 blob 是否存在时
  会发出 `action: "pull"` + `method: "HEAD"` 的事件。实测推一个 3 层镜像共 7 条事件，
  其中 3 条是假的 pull。不按 mediaType 过滤，推一个 20 层的镜像会凭空多出 20 次"拉取"。
- **一次 `docker pull` 会产生十几条事件**。实测 `postgres:15`（15 层）共 17 条：
  1 条 tag 解析 + 1 条内容下载 + 15 条 blob。
- **带 tag 的是 `HEAD`，不是 `GET`**：Docker 先按 tag `HEAD` 拿 digest，再按 digest `GET` 取内容，
  所以 GET 那条既没有 `tag`、`url` 也已经是 digest。判据必须是 `method ∈ {HEAD, PUT}`；
  写成 `{GET, PUT}` 会留下无 tag 的 GET、丢掉带 tag 的 HEAD。
- **blob 事件的 `target.mediaType` 是 `application/octet-stream`**（不是 layer 的 media type）。
  官网示例里的 `ignoredmediatypes: [application/octet-stream]` 就是为它准备的。
- `request.addr` **要看场景，不能一概而论**（早先这里写成"端口映射下一定是网桥网关"，太绝对了）：
  - 客户端在**别的机器**上 → 是**真实客户端 IP**，带临时端口。实测 regsync（跑在 192.0.2.11）
    拉 192.0.2.10 时是 `192.0.2.11:50672` —— 这种情况它**可以**用来区分客户端。
  - 客户端与 registry **同宿主**（含容器端口映射，例如在宿主机上 `docker pull`）→ 是 Docker
    网桥网关（如 `172.19.0.1`），那时**所有人都是它**，区分不了任何东西。
  - 结论：判断"能不能按 IP 排"之前，先看一眼真实事件里的 `addr` 分布；
    UA 才是无条件可靠的那个。
- `actor` 未认证时是 `{}`；`id` 是 **UUIDv7**（适合做去重键）；`timestamp` 的小数位数
  **不固定**（9 位 / 8 位混用），但 `new Date()` 能正确截断，**不需要**像 image config 的
  `created` 那样手动处理。
- 队列是**内存态**：registry 重启会丢未发送的事件；且有 `threshold` / `backoff` 重试
  → **必须按 `event.id` 幂等**（去重与计数放在同一个事务里），否则重复累加。
- 一个信封**可以包含多条事件**（实测每条 1 条），接收端必须按数组处理。
- **`action == "pull"` 的过滤不能替代 `method` 过滤**：两者必须同时在。
- **registry 侧只能按 action 与 media type 过滤**：`notifications` 的过滤项只有
  `ignore.mediatypes` 与 `ignore.actions`（旧写法 `ignoredmediatypes`），
  **没有按客户端 / 仓库 / User-Agent 过滤的入口**。所以"排掉某个自动化进程"只能在我们
  这一侧做，别去改 registry 的配置（改它还要重启 registry，重启会丢掉未发送的事件队列）。
- **排除自动化流量（regsync / skopeo 之类按点扫全量）时，只有 `request.useragent` 无条件可靠**：

  | 字段 | 可用性 |
  | --- | --- |
  | `request.useragent` | **可靠**。docker CLI 是 `docker/27.x ... UpstreamClient(...)`，同步工具带自己的 UA —— 实测 regsync 是 `regclient/regsync (v0.11.5)` |
  | `request.addr` | **看场景**（见上一条）：客户端在别的机器上是真 IP（实测 `192.0.2.11:50672`，可用）；与 registry 同宿主时是网桥网关（不可用） |
  | `request.host` | 内网里所有客户端用的 Host 头通常一致 |
  | `actor.name` | 只有 registry 开了认证**且**该工具用独立账号时才有值；未开认证时是 `{}` |

  这四个字段现在都存进内存里的排查缓冲（并做长度截断 —— 外部输入不能无界撑大内存），
  所以「最近事件」面板能直接看出一列 UA 整齐地刷满所有仓库。
- **排除规则有两个来源，判定时取并集**：
  - **界面**（`ignored_clients` 表，`GET/POST/DELETE /api/stats/ignore`）：日常入口，
    增删**立即生效不用重启**（`ActivityStore` 加删后重算生效列表）。入口主要是热度页
    每一行的「忽略」—— 要排掉某个客户端时人正看着那条 UA，不该被赶去别处。
  - **环境变量 `REGISTRY_STATS_IGNORE_USERAGENTS`**（逗号分隔、子串匹配、忽略大小写）：
    声明式部署的**基线，界面上只读**。服务端也真的删不动它（不只是界面上藏按钮）。
  两者**必须分开显示**：混成一条列表的话，"删了没反应"的用户根本不知道去哪找。
- **命中判定在 `classifyEvent` 的最前面**：整类客户端都不算的时候，它的 blob 事件、GET 事件
  也都不算，reason 说"这个客户端被忽略了"比特意去区分"它是 blob 还是 GET"有用
  （后者会让人以为只忽略了那一部分，进而怀疑配置没生效）。
  且**空/空白规则必须跳过** —— `''.includes` 恒为真，一条空规则会把所有事件判成忽略、
  **热度直接归零**。接口层也拒收空规则（两道，不指望调用方都校验）。
- reason 写成 `IGNORED_USERAGENT:<命中的片段>`，并在 `/api/config` 与面板标题上回显规则 ——
  "被排掉了"和"事件根本没到"必须分得清，否则下一次排查又会绕一圈。
- 界面上"加规则"的弹框要给**实时预览**（会匹配到最近收到的哪几个客户端），
  并且**预填片段而不是完整 UA**：存 `regclient/regsync (v0.11.5)` 的话，
  对方升到 v0.12 规则就静默失效了。
- 规则的来源要一路传到位：`config.mjs` 解析（env 基线）→ `index.mjs` 构造 `ActivityStore`
  → `ActivityStore` 合并（env ∪ 界面）→ 传给 `classifyEvent`。
  **任何一环断了，表现都是"配了规则但热度照旧被刷"**，
  所以 `verify:stats` 每一环都有断言（已验证：逐个回退都会有断言失败）。
- **「见过的客户端」是按客户端聚合的持久视图**（`client_seen` 表，schema v4）：
  行数 = 不同 UA 的数量，与事件量无关（全部 regsync 流量只占一行）。
  加它的理由是个真实顾虑："未知 UA 在刷，200 条窗口可能来不及让我看到"。
  算过账：regsync 一次扫全量 89 条、一天 3.2 次 → **200 条的内存窗口只覆盖约 17 小时**，
  比这更慢的客户端（一天一次的定时任务）永远等不到你看一眼，而热度每天在被它污染。
  根因是**用"逐条事件"回答一个"按客户端聚合"的问题** —— 所以别去把事件日志落盘（那会
  随事件量增长），要落的是这个按客户端聚合的小表。
  - **每条事件都要记账**，包括被忽略的、自身发的、缺 `event.id` 被丢掉的 ——
    少记任何一类，"没出现过"和"出现过但被处理掉了"就又分不清了。
  - `counted` 存的是**口径判定结果**（`verdict.counted`），不是"最终写库成功"：
    重复投递（`DUPLICATE`）也说明这个客户端符合计入口径。
  - 保留期**复用热度的**，不新增配置旋钮。`purgeHeat` 要连它一起清 ——
    它的 `counted` 与热度同源，清了热度却留着它会自相矛盾。
- **已被忽略的事件不进排查缓冲**（`totals.ignored`）。窗口该留给"还没处理过"的客户端。
  代价是"被排掉了"和"事件根本没到"不能再靠缓冲区分 —— 这个区分**改由客户端清单承担**
  （`events` 有值而 `counted` 为 0 = 收到过但被排掉；没有这一行 = 真的没来过）。
  `verify:stats` 里明确钉住了这个替代关系，**改折叠逻辑时不能只把老断言删掉**。
- **「最近事件」是内存缓存，界面上必须一直标着"不落盘"**。它长得像历史记录，
  实际只有最近 `bufferSize` 条（默认 200）、**不落盘、进程重启即清空**。
  标注要让人在**折叠状态**就看见（标签上一句「内存缓存 · 不落盘」），展开后再给一句说全的。
  少这一句的后果不是"不好看"：用户会对着两三天的窗口找"上周是谁在刷"，
  找不到就得出"没发生过"的结论 —— 而真实原因只是这段缓存翻篇了。
  界面上那个 N 取 `totals.bufferSize`（服务端回显），**不要在前端写死** ——
  写死了改容量时界面继续说旧数字，不报错、type-check 也过（和 `--color-error` 同一类）。
- **日历跨度与热度保留期是**一对**，改一个必须看另一个。** 日历固定画 12 个月
  （前端 `HEATMAP_DAYS`，**与服务端保留期不共用配置**），所以保留期只有 90 天时，
  365 格里 275 格（75%）注定是灰的 —— 这张图等于白画四分之三。默认保留期因此定在 365。
  加长保留期**几乎不花钱**：`activity_daily` 按 `(day, repository, tag, action)` 聚合，
  行数上界 = 仓库/tag 组合数 × 2 × 天数，**与流量无关**（实测 125 B/行，表+索引；
  91 个 tag 满打满算一年 66,430 行 / 8 MB）。真正随流量长的是逐事件的 `event_seen`，
  但它走**独立的 7 天去重窗口**（`dedupDays`，**刻意没接到配置上**）——
  别把 `REGISTRY_STATS_RETENTION_DAYS` 当成"库会变大"的旋钮，它只动那张按天聚合的小表。
- **日历上那片灰格子有**两个**原因，界面必须分清**（"找不到就以为没发生过"是这张图最
  容易让人得出的错误结论）：
  - **已过期** —— 保留期比跨度短，更早的被清理了；改配置可解。
  - **还没开始统计** —— `config.statsSince` 落在窗口内（新建的库、或刚「清空热度数据」）；
    **无解**，数据从来没存在过。说成"已过期"会让用户去调一个根本不相干的旋钮。
  判定在 `web/src/heatmap.ts` 的 `heatmapGapNote()`，由 `verify:heatmap` 钉住。
  **两个边界都落在窗口内时两段都要提** —— 本仓库实测保留 90 天、库也刚建 90 天，
  两个边界只差一天，而 275 个灰格子里 **274 个属于"从没采集过"**，只说"已过期"就是错的。
- 症状识别：自动化进程会把**每个 tag 的热度刷成同一个数**，且所有仓库的"最近活动"是
  同一个时刻。看到这种整齐度就别再怀疑是人了。
- **看到 `"useragent": "undici"` 就是本工具自己。** 这是最容易被误判的一项 ——
  真实发生过：用户 grep 事件看到 178 条 `undici` 来问"这是什么"。
  undici 是 Node 内置的 HTTP 客户端；**一次「重新扫描」就会按 tag 数量产生一批事件**
  （每个 tag 一次 manifest GET + 一次 image config blob GET，76 仓库 / 88 tag ≈ 178 条），
  正好把 200 条的排查缓冲冲干净。所以：
  - `registry-client.mjs` 的每次请求都带 `User-Agent: registry-manager/<版本>`
    （`USER_AGENT` 常量）。**不要删** —— 删了就退回"认不出来"的状态。
    ⚠️ **出站路径有三条，别只改 `#request`**：还有两条直接用 `undiciFetch` 的写路径
    （`streamBlobToDest` 的上传会话 PATCH、`putDestManifest` 的目的端 PUT）。
    0.7.1 就漏了这两条 —— 只要用一次「镜像拉取」就会在 registry 侧又冒出 `undici`，
    而且不会被算进"自身请求"。`verify:stats` 里那条断言把三条都跑到了。
  - 接收端按 `SELF_USERAGENT_PREFIX` 认定自身请求，**但只折叠"不计入"的那些**：
    盘点读 manifest/blob（一次上百条、永远不计入）折叠成 `totals().self` 一个数字；
    而**计入热度的自身请求（拉取任务落目的端 manifest 的 PUT）必须留在面板里**。
    ⚠️ 早先把"自身请求"整类折叠是个错误：用户用「镜像拉取」搬了镜像、热度确实 +1，
    但面板里一条都没有 —— "热度为什么变了"当场就查不出来了。
    折叠的判据是"**`self && !counted`**"，不是"`self`"。
  - **计数语义不受影响**：自身请求照常走 `classifyEvent`。盘点读 GET manifest 与 blob
    本来就不计入；拉取任务往本仓库写 manifest（PUT）**仍然计入** —— 那是真实发生过的 push。
    要连它一起排除，就把 `registry-manager` 加进 `REGISTRY_STATS_IGNORE_USERAGENTS`。
  - 加量/改量性能相关的地方别忘了这条：盘点的事件量与 tag 数成正比，
    缓冲默认只有 200 条。
- **清空热度（`purgeHeat`）刻意不碰 `pull_jobs`**：拉取历史是任务记录，不是统计口径的
  产物，两者保留期也是分开配的。同理 `cleanupPullJobs` 不碰 `activity_daily` ——
  **这两条边界都有断言钉住**，别顺手合并成一个 `clear()`。

## 破坏性操作红线

这个工具会删掉真实的基础设施镜像（k8s 组件、数据库、平台自身镜像）。

- **不要为了验证删除逻辑去删真实 manifest。** 验证失败路径只用不存在的 digest
  （`sha256:` + 64 个 `0`），它是非破坏性的。
- 本仓库发生过一次真实事故：把"探测到 405"误判成"删除被禁用"，随后按 digest 删除真的生效，
  删掉了 `alpine:3.19`。当时因为保留了原始 manifest 字节，才用 `PUT` 原样恢复
  （digest 不变）。**教训是：探测结论不可信，只有真实请求的结果算数。**
- 需要只读时用 `allowDelete: false`（或 `REGISTRY_ALLOW_DELETE=false`），服务端会拒绝删除。

## 构建与运行

```bash
corepack enable pnpm     # pnpm 不在 PATH；版本由 package.json 的 packageManager 固定为 11.20.0
pnpm install
pnpm dev                 # 前端 5273（/api 代理到 8787）+ 后端 8787
# 或
pnpm build && pnpm start # 单进程 8787，等价于容器里的跑法
```

**`pnpm dev` 本质上就是这两条**，出问题时可分开跑（绕开 pnpm 的依赖检查）：

```bash
node server/index.mjs
./node_modules/.bin/vite
```

配置优先级：环境变量 > `registry.config.json` > 默认值。`registry.config.json` 被 `.gitignore`
忽略，**不要提交**（里面是本机的 registry 地址与代理）。

## 前端坑（都踩过）

- **`navigator.clipboard` 只在安全上下文存在。** 本工具部署在内网 `http://<ip>:<port>`，
  属于非安全上下文，`navigator.clipboard` 是 `undefined`。`copyText()`
  （`web/src/utils.ts`）里的 `document.execCommand('copy')` 回退**必须保留**，
  否则"复制 docker pull"按钮永远失败。
- **`height: 100%` 在 `.app-shell` 上不生效。** AntD 的 `<App>` 会插入一层没有高度的
  `div.ant-app`，百分比高度因此失效 → 滚动从 `.app-content` 转移到整个文档 → 内容从
  sticky 顶栏下面穿过（顶栏透明时表现为字体重叠）。必须用 `height: 100vh`。
- **接口成功时 `message` 可能是空串**（`ok()` 默认 `message: ''`）。渲染 Alert 前要判断
  有没有文案，否则会得到一个空框。
- 页面外边距由 `.app-main` 的 `padding: 16px` 提供，`.page` 内不要再加外边距。

## 视觉约定

- **界面上只写"这里能做什么"，不写"为什么这么实现"。**
  - 页面副标题**一句话**，不解释机制。实现原理（加密算法名、webhook 口径、
    协议细节、部署级配置为什么分两处）写到 `README.md` 或 `docs/design.md`。
  - 两个理由都不是审美：一是原理不该给使用者看（否则要先读懂源码才能用工具），
    二是**界面上的实现细节不会随代码更新而漂移**，最后会变成一句看着权威、
    其实已经过时的说明。
  - 破坏性操作前**要写后果**（"删除后该镜像无法再被拉取"）—— 那是"会发生什么"，
    不是"为什么这么实现"，必须留。
  - 详见 `docs/design.md` §2。
- **这个项目没有 Tailwind。** 样式层是 `web/src/app.css` 里的普通 CSS 类
  （`.page` / `.panel` / `.app-main` / `.metric-grid` / `.page-header` …），
  配 `web/src/theme.css` 的语义 token。**写 Tailwind 类名（`p-4` / `flex` / `gap-4`）会静默失效**
  —— 没有构建期报错，只是样式不生效，排查起来很费时间。
  （本文件早先写成 `main（p-4）`，那是错的：`.app-main` 的 padding 来自 app.css 的规则。
  这类"看起来像 Tailwind"的写法多半是从别的项目抄过来的，别再抄回去。）
- 结构：`header`（sticky 顶栏）→ `main` → **顶部横向 `Segmented` 导航** → 内容区。
  应用内导航在**顶部**，不要改成左侧栏。
- 颜色一律用 `web/src/theme.css` 里的语义 token（`var(--color-*)`），不要写死色值。
- **AntD 表格里放长内容，必须在列上写 `ellipsis`**，只往单元格里套一个 `.ellipsis` 类
  是不够的。表格默认是 **auto 布局**：长且不可折行的内容会把列撑到自身宽度、列上的
  `width` 变成摆设，结果是**整张表横向滚动、最右边的列被推出视野**（实测：声明 240
  实际撑到 454；新加一列后 `scrollWidth` 1952 > 容器 1374）。写
  `ellipsis: { showTitle: false }` —— AntD 接到它才会切成 fixed 布局；
  `showTitle: false` 是因为通常已经有内容更全的自定义 Tooltip。
  加列之后**量一下 `scrollWidth <= clientWidth`**，`pnpm verify:layout` 里有这条断言。
- **深浅两套主题**：切换开关写在 `<html data-theme="dark">` 上，
  `theme.css` 的 `:root`（浅）与 `[data-theme='dark']`（深）**必须一一对应**
  （与主题无关的几何 token 明确豁免，见脚本里的 `THEME_INDEPENDENT`）。
  - 加 token 时**两套都要加**：漏掉的那个继续用浅色值，表现为"某个角落突然是白的"，
    不报错、不抛异常、type-check 也过。`pnpm verify:theme` 会挡住。
  - **不要写 `var(--x)` 之前先确认它存在。** CSS 自定义属性没有值域检查，
    名字写错整条声明被静默丢弃 —— 本仓库真实发生过（`--color-error` 从未存在过，
    失败态高亮一直是失效的）。`pnpm verify:theme` 会扫描所有 `var(--…)` 引用。
  - 深色下 **AntD 必须一起变**：`main.tsx` 用 `darkAlgorithm` 打底，
    并把 AntD token **对齐到 `theme.css` 的深色值**。只改自己那套会得到"半深色"
    （自定义 CSS 深了、AntD 表格还是白的），这是深色主题最常见的翻车方式。
  - 首屏防闪白的内联脚本在 `web/index.html`，它必须**同步执行、早于模块脚本**；
    React 侧**只读** `dataset.theme`，**不要**再判断一次 `prefers-color-scheme`
    —— 两处判断就是两个真相来源。
  - 两套都要设 `color-scheme`，否则原生滚动条与表单控件不跟随主题。
- KPI 卡：图标块 28×28（语义色底）+ 13px 标签 + 粗体数值，样式见 `app.css` 的 `.metric-card`。
- 手写 SVG 图表的约定：
  - **几何与分档逻辑抽到 `web/src/*.ts`，不要在组件里算**。渲染结果没法靠读代码确认，
    抽出来才能用 `scripts/verify-heatmap.mjs` 那套断言钉住（日历的错法是"长得不对"，不抛异常）。
  - 坐标常量（`viewBox`、留白、格宽）**单点定义**。
  - **方格图（如热度日历）用固定像素尺寸 + `max-width`，不要 `width:100%` 拉伸** ——
    拉伸会把方格变成矩形，失去"日历"的读法。折线图才需要 `width:100%` + `vector-effect: non-scaling-stroke`。
  - **`fill` / `fill-opacity` 只对 SVG 元素生效，对 HTML 元素完全无效。** 日历的档位色就是这么
    定义的，所以**图例也必须用真的 `<rect>`，不能拿 `<span>` 套同一批 class** ——
    本仓库真实发生过：图例是 5 个 `<span>`，屏幕上只剩"少 …… 多"两个字，
    用户来问"这个多、少是什么意思，我没看到作用"。
    **这类缺陷 type-check、build、截图断言全都不报，读代码也像是对的**（class 名确实写对了，
    只是元素类型不对），只有去读 computed style 才看得出来。`verify:layout` 里有断言钉住
    （色块有面积、有颜色、不透明、档位单调递增）。
  - 图例**复用日历那套 class，不要另写一份 `background` 色板** —— 那就是第二份档位色，
    以后改档位一定会漏掉一处。

## 容器

三阶段：`builder` 编译前端 → `prod-deps` 只装 `express + undici`（约 6MB）→ `runtime` 非 root。

- 前端依赖（react / antd / vite）**故意放在 `devDependencies`**：服务端进程从不 require 它们，
  已被 Vite 打进 `web/dist`。移回 `dependencies` 会让运行镜像白白大几十 MB。
- 运行阶段的 `COPY` **必须带 `--chown=node:node`**，并保留 `chmod -R a+rX` 兜底。
  源码可能以 `600` 落盘，`COPY` 会原样带进镜像且属主是 root，非 root 的 `node` 用户会
  `EACCES: permission denied, open '/app/server/index.mjs'`。
- `registry.config.json` 由 `.dockerignore` 排除，**绝不能打进镜像**（会把某台机器的地址与代理固化）。
- 基础镜像可用 `--build-arg NODE_IMAGE=` 覆盖，供拉不到 Docker Hub 的构建机使用。
- `docker-compose.yml` 是给人用的便捷入口，**它传的环境变量必须以 `server/config.mjs`
  实际读取的为准**，不要自造变量名。当前这一组是：

  | 变量 | 作用 |
  | --- | --- |
  | `REGISTRY_URL` / `REGISTRY_NAME` | 目标 registry 与展示名 |
  | `REGISTRY_PROXY` / `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` | **本 registry** 的代理与认证（部署级） |
  | `REGISTRY_CACHE_TTL_SECONDS` / `REGISTRY_ALLOW_DELETE` | 缓存时长、只读模式 |
  | `REGISTRY_ALLOW_PULL` / `REGISTRY_PULL_QUEUE_SIZE` | 是否允许拉取、**内存里**保留的任务条数 |
  | `REGISTRY_PULL_HISTORY_RETENTION_DAYS` | 拉取历史的保留天数（落 SQLite，与热度分开配置） |
  | `REGISTRY_NOTIFY_TOKEN` / `REGISTRY_ALLOW_REGISTRY_EVENTS` / `REGISTRY_STATS_RETENTION_DAYS` / `REGISTRY_STATS_IGNORE_USERAGENTS` | 热度事件的共享密钥、是否接收、保留天数、要排除的客户端 UA 片段 |
  | `REGISTRY_CREDENTIAL_KEY` / `REGISTRY_CREDENTIALS_DIR` | 加密存储的密钥与**数据目录**（凭据、代理库、热度数据库） |

  新增配置项时要同步**五处**：`config.mjs`、`docker-compose.yml`、`.env.example`、
  README 的变量表、以及 `registry.config.example.json`。
- **`docker-compose.yml` 里不写变量说明**，只负责"接线"（`VAR: ${VAR:-默认值}`）；
  解释统一放在 `.env.example`。同一句话在两个文件里各写一份，迟早说不到一起去 ——
  而 compose 那份又总是被先读到的那个。
- **凭据库与代理库共用一个密钥**（`REGISTRY_CREDENTIAL_KEY`，scrypt 派生），
  但落在两个独立文件（`credentials.json` / `proxies.json`）。
  密钥与文件同时丢失 = 永久不可恢复 —— 文档里必须一直保留这句提醒。
- `registry-manager-data` 命名卷挂在 `/app/data`。镜像里已 `mkdir + chown node:node`
  预建该目录；**用旧镜像或让 Docker 在挂载点自建目录都会是 root 属主**，
  非 root 的 `node` 用户写不进去（启动时会以"数据目录不可用"报错并给出修法）。
- `docker-compose.yml` 不重复声明 `healthcheck`（继承镜像），避免两处漂移。
- `.env` 被 `.gitignore` 忽略，`.env.example` 要提交。

## 改动后如何验证

改动必须跑与影响范围匹配的**新鲜**验证：

```bash
pnpm type-check    # 类型
pnpm build         # 构建
pnpm verify        # 非破坏性回归（不起真实服务、不碰真实 registry）
pnpm verify:real   # 打真实公共 registry（需出网，连不上会跳过）
```

`pnpm verify` 会起进程内的 mock registry（basic auth / Bearer 令牌 / 跨主机上传
Location / 上传会话各一套），用真实代码路径跑完整流程。**新增或修改协议行为时
要给它加一条断言**，并**确认回退修复后该断言会失败** —— 否则测试可能只是"跟着实现写"，
挡不住回归。

`scripts/verify-stats.mjs`（`pnpm verify:stats`）专门钉**热度口径**：blob 事件不计入、
pull 的内容下载（GET）不计入、push 时的 blob 探测不计入、同一个 `event.id` 只计一次；
另外钉**排查用的身份字段**（`useragent` / `addr` / `host` / `actor` 有没有真的存下来、
超长输入有没有被截断）、**清空热度**（聚合与去重窗口一起清、清完同一个 id 能重新计入、
累计计数与内存缓冲一起归零、HTTP 层能读能清）与**客户端排除**
（子串 / 忽略大小写 / 不误伤 / 空列表不改变默认行为；配置解析 → ActivityStore → classifyEvent
→ HTTP 层四环都钉住）。
**改动 `server/events.mjs` 的过滤判据时必须同时跑它**，并按上面的规矩确认回退后会失败
（已验证：去掉 method 判据会有 6 项失败、去掉 mediaType 判据会有 5 项失败；
去掉身份字段会有 4 项失败、`purgeHeat` 漏删去重窗口会有 2 项失败、
`purge` 不清内存缓冲会有 1 项失败、删掉 `DELETE /api/stats/heat` 会有 2 项失败；
去掉客户端排除会有 10 项失败、`ActivityStore` 不透传规则会有 5 项失败、
`index.mjs` 不透传会有 3 项失败、逗号不拆分会有 4 项失败；
不设自己的 User-Agent 会有 1 项失败、自身请求照样进缓冲会有 2 项失败、
自身请求也算进面板计数会有 1 项失败、"因为是自己发的就不计数"会有 1 项失败）。
另外钉**界面上管理的忽略规则**：加删立即生效（不重建 store）、环境变量那条服务端也删不掉、
空规则被拒、规则落库重启还在 —— **改动 `ignored_clients` 表或规则合并逻辑时必须同时跑它**。

`scripts/verify-pull-history.mjs`（`pnpm verify:pull-history`）钉**拉取历史的存储契约**：
**老库（user_version=1，只有热度）一路升到 v3 不丢数据**（跨两步）、
**v2 库（有热度 + 拉取历史）升到 v3 不丢数据**、queued/running 不落库、
失败任务保留阶段明细而成功任务不保留、两类保留期互不干扰。
**改 `server/db.mjs` 的 schema 或 `puller.mjs` 的 `#settle` 时必须同时跑它**
（已验证：去掉两处 `#settle` 调用会有 2 项失败）。

`scripts/verify-theme.mjs`（`pnpm verify:theme`）钉**深浅主题的对应关系**，四类都是
"不报错但长得不对"的缺陷：`:root` 的 token 有没有在深色块里漏覆盖、代码里引用的
`var(--…)` 是否真的存在（`--color-error` 那次事故）、`main.tsx` 的 AntD token 与
`theme.css` 的语义色是否同一组值、首屏内联脚本是否仍在模块脚本之前。
**改 `theme.css` / `main.tsx` / `index.html` 的任一处都要跑它**（已验证：逐个回退这四类
改动，断言都会失败）。

`pnpm verify:real` 的价值在于：**mock 只能复现"你以为的"服务端行为**。
本仓库真实吃过这个亏 —— mock 的 `/v2/` 挑战带了 scope（比真实宽松），
于是"无 scope 令牌申请"的缺陷一直没被发现，直到打真实 registry 才暴露
（ghcr.io 回 403、quay.io 回 401）。所以**协议相关改动优先用 `verify:real` 打真实源**。

涉及 registry 交互时，起服务后也打真实请求：

```bash
curl -s localhost:8787/api/config
curl -s -X POST localhost:8787/api/probe
curl -s -X POST localhost:8787/api/refresh   # 全量盘点
```

**渲染结果无法靠读代码确认** —— 涉及布局/样式/交互时，要让人看截图或真实浏览器，
不要臆断"应该没问题"。本仓库的 UI 问题基本都是在截图或实际点击里才暴露的
（例如"任务行展开后收不回去"这种受控状态缺陷，读代码看不出，得点一下）。

`scripts/verify-layout.mjs`（`pnpm verify:layout`）把上面这条变成了可执行的检查：
用无头 Chrome 真的滚一遍，断言**滚动只发生在表格内部**、搜索框位置纹丝不动、表头粘住、
分页器无需滚动即可见、日历的格子数/档位/尺寸合理、**深色主题下没有"半深色"的面**，
并把截图写到 `SHOT_DIR`（默认临时目录）。

- 前置：另开终端跑 `pnpm dev`，然后 `pnpm verify:layout`。
- **它刻意不进 `pnpm verify`**：需要开发态服务和本地 Chrome，无桌面环境跑不起来。
  找不到 Chrome 时**跳过并返回 0**。
- 访问地址要用 `localhost:5273`，**不要用 `127.0.0.1:5273`** ——
  Vite 在 macOS 上只绑 IPv6 的 `[::1]`，`127.0.0.1` 会连接被拒。
- 它第一次跑就抓到两个 type-check / build 都发现不了的问题：分页器被卷进表格滚动区、
  30 天窗口的日历缩成 133px 细缝。**改布局后请跑一次。**
- 深色主题那一段是**真点按钮、真读 computed style**：只断言 `data-theme` 变了是不够的
  —— 自查发现"半深色"只有读 `.ant-table` / `.ant-pagination` / `.ant-tag` 这些
  AntD 面的最终背景色才看得出来。刷新那一步用首屏注入的 `MutationObserver` 记下
  `data-theme` 第一次被设置时 `#root` 是否已有子节点，**那才是"闪不闪白"的判据**
  （把主题交给 React 的 `useEffect` 去设 → `rootChildren > 0` → 断言失败）。

**测试替身要和真实服务同形**：写 mock 前先确认真实响应长什么样
（例如 `/v2/` 的挑战到底带不带 scope），否则 mock 会把缺陷掩盖过去。

**验证脚本不许改应用状态。** 这是踩出来的：`verify:layout` 点「忽略」打开弹框、再点
「取消」，那条断言写的是"弹框消失了" —— 而**保存也会让弹框消失**，所以它挡不住副作用。
结果跑完一次之后，开发库的规则表里多了一条 `docker/27.3.1`（弹框预填的片段），
此后所有 docker 事件都被它排掉，排查时白绕一圈。
对会写状态的交互，断言必须**比对前后快照**（`GET /api/stats/ignore` 跑前跑后必须一致），
而不是只看 UI 有没有关掉。

**断言被条件跳过 = 没有断言。** 上面那条快照断言当时挂在"找得到「忽略」按钮"之后，
而按钮只在**最近事件**里找 —— 那个窗口只有 200 条，一旦里面的事件恰好都已被规则命中，
整段就 `skip`，快照断言跟着一起让过去，看着"全绿"其实什么都没验。
加了「见过的客户端」之后，**持久视图才是入口该在的地方**（客户端出现过就一定在，
不受窗口限制），断言因此改成优先在客户端清单里找，并且当清单里存在"既不是本工具、
也没被排掉"的行时，**这一行必须有「忽略」按钮**（失败，不是跳过）。
写 `skip(...)` 之前先问一句：这个状态是"本来就不该有"，还是"这次恰好没轮到"？
