# Status icon source frames

These five 32×32 RGBA frames are the approved smiling `LIVE` mascot generated
with PixelLab. The generator enlarges them to 40×40 with nearest-neighbour
sampling; the firmware renders that generated sprite without interpolation.

Regenerate `firmware/include/status_icon_sprite.h` from the repository root:

```bash
npm run sprite:generate
```

The generator accepts only non-interlaced 8-bit RGBA PNG files with binary
alpha and fails if an opaque pixel collides with the reserved RGB565
transparency key.
