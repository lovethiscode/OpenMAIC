# OpenMAIC 内网生成与离线 HTML 导出方案

## 目标

FinFit 保持现有客户端通信方式：客户端仍然通过 WebSocket 与 FinFit 服务器通信。OpenMAIC 部署在内网，作为 AI 课程生成引擎，仅由 FinFit 服务器通过内网 HTTP 调用。

OpenMAIC 生成完成后，将课程导出为可直接播放的离线 HTML 目录，再压缩成 ZIP 包并上传到 OSS。OpenMAIC 上传成功后把最终 ZIP URL 写入生成任务结果，FinFit 后台通过轮询拿到 ZIP URL 后再通过 WebSocket 发给客户端。OpenMAIC 本地生成文件仅作为临时工作区，上传成功后自动清理。

## 总体架构

```text
客户端
  ⇅ WebSocket
FinFit 服务器
  ⇅ 内网 HTTP
OpenMAIC 服务
  ⇅ LLM / TTS / 图片 / 视频供应商
```

OpenMAIC 对公网不可见。客户端不直接访问 OpenMAIC，也不需要知道 OpenMAIC 的课堂 URL 或 jobId。

## 本地部署脚本方案

第一步先在本地 Mac 上部署并跑通 OpenMAIC，让 FinFit 本地服务可以连接本地 OpenMAIC API。部署不走 Docker，使用 Python 脚本自动准备运行环境、拉取代码、固定稳定 tag、安装依赖并启动服务。

### 目录结构

建议保持以下结构：

```text
/Users/ai/code/ai/open-maic/
├── docs/
│   └── OFFLINE_EXPORT_PLAN.md
├── deploy_openmaic.py
├── .runtime/
│   ├── node/
│   ├── corepack/
│   ├── pnpm-store/
│   ├── openmaic.pid
│   └── openmaic.log
└── OpenMAIC/
```

说明：

- `docs/`：保存方案与实施文档。
- `deploy_openmaic.py`：部署与启动脚本。
- `.runtime/`：脚本自动准备的本地运行时，不污染系统全局环境。
- `OpenMAIC/`：从 `THU-MAIC/OpenMAIC` 拉取的源码。

### 代码来源与版本

使用官方仓库：

```text
https://github.com/THU-MAIC/OpenMAIC.git
```

固定到稳定 tag：

```text
v0.2.2
```

部署脚本需要执行：

```bash
git clone https://github.com/THU-MAIC/OpenMAIC.git OpenMAIC
cd OpenMAIC
git fetch --tags
git checkout v0.2.2
```

脚本应具备幂等能力：

- 如果 `OpenMAIC/` 不存在，则 clone。
- 如果 `OpenMAIC/` 已存在，则检查是否为正确 git 仓库。
- 如果已有本地修改，不能自动覆盖，应提示用户处理。
- 每次安装前都执行 `git fetch --tags`，确认 `v0.2.2` 可用。
- 最终确保工作区位于 `v0.2.2`。

### 自动准备 Node.js

OpenMAIC `v0.2.2` 要求：

```text
node >= 20.9.0
```

部署脚本应先检查系统 Node：

```bash
node -v
```

如果不存在，或版本低于 `20.9.0`，脚本不要求用户手动安装，而是自动下载 Node.js 到：

```text
/Users/ai/code/ai/open-maic/.runtime/node/
```

推荐使用稳定 LTS，例如 Node 22。脚本应根据 Mac 架构自动选择下载包：

```text
darwin-arm64  # Apple Silicon
darwin-x64    # Intel Mac
```

运行 OpenMAIC 时，脚本应优先使用 `.runtime/node/bin`：

```text
PATH=/Users/ai/code/ai/open-maic/.runtime/node/bin:$PATH
```

这样不会污染系统全局 Node 环境。

### 自动准备 pnpm

OpenMAIC `v0.2.2` 的 `packageManager` 固定为：

```text
pnpm@10.28.0
```

部署脚本不依赖系统全局 `pnpm`。应使用 Node 自带的 Corepack 准备 pnpm：

```bash
corepack enable
corepack prepare pnpm@10.28.0 --activate
```

并使用本地 Corepack 与 pnpm store：

```text
COREPACK_HOME=/Users/ai/code/ai/open-maic/.runtime/corepack
PNPM_STORE_PATH=/Users/ai/code/ai/open-maic/.runtime/pnpm-store
```

安装依赖时执行：

```bash
pnpm install --frozen-lockfile
```

### 环境变量配置

部署脚本应在 `OpenMAIC/` 下检查 `.env.local`：

```bash
cp .env.example .env.local
```

