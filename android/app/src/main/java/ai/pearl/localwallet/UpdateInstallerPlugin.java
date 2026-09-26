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
        String expected = call.getString("sha256", "");
        if (!url.startsWith("https://pearlwallet.az1993.xyz/releases/") || !expected.matches("(?i)[0-9a-f]{64}")) {
            call.reject("安装包地址无效");
            return;
        }
        new Thread(() -> {
            File apk = new File(getContext().getCacheDir(), "pearl-update.apk");
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(30000);
                connection.setInstanceFollowRedirects(false);
                if (connection.getResponseCode() != 200) throw new Exception("下载失败：HTTP " + connection.getResponseCode());
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
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }
}
