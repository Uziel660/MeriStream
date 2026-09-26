import fs from 'node:fs';
import path from 'node:path';

const stylesPath = path.resolve('android/app/src/main/res/values/styles.xml');
if (!fs.existsSync(stylesPath)) {
  throw new Error(`Capacitor Android styles not found at ${stylesPath}. Run "npx cap add android" first.`);
}

let xml = fs.readFileSync(stylesPath, 'utf8');

const nativeWindowItems = [
  ['android:windowLightStatusBar', 'false'],
  ['android:windowLightNavigationBar', 'false'],
  ['android:statusBarColor', '#050608'],
  ['android:navigationBarColor', '#050608'],
  ['android:windowBackground', '#050608'],
  ['android:windowLayoutInDisplayCutoutMode', 'shortEdges'],
];

function injectIntoStyle(styleName) {
  const startToken = `<style name="${styleName}"`;
  const start = xml.indexOf(startToken);
  if (start < 0) return false;
  const end = xml.indexOf('</style>', start);
  if (end < 0) throw new Error(`Malformed Android style: ${styleName}`);

  let block = xml.slice(start, end);
  for (const [name, value] of nativeWindowItems) {
    if (block.includes(`name="${name}"`)) continue;
    block += `\n        <item name="${name}">${value}</item>`;
  }
  xml = xml.slice(0, start) + block + xml.slice(end);
  return true;
}

if (!injectIntoStyle('AppTheme.NoActionBar')) {
  throw new Error('Could not find AppTheme.NoActionBar in generated Capacitor styles.xml');
}
injectIntoStyle('AppTheme.NoActionBarLaunch');

function setStyleItem(styleName, itemName, value) {
  const startToken = `<style name="${styleName}"`;
  const start = xml.indexOf(startToken);
  if (start < 0) return false;
  const end = xml.indexOf('</style>', start);
  if (end < 0) throw new Error(`Malformed Android style: ${styleName}`);

  let block = xml.slice(start, end);
  const itemToken = `<item name="${itemName}">`;
  const itemStart = block.indexOf(itemToken);
  const nextItem = `<item name="${itemName}">${value}</item>`;
  if (itemStart >= 0) {
    const itemEnd = block.indexOf('</item>', itemStart);
    if (itemEnd < 0) throw new Error(`Malformed Android style item: ${itemName}`);
    block = block.slice(0, itemStart) + nextItem + block.slice(itemEnd + '</item>'.length);
  } else {
    block += `\n        ${nextItem}`;
  }
  xml = xml.slice(0, start) + block + xml.slice(end);
  return true;
}

// Brand the OS-owned launch window as well as the WebView surface.
setStyleItem('AppTheme.NoActionBarLaunch', 'android:background', '@drawable/meristream_splash');
setStyleItem('AppTheme.NoActionBarLaunch', 'windowSplashScreenBackground', '@color/meristream_splash_background');
setStyleItem('AppTheme.NoActionBarLaunch', 'windowSplashScreenAnimatedIcon', '@drawable/meristream_launcher_foreground');
setStyleItem('AppTheme.NoActionBarLaunch', 'postSplashScreenTheme', '@style/AppTheme.NoActionBar');

fs.writeFileSync(stylesPath, xml, 'utf8');
console.log('Patched Capacitor Android window chrome for MeriStream.');

const resRoot = path.resolve('android/app/src/main/res');
const ensureDir = (relative) => fs.mkdirSync(path.join(resRoot, relative), { recursive: true });
for (const dir of ['values', 'drawable', 'mipmap-anydpi', 'mipmap-anydpi-v26']) ensureDir(dir);

const brandColors = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="meristream_splash_background">#050608</color>
    <color name="meristream_launcher_background">#050608</color>
</resources>
`;

const launcherVector = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:pathData="M54,18 A36,36 0,1 1,53.9,18"
        android:fillColor="@android:color/transparent"
        android:strokeColor="#F4B33F"
        android:strokeWidth="7"
        android:strokeLineCap="round" />
    <path
        android:pathData="M48,36 L77,54 L48,72 Z"
        android:fillColor="#F4B33F" />
</vector>
`;

const splashDrawable = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/meristream_splash_background" />
    <item
        android:drawable="@drawable/meristream_launcher_foreground"
        android:gravity="center"
        android:width="108dp"
        android:height="108dp" />
