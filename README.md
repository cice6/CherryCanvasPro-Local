# Cherry Canvas Pro Local

Cherry Canvas Pro Local 是一个可在本机运行的 AI 画布系统，包含图片、文本、视频、音频、素材节点、文件夹素材工作流、API 设置，以及即梦 / Dreamina CLI 本地运行时集成。

## 运行要求

- Windows 10/11 或 macOS 12+
- Node.js 20 或更新版本
- 第一次安装依赖、安装或授权即梦 CLI 时需要网络
- macOS 用户如果要处理视频封面或提升网页播放兼容性，建议安装 FFmpeg：

```bash
brew install ffmpeg
```

## 快速启动

### Windows

双击 `START.bat`。

它会自动执行：

1. 如果没有 `node_modules`，先安装依赖。
2. 构建前端页面。
3. 启动本地前端和本地运行时后端。
4. 打开浏览器访问本地画布。

启动地址：

```text
http://127.0.0.1:5174/
```

### macOS

推荐方式：

1. 下载或解压项目。
2. 双击 `START.command`。
3. 如果系统提示没有执行权限，在终端进入项目目录后运行：

```bash
chmod +x START.command START.sh
./START.command
```

也可以直接用终端启动：

```bash
./START.sh
```

启动地址：

```text
http://127.0.0.1:5174/
```

### 命令行通用启动

Windows、macOS、Linux 都可以使用：

```bash
npm install
npm run build
npm start
```

前端地址：

```text
http://127.0.0.1:5174/
```

本地运行时地址：

```text
http://127.0.0.1:8777/
```

## 文件夹素材工作流

可以把电脑里的文件夹直接拖进画布。

第一步会生成一个“文件夹”节点，用来查看文件夹里的素材清单和数量。

点击“展开为素材工作流”后，会按文件名自然排序生成真实素材节点：

- 图片：生成“素材图”节点
- 视频：生成“素材视频”节点
- 音频：生成“素材音频”节点
- txt、md、json、csv、srt 等文本：生成“文本素材”节点

后续生成时请引用展开后的真实素材节点，而不是引用文件夹本身。`@` 面板里也会优先引用这些素材节点。

## 即梦 / Dreamina

系统集成官方即梦 CLI。进入应用后打开设置，使用即梦网页登录或授权流程即可。

生成的视频、图片和本地缓存会写入：

```text
dreamina-output/
```

这个目录不会放进压缩包，因为里面可能包含本机用户上传的图片、生成的视频和登录后的缓存结果。

## 包含内容

- `src/`：前端源码
- `server/`：本地运行时后端
- `scripts/`：开发和启动脚本
- `dist/`：已构建的前端产物
- `package.json` 和 `package-lock.json`
- `START.bat`：Windows 一键启动脚本
- `START.command`：macOS 双击启动脚本
- `START.sh`：macOS / Linux 终端启动脚本

## 注意

- API Key 保存在每个用户自己的浏览器本地存储中，不会包含在压缩包里。
- 压缩包不包含 `node_modules`，第一次启动会自动安装依赖。
- 压缩包不包含 `dreamina-output`，避免带上本机生成结果和用户素材。
- 开发调试用 `npm run dev`。
- 普通本地使用用 `npm start`、`START.bat` 或 `START.command`。