只在 `.env.local` 不存在时复制。脚本不应写入 API key，也不应要求用户在命令行输入 key。

用户需要自行编辑：

```text
OpenMAIC/.env.local
```

至少配置一个核心 LLM provider，例如：

```env
OPENAI_API_KEY=...
DEFAULT_MODEL=openai:gpt-4o-mini
```

或：

```env
GOOGLE_API_KEY=...
DEFAULT_MODEL=google:gemini-3-flash-preview
```

或：

```env
ANTHROPIC_API_KEY=...
DEFAULT_MODEL=anthropic:claude-3-5-haiku-20241022
```

如果只是给 FinFit 通过本地或内网调用，不建议设置：

```env
ACCESS_CODE=
```

即保持 `ACCESS_CODE` 为空或不配置，避免 FinFit 后端调用 API 时还需要浏览器 Cookie 登录流程。

可选能力按需配置：

- Web Search：`TAVILY_API_KEY` 等。
- 图片生成：`IMAGE_OPENAI_API_KEY`、`IMAGE_SEEDREAM_API_KEY`、`IMAGE_QWEN_IMAGE_API_KEY` 等。
- 视频生成：`VIDEO_SEEDANCE_API_KEY`、`VIDEO_KLING_API_KEY`、`VIDEO_VEO_API_KEY` 等。
- TTS：`TTS_OPENAI_API_KEY`、`TTS_AZURE_API_KEY`、`TTS_GLM_API_KEY`、`TTS_QWEN_API_KEY` 等。

### 阿里云百炼 / DashScope 配置

OpenMAIC 支持阿里云百炼 / DashScope 相关能力，但环境变量名称不是通用的 `DASHSCOPE_API_KEY`。

如果 FinFit 已经有：

```env
DASHSCOPE_API_KEY=...
```

可以复用同一个 key，但需要复制到 OpenMAIC 识别的变量名：

```env
QWEN_API_KEY=...
TTS_QWEN_API_KEY=...
IMAGE_QWEN_IMAGE_API_KEY=...
VIDEO_HAPPYHORSE_API_KEY=...
```

推荐模板已放在：

```text
/Users/ai/code/ai/open-maic/.env.example
```

用途：

- `QWEN_API_KEY`：大语言模型，默认 base URL 为 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
- `TTS_QWEN_API_KEY`：Qwen TTS，默认 base URL 为 `https://dashscope.aliyuncs.com/api/v1`。
- `IMAGE_QWEN_IMAGE_API_KEY`：Qwen Image，默认 base URL 为 `https://dashscope.aliyuncs.com`。
- `VIDEO_HAPPYHORSE_API_KEY`：HappyHorse 视频适配器，默认 base URL 为 `https://dashscope.aliyuncs.com`。

注意：OpenMAIC 当前服务端 provider 映射读取的是 `QWEN_*`、`TTS_QWEN_*`、`IMAGE_QWEN_IMAGE_*`、`VIDEO_HAPPYHORSE_*` 这些前缀。仅在 OpenMAIC `.env.local` 中写 `DASHSCOPE_API_KEY` 不会自动启用 Qwen LLM 或 Qwen TTS。

### 启动模式

本地第一阶段推荐开发模式：

```bash
pnpm dev
```

默认地址：

```text
http://localhost:3000
```

稳定后可切换为更接近生产的本地模式：

```bash
pnpm build
pnpm start
```

部署脚本应支持后台运行，并记录：

```text
.runtime/openmaic.pid
.runtime/openmaic.log
```

建议命令：

```bash
python3 deploy_openmaic.py install
python3 deploy_openmaic.py start
python3 deploy_openmaic.py stop
python3 deploy_openmaic.py status
python3 deploy_openmaic.py health
```

### 健康检查

启动后检查：

```bash
curl -fsS http://localhost:3000/api/health
```

正常返回应包含：

```json
{
  "success": true,
  "status": "ok",
  "capabilities": {
    "webSearch": false,
    "imageGeneration": false,
    "videoGeneration": false,
    "tts": false
  }
}
```

`capabilities` 是否为 `true` 取决于 `.env.local` 中是否配置了对应 provider。

### FinFit 本地连接地址

如果 FinFit 也在本机直接运行，调用：

```text
http://localhost:3000
```

如果 FinFit 运行在 Docker 容器里，通常应调用：

```text
http://host.docker.internal:3000
```

核心 API：

```text
POST http://localhost:3000/api/generate-classroom
GET  http://localhost:3000/api/generate-classroom/{jobId}
GET  http://localhost:3000/api/classroom?id={classroomId}
```

### 远程 Ubuntu 部署

