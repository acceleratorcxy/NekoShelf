# API 契约（前后端与独立客户端共同遵守）

机器可读版本见 [`docs/openapi.json`](./openapi.json)（OpenAPI 3.1），运行期可通过 `GET /api/openapi.json` 直接取。本文件是人读摘要，两者不一致时以 `openapi.json` 为准并同步修正本文。

全局约定：

- 前缀 `/api`，JSON 请求/响应，UTF-8；时间一律 ISO 8601 UTC 字符串（`2026-11-15T12:00:00.000Z`）。
- 路径不含版本号；主版本通过 `X-API-Version: 1` 协商，响应恒回带 `X-API-Version`。请求头主版本不符返回 `400 unsupported_api_version`（详见 [](./adr/0003-client-api.md)）。
- 鉴权（两种等价方式，Cookie 优先）：
  - `Cookie: sid=...`：登录/初始化后下发的 HttpOnly 会话 Cookie，适用于同源 Web。
  - `Authorization: Bearer nks_<prefix>_<secret>`：API Token，适用于独立客户端与脚本，可单独吊销并按 `read` / `write` / `admin` 授权。
  - 公开路由：`/healthz`、`/api/setup/status`、`/api/setup`、`/api/auth/login`、`/api/auth/logout`、`/api/meta`、`/api/openapi.json`。
- 错误统一为 `{"error":{"code":"...","message":"..."}}`；客户端以 `code` 分支，`message` 仅供兜底展示。错误码表见文末。
- 分页：`page` 从 1 开始，`pageSize` 默认 48、上限 200；列表响应回显 `{items, total, page, pageSize}`。
- 排序：`/api/works` 的 `sort=recent|title|rating`，默认 `recent`（更新时间倒序）。
- 客户端必须忽略未知字段、对未知枚举值降级显示（同主版本内只做向后兼容演进）。

## 版本与能力发现

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/meta` | 公开。`{name:"NekoShelf", version, apiVersion:"1", features:{archives,video,dualLanguage,scraper,tokens}, limits:{pageSizeMax:200, uploadMaxMB:null}}`，`cache-control: public, max-age=300` |
| GET | `/api/openapi.json` | 公开。返回本仓库 `docs/openapi.json` 原文，`cache-control: public, max-age=600` |

`version` 取 `apps/server/package.json`（容器构建可用 `APP_VERSION` 覆盖）；`apiVersion` 是 API 主版本。`features.dualLanguage` 为 `false`（双语标题切换规划中）；`features.scraper` 取决于 `ENABLE_SCRAPER`；`limits.uploadMaxMB = null` 表示本版本无上传接口。

客户端推荐启动顺序：`GET /api/meta` → 校验 `apiVersion` → 无凭据则登录或粘贴 Token → 后续请求带 `X-API-Version: 1`。

## 跨域（CORS）

- 默认**不启用**（同源 Web 不需要）。设置环境变量 `CORS_ORIGINS`（逗号分隔的精确 Origin，例如 `http://localhost:5173,capacitor://localhost,tauri://localhost`）后启用 `@fastify/cors`。
- 允许 `credentials`；预检 `OPTIONS` 直接 204，`Access-Control-Max-Age: 600`；允许请求头 `Authorization`、`X-API-Version`、`Content-Type`、`If-None-Match`；暴露 `X-API-Version`、`Content-Range`、`Accept-Ranges`、`ETag`、`Cache-Control`。
- 未在白名单的 Origin 不会收到 `Access-Control-Allow-Origin`（浏览器侧即拒绝）。原生 HTTP 栈（OkHttp / URLSession / Rust reqwest）不受 CORS 限制，但仍需 Bearer Token。

## 健康与初始化

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | `{ok:true, version, uptimeSec, db:"ok"}`，不需要鉴权 |
| GET | `/api/setup/status` | `{initialized:boolean}`，公开 |
| POST | `/api/setup` | body `{username,password}`；201 `{user}`，并直接登录；已初始化 409 `conflict` |
| POST | `/api/auth/login` | body `{username,password}`；200 `{user}`；失败 401 `bad_credentials` |
| POST | `/api/auth/logout` | 204（清 Cookie，公开幂等） |
| GET | `/api/auth/me` | 200 `{user}` |

