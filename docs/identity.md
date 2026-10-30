# 私人入口与数据操作

当前只有一个管理员，没有公开注册、默认密码或浏览器重置密码接口。公开的健康与版本接口不包含身份或业务状态；私人接口统一在服务端认证，浏览器隐藏按钮不构成授权。

## 初始化与恢复身份

本地设置 `ZHONGSHU_DATA_DIR` 后运行 `npm run admin -- init`，在终端两次输入密码，输入不回显。未设置目录时使用当前系统用户的 `~/.local/share/zhongshu`。初始化遇到已有管理员会拒绝；重置使用 `npm run admin -- reset` 并吊销全部登录会话。两者需要运行账号对私有数据目录的访问权，不能暴露成公网操作。

生产产物对应命令为 `node dist/server/admin.js init` 或 `reset`。密码管理器可通过标准输入配合 `--password-stdin` 提供秘密；不把密码放命令参数、仓库或日志。密码要求及限速参数以 [auth.ts](../src/server/auth.ts) 为准。

登录成功轮换当前浏览器会话，其他端的会话独立存在。退出只吊销当前会话；重置密码或从备份恢复会吊销全部会话。正常重启保存尚未到期的会话，绝对有效期为 7 天。服务端保存随机 token 的 SHA-256 摘要，浏览器使用 HttpOnly、Secure、SameSite=Strict Cookie，不使用 localStorage 保存认证秘密。

## 运行边界

`ZHONGSHU_ORIGIN` 必须匹配浏览器访问的完整 HTTPS origin，服务端以它检查写请求来源，并为已认证写请求验证会话关联的 CSRF token。应用不信任客户端转发的地址头；未配置受信代理前，反向代理后的登录尝试共享该代理地址的限速桶。

本机开发只有显式设置 `ZHONGSHU_ALLOW_HTTP_LOOPBACK=true`，且 origin 与监听地址都为 loopback 时才允许 HTTP。开发 Cookie 使用独立名称；这个例外不用于公网实例。Vite 开发启动器已配置同源代理，生产由 Node 直接提供构建后的静态资源。

数据目录是身份与私有内容的信任边界：目录 0700，数据库及备份 0600，运行账号必须拥有它们。宿主管理员和应用进程可以访问数据库；将来的 Harness 执行身份不能获得该目录，工作区不能作为认证数据目录。TLS 由部署入口终止，部署实例配置留在源码之外。

## 备份、恢复与迁移

`npm run admin -- backup /absolute/private/backup.sqlite` 使用 SQLite 在线备份 API，验证备份后保留，不覆盖已有文件。不要直接复制仍在运行的 WAL 数据库文件。备份包含密码摘要与私有状态，按身份数据保护和保留；无自动上传或自动清除策略。

`npm run admin -- restore /absolute/private/backup.sqlite --data-dir /absolute/new/data` 仅恢复到尚不存在数据库的新目录。先在私有暂存库中吊销旧会话并验证，再原子发布，管理员必须重新登录。恢复后重新指向新目录启动应用；旧数据目录在确认恢复有效前保留。

迁移有序执行，记录 SQL 摘要；不允许改写已应用迁移、跳号或用旧程序打开更新的 schema。失败回滚并拒绝启动私人服务。恢复程序版本不等于回退数据库，版本切换前使用匹配的备份与恢复路径。[database.ts](../src/server/database.ts) 负责这些机制。

## 安全取舍与验证入口

网络输入、Cookie、数据库文件和未来原生消息均是不可信入口。输入经有界校验；SQL 参数化；密码使用 Node 原生异步 scrypt 与随机盐，散列并发受限；登录限速持久化，重启不清零。审计只记录动作类别和时间，不记录密码、token、用户正文或原生完整响应。

框架插件、前端与校验库使用 npm 官方发行包并固定版本，安装禁用生命周期脚本；版本事实以依赖锁为准，升级要复跑对应行为。SQLite 驱动取舍见 [ADR 0003](adr/0003-local-persistence.md)。身份/数据库验证入口是 [auth 测试](../test/auth.test.ts) 和 [HTTP 边界测试](../test/http.test.ts)，实际浏览器与容器证据归 PR。Android 真机和生产 TLS 链路需在可用环境另行验收。