本地部署跑通后，可以使用同一个 `deploy_openmaic.py` 将 OpenMAIC 部署到远程 Ubuntu 服务器。部署脚本会通过 SSH 连接远程服务器，然后在远程执行部署命令。

远程配置文件：

```text
/Users/ai/code/ai/open-maic/deploy.toml
```

配置结构参考 FinFit server 的 `deploy.toml`：

```toml
[server]
host = "your-server-ip"
port = 22
username = "root"
key_path = ""
password = ""

[deploy]
remote_app_dir = "/usr/local/openmaic"
service_name = "openmaic"
port = 3000
hostname = "0.0.0.0"
repo_url = "https://github.com/THU-MAIC/OpenMAIC.git"
tag = "v0.2.2"
node_version = "22.12.0"
pnpm_version = "10.28.0"
local_env_path = "/Users/ai/code/ai/open-maic/.env.product"
remote_env_path = "/usr/local/openmaic/OpenMAIC/.env.local"
```

远程部署命令：

```bash
python3 /Users/ai/code/ai/open-maic/deploy_openmaic.py remote-deploy --config /Users/ai/code/ai/open-maic/deploy.toml --upload-env
```

说明：

- `--upload-env` 会把本地 env 文件上传到远程服务器。
- 生产部署约定本地文件名为 `/Users/ai/code/ai/open-maic/.env.product`。
- 上传到远程后必须复制/改名为 `/usr/local/openmaic/OpenMAIC/.env.local`，因为 OpenMAIC / Next.js 实际读取的是项目根目录下的 `.env.local`。
- 脚本应优先使用 `deploy.toml` 的 `local_env_path`。为空时才依次尝试 `OpenMAIC/.env.local`、`.env`、`.env.example`。
- 远程服务器不走 Docker。
- 远程服务器会自动安装基础 apt 包：`git`、`curl`、`ca-certificates`、`xz-utils`、`build-essential`、`python3`。
- 远程 Node.js 会安装到 `/usr/local/openmaic/.runtime/node`，不会依赖系统 Node。
- 远程 pnpm 使用 `corepack pnpm@10.28.0`。
- 远程源码位于 `/usr/local/openmaic/OpenMAIC`，并固定 checkout 到 `v0.2.2`。
- 远程服务通过 systemd 管理，服务名默认 `openmaic`。
- 远程健康检查地址为 `http://127.0.0.1:3000/api/health`。

远程常用命令：

```bash
systemctl status openmaic --no-pager
journalctl -u openmaic -f
tail -f /usr/local/openmaic/.runtime/openmaic.log
systemctl restart openmaic
```

## 当前 OpenMAIC 服务端存储

后台生成 API 当前使用服务器本地文件系统：

```text
data/
├── classroom-jobs/
│   └── {jobId}.json
└── classrooms/
    ├── {classroomId}.json
    └── {classroomId}/
        ├── audio/
        │   └── *.mp3
        └── media/
            ├── *.png
            └── *.mp4
```

关键代码：

- `lib/server/classroom-storage.ts`：课堂 JSON 与 job 目录定义。
- `lib/server/classroom-job-store.ts`：job 状态读写。
- `lib/server/classroom-media-generation.ts`：服务端图片、视频、TTS 生成与落盘。
- `app/api/classroom-media/[classroomId]/[...path]/route.ts`：本地媒体文件读取与流式返回。

Docker 部署时，`docker-compose.yml` 已将 `/app/data` 挂载为 volume：

```yaml
volumes:
  - openmaic-data:/app/data
```

该存储可以作为临时工作区使用。离线 HTML ZIP 包上传到 OSS 且校验成功后，可删除对应课堂与 job 文件。

## FinFit 与 OpenMAIC 调用流程

### 1. 客户端发起生成

客户端通过 WebSocket 请求 FinFit：

```json
{
  "type": "course.generate",
  "payload": {
    "requirement": "生成一节适合初中生的营养与运动课程",
    "enableImageGeneration": true,
    "enableVideoGeneration": false,
    "enableTTS": true,
    "agentMode": "generate"
  }
}
```

### 2. FinFit 提交 OpenMAIC 生成任务

```http
POST http://openmaic.internal:3000/api/generate-classroom
Content-Type: application/json
```

请求体：

```json
{
  "requirement": "生成一节适合初中生的营养与运动课程",
  "enableImageGeneration": true,
  "enableVideoGeneration": false,
  "enableTTS": true,
  "agentMode": "generate"
}
```

OpenMAIC 返回：

