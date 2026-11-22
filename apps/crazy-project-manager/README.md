# 疯狂的项目经理

一个有剧情的海报工作台。你负责项目简报、评审和交付，小乙用可编辑图层做海报，周总、林尺和阿唐看到发布稿后轮流提意见。界面默认使用英文，会议模式默认开启。语言、声音和项目工作流都在「设置」里调整。

## 本机启动

安装 Node.js 24 或更新版本。以下命令在本 README 所在的主站目录运行。

~~~powershell
npm ci
npm start
~~~

打开 [本机首页](http://127.0.0.1:4173/)。Windows 也可以双击 `打开预览.cmd`。脚本会安装缺少的依赖、构建界面并打开浏览器。`npm start` 同样会先构建 React 页面。

进入「设置 → API 设置」，配置可处理图片输入的 Agent。完成配音配置后，角色可以用各自的音色发言。新手可从首页的「体验示例」进入，或自行填写项目主题和简报。

修改前端时，保留 4173 端口的 Node 服务，在另一终端执行 `npm run dev:ui`，再打开 Vite 输出的开发地址。Vite 会把 API、语音 WebSocket 和静态素材请求转给本机 Node。工作台和麦克风可以在 `localhost` 或 HTTPS 环境使用，录音需要浏览器授权。

## 一局怎么进行

1. **生成并发布首稿。** 小乙从简报开始画竖版 A3 海报（297 × 420 毫米）。首稿生成后可预览、继续改或替换主视觉。在工作台点击「发布首稿」后，草稿才成为 `V01`，三位甲方随后开始评审。
2. **组织评审。** 甲方按角色查看本轮发布稿的实际 PNG，逐次接续发言。每张角色卡保留按版本和轮次分组的意见，底边满意度条可打开评分依据。会议台词按完整短句排队配音。
3. **继续改稿。** 默认会议先收齐意见，再自动交给小乙，改完可自动发布后续版本。在设置中开启「审批」后，可以逐条退回意见、写反馈或恢复，再把剩余意见一次发给小乙。小乙交出的草稿可再修改，确认后生成正式版本。手动文字派工也可用于直接修改当前稿。关闭会议模式可以逐条引用和转交需求。
4. **用声音指导小乙。** 按住「说话」录音，松手后提交转写。录音会暂停当前播报，经理的指导会进入小乙的工作队列。也可以直接输入文字。拍桌提供即时受击动画、音效和催稿，当前服务端工单继续执行。
5. **检查稿件并交付。** 中栏可以缩放、全屏和对比版本，也可从版本记录恢复旧稿作为草稿。选定正式版本后可定稿并导出 SVG 或 PNG。回放能定位到关键版本、评审和拍桌，也能另存为含已记录海报、音频和事件的单文件 HTML。

## 在线服务与环境变量

本机可以在首页更新服务设置，也可以在还没有 `.env` 时从模板创建。

~~~powershell
Copy-Item .env.example .env
~~~

本机常规入口从项目根目录 `.env` 读取配置，网页保存也写入该文件。API 设置只接受从本机回环地址访问。密钥输入留空会保留已配置值，前端只展示密钥状态。真实凭据随运行环境保存，公共版本库保留 `.env.example`。

| 能力 | 环境变量 | 行为 |
| --- | --- | --- |
| Agent | `STUDIO_AGENT_MODE`、`OPENCODE_GO_API_KEY` 或 `STUDIO_MODEL_URL`、`STUDIO_MODEL`、`STUDIO_MODEL_KEY` | `opencode-go` 使用内置预设 `hy4-flash-free`，`api` 使用自定义 Chat Completions 接口。小乙需要支持图片输入的模型。`local` 用于停用在线 Agent。 |
| 看图评审 | `STUDIO_VISION_MODE`、`STUDIO_VISION_URL`、`STUDIO_VISION_MODEL`、`STUDIO_VISION_KEY` | 默认 `inherit`，沿用 Agent 连接。选 `api` 可为甲方配置独立的多模态接口。 |
| 角色配音 | `STUDIO_TTS_MODE`、`FISH_TTS_API_KEY`、`OPENROUTER_API_KEY`、`VOLCENGINE_API_KEY` | 可选 `fish`、`openrouter` 或 `volcengine`。各提供方支持为 `ZHOU`、`LIN`、`TANG`、`YI` 配置独立音色，例如 `FISH_VOICE_YI`。正式台词通过配置的 TTS 合成，成功的音频可被缓存和复用。 |
| 麦克风识别 | `STUDIO_ASR_MODE`、`FISH_ASR_API_KEY`、`VOLCENGINE_ASR_API_KEY` | 支持 `browser` 浏览器识别、`fish` 实时识别，以及 `volcengine`、`volcengine-flash` 下的实时识别和兼容录音文件接口。 |
| 豆包一句话识别 | `STUDIO_ASR_MODE=volcengine-sentence`、`VOLCENGINE_SENTENCE_ASR_API_KEY`、`VOLCENGINE_SENTENCE_ASR_RESOURCE_ID` | 通过 WebSocket 录音，松手后返回整句。资源可选 `volc.seedasr.sauc.duration` 或 `volc.seedasr.sauc.concurrent`。未单独配置密钥时沿用火山 ASR 密钥。 |
| 生成及编辑位图 | `STUDIO_IMAGE_MODE=amd`、`AMD_CREATIVE_HUB_API_KEY` | AMD Creative Hub 的 `Qwen-Image-2.1-Turbo` 支持文生图和参考图编辑。小乙可选 `1:1`、`4:3`、`3:4`、`16:9`、`9:16`，生成结果进入素材库。 |
| 本机服务 | `HOST`、`PORT`、`STUDIO_DATA_DIR`、`STUDIO_PUBLIC_URL` | 默认监听 `127.0.0.1:4173`，数据保存在 `.studio-data/`。工作台为新项目生成预约码时使用配置的公开地址。 |

角色评审每轮优先用一句短话表达一个重点，中文目标为 30 字以内、英文为 18 词以内；完整需求仍由工单保存。小乙每单最多播报一次开工进度，完成后用一句短话交稿。四位角色的配音基础播放速度为 1.3 倍，保留各自的语气节奏。

Agent 服务不可用时，生成和评审会显示失败并允许重试。配音可从角色卡重试，浏览器阻止自动播放时可以手动启用声音。设置中的音量项分别控制台词、音效和音乐。

扫码预约使用站内 `/reservation` 页面。若要从手机访问本机新建项目里的预约码，将 `HOST` 设为 `0.0.0.0`，把 `STUDIO_PUBLIC_URL` 设为手机可访问的局域网地址，重启后新建项目。使用火山标准版录音文件识别时，临时录音地址需要允许提供方通过公网 HTTPS 读取。

## 小乙的海报工具

小乙使用 Pi agent-core 驱动工具链，每回合可收到当前海报 PNG。工具的参数、调用 ID 和结果会通过「设置 → 工具调用审计」保留，便于区分模型请求、实际运行的工具和失败后的修复。

| 工具 | 用途 |
| --- | --- |
| `run_canvas` | 批量执行 `resize`、`text`、`draw`、`paint`、`palette`、`arrange`。支持文字、SVG 路径、渐变、分组、图层顺序、矢量遮罩和混合模式。可修改竖版 A4、A3、A2 或自定义尺寸。 |
| `inspect_poster` / `preview_draft` | 查看可编辑图层、素材列表和当前 PNG，检查改图结果。 |
| `place_material` | 以素材 ID 放置或替换位图图层，可设置 `contain`、`cover`、`fill`、透明度与混合模式。 |
| `generate_image` | 在开启 AMD 图像服务时创建位图或编辑参考图，再将产物作为会话素材放入海报。 |
| `submit_draft` | 交付改稿并提交用于在线配音的简短说明。 |

素材库接受本机图片和允许浏览器跨域读取的图片链接。上传主视觉用于替换当前海报主图，加入素材库的图片可独立作为图层使用。

可以用同一套绘图指令在本机生成一张示例 SVG。将以下内容保存为 `drawing.json`。

~~~json
{
  "commands": [
    { "op": "resize", "preset": "A3" },
    {
      "op": "palette",
      "decorations": "none",
      "gradient": {
        "type": "linear",
        "stops": [
          { "offset": 0, "color": "#182648" },
          { "offset": 1, "color": "#635da2" }
        ]
      }
    }
  ]
}
~~~

~~~powershell
npm run canvas -- drawing.json poster.svg
~~~

输入 `-` 可以从标准输入读指令，省略 `poster.svg` 则将 SVG 写到标准输出。

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `frontend/` | React 首页和工作台的两个 Vite 入口，工作台组件、语音调度、设置和回放在 `frontend/src/`。 |
| `server.mjs`、`server/`、`shared/` | 本机 HTTP 服务与两种运行时共用的会话、Agent、绘图、语音和设置逻辑。Node 将状态写入 SQLite，将海报和媒体保存为本地文件。 |
| `worker/`、`drizzle/` | Sites Worker 路由、D1/R2 持久化和 SQL 迁移。Worker 用 WASM 渲染海报 PNG。 |
| `dist/assets/`、`dist/reservation.html` | 随源码版本化的角色立绘、音效、字体以及预约页。 |
| `scripts/` | Worker 构建、本地 Worker 启动、海报命令和冒烟测试。 |

浏览器通过会话 API 提交操作并通过 SSE 接收项目快照、事件和流式台词。Node 与 Worker 都使用同一份会话与改图逻辑。录音工作线程、回放播放器和回放样式额外以独立 URL 提供，离线回放导出时会内联播放器。

## Sites Worker 与发布

~~~powershell
npm run start:worker
~~~

该命令自动构建 Worker、启动 Miniflare 并应用 `drizzle/` 中的迁移。默认地址为 [本机 Worker](http://127.0.0.1:8787/)。通过 `STUDIO_WORKER_PORT` 和 `STUDIO_WORKER_DATA_DIR` 覆盖端口和数据目录。本机 Worker 默认使用 `.studio-worker-data/`，它与 Node 的 SQLite 数据各自独立。

生成 Sites 发布产物时执行 `npm run build:worker`。构建先把 React 写到 `dist/client/`，再生成 `dist/server/index.js`、同目录的 `resvg_bg.wasm` 和 `dist/.openai/hosting.json`。Worker 以 `nodejs_compat` 运行，所需页面和素材随产物内置。仓库里的 `.openai/hosting.json` 提供绑定模板。发布到 Sites 前，注册目标站点并在本机清单中填入其 `project_id`。

- `DB` 是 D1 绑定，保存项目、事件、版本元数据和共享设置。发布目标需要应用 `drizzle/` 的 SQL 迁移。
- `BUCKET` 是 R2 绑定，保存海报、上传素材、语音和缓存。
- Sites 的 Agent、语音及图像服务配置全站共享。通过托管环境提供服务凭据。启用网页编辑共享配置时，需要设置 `STUDIO_SETTINGS_ADMIN_KEY` 以及由 64 个十六进制字符组成的 `STUDIO_SETTINGS_SECRET`，后者用于 AES-GCM 加密 D1 中的覆盖设置。默认配置可从 Worker 环境变量读取。
- 发布 Worker 会使用目标站点的身份和存储。本机的 SQLite、Miniflare 数据、历史项目和真实密钥由各自环境保管。GitHub 中的源码更新与 Sites 发布是两个独立操作。

## 维护命令与版本库内容

| 命令 | 用途 |
| --- | --- |
| `npm run build:ui` | 只构建 React 首页和工作台。 |
| `npm run build:worker` | 生成完整 Sites Worker 发布产物。`npm run build` 等价。 |
| `npm test` | 运行 Node 测试，覆盖会话、评审、海报、设置及语音。 |
| `npm run test:worker` | 构建后在隔离的本地 Worker 环境冒烟测试页面、会话、静态资源与媒体。 |
| `node --test server/designer-agent.integration.test.mjs` | 通过受控模型应答检查实际工具执行、PNG 渲染、失败修复和交稿。 |

纳入版本库的 `dist/assets/` 和预约页属于运行源码，与可重建的 `dist/client/`、`dist/server/`、`dist/.openai/` 分开维护。回放仍会读取老版本的三张角色图，测试也会读取少量历史声音资源。保留 `.env.example`、锁文件、SQL 迁移、Sites 源配置和海报字体资源。实际 `.env`、本机数据目录、安装依赖、日志、临时截图和发布压缩包由运行环境保管。

早期的产品目标和评审角色设计见[产品与技术设计](docs/product-design.md)和[甲方角色手册](docs/client-agents.md)。
