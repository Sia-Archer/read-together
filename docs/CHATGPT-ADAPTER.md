# ChatGPT 官方 App 适配层

这一层不建立第二个书架。`web/reader.html` 仍是唯一 Books 阅读界面；ChatGPT MCP UI 在返回资源时复用它，并注入一层宿主桥，把原来的 `/reading/api` 调用换成 component-only 工具调用。

## 边界

- Books Core `18004` 仍是书籍、进度、划线、书签和批注的唯一数据源。
- 既有 Books MCP `18005` 继续只服务 Codex / Gateway，不因官方入口放宽认证。
- ChatGPT UI Adapter 使用独立 loopback 端口 `18006` 和独立 systemd unit。
- 适配器保持 loopback `18006`，由部署者自己的 HTTPS 反向代理公开 `/books-mcp/`；不直接开放 18006 入站端口。
- 公网 MCP 使用独立 OAuth client、secret、access token 与 refresh token，不复用书架登录密码或其他 MCP 的凭据。
- OAuth 授权码必须带 PKCE `S256`，并把 protected-resource 中的精确 `resource` 绑定到授权与换 token；回调只接受 ChatGPT 官方 HTTPS 路径。
- 书籍正文和封面只放在 `books_ui_request` 的 `_meta` 中供组件读取，不写入模型可见的工具正文。
- 在 ChatGPT 组件中产生的划线标记为 `sharedTarget=chatgpt`，不会再唤醒 Codex / Home。
- 官端回写的页边回复仍标记为 `source=chatgpt`，用于保留渠道和路由证据；Books 页面按人物身份统一显示“共读者”，不把渠道渲染成另一个人。

## 组件内流程

1. `open_books` 返回 `ui://guichao-books/reader-v12.html`。
2. 组件加载原有 Books 书架，并通过 app-only 的 `books_ui_request` 读取同一份数据。
3. 读者翻页时仍提交原来的 `/beat` 数据，进度不分叉。
4. 读者划线后先写入 Books，再由 `sendFollowUpMessage` 把划线、限定的小段和 `selection_id` 交给当前 ChatGPT 对话；同段后续划线不重复小段。已有批注下的新回复只带新内容、`selection_id` 与 `comment_id`。

ChatGPT 全屏组件使用独立的宿主适配层：桌面书架与阅读页固定在可见窗口内，阅读正文为横向分页，并为 ChatGPT 输入框预留底部空间。鼠标或触控选字松开后，Books 的“给共读者看 / 写一句”操作条显示在输入框上方。自建 Books 页面继续使用原样式。

组件把 inline 与 fullscreen 当作两种独立布局：聊天中的紧凑书架使用内容自身的 `auto` 高度并主动报告 intrinsic height，关闭的阅读器、目录与批注层不参与尺寸计算；fullscreen 高度受 `100dvh` 和宿主 `maxHeight` 约束。组件监听 `openai:set_globals` 同步显示模式、安全区与可用高度；首次挂载时若宿主尚未注入高度，会短时轮询等待。

官端批注板提供写批注和回复输入框。手机窄屏输入时，板子移到阅读页顶部附近；书签工具栏参考宿主的底部避让值。带 `[Books shared line]` 或 `[Books follow-up]` 的消息要求模型正常聊天回复并调用 `reply_to_shared_line` 写回同一条页边对话。
5. ChatGPT 可调用 `reply_to_shared_line`，回复按原来的逐句协议落回同一条页边对话。
6. ChatGPT 或 Codex 共用七个 Books 工具。`read_book_position` 每次读取约 1600 字，省略进度时继续 AI 自己的位置；`search_read_text` 搜索整本已导入正文；`see_library_overview` 只返回累计统计。这些读取都不修改读者的阅读进度。

## 自托管 HTTPS 部署

1. 复制 `deploy/books-chatgpt.env.example` 到私有配置目录，填写自己的 `BOOKS_CHATGPT_PUBLIC_BASE_URL` 和四项独立 OAuth 随机值；`BOOKS_CHATGPT_CONTROL_TOKEN` 必须与 Core 的 `READING_CHATGPT_CONTROL_TOKEN` 一致，并与另一路 control token 不同。
2. 根据自己的服务用户、Node 路径、工作目录和环境文件修改 `deploy/guichao-books-chatgpt.service` 示例；配置好后启动适配器并确认它只监听 `127.0.0.1:18006`。
3. 把 `deploy/nginx-books-mcp.conf` 的各个 location 放进自己的 HTTPS server，替换密码文件路径，保持带结尾斜杠的 `proxy_pass`。授权地址由书房的 Basic Auth 验证本人，OAuth metadata 与 MCP 端点不能套用这层 Basic Auth；请勿删除保护授权地址的精确匹配 location。
4. 验证 protected-resource metadata、authorization-server metadata、PKCE S256 授权码交换、refresh token 与带 bearer 的 MCP initialize。
5. 在 ChatGPT 网页端的应用管理中添加自定义 MCP 服务器，填写 `https://自己的域名/books-mcp/mcp`，选择 OAuth 并填写本次部署的 client ID 和 secret。授权时，浏览器会先要求输入书房账户和密码。入口与界面以 [OpenAI 官方说明](https://developers.openai.com/api/docs/guides/custom-mcp-server) 为准。

开源仓只提供占位配置，不包含任何部署者的域名、书籍、数据或真实凭据。

当前适配器面向单人自托管：access token 与 refresh token 是部署者配置的固定凭据，不会自动轮换或在一小时后被服务端吊销。泄露时应立即生成替代值、更新私有配置并重启适配器，再重新连接；不要把这套实现当作多用户账号系统。

## 仍需人工账户步骤

- 在 ChatGPT 开发者模式中创建自己的 Books 连接，并填写自托管地址和 OAuth client。
- 用真实官端对话完成打开书架、划线和页边回写验收。

源码、loopback 服务、HTTPS/OAuth 和 ChatGPT 连接是四层独立状态；任何一层测试通过都不能代替官端真机验收。


## 双渠道隔离

Books Core 根据服务端凭证确定身份。Home/Codex 使用 `READING_MCP_CONTROL_TOKEN`；ChatGPT 使用单独的 `READING_CHATGPT_CONTROL_TOKEN`，适配器的 `BOOKS_CHATGPT_CONTROL_TOKEN` 与之匹配。两值相同时拒绝控制请求；ChatGPT 未配置凭证时不会借用 Home 凭证。客户端传入的 `source` 不能改变归属。

书籍、读者的阅读位置、书签和读者创建的批注在两边共享。AI 阅读位置分别存为 `ai_codex`、`ai_chatgpt`。共读者主动写的批注只在对应入口显示；共享批注下的回复按 `source` 分别显示和写回，未标记渠道的旧回复沿用批注原入口。GPT 划线由组件发往当前 GPT 对话，Home 的消息队列只接受 Home 渠道。官端组件继续使用原书架和阅读器，不提供导入或书房管理。

历史 `readers.ai` 保留，不自动复制给任何一边。可确认由读者创建的历史批注在两边显示，原记录不改写；无法确认归属的共读者批注和回复保留在磁盘，不推断到另一入口。

GPT 使用同一个 `web/reader.html`；记录页复用 `web/stats.html`，在组件内显示并返回原书架。窄面板与全屏按容器尺寸布局，关闭抽屉不可见。键盘、安全区与发送回调的设备表现须在真实 ChatGPT 宿主中验收，本机模拟宿主不能替代。