```json
{
  "success": true,
  "jobId": "abc123",
  "status": "queued",
  "step": "queued",
  "pollUrl": "http://openmaic.internal:3000/api/generate-classroom/abc123",
  "pollIntervalMs": 5000
}
```

FinFit 保存映射关系：

```text
finfitCourseJobId -> openmaicJobId
userId
websocketSessionId
status
```

### 3. FinFit 轮询 OpenMAIC 进度

```http
GET http://openmaic.internal:3000/api/generate-classroom/{jobId}
```

OpenMAIC 返回字段：

```json
{
  "status": "running",
  "step": "generating_scenes",
  "progress": 52,
  "message": "Generating scene 3/6",
  "scenesGenerated": 2,
  "totalScenes": 6,
  "done": false
}
```

FinFit 将进度转换为 WebSocket 消息推给客户端：

```json
{
  "type": "course.progress",
  "payload": {
    "status": "running",
    "step": "generating_scenes",
    "progress": 52,
    "message": "Generating scene 3/6",
    "scenesGenerated": 2,
    "totalScenes": 6
  }
}
```

### 4. OpenMAIC 生成完成

最终轮询返回：

```json
{
  "status": "succeeded",
  "done": true,
  "result": {
    "classroomId": "Uyh82Y32ZK",
    "url": "http://openmaic.internal:3000/classroom/Uyh82Y32ZK",
    "scenesCount": 6
  }
}
```

FinFit 不应直接把 OpenMAIC 内网 URL 暴露给客户端。OpenMAIC 应在生成完成后自动执行离线导出、ZIP 打包和 OSS 上传，最终任务结果中返回 OSS ZIP URL。

### 5. OpenMAIC 导出并上传 OSS

OpenMAIC 生成课堂成功后，后台继续执行：

```text
生成课堂
  -> 导出离线 HTML 静态目录
  -> 压缩为 {classroomId}-offline.zip
  -> 上传 ZIP 到 OSS
  -> 校验 OSS ZIP 对象存在
  -> 更新 job.result.zipUrl
  -> 清理本地课堂临时文件
```

最终轮询返回：

```json
{
  "status": "succeeded",
  "done": true,
  "result": {
    "classroomId": "Uyh82Y32ZK",
    "scenesCount": 6,
    "zipUrl": "https://cdn.example.com/openmaic/courses/Uyh82Y32ZK/Uyh82Y32ZK-offline.zip",
    "artifactKey": "openmaic/courses/Uyh82Y32ZK/Uyh82Y32ZK-offline.zip"
  }
}
```

FinFit 收到 `zipUrl` 后通过 WebSocket 发给客户端：

```json
{
  "type": "course.ready",
  "payload": {
    "courseId": "finfit-course-id",
    "zipUrl": "https://cdn.example.com/openmaic/courses/Uyh82Y32ZK/Uyh82Y32ZK-offline.zip"
  }
}
```

这样 OpenMAIC 不需要额外暴露公网导出 API，FinFit 也不需要从 OpenMAIC 下载 ZIP 后再上传保存。

## 需要新增的 OpenMAIC 能力

### 1. OSS 上传能力

新增 OpenMAIC 服务端 OSS 配置：

```env
ALIYUN_OSS_ACCESS_KEY_ID=...
ALIYUN_OSS_ACCESS_KEY_SECRET=...
ALIYUN_OSS_BUCKET=finfit-ai-ketang-sig
ALIYUN_OSS_ENDPOINT=oss-ap-southeast-1.aliyuncs.com
ALIYUN_OSS_REGION=ap-southeast-1
AI_COURSE_OSS_PREFIX=ai_courses
AI_COURSE_OSS_PUBLIC_BASE_URL=https://finfit-ai-ketang-sig.oss-ap-southeast-1.aliyuncs.com
AI_COURSE_OSS_UPLOAD_RETRY_COUNT=3
AI_COURSE_OSS_UPLOAD_RETRY_DELAY_SECONDS=1
OPENMAIC_UPLOAD_COURSE_ZIP_TO_OSS=true
OPENMAIC_DELETE_LOCAL_AFTER_OSS_UPLOAD=true
```

字段命名刻意保持和 FinFit server 一致，上传实现也参考 FinFit 的 `CourseStorageService`：

- 使用 `alibabacloud_oss_v2`。
- 通过 `PutObjectRequest` 上传整个 ZIP。
- 使用 `AI_COURSE_OSS_PREFIX/{courseId}/course_{courseId}_v{version}.zip` 生成 object key。
- 支持失败重试。
- 如果使用 internal endpoint，必须配置 `AI_COURSE_OSS_PUBLIC_BASE_URL`，避免把内网 OSS 地址返回给客户端。