</layer-list>
`;

const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/meristream_launcher_background" />
    <foreground android:drawable="@drawable/meristream_launcher_foreground" />
</adaptive-icon>
`;

fs.writeFileSync(path.join(resRoot, 'values/meristream_brand.xml'), brandColors, 'utf8');
fs.writeFileSync(path.join(resRoot, 'drawable/meristream_launcher_foreground.xml'), launcherVector, 'utf8');
fs.writeFileSync(path.join(resRoot, 'drawable/meristream_splash.xml'), splashDrawable, 'utf8');
fs.writeFileSync(path.join(resRoot, 'mipmap-anydpi/ic_launcher.xml'), launcherVector, 'utf8');
fs.writeFileSync(path.join(resRoot, 'mipmap-anydpi/ic_launcher_round.xml'), launcherVector, 'utf8');
fs.writeFileSync(path.join(resRoot, 'mipmap-anydpi-v26/ic_launcher.xml'), adaptiveIcon, 'utf8');
fs.writeFileSync(path.join(resRoot, 'mipmap-anydpi-v26/ic_launcher_round.xml'), adaptiveIcon, 'utf8');
console.log('Generated MeriStream adaptive launcher icon and native splash.');

function findMainActivity(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const candidate = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findMainActivity(candidate);
      if (nested) return nested;
    } else if (entry.name === 'MainActivity.java') {
      return candidate;
    }
  }
  return null;
}

const activityPath = findMainActivity(path.resolve('android/app/src/main/java'));
if (!activityPath) {
  throw new Error('Could not locate generated Capacitor MainActivity.java');
}

const originalActivity = fs.readFileSync(activityPath, 'utf8');
const packageMatch = originalActivity.match(/^package\s+([^;]+);/m);
if (!packageMatch) {
  throw new Error(`Could not detect Java package in ${activityPath}`);
}
const packageName = packageMatch[1];

const activity = `package ${packageName};

import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsetsController;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AndroidRenderCompatibilityPlugin.class);

        // Enable inspection only for debuggable APKs, before Capacitor creates
        // the WebView. Release builds keep WebView debugging disabled.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        super.onCreate(savedInstanceState);

        // Consume Android Back at the Activity layer first. This keeps the
        // React history contract deterministic even if an optional plugin is
        // unavailable or the WebView reports canGoBack=false.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView == null) {
                    moveTaskToBack(true);
                    return;
                }
                webView.evaluateJavascript(
                    "(function(){try{return !!(window.__meristreamHandleAndroidBack && window.__meristreamHandleAndroidBack());}catch(e){return false;}})()",
                    value -> {
                        if (!"true".equals(value)) {
                            moveTaskToBack(true);
                        }
                    }
                );
            }
        });

        // Keep Android system chrome visually continuous with MeriStream.
        getWindow().setStatusBarColor(Color.rgb(5, 6, 8));
        getWindow().setNavigationBarColor(Color.rgb(5, 6, 8));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                    0,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
        } else {
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }
}
`;

fs.writeFileSync(activityPath, activity, 'utf8');
console.log(`Patched MainActivity: ${path.relative(process.cwd(), activityPath)}`);

const rendererPlugin = `package ${packageName};

import android.os.Build;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AndroidRenderCompatibility")
public class AndroidRenderCompatibilityPlugin extends Plugin {
    @PluginMethod
    public void setMoreMenuOpen(PluginCall call) {
        boolean open = call.getBoolean("open", false);
        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge() != null ? getBridge().getWebView() : null;
            if (webView == null) {
                call.reject("Android WebView is unavailable");
                return;
            }

            boolean useSoftwareLayer = open && Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q;
            webView.setLayerType(useSoftwareLayer ? View.LAYER_TYPE_SOFTWARE : View.LAYER_TYPE_NONE, null);
            String renderMode = useSoftwareLayer ? "software" : "default";
            webView.evaluateJavascript(
                "document.documentElement.dataset.nativePlayerMoreRenderMode='" + renderMode + "'",
                null
            );
            call.resolve();
        });
    }
}
`;

const rendererPluginPath = path.join(path.dirname(activityPath), 'AndroidRenderCompatibilityPlugin.java');
fs.writeFileSync(rendererPluginPath, rendererPlugin, 'utf8');
console.log(`Generated Android renderer compatibility plugin: ${path.relative(process.cwd(), rendererPluginPath)}`);
