# 镜像热度（pull / push 统计）—— 设计

| | |
|---|---|
| 状态 | 已实现（0.4.0） |
| 存储 | SQLite，`node:sqlite`（Node 22 自带，零依赖、单文件、无服务） |
| 数据源 | Distribution `notifications` webhook（**唯一**的结构化按仓库数据源） |
| 落地文件 | `data/registry-manager.db` |

---

## 1. 要解决的问题

registry-manager 通过 V2 API 只能看到 registry 的**内容**（有哪些镜像），看不到**使用情况**。
于是回答不了：哪些镜像真有人在用、哪些是僵尸、磁盘要爆时该清谁。

Distribution 提供 `notifications.endpoints`，在 manifest 的 push / pull 时主动回调一个 HTTP 地址。
**manager 只收事件，不碰数据面**：`docker pull` 的字节一个包都不经过 manager。

## 2. 为什么不用另外两条路

| 备选 | 否决理由 |
|---|---|
| Prometheus metrics | **实测排除**。见 §3，指标里没有仓库维度标签 |
| 解析 access log | 可以做，但需要解决"容器日志怎么拿"（docker socket 或共享卷）、日志轮转、文本解析。实测用户的 compose 只留 30MB 日志窗口，做不了历史。webhook 是结构化的、官方支持的、零权限的 |

## 3. 实测事实（全部来自真实 registry，不是文档推断）

以下每一条都在 `registry:3.1.1` 上实测过，**与本仓库的过滤规则直接相关**：

### 3.1 Prometheus 指标没有仓库维度

`registry_http_requests_total` 的标签只有 `code` / `handler` / `method`，
`handler` 取值为**路由名**（`base` / `catalog` / `manifest` / `blob` / `tags`）。
遍历全部 64 个指标、216 个样本行，**没有任何一个带 repository / repo / name / namespace / image / tag 标签**。

对照实验：读一个 manifest + 一个 blob → `+1 handler=manifest GET 200`、`+1 handler=blob GET 200`。
且**按 tag 与按 digest 落在同一个桶**，无法区分。

→ **按镜像的热度不可能来自 metrics。** 但它是免费的**全局对账源**，见 §7。

### 3.2 一次 `docker pull` 会产生十几个事件

实测 `docker pull postgres:15`（15 层）产生 **17 条事件**：

| 事件 | action | method | mediaType | `target.tag` |
|---|---|---|---|---|
| tag 解析 | pull | **HEAD** | manifest.v2+json | **`"15"`** ✅ |
| 内容下载 | pull | GET | manifest.v2+json | **无 tag** ❌ |
| 各层 × 15 | pull | GET | **octet-stream** | — |

**必须只统计 manifest 事件**：按条数算热度会让 15 层的镜像比 1 层的重 17 倍，
"用了一次"却得到完全不同的分数。这与"镜像层合计不是磁盘占用"是同一类错误——
数字看着权威，含义被层数扭曲。

### 3.3 带 tag 的是 HEAD，不是 GET

Docker 的 pull 是两步：

```
HEAD /v2/<repo>/manifests/<tag>              → 拿到 digest，事件里带 tag
GET  /v2/<repo>/manifests/sha256:<digest>    → 取内容，事件里 tag 丢失
```

所以判据**不能**写成 `method ∈ {GET, PUT}`——那会留下不带 tag 的 GET、丢掉带 tag 的 HEAD。

**连带结论**：`digest 拉取` 与 `tag 拉取` 无法从事件里区分——每次普通 tag 拉取都会产生一条 digest GET。
（好处是修正后的判据绕开了这个问题。）

### 3.4 push 会产生假的 `pull` 事件

实测 `docker push`（3 层）产生 7 条事件，其中 **3 条是 `action: "pull"`**：

| action | method | mediaType |
|---|---|---|
| push | PUT | octet-stream |
| **pull** | **HEAD** | octet-stream ← push 前的 blob 存在性探测 |

**`action == "pull"` 不等于"有人在拉镜像"。** 不按 mediaType 过滤的话，推一个 20 层的镜像会凭空多出 20 次"拉取"。

### 3.5 blob 事件的 mediaType 是 `application/octet-stream`

