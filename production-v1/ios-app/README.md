# Hong Kong Buddy iOS shell

Windows cannot generate a usable Xcode project. On hosted macOS with Xcode 26:

```bash
cd production-v1/ios-app
npm ci
npx cap add ios
npx cap sync ios
```

Copy `Info.plist.tpl` microphone string and `PrivacyInfo.xcprivacy` into the generated App target. Do not commit signing certificates or App Store Connect API keys.

`server.url` stays unset so the UI is bundled. API calls use the production `V1_PUBLIC_ORIGIN`.

Voice remains off for App Store until both Safari and TestFlight evidence files are bound. Text chat must still work.
