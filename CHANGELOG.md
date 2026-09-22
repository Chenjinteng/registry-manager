# 更新日志

版本号规则见 [AGENTS.md](./AGENTS.md#版本号规则)：`主.中.小` 三位。

- **主**：由人决定，新增/破坏性变化时才动；
- **中**：每新增一个功能或模块 +1；
- **小**：缺陷修复与现有功能优化。

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
