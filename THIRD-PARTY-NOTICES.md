# 第三方组件与协议 / Third-Party Notices

NekoShelf 本体以 MIT 协议发布（见 [LICENSE](LICENSE)）。运行时镜像与可选集成还包含下列第三方组件，各自遵循自己的协议。

## 运行时镜像

| 组件 | 用途 | 协议 |
| --- | --- | --- |
| Node.js | 运行时 | MIT |
| Fastify 5 / `@fastify/*` | HTTP 服务 | MIT |
| React 19 / Vite 7 / react-router-dom | 前端 | MIT |
| sharp（libvips） | 封面与缩略图 | Apache-2.0 / LGPL-3.0（libvips） |
| ffmpeg（Debian 构建） | 转码与视频封面 | LGPL-2.1+（**该构建启用了 libx264 等 GPL 组件时为 GPL-2.0+**，以所装二进制为准） |
| 7-Zip / p7zip | 7z / zip 解析 | LGPL-2.1+；**RAR 解压受 unRAR 附加限制** |
| libarchive（bsdtar） | RAR5 等归档读取 | BSD-2-Clause |
| tini | 容器 init | MIT |
| SQLite（Node 内置 `node:sqlite`） | 数据库 | Public Domain |

说明：RAR 是专有格式。NekoShelf 只调用系统已有的解压工具读取 RAR，**不随仓库分发 rar.exe / WinRAR**；镜像里 RAR 能力来自 libarchive（BSD）与 7-Zip 的受限 RAR 代码，分发或商业使用时请自行确认 unRAR 限制条款。

## 可选集成（默认关闭）

| 集成 | 说明 |
| --- | --- |
| ExHentai / E-Hentai 元数据 | 请求只发往用户自行登录的里站；使用时需遵守站点服务条款与当地法律 |
| AV 元数据源（JavBus / JavDB / JavLibrary 等） | 同上，由用户自行开启与配置 |
| DeepSeek（或任意 OpenAI 兼容服务） | LLM Key 由用户提供，使用受对应服务条款约束 |
| EhTagTranslation | 标签中文翻译数据，**CC BY-NC-SA 3.0**（非商业、署名、相同方式共享） |

## 测试样本

仓库不包含真实媒体样本或用户数据；测试夹具均为脱敏后的合成数据或解析结果片段。

## 免责声明

本项目仅提供本地媒体文件的索引与浏览工具，不提供、不托管、不传播任何媒体内容。使用者应自行确保所处理内容与使用方式的合法性，并对自己的部署负责。