`User = {id, username, role:"admin"|"member"|"guest", createdAt}`

## API Token（仅管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/tokens` | body `{name (1–64 字), scopes?: ("read"\|"write"\|"admin")[]}`；201 `{id,name,prefix,scopes,createdAt,token}`，**`token` 明文只返回这一次** |
| GET | `/api/auth/tokens` | `{tokens:[{id,name,prefix,scopes,createdAt,lastUsedAt}]}`，不含明文，按 id 倒序，仅未吊销 |
| DELETE | `/api/auth/tokens/:id` | 204 软吊销（置 `revoked_at`）；不存在或已吊销 404 |

- `scopes` 省略时为 `["read"]`。`write` 隐含读权限；`admin` 隐含全部（含 Token 管理）。
- Token 形态 `nks_<8 位 hex 前缀>_<64 位 hex 密钥>`；服务端只存 `sha256` 哈希，`prefix` 用于辨认。
- 用 Token 调 API 时刷新 `last_used_at`。`/api/auth/tokens*` 要求 `role=admin`，且若用 Bearer 调用还需要该 Token 含 `admin` 作用域（防提权）。
- 权限不足 403 `forbidden`；Token 不存在/已吊销/格式错误 401 `unauthorized`。

## 媒体库与任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/libraries` | `{items: Library[]}` |
| POST | `/api/libraries` | body `{name, rootPath, kind?:"comic"|"video"|"mixed"}`；201 `{library}` |
| POST | `/api/libraries/:id/scan` | 202 `{jobId}`（后台扫描，只读源）；同库并发 409 `conflict` |
| DELETE | `/api/libraries/:id` | 204（只删索引，不动源文件） |
| GET | `/api/libraries/:id/skips` | `{items:[{path, reason, at}]}`：扫描跳过的条目 |
| GET | `/api/libraries/:id/status` | `{readable, error, lastScanAt}`：根路径可读性 |
| GET | `/api/jobs` | `{items: Job[]}` |
| GET | `/api/jobs/:id` | `{job}`；长任务轮询建议 1–2 秒一次 |

`Library = {id, name, rootPath, kind, workCount, lastScanAt}`（`rootPath` 是服务端绝对路径，客户端只展示，不要用于拼 URL）。

`Job = {id, type:"scan"|"scrape", state:"queued"|"running"|"done"|"failed"|"cancelled", progress:{done,total}, message, startedAt, finishedAt}`

## 作品

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/works` | query `q, libraryId, kind=comic\|image-set\|video, sort, page, pageSize` → `{items: WorkCard[], total, page, pageSize}` |
| GET | `/api/works/:id` | `{work, editions:[], pages: PageRef[], progress: {page,pageCount}\|null, coverIndex, dualLanguage, duplicates}` |
| GET | `/api/works/:id/cover` | `image/webp` 封面（480px 宽；视频取首帧剧照，可能为 null；无封面 404），`cache-control: private, max-age=600` |
| GET | `/api/works/:id/pages/:index/thumb` | `image/webp` 缩略图，支持 `?variant=zh` 与 `?w=80..800`（宽度，默认 320；两级缩略图用 `w=160`），`private, max-age=600` |
| GET | `/api/works/:id/pages/:index/image` | 原图/原始帧（`content-type` 随源文件），支持 `?variant=zh`，`private, max-age=3600` |
| GET | `/api/works/:id/video` | 视频原文件流；支持 `Range`（206 + `content-range`，越界 416） |
| PUT | `/api/works/:id/progress` | body `{page}`（0 = 未开始）；204 |

```
WorkCard = {id, title, kind:"comic"|"image-set"|"video", pageCount, coverUrl|null,
            tags: string[], progress?: {page, pageCount}, libraryId, updatedAt}
