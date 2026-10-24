# Pearl Wallet 0.2.44

**官方网站：** https://pearlwallet.az1993.xyz/ · **Android 下载：** https://github.com/azxtop/pearl-wallet/releases

**PRL 捐赠地址：** `prl1pm2u7jht5vqqw32k5e2m87dpwhavwwrjnd6d7tjtpsv3l8qzzgdds8d449j`

当前支持助记词导入，尚不支持单独私钥导入。应用未经独立安全审计；只需查看余额与交易时，建议使用观察地址。

Pearl 主网安卓钱包。Wallet 显示链上余额与交易、收款和转账；Market 可切换 SafeTrade、Gate PEARL/USDT 现货、以太坊 Uniswap V3 WPRL/USDT、Hyperliquid PRL/USDC 永续、Lighter PRL/USDC 永续与 Aster PEARL/USDT 永续，SafeTrade 还可只读展示 PEARL、USDT 余额；Setting 管理解锁、指纹、密码、备份和版本。

## 已实现

- 创建或导入 BIP-39 钱包，使用加密随机数生成助记词，并在本机以 PBKDF2-SHA256 与 AES-256-GCM 加密。每个钱包和观察地址可命名，通过 Wallet 页顶部切换、重命名或移除。钱包可从切换菜单或 Setting 删除；删除需输入钱包名称与密码，并清理本机加密密钥、指纹凭据和对应缓存。升级时保留原有加密钱包和观察地址。
- 进入钱包时自动尝试已启用的指纹；可在 Setting 关闭进入时解锁。每次转账仍需密码或指纹。密码修改、指纹授权和助记词备份各有独立的密码输入。
- 私钥仅在单次钱包操作期间派生，结束或出错时销毁主密钥、中间派生密钥和签名密钥的私有数据。切换到后台或手动锁定会立即终止钱包 Worker、取消未完成的授权并清空所有助记词及密码输入；返回前台后需重新授权。关闭进入时解锁仅保留公开余额展示，不保留私钥。JavaScript 无法保证字符串及 BigInt 在物理内存中被完全擦除。
- 钱包列表或旧版数据损坏时保留原文并进入恢复页面，可复制加密恢复数据，不会静默覆盖；失效的当前钱包 ID 只重新选择有效条目。修改密码后同步更新同地址的全部钱包条目，核对新数据已保存后清理对应旧版加密副本；已迁移的钱包也会在成功授权后尝试清理对应旧副本。写入失败时保留原数据。
- 签名时在本机计算交易 ID，主节点和备用浏览器的广播返回值必须与其一致。广播返回值并不替代链上确认；网络异常或结果不一致时，请先核对链上记录再重试转账。
- 正式版和测试版均关闭 Capacitor 桥接日志，避免插件参数中的敏感内容进入系统日志。测试版仍具有调试权限，存币请使用正式签名版。
- Android 原生 HTTP 优先请求 pearlchain.live，读取失败时改用 PearlResearch Blockbook；主浏览器同步时也从 PearlResearch 补充待确认转出。扫描前 20 个派生地址；观察模式只查询所填地址。待确认转入单独标记，待确认 UTXO 不计入可转账余额；钱包首页支持下拉刷新。
- 每个钱包的上次余额和交易记录保存在本机，切换钱包或重启后先显示缓存并同步链上数据。缓存只用于展示，转账须等待新同步完成；离开设置页或切到后台会隐藏已显示的助记词并清空敏感输入。
- 转账广播成功后，在本机保存交易 ID、所花输入和找零金额；浏览器尚未列出 0 确认转出时，Activity 立即显示待确认记录，余额显示估算找零，并阻止复用已广播的输入。浏览器同步完成后以链上数据为准。
- 发送页显示钱包余额、按当前费率计算的最多可发送金额、25%/50%/75%/MAX 快捷金额与经济/标准/优先三档费率。费率分别为 1/2/4 grains/vB，预览按所选费率构造交易并显示实际估算手续费；确认速度不保证。
- App 前台每 5 秒用主浏览器扫描余额和 UTXO，仅在结果变化时读取交易历史；尝试连接浏览器 SSE，断线后逐步延长重连时间。主浏览器请求失败后暂停 60 秒起，切到备用浏览器并放慢检查，冷却结束后自动重试主浏览器。App 进入手机后台时暂停连接与轮询，返回前台立即同步。
- Market 页面可切换 SafeTrade、Gate PEARL/USDT 现货、以太坊 Uniswap V3 WPRL/USDT、Hyperliquid PRL/USDC 永续、Lighter PRL/USDC 永续与 Aster PEARL/USDT 永续。SafeTrade 展示 K 线、24 小时行情、左右并排买卖盘和最新成交；WPRL 展示指定链上交易池的 K 线、流动性和成交；永续来源展示公开 K 线、盘口、成交、标记价、资金费率和持仓量。K 线可切换周期、双指缩放、横向拖动和点选查看单根详情；服务器返回最近 300 根。公开行情不需要个人 API Key。用户可在 App 输入自己的 SafeTrade 只读 Key 和 Secret，服务器验证后加密保存，仅向该连接的随机令牌返回 PEARL、USDT 余额。用户可在 SafeTrade K 线设置中选择显示个人成交标记、买卖加权均价和单根 K 线的成交详情；历史成交由服务器加密保存，断开连接时删除。App 不含下单和提款功能。
- SafeTrade 现货资产的主数字包含可用余额和挂单占用，另显示两者明细与按 PEARL/USDT 现货价计算的预估总资产（USDT）。
- 常规页面允许系统截屏；创建和导入钱包的助记词界面，以及 Setting 中显示助记词时，Android 启用防截屏。SafeTrade 前台每 5 秒更新公开行情，服务器按端点缓存 5–10 秒；WPRL 前台接收链上成交推送，并定时核对公开行情。
- 检查 HTTPS 版本清单、下载并校验 APK 的 SHA-256，再交给 Android 安装。更新 APK 必须与已安装应用使用同一签名密钥。

