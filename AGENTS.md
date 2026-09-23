# AGENTS.md

本文件只记录本仓库特有、且会改变实现方式的约束。通用编码风格不在此重复。

## 这是什么

一个**独立**的 CNCF Distribution（Docker Registry HTTP API V2）镜像仓库管理 Web 工具：
浏览镜像、查看每个 tag 的 digest/架构/层数/体积/构建时间、复制 `docker pull`、按 digest 删除 manifest。

它**是一个自成一体的小工具**：服务端只有 Express + undici，前端是 React + Ant Design，
没有后端框架、没有 ORM、没有 i18n 体系。不要把大平台的模块、权限、国际化
或服务端框架引进来 —— 这个工具的卖点就是"小到能看懂、能单独跑起来"。

刻意不做的事：**没有登录，没有数据库，没有多实例配置**。一次管理一个 registry。
这些是产品决定，不是未完成项；要加先问。

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

- `tags/list?n=` 的分页**不生效**（Distribution 2.x），一次返回全量；`_catalog` 的分页生效
  （用 `?n=&last=`，并在 `Link` 头给下一页）。
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

- 结构：`header`（sticky 顶栏）→ `main`（`p-4`）→ **顶部横向 `Segmented` 导航** → 内容区。
  应用内导航在**顶部**，不要改成左侧栏。
- 颜色一律用 `web/src/theme.css` 里的语义 token（`var(--color-*)`），不要写死色值。
- KPI 卡：图标块 28×28（语义色底）+ 13px 标签 + 粗体数值，样式见 `app.css` 的 `.metric-card`。

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
  | `REGISTRY_ALLOW_PULL` / `REGISTRY_PULL_QUEUE_SIZE` | 是否允许拉取、任务保留条数 |
  | `REGISTRY_CREDENTIAL_KEY` / `REGISTRY_CREDENTIALS_DIR` | 加密存储的密钥与目录（外部源凭据/代理） |

  新增配置项时要同步**五处**：`config.mjs`、`docker-compose.yml`、`.env.example`、
  README 的变量表、以及 `registry.config.example.json`。
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

**测试替身要和真实服务同形**：写 mock 前先确认真实响应长什么样
（例如 `/v2/` 的挑战到底带不带 scope），否则 mock 会把缺陷掩盖过去。
