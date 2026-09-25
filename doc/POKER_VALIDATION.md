# Validation — The Last Table v0.7.0 / HoboPages 1.3.0

Completed 25 September 2026.

## Passed

- 28 game tests: poker rules, 1,000 bot hands, hidden-card snapshots, UI, whitespace/case handling, scene transforms, room limits/isolation, relay direction, authenticated sender IDs, host acceptance, cancellation, stale callbacks, backpressure cleanup and upgrade compatibility.
- Six-player look traffic simulation: five guests each send 80 updates, rebroadcast to all five guests, without exceeding relay limits. Guests cannot send state snapshots or relay directly to other guests.
- HoboPages pinned Deno 2.1.4: 86 HTTP/deployment/auth assertions, 39 retention/disk/migration assertions, and two room-service tests pass.
- Real Deno integration: published-site rooms, relayed private messages, namespaces, foreign-origin rejection, visitor passwords, access changes and disabled sites.
- Full game in two independent Chromium browser contexts through the real Deno server: create, case-insensitive duplicate rejection, join, private card snapshots, guest action reflected in both players, host departure and room-key reuse. No uncaught browser errors.
- Room dialog fits 320×740, 360×740 and 740×360. Typed spaces are blocked; pasted whitespace is removed.
- Strict TypeScript checks pass for networking/room-service JavaScript; Deno server checks and YunoHost shell syntax checks pass.
- The 140 character assets were validated in the preceding release and are unchanged.

## Remaining deployment checks

This update has not been deployed to your live server. No physical Android device or actual YunoHost/Nginx deployment was available. Install both packages, reload both devices, and verify a live session. Tests used local HTTP/WebSockets; production uses HTTPS/WSS through your existing proxy.

The host still owns the game and must remain connected. Server restarts close rooms. The server now forwards gameplay, including each player's individually addressed card snapshot. No WebRTC or TURN service is used.
