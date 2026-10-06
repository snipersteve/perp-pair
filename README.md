# Perp Pair

独立的 Aster 永续 ↔ Binance USDT-M 永续交易程序。**不依赖 taoli-auto / asbn 的代码、构建产物、SDK、数据库、钱包或进程。** Node.js >=22.16（建议22 LTS），TypeScript，SQLite，原生网页管理台。

## 当前部署（2026-10-03）
按用户要求迁至东京 `43.133.181.195`，复用 `/root/deploy/shared/exchanges.env` 的 Aster / 币安凭证（只读引用，不复制、不改原文件）。代码 `/root/perp-pair-code`，状态/配置 `/root/deploy/perp-pair`，独立 systemd `perp-pair`；Node22路径固定。legalava实例已停止并禁用自启，旧数据保留，不能双开。

显式 `SHARED_ACCOUNT_MODE=true` + `SHARED_SYMBOLS=龙虾USDT`：只核对/操作受管合约；其他策略仓位、挂单、资金费不纳入本程序账本。总账户可用保证金仍按真实余额限制。每次首腿检查 `SHARED_FOREIGN_PAIR_FILES` 内该合约全部为 stop；外部文件缺失也阻断。默认仍只允许人工探针。`SHARED_AUTOTRADE_ENABLED=true` 时，必须有 `SHARED_RESERVATION_FILE` 中 Aster/币安两条 owner=perp-pair、enabled=true 登记，并将该合约从所有外部 pair 名单撤出（stop 也不允许保留）；恢复、每个交易tick、首腿前及对账都检查。任何登记撤销/配置重现/文件不可读都阻断新首腿。**这是配置独占加冲突检测，不是旧程序也参与的原子交易锁**；禁止其它程序/人工使用受管合约或绕过登记，不能保证有人同时改配置并下单时完全无竞态。账户刷新默认15秒且单飞，挂单查询按受管symbol发起，避免共享账户全量高权重查询。限流仅进程内共享Circuit；实际418/429（包括HTML响应）另触发配置的 `RATE_LIMIT_STOP_HOOK`，东京hook停止已知同机PM2交易/API消费者，不自动恢复。旧程序先遇限流仍须立即协调停手；并非跨程序统一请求调度器。

早期核验服务保持 observe，临时探针用 `MODE=live LIVE_TRADING=true` 覆盖，不把常驻服务切live。探针 timeInForce 默认读取部署的 ASTER_FIRST_TIF，可通过 `--tif FOK|IOC` 显式指定，测试接口与真实单使用相同选择。探针新增 `--mode account`（只读核验）与 `--mode close --confirm-real-orders`（仅平本账本多A空B）。不能通过修改DATA_DIR绕过历史订单/持仓。

实测：龙虾两所空仓；Aster可用仅0.00384381U，无法做成交测试。Aster `/fapi/v3/order/test` 以 LIMIT+FOK+RESULT 返回400/-1115 `Invalid timeInForce.`。这证明测试端点拒绝该参数，不冒充真实下单端点的完整验证；当时没有发真实订单、没有自行划转资金或改用IOC。

14:33用户明确授权改IOC：东京 `ASTER_FIRST_TIF=IOC`、`ASTER_FOK_VERIFIED=false`。相同测试端点以 LIMIT+IOC+RESULT 返回成功（空订单字段为测试回执，不是成交）。Aster可用仍0.00384381U，故没有发真实订单。首腿零成交不下币安单，部分成交按真实量对冲；若低于币安最小名义/精度，则尝试撤回差额，不擅自扩大对冲量。订单未知仍先查单。45项测试通过，服务保持暂停观察，充值不会自动启动。

