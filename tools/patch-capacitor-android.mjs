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

fs.writeFileSync(stylesPath, xml, 'utf8');
console.log('Patched Capacitor Android window chrome for MeriStream.');

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

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Enable inspection only for debuggable APKs, before Capacitor creates
        // the WebView. Release builds keep WebView debugging disabled.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        super.onCreate(savedInstanceState);

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
