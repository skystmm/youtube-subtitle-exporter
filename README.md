# YouTube 字幕导出器

一个零账号的 Chrome/Edge Manifest V3 插件。它会读取当前 YouTube 视频已有的字幕轨道，并将所选字幕保存为 UTF-8 TXT 文件。没有字幕时，本机助手会用 `yt-dlp` 快速下载音频，再交给本地 Whisper 识别口播，不需要把视频完整播放一遍。

对于 YouTube 返回空字幕正文的受限视频，插件会自动打开并读取 YouTube 原生文字稿面板，不需要外部服务。

## 安装

1. 克隆仓库后，在项目目录运行 `npm install && npm run build`，生成浏览器运行所需的 `vendor/` 文件。
2. 打开 `chrome://extensions`（Edge 使用 `edge://extensions`）。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本项目目录 `youtube-subtitle-exporter`。

修改或升级插件后，请在扩展管理页点击插件的“重新加载”，并刷新已打开的 YouTube 页面。

### 启动本机助手

转写前双击项目中的 `start-helper.command`，并保持打开的终端窗口运行。助手只监听本机 `127.0.0.1:43127`。

在 Apple Silicon Mac 上首次使用“高准确率转写”前，先双击 `setup-accurate.command`。它会在项目内建立隔离的 Python 环境并安装 Apple MLX Whisper；首次转写还会从 Hugging Face 下载约 3 GB 的完整 `large-v3` 模型，之后会使用本机缓存。

若电脑尚未安装 `yt-dlp` 和 FFmpeg，可以运行：

```sh
python3 -m pip install yt-dlp
brew install ffmpeg
```

## 使用

1. 打开一个 YouTube 视频页面。
2. 点击页面右下角的“导出字幕 TXT”。
3. 有字幕时点击“一键导出字幕 TXT”；插件会优先选择浏览器语言对应的人工字幕，其次选择音轨语言和英文字幕。需要时可展开选择其他字幕轨道。
4. Whisper 转写区始终保留：没有字幕或希望重新识别时，选择口播语言，再选择“高准确率转写（推荐）”。它使用 MLX 优化的完整 Whisper large-v3；“较快转写（浏览器 Base）”保留为低配置备用。两种方式都无需播放完整视频。
5. 插件显示音频下载和 Whisper 识别进度，完成后自动下载 TXT。

高准确率模式关闭跨窗口历史文本条件，避免长视频出现整段重复，并自动读取视频的公开标题与简介，辅助人名、地名等专有词识别。对于简介 `#标签` 中明确给出的中文专名，还会校正同音识别错误，但不会任意改写普通正文。浏览器 Base 模式仍会在首次使用时下载百余 MB 的模型，并在 Base 下载失败时退回 Tiny。插件会在导出前清理异常重复片段，但不会在解码阶段封禁正常中文重复词组。音频不会上传；转写速度和准确率仍取决于电脑性能与音质。若 `yt-dlp` 无法下载某个视频，可使用“备用：播放录制模式”。

## 隐私与权限

- 只在 `youtube.com` 页面注入界面。
- 不需要登录插件账号，也不向第三方服务器上传字幕或浏览记录。
- 本地 Whisper 只从 `huggingface.co` 下载模型文件；视频音频始终留在本机。
- 本机助手只接受 YouTube HTTPS 视频地址，下载的临时 WAV 会在任务结束后清理。
- `tabCapture` 权限仅供用户主动选择的备用播放录制模式使用。
- 不申请 `downloads` 权限；文件由页面内生成的临时 Blob 下载。

## 开发验证

```sh
npm install
npm test
```

`npm test` 会同时运行单元测试并重新生成 `offscreen.js` 与本地 ONNX Runtime 文件。`vendor/` 是构建产物，不提交到 Git；安装扩展前必须执行一次 `npm run build` 并保留生成的目录。
