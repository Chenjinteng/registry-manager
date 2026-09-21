# AGENTS.md

本文件只记录本仓库特有、且会改变实现方式的约束。通用编码风格不在此重复。

## 这是什么

一个**独立**的 CNCF Distribution（Docker Registry HTTP API V2）镜像仓库管理 Web 工具：
浏览镜像、查看每个 tag 的 digest/架构/层数/体积/构建时间、复制 `docker pull`、按 digest 删除 manifest。

它**不依赖 平台**，只沿用了后者的视觉 token（`web/src/theme.css`，取自 平台
`web/src/theme/defaults.ts` 的 light 语义色板）。不要把 平台 的模块、权限、i18n
或 Django 后端引进来。

刻意不做的事：**没有登录，没有数据库，没有多实例配置**。一次管理一个 registry。
这些是产品决定，不是未完成项；要加先问。

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

- 结构对齐 平台 控制台：`header`（sticky 顶栏）→ `main`（`p-4`）→ **顶部横向 `Segmented` 导航**
  → 内容区。应用内导航在**顶部**，不要改成左侧栏。
- 颜色一律用 `web/src/theme.css` 里的语义 token（`var(--color-*)`），不要写死色值。
- KPI 卡解剖对齐 平台 的 `summary-metric-card`：图标块 28×28（语义色底）+ 13px 标签 + 粗体数值。

## 容器

三阶段：`builder` 编译前端 → `prod-deps` 只装 `express + undici`（约 6MB）→ `runtime` 非 root。

- 前端依赖（react / antd / vite）**故意放在 `devDependencies`**：服务端进程从不 require 它们，
  已被 Vite 打进 `web/dist`。移回 `dependencies` 会让运行镜像白白大几十 MB。
- 运行阶段的 `COPY` **必须带 `--chown=node:node`**，并保留 `chmod -R a+rX` 兜底。
  源码可能以 `600` 落盘，`COPY` 会原样带进镜像且属主是 root，非 root 的 `node` 用户会
  `EACCES: permission denied, open '/app/server/index.mjs'`。
- `registry.config.json` 由 `.dockerignore` 排除，**绝不能打进镜像**（会把某台机器的地址与代理固化）。
- 基础镜像可用 `--build-arg NODE_IMAGE=` 覆盖，供拉不到 Docker Hub 的构建机使用。

## 改动后如何验证

改动必须跑与影响范围匹配的**新鲜**验证：

```bash
./node_modules/.bin/tsc --noEmit      # 类型
./node_modules/.bin/vite build        # 构建
```

涉及 registry 交互时，起服务后打真实请求：

```bash
curl -s localhost:8787/api/config
curl -s -X POST localhost:8787/api/probe
curl -s -X POST localhost:8787/api/refresh   # 全量盘点
```

**渲染结果无法靠读代码确认** —— 涉及布局/样式时，要让人看截图或真实浏览器，不要臆断"应该没问题"。
本仓库的 UI 问题基本都是在截图里才暴露的。
