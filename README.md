# CosspointX 工作室

两个围绕海报设计与角色协作的项目共用这个仓库。各自有独立的依赖、配置和发布目录。

| 项目 | 体验 | 在线演示 | 开发文档 |
| --- | --- | --- | --- |
| **疯狂的项目经理** | 在漫画工作台主持三位甲方的评审，把意见交给小乙。小乙用工具改海报，项目经理确认后发布新版本。 | [打开工作台](https://crazy-project-manager-manga-1121.xxwdgs.chatgpt.site/) | [项目 README](apps/crazy-project-manager/README.md) |
| **日落工作室** | 用项目简报召集角色讨论。讨论形成可继续编辑和导出图片的海报。 | [打开工作室](https://sunset-studio-public.xxwdgs.chatgpt.site/) | [项目 README](apps/sunset-studio/README.md) |

## 本地运行

安装 Node.js 24 和 npm。从仓库根目录进入想运行的项目，再安装依赖和配置服务。两个项目无需同时启动。

**疯狂的项目经理**

```powershell
cd apps/crazy-project-manager
npm ci
Copy-Item .env.example .env
npm start
```

**日落工作室**

```powershell
cd apps/sunset-studio
npm ci
Copy-Item .env.example .env
npm run dev
```

首次启动前，按项目 README 填写本机 `.env` 中对应服务的变量。已有 `.env` 时直接编辑它。终端会显示本地地址。

## 构建与配置

在项目目录用 `npm run build` 生成该项目的 Worker。各项目的 `.openai/hosting.json` 描述所需的存储绑定。部署时在自己的站点中补齐站点标识、运行变量和密钥。真实 `.env`、本机数据库、依赖目录和构建产物均由 Git 忽略。

主项目的 `dist/assets/` 和 `dist/reservation.html` 是运行所需的静态源码。日落工作室的静态源码在 `public/`。

## 设计资料

- [疯狂的项目经理产品与技术设计](apps/crazy-project-manager/docs/product-design.md)
- [三位甲方的角色与审稿手册](apps/crazy-project-manager/docs/client-agents.md)

这两份资料记录了初期设计。当前启动方式和功能边界以各项目 README 为准。
