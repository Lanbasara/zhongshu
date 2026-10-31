# 私人入口：feature map

范围：单管理员登录、身份恢复与退出；初始化、密码重置和备份恢复的操作细节在外层实例运维记录中。身份与会话决策归 [ADR 0006](../adr/0006-auth-session-data.md)。

## Sub-features

- 初始化前与首次登录：全新数据目录显示“管理员尚未完成初始化”；按可信 CLI 初始化后登录。
- 刷新与普通重启：有效身份保留。
- 多端与退出：两个独立浏览器上下文分别登录；退出只吊销当前会话。
- 重置与过期：CLI 重置或过期后，私有请求和对应更新流失效。
- 登录状态竞争：延迟旧的 session 查询，再登录/退出，旧响应不得覆盖新身份。

## How to get to it (user POV)

1. 打开应用进入“登录中书”，填写管理员密码，点“进入工作台”。
2. 已登录时从侧栏“退出登录”。
3. 没有公开注册或浏览器密码重置入口；初始化和重置只在可信终端。

## Driving it with Harness

本节不需要 Harness；先按 [features/README](README.md) 的 Launch/Doctor 准备独立数据目录和端口。

```sh
export ZHONGSHU_DATA_DIR="$(mktemp -d)/data"
npm run admin -- init
REVISION="$(git rev-parse HEAD)" npm run build
node dist/server/main.js
```

1. 在全新目录启动，确认“管理员尚未完成初始化”；按 CLI 初始化，再重开页面登录。
2. 登录后刷新，只重启本次中书进程并重开页面；确认有效身份保留。
3. 两个独立浏览器上下文分别登录；A 退出后，其私有请求和 SSE 拒绝，B 仍可访问；刷新 A 确认没有复活。
4. 本次隔离 CLI 重置后，两个端的私有请求/流都失效。
5. 有能力控制响应顺序时，延迟旧的 session 查询，再登录/退出并释放旧响应；页面不得退回旧身份。

## Gotchas

- **刷新后仍登录，不等于重新登录成功。** 记录浏览器与数据目录身份，区分“恢复”与“重新认证”。
- **退出只吊销当前会话。** 另一端的会话独立存在；重置密码或恢复备份才吊销全部。
- **重置后旧页面可能看起来还在。** 私有请求和 SSE 必须失效；刷新核对没有复活。
- **初始化/重置只能从可信终端。** 不暴露成公网操作，不把密码放命令参数、仓库或日志。
- **隐藏按钮不是授权。** 服务端必须认证；浏览器隐藏只影响可见性。
- **只做一次顺序登录不能证明竞态分支。** 需要可控的旧响应延迟。

## Implementation and regression

- 认证、会话、限速与密码散列：[auth.ts](../../src/server/auth.ts)
- 初始化、重置、备份与恢复 CLI：[admin.ts](../../src/server/admin.ts)
- 数据库与迁移：[database.ts](../../src/server/database.ts)、[migrations.ts](../../src/server/migrations.ts)
- 回归：[auth.test.ts](../../test/auth.test.ts)、[http.test.ts](../../test/http.test.ts)、[workbench-store.test.ts](../../test/workbench-store.test.ts)