这些配置已经复制到本地：

```text
/Users/ai/code/ai/open-maic/OpenMAIC/.env.local
```

同时也写入：

```text
/Users/ai/code/ai/open-maic/OpenMAIC/.env.example
```

`OpenMAIC` 当前主要使用 Next.js 的环境变量加载机制，本地 `pnpm dev` 和生产 `pnpm start` 都会读取项目根目录下的 `.env.local`。它不像 FinFit server 那样天然维护 `.env` / `.env_production` 两套文件。生产环境区分主要由部署脚本决定：本地维护 `/Users/ai/code/ai/open-maic/.env.product`，远程部署时使用 `deploy_openmaic.py --upload-env` 上传，并在服务器上改名/落地为 `OpenMAIC/.env.local`。

上传目标是单个 ZIP 包：

```text
openmaic/courses/{classroomId}/{classroomId}-offline.zip
```

ZIP 解压后的目录结构仍然是可直接播放的 HTML 静态目录：

```text
{classroomId}-offline/
├── index.html
├── offline-player.js
├── offline-player.css
└── assets/
    ├── audio/
    ├── media/
    └── avatars/
```

返回给 FinFit 的 URL 应指向 ZIP 文件：

```text
{OSS_PUBLIC_BASE_URL}/{OSS_COURSE_PREFIX}/{classroomId}/{classroomId}-offline.zip
```

内联课程 JSON 中所有资源引用必须改为相对路径：

```json
{
  "audioSrc": "assets/audio/tts_s0_action_1.mp3",
  "src": "assets/media/gen_img_1.png"
}
```

不能保留以下依赖：

```text
/api/classroom-media/...
http://openmaic.internal/...
IndexedDB
/api/chat
/api/quiz-grade
/api/pbl/chat
```

OSS / CDN 需要正确设置 Content-Type：

```text
.zip  -> application/zip
.html -> text/html; charset=utf-8
.js   -> application/javascript; charset=utf-8
.css  -> text/css; charset=utf-8
.mp3  -> audio/mpeg
.wav  -> audio/wav
.mp4  -> video/mp4
.png  -> image/png
.jpg  -> image/jpeg
```

### 2. 离线导出执行器

不再优先新增面向 FinFit 的下载接口，而是在生成任务完成后由 OpenMAIC 内部调用离线导出执行器：

```text
exportOfflineClassroom(classroomId)
  -> build/reuse offline-player
  -> rewrite assets
  -> render index.html
  -> validate no online refs
  -> return localOutputDir
```

该执行器可以先复用当前本地脚本 `export_offline_classroom.py` 的逻辑，后续迁移为 TypeScript 服务端模块，方便直接接入 `/api/generate-classroom` 后台任务。

### 3. 复用 OpenMAIC 渲染层的离线播放器

不建议从零手写一个“看起来差不多”的简化播放器。这样容易导致离线 HTML 与 OpenMAIC 在线课堂在文本换行、字号、元素定位、shape、video 层级、spotlight 效果等方面出现明显差异。

推荐方案是复用 OpenMAIC 的 slide 渲染层，新增一个离线运行时：

```text
OpenMAIC 原 slide-renderer
  + Offline Adapter
  + Offline Playback Controller
  + 资源路径重写
  + 静态 HTML 导出
```

离线播放器可以使用 React 运行时并被打包进 `offline-player.js`，但不能依赖 Next.js 服务、IndexedDB、OpenMAIC `/api/*`、媒体生成任务或在线状态。

优先复用的 OpenMAIC 组件：

```text
components/stage/scene-renderer.tsx
components/slide-renderer/Editor/ScreenCanvas.tsx
components/slide-renderer/Editor/ScreenElement.tsx
components/slide-renderer/components/element/TextElement/BaseTextElement.tsx
components/slide-renderer/components/element/ImageElement/BaseImageElement.tsx
components/slide-renderer/components/element/ShapeElement/BaseShapeElement.tsx
components/slide-renderer/components/element/LineElement/BaseLineElement.tsx
components/slide-renderer/components/element/TableElement/BaseTableElement.tsx
components/slide-renderer/components/element/ChartElement/BaseChartElement.tsx
components/slide-renderer/components/element/VideoElement/BaseVideoElement.tsx
components/slide-renderer/Editor/HighlightOverlay.tsx
components/slide-renderer/Editor/SpotlightOverlay.tsx
components/slide-renderer/Editor/LaserOverlay.tsx
```

不建议直接复用或只应裁剪复用：

```text
components/edit/PlaybackChromeRoot.tsx
lib/store/stage.ts
lib/store/media-generation.ts
lib/server/*
app/api/*
```

