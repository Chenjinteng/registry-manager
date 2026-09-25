# 三阶段构建：
#   builder   装全量依赖并把前端编译成静态产物
#   prod-deps 只装运行时依赖（express + undici，约 6MB）
#   runtime   最终镜像，非 root 运行
#
# 前端依赖（react / antd / vite …）全部归在 devDependencies，因为服务端进程
# 从不 require 它们 —— 它们已经被 Vite 打进 web/dist 了。这样运行镜像不需要
# 带上 antd 那几十 MB。

# 基础镜像可覆盖：构建机若拉不到 Docker Hub，把镜像先推进内网 registry，
# 再这样构建 —— ARG 必须在第一个 FROM 之前声明。
#   docker build --build-arg NODE_IMAGE=192.0.2.10:10001/node:22-alpine .
ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------------------
# 1) 构建前端静态产物
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# 构建机若需经代理访问 npm registry，用 --build-arg HTTPS_PROXY=... 传入。
# 注意这个地址是**构建容器内**能访问到的地址：写 127.0.0.1 只会指向容器自己，
# 需要写宿主在容器网络里的地址。
# 它们只作用于构建阶段，不会进入最终镜像。
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# 构建机到 registry.npmjs.org 慢或不通时换源（不传就保持默认，仍走 npmjs）。
#
# 真正需要联网现拿的是**平台二进制包** —— `@esbuild/linux-x64`、
# `@rollup/rollup-linux-x64-musl` 之类：它们在 macOS 上装到的是 darwin 变体，
# Linux 容器里必须重新下载。其余纯 JS 依赖与平台无关，本来就会命中缓存。
# 所以"构建机上 npmjs 很慢"通常就卡在这几个包上，表现为下载超时、
# 而本地 pnpm install 一切正常。
#
# 只作用于构建阶段，不会进入最终镜像。
ARG NPM_REGISTRY

# 无 TTY 环境下 pnpm 不做交互确认；否则会在需要重装 node_modules 时报错。
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# pnpm 版本由 package.json 的 packageManager 字段固定为 11.20.0。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 必须写 --location=project：pnpm config set 默认不落到项目 .npmrc 上，不加这个参数
# 命令会"成功"但完全不生效，然后继续去 npmjs 拉（比直接失败更难查）。
RUN corepack enable pnpm \
 && pnpm --version \
 && if [ -n "$NPM_REGISTRY" ]; then pnpm config set registry "$NPM_REGISTRY" --location=project; fi

RUN pnpm install --frozen-lockfile

COPY tsconfig.json vite.config.ts ./
COPY web ./web
RUN pnpm build

# ---------------------------------------------------------------------------
# 2) 只装运行时依赖
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps

WORKDIR /app

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# 与 builder 阶段同一个来源开关（见上面的说明）。
ARG NPM_REGISTRY

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm \
 && pnpm --version \
 && if [ -n "$NPM_REGISTRY" ]; then pnpm config set registry "$NPM_REGISTRY" --location=project; fi \
 && pnpm install --prod --frozen-lockfile

# ---------------------------------------------------------------------------
# 3) 运行
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787

# --chown 在这里是必需的，不能依赖构建上下文里的文件权限：
# 源码可能是以 600 落盘的（某些编辑器/工具/umask 会这样），COPY 会原样带进镜像
# 且属主是 root；随后切到非 root 的 node 用户就会读不到 server/index.mjs，
# 报 EACCES: permission denied。
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# 运行只需要 package.json（读 packageManager/engines 与脚本元信息）、
# server 与构建产物；registry.config.json 刻意不打进镜像，一律由环境变量
# 或挂载提供，避免把某台机器的地址/代理固化进镜像。
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node --from=builder /app/web/dist ./web/dist

# 再兜一层：显式打开读权限（a+rX 只给目录和已可执行文件加 x），
# 这样无论上下文带来的权限位是什么，node 用户都能读。
RUN chmod -R a+rX /app/server /app/web/dist /app/package.json

# 数据目录：凭据库、代理库与热度统计的 SQLite 文件都落在这里。
#
# 必须在镜像里就建好并交给 node 用户：WORKDIR /app 是 root 所有（755），
# 非 root 的 node 用户无权在其中 mkdir，否则凭据库初始化会以
# "EPERM/EACCES: mkdir '/app/data'" 失败，表现为页面上凭据库不可用。
# 先建好目录，挂载空 volume 时 Docker 会沿用这里的属主。
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data

# node 镜像自带 uid 1000 的 node 用户。
USER node

EXPOSE 8787

# 用 node 自带的 fetch 做探针，不额外装 curl/wget。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --disable-warning 与 package.json 的 start 脚本保持一致：node:sqlite 在 Node 22 上
# 仍标注实验性，启动时打一条 ExperimentalWarning 会盖住真正有用的告警。
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
