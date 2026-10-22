#!/usr/bin/env bash
# 部署轻盘到 Cloudflare Pages（项目名 qingpan → https://qingpan-67r.pages.dev）
# 密钥不在这里：在 Cloudflare 后台配置，或用
#   npx wrangler@4 pages secret put MCD_MCP_TOKEN --project-name qingpan
#   npx wrangler@4 pages secret put AMAP_KEY      --project-name qingpan
set -euo pipefail
cd "$(dirname "$0")"
npm test
npx --yes wrangler@4 pages deploy --project-name qingpan --branch main --commit-dirty=true
