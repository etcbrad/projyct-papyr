# XPPen Note Plus BLE bridge

This daemon scans for an XPPen Note Plus, connects over GATT, subscribes to every characteristic advertising the `notify` property, and translates hover/contact movement into macOS pointer input.

## Run

```sh
npm install
npm start
```

On macOS, grant the terminal/Node process Bluetooth and Accessibility permissions in System Settings. Keep the notepad awake and nearby. The Note Plus stream uses 8-byte records with little-endian X/Y and pressure fields.

## Automatic startup on macOS

The installed LaunchAgent starts the bridge at login and keeps it running:

```sh
launchctl print gui/$(id -u)/com.bradley.xppen-note-plus-bridge
tail -f ~/Library/Logs/xppen-note-plus-bridge.log
```

It scans automatically, so no manual activation is needed. Quit the official XPPen Note Plus app before using this daemon because the notepad generally permits one active BLE connection. The current sensitivity is `0.1`; override it with `XPPEN_SENSITIVITY`. Smoothing can be tuned with `XPPEN_SMOOTHING` (default `0.35`). Full packet logging is opt-in with `XPPEN_DEBUG=1`.

Open the local adjustment toolbox at [http://127.0.0.1:8765](http://127.0.0.1:8765) while the daemon is running.

The fixed reference drawing surface is available at [http://127.0.0.1:8765/art-test](http://127.0.0.1:8765/art-test). It is a full-window white canvas with black strokes, clear/export controls, and a stable title used for automatic art-mode detection.

Normal apps use hover/contact as pointer movement, taps as clicks, double-taps as double-clicks, and triple-taps to toggle drag mode. Recognized art apps automatically use contact movement for drawing. The bridge also checks the frontmost Chrome window title, so Paintz tabs are recognized as art mode. Add or override app names with `XPPEN_ART_APPS`, a comma-separated list.
