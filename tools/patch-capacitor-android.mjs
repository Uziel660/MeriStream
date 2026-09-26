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
