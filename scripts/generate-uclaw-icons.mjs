#!/usr/bin/env node
/**
 * U-Claw brand icon generator.
 *
 * Two hand-authored sources, everything else derived and never hand-edited:
 *
 *   icon-uclaw.png          1024x1024  the brand master
 *     ├── icon.png            512x512  Electron root icon / tray fallback
 *     ├── {16..512}x{}.png             Linux icon set + Windows tray (32x32)
 *     ├── icon.ico                     Windows app + tray + NSIS + rcedit patch
 *     └── icon.icns                    macOS app bundle + dmg
 *
 *   tray-icon-template.svg       22x22  the macOS status-bar mark
 *     ├── tray-icon-Template.png       1x
 *     └── tray-icon-Template@2x.png    2x (retina menu bars)
 *
 * The tray mark is a separate source on purpose: the master is a solid-filled
 * carapace, and every automatic reduction of it — threshold, silhouette, crop —
 * turns into an unreadable blob at 22px. See that SVG's own comment.
 *
 * Why this exists instead of `pnpm icons` (scripts/generate-icons.mjs): that
 * script's source is `icon.svg`, which upstream ships as the 🦞 emoji rendered
 * as text, so regenerating from it silently restores OpenClaw's lobster over the
 * U-Claw brand. This script also drops the png2icons dependency (sharp alone)
 * and can verify instead of overwrite.
 *
 * Usage:
 *   node scripts/generate-uclaw-icons.mjs            # write derived icons
 *   node scripts/generate-uclaw-icons.mjs --check    # verify, write nothing
 *   node scripts/generate-uclaw-icons.mjs --json     # machine-readable result
 *   node scripts/generate-uclaw-icons.mjs --master <png>
 *
 * Exit codes: 0 ok · 1 drift (--check) or generation failure · 2 bad usage
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = path.join(ROOT, 'resources', 'icons');
const DEFAULT_MASTER = path.join(ICONS_DIR, 'icon-uclaw.png');

/** Linux PNG set, also the source of the 32x32 Windows tray icon. */
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512];

/**
 * Windows .ico members.
 *
 * Sizes at or below ICO_BMP_MAX are embedded as uncompressed BMP/DIB, larger
 * ones as PNG. This split is deliberate: a PNG-only .ico renders fine in the
 * modern shell and in Electron, but the legacy GDI+ path still in use by parts
 * of Windows (and by .NET's System.Drawing, which throws outright on the 128px
 * entry) mis-decodes PNG members. Since this icon ships to customers through
 * NSIS, rcedit, the shell and the tray, it uses the format every one of them
 * has always understood.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICO_BMP_MAX = 64;

/**
 * macOS .icns members: [OSType, pixel size].
 * Only the PNG-payload types — the legacy is32/il32 raw+mask pairs are not
 * needed by any macOS version we ship to (10.13+).
 */
const ICNS_MEMBERS = [
  ['ic11', 32], // 16pt @2x
  ['ic12', 64], // 32pt @2x
  ['ic07', 128], // 128pt @1x
  ['ic13', 256], // 128pt @2x
  ['ic08', 256], // 256pt @1x
  ['ic14', 512], // 256pt @2x
  ['ic09', 512], // 512pt @1x
  ['ic10', 1024], // 512pt @2x
];

/** macOS status-bar icon: hand-authored source, rasterised at 1x and 2x. */
const TRAY_SVG = path.join(ICONS_DIR, 'tray-icon-template.svg');
const TRAY_SIZE = 22;

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const checkOnly = args.includes('--check');
const masterIdx = args.indexOf('--master');
if (masterIdx !== -1 && !args[masterIdx + 1]) {
  process.stderr.write('--master requires a path\n');
  process.exit(2);
}
const masterPath = masterIdx === -1 ? DEFAULT_MASTER : path.resolve(args[masterIdx + 1]);

const log = (msg) => {
  if (!wantJson) process.stderr.write(`${msg}\n`);
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Resize the master to `size`, contain-fit on transparent, as PNG bytes. */
function pngAt(master, size) {
  return sharp(master)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * One uncompressed BMP/DIB .ico member: BITMAPINFOHEADER + 32bpp BGRA pixels +
 * a 1bpp AND mask.
 *
 * Three details that silently produce a corrupt icon if missed:
 *   - biHeight is doubled, because the DIB covers both the colour bitmap and
 *     the mask that follows it;
 *   - rows are bottom-up, so the source image is written back to front;
 *   - the AND mask must be present and its rows padded to 4 bytes even though
 *     it stays all-zero — 32bpp icons get their transparency from the alpha
 *     channel, but a missing mask still makes the entry unreadable.
 */
async function bmpMember(master, size) {
  const { data } = await sharp(master)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: colour + mask
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      pixels[d] = data[s + 2]; // B
      pixels[d + 1] = data[s + 1]; // G
      pixels[d + 2] = data[s]; // R
      pixels[d + 3] = data[s + 3]; // A
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size, 0);

  header.writeUInt32LE(pixels.length + mask.length, 20); // biSizeImage
  return Buffer.concat([header, pixels, mask]);
}

/**
 * Windows ICO: 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per member,
 * then the payloads. Width/height of 256 are encoded as 0.
 */
function buildIco(members) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(members.length, 4);

  const entries = [];
  let offset = 6 + members.length * 16;
  for (const { size, data } of members) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette colours
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...members.map((m) => m.data)]);
}

