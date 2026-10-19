# chivgent 产品介绍素材

整理日期：2026-10-19。共 9 张 PNG，包含真实桌面界面、功能细节和现有品牌素材。

直接打开 [index.html](index.html) 可浏览所有图片，点击图片查看原图。文件路径、尺寸、大小、校验值及网站 alt 文案见 [manifest.json](manifest.json)。

## 优先使用

- **首页主图**：`desktop/02-conversation.png`。同时展示提问、真实文件读取和项目说明。
- **简洁界面**：`desktop/01-workspace.png`。适合介绍工作台结构。
- **功能细节**：`desktop/07-tool-card.png`、`desktop/03-streaming-detail.png`、`desktop/06-session-settings.png`。适合放在功能介绍卡片中。
- **紧凑窗口**：`desktop/05-compact-window.png`。这是窄桌面窗口截图。
- **应用下载/品牌**：`brand/chivgent-app-icon-ivory.png` 与 `brand/chivgent-logo.png`。

## 图片清单

| 文件 | 像素尺寸 | 建议用途 |
| --- | --- | --- |
| [desktop/02-conversation.png](desktop/02-conversation.png) | 2880 × 1654 | 首页主图 / 产品概览 |
| [desktop/01-workspace.png](desktop/01-workspace.png) | 2880 × 1654 | 首页辅助图 / 界面介绍 |
| [desktop/05-compact-window.png](desktop/05-compact-window.png) | 1760 × 1456 | 紧凑桌面布局 / 功能介绍 |
| [desktop/04-tool-details.png](desktop/04-tool-details.png) | 2880 × 1654 | 工作过程 / 可查看的工具结果 |
| [desktop/03-streaming-detail.png](desktop/03-streaming-detail.png) | 2368 × 484 | 流式体验 / 横向功能配图 |
| [desktop/07-tool-card.png](desktop/07-tool-card.png) | 1288 × 594 | 功能卡片 / 局部特写 |
| [desktop/06-session-settings.png](desktop/06-session-settings.png) | 960 × 592 | 模型选择 / 局部特写 |
| [brand/chivgent-app-icon-ivory.png](brand/chivgent-app-icon-ivory.png) | 1024 × 1024 | 下载区域 / 应用介绍 / 品牌装饰 |
| [brand/chivgent-logo.png](brand/chivgent-logo.png) | 146 × 142 | 品牌标识 / 页脚 / 关于产品 |

## 来源与展示范围

桌面图片从 commit `51149f28a6c249a94b363797a688f53532bd962f` 的已构建 Electron 应用直接截取，完整界面保留 Retina 分辨率。`03`、`06`、`07` 为直接截取的界面局部；没有重绘 UI 或加入尚未实现的控件。

截图使用临时示例工程 `chivopic`。对话文本由本地离线响应脚本提供，`read_file` 经真实桌面 IPC、Agent host 与工具执行并读取示例 README；没有调用外部模型。图片用于说明产品工作流。

品牌素材复用仓库现有叶片 logo 和此前选定的象牙白应用图标，来源见 [brand/SOURCE.md](brand/SOURCE.md)。应用图标保留透明外缘；原始叶片 logo 自带浅色底。

## 网站使用

图片可直接复制到网站静态资源目录。完整界面按原比例展示，建议使用 `width: 100%; height: auto`，保留文字清晰度。功能局部图适合与功能文案并排排版。

建议 alt 文案：

- `desktop/02-conversation.png`：chivgent 桌面版展示 chivopic 项目的文件读取过程与结构说明。
- `desktop/01-workspace.png`：chivgent 桌面工作台，显示 chivopic 项目、会话与输入区。
- `desktop/05-compact-window.png`：chivgent 在收起侧栏的窄桌面窗口中展示对话与工具状态。
- `desktop/04-tool-details.png`：chivgent 对话中展开 read_file 的参数和文件读取结果。
- `desktop/03-streaming-detail.png`：chivgent 正在生成回答，对话区显示文件读取活动与流式光标。
- `desktop/07-tool-card.png`：read_file 工具卡片展示读取参数、README 内容和完成状态。
- `desktop/06-session-settings.png`：chivgent 会话设置中的 Provider 选择与模型输入框。
- `brand/chivgent-app-icon-ivory.png`：象牙白圆角底上的 chivgent 叶片应用图标。
- `brand/chivgent-logo.png`：chivgent 原始叶片 logo。