WorkDetail = WorkCard & {sourceKind:"directory"|"archive"|"video", gid: number|null,
            hasComicInfo: boolean, rating: number|null, path: string,
            coverIndex: number|null, dualLanguage: boolean,
            duplicates: Array<{workId, title, coverUrl|null, reason:"exact"|"same-title"}>}
PageRef = {index, width: number|null, height: number|null, thumbUrl, imageUrl,
           language: string|null, pairKey: string|null, variantIndex: number|null}
```

**双语包与压缩包约定**：

- `dualLanguage=true` 表示作品内存在 `_A`/`_CN`、`_EN`/`_zh` 这类同页双语文件；`PageRef.pairKey` 是跨语言配对键（同键多语言互为对照），`variantIndex` 是中文版页码（若无则为 `null`）。阅读器用 `?variant=zh` 切换同一页的中文版本。
- 压缩包作品（zip/7z/rar）**不解压到作品目录**：zip 直接读中央目录、按需 seek 取页；7z/rar 由容器内 `7zz`/`bsdtar` 按需抽取**单页**，图片页放进程内 LRU（`PAGE_CACHE_MB`，默认 96MB）不落盘，按页流式返回；只有归档内的视频才落到 `/cache/archives/`。客户端无感知，行为与目录作品一致。
- 视频作品的封面是 ffmpeg 首帧剧照（`/api/works/:id/cover`），生成失败返回 404，客户端应回退到占位图。

**搜索查询语法（`q` 参数）**：空白或 `,` 分隔，多个条件为 AND。

| 写法 | 含义 |
| --- | --- |
| `keyword` | 关键词（ASCII 走 FTS，中文按标题子串匹配） |
| `-keyword` | 排除（标题不含） |
| `$title` | 标题精确匹配（不区分大小写） |
| `ca?/ca*/ca%` | 通配：`?` 单字符、`*` 与 `%` 任意长度 |
| `tag:name` / `tag:namespace:name` | 按标签过滤（`-tag:...` 排除）；中文标签直接写中文 |
| `pages:>50` / `pages:20-40` | 页数过滤（支持 `>` `<` `>=` `<=` `=` 与区间） |
| `read:<=30` / `read:0-10` | 阅读进度过滤（0–100，未读按 0） |

例：`q=猫 -ntr tag:language:chinese pages:>50 read:<=30`。标签名含空格时只取第一个词作为标签、其余仍当关键词（写 `tag:big breasts` 会被拆成标签 `big` + 关键词 `breasts`），需要多词标签请用 URL 编码的单一词或后续扩展语法。

**媒体 URL 约定（重要）**：`coverUrl` / `thumbUrl` / `imageUrl` / 视频路径都是**相对路径**（如 `/api/works/12/cover`），客户端用「服务端 Base URL + 路径」拼绝对地址。`work.path`、`library.rootPath` 是服务端本地/库内路径，**禁止**直接展示给终端用户或据此访问文件系统（路径穿越 + 信息泄露）。媒体接口与 JSON 接口一样需要鉴权：原生客户端把 Bearer Token 放请求头（不要拼进 URL 查询串）。

## E-H 刮削

默认关闭：需容器环境 `ENABLE_SCRAPER=true` **且**设置页开关打开，才会发出任何外网请求；已有元数据的作品不重刮（`force` 例外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/scraper` | `{scraper:{enabled, envGate, hasCredential, intervalMs, candidateCount, cooldownMs}}`（`cooldownMs>0` 表示 509 配额冷却剩余毫秒） |
| PUT | `/api/scraper` | body `{enabled?:boolean, minIntervalMs?:2000..60000, cookie?:{ipbMemberId,ipbPassHash,igneous,star?,cfClearance?,userAgent?}}`（更新 Cookie 会解除冷却）；Cookie AES-256-GCM 落 `source_credentials`，不回显 |
| DELETE | `/api/scraper/cookie` | 清除凭据并关闭开关，200 `{scraper}` |
| POST | `/api/scraper/health` | `{health:{ok, latencyMs, error|null}}`；无凭据 409 `no_credential` |
| POST | `/api/scrape/works/:id` | body `{force?:boolean}`；同步返回 `{ok:true, applied:{workId,title,pageCount,tagCount,sourceUrl,cached}}` |
| POST | `/api/scrape/batch` | body `{libraryId?,limit?:1..20,force?}`；202 `{jobId, candidates}`（无候选 `jobId:null`），用 `GET /api/jobs/:id` 轮询 |

