# surgenode_images

Keeps your ox_inventory item images on the SurgeNode image CDN. Drop a PNG into
`ox_inventory/web/images` like you always have and it's live for players within a minute or so,
no inventory restart needed.

You need a SurgeNode Images subscription for this to do anything. Grab one from the
[client area](https://billing.surgenode.net), then manage everything at
[images.surgenode.net](https://images.surgenode.net).

## Install

1. Download the latest release and put the `surgenode_images` folder in your resources.
2. Add it to server.cfg below ox_inventory:

   ```cfg
   ensure ox_inventory
   ensure surgenode_images
   ```

3. Start the server. The console prints a link with a code, something like
   `images.surgenode.net/link/ABCD-EFGH`. Open it, sign in and confirm.

The first sync uploads the whole folder, which can take a few minutes if you have thousands of
images. Once it's verified, the resource points `inventory:imagepath` at the CDN by itself. If
you already set that convar to something else, it'll leave yours alone and say so in the console.

Works on Windows and Linux, any host. You need an FXServer build from roughly the last year,
older ones don't have `fetch` in the JS runtime and the resource will just sit idle.

## Smaller downloads (optional)

Once the images are on the CDN, players don't need them inside ox_inventory anymore. Turn this
on and the resource removes each image from `web/images` after the CDN confirms it has the exact
same file:

```cfg
add_filesystem_permission surgenode_images write ox_inventory
set surgenode_images_prune true
ensure surgenode_images
```

Every removed file gets copied to `surgenode_images/backup/images` first. Stock ox_inventory goes
from about 4 MB to under 1 MB; big custom item packs save a lot more. Players see the smaller
download after ox_inventory's next restart.

It won't remove anything while `inventory:imagepath` points somewhere other than the CDN, and it
skips files changed in the last two minutes in case they're still being copied in.

If you want everything back, run `snimages restore` in the server console. That copies the
backups into `web/images` and pauses pruning until you run `snimages prune resume`.

When you update ox_inventory later, keep the `backup` folder.

## Console

```
snimages status          what it's doing, last sync, pruning, backup size
snimages sync            sync now instead of waiting
snimages relink          print a new link code (e.g. to move to another workspace)
snimages restore         put backed up images back and pause pruning
snimages prune resume    turn pruning back on after a restore
```

## Convars

| convar | default | |
|---|---|---|
| `surgenode_images_prune` | `false` | remove synced images from ox_inventory, see above |
| `surgenode_images_autoconvar` | `true` | set `inventory:imagepath` for you |
| `surgenode_images_resource` | `ox_inventory` | if your inventory resource has a different name |
| `surgenode_images_token` | | a sync token, if you'd rather not use the link code |

Use `set` for the token, not `setr`. `setr` sends it to every player.

## Image names

Name images exactly like the item, ox_inventory is case sensitive: `WEAPON_PISTOL.png` for
`WEAPON_PISTOL`. Letters, numbers, `_`, `.` and `-` only. Anything else is skipped with a warning
in the console. `.PNG` gets saved as `.png`.

Items that use `client.image` in `data/items.lua` or `data/weapons.lua` are picked up too, so the
coverage page on the site knows `mastercard` uses `card_bank.png`.

## Problems

Link code expired: restart the resource or run `snimages relink`.

"blocked by the FiveM sandbox": the `add_filesystem_permission` line is missing, or it's below
`ensure surgenode_images`.

Icons show up blank: check the item coverage page on the site. It lists items with no image and
catches near misses like `Bandage.png` vs `bandage`.

Anything else, open a ticket at [billing.surgenode.net](https://billing.surgenode.net) or ask in
our Discord.
