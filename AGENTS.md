# Perp Pair
所有回复默认中文。独立双合约项目，不依赖或修改 taoli-auto / asbn。
- 默认观察模式，任何实盘开关/凭证变更必须明确授权。2026-10-03用户授权东京复用共享Aster/币安账号；只通过SHARED_EXCHANGES_FILE读取原凭证，不复制密钥。
- 代码缺省FOK；2026-10-03用户明确授权东京部署 ASTER_FIRST_TIF=IOC，按首腿真实成交量对冲。FOK未声明时必须先核验，禁止未经授权隐式切换订单语义。
- 首腿确认真实成交后立即币安MARKET；手续费查询不能挡对冲路径。
- 每个订单意图先落库；结果未知先查询相同clientOrderId，绝不盲重发POST或把超时当零成交。
- 不同模式共用账本/锁，不能为绕过未解决订单而换DATA_DIR。
- 默认独立账户；共享模式默认仅人工探针。2026-10-03用户授权龙虾1000U自动运行：SHARED_AUTOTRADE_ENABLED须配双所专属登记、外部pair名单完全撤出（stop也不保留）、tick/首腿/对账冲突检查。原BSC龙虾stop配置已备份撤出，不许在旧程序重新登记/启用。禁止同币共享净仓；这不是双程序原子锁，不能让其它程序或人工抢该合约。实际418/429触发RATE_LIMIT_STOP_HOOK协调同机停手，不自动恢复其它引擎。
- 修改需 npm run check && npm test && npm run build。测试不得真实下单。
- 当前东京43.133.181.195：/root/perp-pair-code、/root/deploy/perp-pair/{.env,data}、systemd perp-pair，Node22绝对路径；不改taoli-auto代码/进程。legalava旧实例已停用，禁止同时开启。
- 维护README限制说明；不把单元测试/观察数据声称为实盘验证。