## 构建

需要 Node.js 24、JDK 21、Android SDK 36。SDK 和 JDK 只在构建电脑上使用，安装 APK 的手机不需要。

```powershell
npm ci
npm test
npm run android:sync
cd android
./gradlew.bat assembleDebug assembleRelease
```

APK 位于 `releases/`。`PearlWallet-0.2.44-debug.apk` 可覆盖此前安装的 debug 版；`PearlWallet-0.2.44-release.apk` 使用独立正式签名，不能直接覆盖 debug 版。切换签名前先备份助记词，并确认可恢复钱包。

正式签名材料在 `private/pearlwallet-release.jks` 和 `android/release-signing.properties`，两者已被 `.gitignore` 排除。**必须一起离线备份**；丢失签名密钥后无法为已安装的正式版发布可覆盖更新。

## 公开仓库注意事项

不要提交助记词、交易所 API 凭据、签名密钥、`.env` 文件、数据库或包含真实账户数据的日志。`private/`、`server/data/`、`releases/` 和本机构建产物已被 `.gitignore` 排除。`VITE_*` 环境变量会被打包进客户端，不能存放交易所 API 密钥或令牌。只读 API 凭据经 HTTPS 从 App 发送至服务器后仅保存在服务器，连接令牌保存在 App 本地。

## SafeTrade 服务

本地执行 `npm run server` 前，设置 `PEARL_CREDENTIAL_KEY_FILE` 为一个仅服务进程可读取的文件，内容是随机 32 字节密钥的 Base64 编码；设置 `PEARL_DATA_DIR` 保存 SQLite 数据库。密钥文件丢失后，已保存的 SafeTrade 连接无法解密。默认只监听 `127.0.0.1:8787`。公开 `GET /api/safetrade/overview` 返回价格、盘口和成交，`GET /api/safetrade/candles?interval=1m` 返回指定周期 K 线；原 `GET /api/safetrade?interval=1m` 继续兼容旧版。公开数据在服务端短时缓存并后台刷新，App 会按周期保存公开 K 线，切换时先显示已有数据。`POST /api/safetrade/connection` 验证只读密钥并返回随机令牌；`GET/DELETE /api/safetrade/account` 需要令牌，分别读取 PEARL、USDT 余额（为兼容旧版 App，响应中的 PEARL 暂用 PRL 字段）和撤销连接。`GET /api/safetrade/personal-trades` 需要令牌，首次从 SafeTrade 拉取近 165 天的旧 PRL/USDT 与新 PEARL/USDT 个人成交，此后增量同步；成交记录在服务端 SQLite 中加密保存，断开连接时删除。

服务端持续订阅 SafeTrade 的公开 WebSocket 行情、盘口增量和成交，按序号维护盘口，并通过 `/api/safetrade/stream` 将增量推送给前台 App。历史 K 线仍通过 REST 获取，当前 K 线由实时成交更新，并定期用 REST 校正。账户余额使用 SafeTrade 私有 WebSocket 事件触发只读 REST 核对；App 先凭连接令牌换取一次性短期票据，再连接 `/api/safetrade/account-stream`。断线时自动重连，REST 定时刷新继续兜底。WebSocket 服务端需通过 Nginx 转发 Upgrade 请求。

新服务器 `104.160.38.45` 使用 `deploy/install-api-runtime.sh` 安装独立的 Node 24 运行环境，以 `deploy/pearlwallet-api.service` 启动服务，只监听 `127.0.0.1:8788`；专用 Nginx 虚拟主机配置见 `deploy/nginx-pearlwallet.conf`。部署时先执行 `nginx -t`，通过后重载。服务端加密密钥位于 `/var/lib/pearlwallet/credential-key`，不上传到仓库。SafeTrade 已放行该服务器 IP，HTTPS 行情、盘口、市场成交和只读账户连接均已实测成功。

