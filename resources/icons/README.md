# U-Claw Application Icons

This directory contains the application icons for all supported platforms.

## Two sources, everything else generated

Only two files here are hand-authored. Editing any of the others is a mistake —
the next `pnpm icons` overwrites it.

| File | Role |
|------|------|
| `icon-uclaw.png` | **Brand master**, 1024x1024 RGBA. Source for every app icon. |
| `tray-icon-template.svg` | **macOS status-bar mark**, hand-drawn for 22px. |

| Generated file | Platform | Description |
|------|----------|-------------|
| `icon.icns` | macOS | app bundle + dmg |
| `icon.ico` | Windows | app, tray, NSIS installer, rcedit exe patch |
| `icon.png` | All | 512x512 Electron root icon / tray fallback |
| `16x16.png` - `512x512.png` | Linux | PNG set; the 32x32 is also the Windows tray icon |
| `tray-icon-Template.png` | macOS | 22x22 status bar (the "Template" suffix is required) |
| `tray-icon-Template@2x.png` | macOS | 44x44 retina status bar |

`icon.svg` is upstream's leftover source — the 🦞 emoji rendered as text. It is
**not** the brand and nothing generates from it any more.

### Why the tray mark is a separate source

The master's carapace is a solid fill. Every automatic reduction of it —
threshold, silhouette, crop-to-subject — collapses into an unreadable blob at
menu-bar size, so the tray mark is drawn as an outline instead. macOS also
requires templates to be pure `#000000` on transparent; the generator asserts
this and fails rather than shipping an icon that ignores dark mode.

## Generating Icons

```bash
pnpm icons          # regenerate every derived file from the two sources
pnpm icons:check    # verify they still match, write nothing (exit 1 on drift)
```

Only `sharp` is required — no ImageMagick, no librsvg install, no png2icons.
`pnpm icons:check` is the guard worth wiring into CI: it catches a derived icon
that was hand-edited, or a merge that restored upstream's lobster.

## Design Guidelines

See `uclaw-design-philosophy.md` for the brand intent.

### Application Icon (`icon-uclaw.png`)
- **Subject**: blue prawn, side profile, with the U-disk connector at the tail
- **Corner Radius**: ~20% of width (200px on a 1024px canvas)
- **Safe Area**: keep a 10% margin from the edges
- **Canvas**: square, at least 1024x1024, RGBA (the generator enforces this)

### macOS Tray Icon (`tray-icon-template.svg`)
- **Format**: pure black (#000000) on transparent — no gradients, no colour
- **Size**: 22x22 viewBox; the generator emits 1x and 2x
- **Naming**: output must end in `Template.png` for automatic template mode
- **Design**: outlined, not filled — a solid shape is illegible at 22px

## Updating the Icon

1. Replace `icon-uclaw.png` (app icon) or edit `tray-icon-template.svg` (tray)
2. Run `pnpm icons`
3. Check the result at small sizes, not just at 512px
4. Commit the two sources **and** every generated file
