# 镜像仓库管理（registry-manager）

一个独立的 Web 工具，用来浏览和管理 **CNCF Distribution**（Docker Registry HTTP API V2）里的镜像。

单进程、可独立部署：运行时只依赖 Express 与 undici，前端产物由 Vite 打包后同源托管。

## 它能做什么

- **镜像列表**：搜索仓库名、按体积或构建时间排序。
- **镜像详情**：每个 tag 的 digest、架构与操作系统、层数、体积、构建时间，一键复制 `docker pull` 命令。
- **删除镜像**：按 manifest digest 删除。删除前会列出同一 digest 下的全部 tag，并说明磁盘空间不会立即释放。
- **镜像拉取**：从外部 registry 拉取镜像落到本仓库，单并发 + FIFO 队列，优雅取消；
  支持公共源（Docker Hub / ghcr / quay 等，匿名即可拉公开镜像）与私有源。
- **凭据管理**：外部源的 basic auth 凭据库，加密落盘，密码不回显。
- **代理管理**：外部源的 HTTP 代理库，支持连通性测试。
- **清单概览**：仓库数、tag 数、镜像层合计、清单刷新时间，以及读取失败的 tag 明细。
- **镜像热度**：每个仓库 / tag 被 push、pull 了多少次，用来识别僵尸镜像与判断"能不能清理"。
  ⚠️ 这一项**需要先在 registry 侧配置 webhook**（见[镜像热度](#镜像热度)），不配的话页面是空的。
- **连接自检**：一键测试 registry 连通性与 API 版本。
- **深色主题**：顶栏右上角一键切换，**记住选择**，首次打开跟随系统偏好；
  浅色与深色是两套独立配色，不是把颜色取反。

没有登录。**也没有需要运维的数据库服务**——清单在内存里缓存（重启即重新扫描），
热度统计用 Node 自带的 SQLite，只落一个文件在数据目录里。

版本变更见 [CHANGELOG.md](./CHANGELOG.md)；版本号规则见 [AGENTS.md](./AGENTS.md#版本号规则)。
<img width="1855" height="927" alt="image" src="https://github.com/user-attachments/assets/512b97af-bb66-4ef6-9686-9eb05fe991ef" />

## 为什么需要一个服务端

registry 不下发任何 CORS 头，浏览器无法跨域直接读 `/v2/`，删除也必须同源发起。
所以这个进程做两件事：托管前端页面，并把 registry 的 API 代理成同源的 `/api`。

## 快速开始

```bash
pnpm install

# 方式一：环境变量
REGISTRY_URL=http://192.0.2.10:10001 pnpm dev

# 方式二：项目根目录 registry.config.json（可从 registry.config.example.json 复制）
pnpm dev
```

开发态前端在 http://localhost:5273 （`/api` 自动代理到服务端）。

> 请用 `localhost` 而不是 `127.0.0.1`：Vite 默认绑 `localhost`，在 macOS 上会解析成
> **IPv6 的 `[::1]`**，此时 `http://127.0.0.1:5273` 是连不上的（连接被拒）。
> `localhost` 两种解析都能用。
生产态：

```bash
pnpm build     # 产出 web/dist
pnpm start     # 单进程同时提供页面与 /api，默认 http://127.0.0.1:8787
```

> ⚠️ **镜像热度不是开箱即用的**，它需要 registry 侧配合（加一段 `notifications` 配置并用同一个
> 密钥回调本服务，然后重启 registry）。不配的话热度页会给出配置片段，其余功能照常。
> 详见[镜像热度](#镜像热度)。

### 验证

```bash
pnpm type-check   # 前端类型
pnpm verify       # 非破坏性回归：basic 认证头 / Bearer 令牌流程 / 双端认证的完整拉取
```

`pnpm verify:real` 会访问**真实**公共 registry（ghcr.io / quay.io / mcr / 华为 SWR）
验证 Bearer 流程，需要出网，连不上会跳过；它不进默认 `verify`。
实测价值见下：mock 只能复现"我以为的"服务端行为，而真实世界更严格 ——
ghcr.io 会拒绝**无 scope** 的令牌申请（403），quay.io 回 401。

`pnpm verify` 会起几个进程内的 mock registry（Basic auth、Bearer 令牌各一套），用真实的
`PullQueue` 跑一次完整拉取，断言认证头真的发到了线路上、流式 PATCH 真的到达目的端、
blob 逐字节一致、manifest 原样落库。**不接触任何真实仓库**，可以随时跑。

## 容器化

镜像分三阶段：`builder` 装全量依赖并编译前端 → `prod-deps` 只装运行时依赖
（express + undici，约 6 MB）→ `runtime` 以非 root 运行。前端依赖（react / antd / vite）
都在 `devDependencies`，因为它们已被 Vite 打进 `web/dist`，服务端进程从不 require 它们。

### 用 Docker Compose

```bash
cp .env.example .env     # 填好 REGISTRY_URL
docker compose up -d --build
```

> ⚠️ **热度统计需要额外在 registry 侧配置，否则永远是空的。**
> 它靠 registry 主动回调（Distribution 的 `notifications` webhook）拿数据 ——
> 只在 `.env` 里设 `REGISTRY_NOTIFY_TOKEN` 是不够的，registry 那边也必须指向本服务、
> 并用同一个密钥，**且改完要重启 registry 容器**（Distribution 没有配置热重载）。
> 完整步骤见 [镜像热度 § 配置 registry 侧](#配置-registry-侧)。
> **拉取、浏览、删除都不受这个影响**，不配也能用。

`.env` 里的变量（`REGISTRY_URL` 必填，没填会直接报错而不是起一个连不上 registry 的容器）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REGISTRY_URL` | 无（必填） | 要管理的 registry 地址 |
| `REGISTRY_PROXY` | 空 | 访问 registry 的 HTTP 代理；留空直连 |
| `REGISTRY_USERNAME` | 空 | 本 registry 自身的 basic auth 用户名；留空 = 匿名 |
| `REGISTRY_PASSWORD` | 空 | 本 registry 自身的 basic auth 密码 |
| `REGISTRY_NAME` | `镜像仓库` | 展示名称 |
| `REGISTRY_CACHE_TTL_SECONDS` | `60` | 清单缓存时长 |
| `REGISTRY_ALLOW_DELETE` | `true` | `false` = 只读模式，拒绝所有删除 |
| `REGISTRY_ALLOW_PULL` | `true` | `false` = 禁止拉取模式，拒绝所有 `/api/pull/*` 写入 |
| `REGISTRY_PULL_QUEUE_SIZE` | `50` | 内存里保留的最近任务数（完整历史在 SQLite 里） |
| `REGISTRY_PULL_HISTORY_RETENTION_DAYS` | `90` | 拉取历史的保留天数 |
| `REGISTRY_NOTIFY_TOKEN` | 空 | 热度事件的共享密钥；**不设置则拒绝所有事件** |
| `REGISTRY_ALLOW_REGISTRY_EVENTS` | `true` | `false` = 不再接收热度事件（历史仍可查） |
| `REGISTRY_STATS_RETENTION_DAYS` | `90` | 热度数据的保留天数 |
| `REGISTRY_STATS_IGNORE_USERAGENTS` | 空 | 不计入热度的客户端 User-Agent 片段（逗号分隔、子串匹配、忽略大小写）。用来排掉常驻的同步工具，见[自动化流量](#自动化流量会把热度刷高) |
| `REGISTRY_CREDENTIAL_KEY` | 无（强烈建议填） | 凭据库加密密钥；缺失时凭据库不可用（拉取仍可匿名） |
| `REGISTRY_CREDENTIALS_DIR` | `/app/data` | 数据目录：凭据、代理库与 SQLite 数据库都在这里 |
| `HOST_PORT` | `8787` | 宿主机端口（容器内固定 8787） |
| `IMAGE` | `registry-manager:0.7.2` | 镜像名；改成带 registry 前缀的完整名即可直接 `docker compose push` |
| `NODE_IMAGE` | `node:22-alpine` | 构建用基础镜像，供拉不到 Docker Hub 的构建机覆盖 |

注意 `REGISTRY_PROXY` 是**访问 registry** 用的代理，和**构建机访问 npm** 用的代理是两回事，
后者要 `docker compose build --build-arg HTTPS_PROXY=...`。

健康检查继承自镜像里的 `HEALTHCHECK`，compose 不重复声明，避免两处漂移。

### 构建

```bash
docker build -t registry-manager:0.7.2 .
```

**构建机拉不到 Docker Hub 时**，先把 `node:22-alpine` 推进内网 registry，再覆盖基础镜像：

```bash
docker build \
  --build-arg NODE_IMAGE=192.0.2.10:10001/node:22-alpine \
  -t registry-manager:0.7.2 .
```

注意镜像里那份 `node:22-alpine` 是 **amd64 单架构**，在 arm64 机器上构建需要另找 arm64 的基础镜像。

**构建机访问 npm registry 需要代理时**，用构建参数传入（只作用于构建阶段，不会进入最终镜像）：

```bash
docker build \
  --build-arg HTTP_PROXY=http://<构建容器能访问到的代理>:<端口> \
  --build-arg HTTPS_PROXY=http://<构建容器能访问到的代理>:<端口> \
  -t registry-manager:0.7.2 .
```

⚠️ 代理地址必须是**构建容器内**能访问到的地址。写 `127.0.0.1` 只会指向容器自己，不是宿主机；
Linux 上用宿主机在 docker0 上的地址（或用 `--network=host`），macOS/Windows 上用
`host.docker.internal`。

在 Apple Silicon 上构建、但目标是 amd64 集群时加 `--platform linux/amd64`。

### 运行

```bash
docker run -d --name registry-manager \
  -p 8787:8787 \
  -e REGISTRY_URL=http://192.0.2.10:10001 \
  -e REGISTRY_PROXY=http://proxy.example.com:8080 \
  registry-manager:0.7.2
```

打开 http://localhost:8787 。常用变体：

```bash
# 只读模式：隐藏删除入口并拒绝所有删除请求
-e REGISTRY_ALLOW_DELETE=false

# 改端口（容器内外都要改）
-p 9090:9090 -e PORT=9090
```

也可以挂载配置文件代替环境变量：

```bash
-v "$PWD/registry.config.json:/app/registry.config.json:ro"
```

注意**环境变量优先级高于配置文件**，两者同时存在时以环境变量为准。

### 推到你自己的 registry

这个工具本身也可以托管在它管理的 registry 里：

```bash
docker tag registry-manager:0.7.2 192.0.2.10:10001/example/registry-manager:0.7.2
docker push 192.0.2.10:10001/example/registry-manager:0.7.2
```

### 镜像内置

- 基础镜像 `node:22-alpine`，以 uid 1000 的 `node` 用户运行，不写磁盘。
- pnpm 版本由 `package.json` 的 `packageManager` 固定，构建用 `--frozen-lockfile`。
- `HEALTHCHECK` 用 node 自带 fetch 探 `/api/config`，无需额外装 curl。
- 容器收到 `SIGTERM` 时先停止接收新连接、等在途请求结束再退出。
- **非 root 运行的前提是文件可读**：`COPY` 会原样带上构建上下文里的权限位。若源码是以
  `600` 落盘的（某些编辑器、工具或 `umask` 会这样），进镜像后属主是 root，切到 `node`
  用户就会报 `EACCES: permission denied, open '/app/server/index.mjs'`。Dockerfile 因此
  对运行阶段的所有 `COPY` 显式加了 `--chown=node:node`，并用 `chmod -R a+rX` 兜底，
  不依赖宿主机的权限位。
- **`registry.config.json` 刻意不打进镜像**（`.dockerignore` 排除），避免把某台机器的
  registry 地址与代理固化进去。

## 配置

优先级：环境变量 > `registry.config.json` > 默认值。

| 配置项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `name` | `REGISTRY_NAME` | `镜像仓库` | 展示名称 |
| `url` | `REGISTRY_URL` | 无（必填） | registry 地址，须带 `http://` 或 `https://` |
| `proxy` | `REGISTRY_PROXY` | 空 | 访问 registry 需要经过的 HTTP 代理 |
| `username` | `REGISTRY_USERNAME` | 空 | 本 registry 自身的 basic auth 用户名 |
| `password` | `REGISTRY_PASSWORD` | 空 | 本 registry 自身的 basic auth 密码（不回显到任何接口） |
| `cacheTtlSeconds` | `REGISTRY_CACHE_TTL_SECONDS` | `60` | 清单缓存时长 |
| `allowDelete` | `REGISTRY_ALLOW_DELETE` | `true` | 设为 `false` 进入只读模式，服务端拒绝一切删除 |
| `allowPull` | `REGISTRY_ALLOW_PULL` | `true` | 设为 `false` 后服务端拒绝一切 `/api/pull/*` 写入 |
| `pullQueueSize` | `REGISTRY_PULL_QUEUE_SIZE` | `50` | 内存里保留的最近任务数（完整历史在 SQLite 里，见下） |
| `pullHistoryRetentionDays` | `REGISTRY_PULL_HISTORY_RETENTION_DAYS` | `90` | 拉取历史的保留天数（与热度**分开配置**） |
| `notifyToken` | `REGISTRY_NOTIFY_TOKEN` | 空 | 热度事件的共享密钥。**只从环境变量读**；不设置则拒绝所有事件 |
| `allowRegistryEvents` | `REGISTRY_ALLOW_REGISTRY_EVENTS` | `true` | 设为 `false` 后不再接收热度事件（历史仍可查询） |
| `statsRetentionDays` | `REGISTRY_STATS_RETENTION_DAYS` | `90` | 热度数据的保留天数 |
| `statsIgnoreUseragents` | `REGISTRY_STATS_IGNORE_USERAGENTS` | `[]` | 不计入热度的客户端 User-Agent 片段；环境变量写逗号分隔的字符串，配置文件里可以写成数组 |
| `allowCredentials` | (env 决定) | - | 是否启用凭据库（由 `REGISTRY_CREDENTIAL_KEY` 是否设置决定） |
| `credentialsDir` | `REGISTRY_CREDENTIALS_DIR` | `/app/data` | 数据目录：凭据、代理库与热度数据库都在这里 |
| `port` | `PORT` | `8787` | 监听端口 |

只有一个 registry：多实例配置属于平台能力，不属于这个工具。

## 接口

统一返回 `{ success, code, message, data }`。registry 的"能力性拒绝"（例如删除被拒）
返回 `success: false` + 稳定 `code`，HTTP 仍是 200 —— 它是页面要内联展示的领域事实。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 当前配置（不含任何凭据） |
| GET | `/api/inventory` | 镜像清单（命中缓存则直接返回） |
| POST | `/api/refresh` | 强制重新扫描 |
| POST | `/api/probe` | 探测连通性与 API 版本 |
| DELETE | `/api/tags?repository=&tag=` | 删除一个 tag 指向的 manifest |
| POST | `/api/pull/jobs` | 创建镜像拉取任务 |
| GET | `/api/pull/jobs` | 列出全部任务（当前 + 排队 + 历史） |
| GET | `/api/pull/jobs/:id` | 单任务详情（含每个 phase 进度） |
| POST | `/api/pull/jobs/:id/cancel` | 优雅取消（传输中的 chunk 会写完） |
| DELETE | `/api/pull/jobs/:id` | 从历史移除（不影响已落库的镜像） |
| GET | `/api/credentials` | 列出凭据（密码不回显） |
| GET | `/api/credentials/:id` | 单条凭据详情 |
| POST | `/api/credentials` | 创建凭据（请求带密码明文） |
| PATCH | `/api/credentials/:id` | 更新（密码字段省略或空字符串视为不更新） |
| DELETE | `/api/credentials/:id` | 删除凭据 |
| POST | `/api/credentials/:id/test` | 用此凭据打一次 `GET /v2/`，验证可达性 |
| GET | `/api/proxies` | 列出代理（密码不回显） |
| GET | `/api/proxies/:id` | 单条代理详情 |
| POST | `/api/proxies` | 创建代理 |
| PATCH | `/api/proxies/:id` | 更新（密码传空字符串 = 清掉，改成匿名代理） |
| DELETE | `/api/proxies/:id` | 删除代理 |
| POST | `/api/proxies/:id/test` | 穿过该代理访问目标，返回状态码与耗时 |
| POST | `/api/registry-events` | **registry 调用**：接收 push/pull 事件；需 `Authorization: Bearer <REGISTRY_NOTIFY_TOKEN>` |
| GET | `/api/stats/summary?days=` | 热度总览（合计、拉取、推送、仓库数、最近事件时间） |
| GET | `/api/stats/top?days=&limit=&by=repository\|tag` | 热度 Top 榜 |
| GET | `/api/stats/series?days=&repository=` | 按天时间序列（`repository` 留空为全部） |
| GET | `/api/stats/repositories?days=` | 全部有热度的仓库（返回 map，供列表页 join） |
| GET | `/api/stats/events?limit=` | 最近收到的原始事件（含未被计入的原因与客户端身份），**排查用** |
| DELETE | `/api/stats/heat` | **清空全部热度数据**（不按保留期）。只清热度聚合与去重记录，拉取历史不受影响 |

`/api/registry-events` 是唯一面向机器的写接口，因此和其它接口有两点不同：
**失败返回真实的 HTTP 状态码**（401 / 503 / 400，registry 靠状态码决定重试与告警），
且**先校验密钥再解析请求体**。

## 规模与边界

- 一次全量扫描要逐个 tag 读 manifest 与 image config（registry 没有聚合接口）。
  实测 64 仓库 / 78 tag 约 **1 秒**；上限由 `MAX_REPOSITORIES`(2000) 与
  `MAX_TAGS_PER_REPOSITORY`(500) 约束，超出会在页面上标记"已截断"。
- 「镜像层合计」是各 manifest 中 layer 大小之和，**不是磁盘占用**：不同 tag 与仓库
  共享底层 blob，且 Distribution 没有任何存储用量 API。
- 删除只解除 manifest 引用，磁盘空间需要另行运行 `registry garbage-collect`。

## 关于删除能力的重要提醒

**不要用 `OPTIONS /v2/<name>/manifests/<digest>` 的 `Allow` 头判断删除是否可用。**
实测该 registry 在删除关闭时同样宣告 `Allow: DELETE, GET, HEAD, PUT`，这个头是假的。

判断删除能力只能以真实请求的结果为准：

| 请求 | 结果 | 含义 |
| --- | --- | --- |
| `DELETE` 一个存在的 digest | `201` | 删除已开启，且真的删掉了 |
| `DELETE` 一个不存在的 digest | `404 MANIFEST_UNKNOWN` | 删除已开启 |
| `DELETE` 按 tag | `400 DIGEST_INVALID` | Distribution 只支持按 digest 删除 |
| `DELETE` 任意 digest 都得到 `405` | `405` | 删除确实被关闭 |

本工具只按 digest 删除，并把上述状态翻译成页面上的明确提示。
如果不希望任何人从页面删除镜像，设置 `allowDelete: false`。

## 镜像拉取

`镜像拉取` 页面把外部 registry 的镜像落到当前仓库：

- **表单是两个输入框，中间的主机是固定文本**：

  ```
  源镜像名    [ library/alpine:3.19                 ]   ← 支持带主机前缀
  目标镜像名  [ 192.0.2.10:10001/ ][ library/alpine:3.19 ]   ← 前缀不可编辑
  ```

  目标镜像名默认与源镜像同名，**可以改**，用来换落地路径：`alpine:3.19`、
  `example/alpine:3.19` 都行。留空即沿用源镜像。
- **目的端主机固定来自配置**，页面上以静态文本呈现、没有输入框 ——
  工具一次只管理一个 registry，不存在"配成 push 到另一个 registry"的可能。
  （往目标镜像名里塞主机，例如 `192.0.2.20:10001/foo`，会被直接拒绝。）
- 目标镜像名不带 tag 时沿用源 tag（前端会把最终结果算出来给预览确认）。
- 单并发 + FIFO 队列：同一时刻只跑一个任务，其他任务按提交顺序排队。
- 每个任务可以单独配 `来源代理`（仅作用于源端，目的端走服务配置的代理），
  应对"源在公网 / 受限网段、本仓库在内网"这种跨网段场景。
- 复制优先走 Distribution 的 cross-repo mount（命中即 0 字节传输）；
  源端没开 mount 时回落为流式 PATCH，**数据始终在两个 registry 之间流式搬运**，不经过本进程内存。
- 优雅取消：标记 `cancelled` 后立即让源 / 目的 stream 停止传输 —— 正在写的当前 chunk
  会写完才退出，目的端不会留下半截 manifest。已落库的 blob 不主动清理（沿用
  "删除不立即释放磁盘" 的约定），交给 `registry garbage-collect` 兜底。
- **运行态在内存、历史在 SQLite**：排队与执行中的任务（含实时进度）只在进程内，不需要数据库；
  任务到达终态时追写一条历史到 `data/registry-manager.db`，**所以重启之后仍然查得到**
  "上周搬了哪些镜像"。历史默认保留 90 天（`REGISTRY_PULL_HISTORY_RETENTION_DAYS`）。

### 上传会话的 Location 可能指向别的主机

Distribution 在上传走重定向、配了 `REGISTRY_HTTP_HOST`、或使用对象存储网关时，
`POST /blobs/uploads/` 返回的 `Location` 会是**绝对 URL，且主机与 `REGISTRY_URL` 不同**。

早期实现用 `finalUrl.replace(baseUrl, '')` 去前缀，跨源时什么都替不掉，path 变成完整
URL，再被拼成 `http://basehttp://other/...` 这种畸形地址 —— 表现为
**「manifest 已读取，但目的 PUT 404」**这种自相矛盾的现象（因为 PATCH 用的是 URL 对象，
是正确的；只有 PUT 走字符串替换被拼坏了）。

现在：跨源 Location 原样使用、同源只取 path+query，并且收尾一律用 PATCH 响应里
**最新**的 Location（而非最初那个）。若你确实遇到 PUT 404，报错里会带上实际请求的
URL，并提示检查 registry 的 `REGISTRY_HTTP_HOST` 是否与 `REGISTRY_URL` 一致。

### 创建前的预检

点「确认入队」前会先弹预览，并真的做两次只读探测：

| 探测 | 结果 |
| --- | --- |
| 源 `GET /v2/` | 源是否可达、API 版本 |
| 源 / 目的各一次 `HEAD manifest` | 源 tag 是否存在；目标 tag 是否已存在、会不会被替换 |

对应四种提示：

- **源镜像不存在** → 拦下并禁用「确认入队」（拼错 tag 不用等入队后才失败）；
- **目标 tag 不存在** → 提示将新建；
- **目标 tag 已存在且与源 digest 一致** → 提示重复拉取不会改变内容；
- **目标 tag 已存在但 digest 不同** → 警告**将替换该 tag**，并列出替换前后的 digest。
  （manifest `PUT` 是覆盖语义，原 manifest 不保留。）


`allowPull: false`（环境变量 `REGISTRY_ALLOW_PULL=false`）可以一键关闭写入，
GET 列表仍可读，便于运维查看历史任务。

### 认证 / 代理怎么配：都分两处，不要混

凭据与代理都按**作用对象**分成两处，这是刻意的：

| 凭据 | 配在哪 | 为什么 |
| --- | --- | --- |
| **本 registry 自身**（工具要管理的那个） | `registry.config.json` 的 `username` / `password`，或环境变量 `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` | 这是**部署级**凭据：没有它连「镜像列表」都打不开，所以服务启动时就必须具备。它作用于**所有**对本仓库的请求（盘点、删除、拉取时的 mount / blob / manifest 落库），因此没有"每个任务选一次"的意义。 |
| **外部源 registry**（要去拉镜像的地方） | 页面上的「凭据管理」 | 源是**任务级**的：同一个源可以拉很多次，也可能有多个源。所以放进可增删改的凭据库，任务里按需选用。 |
| **本 registry 的代理** | `registry.config.json` 的 `proxy`，或 `REGISTRY_PROXY` | 同上：没有它连「镜像列表」都打不开，必须是启动级配置，作用于所有对本仓库的请求。 |
| **外部源的代理** | 页面上的「代理管理」 | 与源凭据同理，是任务级的：读哪个源、走哪个代理，都在任务里选。 |

因此任务表单里**只有「源认证」和「源端代理」**，没有「目的认证 / 目的代理」；
凭据库与代理库里也**没有"用途"维度** —— 里面全是给源用的。

两者共用 `REGISTRY_CREDENTIAL_KEY` 派生出的密钥，但落在**两个独立文件**
（`credentials.json` / `proxies.json`），互不影响。

本仓库的凭据只以布尔形式暴露给页面（`usingAuth`），密码不会出现在任何接口响应里。

### 凭据管理（外部源认证）

`凭据管理` 页签维护外部源的 basic auth。任务表单里可以：

- 从凭据库**选一条**（按 registryUrl 严格匹配，不一致会被拒绝）；
- **临时输入**账号密码 —— **不写入凭据库**、不回显、不进任务历史；
- 或者**不用**（匿名源）。

凭据库本身是 AES-256-GCM 加密的 JSON 文件，路径默认 `/app/data/credentials.json`
（建议在 compose 里挂卷持久化）。密钥走环境变量 `REGISTRY_CREDENTIAL_KEY`，
scrypt 派生；密钥与文件**同时丢失 = 凭据永久不可恢复**，运维备份时务必一起带走。

启动时如果没设置 `REGISTRY_CREDENTIAL_KEY`，服务仍可启动并支持匿名拉取，
但凭据管理页会显示警告、相关 API 返回 `CREDENTIAL_KEY_MISSING`。

临时输入模式下，预览 Modal 不会做认证连通测试（密码不在凭据库、服务端拿不到）；
但任务真正开始时会带上账号密码去连源。

### 别把「镜像站的网站」当成 registry

国内很多镜像加速站（例如渡渡鸟 `docker.aityp.com`）的主域名其实是**网站**，
被 nginx 的 `Basic realm="Authorization Required"` 挡着，响应里连
`Docker-Distribution-Api-Version` 头都没有 —— 它**不是 registry**，怎么配凭据都拉不动。

而 `docker pull` 看起来"能用"，是因为配在 `daemon.json` 的 `registry-mirrors` 一旦失败，
**Docker 会静默回落到官方 registry**，你看到的成功其实没走镜像站。

真正承载镜像的往往是另一个域名。以渡渡鸟为例，实际可拉的是华为 SWR 上的同步结果：

```
源 registry  https://swr.cn-north-4.myhuaweicloud.com
镜像名       ddn-k8s/docker.io/library/nginx:latest
```

本工具对这两种情形给的是**不同**的错误：地址缺少 registry API 版本头时判为
`NOT_A_REGISTRY`（提示"这不是 registry"），而不是笼统地说"需要认证"。

### 公共源为什么"不用配凭据"也能拉

Docker Hub / ghcr / quay 这类 registry 用的是 **Bearer 令牌认证**，不是 basic auth：

1. 匿名请求先吃 `401` + `WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service=...`；
2. 客户端拿 realm 去换一个（匿名的，或带你账号的）token；
3. 用 `Authorization: Bearer <token>` 重试。

`docker pull nginx` 自动做这三步，所以"不用登录"也能拉公开镜像。本工具现在也走同一套流程，
**匿名即可拉公共镜像**；token 按 scope 缓存复用，不会每个请求都去换一次。
私有镜像则在令牌请求里带上你在「凭据管理」里配的账号 —— 所以凭据仍然有用，只是
它的作用是"换一个权限更高的 token"，而不是直接当 basic auth 用。

注意 `/v2/` 这个探测端点的挑战**不带 scope**，此时要申请一个**无 scope 的 token**
（`docker login` 验证凭据也是这么做的）。早期实现对空 scope 直接放弃申请，
导致"源可达性探测"对 Docker Hub 永远失败 —— 预览显示"源不可达 / 要求认证"，
入队按钮被禁用，用户根本进不到拉取那一步。

另外 `docker pull nginx` 能用的第二个原因是 CLI 自动补了 `library/` 前缀：
官方镜像在 Hub 上位于 `library/` 下，直接请求 `/v2/nginx/...` 是拿不到的，
而 Hub 对不存在的仓库也回 `401`，很容易被误读成"要认证"。本工具现在也做同样的补全：

```
输入 nginx:latest
  → 源 registry  https://registry-1.docker.io
  → 源镜像       library/nginx:latest      （自动补 library/）
  → 目标引用     192.0.2.10:10001/library/nginx:latest
```

`docker.io` / `index.docker.io` 这些别名也会被归一到真正的 API 主机
`registry-1.docker.io`（`docker.io` 本身是网站，不是 registry API）。
补全只对 Docker Hub 生效，其它 registry 没有这个约定。

### 代理管理（外部源代理）

`代理管理` 页签维护访问外部源用的 HTTP 代理，字段是名称、地址（`http://主机:端口`）、
可选的用户名 / 密码、备注。任务表单的「源端代理」可以选「不用 / 代理库 / 临时输入」，
临时输入同样不落库。

**连通性测试**：代理本身没有可直接访问的资源，所以测试会**实际穿过这个代理**去访问一个目标：

- 目标留空 → 本仓库的 `/v2/`（最常需要经代理访问的目标）；
- 想验证"能不能出外网"→ 填 `https://registry-1.docker.io/v2/` 之类；
- 结果给出 HTTP 状态码与耗时；超时上限 8 秒。

⚠️ 超时是用 `Promise.race` 硬兜底的，不能只靠 `AbortController`：实测当代理能建 TCP
但到不了目标时，undici 的 abort **不会穿透正在建立的 CONNECT 隧道**，请求会永远挂着 ——
只靠 abort 的话测试接口就永远不返回了。

代理的 basic auth 会以 `Proxy-Authorization` 发出；密码里的特殊字符（`@` `:` `/`）
会正确 URL 编码。匿名代理不发这个头。

### 数据目录不可用时怎么排查

凭据库与代理库共用同一个目录，页面会区分两种失败，**先看它给的是哪一种**：

| 页面提示 | 含义 | 怎么办 |
| --- | --- | --- |
| 未配置 `REGISTRY_CREDENTIAL_KEY` | 环境变量确实没读到 | 补上环境变量后重启 |
| 加密存储初始化失败（`CREDENTIAL_STORE_INIT_FAILED`） | **密钥已读到**，问题在数据目录 | 见下 |

第二种都是**目录不可用**。服务启动时会主动往目录里写一个探针文件来验证可写性
（不是等第一次新增凭据才失败），报错里直接给出目录、进程 uid 和修法：

```
数据目录不可用：/app/data
  原因：EPERM EPERM: operation not permitted, mkdir '/app/data'
  当前进程身份：uid=1000 gid=1000
  该目录必须【存在】且对上面这个 uid 可写。按部署方式挑一条：
  ...
```

先在容器里跑这几条确认现场：

```bash
docker compose exec registry-manager id
docker compose exec registry-manager ls -ld /app/data
docker compose exec registry-manager sh -c 'touch /app/data/.probe && echo 可写 || echo 不可写'
```

按情况挑一条修：

**1. `REGISTRY_CREDENTIALS_DIR` 指的是宿主机路径，但没挂载进容器**（最容易踩）。
容器有独立的文件系统，**看不到宿主机的 `/data/...`**；服务会以非 root 用户去
`mkdir` 那个路径，因为无权创建顶层目录而失败：

```
数据目录不可用：/data/registry-manager
  原因：EPERM ... mkdir '/data/registry-manager'
```

在宿主机上明明能看到、甚至 `777` 也没用 —— 那是宿主机的事。确认：

```bash
docker compose exec registry-manager ls -ld /data          # No such file or directory
docker inspect registry-manager --format '{{json .Mounts}}' # [] 就是没挂
```

挂上即可（宿主目录是 777 时不用改属主，node 用户能写）：

```yaml
    volumes:
      - /data/registry-manager:/app/data
```

然后把 `REGISTRY_CREDENTIALS_DIR` **删掉**，用镜像默认的 `/app/data` 最省事。

**2. 用的还是旧镜像**。镜像已通过
`RUN mkdir -p /app/data && chown node:node /app/data` 预建好该目录，旧镜像里没有：

```bash
docker compose up -d --build
```

**3. 命名卷是早先用旧镜像建出来的**，挂载点上没有镜像里的目录，Docker 就按 root 建了。
这时重新构建镜像也**不会**改已有卷的属主（Docker 只在卷首次创建时拷贝属主）。
卷里本来就没数据，删掉重建：

```bash
docker compose down
docker volume ls | grep registry-manager     # 找到卷名
docker volume rm <上面那个卷名>
docker compose up -d
```

**4. 用了 bind mount**，宿主机目录的属主必须是容器内的 uid 1000：

```bash
sudo chown -R 1000:1000 ./data
```

**5. 只想先跑起来**（**不持久化**，容器重建即丢）：

```bash
-e REGISTRY_CREDENTIALS_DIR=/tmp/registry-manager-data
```

## 镜像热度

统计每个仓库（以及每个 tag）被 **push / pull** 了多少次，用来回答"哪些镜像真有人在用、
哪些是拉了就没动过的僵尸镜像"——这是判断"能不能清理"的关键输入。

原理是 Distribution 原生的 webhook 通知：registry 在 manifest 的 push / pull 时主动回调本服务。
**管理服务只收事件，不进数据面**：`docker pull` 的字节一个包都不经过它。

> **这一节是热度能用的前提。** 热度不像拉取、浏览、删除那样开箱即用 ——
> 数据是 registry **主动推**过来的，所以只在本服务上设置密钥没有任何作用，
> 必须在 registry 的 `config.yml` 里加一段 `notifications` 并用同一个密钥，
> 然后**重启 registry 容器**。没配好的话热度页会给出可复制的配置片段，其余功能不受影响。

### 配置 registry 侧

在 registry 的 `config.yml` 里**顶级**加一段（与 `log` / `storage` / `http` / `health` 同级）：

```yaml
notifications:
  endpoints:
    - name: registry-manager
      url: http://registry-manager:8787/api/registry-events
      headers:
        Authorization: [Bearer <与 REGISTRY_NOTIFY_TOKEN 相同的密钥>]
      timeout: 2s
      threshold: 5
      backoff: 1s
```

然后：

1. 在服务端设置 `REGISTRY_NOTIFY_TOKEN`（两边必须一致，用 `openssl rand -hex 32` 生成）
2. **重启 registry 容器** —— Distribution 只监听 `SIGTERM`，没有配置热重载
3. 重启后确认 registry 日志里有 `configuring endpoint registry-manager`，这是配置生效的证据
4. 随便 `docker pull` 一个镜像，热度页应立刻出现计数

`url` 里的主机名要在 registry 容器内可解析（同一个 compose 网络直接用服务名即可）。

### 怎么算"一次拉取"

一次 `docker pull` 会产生十几条事件（每个层一条 blob），所以口径必须过滤：

| 事件 | 是否计入 | 原因 |
| --- | --- | --- |
| manifest 的 `HEAD`（按 tag） | ✅ | 带 tag，代表用户意图 |
| manifest 的 `PUT`（push 落库） | ✅ | 带 tag |
| manifest 的 `GET`（按 digest 取内容） | ❌ | 与上面那条 HEAD 是同一个 manifest，计入会翻倍 |
| 所有 blob 事件 | ❌ | 否则一次 15 层的拉取会被算成 15 次 |

结果是**一次拉取 = 1 次热度，与镜像层数无关**。

顺带一提：`docker push` 在探测 blob 是否存在时会发出 `action: "pull"` 的事件，
所以"pull 事件"并不等于"有人在拉镜像"——上面的过滤顺带把这种情况也排除了。

### 已知边界

- 热度**从配置生效那天开始**统计，之前的历史补不回来。
- 失败的拉取（401 / 404）不产生事件，所以热度只反映**成功**的推送与拉取。
- 保留期默认 90 天（`REGISTRY_STATS_RETENTION_DAYS`），按天聚合。
- 热度页底部有「最近事件」面板：事件到了但没被计入时，能直接看出原因，
  并能看到每条事件的客户端身份（`User-Agent` / 来源地址 / Host / 账号）。

### 自动化流量会把热度刷高

registry 上常驻的同步工具（regsync、skopeo 之类）会**按点扫全量**，于是每个 tag 的
热度都被刷成同一个数、「最近活动」也全是同一个时刻 —— 这时候热度榜测的是工具的心跳，
不是人。**热度口径本身没错**（那些确实是 push / pull 事件），缺的是"把机器和真人分开"。

**registry 侧排不掉它**：`notifications` 的过滤只有 `ignore.mediatypes` 与
`ignore.actions` 两项，没有按客户端 / 仓库 / User-Agent 过滤的入口。所以判断"是谁在打"
只能在这一侧做，判据是事件里的 `request.useragent`：

| 字段 | 能不能用来区分客户端 |
| --- | --- |
| `request.useragent` | **最可靠**。真人用 docker CLI（`docker/27.x ...`），同步工具带自己的 UA（如实测到的 `regclient/regsync (v0.11.5)`） |
| `request.addr` | **看情况**。从**别的机器**来的请求是真 IP（实测 `192.0.2.11:50672`）；与本 registry **同宿主的容器**（端口映射 + 客户端在宿主机上）则只会看到 Docker 网桥地址（如 `172.19.0.1`），那时它对所有人都是同一个值 |
| `request.host` | 通常不行。内网里所有客户端用的 Host 头都一样 |
| `actor.name` | 只有 registry **开了认证且同步工具用独立账号**时才可用；未开认证时它是空的 |

#### 怎么排

0. **先把"自己人"认出来**：`registry-manager/…` 是本工具自己发的请求（重新扫描时按 tag
   数量读 manifest 与 image config，一次几十上百条），`regclient/…`、`skopeo/…` 是同步工具，
   `docker/…` 才是真人。本工具的自身请求**不列在面板里**，只在标题上显示「自身请求 N 条」。
   （0.7.1 之前本工具没设 User-Agent，这些在 registry 侧显示成裸的 `undici`。）
1. **先看清是谁**：热度页 →「最近事件」→ 展开 → 看「客户端」列。有没有一个 UA 整齐地
   刷满所有仓库？（也可以 `curl /api/stats/events?limit=50`）
2. **把它的片段填进配置**，重启服务：

   ```bash
   # 逗号分隔；子串匹配、忽略大小写，所以不用带版本号
   REGISTRY_STATS_IGNORE_USERAGENTS=regclient/regsync,skopeo
   ```

   被忽略的事件**仍然留在「最近事件」里**，`reason` 标成 `IGNORED_USERAGENT:<命中的片段>` ——
   这样"被排掉了"和"事件根本没到"才分得清。忽略规则生效时，面板标题上会挂一个
   「已忽略：…」的标签，`/api/config` 里也能查到，不用猜配置有没有读到。

3. **清掉已经算歪的历史**：口径改正**只对以后生效** —— `activity_daily` 当初没留身份字段，
   追溯不回来。用 **设置页 → 清空热度数据** 清掉重新累计（只清热度聚合与幂等去重记录，
   **拉取历史不受影响**）。

### 与 Prometheus 指标的关系

Distribution 的 `registry_http_requests_total` **没有仓库维度标签**（实测只有
`handler` / `method` / `code`，其中 `handler` 是路由名如 `manifest` / `blob`），
所以按镜像的热度不可能来自指标。指标仍然有用：它是个全局计数，
可以拿来和事件数**对账**，判断 webhook 是否在丢事件。

## 许可证

[MIT](./LICENSE) © 2026 Chenjinteng

问题与建议请提到 [Issues](https://github.com/Chenjinteng/registry-manager/issues)。

