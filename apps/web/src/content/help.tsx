import type { ReactNode } from "react";

export type HelpSection = {
  id: string;
  title: string;
  /** 一句话摘要，用于目录与搜索 */
  summary: string;
  body: ReactNode;
};

function Code({ children }: { children: string }) {
  return <pre className="help-code">{children}</pre>;
}

function Kbd({ children }: { children: string }) {
  return <kbd className="help-kbd">{children}</kbd>;
}

function Note({ kind = "info", children }: { kind?: "info" | "warn"; children: ReactNode }) {
  return <div className={`help-note help-note--${kind}`}>{children}</div>;
}

/**
 * 「帮助」页内容。改这里等于改应用内文档；docs/帮助文档.md 是给仓库/离线看的镜像。
 */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "5 分钟上手",
    summary: "起容器 → 初始化 → 添加库 → 扫描",
    body: (
      <>
        <p>
          NekoShelf 是一个单容器的私有媒体库：挂上你的媒体目录（默认只读），它负责索引、封面、阅读与播放。
          所有数据（数据库、凭据、备份）都在 <code>/config</code>，缓存可随时清空。
        </p>
        <Code>{`docker run -d --name nekoshelf -p 8080:8080 \\
  -v /你的漫画目录:/data:ro \\
  -v /你的配置目录:/config \\
  -v /你的缓存目录:/cache \\
  -e PUID=1000 -e PGID=1000 -e TZ=Asia/Shanghai \\
  nekoshelf:0.5.0`}</Code>
        <ol>
          <li>
            打开 <code>http://NAS地址:8080</code>，首次会跳 <code>/setup</code>：设管理员账号 → 添加第一个媒体库（根路径填容器内路径，如 <code>/data</code>）。
          </li>
          <li>保存后回设置页点「扫描」。扫描只读；扫描期间可以正常浏览已索引内容。</li>
          <li>点开作品即可阅读；进度自动保存。</li>
        </ol>
        <Note>
          不想写 docker run 也行：<code>docker/docker-compose.yml</code> 里改两个卷路径，然后 <code>docker compose up -d</code>。
        </Note>
      </>
    ),
  },
  {
    id: "layout",
    title: "媒体怎么放",
    summary: "目录、压缩包、命名规则与双语对照",
    body: (
      <>
        <h3>目录与压缩包</h3>
        <ul>
          <li>一个作品一个目录（图片直接放在目录里），或一个作品一个压缩包（zip / 7z / rar / cbz）。</li>
          <li>支持混合：同一目录下既有散图也有压缩包，会自动归组、不会重复计数。</li>
          <li>zip 直接读中央目录、逐页流式输出，不落盘；7z/rar 单页按需解到 <code>/cache</code>，再快照缓存。</li>
          <li>下载中的文件不会被索引：<code>.pptd</code>、<code>.part</code>、<code>.downloading</code>、<code>.aria2</code>、<code>.tmp</code>、<code>.!qB</code>，以及 <code>.cfg</code> 伴生配置。</li>
          <li><code>thumb.webp</code> / <code>cover.jpg</code> 这类封面文件不算「页」，会自动挑作封面。</li>
        </ul>
        <h3>命名规则（能识别就赚到）</h3>
        <ul>
          <li>标题：<code>[作者] 标题 [汉化组] [Chinese]</code> → 自动拆「标题 / 作者 / 汉化组」。</li>
          <li>E-H 目录名 <code>gid-标题</code>：直接拿 gid/token，跳过标题推断。</li>
          <li>页数声明：<code>[57P-795MB]</code>、<code>[463P+67P]</code>、<code>[108P+7V-1.23GB]</code> 都认，用于与实测页数比对。</li>
          <li>双语对照：同目录 <code>001.webp</code> 与 <code>001_CN.webp</code>（<code>_CH</code>/<code>_EN</code>/<code>_JP</code> 同理）自动配对，阅读器可切换语言。</li>
          <li>视频番号：<code>ABC-123</code>、<code>XYZ-456</code>，自动剥掉 <code>ads.com@</code> 这类广告域名前缀与广告文件；同番号多版本合成版本组。</li>
        </ul>
        <Note kind="warn">
          只读是设计原则：扫描、阅读、封面生成都不会改媒体目录。只有你显式开启「整理」并配置写回目录时，才会动文件。
        </Note>
      </>
    ),
  },
  {
    id: "reader",
    title: "浏览与阅读",
    summary: "书库、阅读器模式、快捷键、触摸与鼠标",
    body: (
      <>
        <h3>书库</h3>
        <ul>
          <li>搜索框有 300ms 防抖；排序支持「最近更新 / 标题 / 评分」，可按媒体库过滤。</li>
          <li>网格密度与筛选会记在这台设备上（localStorage）。</li>
        </ul>
        <h3>阅读器</h3>
        <ul>
          <li>三种模式：单页、双页、纵向连续；方向支持右到左（日漫）/ 左到右；适配「适高 / 适宽 / 原始」；缩放 1×/1.25×/1.5×/2×。</li>
          <li>打开时默认使用「上次这本书的设置」，再回落到设置页的默认值。</li>
          <li>键盘：<Kbd>←</Kbd> <Kbd>→</Kbd> 翻页，<Kbd>空格</Kbd> 下一页，<Kbd>m</Kbd> 模式，<Kbd>p</Kbd> 方向，<Kbd>f</Kbd> 适配，<Kbd>g</Kbd> 跳页，<Kbd>q</Kbd> 退出。</li>
          <li>鼠标模式：滚轮/方向键翻页，悬停显示菜单；触屏模式：点左/右 1/3 翻页、双指缩放、长按不弹菜单。</li>
          <li>交互模式（自动 / 触摸 / 鼠标）在设置页或阅读器面板里可手动切换，选择会持久化。</li>
        </ul>
        <h3>合集与章节</h3>
        <ul>
          <li>作者/平台目录下按日期、套图、第 N 话分子目录的图集，会合并成一个作品：详情页有「章节目录」，点一章进入章节详情页（封面、页数、上一章/下一章），再从章节详情开始阅读。</li>
          <li>视频剧集（如 <code>av/番剧/第01话/01.mp4</code>）合并成一个视频作品，每话一章：详情页点章节观看，播放页可切换话数。</li>
          <li>含 ComicInfo.xml / .ehviewer / 压缩包的子目录不会被合并，仍按单本漫画处理。多卷/多话命名（第01话、vol.2、part1…）会被合并成一册多章。</li>
          <li>同一目录下多集视频（EP01/02、CD1/2…）合并成一个视频作品，播放页可切换集数。</li>
        </ul>
        <Note>移动端：顶栏自动收成两行，面板变成底部抽屉，按钮保证 ≥44px 触摸目标。</Note>
      </>
    ),
  },
  {
    id: "browse",
    title: "分类与浏览",
    summary: "按作者 / 系列 / 文件树找东西",
    body: (
      <>
        <p>
          书库顶部有「全部 / 漫画 / 图集 / 视频」分类，选择会记在这台设备上。书库下方还有三个入口：
        </p>
        <ul>
          <li>
            <strong>按作者</strong>：作者来自 ComicInfo 的 Writer / Penciller 与目录名前缀，点作者看作品。
          </li>
          <li>
            <strong>按系列</strong>：来自 ComicInfo 的 Series 字段，同系列作品自动归组。
          </li>
          <li>
            <strong>文件树</strong>：按磁盘真实结构逐级浏览（只读），带作品标记的条目可直接打开；目录里有图片/视频时，上方会出现「本目录媒体」，点开可连续查看（←/→ 切换、Esc 关闭），视频可拖动进度。
          </li>
        </ul>
        <p>
          打开任意作品，标题下方显示作者 / 画师 / 系列；页面底部有「相关推荐」（同系列、同作者、共享标签）。
        </p>
        <Note>归类规则见仓库 docs/目录特征与归类.md；判不准的作品可在详情页用 AI 分类。</Note>
      </>
    ),
  },
  {
    id: "video",
    title: "视频播放与缩放",
    summary: "Range 直连播放、缩放与拖动",
    body: (
      <>
        <p>
          视频作品详情页点「播放视频」进入播放页：走 Range 直连（不转码，交给浏览器解码），
          视频包里的文件会按需解包到 /cache 再流式播放。
        </p>
        <p>
          缩放：<Kbd>+</Kbd> / <Kbd>-</Kbd> 调整倍率，<Kbd>0</Kbd> 复位，<Kbd>f</Kbd> 切换「适应窗口 / 原始尺寸」；
          放大后可在画面区域拖动查看细节。
        </p>
        <p>
          图片阅读器的缩放：<Kbd>Ctrl</Kbd> + 滚轮，触摸设备双指捏合，双击切换 1×/2×。
        </p>
      </>
    ),
  },
  {
    id: "aiworks",
    title: "标题翻译与 AI 分类",
    summary: "中文标题、判不准的类型交给模型",
    body: (
      <>
        <p>
          标题翻译：作品详情页「翻译标题」把原标题交给 LLM 翻成中文并保存；之后列表与详情优先显示中文名。
        </p>
        <p>
          AI 分类：图集 / 漫画 / 视频判不准时，用「AI 判断类型」让模型按内容与命名给出类型和置信度，确认后应用。分类结果会缓存，重复点不重复计费。
        </p>
        <Note kind="warn">
          在「设置 → AI 自然语言搜索」里填入 Key 并打开开关即可，不需要改容器环境变量；默认关闭，不发任何外网请求。
        </Note>
      </>
    ),
  },
  {
    id: "search",
    title: "搜索语法",
    summary: "关键词、排除、标签、页数、阅读进度",
    body: (
      <>
        <p>普通输入就是标题/日文标题的模糊搜索；下面这些写法可以组合：</p>
        <ul>
          <li><code>猫 夏天</code>：多个词都要命中（AND）。</li>
          <li><code>-猫</code>：排除含「猫」的标题。</li>
          <li><code>&quot;猫物语&quot;</code>：精确短语。</li>
          <li><code>猫*</code>：通配。</li>
          <li><code>tag:猫娘</code>、<code>tag:group:某某汉化</code>：按标签搜（<code>-tag:</code> 排除）。</li>
          <li><code>pages:&gt;100</code>、<code>pages:20-80</code>：页数范围。</li>
          <li><code>read:&lt;50</code>：阅读进度（百分比）。</li>
        </ul>
        <p>语法由 <code>packages/core/src/query.ts</code> 解析，纯函数、有单测，不会把用户输入直接拼进 SQL。</p>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI 自然语言搜索",
    summary: "用一句话找书，默认 DeepSeek",
    body: (
      <>
        <p>
          书库里点「✨ AI 描述搜索」，用自然语言描述你要找什么，例如「找页数超过 100 的汉化同人志，排除已经看过的」。
          服务端会让大模型把这句话<strong>翻译成本页上面的搜索语法</strong>，再走同一个查询引擎——大模型不接触你的库内容，也不做向量检索。
        </p>
        <ol>
          <li>设置页「AI 自然语言搜索」里填 DeepSeek API Key（或兼容 OpenAI 的服务地址 + 模型名）。</li>
          <li>打开开关并保存，点「测试连接」确认可用。</li>
          <li>AI 默认关闭：到设置页填入 API Key 并打开开关即可；旧版的环境变量硬开关已取消，不需要改容器配置。</li>
          <li>会在结果上方显示「理解成了什么查询」与命中的标签分布，可一键返回普通搜索。</li>
        </ol>
        <Note kind="warn">AI 搜索会把你的自然语言描述与当前标签上下文发给所配置的模型服务商，介意的话保持关闭即可。</Note>
      </>
    ),
  },
  {
    id: "eh",
    title: "E-H 刮削（里站）",
    summary: "默认关闭、只补缺失、手动单条",
    body: (
      <>
        <p>
          刮削只访问里站 <code>exhentai</code>，用于补齐标题、作者、标签、页数与封面。三条硬规则：
        </p>
        <ol>
          <li><strong>默认关闭</strong>：容器没设 <code>ENABLE_SCRAPER=1</code> 时，任何页面都不会发请求。</li>
          <li><strong>已有元数据不重刮</strong>：目录里有 ComicInfo、有 <code>.ehviewer</code> 记录、或之前已标来源 E-H 的作品直接跳过，不覆盖人工字段。</li>
          <li><strong>只手动触发</strong>：在作品详情页点「从 E-H 刮削」（单条），或设置页「批量刮削（≤10）」，没有全自动后台任务。</li>
        </ol>
        <h3>Cookie 怎么给</h3>
        <p>
          设置页填 <code>ipb_member_id</code>、<code>ipb_pass_hash</code>（必需），<code>igneous</code>、<code>cf_clearance</code>（可选，里站常需要）。
          用浏览器登录里站后，从开发者工具 Application → Cookies 复制。凭据用 AES-256-GCM 加密存 <code>/config</code>，页面不回显。
        </p>
        <p>请求串行 + 限速（默认 1 req/s，可调 0.2–5），连续失败会指数退避并进入冷却；429/509 会冷却而不是硬刷。</p>
      </>
    ),
  },
  {
    id: "organize",
    title: "整理与 NFO 写回",
    summary: "默认只预览；写回要三重门禁",
    body: (
      <>
        <p>「整理」= 按模板重命名/移动媒体文件，并可选写 NFO。默认永远只出<strong>预览计划</strong>，不会动文件。</p>
        <h3>模板变量</h3>
        <Code>{`{author}  {title}  {series}  {pages}  {language}  {year}  {gid}
例：[{author}] {title} [{language}] {pages}P`}</Code>
        <h3>真的执行需要同时满足</h3>
        <ol>
          <li>容器以 <code>DATA_MODE=writeback</code> 启动（不是 readonly）；</li>
          <li>设置页打开「整理」开关；</li>
          <li>执行时在预览里带 <code>confirm: true</code>（界面会二次确认）。</li>
        </ol>
        <p>执行会写 journal 到 <code>/config/journal.jsonl</code>，可在「写回记录」里逐条撤销（只撤销 NekoShelf 自己做过的移动）。</p>
        <h3>NFO</h3>
        <p>
          作品详情页「NFO 预览」展示将生成的 Kodi/Jellyfin 兼容 XML（标题、页数、唯一 ID、标签）。写回同样受上面的门禁限制。
        </p>
      </>
    ),
  },
  {
    id: "dupes",
    title: "疑似重复与合并",
    summary: "按归一化标题分组，可合并与撤销",
    body: (
      <>
        <p>
          「重复」页按归一化标题（去括号、去标记、转小写）把疑似同一作品分组；逐字节相同会被高亮。
          合并 = 把被合并项标记为隐藏并指向保留项（<code>merged_into</code>），<strong>不删文件</strong>。
        </p>
        <ul>
          <li>每组选一个保留目标，点「合并」；合并后仍可在「写回记录」里撤销。</li>
          <li>有写回动作时同样需要写回门禁（DATA_MODE=writeback + 开关 + confirm）。</li>
        </ul>
      </>
    ),
  },
  {
    id: "backup",
    title: "备份与恢复",
    summary: "快照位 /config/backups，恢复走宿主机",
    body: (
      <>
        <p>设置页「备份与维护 → 立即备份」会在 <code>/config/backups/</code> 生成一个 <code>VACUUM INTO</code> 一致性快照（<code>nekoshelf-时间-版本.db</code>），可直接拷走。</p>
        <p>恢复没有开放远程接口，避免误操作。停容器后按下面做：</p>
        <Code>{`docker stop nekoshelf
cd /你的配置目录
cp nekoshelf.db nekoshelf.db.bak-$(date +%s)
rm -f nekoshelf.db-wal nekoshelf.db-shm
cp backups/nekoshelf-<时间>-0.5.0.db nekoshelf.db
chown -R 1000:1000 .
docker start nekoshelf`}</Code>
        <Note kind="warn">
          <code>nekoshelf.db</code> 及其 <code>-wal</code> 必须在本地磁盘卷上：SQLite WAL 不支持放在 SMB/NFS 上，放在网络盘会导致损坏，程序检测到会拒绝启动。
        </Note>
      </>
    ),
  },
  {
    id: "client",
    title: "客户端与 API",
    summary: "Bearer Token、/api/meta、OpenAPI",
    body: (
      <>
        <p>给第三方客户端/脚本用：</p>
        <ol>
          <li>管理员在设置页生成 API Token（<code>nks_...</code>，明文只显示一次），作用域 <code>read</code>/<code>write</code>/<code>admin</code>。</li>
          <li>请求头 <code>Authorization: Bearer nks_...</code>，并带 <code>X-API-Version: 1</code>。</li>
          <li>先 <code>GET /api/meta</code> 拿版本与能力；完整契约见 <code>docs/openapi.json</code> 或运行期 <code>GET /api/openapi.json</code>。</li>
        </ol>
        <p>浏览器同源访问用 Cookie 会话即可，不需要 Token。跨域 WebView 需要配置 <code>CORS_ORIGINS</code>。</p>
      </>
    ),
  },
  {
    id: "faq",
    title: "常见问题",
    summary: "权限、编码、封面、性能、移动端",
    body: (
      <>
        <h3>容器起来了但页面 502 / 白屏</h3>
        <p>看容器日志。常见原因：<code>/config</code> 没有写权限（PUID/PGID 与目录属主不一致），或 <code>/data</code> 路径挂了不存在的目录。</p>
        <h3>扫不到文件</h3>
        <ul>
          <li>根路径要填<strong>容器内</strong>路径（如 <code>/data/comics</code>），不是宿主机路径。</li>
          <li>文件名以 <code>.</code> 开头的目录、下载中间态文件会被跳过；确认不是还没下载完。</li>
          <li>扫描任务在「任务」页看进度与失败原因。</li>
        </ul>
        <h3>封面是空的</h3>
        <p>页面里找不到可作封面的图片（例如只有视频、或压缩包首页损坏）时，会显示占位图；重新扫描可重建缓存。缩略图缓存在 <code>/cache/thumbs</code>，删掉后会重建。</p>
        <h3>中文标题乱码</h3>
        <p>压缩包内文件名编码不统一（GBK vs UTF-8）是历史遗留：zip 会优先按 UTF-8 标志位读，必要时回退 GBK；仍有问题请把样本目录名与压缩包文件名一起反馈。</p>
        <h3>转码/视频不流畅</h3>
        <p>视频默认直连播放（浏览器支持就直连），不支持再转码；<code>MAX_TRANSCODE</code> 限制并发路数，软解很吃 CPU，有核显建议 <code>HWACCEL=qsv</code>。</p>
        <h3>WSL 里容器总是自己停</h3>
        <p>WSL 空闲会回收。开发/演示时保持一个终端运行 <code>wsl -d Ubuntu -e sleep 3600</code>，或用 Windows 任务计划在登录时启动。</p>
      </>
    ),
  },
  {
    id: "readonly",
    title: "只读保证与合规",
    summary: "默认不改你的文件；仅索引元数据",
    body: (
      <>
        <p>
          NekoShelf 的默认行为是<strong>只读</strong>：扫描读目录与压缩包头、阅读按需读图、缩略图写 <code>/cache</code>、数据库写 <code>/config</code>。
          不会重命名、移动、删除媒体文件；<code>docker-smoke.sh</code> 与 <code>verify-readonly.ps1</code> 会对比扫描前后文件清单来验证这一点。
        </p>
        <p>整理/写回是显式开启的例外，见「整理与 NFO 写回」。请只对你有权处理的内容使用本工具；刮削得到的是第三方站点元数据，注意遵守相应站点条款与本地法律。</p>
      </>
    ),
  },
];
