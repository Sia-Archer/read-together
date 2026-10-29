# 部署书房

Books Core、网页、MCP 与 ChatGPT 适配层是不同组件。先在自己的机器上运行 Core，并用 HTTPS 和访问控制保护网页；需要 AI 或 ChatGPT 时再配置对应的 MCP 服务。

## 准备

- Node.js 20.19 或更高版本、pnpm、Nginx、HTTPS 域名和有效证书。
- 一个只供自己使用的持久数据目录。书籍、进度和批注都放在这里，不要加入 Git。
- 本文的 Nginx 示例使用 HTTP Basic Auth；只在 HTTPS 下使用，并为书房设置独立的强密码。

## 启动 Books Core

```bash
cd /opt/books
pnpm install --frozen-lockfile
READING_DATA_DIR=/var/lib/books READING_PUSH_WEBHOOK= READING_PUSH_ENABLED=0 npm start
```

目录需提前创建，并确保运行服务的用户能读写。Core 默认只监听本机 `127.0.0.1:18004`。本命令用于前台验证，不要将 Core 端口直接开放到公网。

长期运行可以从 [read-together-core.service](../deploy/read-together-core.service) 开始：先创建专用服务用户和私有数据目录，将 `deploy/books.env.example` 复制为 `/etc/books/core.env`，核对 `READING_DATA_DIR`，并设置两条不同的 Core control token。检查并按实际情况修改 service 中的用户、Node 路径、工作目录、环境文件及可写数据目录，然后交给 systemd 启动。MCP 和 ChatGPT 适配器的各自 control token 要与 Core 中对应的值一致。服务文件是示例，目标 Linux 环境仍需实际验证。

默认没有配置 webhook；也不要把 `READING_PUSH_WEBHOOK` 或 `READING_PUSH_ENABLED=1` 带入验证环境，以免产生真实消息。

## 保护网页与 API

1. 用 `htpasswd` 等工具创建密码文件，例如 `/etc/books/htpasswd`，并限制其读取权限。密码不放进源码。
2. 在已配置好证书的 HTTPS `server` 块中包含 [nginx-standalone.conf](../deploy/nginx-standalone.conf)。将文件中的 `/opt/books/web/` 和密码文件路径改为实际绝对路径；如果 Core 端口不是 18004，也同时调整代理地址。确保 Nginx 的 `http` 配置已包含 `mime.types`，以正确提供脚本和样式。
3. 执行 `nginx -t`，确认配置通过后按自己的服务管理方式重载 Nginx。访问 `https://你的域名/reading/`，输入书房账户密码。

静态页面与 `/reading/api/` 都由 Nginx 先认证；只有验证成功的 API 请求才会被 Nginx 注入 Core 信任的本机标记。不要让外部客户端直接访问 Core，也不要在未认证的 location 中注入该标记。随机路径不能代替认证。

本机隔离验证覆盖了页面、静态资源与书库 API 的未认证拒绝，以及认证后的页面、API 访问和示例 TXT 导入；实际公网 HTTPS、部署者的 Nginx 配置和目标设备仍须自行验证。

## 网页消息接入

网页里的划线和批注会存进书房；把分享或回复主动送进 AI 对话，还需要部署者提供接收消息的服务，配置 `READING_PUSH_WEBHOOK`，按需设置 `READING_PUSH_WEBHOOK_SECRET`。接收端接收 `POST` JSON，字段包括 `source`、`replyTarget`、`sourceMessageId`、`text`、`createdAt` 和 `waitForCompletion`；配置密钥时通过 `Authorization: Bearer …` 验证。接收端需要去重并把消息交给自己的 AI 客户端。HTTP 2xx 仅表示消息桥已接收，不代表 AI 已回复。没有配置消息桥时不会唤醒 AI；消息和回复的发送状态也不能当作实际送达。默认的 Cyberboss 队列只适用于已有对应系统的环境。ChatGPT 组件内的分享走当前 ChatGPT 对话，是另一条路径。

## AI 与 ChatGPT

Books MCP 使用 `deploy/books-mcp.env.example` 中的独立 access token 与 control token，启动命令为 `npm run mcp:start`。Core 的 `READING_MCP_CONTROL_TOKEN` 必须与 MCP 的 `BOOKS_MCP_CONTROL_TOKEN` 一致。实际凭据必须单独生成并保存在私有配置中。

ChatGPT 入口使用另一个 Core control token，且其 OAuth 凭据应与 Books MCP 的凭据不同。部署示例中的授权入口需用书房密码认证，不能只保护书架页面。`deploy/guichao-books-*.service` 是示例，默认示例为 `/opt/books`、`books` 服务用户和 `/usr/bin/node`，请按实际服务用户、Node 路径、工作目录和环境文件修改；示例尚需在目标 Linux 环境验证。配置和接入边界见 [CHATGPT-ADAPTER.md](CHATGPT-ADAPTER.md)。只在确认 HTTPS、认证与数据备份之后连接真实账户。

## 备份

`READING_DATA_DIR` 保存书籍和私人阅读记录，需另外做私密、加密的备份并验证恢复。公开仓库只保存代码、示例配置和文档。
