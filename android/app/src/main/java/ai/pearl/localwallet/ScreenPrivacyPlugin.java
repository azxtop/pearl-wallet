package ai.pearl.localwallet;

import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenPrivacy")
public class ScreenPrivacyPlugin extends Plugin {
    @PluginMethod
    public void setSecure(PluginCall call) {
        Boolean secure = call.getBoolean("secure");
        if (secure == null) {
            call.reject("secure is required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (secure) {
                getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
            call.resolve();
        });
    }
}
