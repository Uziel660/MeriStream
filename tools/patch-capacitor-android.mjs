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