错误映射：未开 409 `scraper_disabled`；无 gid 400 `no_gid`；已有元数据 409 `already_scraped`；Cookie 失效 409 `credential_invalid`；CF 502 `cf_challenge`；509 配额 429 `quota_exceeded`（并写入全局冷却，期间再刮削返回 429 `cooldown`）；sadpanda/kokomoe 封禁页 403 `ip_banned`；未找到 404。

命中 token 的链路（按优先级）：① 目录作品内 `.ehviewer`（VERSION2 文本格式，直接含 gid+token）→ ② 本地 `ComicInfo.xml` 的 `Web` 字段 `/g/{gid}/{token}` → ③ 站内搜索 `f_search=gid:{gid}`。客户端不感知，均为服务端内部行为。

## 错误码表

| HTTP | `code` | 含义 / 客户端处理 |
| --- | --- | --- |
| 400 | `validation_failed` | 参数/body 非法。修正输入后重试，不要自动重试 |
| 400 | `unsupported_api_version` | `X-API-Version` 主版本不受支持。提示升级客户端 |
| 401 | `unauthorized` | 未登录、Cookie 失效、Token 无效或已吊销。清凭据重新登录 / 重新配置 Token |
| 401 | `bad_credentials` | 登录用户名或密码错误。提示用户重输 |
| 403 | `forbidden` | 已鉴权但角色或 Token 作用域不足。提示权限不足，不要重试 |
| 404 | `not_found` | 资源不存在（含已吊销的 Token）。刷新列表 |
| 409 | `conflict` | 状态冲突：已完成初始化 / 该库正在扫描 / 刮削未开启 / 无凭据等。读 `message` 提示 |
| 429 | `rate_limited` | 被外站限速（刮削）。按退避重试 |
| 429 | `quota_exceeded` | 里站 509 配额超限。稍后重试，勿立即循环 |
| 429 | `cooldown` | 配额冷却中（`message` 含剩余分钟数）。等冷却结束或换 Cookie |
| 403 | `ip_banned` | 里站 sadpanda/kokomoe 封禁页。换出口 IP 或换账号 |
| 500 | `internal` | 服务端内部错误。可退避重试一次并上报日志 |

刮削专用码：`scraper_disabled`、`no_gid`、`already_scraped`、`no_credential`、`credential_invalid`、`cf_challenge`、`not_found`、`scrape_failed`（多数落在 4xx，按上表同码处理）。

## 缓存建议

- `/api/meta`、`/api/openapi.json`：可公共缓存（5–10 分钟）。
- 业务 JSON（作品、库、任务）：随鉴权态变化，客户端按账号隔离缓存，不要跨账号复用。
- 图片：按 `workId + page + 尺寸(`w`)` 建磁盘缓存键；收到 401/403 时失效重取。列表用 `w=160` 的小图、详情预览用默认 320。
- 视频：用支持 `Range` 的播放器直接请求，不整段缓存到内存。

## 前端路由（Web 端，供客户端对照）

| 路由 | 页面 |
| --- | --- |
| `/setup` | 首次向导：创建管理员 → 添加媒体库 → 开始扫描 → 进入书库 |
| `/login` | 登录 |
| `/` | 书库网格（封面/标题/页数/进度），搜索、排序、库筛选 |
| `/works/:id` | 详情（封面、标签、页数、继续阅读） |
| `/reader/:id?page=N` | 阅读器（单页/双页/纵向连续，键盘与点击翻页，自动上报进度） |
| `/settings` | 媒体库管理、扫描任务状态（最小实现） |

## AI 自然语言搜索

