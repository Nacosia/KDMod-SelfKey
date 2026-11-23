# SelfKey

[English](README.md) · [中文](README.zh-CN.md) · for KinkiestDungeon **5.5.12+**

**Restraints you put on and locked yourself don't consume a key or keycard when you unlock them.** You still need to be carrying at least one matching key — it just doesn't get eaten.

In the vanilla game, every unlock costs a key. SelfKey only removes the cost in the one case where you did the locking yourself; everything else is plain vanilla.

![Name mark, tooltip line and unlock messages in game](docs/game-ui.png)

## What counts as a self-lock

Two things, tracked on the item itself:

1. **You put the restraint on** — from the inventory, the restraint UI, or a bondage spell that equips through the normal path.
2. **You applied the current lock** — the gear's built-in lock, or the "lock" action.

By default both must be true (**Strict AND**). Turn that off and only step 2 matters, which also makes "an enemy dressed me, I locked it" free.

Still costs a key, exactly like vanilla:

- anything an enemy, a trap or a living restraint put on you;
- a lock that an enemy swapped or upgraded onto your gear — your own gear stops being free until you lock it yourself again;
- doors and chests, always;
- `Gold` / `GoldPlus` / `Masterwork` locks — unless you enable *Also exempt Gold / GoldPlus / Masterwork*.

`Cyber` locks are free all the way: no keycard **and** no security build-up.

Unlock difficulty, success rate and the key you can drop on a failed attempt are untouched. SelfKey only decides whether a *successful* unlock consumes one.

## What you'll see

- A short mark in front of a self-locked restraint's name — `※` by default, `〔SB〕` if you prefer — in the inventory, tooltips, equipment list and messages. It only shows up when the free unlock is genuinely in effect, so you can trust it.
- A tooltip line on worn restraints: *Self-lock: unlocking costs no key (still needs at least 1 key)*.
- A counter in the HUD showing how many self-locks you're wearing.
- A message whenever you lock something yourself, and whenever an unlock skips the key.

All four are display only, and each can be switched off on its own.

![Mod configuration page (mark set to 〔SB〕, placed after the name, in this shot)](docs/config.png)

## Settings

`Options → Mod Configuration → SelfKey`. The defaults are what you want; these are the ones worth knowing:

| Setting | Default | What it does |
| --- | --- | --- |
| Enable: self-locked restraints cost no keys | on | Master switch — off restores vanilla key costs. |
| Strict AND (self-worn AND self-locked) | on | Off = only who applied the lock matters. |
| Also exempt Gold / GoldPlus / Masterwork | off | High-end locks stay expensive by default. |

## Install

1. Grab `SelfKey.zip` from [Releases](../../releases).
2. Standalone build: drop the zip into `<game>/Mods/` and start the game. Web build: turn on **Auto Load Mods**, then `Options → Mods → Load Mod .zip`, then reload the page.
3. `Options → Mod Configuration → SelfKey`.

## One gotcha

Restraints you were already wearing when you installed the mod carry no marks, so they still cost keys. Take them off and put them on again once, and they'll behave.
