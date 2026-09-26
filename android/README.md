# Android app

This is a native Android WebView shell around a local copy of the game. It
opens directly in landscape and immersive full screen, with no browser address
bar. Sandbox mode is bundled; online multiplayer needs internet for PeerJS.

Open this `android` folder in Android Studio and build **Build > Build APK(s)**.
The project uses Android Gradle Plugin 8.6.1, compile SDK 35, and requires
JDK 17. The generated debug APK is under `app/build/outputs/apk/debug/`.

When changing the game, copy the current `index.html`, `style.css`, `game.js`,
manifest, service worker and icons into `app/src/main/assets/www/` before
building a fresh APK.