不是 layer 的 media type。所以 manifest 白名单一卡，全部 blob 事件自动出局。

（这也解释了官方文档示例配置里的 `ignoredmediatypes: [application/octet-stream]`。）

### 3.6 其它字段

| 字段 | 实测值 | 用途 |
|---|---|---|
| `id` | UUIDv7（自带时间序） | 去重（registry 重试会重复投递） |
| `timestamp` | 小数位**不固定**（9 位 / 8 位混用） | Node 的 `new Date()` 能正确截断，无需特殊处理 |
| `actor` | `{}`（未认证时） | 现在恒为空，等认证做完后自然有值 |
| `request.addr` | **`172.19.0.1`（Docker 网桥网关）** | **不可用作客户端识别** → 本项目不做 IP 统计 |
| `source.instanceID` | 每个 registry 实例一个 UUID | 多实例合并用 |
| 信封 | 实测每条 1 个 event，但文档允许批量 | 接收端必须按数组处理 |

### 3.7 拿 manifest 必须带 `Accept`

`GET`/`HEAD /v2/<repo>/manifests/<ref>` **不带 `Accept` 会返回 404**（不是 400/406）。
裸 curl 探活会把"存在"读成"不存在"。

## 4. 过滤规则（最终）

```
target.mediaType 属于 manifest 白名单
AND request.method ∈ {HEAD, PUT}
```

| 事件 | 结果 | 理由 |
|---|---|---|
| pull 的 tag 解析（HEAD） | ✅ 计入 | **带 tag**，代表用户意图 |
| pull 的内容下载（GET） | ❌ 排除 | 无 tag，且与上一条同 digest，计入会翻倍 |
| push 落库（PUT） | ✅ 计入 | 带 tag |
| 多架构子 manifest（GET） | ❌ 排除 | 按 digest 取 |
| 全部 blob 事件 | ❌ 排除 | mediaType 为 `application/octet-stream` |

manifest 白名单：

- `application/vnd.docker.distribution.manifest.v2+json`
- `application/vnd.docker.distribution.manifest.list.v2+json`
- `application/vnd.docker.distribution.manifest.v1+json`
- `application/vnd.oci.image.manifest.v1+json`
- `application/vnd.oci.image.index.v1+json`

**白名单，不是黑名单**：未知类型默认丢弃并记 debug 日志。理由不对称——漏算一个未知 manifest 只是少算；
误算一类 blob 会把热度放大几十倍。

### 已知风险

判据依赖"Docker 先 HEAD 再 GET"这一行为，目前只实测了 `docker/29.6.1`。
若某个客户端直接按 tag GET 而不先 HEAD，那次拉取会被漏计。
**处理方式是不猜**：原始事件缓冲里保留了 `method`，将来发现漏计能立刻定位。

## 5. 范围

**做**：按 天 × 仓库 × tag × 动作（push/pull） 聚合的事件计数。

**明确不做**：客户端 IP、客户端类型归类、拉取字节数、失败拉取、
以及"按 digest 拉取 vs 按 tag 拉取"的区分（见 §3.3，事件里无法区分）。

## 6. 数据模型

```sql
PRAGMA user_version = 1;   -- schema 版本，第一版就要有

CREATE TABLE activity_daily(
  day        TEXT    NOT NULL,   -- YYYY-MM-DD（事件 timestamp 的 UTC 日期）
  repository TEXT    NOT NULL,
  tag        TEXT    NOT NULL,   -- '' 表示事件无 tag
  action     TEXT    NOT NULL,   -- 'push' | 'pull'
  events     INTEGER NOT NULL DEFAULT 0,
  last_at    TEXT    NOT NULL,
  PRIMARY KEY(day, repository, tag, action)
) WITHOUT ROWID;

CREATE INDEX idx_activity_repo ON activity_daily(repository, day DESC);

-- 去重：registry 的重试机制会重复投递同一个 event.id
CREATE TABLE event_seen(
  id      TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
) WITHOUT ROWID;
```

**为什么留 `tag`**：多一列、基数很小，而丢掉是不可逆的（没法回填历史）。
默认 UI 视图仍是仓库级（对 tag 求和）。

### 清理

