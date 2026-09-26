// Web/default bindings.
// Android builds overwrite this file transiently before Vite runs so the
// shared frontend can use native Capacitor plugins without adding them to the
// normal web dependency graph or lockfile.
export const nativeBindingsReady = false;
export const nativeAppBinding: any = null;
export const nativeHapticsBinding: any = null;
export const nativeScreenOrientationBinding: any = null;
export const nativeSystemBarsBinding: any = null;
export const nativeShareBinding: any = null;
export const nativeAndroidRenderCompatibilityBinding: any = null;
