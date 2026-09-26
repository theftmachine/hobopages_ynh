# Hobo Poker Alpha v0.15.0 — spatial voice

## Install

1. Upgrade HoboPages using the included `hobopages_ynh-1.5.0.tar.gz` package.
2. Upload the complete `Hobo-Poker-web-v0.15.0.zip` to your game site.
3. Reload the game on every device. The menu and HUD must show Alpha v0.15.0.
4. Create or join a multiplayer room, press JOIN VOICE, then allow the microphone.
   Each friend joins voice separately. Voice is off until they choose to join.

This game version requires HoboPages 1.5.0 for room protocol 3 and host recovery. The Node development server also supports voice.

## Controls and behavior

- Voices originate at each character's head. Turning the in-game camera changes
  their position in your headphones. Ordinary headphones do not physically track
  your head. Distance falloff is gentle so the opposite seat stays audible.
- MUTE MIC stops transmitting microphone audio; you can still hear friends.
- VOICE opens individual volume sliders and mute buttons.
- A green glow beside a name indicates detected speech. Your microphone button
  also lights while you speak. A muted microphone does not light the indicator.
- LEAVE VOICE stops capture and closes voice connections. Leaving the table or
  losing the host does the same. Closing the voice controls keeps voice active.
- If the browser suspends audio, open VOICE and tap RESUME AUDIO.
- Table-sound mute is separate from voice mute. No voice recording is built in.

Use HTTPS (localhost is allowed for development). Use headphones to avoid echo.
Microphone permission can be changed in your browser's site settings. Mobile
browsers may interrupt voice when backgrounded or when a phone call takes over;
return to the game and resume audio or leave/rejoin voice if needed.

## TURN relay for friends on different networks

The game uses a six-person WebRTC mesh. Deno forwards authenticated connection
messages through the host; it does not process or mix microphone audio. Each
listener spatializes the separate incoming streams locally.

The default configuration uses Google's public STUN endpoint. STUN assists
direct connections but is not an audio relay. Some mobile carriers, firewalls
and Wi-Fi networks require TURN. This release includes TURN configuration
support, **not a provisioned TURN service or working relay credentials**.

Use your own TURN service or a managed provider. It must accept browser WebRTC
clients; TCP/TLS (commonly port 443) is useful for restrictive networks. Supply
its real URLs, username and credential to HoboPages using this environment
variable (one line of JSON):

```text
HOBOPAGES_VOICE_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":["turn:YOUR_RELAY:3478?transport=udp","turn:YOUR_RELAY:3478?transport=tcp","turns:YOUR_RELAY:443?transport=tcp"],"username":"YOUR_USERNAME","credential":"YOUR_TURN_CREDENTIAL"}]
```

Include only URLs and ports actually offered by your relay. This is an example,
not a functioning endpoint. `[]` is valid for local-only development tests.
The server validates the configuration at startup. Malformed JSON or missing
TURN credentials must be fixed before it can start.

For YunoHost, use a persistent systemd override so package upgrades do not
replace the setting:

1. Put the environment-variable line in `/etc/hobopages-voice.env`, readable only
   by root (`chmod 600 /etc/hobopages-voice.env`).
2. Run `systemctl edit hobopages` (substitute your actual app/service name) and add:

```ini
[Service]
EnvironmentFile=/etc/hobopages-voice.env
```

3. Run `systemctl daemon-reload` and `systemctl restart hobopages`.

For the Node development server, set the same variable before `npm start`.
All newly joined room members receive this ICE configuration automatically;
there is no need to paste credentials on every phone.

TURN client credentials are necessarily visible to room participants. Use a
restricted relay account with suitable traffic limits; never place a provider's
administrative API key or TURN shared signing secret here. The current integration
accepts RTCIceServer username/credential pairs; it does not fetch or refresh
short-lived credentials from a provider API automatically.

## Troubleshooting

- Voice disabled: upgrade the server and reload all players.
- Permission denied: allow microphone access in browser site settings and retry.
- One friend cannot hear/connect: leave/rejoin voice; check TURN configuration if
  it only fails between different networks. Poker continues even if voice fails.
- Echo: wear headphones. Echo cancellation and noise suppression are requested
  where the browser supports them.
- Local test success does not verify your public TURN deployment. After adding
  a relay, test with one phone on mobile data and another device on Wi-Fi.
