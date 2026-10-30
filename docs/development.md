# 开发、验证与集成

目标是让本地修改获得快速反馈，再由 CI 的干净环境验证可复现性。下文提供默认路径，任务范围和既有授权决定需要走到哪里。

## 本地工作

首次启动按 [README](../README.md) 操作。Node 版本以 [.node-version](../.node-version) 为准，命令定义在 [package.json](../package.json)。当前本地运行不需要 Docker、部署账号或生产凭据。

开发模式由 Node watch 运行服务端源码，Vite 提供前端热更新和同源代理。先按[身份说明](identity.md)初始化本地管理员。验证生产目录布局时，先停止占用同一端口的开发服务，再执行：

```sh
npm run build
ZHONGSHU_ORIGIN=http://127.0.0.1:3000 ZHONGSHU_ALLOW_HTTP_LOOPBACK=true npm start
```

默认本地访问 `http://127.0.0.1:3000`；生产使用配置的 HTTPS origin。环境通过进程传入，服务不自动读取 `.env`。构建默认标记为 `development`；对干净的已提交源码可用 `REVISION=$(git rev-parse HEAD) npm run build` 关联版本。提交标记本身不证明工作区没有未提交修改。

涉及容器或交付边界时，在本地 Docker 可用的情况下验证实际 Compose 路径：

```sh
docker build -t zhongshu:local .
IMAGE=zhongshu:local docker compose --project-name zhongshu-local up -d --wait
# 访问 http://127.0.0.1:8787，完成后停止本地实例：
IMAGE=zhongshu:local docker compose --project-name zhongshu-local down
```

配置项见 [.env.example](../.env.example) 和 [compose.yaml](../compose.yaml)。后续引入外部依赖时，一并提供可复现的本地运行与必要数据准备方式；模拟反馈与真实集成验证要明确区分。

[容器检查脚本](../scripts/check-container.mjs)用于已启动、具有全新数据卷的临时 `zhongshu-check` Compose 项目；可用 `ZHONGSHU_CHECK_PROJECT=zhongshu-check-<后缀>`指定同类测试项目。它会初始化随机测试密码，验证真实登录、生产 Cookie 属性、容器替换后的会话保留，以及在线备份、新目录恢复和旧会话吊销；随后清理自己创建的恢复容器与临时目录。它不会复用已有管理员的数据卷，也不用于真实实例。完整启动与销毁命令以 [CI](../.github/workflows/ci.yml)为准，临时 Compose 项目和数据卷由调用方清理。

该脚本直接请求回环 HTTP 端口，模拟 TLS 终止后的内部链路，并验证配置的 HTTPS origin；它不证明浏览器已通过 TLS 收发 Secure Cookie。

## 决定怎样验证

修改前从 [feature-map](features/README.md)选受影响的行为，明确预期、边界及证据，再按[通用验证能力](verification.md)准备现场。简单任务可以直接执行；复杂任务按需使用计划、原型或独立审查。

当前代码变更的基础检查是 `npm run typecheck`、`npm test` 与 `npm run build`；在此之上，根据影响选择接口、浏览器、容器或真实集成验证。纯文档改动检查内容准确性、入口和链接即可。测试应检验行为或契约，新增测试需要有实际保护价值。

本地和 CI 复用仓库中的检查定义。自动检查适合稳定、可判定的约束；涉及取舍的经验通过理由和例子传递。发现验证遗漏时，改进最接近实际失败边界的反馈。

交付时说明改动效果、实际完成的检查及重要限制。运行证据关联版本和环境，优先链接已有记录。无法运行某项检查时说明缺口及影响，不能将“尚未验证”写成“通过”。

## 从本地变更到 main

在开发分支完成修改和相关验证，向远程 `main` 提交 PR。PR 保留变更目的、验证证据和重要限制；CI 通过后按任务授权合并，`main` 保持可集成状态。

[CI](../.github/workflows/ci.yml) 在 PR 和 `main` 更新时执行接口与构建检查，并启动实际 Compose 容器核对版本。具体命令以仓库定义为准。GitHub 的合并门禁由仓库设置执行，不能仅凭存在 workflow 推断保护已启用。

代码集成与生产发布分开。开发者的完成边界是已验证、可审阅的 PR，或任务已授权的合并；这不隐含上线授权。具体发布分支的推进、部署目标、凭据、恢复操作及发布 skill 由操作者在源码之外维护。仓库保留通用构建与自动化执行接口，产品开发无需读取实例运维资料。

## 留下可接续的知识

知识归属与维护路径见[文档入口](README.md)，本地操作方法归本文。中断工作时在任务或 PR 中补足剩余问题和下一步上下文，不另建一份平行的项目状态文档。

重复且确定的操作适合脚本；反复出现、需要判断的工作方法再考虑提炼 skill，引用现有知识来源。新增规范应说明保护的目标，随实际摩擦修订和删减。

用后续真实小任务检验这套体系：一个新上下文的 Agent 能否从正常入口找到必要信息、独立修改并验证、留下足够的接续信息。发现障碍时修正对应入口、结构或反馈。