/**
 * Apple ICNS: 'icns' magic + total length, then TypeLength-prefixed chunks.
 * Chunk length counts its own 8-byte header.
 */
function buildIcns(members) {
  const chunks = members.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/**
 * macOS status-bar template, rasterised from the hand-authored SVG.
 *
 * `scale` is the retina factor: macOS picks tray-icon-Template.png for 1x and
 * tray-icon-Template@2x.png for 2x. Density is raised with the scale so librsvg
 * renders at the target resolution instead of upscaling a 22px bitmap.
 *
 * The result is asserted to be pure black — macOS only tints an image as a
 * template if every pixel's colour is black, and a stray coloured pixel makes
 * the whole icon render as-is, breaking dark mode. Cheaper to fail here than to
 * notice on a customer's Mac.
 */
async function buildTrayTemplate(scale) {
  const px = TRAY_SIZE * scale;
  const svg = await readFile(TRAY_SVG);
  const raster = await sharp(svg, { density: 72 * scale })
    .resize(px, px, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const { data, info } = await sharp(raster).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.height; i++) {
    const s = i * 4;
    if (data[s] || data[s + 1] || data[s + 2]) {
      throw new Error(
        `tray-icon-template.svg produced a non-black pixel at index ${i} ` +
          `(rgb ${data[s]},${data[s + 1]},${data[s + 2]}) — macOS templates must be pure #000000`,
      );
    }
  }

  return raster;
}

async function main() {
  if (!existsSync(masterPath)) {
    throw new Error(
      `U-Claw master icon not found: ${masterPath}\n` +
        'This file is the brand source of truth and must be committed.',
    );
  }

  if (!existsSync(TRAY_SVG)) {
    throw new Error(
      `tray icon source not found: ${TRAY_SVG}\n` +
        'This file is hand-authored and must be committed.',
    );
  }

  const master = await readFile(masterPath);
  const meta = await sharp(master).metadata();
  if (meta.width !== meta.height) {
    throw new Error(`master must be square, got ${meta.width}x${meta.height}`);
  }
  if (meta.width < 1024) {
    throw new Error(`master must be at least 1024x1024, got ${meta.width}x${meta.width}`);
  }
  log(`master ${path.relative(ROOT, masterPath)} ${meta.width}x${meta.height} (${sha256(master).slice(0, 12)})`);

  /** @type {Map<number, Buffer>} */
  const scaled = new Map();
  for (const size of new Set([...PNG_SIZES, ...ICO_SIZES, ...ICNS_MEMBERS.map(([, s]) => s)])) {
    scaled.set(size, await pngAt(master, size));
  }

  /** @type {Array<{ file: string, data: Buffer }>} */
  const artifacts = [];
  for (const size of PNG_SIZES) {
    artifacts.push({ file: `${size}x${size}.png`, data: scaled.get(size) });
  }
  artifacts.push({ file: 'icon.png', data: scaled.get(512) });
  const icoMembers = [];
  for (const size of ICO_SIZES) {
    icoMembers.push({
      size,
      data: size <= ICO_BMP_MAX ? await bmpMember(master, size) : scaled.get(size),
    });
  }
  artifacts.push({ file: 'icon.ico', data: buildIco(icoMembers) });
  artifacts.push({
    file: 'icon.icns',
    data: buildIcns(ICNS_MEMBERS.map(([type, size]) => ({ type, data: scaled.get(size) }))),
  });
  artifacts.push({ file: 'tray-icon-Template.png', data: await buildTrayTemplate(1) });
  artifacts.push({ file: 'tray-icon-Template@2x.png', data: await buildTrayTemplate(2) });

  const results = [];
  for (const { file, data } of artifacts) {
    const target = path.join(ICONS_DIR, file);
    const existing = existsSync(target) ? await readFile(target) : null;
    const matches = existing !== null && existing.equals(data);

    if (checkOnly) {
      results.push({
        file,
        bytes: data.length,
        sha256: sha256(data),
        status: matches ? 'ok' : existing === null ? 'missing' : 'drifted',
      });
      continue;
    }

    if (!matches) await writeFile(target, data);
    results.push({
      file,
      bytes: data.length,
      sha256: sha256(data),
      status: matches ? 'unchanged' : existing === null ? 'created' : 'updated',
    });
  }

  const bad = results.filter((r) => r.status === 'drifted' || r.status === 'missing');
  const ok = bad.length === 0;

  if (wantJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: checkOnly ? ok : true,
          mode: checkOnly ? 'check' : 'write',
          master: path.relative(ROOT, masterPath).replaceAll('\\', '/'),
          masterSha256: sha256(master),
          artifacts: results,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const r of results) log(`  ${r.status.padEnd(9)} ${r.file} (${r.bytes} B)`);
    if (checkOnly) {
      log(ok ? '\nicons match the U-Claw master.' : `\n${bad.length} icon(s) no longer derive from the U-Claw master.`);
    } else {
      log('\nicons regenerated from the U-Claw master.');
    }
  }

  process.exit(checkOnly && !ok ? 1 : 0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (wantJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`icon generation failed: ${message}\n`);
  }
  process.exit(1);
});
