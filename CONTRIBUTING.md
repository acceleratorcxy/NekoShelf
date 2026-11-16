# 贡献指南 / Contributing

欢迎提交 Issue 与 Pull Request。请先读 [docs/api-contract.md](docs/api-contract.md)，它记录了接口契约与主要设计取舍。

> English: contributions are welcome. Please read the ADRs and the API contract first; keep PRs small and focused, and describe the user-visible behavior change.

## 开发环境

- Node 24 + pnpm 11（版本由 `package.json` 的 `packageManager` 固定，用 `corepack enable` 即可）。
- 可选：Docker（验证镜像与容器冒烟）、`7z`/`bsdtar`（压缩包相关测试）。
- 不需要系统级 libvips / ImageMagick：图像走 `sharp` 预编译；压缩包走子进程调 `7zz` / `bsdtar`。

```bash
pnpm install
pnpm typecheck        # 四个包整体类型检查，必须全绿
pnpm test             # 单元 + 集成测试
pnpm --filter @nekoshelf/web build
```

## 提交前自查

1. `pnpm typecheck` 与 `pnpm test` 全绿；新增逻辑必须有测试。
2. 解析规则改动必须附带**由真实样本派生的脱敏夹具**（不要提交真实媒体文件；单个夹具 ≤5MB）。
3. 新的默认行为如果涉及写盘、外网请求，必须是**默认关闭 + 显式开关**。
4. 不提交大文件、`node_modules`、`dist`、`data/`、`cache/`、`.env`、数据库、密钥。
5. 涉及需求变化时改 `docs/src/part*.md` 再重建，不要手改合并产物。

## 提交信息

使用中文 Conventional Commits：

```
feat(m4): 重复合并支持索引层 merge 与撤销
fix(reader): 双页模式在超宽屏下页序颠倒
docs: 补充第三方组件协议说明
```

## Pull Request

- 一个 PR 只解决一件事，描述里写清「为什么」与「用户可见的变化」。
- 涉及界面变化请附截图；涉及接口变化请同步 `docs/api-contract.md` / `docs/openapi.json`。
- CI 必须绿（typecheck / 测试 / 前端构建）。
- 维护者可能会就「是否扩大范围」提出意见，请在 PR 里保持讨论聚焦。

## 写回规则

默认路径不得写、改、删用户媒体文件。写回能力（整理重命名、NFO、重复合并）必须保留：显式开启 + dry-run 预览 + **每次操作手动确认** + journal 可撤销。
