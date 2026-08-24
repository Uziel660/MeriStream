import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nitiflix.app',
  appName: 'Nitiflix',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
    cleartext: true
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
  android: {
    allowMixedContent: true
  }
};

export default config;