14:40 IOC实测约10U完整开平仓：211枚，两腿数量一致，最终空仓。首腿139–154ms、币安246–249ms，只有两笔执行，不声称p95。用户授权1000U上限自动运行；初始主方向longA；2026-10-03 16:20按用户要求改为shortA（空Aster、多币安为开仓方向，反向为平仓），切换时双腿空仓、无未知订单，暂停后经管理API修改并恢复实盘。两所当时均4小时结算，Aster费率高于币安，偏向shortA收净资金费；这是人工方向设置，不会随未来费率反转自动换向。单笔50U、单边累计1000U，开/平净阈值0.55%/-0.05%（费率0.05%+0.05%、缓冲0.15%，对应毛0.80%/0.20%）。calc统计脚本 `scripts/peer-lobster.py`：8人最新可辨认快照12,629笔，买A毛价差中位1.003%，卖A0.284%；大部分为10月2日成交，无逐行时间戳与开/平标记，不是今天报价分布或保证收益。原BSC stop配置经pair_set备份撤出并记noAuto，其他币不变。新程序所有重启仍须人工resume；仓位上限按新增订单最坏盘口名义检查，已有仓位随市价升值可超过名义上限，不因此自动强平。告警复用共享engine.env的提醒bot，不开启其polling。

访问：`ssh -N -L 3321:127.0.0.1:3321 root@43.133.181.195`，网页 http://127.0.0.1:3321；admin 密码在东京部署 .env。下面 legalava 部署方法为历史独立账户部署说明，不是当前运行位置。

## 当前安全边界

默认 `MODE=observe`：只订阅真实行情，不发私有交易请求，不生成模拟利润。每次启动都暂停；自动实盘需要独立账户，或上节显式启用且通过归属核验的共享账户专属合约模式。没有凭证时仍可使用 UI、配置 stop 币、观察两边深度。

**Aster FOK 尚未完成私有接口/真实成交核验。** 当前公开 exchangeInfo 未列 FOK。严格 FOK 是默认模式，除非 metadata 明示支持或操作员完成独立核验后设置 `ASTER_FOK_VERIFIED=true`，否则拒绝激活。兼容币安签名字段/请求结构不代表所有订单语义相同。提供独立探针，不会因为测试接口不存在就自动发真实订单。IOC 只有显式设置 `ASTER_FIRST_TIF=IOC` 才启用。

这是可构建、可部署的首版。模拟适配器故障测试与只读线上检查**不是实盘验收**；上线前需完成下方核验。不要把估计手续费口径当交易所审计净收益。

## 启动

```bash
npm ci
cp .env.example .env
npm run check
npm test
# UI冒烟：本机需 Chromium，可用 npx playwright install chromium 安装
npm run test:ui
npm run build
npm start
# http://127.0.0.1:3321
```

默认带一个 stop 状态的龙虾 pair。UI：交易对、运行/只减仓/停止、双向净价差、双边深度、资金费、仓位、执行耗时、收益、事件、恢复查询和熔断解除。没有链上/现货配置。

访问带密码的管理台：HTTP Basic 用户名 `admin`，密码取 `ADMIN_PASSWORD`。公网必须使用 HTTPS 反向代理；默认仅回环监听，未修改现有 legalava/Caddy 配置。API 修改请求还需要页面给出的 CSRF token。前端不接触交易所凭证。

## 策略与状态机

1. 两所 WS 前20档盘口，检查本地接收年龄、校正服务器时间后的事件年龄、双边时间差；断线立即清缓存。
2. 按双边深度 × DEPTH_TRUST 计算共同数量；共同步长取 LCM，不用简单 max；拒绝自动映射1000倍合约。
3. Aster 最深可成交价按 tick 保守取整作为触发基准，Binance 盘口 VWAP 作为预估价格。信号净价差 = 毛价差 − 两边配置费率 − 执行缓冲。`ASTER_IOC_SLIPPAGE_PCT` 默认0，东京2026-10-03按用户要求启用0.1：仅自动策略首腿 IOC（开仓/平仓）在基准限价上买入加0.1%、卖出减0.1%，向内取整不超过容差；FOK、人工探针及独立撤回滑点不变。开/平触发阈值不变，不因让价再抬高信号线；让价会消耗原0.15%执行缓冲，不代表保证成交或保证利润。单笔/单币/总额度及保证金预算按含让价的保守名义金额检查。订单候选记录同时保留基准价、实际限价、触发价差和限价下估算价差，后者币安腿仍为盘口预估，非实际成交收益。
4. 先 Aster FOK（或明确启用的 IOC）。意图先落 SQLite FULL/WAL；同一 clientOrderId 不重发 POST。
5. 确认首腿终态后，按实际成交数量立即下 Binance MARKET；不查成交明细/手续费、不重新等信号。
6. 币安确定只成交部分/被拒：用 Aster 反向 IOC 撤回差额，检查新鲜深度、允许滑点、最坏美元损失。开仓撤回 reduceOnly；平仓撤回重开原仓。
7. 任一订单未知：先查询相同 clientOrderId，查不到不能当没成交；禁止贸然撤回造成反向裸露。查不清、撤不掉则暂停熔断、告警，保留真实账本。

