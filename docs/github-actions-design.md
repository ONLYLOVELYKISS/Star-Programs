# GitHub Actions 每日项目采集方案

## 数据层

`.github/workflows/github-daily-collect.yml` 每天 01:00 UTC（北京时间 09:00）运行，也支持手动触发并指定 `top_n`。

`scripts/collect-github-daily.mjs` 会：

1. 读取 GitHub Trending daily 页面，默认取前十。
2. 用 GitHub 官方仓库 API 读取描述、语言、累计 Star、许可、主题和更新时间。
3. 读取官方 README 摘要。
4. 与最近的历史 JSON 比较，生成“两个采集快照之间的估算 Star 增量”。这不是官方全天新增量。
5. 写入 `data/github-trending/YYYY-MM-DD.json` 和 `latest.json`。

抓取失败也会写入带 `failureReason` 的 JSON，工作流继续上传 Artifact，避免用旧数据伪装成新数据。

## 内容层

Codex 或其他写作程序只需读取 `data/github-trending/latest.json`：

- 用 `projects` 生成 Notion 数据库文章。
- 用同一份数据生成微信公众号发布稿。
- 将相同 Markdown 写入本地 `Github每日星标项目/YYYY-MM-DD.md`。

Notion 写入可以继续使用 MCP；若 MCP OAuth 不稳定，可改为在 GitHub Secrets 中保存 Notion Integration Token，直接调用 Notion API。

## 重要口径

- Trending 的今日 Star 是页面采集时显示的 daily 信号。
- `estimatedStarsSincePreviousSnapshot` 是两个快照的差值，不是官方自然日新增量。
- 每一篇文章应保存 `capturedAtChinaTime`、来源 URL 和失败原因。
