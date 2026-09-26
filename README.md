# Pearl Wallet 0.2.9

Pearl 主网安卓钱包。Wallet 显示链上余额与交易、收款和转账；SafeTrade 只读展示 PRL/USDT 行情及 PRL、USDT 余额；Setting 管理解锁、指纹、密码、备份和版本。

## 已实现

- 创建或导入 BIP-39 钱包，使用加密随机数生成助记词，并在本机以 PBKDF2-SHA256 与 AES-256-GCM 加密。每个钱包和观察地址可命名，通过 Wallet 页顶部切换、重命名或移除观察地址；升级时保留原有加密钱包和观察地址。
- 进入钱包时自动尝试已启用的指纹；可在 Setting 关闭进入时解锁。每次转账仍需密码或指纹。密码修改、指纹授权和助记词备份各有独立的密码输入。
- Android 原生 HTTP 优先请求 pearlchain.live，读取失败时改用 PearlResearch Blockbook。扫描前 20 个派生地址；观察模式只查询所填地址。待确认转入单独标记，待确认 UTXO 不计入可转账余额；钱包首页支持下拉刷新。
- 每个钱包的上次余额和交易记录保存在本机，切换钱包或重启后先显示缓存并同步链上数据。缓存只用于展示，转账须等待新同步完成；离开设置页或切到后台会隐藏已显示的助记词并清空敏感输入。
- App 前台每 5 秒用主浏览器扫描余额和 UTXO，仅在结果变化时读取交易历史；尝试连接浏览器 SSE，断线后逐步延长重连时间。主浏览器请求失败后暂停 60 秒起，切到备用浏览器并放慢检查，冷却结束后自动重试主浏览器。App 进入手机后台时暂停连接与轮询，返回前台立即同步。
- SafeTrade 服务通过逐笔成交构造 1 分、5 分、15 分、1 小时、4 小时和日线 K 线。服务只读取 PRL/USDT 成交及 PRL、USDT 账户余额，不含交易和提款功能。数据服务只在服务器保存交易所 API 凭据。
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

APK 位于 `releases/`。`PearlWallet-0.2.9-debug.apk` 可覆盖此前安装的 debug 版；`PearlWallet-0.2.9-release.apk` 使用独立正式签名，不能直接覆盖 debug 版。切换签名前先备份助记词，并确认可恢复钱包。

正式签名材料在 `private/pearlwallet-release.jks` 和 `android/release-signing.properties`，两者已被 `.gitignore` 排除。**必须一起离线备份**；丢失签名密钥后无法为已安装的正式版发布可覆盖更新。

## 公开仓库注意事项

不要提交助记词、交易所 API 凭据、签名密钥、`.env` 文件、数据库或包含真实账户数据的日志。`private/`、`server/data/`、`releases/` 和本机构建产物已被 `.gitignore` 排除。`VITE_*` 环境变量会被打包进客户端，不能存放交易所 API 密钥或其他秘密；SafeTrade 凭据只应放在服务器端。

## SafeTrade 服务

本地执行 `npm run server`。默认监听 `127.0.0.1:8787`，从未纳入版本控制的 `private/safetrade.txt` 读取 API 凭据；也可通过 `SAFETRADE_CREDENTIAL_FILE` 指定路径。服务器部署文件位于 `deploy/`，指定独立的 `127.0.0.1:8788` 端口和 `pearlwallet.az1993.xyz` 专用 Nginx 虚拟主机，不改变其他服务的端口与配置。`deploy/.env` 的读取令牌与安卓 APK 内的令牌对应；令牌只保护只读接口，不可替代交易所 API 密钥的权限限制。更新清单在 `server/update.json`。

部署顺序：先用 `deploy/nginx-pearlwallet-http.conf` 申请该域名证书；证书到位后使用 `deploy/nginx-pearlwallet-updates.conf` 单独上线版本检查和 APK 下载，静态文件放在 `/var/www/pearlwallet/api` 与 `/var/www/pearlwallet/releases`。SafeTrade 官方放行服务器 IP 后，确认 8788 空闲、把 `server/data` 及 `private/safetrade.txt` 授权给容器 UID 1000，再启动后端并换成 `deploy/nginx-pearlwallet.conf`。每次先执行 `nginx -t`，通过后才重载。发布 APK 时核对 `server/update.json` 的 SHA-256。

**新服务器已上线版本服务。** `pearlwallet.az1993.xyz` 的 HTTPS、`/api/update` 和正式签名 APK 下载已从外网验证；证书自动续期的模拟运行通过。SafeTrade 官方要求通过工单放行新服务器静态 IP；获批前不启动行情与账户采集，也不会伪造 K 线。

## 已知限制

无法保证钱包“100% 安全”。签名测试使用模拟 UTXO，没有广播真实主网转账。链上余额依赖 `pearlchain.live`，失败时依赖 PearlResearch Blockbook，不是本机完整节点验证；前 20 个地址以外的资产目前不会自动发现。观察模式只读，但所查询的地址会发送给当前使用的浏览器。不要在完成实机小额转账与独立安全审计前存入有价值的资产。

## APK 更新

更新检查优先读取 GitHub 仓库的 `server/update.json`，失败时读取现有 HTTPS 服务器。新版 App 优先下载 GitHub Release 的正式签名 APK，失败时下载服务器副本。`apkUrl` 保留服务器地址供 0.2.8 及更早版本升级；`githubApkUrl` 提供新版的首选地址。两份 APK 必须具有相同的 SHA-256。

## 官网

`site/index.html` 是无需构建的静态介绍页，部署在 `https://pearlwallet.az1993.xyz/`。页面的 APK 下载按钮直连 GitHub Release；发布新版本时同步更新页面中的版本号、下载链接及 SHA-256。Nginx 配置只为根路径增加静态页面，保留 `/api/update` 与 `/releases/` 作为 App 更新的备用来源。

## License

Licensed under the [Apache License 2.0](LICENSE).