这些模块和在线生成、编辑模式、服务端 API、后台任务、Zustand store、IndexedDB 等绑定较深，离线包中应由更小的 adapter 替代。

建议新增离线播放器源码目录：

```text
OpenMAIC/offline-player/
├── main.tsx
├── OfflineApp.tsx
├── OfflineSceneProvider.tsx
├── OfflineCanvasStore.ts
├── OfflineMediaAdapter.ts
├── OfflinePlaybackController.ts
└── rewrite-assets.ts
```

Offline Adapter 负责提供 OpenMAIC 渲染组件需要的最小运行环境：

```text
OfflineSceneProvider
  - 当前 scene
  - 当前 slide content
  - 提供 useSceneSelector 等价能力

OfflineCanvasStore
  - canvasScale
  - spotlightElementId
  - laserElementId
  - playingVideoElementId
  - playVideo(elementId)
  - pauseVideo()

OfflineMediaAdapter
  - 不查询媒体生成任务
  - 图片、视频、音频 src 均来自 assets 相对路径
  - placeholder 不再触发重新生成

OfflineSettingsStore
  - imageGenerationEnabled = false
  - videoGenerationEnabled = false
  - webSearchEnabled = false

OfflineI18n
  - 返回固定中文文案或使用内置字典
```

离线播放器需要支持：

- 幻灯片基础元素渲染。
- speech action 播放本地音频。
- play_video action 播放本地视频。
- 白板绘图动作。
- interactive scene 通过 iframe 或内联 HTML 渲染。
- 基础播放、暂停、上一页、下一页。

`speech`、`play_video`、`spotlight` 等课堂动作由 `OfflinePlaybackController` 顺序执行：

```text
speech
  - 显示字幕
  - 播放 assets/audio/*.wav 或 *.mp3
  - 等音频 ended 后继续

play_video
  - 根据 elementId 找到 video element
  - 设置 playingVideoElementId
  - 播放对应本地视频
  - 等 video ended 后继续，或允许用户手动继续

spotlight / highlight / laser
  - 更新 OfflineCanvasStore 中的效果状态
  - 继续复用 OpenMAIC overlay 组件渲染

discussion
  - 离线模式显示讨论题或提示
  - 不调用 AI
  - 可等待用户点击继续，或停顿数秒后继续
```

离线模式应降级或禁用：

- AI 实时讨论。
- PBL 在线聊天。
- 主观题 AI 判分。
- 重新生成图片、视频、TTS。
- Web search。
- ASR 语音识别。

为了支持双击 `index.html` 直接播放，课程 JSON 推荐内联到 HTML：

```html
<script id="openmaic-course-data" type="application/json">
  {...}
</script>
```

不要让离线播放器通过 `fetch('course.json')` 读取课程数据，因为部分浏览器在 `file://` 场景下会拦截本地 fetch。音频、图片、视频可以继续使用相对路径：

```text
assets/audio/...
assets/media/...
```

`offline-player.js` 与 `offline-player.css` 可以作为独立文件放在导出目录中，也可以在最终版本内联进 `index.html`。若目标是手机 WebView 或普通桌面浏览器双击播放，建议保留外部 JS/CSS 文件并保证路径为相对路径。

### 4. 上传成功后的本地清理

不需要优先暴露清理 API。OpenMAIC 应在 OSS 上传成功且校验通过后，自动清理：

```text
data/classrooms/{classroomId}.json
data/classrooms/{classroomId}/
data/classroom-jobs/{jobId}.json
exports/{classroomId}-offline/
```

为了避免生成结果丢失，清理必须满足：

- OSS ZIP 对象上传成功。
- 对 OSS ZIP 对象执行 HEAD 校验，确认 size / ETag 等元数据存在。
- job 结果已经写入 `zipUrl`。
- 如果上传失败，不清理本地课堂文件，方便重试和排查。

可以保留一个内部维护命令或管理接口用于手动清理失败任务，但不作为 FinFit 正常链路的一部分。

## 资源重写规则

### 音频

后台生成 TTS 时，speech action 当前会包含：

```json
{
  "audioId": "tts_s0_action_1",
  "audioUrl": "http://openmaic.internal:3000/api/classroom-media/xxx/audio/tts_s0_action_1.mp3"
}
```

离线导出时应复制音频文件到：

```text
assets/audio/tts_s0_action_1.mp3
```

并重写为：

```json
{
  "audioId": "tts_s0_action_1",
  "audioSrc": "assets/audio/tts_s0_action_1.mp3"
}
```

导出后的播放器优先使用 `audioSrc`，不能再请求 `audioUrl`。