WPRL 行情使用以太坊主网 Uniswap V3 的 WPRL/USDT 交易池 `0x89a67c6dee35db9815da2fb9191f0998a8b37c39`。服务首次启用时把当前区块的下一个区块设为永久采集起点，不补起点之前的成交。Infura WebSocket 实时接收 `Swap` 日志，RPC 每 15 秒按持久化区块进度补漏并复查最近 20 个区块。服务端在 `/var/lib/pearlwallet/wprl-market.sqlite` 的 WAL SQLite 中保存成交、扫描进度和 1 分钟 K 线：成交保留 30 天，1 分钟 K 线长期保存；5 分钟至日线从分钟线生成。没有成交而已扫描的分钟按前收盘价显示零成交量，未扫描到的区间不会被当作零成交。短链重组通过复查重算受影响的分钟线。超过完整 24 小时的 24h 指标来自本地记录；此前概览和历史参考 K 线使用 GeckoTerminal，历史 K 线不会导入本地正式记录。参考 K 线的美元成交量按收盘价换算为近似 WPRL 数量，正式记录的数量来自链上 Swap。`GET /api/wprl/overview`、`GET /api/wprl/candles?interval=1m` 与 `/api/wprl/stream` 分别提供概览、K 线和推送。运行时设置 `WPRL_ENABLED=1`、`PEARL_INFURA_KEYS_DB` 指向仅服务账号可读的 SQLite 文件；文件须含 `infura_keys(api_key, available)` 表。RPC Key 只保存在服务器，绝不可提交仓库或放进 `VITE_*` 变量。WPRL 与 PRL 是不同资产，图表和成交分别按来源缓存。

Hyperliquid 只读行情默认使用 EntropyIO 的 HIP-3 `io:PRL` 永续合约，抵押与计价币为 USDC，在 App 显示为 PRL/USDC。服务端用一条上游 WebSocket 订阅 1 分钟 K 线、L2 盘口、成交和资产上下文，再通过 `/api/hyperliquid/stream` 分发给 Market 前台；`/api/hyperliquid/overview`、`/api/hyperliquid/candles?interval=1m` 提供 REST 兜底。服务端先从官方 `candleSnapshot` 补最近最多 5000 根 1 分钟 K 线，此后通过实时推送与每两分钟补漏，在 `/var/lib/pearlwallet/hyperliquid-market.sqlite` 长期保存分钟线并汇总为 5 分钟至日线。供应商只能补最近约 5000 根，长时间停机超出此窗口会留下可见的时间缺口。默认逐笔转发成交；Hyperliquid 页达到 100 个连接或出站行情持续超过 5 Mbps 一分钟时，每秒只向客户端发送最新最多 10 笔并标明跳过数量；连接低于 60 且低于 2 Mbps 持续五分钟后恢复逐笔。慢客户端单独降采样。原 BTC 示例 K 线与新 PRL K 线按合约标识分别存储；服务端可用 `HYPERLIQUID_COIN` 和 `HYPERLIQUID_DEX` 修改订阅市场。

Gate 现货源使用 `PEARL_USDT` 公开行情，不需要 API Key。服务端通过一条 Gate WebSocket 订阅行情、成交、六种周期 K 线和盘口增量；盘口使用自带初始快照的 V2 400 档推送，发现序号缺口后重新订阅，REST 只作断线兜底。`/api/gate/overview`、`/api/gate/candles?interval=1m`、`/api/gate/depth`、`/api/gate/trades` 提供概览、K 线、完整盘口和可筛选的公开成交；`/api/gate/stream`、`/api/gate/depth-stream` 提供推送。K 线在 `gate-pearl-market.sqlite` 长期保存，公开成交沿用服务器 30 天保存策略；App 分源缓存并预取各周期。设置 `GATE_ENABLED=0` 可关闭采集。

## 已知限制

无法保证钱包“100% 安全”。签名测试使用模拟 UTXO，没有广播真实主网转账。链上余额依赖 `pearlchain.live`，失败时依赖 PearlResearch Blockbook，不是本机完整节点验证；前 20 个地址以外的资产目前不会自动发现。观察模式只读，但所查询的地址会发送给当前使用的浏览器。不要在完成实机小额转账与独立安全审计前存入有价值的资产。

## APK 更新

原生 App 离开 Wallet 并进入 Market 或 Setting 后才自动检查更新；Wallet 中不发起自动检查，也不展示更新弹窗。检查失败静默重试，正常检查间隔 6 小时。提示框提供“稍后”和“立即更新”，同一版本暂缓 24 小时；只有用户主动点击更新才下载安装包。设置页仍可手动检查更新。

更新检查优先读取 GitHub 仓库的 `server/update.json`，失败时读取现有 HTTPS 服务器。新版 App 优先下载 GitHub Release 的正式签名 APK，失败时下载服务器副本。`apkUrl` 保留服务器地址供 0.2.8 及更早版本升级；`githubApkUrl` 提供新版的首选地址。两份 APK 必须具有相同的 SHA-256。

## 官网

`site/index.html` 是无需构建的静态介绍页，部署在 `https://pearlwallet.az1993.xyz/`。页面的 APK 下载按钮直连 GitHub Release；发布新版本时同步更新页面中的版本号、下载链接及 SHA-256。Nginx 配置只为根路径增加静态页面，保留 `/api/update` 与 `/releases/` 作为 App 更新的备用来源。

## License

Licensed under the [Apache License 2.0](LICENSE).
