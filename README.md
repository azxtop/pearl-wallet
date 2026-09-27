# Pearl Wallet 0.2.18

Pearl 主网安卓钱包。Wallet 显示链上余额与交易、收款和转账；SafeTrade 只读展示 PRL/USDT 行情及 PRL、USDT 余额；Setting 管理解锁、指纹、密码、备份和版本。

## 已实现

- 创建或导入 BIP-39 钱包，使用加密随机数生成助记词，并在本机以 PBKDF2-SHA256 与 AES-256-GCM 加密。每个钱包和观察地址可命名，通过 Wallet 页顶部切换、重命名或移除观察地址；升级时保留原有加密钱包和观察地址。
- 进入钱包时自动尝试已启用的指纹；可在 Setting 关闭进入时解锁。每次转账仍需密码或指纹。密码修改、指纹授权和助记词备份各有独立的密码输入。
- Android 原生 HTTP 优先请求 pearlchain.live，读取失败时改用 PearlResearch Blockbook；主浏览器同步时也从 PearlResearch 补充待确认转出。扫描前 20 个派生地址；观察模式只查询所填地址。待确认转入单独标记，待确认 UTXO 不计入可转账余额；钱包首页支持下拉刷新。
- 每个钱包的上次余额和交易记录保存在本机，切换钱包或重启后先显示缓存并同步链上数据。缓存只用于展示，转账须等待新同步完成；离开设置页或切到后台会隐藏已显示的助记词并清空敏感输入。
- 转账广播成功后，在本机保存交易 ID、所花输入和找零金额；浏览器尚未列出 0 确认转出时，Activity 立即显示待确认记录，余额显示估算找零，并阻止复用已广播的输入。浏览器同步完成后以链上数据为准。
- App 前台每 5 秒用主浏览器扫描余额和 UTXO，仅在结果变化时读取交易历史；尝试连接浏览器 SSE，断线后逐步延长重连时间。主浏览器请求失败后暂停 60 秒起，切到备用浏览器并放慢检查，冷却结束后自动重试主浏览器。App 进入手机后台时暂停连接与轮询，返回前台立即同步。
- SafeTrade 页面展示 PRL/USDT 官方 K 线、24 小时行情、左右并排买卖盘和市场最新成交。K 线可切换周期、双指缩放、横向拖动和点选查看单根详情；服务器读取最近 300 根历史数据。公开行情不需要个人 API Key。用户可在 App 输入自己的只读 Key 和 Secret，服务器验证后加密保存，仅向该连接的随机令牌返回 PRL、USDT 余额；可在 App 中断开并撤销令牌。不含下单和提款功能。
- 常规页面允许系统截屏；创建和导入钱包的助记词界面，以及 Setting 中显示助记词时，Android 启用防截屏。SafeTrade 前台每 5 秒更新公开行情，服务器按端点缓存 5–10 秒。
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

APK 位于 `releases/`。`PearlWallet-0.2.18-debug.apk` 可覆盖此前安装的 debug 版；`PearlWallet-0.2.18-release.apk` 使用独立正式签名，不能直接覆盖 debug 版。切换签名前先备份助记词，并确认可恢复钱包。

正式签名材料在 `private/pearlwallet-release.jks` 和 `android/release-signing.properties`，两者已被 `.gitignore` 排除。**必须一起离线备份**；丢失签名密钥后无法为已安装的正式版发布可覆盖更新。

## 公开仓库注意事项

不要提交助记词、交易所 API 凭据、签名密钥、`.env` 文件、数据库或包含真实账户数据的日志。`private/`、`server/data/`、`releases/` 和本机构建产物已被 `.gitignore` 排除。`VITE_*` 环境变量会被打包进客户端，不能存放交易所 API 密钥或令牌。只读 API 凭据经 HTTPS 从 App 发送至服务器后仅保存在服务器，连接令牌保存在 App 本地。

## SafeTrade 服务

本地执行 `npm run server` 前，设置 `PEARL_CREDENTIAL_KEY_FILE` 为一个仅服务进程可读取的文件，内容是随机 32 字节密钥的 Base64 编码；设置 `PEARL_DATA_DIR` 保存 SQLite 数据库。密钥文件丢失后，已保存的 SafeTrade 连接无法解密。默认只监听 `127.0.0.1:8787`。公开 `GET /api/safetrade/overview` 返回价格、盘口和成交，`GET /api/safetrade/candles?interval=1m` 返回指定周期 K 线；原 `GET /api/safetrade?interval=1m` 继续兼容旧版。公开数据在服务端短时缓存并后台刷新，App 会按周期保存公开 K 线，切换时先显示已有数据。`POST /api/safetrade/connection` 验证只读密钥并返回随机令牌；`GET/DELETE /api/safetrade/account` 需要令牌，分别读取 PRL、USDT 余额和撤销连接。

服务端持续订阅 SafeTrade 的公开 WebSocket 行情、盘口增量和成交，按序号维护盘口，并通过 `/api/safetrade/stream` 将增量推送给前台 App。历史 K 线仍通过 REST 获取，当前 K 线由实时成交更新，并定期用 REST 校正。账户余额使用 SafeTrade 私有 WebSocket 事件触发只读 REST 核对；App 先凭连接令牌换取一次性短期票据，再连接 `/api/safetrade/account-stream`。断线时自动重连，REST 定时刷新继续兜底。WebSocket 服务端需通过 Nginx 转发 Upgrade 请求。

新服务器 `104.160.38.45` 使用 `deploy/install-api-runtime.sh` 安装独立的 Node 24 运行环境，以 `deploy/pearlwallet-api.service` 启动服务，只监听 `127.0.0.1:8788`；专用 Nginx 虚拟主机配置见 `deploy/nginx-pearlwallet.conf`。部署时先执行 `nginx -t`，通过后重载。服务端加密密钥位于 `/var/lib/pearlwallet/credential-key`，不上传到仓库。SafeTrade 已放行该服务器 IP，HTTPS 行情、盘口、市场成交和只读账户连接均已实测成功。

## 已知限制

无法保证钱包“100% 安全”。签名测试使用模拟 UTXO，没有广播真实主网转账。链上余额依赖 `pearlchain.live`，失败时依赖 PearlResearch Blockbook，不是本机完整节点验证；前 20 个地址以外的资产目前不会自动发现。观察模式只读，但所查询的地址会发送给当前使用的浏览器。不要在完成实机小额转账与独立安全审计前存入有价值的资产。

## APK 更新

更新检查优先读取 GitHub 仓库的 `server/update.json`，失败时读取现有 HTTPS 服务器。新版 App 优先下载 GitHub Release 的正式签名 APK，失败时下载服务器副本。`apkUrl` 保留服务器地址供 0.2.8 及更早版本升级；`githubApkUrl` 提供新版的首选地址。两份 APK 必须具有相同的 SHA-256。

## 官网

`site/index.html` 是无需构建的静态介绍页，部署在 `https://pearlwallet.az1993.xyz/`。页面的 APK 下载按钮直连 GitHub Release；发布新版本时同步更新页面中的版本号、下载链接及 SHA-256。Nginx 配置只为根路径增加静态页面，保留 `/api/update` 与 `/releases/` 作为 App 更新的备用来源。

## License

Licensed under the [Apache License 2.0](LICENSE).