### 图片与视频

场景中的图片/视频元素当前可能引用：

```text
/api/classroom-media/{classroomId}/media/xxx.png
/api/classroom-media/{classroomId}/media/xxx.mp4
```

离线导出时应复制到：

```text
assets/media/xxx.png
assets/media/xxx.mp4
```

并重写元素的 `src` 为相对路径。

### 交互 HTML

复用现有 `inlineHtmlAssets()` 逻辑，将 interactive scene 里的外部 CSS、JS、图片、字体等资源尽量内联成 `data:` URI。

如果有无法内联的外部资源，导出执行器应在 job 状态中记录 warning，必要时阻止上传，避免误以为已完全离线。

## 方案 B 实施步骤

开发离线播放器和导出流程时，不应执行任何课堂清理或删除操作。尤其不要删除：

```text
OpenMAIC/data/classrooms/{classroomId}.json
OpenMAIC/data/classrooms/{classroomId}/
OpenMAIC/data/classroom-jobs/{jobId}.json
```

这些文件是离线导出和效果比对的数据源。自动清理应等导出流程稳定、OSS 上传校验成功后再接入业务链路。

### 1. 建立离线播放器构建入口

在 OpenMAIC 项目内新增独立入口：

```text
OpenMAIC/offline-player/main.tsx
OpenMAIC/offline-player/OfflineApp.tsx
OpenMAIC/offline-player/rollup.config.mjs
```

当前实现使用项目已有的 Rollup 构建离线播放器 bundle，避免额外引入 Vite 依赖：

```bash
pnpm build:offline-player
```

输出：

```text
OpenMAIC/dist-offline/offline-player.js
OpenMAIC/dist-offline/offline-player.css
```

`package.json` 中新增脚本：

```json
{
  "scripts": {
    "build:offline-player": "rollup -c offline-player/rollup.config.mjs && mkdir -p dist-offline && cp offline-player/offline-player.css dist-offline/offline-player.css"
  }
}
```

### 2. 接入 OpenMAIC slide 渲染组件

第一阶段只接入 slide 渲染，不实现完整自动播放。

目标是让离线播放器能够读取内联 course data，并显示当前 scene：

```text
OfflineApp
  -> OfflineSceneProvider
  -> SceneRenderer 或 ScreenCanvas
  -> ScreenElement
  -> BaseTextElement / BaseShapeElement / BaseImageElement / BaseVideoElement
```

若原组件直接依赖在线 store，应先通过 adapter 提供同名或等价能力。不要为了快速跑通而大幅改动原始组件，否则后续 OpenMAIC 升级时难以同步。

### 3. 裁剪媒体生成相关依赖

图片和视频元素中原来可能存在：

```text
media generation task
placeholder
retryMediaTask
useSettingsStore
useMediaGenerationStore
```

离线模式下不重新生成媒体。导出时已经把最终资源复制到 `assets/`，播放器只需要渲染本地 `src`。

因此应新增离线媒体解析逻辑：

```text
if element.src is local assets path:
  render normally
else if element.src is placeholder:
  render static placeholder
else:
  render empty or warning state
```

### 4. 实现 Offline Playback Controller

实现动作队列控制器，按 scene 顺序执行 actions：

```text
load scene
render slide
for action in scene.actions:
  run action
move next scene
```

最低可用能力：

- `speech`：播放本地音频，显示字幕。
- `play_video`：播放当前 slide 中对应 video element。
- `spotlight`：设置高亮状态。
- `discussion`：离线展示，不调用 AI。
- `pause/resume`：暂停当前 audio/video 与动作队列。
- `prev/next`：切换 scene。

浏览器有自动播放限制，第一次播放必须由用户点击播放按钮触发。之后同一个用户手势链路内可以顺序播放音频和视频。

### 5. 实现导出脚本

先实现本地脚本：

```text
/Users/ai/code/ai/open-maic/export_offline_classroom.py
```

脚本职责：

1. 读取 `OpenMAIC/data/classrooms/{classroomId}.json`。
2. 创建 `exports/{classroomId}-offline/`。
3. 复制 `audio/`、`media/` 到 `assets/`。
4. 深度遍历并重写 JSON 中的资源 URL。
5. 调用或检查 `pnpm build:offline-player` 输出。
6. 生成 `index.html`，内联课程 JSON。
7. 复制 `offline-player.js`、`offline-player.css`。
8. 生成 `{classroomId}-offline.zip`。

后续再把同样逻辑迁移为 OpenMAIC 内部导出模块，并接入生成任务完成回调。FinFit 不需要直接调用导出下载 API；它只需要继续轮询生成 job，等待 `zipUrl`。