两边持仓同时加/减，平仓单双边 reduceOnly，不能翻向开新仓。已有持仓时反向信号先平仓；没有同账户同币多个 pair 的仓位竞争。全局仅一个执行泳道，确保额度与保证金不重复占用；不是为数百币同时执行设计的高并发版本。

### 成交 Telegram 推送

`TRADE_TELEGRAM_ENABLED` 默认 false；东京按用户要求开启。日常成交读取 `SHARED_NOTIFY_FILE` 的 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`，可用 `TG_TRADE_BOT_TOKEN` / `TG_TRADE_CHAT_ID` 显式覆盖；风险告警仍用原提醒 Bot，不开启任何 polling。启用但无凭证时拒绝启动，日志与 API 不暴露 Token。

只有双腿实际成交完成对冲才推送（开仓、平仓、IOC部分成交均支持），在成交落账及对账尝试后异步发送，不阻挡对冲或下一次交易。内容为方向、计划/实际数量、两边成交均价与名义金额、实际成交毛价差（不是利润）、两腿耗时、成交后账本仓位、北京时间和唯一流水号。对账触发熔断时消息明确提示暂停。零成交不发日常消息；拒单、撤回、未知订单沿用风险告警，不能当正常成交成功播报。

发送超时5秒，检查 HTTP 和 Telegram `ok`；失败只记日志，不改变成交状态、不熔断交易。退出会等待已发起的通知。当前为尽力推送：不自动重试或补发历史成交，避免网络回执未知造成重复；进程崩溃仍可能漏通知，可按流水查账，不声称 exactly-once 送达。

### 收益

逐笔已确认成交更新两个独立的签名数量/平均成本账本：平仓实现盈亏、剩余仓位按标记价估值。策略净值估算 = 已实现 + 浮盈亏 + 自程序建立后的资金费 − 预估成交费。进场价差不是已经落袋利润。

资金费独立账户口径，每分钟按时间窗口补录去重；非USDT与满页异常不静默跳过。手续费按部署 taker 费率估算，含撤回费用，**尚未做逐 fill 手续费审计/手续费币折算回写**。UI 明示估算。

日亏损熔断按北京时间日期、当日首次采样的策略净值为基线（首日从启动采样开始，不回溯部署前盈亏），包含持仓浮盈亏。触发只暂停，不自动强平。资金费过滤保守计算两边下一次不利结算成本，不把不同时刻的收款提前抵扣。

### 风控与恢复

- 单向持仓、低杠杆全仓；默认专属账户，共享模式须用户明确授权并通过上节专属合约校验，凭证只读引用。检测外来仓位、手动交易漂移、活动挂单即阻断。
- 默认每15秒后台刷新账户/对账（ACCOUNT_POLL_MS），执行期间不并发巡检；每次成交后再次对账，下次首腿必须有新鲜对账。
- 双边保证金余量闸、单笔/单币/总仓位硬顶、日亏损闸、盘口/资金费数据闸。
- 429/418 全进程两所一起退避，截止时间持久化；不同程序须使用隔离IP或另做跨进程共享限流。
- 重启不自动交易：先恢复已持久化订单、只读对账。未知结果未解决不能解除熔断。
- 恢复按钮只查单，不盲目补单；人工解除也必须对账通过。持仓漂移/外部手工平仓不能一键抹账：需逐笔核对交易所历史修复，禁止删数据库掩盖。
- `pause` / pair `stop` 都不是平仓；已成交的后续对冲/撤回不因暂停中断。退出 drain 最长30秒，systemd TimeoutStopSec=40。
- 撤回预算是盘口估算与IOC保护，不保证交易所一定成交；超预算会保留单腿并要求人工处置。必须有人接收告警。
- 首版未提供 ADL 排名自动减仓、交易所间自动划转、自动强平策略。即使名义对冲，两所保证金也不能互相抵扣，应主动留足资金。

## 独立 FOK 核验

探针与服务共用数据目录互斥锁；先停服务，使用同一 DATA_DIR，不能绕锁另建目录在同账户试单。观察 metadata 无需密钥：

```bash
node dist/probe.js --mode metadata --symbol 龙虾USDT
```

私有核验需在安全 shell 注入独立账户环境（`MODE=live LIVE_TRADING=true DEDICATED_ACCOUNTS_CONFIRMED=true` 等），先检查没有本程序之外的仓位与挂单。探针不修改服务环境，不自动写入 FOK_VERIFIED。

```bash
# 仅测试订单API：即使404/不支持，也不会自动切到真实订单
node dist/probe.js --mode validate --symbol 龙虾USDT --max-usd 10

