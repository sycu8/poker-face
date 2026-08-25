# Game rules — Texas Hold'em (play money)

Poker Faces runs **private play-money** Texas Hold'em. Virtual chips only. No purchases, cash-out, prizes, rake, wallet, payment, or crypto.

## Cards

- Each player receives **two private hole cards**.
- The board has **five public community cards** (flop 3, turn 1, river 1).
- There is **no dealer hand**.

## Blinds and stacks

- Host sets **small blind** as a positive integer.
- **Big blind is always exactly `2 × smallBlind`** (read-only).
- Starting stacks must be in **`[10, 1000]`** virtual chips.

## Pot-cap wagering

- Default **pot-cap multiplier = 2**.
- For a player's action, let `potBeforeAction` be the pot size before that action (including any bets already in the current betting round that are part of the committed pot state used by the engine).
- The **maximum target wager** for that action is:

```
maxTargetWager = floor(potBeforeAction * potCapMultiplier)
```

- A raise/bet that would leave the player below their stack but above `maxTargetWager` is clamped to `maxTargetWager`, except **all-in** which may exceed the pot-cap when the player's remaining stack is the limiting factor for an all-in shove that is still a legal poker action under standard all-in rules. Implementation: clamp non-all-in bets/raises to the pot-cap; all-in always allowed for remaining chips.
- Exact engine behavior lives in `worker/domain/` and is covered by invariant tests.

## Host configuration changes

- A host config change **during a hand** becomes **pending**.
- Pending config is **atomically promoted only when the next hand starts**.

## Joining mid-hand

- A player who joins during a hand **waits until the next hand** before receiving cards / posting blinds.

## Authority and privacy

- The server (room Durable Object) is the **only authority** for deck order, actions, pots, side pots, winners, chips, timers, and configuration transitions.
- Clients must **never** receive another player's private cards. UI hiding is not sufficient; projections strip foreign hole cards.

## Disconnect / reconnect

- Disconnects must not corrupt a hand.
- Reconnect restores a **private projected snapshot** and ordered event sequence with monotonic `roomSequence`.