### 6. 加入导出校验

导出脚本完成后应自动检查：

```text
index.html 中不包含 http://localhost
index.html 中不包含 /api/classroom
index.html 中不包含 /api/classroom-media
课程 JSON 中所有 assets/audio 文件存在
课程 JSON 中所有 assets/media 文件存在
导出目录可以整体移动后保持相对路径可用
```

### 7. 视觉一致性验证

为减少离线播放效果和 OpenMAIC 在线课堂的差异，后续可以增加 Playwright 截图比对：

```text
在线课堂:  http://localhost:3000/classroom/{classroomId}
离线课堂:  file:///.../exports/{classroomId}-offline/index.html
```

逐个 scene 截图，重点比较：

- canvas 比例和居中位置。
- 文本字号、换行、字体。
- shape、line、table、chart。
- video 的位置、尺寸、旋转和层级。
- spotlight、laser、highlight。
- 背景色和主题。

截图比对不是第一阶段必须项，但应该作为最终质量验收手段。

## 开发完成后的导出方法

开发完成后，用户可以自行执行导出，不需要 Codex 实际导出或测试。

以课堂 `G4kNV3OKWI` 为例：

```bash
cd /Users/ai/code/ai/open-maic
python3 export_offline_classroom.py G4kNV3OKWI
```

默认输出：

```text
/Users/ai/code/ai/open-maic/exports/G4kNV3OKWI-offline/
/Users/ai/code/ai/open-maic/exports/G4kNV3OKWI-offline.zip
```

如果脚本支持指定输出目录，可以使用：

```bash
python3 export_offline_classroom.py G4kNV3OKWI --output /Users/ai/Desktop/G4kNV3OKWI-offline
```

导出后双击：

```text
/Users/ai/code/ai/open-maic/exports/G4kNV3OKWI-offline/index.html
```

或复制整个目录到任意位置后双击 `index.html`。注意必须复制整个目录，不能只复制单独的 `index.html`，因为音频、图片、视频资源位于 `assets/` 下。

如果后续实现 OSS 上传链路，生成任务完成后不需要手动从 OpenMAIC 下载 ZIP。FinFit 轮询 OpenMAIC job，最终读取：

```json
{
  "result": {
    "zipUrl": "https://cdn.example.com/openmaic/courses/G4kNV3OKWI/G4kNV3OKWI-offline.zip"
  }
}
```

本地开发阶段仍然可以保留 Python 脚本导出，用于人工比对和离线播放器调试。

## 安全与部署建议

OpenMAIC 不暴露公网，仅允许 FinFit 服务器访问。

推荐至少做一层内网限制：

- Docker/Kubernetes 网络隔离。
- 反向代理 IP allowlist。
- 仅监听内网地址。
- 可选内部 Header，例如 `X-Internal-Token`。

如果完全处于可信内网，可以不启用面向用户的 `ACCESS_CODE`。但不要把 OpenMAIC 端口直接暴露到公网。

## 推荐实施顺序

1. 编写 `deploy_openmaic.py`，完成本地 runtime 准备、clone `THU-MAIC/OpenMAIC`、checkout `v0.2.2`、安装依赖、启动和健康检查。
2. 保持现有 `/api/generate-classroom` 与轮询接口不变，先完成 FinFit 到本地 OpenMAIC 的调用。
3. 在 FinFit 中实现 job 映射和“轮询 OpenMAIC -> WebSocket 推送客户端”的桥接。
4. 新增 OpenMAIC 内部离线导出执行器，先支持 slide、speech、image、video、quiz。
5. 新增 OpenMAIC OSS 上传模块，上传 `{classroomId}-offline.zip` 并返回 `zipUrl`。
6. 将“生成课堂 -> 导出 HTML -> 打包 ZIP -> 上传 OSS -> 写入 job.result.zipUrl -> 清理本地文件”接入后台生成任务。
7. FinFit 轮询 OpenMAIC job，拿到 `zipUrl` 后通过 WebSocket 推给客户端。
8. 扩展离线播放器，继续补齐白板动作、interactive scene、PBL 降级展示。

## 最终结论

该方案可行。OpenMAIC 作为内网 AI 课程生成引擎，FinFit 作为业务网关和 WebSocket 入口，是清晰且低耦合的拆分。

OpenMAIC 本地文件系统只承担临时生成与导出工作区。离线 HTML 目录生成并压缩成 ZIP 后由 OpenMAIC 上传到 OSS，FinFit 只接收最终 ZIP URL 并推送给客户端。OSS 上传校验成功后，OpenMAIC 自动清理本地临时数据。
