# MCP 集成说明

## 使用的 MCP Server

| 项目 | 内容 |
|---|---|
| 服务 | 麦当劳中国 MCP Server（`mcd-mcp 1.0.0`） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输 | Streamable HTTP，协议版本 `2025-06-18`（`initialize` → `notifications/initialized` → `tools/call`，带 `Mcp-Session-Id`） |
| 鉴权 | `Authorization: Bearer ${MCD_MCP_TOKEN}`，Token 只来自环境变量 / Cloudflare 后台密钥 |
| 客户端 | [`scripts/mcp-client.mjs`](scripts/mcp-client.mjs)：零依赖，Node 18+ 与 Cloudflare Pages Functions 通用；兼容 SSE 与 JSON 两种响应 |

## 使用的工具

线上共 35 个工具（2026-10-22 实测，比公开文档多 14 个）。轻盘只用其中 5 个只读工具：

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `query-nearby-stores` | 按城市 + 关键词找附近可到店的门店 | `searchType=2`、`city`、`keyword`、`beType=1` |
| `query-meals` | 读取该门店当前在售菜单与价格 | `storeCode`、`beType=1`、`orderType=1`（到店自取不传 `beCode`） |
| `list-nutrition-foods` | 官方营养成分表（160 款，含能量、蛋白质、脂肪、碳水、钠、钙） | 无 |
| `calculate-price` | 用门店算价确认托盘价格（试算，不生成订单） | `storeCode`、`beType=1`、`orderType=1`、`items[{productCode, quantity}]` |
| `now-time-info` | 连通性冒烟（探测脚本） | 无 |

## 调用流程

```
用户输入「城市 + 地点」或点「定位」
  │  （定位时：腾讯逆地理编码 → 城市 + 区县）
  ▼
query-nearby-stores ──► 选最近的营业门店
  │                       门店接口不返回坐标（经纬度为 0），
  │                       用腾讯按「城市 + 门店地址」补坐标，供步行路线使用
  ▼
query-meals ∥ list-nutrition-foods   （营养表全站缓存 6 小时）
  │
  ▼
mcd-adapter.js：解析表格文本营养表、合并菜单与营养、剔除套餐/酱料/周边
  │  · 精确匹配优先；菜单名不带规格时按中杯/中份估算，并在界面标「≈」
  │  · 没有营养数据的单品不参与配餐，单独列出
  ▼
planner.js：主食 + 配餐 + 饮品，满足热量上限与蛋白质下限，按天气加权
  │
  ▼
calculate-price ──► 显示门店算价（单位：分 → 元）
```

返回结构的解析集中在 [`web/js/mcd-adapter.js`](web/js/mcd-adapter.js)，网页、Skill 和测试共用同一份。

## 其他接入的能力

| 能力 | 用途 |
|---|---|
| 腾讯地图 WebService API（地理编码 / 逆地理编码 / 步行路线） | 「走着去」往返步行消耗、定位后自动识别城市与门店关键词 |
| open-meteo 免费天气 API（按坐标，无需 Key） | 「天气菜单」热饮/清爽加权、首屏文案随天气变化 |
| 浏览器 Canvas | 本地绘制营养成分表风格分享卡，不上传 |
| 浏览器 DeviceMotion | 摇一摇开盲盒 |
| 浏览器 localStorage | 7 天轻盘挑战打卡记录，只存在本机 |

## 安全与隐私设计

- **只读白名单**：客户端只放行 17 个查询类工具；下单、取消、领券、兑换、抽奖、新增地址等写操作以及白名单外的新工具，一律拒绝调用。
- **两种身份**：
  - 体验模式用站点 Token，服务端只放行与个人账户无关的 7 个公共工具；
  - 个人模式由访客在浏览器填自己的 Token（只存 `sessionStorage`），才能查自己的券和积分。
- **个人权益不外泄**：`calculate-price` 会自动套用 Token 主人的会员权益（实测会返回员工卡折扣和权益余额）。体验模式下服务端只回传原价与商品小计，到手价、折扣名称和余额不离开服务器。
- 同源校验 + 按 IP 限流；公共结果短时缓存，减少对每分钟 600 次限额的占用。
- 腾讯地图 Key 只在服务端（可选 SK 做签名校验）；逆地理编码坐标粗化到约百米，用户坐标不保存。天气走 open-meteo，不需要 Key。

## 业务价值

麦当劳菜单按门店变化，营养数据和价格分散在不同接口，营养表的命名（「可乐中杯」）和菜单命名（「可乐」）也不一致，人工很难同时兼顾热量、蛋白质和价格。轻盘把门店、菜单、营养、算价串成一次调用，并诚实标出估算与缺失，给控制饮食的人一份可以直接到店点单的方案。
