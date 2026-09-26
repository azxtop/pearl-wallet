package ai.pearl.localwallet;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.view.WindowManager;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(UpdateInstallerPlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
