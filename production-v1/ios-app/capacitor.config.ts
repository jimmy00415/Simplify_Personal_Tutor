import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.simplify.hongkongbuddy',
  appName: 'Hong Kong Buddy',
  webDir: '../public',
  server: {
    androidScheme: 'https',
    hostname: 'hkbuddy-v1-api-582852715831.asia-east2.run.app',
  },
};

export default config;
