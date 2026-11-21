# 日落工作室 · SUNSET STUDIO

日落工作室是一款语音驱动的 AI 海报工作台。你提交需求，豆包负责改图，老板 Trump 监督进度和交付范围，客户 CJ 对照需求评审并给出验收意见。实时模式的三位角色分别调用模型，共享当前画布截图和近期讨论，以英语短句交流并显示中文字幕。没有配置模型时，可用离线演示体验工作流并导出海报。

## 本地启动

需要 Node.js **22.18 或更新版本**及 npm。在日落工作室目录执行以下命令。

```sh
npm ci
npm run dev
```

打开 `http://127.0.0.1:8765/`。离线演示可以直接使用。若要配置实时模式，以 `.env.example` 为模板，在本目录创建本地 `.env` 并填写管理员口令和运行密钥。修改启动配置后重启本地服务。

| 本地变量 | 填写内容 |
| --- | --- |
| `STUDIO_ADMIN_KEY` | 自行设置的管理员口令，用来解锁网页上的模型和配音设置 |
| `STUDIO_RUNTIME_SECRET` | 32 字节随机数的 64 位十六进制表示，用来签发管理员会话 |
| `OPENAI_BASE_URL` | 可选的模型接口基址，可在设置页更改 |
| `OPENAI_API_KEY`、`OPENAI_MODEL` | 可选的本地模型凭据和模型名，启动时载入。进入实时模式前仍要通过连接测试 |
| `FISH_API_KEY` | 可选的本地 Fish Audio API Key，也可以用管理员面板配置 |
| `PORT` | 可选的本地监听端口，默认 `8765` |

本地配置保存在服务进程内存中。Windows 和 macOS 已启用的手动系统代理会用于本地出站连接，显式设置的 `HTTPS_PROXY`、`HTTP_PROXY` 优先。可以用 `NO_PROXY` 补充绕过项，回环地址默认绕过。

## 配置实时模型和配音

1. 打开右上角「•••」→「API 设置」，输入管理员口令解锁。填写模型服务地址、模型名和 API Key，选择 OpenAI Responses 或兼容 Chat Completions，再点击「保存并测试」。连接验证通过后可使用实时会议。
2. 需要角色音色时，从同一菜单打开「Fish Audio · voices」，使用同一管理员口令解锁，配置独立的 Fish Audio API Key 和角色音色，再试听确认。配音默认使用 S2.1 Pro。模型设置也提供浏览器朗读和模型服务的语音接口选项。

## 使用工作台

- 点击麦克风开始说话，再点一下结束并提交。短暂停顿会保留已识别文字。识别依赖浏览器的 Web Speech API 和麦克风权限，遇到权限或连接问题时可用「Type a brief」输入中文或英文。
- 实时会议通常依次由豆包设计、老板监督、CJ 评审。CJ 要求修改时会返回豆包，CJ 验收通过时结束该轮。也可以点「请 CJ 验收当前版本」单独发起客户评审。
- 用「暂停讨论」停止当前语音和请求，保留海报与会话。用「继续讨论」恢复剩余话轮。随时提供新要求可以打断当前讨论。豆包优先执行你最新的明确要求。
- 可让角色核查公开事实。展开「联网资料与来源」查看检索关键词、结果和引用，使用「导出会话 · JSON」保存讨论、来源和当前画布。
- 用「Export poster · PNG」随时导出 1080 × 1350 的当前稿。用「我来拍板 · 锁定并导出」结束讨论并冻结当前稿，无需等待 CJ 验收。再次提交明确的修改要求会重新开放设计。
- 「清空画布」会立即停止生成并清空当前画布及旧工作指令。支持撤销，刷新后也会保留清空状态。

试用需求示例

> 做一张 NIGHT SHIFT 滑板音乐节海报，主色用奶油白和荧光绿，文字包括 FRIDAY 8 PM 和 VENICE SKATEPARK。

## 托管构建与配置

本目录的 `.openai/hosting.json` 提供 Worker 绑定模板。构建命令打包 Cloudflare Worker，并内置 `public/` 下的页面、字体、角色图片及演示音频。发布到 Sites 前，注册目标站点并在本机清单中填入其 `project_id`。

```sh
npm run build
```

生成 `dist/server/index.js` 和 `dist/.openai/hosting.json`。托管端通过 `DB` 绑定访问 D1，仓库中的 `drizzle/` 包含 `studio_settings` 的迁移。管理员需在站点的运行环境中配置以下变量。

| 站点变量 | 填写内容 |
| --- | --- |
| `STUDIO_ADMIN_HASH` | 管理员口令的 SHA-256 十六进制摘要，用于校验网页解锁 |
| `STUDIO_RUNTIME_SECRET` | 由 64 个十六进制字符组成的站点运行密钥，用于管理员会话和 D1 配置加密 |

模型和 Fish Audio 的 API Key 通过管理员面板录入，托管端加密保存至 D1。管理员会话有效期为 30 分钟，也可以在菜单中主动锁定。更新原站点时保留原 `project_id`、D1 绑定和原 `STUDIO_RUNTIME_SECRET`，使新版本能够读取已有配置。

画布保存在访客浏览器，当前讨论保存在浏览器会话中。实时模式会把需求、画布截图及近期发言发送到指定的模型服务，配音模式会把台词发送到对应的语音服务，联网检索会发送相应的公开关键词。实际会议会消耗配置方的模型和语音额度。

## 源码结构与验证

| 路径 | 用途 |
| --- | --- |
| `public/` | 页面、Canvas 海报渲染、会议界面及公开素材 |
| `server.mjs` | 本地 Node.js 服务入口 |
| `worker/index.mjs` | 托管 Worker 入口 |
| `server/` | 两端共享的 API、角色编排、模型和配音接入、检索与配置存储 |
| `skills/` | 三个角色的岗位技能与上游来源记录 |
| `drizzle/` | 托管数据库迁移 |
| `scripts/` | 检查、测试和构建脚本 |

三个岗位分别改编自 Anthropic canvas-design、Agency Agents Project Shepherd 和 Reality Checker。固定提交、许可证和上游链接见 `skills/sources.json`，素材来源见 `ASSETS.md`。编辑 `skills/roles/` 下的 `SKILL.md` 后运行 `npm run skills:build` 更新 `public/expertise.json`。

```sh
npm run check
npm test
```

检查涵盖 Node.js 脚本语法。测试涵盖角色权限与验收、共享画布、持续会议和语音重连、联网检索、模型连接及管理员加密配置。

`.env.example`、`.openai/hosting.json` 和依赖锁文件随源码维护。本机 `.env`、安装依赖、`dist/`、`.cache/` 和日志由 Git 忽略。
