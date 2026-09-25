# Validation — The Last Table v0.6.0 / HoboPages 1.2.0

Completed 25 September 2026.

## Passed

- 26 game tests: poker rules, 1,000 simulated hands with chip conservation, hidden-card snapshots, scene transforms, UI handlers, whitespace/case handling, room-key validation, duplicate/full rooms, key reuse, isolation, signalling direction, cancellation, stale callbacks, disconnect cleanup and ICE validation.
- All 140 bundled character assets parse and contain the expected rig. Required assets are present.
- HoboPages: 86 existing HTTP/deployment/auth assertions and 39 retention/disk/migration assertions; all pass with its pinned Deno 2.1.4 runtime.
- Two new Deno room-service tests pass with resource sanitization (no leaked test timers).
- Real Deno/WebSocket integration passes: published-site routing, independent room namespaces, signalling, rejected foreign origins, visitor passwords, disabled sites and key release.
- Strict TypeScript checks pass for the new annotated JavaScript networking/room-service modules. Deno checks pass for the server and new tests.
- YunoHost shell script syntax checks pass.
- Actual game rendered in headless Chromium at 320×740, 360×740 and 740×360. Dialog boundaries fit all viewports; typed spaces are blocked and pasted whitespace/capitals are normalized. Duplicate-room errors leave the menu intact and restore the controls.
- Browser-to-Deno host/join acknowledgements and WebRTC offer/answer exchange observed with the real game code.

## Limits requiring a live check

A complete two-device WebRTC gameplay session could not be verified here. The sandbox's headless browser produced no ICE candidates (even for local-only tests); the full Chromium process was blocked from creating a required socket. The offer/answer exchange completed, then the client timed out and cleaned up. Unit tests cover data-channel dispatch and lifecycle with test peers, but do not replace live cross-device verification.

No YunoHost instance, live Nginx proxy, Android device, public STUN/TURN relay or live user server was available. The supplied YunoHost upgrade has not been deployed or tested on a real YunoHost runner. Confirm host/join gameplay on two devices after installing both updates; restrictive networks may require TURN credentials.

## Additional fixes found during validation

HoboPages' pinned Deno compiler predates generic typed-array annotations. The streaming functions now use the compatible Uint8Array form. Weak If-None-Match validators now match their equivalent strong tags, avoiding unnecessary file transfers. HEAD responses expose the selected compression encoding. The gzip test inspects raw response headers rather than headers already stripped by fetch's automatic decompression.

The single-field input also handles multi-character insertions containing whitespace (including mobile keyboard replacements) without discarding the entire insertion.
