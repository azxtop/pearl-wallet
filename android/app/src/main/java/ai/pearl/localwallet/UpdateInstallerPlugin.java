package ai.pearl.localwallet;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

@CapacitorPlugin(name = "UpdateInstaller")
public class UpdateInstallerPlugin extends Plugin {
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url", "");
        String backupUrl = call.getString("backupUrl", "");
        String expected = call.getString("sha256", "");
        if (!url.matches("https://github\\.com/azxtop/pearl-wallet/releases/download/v[0-9]+\\.[0-9]+\\.[0-9]+/PearlWallet-[0-9]+\\.[0-9]+\\.[0-9]+-release\\.apk")
                || !backupUrl.matches("https://pearlwallet\\.az1993\\.xyz/releases/PearlWallet-[0-9]+\\.[0-9]+\\.[0-9]+-release\\.apk")
                || !expected.matches("(?i)[0-9a-f]{64}")) {
            call.reject("安装包地址无效");
            return;
        }
        new Thread(() -> {
            File apk = new File(getContext().getCacheDir(), "pearl-update.apk");
            try {
                Exception lastError = null;
                for (String candidate : new String[]{url, backupUrl}) {
                    try {
                        downloadAndVerify(apk, candidate, expected, candidate.equals(url));
                        lastError = null;
                        break;
                    } catch (Exception error) {
                        apk.delete();
                        lastError = error;
                    }
                }
                if (lastError != null) throw new Exception("GitHub 与备用服务器下载失败：" + lastError.getMessage());
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                JSObject result = new JSObject();
                result.put("started", true);
                call.resolve(result);
            } catch (Exception error) {
                apk.delete();
                call.reject(error.getMessage() == null ? "安装失败" : error.getMessage());
            }
        }).start();
    }

    private void downloadAndVerify(File apk, String source, String expected, boolean github) throws Exception {
        URL current = new URL(source);
        for (int redirects = 0; redirects <= 5; redirects++) {
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            try {
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(30000);
                connection.setInstanceFollowRedirects(false);
                int status = connection.getResponseCode();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = connection.getHeaderField("Location");
                    if (!github || location == null) throw new Exception("下载跳转无效");
                    URL next = new URL(current, location);
                    if (!"https".equalsIgnoreCase(next.getProtocol())
                            || !("github.com".equalsIgnoreCase(next.getHost())
                            || "release-assets.githubusercontent.com".equalsIgnoreCase(next.getHost()))) {
                        throw new Exception("下载跳转地址无效");
                    }
                    current = next;
                    continue;
                }
                if (status != 200) throw new Exception("HTTP " + status);
                if (connection.getContentLengthLong() > 100_000_000) throw new Exception("安装包过大");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long size = 0;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[32768];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        size += count;
                        if (size > 100_000_000) throw new Exception("安装包过大");
                        digest.update(buffer, 0, count);
                        output.write(buffer, 0, count);
                    }
                }
                StringBuilder hash = new StringBuilder();
                for (byte value : digest.digest()) hash.append(String.format("%02x", value & 0xff));
                if (!hash.toString().equalsIgnoreCase(expected)) throw new Exception("安装包校验失败");
                return;
            } finally {
                connection.disconnect();
            }
        }
        throw new Exception("下载跳转过多");
    }
}
