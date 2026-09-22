# 镜像仓库管理（registry-manager）

一个独立的 Web 工具，用来浏览和管理 **CNCF Distribution**（Docker Registry HTTP API V2）里的镜像。

不依赖 平台：UI 只沿用了它的视觉 token 与 Ant Design 主题，代码零耦合，可以单独部署。

## 它能做什么

- **镜像列表**：搜索仓库名、按体积或构建时间排序。
- **镜像详情**：每个 tag 的 digest、架构与操作系统、层数、体积、构建时间，一键复制 `docker pull` 命令。
- **删除镜像**：按 manifest digest 删除。删除前会列出同一 digest 下的全部 tag，并说明磁盘空间不会立即释放。
- **镜像拉取**：从外部 registry 拉取镜像落到本仓库，单并发 + FIFO 队列，支持任务级来源代理，优雅取消。
- **清单概览**：仓库数、tag 数、镜像层合计、清单刷新时间，以及读取失败的 tag 明细。
- **连接自检**：一键测试 registry 连通性与 API 版本。

没有登录、没有数据库。清单在内存里缓存，重启即重新扫描。

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

开发态前端在 http://127.0.0.1:5273 （`/api` 自动代理到服务端）。
生产态：

```bash
pnpm build     # 产出 web/dist
pnpm start     # 单进程同时提供页面与 /api，默认 http://127.0.0.1:8787
```

## 容器化

镜像分三阶段：`builder` 装全量依赖并编译前端 → `prod-deps` 只装运行时依赖
（express + undici，约 6 MB）→ `runtime` 以非 root 运行。前端依赖（react / antd / vite）
都在 `devDependencies`，因为它们已被 Vite 打进 `web/dist`，服务端进程从不 require 它们。

### 用 Docker Compose

```bash
cp .env.example .env     # 填好 REGISTRY_URL
docker compose up -d --build
```

`.env` 里的变量（`REGISTRY_URL` 必填，没填会直接报错而不是起一个连不上 registry 的容器）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REGISTRY_URL` | 无（必填） | 要管理的 registry 地址 |
| `REGISTRY_PROXY` | 空 | 访问 registry 的 HTTP 代理；留空直连 |
| `REGISTRY_NAME` | `镜像仓库` | 展示名称 |
| `REGISTRY_CACHE_TTL_SECONDS` | `60` | 清单缓存时长 |
| `REGISTRY_ALLOW_DELETE` | `true` | `false` = 只读模式，拒绝所有删除 |
| `REGISTRY_ALLOW_PULL` | `true` | `false` = 禁止拉取模式，拒绝所有 `/api/pull/*` 写入 |
| `REGISTRY_PULL_QUEUE_SIZE` | `50` | 内存里保留的最近任务数；超出按创建时间最旧剔除 |
| `HOST_PORT` | `8787` | 宿主机端口（容器内固定 8787） |
| `IMAGE` | `registry-manager:0.1.0` | 镜像名；改成带 registry 前缀的完整名即可直接 `docker compose push` |
| `NODE_IMAGE` | `node:22-alpine` | 构建用基础镜像，供拉不到 Docker Hub 的构建机覆盖 |

注意 `REGISTRY_PROXY` 是**访问 registry** 用的代理，和**构建机访问 npm** 用的代理是两回事，
后者要 `docker compose build --build-arg HTTPS_PROXY=...`。

健康检查继承自镜像里的 `HEALTHCHECK`，compose 不重复声明，避免两处漂移。

### 构建

```bash
docker build -t registry-manager:0.1.0 .
```

**构建机拉不到 Docker Hub 时**，先把 `node:22-alpine` 推进内网 registry，再覆盖基础镜像：

```bash
docker build \
  --build-arg NODE_IMAGE=192.0.2.10:10001/node:22-alpine \
  -t registry-manager:0.1.0 .
```

注意镜像里那份 `node:22-alpine` 是 **amd64 单架构**，在 arm64 机器上构建需要另找 arm64 的基础镜像。

**构建机访问 npm registry 需要代理时**，用构建参数传入（只作用于构建阶段，不会进入最终镜像）：

```bash
docker build \
  --build-arg HTTP_PROXY=http://<构建容器能访问到的代理>:<端口> \
  --build-arg HTTPS_PROXY=http://<构建容器能访问到的代理>:<端口> \
  -t registry-manager:0.1.0 .
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
  -e REGISTRY_PROXY=http://192.0.2.10:4433 \
  registry-manager:0.1.0
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
docker tag registry-manager:0.1.0 192.0.2.10:10001/example/registry-manager:0.1.0
docker push 192.0.2.10:10001/example/registry-manager:0.1.0
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
| `cacheTtlSeconds` | `REGISTRY_CACHE_TTL_SECONDS` | `60` | 清单缓存时长 |
| `allowDelete` | `REGISTRY_ALLOW_DELETE` | `true` | 设为 `false` 进入只读模式，服务端拒绝一切删除 |
| `allowPull` | `REGISTRY_ALLOW_PULL` | `true` | 设为 `false` 后服务端拒绝一切 `/api/pull/*` 写入 |
| `pullQueueSize` | `REGISTRY_PULL_QUEUE_SIZE` | `50` | 内存里保留的最近任务数；超出按创建时间最旧剔除 |
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

- 单并发 + FIFO 队列：同一时刻只跑一个任务，其他任务按提交顺序排队。
- 每个任务可以单独配 `来源代理`（仅作用于源端，目的端走服务配置的代理），
  应对"源在公网 / 受限网段、本仓库在内网"这种跨网段场景。
- 复制优先走 Distribution 的 cross-repo mount（命中即 0 字节传输）；
  源端没开 mount 时回落为流式 PATCH，**数据始终在两个 registry 之间流式搬运**，不经过本进程内存。
- 优雅取消：标记 `cancelled` 后立即让源 / 目的 stream 停止传输 —— 正在写的当前 chunk
  会写完才退出，目的端不会留下半截 manifest。已落库的 blob 不主动清理（沿用
  "删除不立即释放磁盘" 的约定），交给 `registry garbage-collect` 兜底。
- 任务只存内存，重启即丢；这是刻意的 —— 与现有清单缓存一致，避免引入持久化依赖。

源暂不支持认证：源返回 `UNAUTHORIZED` 时透传错误提示，不存凭据。如果需要拉私有源，
先用临时方案把镜像提前推到公网可达的位置或自己写一个反代。

`allowPull: false`（环境变量 `REGISTRY_ALLOW_PULL=false`）可以一键关闭写入，
GET 列表仍可读，便于运维查看历史任务。