| 表 | 保留 | 触发 |
|---|---|---|
| `activity_daily` | `REGISTRY_STATS_RETENTION_DAYS`（默认 90 天） | 启动时 + 每 24 小时 |
| `event_seen` | 7 天 | 同上 |

## 7. 对账（免费的可靠性验证）

`registry_http_requests_total{handler="manifest",method="get",code="200"}` 是**全局**的成功 manifest 读取计数。

在时间窗内比较它的**增量**与 webhook 收到的 manifest pull 事件数：
两个数不会相等（指标包含 digest GET、多架构子 manifest，而我们的口径排除了这些），
但应该**成比例**。长期严重偏离说明 webhook 在丢事件。

注意：这是**进程内计数器，registry 重启归零** → 只能比增量。

## 8. 部署（registry 侧）

```yaml
notifications:
  endpoints:
    - name: registry-manager
      url: http://registry-manager:8787/api/registry-events
      headers:
        Authorization: [Bearer <与 REGISTRY_NOTIFY_TOKEN 一致>]
      timeout: 2s
      threshold: 5
      backoff: 1s
```

- 加在**顶级**（与 `log` / `storage` / `http` / `health` 同级）
- **不使用** `ignore` / `ignoredmediatypes` 等服务端过滤：过滤放在 manager 侧，
  出问题能看到原始事件、能改代码，不必重启 registry
- **改完必须重启 registry**：Distribution 只监听 `SIGTERM`，没有 SIGHUP 热重载
- 重启后确认 registry 日志里有 `configuring endpoint ...` —— 这是配置生效的证据

## 9. 安全

`/api/registry-events` 是唯一面向机器的写接口。

| 措施 | 说明 |
|---|---|
| 共享密钥 | `REGISTRY_NOTIFY_TOKEN`；registry 侧用 `headers.Authorization` 发送 |
| 常量时间比较 | `crypto.timingSafeEqual`，不用 `===` |
| 未配置即拒绝 | 没设 token 时**拒绝所有事件**并提示，不提供"无密钥也能收"的默认 |
| 密钥不落日志 | 只暴露"是否已配置"布尔，绝不回显 |
| 请求体上限 | 独立 body parser，限制在 256kb |

## 10. 降级（开源用户的关键路径）

不配 `notifications` 的 registry 必须能正常使用本工具：

- 收不到事件 → 热度列显示 `—`，热度页显示**未启用**空状态
- 空状态里**直接给出可复制的 YAML 片段**（把 URL 和 token 占位符填好）
- 不影响任何现有功能，不报错
- SQLite 初始化失败同样**不阻断启动**（`statsError` + `statsEnabled: false`），
  与凭据库的失败处理一致
- 判据是"最近是否收到过事件"。收不到不一定是没配，也可能是最近确实没人拉，
  所以文案不能断言"你配错了"

## 11. 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/registry-events` | registry → manager 的事件入口（非浏览器调用） |
| `GET` | `/api/stats/summary` | 总览：总事件数、收录仓库数、最近事件时间 |
| `GET` | `/api/stats/top` | Top N 仓库 / tag（`?days=&limit=&by=`） |
| `GET` | `/api/stats/series` | 按天时间序列（`?repository=&days=`） |
| `GET` | `/api/stats/events` | 最近收到的原始事件（排查用，内存环形缓冲） |

`GET /api/config` 新增：`statsEnabled`、`statsError`、`statsSince`、`notifyTokenConfigured`。

## 12. 验证

`scripts/verify-stats.mjs`：构造真实形状的事件，断言

- manifest pull 事件 → 计数 +1，且 tag 正确
- **伴随的 GET（无 tag）不计入**（防翻倍）
- **`octet-stream` 事件被丢弃**（防放大几十倍）
- **push 时的 blob HEAD 不产生热度**（防假 pull）
- 重复 `event.id` 只计一次
- tag 为空的 manifest 事件仍计入仓库
- 未知 mediaType 被丢弃
- 错误 / 缺失 token 被拒
- 未启用时查询接口返回空而不报错

`pnpm verify:real` 之外，端到端靠真实 registry：配好 notifications 后
`docker pull` 一次，确认热度 +1。**mock 只能复现你以为的服务端行为**，
本仓库在 `/v2/` 挑战那次已经吃过一次亏。
