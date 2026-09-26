# Hobo Poker Alpha v0.15.0 — host migration

Install HoboPages **1.5.0** first, upload the complete game web ZIP, then reload
all players. This release uses room protocol 3; older game/server builds must be
updated before joining the same room. Existing TURN configuration is unchanged.

## What happens when the host leaves

The server promotes the earliest-joined player who is still connected and has a
seat in the saved game. Players stay in their existing seats. The new host gets
the current deck, hand, board, pot, stacks, bets, pending actions and turn deadline.
The current hand continues; no new deal is required. Later failures repeat the
same process in connection order. Rejoining puts a player at the end of that order.

The server keeps recovery snapshots in memory. Only the active host can save one,
and only its elected successor receives the private recovery data. Other players
continue receiving their usual redacted views. As with the original game, the
active host is trusted with the deck and all cards; this is a friends/play-money
architecture, not a cheating-resistant gambling service.

An orderly leave or closed connection normally triggers a quick handoff. If a
connection silently stops responding, the server waits up to about 45 seconds
since its last message before promoting the next player. The normal action timer
continues across handoff rather than resetting with every reconnect.

## Returning to the table

Use **JOIN ROOM** with the same room key in the **same browser/profile**. A private
browser token identifies your seat; matching a player name alone cannot claim it.
The game keeps your existing chips and cards. If your turn already timed out,
the resulting check/fold remains; rejoining does not undo play.

Disconnected human seats are reserved for **two minutes**. Afterwards a new player
may take the seat when no unsettled hand contributions would be replaced. You can
still reclaim it after two minutes if nobody has taken it. Clearing browser data,
switching browser/profile or using another device loses that automatic identity.
Opening the same room in a second tab with the same identity is rejected while
the original connection remains alive.

Disconnected humans sit out subsequent hands in either mode. If fewer than
two eligible players (connected humans or NPCs) are available, the table waits. Existing voice connections
between remaining players are kept through handoff, with voice signalling moving
to the new host. A returning player must choose Join Voice again.

At least one eligible player must remain connected. If everyone leaves, the room
ends. Snapshots do not survive a Deno server restart, site shutdown or redeployment
that closes the room service. This update handles player-host loss, not server
outages or long-term saved games.
