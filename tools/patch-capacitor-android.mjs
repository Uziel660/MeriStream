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

const patchedMain = injectIntoStyle('AppTheme.NoActionBar');
injectIntoStyle('AppTheme.NoActionBarLaunch');

if (!patchedMain) {
  throw new Error('Could not find AppTheme.NoActionBar in generated Capacitor styles.xml');
}

fs.writeFileSync(stylesPath, xml, 'utf8');
console.log('Patched Capacitor Android window chrome for MeriStream.');


const activityPath = path.resolve('android/app/src/main/java/me/merith/meristream/MainActivity.java');
if (!fs.existsSync(activityPath)) {
  throw new Error(`Capacitor Android MainActivity not found at ${activityPath}`);
}

let activity = fs.readFileSync(activityPath, 'utf8');
if (!activity.includes('WebView.setWebContentsDebuggingEnabled')) {
  activity = activity
    .replace(
      'import com.getcapacitor.BridgeActivity;',
      `import com.getcapacitor.BridgeActivity;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebView;`,
    )
    .replace(
      'public class MainActivity extends BridgeActivity {}',
      `public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
      WebView.setWebContentsDebuggingEnabled(true);
    }
  }
}`,
    );
}

if (!activity.includes('WebView.setWebContentsDebuggingEnabled')) {
  throw new Error('Could not patch MainActivity for debug-only WebView inspection');
}

fs.writeFileSync(activityPath, activity, 'utf8');
console.log('Enabled Android WebView inspection for debuggable builds only.');


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

const mainActivityPath = findMainActivity(path.resolve('android/app/src/main/java'));
if (!mainActivityPath) {
  throw new Error('Could not locate generated Capacitor MainActivity.java');
}

let java = fs.readFileSync(mainActivityPath, 'utf8');
if (!java.includes('setWebContentsDebuggingEnabled')) {
  const packageMatch = java.match(/^package\s+([^;]+);/m);
  if (!packageMatch) throw new Error(\`Could not detect Java package in \${mainActivityPath}\`);
  const packageName = packageMatch[1];

  java = \`package \${packageName};

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
        // Expose the installed debug APK's WebView before Capacitor creates it,
        // enabling deterministic DOM/media assertions from CI. Release APKs
        // remain non-debuggable and never execute this branch.
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
\`;
  fs.writeFileSync(mainActivityPath, java, 'utf8');
}
console.log(\`Patched MainActivity: \${path.relative(process.cwd(), mainActivityPath)}\`);