LLM 只把「一句话描述」翻译成上面的查询语法，检索仍由服务端完成；默认 DeepSeek（OpenAI 兼容）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ai` | 状态：`enabled`（站内开关）、`envGate`（兼容字段，已不再参与门禁）、`configured`（是否已存 Key）、`model`、`baseUrl`、`usage.requests` |
| PUT | `/api/ai` | 保存 `{enabled?,model?,baseUrl?,apiKey?,explain?,summarize?}`；保存 `apiKey` 会自动开启 |
| DELETE | `/api/ai/key` | 删除加密存储的 Key 并关闭 AI |
| POST | `/api/ai/health` | 最小请求测连通，返回 `{health:{ok,latencyMs,error}}` |
| POST | `/api/ai/query` | `{q:"最近更新的中文猫娘同人"}` → `{query,explanation,sort,total,items,facets,effective}` |

- 错误码：`ai_disabled`（409，双重门禁未开）、`ai_not_configured`（409）、`ai_llm_auth_failed`（502）、`ai_llm_model_not_found`（502）、`ai_llm_rate_limited`（429）、`ai_llm_timeout`（504）、`ai_llm_network`（502）、`ai_bad_response`（422，模型输出无法解析）。
- `items` 形状与 `WorkCard` 一致（`coverUrl` 等相对路径）；`query` 为用户可复现/可手改的查询串；`facets` 是结果内 top 12 标签计数。
- 标签查询：`GET /api/tags?q=&limit=`（≤200）返回 `{items:[{id,namespace,name,count}]}`，按作品数倒序，供客户端做标签联想。
- 启用方式：设置页保存 Key 后打开「开启 AI 搜索」即可（无需环境变量）；`LLM_API_KEY`（可选兜底，与设置页二选一）、`LLM_BASE_URL`（默认 `https://api.deepseek.com`）、`LLM_MODEL`（默认 `deepseek-chat`）、`LLM_TIMEOUT_MS`（默认 20000）。错误码：未开启 `ai_disabled`、无 Key `ai_no_key`、未开分类 `ai_classify_disabled`。


## 整理 / NFO / 去重

### 整理（dry-run 默认）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/organize` | 状态：`enabled`（站内开关）、`writebackEnabled`（`DATA_MODE=writeback`）、`pattern`、`nfoEnabled` |
| PUT | `/api/organize` | `{enabled?, pattern?, nfo?}`；模板非法返回 `400 invalid_pattern`；`nfo=true` 在只读部署下返回 `409 writeback_disabled` |
| GET | `/api/organize/preview?libraryId&pattern&limit` | dry-run：`{pattern, writebackEnabled, enabled, library{id,rootPath}, items[{workId,title,kind,pages,from,to,conflict}], conflictCount}`，**不触碰磁盘** |
| POST | `/api/organize/apply` | `{libraryId, workIds?, confirm:true}` → `{applied, failed, journalId, journalPath, rescanRequired}`；三重门禁（`writeback_disabled` / `organize_disabled` / `confirm_required`），执行后建议重新扫描 |
| GET | `/api/organize/journal` | 写回记录：`{entries:[{id,type,at,detail}]}`，最多 50 条（`type`：整理重命名 / NFO 写入 / 重复合并） |
| POST | `/api/organize/undo/{id}` | 撤销一条 journal → `{ok, undone, rescanRequired, type}`；NFO 记录删文件、整理记录反向改名、合并记录恢复副本；未知 id 返回 `404 journal_not_found` |

- 模板变量：`{title} {author} {series} {year} {pages} {gid} {kind} {ext}`；非法字符会被清洗，`..` 越界条目报 `invalid_path`，目标已存在报 `target_exists` 并跳过。
- 执行只做重命名/移动，**不删除、不覆盖**；每次写 `<CONFIG_DIR>/journal/<id>.json`（带撤销凭据）并记一条审计。详见 。

