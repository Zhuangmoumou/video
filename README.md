# Video Console

Node.js 视频解析、下载与 FFmpeg 处理服务。

## 启动

```bash
pnpm install
pnpm start
```

默认监听 `9898`，可通过 `PORT` 环境变量覆盖。运行配置位于 `config.json`。

## 检查

```bash
pnpm run check
pnpm test
```

## 目录

```text
app.js                 精简启动入口
src/createApp.js       Express 应用装配
src/routes/            登录、控制台、前端任务 API、旧客户端 API
src/taskManager.js     单任务锁、取消、资源释放和任务结束等待
src/taskService.js     下载任务与队列流程
src/mediaResolver.js   插件和浏览器媒体解析
src/download/          MP4、M3U8 下载
src/videoProcessor.js  FFmpeg 压缩、裁剪和拼接
mod/                   站点解析插件，仍由根目录动态加载
pages/                 HTML 页面
public/                浏览器脚本和样式
test/                  Node.js 测试
```

前端使用 `/api/task/*`；旧客户端和简单 API 对接继续使用 `POST /`。两套协议保持独立，底层共用任务执行服务。