# 真实不成交探针：买价在买一下方1%；价格突变仍可能成交！
node dist/probe.js --mode no-fill --symbol 龙虾USDT --max-usd 10 --confirm-real-orders

# 真实可成交探针；成交即币安市价对冲，留下有账本的对冲仓位
node dist/probe.js --mode fill --symbol 龙虾USDT --max-usd 10 --confirm-real-orders
```

真实探针硬顶20U，数量还受部署单笔上限约束；低于交易所最小名义则拒绝，不会放大到超预算。fill 模式完成后仓位不自动平掉；通过同一程序 reduce 模式退出或人工核对处理。探针会保留拒绝原因与错误码。必须区分参数拒绝（REJECTED）与合法零成交（EXPIRED），不能把一次没有成交当作FOK核验成功。

核验顺序：测试接口 → 零成交终态 → 全量成交与币安对冲 → 完整往返 → 断网/超时恢复。记录 p50/p95/p99（样本足够后），再允许严格 FOK 实盘。正常对冲路径不额外查询手续费；确认耗时包含签名、网络、撮合、回执和本地入账，不等于交易所内撮合时间。

## 部署到 legalava 服务器

目标 `root@43.163.244.44`，Node22 已安装。代码独立 `/opt/perp-pair/releases/<版本>`，软链 `current`；状态 `/var/lib/perp-pair`，配置 `/etc/perp-pair.env`。独立 systemd 用户与进程，不改 legalava 网站。

```bash
bash scripts/deploy.sh root@43.163.244.44
bash scripts/tunnel.sh root@43.163.244.44
# 浏览器 http://127.0.0.1:3321，admin + 服务器环境文件中的密码
```

部署脚本 npm ci/check/test/build 后同步独立 release，只读观察模式可自动启动。发现现有配置 MODE=live 时只上传新版本，**不切换、不重启**。生产升级应先管理台 pause、等 busy=false、正常停止服务后再切换 current 并启动；重启仍默认暂停。

```bash
ssh root@43.163.244.44 'systemctl status perp-pair --no-pager'
ssh root@43.163.244.44 'journalctl -u perp-pair -n 80 --no-pager'
```

服务器环境文件不要直接 source 不可信内容；systemd EnvironmentFile 读取。Ed25519 私钥可放 `/etc/perp-pair/`，属组 perp-pair、权限640，禁止放网页目录。API key 必须无提现权限、绑定新服务器IP。Node内置SQLite，避免跨机原生模块ABI问题。

## 目录

```
src/config.ts            集中env与pair校验
src/exchanges/           Aster v3 / Binance签名、HTTP、行情、回执
src/math.ts              数量步长、深度、仓位PnL纯函数
src/strategy.ts          双边深度与信号
src/engine.ts            执行、残差、恢复、对账、风控
src/store.ts             SQLite意图/成交/仓位/资金费
src/server.ts            有认证/CSRF的管理API
src/probe.ts             显式FOK验证工具
web/                     独立静态管理台
tests/                   无真实订单的自动化测试
deploy/ scripts/         systemd、独立部署、SSH隧道
```