### NFO

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/works/{id}/nfo` | `{filename, content, writePath, writebackEnabled}`；`content` 为 Kodi/Jellyfin 兼容 XML；只读部署下只预览不写入 |
| POST | `/api/works/{id}/nfo` | `{confirm:true, force?}` → `{ok, path, filename, journalId, journalPath}`；三重门禁：`writeback_disabled` / `organize_disabled`（含 `organize.nfo` 子开关）/ `confirm_required`；同名已存在且无 `force` 时 `409 target_exists` |

### 重复

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/duplicates` | `{groups:[{key,count,works:[{id,title,path,pageCount}]}]}`（按 `works.dup_key` 聚合） |
| POST | `/api/duplicates/preview-merge` | `{keepId}` → `{plan:{keepId,dropIds,mergedTags,totalPages,warnings}, writebackEnabled}`；**只生成计划，不合并、不删除** |
| POST | `/api/works/merge` | `{keepId, confirm:true}` → `{ok, keepId, merged, dropIds, journalId, journalPath}`；仅改索引（副本 `hidden=1, merged_into=keepId`），源文件不动，可撤销 |

### 维护与备份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/maintenance` | `{maintenance:{version, configDir, backupCount, backups:[{name,bytes,createdAt}]}}` |
| POST | `/api/maintenance/backup` | `VACUUM INTO /config/backups/nekoshelf-<ts>-<ver>.db` → `{backup:{name,bytes,createdAt}}`；不锁库、不写媒体目录 |

恢复没有 API：由用户停容器后用快照覆盖 `nekoshelf.db`（README「发布与备份」）。详见 。

## 尚未实现（避免误用）

- 上传接口、Token 过期/刷新、通用速率限制：未实现（Token 只有作用域与吊销，见 后果」）。
- 整理批量执行仍为同步请求（无进度条）；`editions` 字段为兼容保留，恒为空数组。
- 向量检索 / 语义近邻：「画风类似 X」这类需求不在 范围内。

## 0.6.0 新增：作者 / 系列 / 文件树 / 相关推荐 / AI 操作

所有接口都需要登录态（Cookie 或 Bearer Token），错误格式仍为 `{error:{code,message}}`。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/people?q=&role=&limit=200` | 作者/画师列表，返回 `{items:[{id,name,role,count}]}` |
| `GET /api/people/:id?page=1&pageSize=60` | 某人作品：`{person:{id,name},items:[WorkCard],total}` |
| `GET /api/series?q=&limit=200` | 系列列表：`{items:[{id,name,count}]}` |
| `GET /api/series/:id?page=1&pageSize=60` | 某系列作品：`{series:{id,name},items,total}` |
| `GET /api/libraries/:id/tree?path=` | 文件树当前目录：`{libraryName,path,entries:[{type:"dir"|"file",name,size?,workId?,workTitle?,pageCount?,workCount?}]}` |
| `GET /api/works/:id/related?limit=12` | 相关推荐 `{items:[WorkCard]}`（同系列 → 同作者 → 共享标签） |
| `POST /api/works/:id/translate-title` | 标题翻译为中文并落库，返回 `{id,titleZh,cached}`；需 AI 开关，否则 409 |
| `POST /api/works/:id/classify` | AI 类型判定并应用，返回 `{id,kind,previousKind,cached,result:{kind,confidence,reason?}}`；需 AI 开关，否则 409 |

`GET /api/works` 新增 `kind` 参数：`comic | image-set | video`；作品详情 `WorkDetail` 增加 `authors:[{id,name,role}]`、`series:{id,name}|null`、`titleZh`。


### 库内原始文件（文件树预览）

`GET /api/libraries/:id/file?path=<库内相对路径>`

- 只读返回库根目录下的原始文件，用于文件树里预览图片、播放视频；`path` 不允许 `..`，越界返回 400/404。
- 图片：`?thumb=1&w=480` 返回 WebP 缩略图（结果缓存到 `/cache/tree-thumbs`）；不带 `thumb` 返回原图。
- 视频：支持 `Range` 请求（`206 Partial Content`），可直接拖动进度条。
- 不支持的类型返回 415。
