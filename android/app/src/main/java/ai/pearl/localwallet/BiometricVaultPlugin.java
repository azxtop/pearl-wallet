package ai.pearl.localwallet;

import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {
    private static final String ALIAS = "pearl-wallet-biometric-v1";
    private static final String PREFS = "pearl-wallet-biometric";
    private static final String IV = "iv";
    private static final String CIPHERTEXT = "ciphertext";

    private boolean canUseBiometric() {
        return BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    private String walletAddress(PluginCall call) {
        String address = call.getString("address");
        if (address == null || !address.matches("prl1[a-z0-9]{20,120}")) {
            throw new IllegalArgumentException("钱包地址无效");
        }
        return address;
    }

    private String field(String name, String address) {
        return name + ":" + address;
    }

    private boolean legacyWallet(PluginCall call, String address) {
        return address.equals(call.getString("legacyAddress"));
    }

    private boolean enabled(PluginCall call, String address) {
        return preferences().contains(field(CIPHERTEXT, address))
                || (legacyWallet(call, address) && preferences().contains(CIPHERTEXT));
    }

    private String stored(PluginCall call, String name, String address) {
        SharedPreferences prefs = preferences();
        if (prefs.contains(field(CIPHERTEXT, address))) return prefs.getString(field(name, address), null);
        return legacyWallet(call, address) ? prefs.getString(name, null) : null;
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject response = new JSObject();
        response.put("available", canUseBiometric());
        try {
            response.put("enabled", enabled(call, walletAddress(call)));
        } catch (IllegalArgumentException exception) {
            response.put("enabled", false);
        }
        call.resolve(response);
    }

    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("指纹密钥不存在");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            builder.setUserAuthenticationValidityDurationSeconds(-1);
        }
        generator.init(builder.build());
        return generator.generateKey();
    }

    private void prompt(PluginCall call, Cipher cipher, boolean encrypt, String mnemonic) {
        getActivity().runOnUiThread(() -> {
            Executor executor = command -> new Handler(Looper.getMainLooper()).post(command);
            BiometricPrompt biometricPrompt = new BiometricPrompt((FragmentActivity) getActivity(), executor,
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                            call.reject("指纹验证取消或失败");
                        }

                        @Override
                        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                            try {
                                Cipher authorized = result.getCryptoObject().getCipher();
                                if (authorized == null) throw new IllegalStateException("指纹加密操作未授权");
                                JSObject response = new JSObject();
                                if (encrypt) {
                                    byte[] plaintext = mnemonic.getBytes(StandardCharsets.UTF_8);
                                    byte[] encrypted;
                                    try {
                                        encrypted = authorized.doFinal(plaintext);
                                    } finally {
                                        java.util.Arrays.fill(plaintext, (byte) 0);
                                    }
                                    String address = walletAddress(call);
                                    boolean saved = preferences().edit()
                                            .putString(field(IV, address), Base64.encodeToString(authorized.getIV(), Base64.NO_WRAP))
                                            .putString(field(CIPHERTEXT, address), Base64.encodeToString(encrypted, Base64.NO_WRAP))
                                            .commit();
                                    if (!saved) throw new IllegalStateException("指纹数据保存失败");
                                    response.put("enabled", true);
                                } else {
                                    String encoded = stored(call, CIPHERTEXT, walletAddress(call));
                                    if (encoded == null) throw new IllegalStateException("未启用指纹授权");
                                    byte[] plaintext = authorized.doFinal(Base64.decode(encoded, Base64.NO_WRAP));
                                    try {
                                        response.put("mnemonic", new String(plaintext, StandardCharsets.UTF_8));
                                    } finally {
                                        java.util.Arrays.fill(plaintext, (byte) 0);
                                    }
                                }
                                call.resolve(response);
                            } catch (Exception exception) {
                                call.reject("指纹授权数据不可用", exception);
                            }
                        }
                    });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(encrypt ? "启用 Pearl 指纹授权" : "Pearl 钱包授权")
                    .setSubtitle(encrypt ? "验证指纹以保护钱包" : "验证指纹以继续")
                    .setNegativeButtonText("取消")
                    .setConfirmationRequired(true)
                    .build();
            biometricPrompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    @PluginMethod
    public void enable(PluginCall call) {
        String mnemonic = call.getString("mnemonic");
        try { walletAddress(call); } catch (IllegalArgumentException exception) { call.reject(exception.getMessage()); return; }
        if (!canUseBiometric() || mnemonic == null || mnemonic.isEmpty()) {
            call.reject("指纹不可用或钱包数据为空");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            prompt(call, cipher, true, mnemonic);
        } catch (Exception exception) {
            call.reject("无法启用指纹", exception);
        }
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String address;
        try { address = walletAddress(call); } catch (IllegalArgumentException exception) { call.reject(exception.getMessage()); return; }
        if (!enabled(call, address) || !canUseBiometric()) {
            call.reject("指纹未启用或不可用");
            return;
        }
        try {
            String encodedIv = stored(call, IV, address);
            if (encodedIv == null) throw new IllegalStateException("指纹数据损坏");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(encodedIv, Base64.NO_WRAP)));
            prompt(call, cipher, false, null);
        } catch (Exception exception) {
            call.reject("无法使用指纹解锁，请输入钱包密码", exception);
        }
    }

    @PluginMethod
    public void disable(PluginCall call) {
        try {
            String address = walletAddress(call);
            SharedPreferences.Editor edit = preferences().edit()
                    .remove(field(IV, address)).remove(field(CIPHERTEXT, address));
            if (legacyWallet(call, address)) edit.remove(IV).remove(CIPHERTEXT);
            if (!edit.commit()) throw new IllegalStateException("指纹数据删除失败");
            JSObject response = new JSObject();
            response.put("enabled", false);
            call.resolve(response);
        } catch (Exception exception) {
            call.reject("无法关闭指纹授权", exception);
        }
    }
}
