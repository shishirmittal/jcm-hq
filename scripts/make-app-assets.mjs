// Builds the source images @capacitor/assets expands into every Android
// density, from the one logo in src/assets.
//
// The logo is a dark disc that fills its whole square. Handed to Android
// as-is it would be cropped: an adaptive icon is masked to a shape the
// launcher chooses (circle, squircle, teardrop) and only the middle 66% is
// guaranteed to survive — the outer ring and "RETAILS" sit outside that. So
// the foreground layer scales the mark down into the safe zone and the
// background layer carries the colour, which is what the format is for.
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const LOGO = 'src/assets/jcm-logo.png'
const OUT = 'assets'

// The app's own surface colours, so the icon and the splash match the screen
// that follows them rather than approximating it.
const LIGHT = '#ffffff'
const DARK = '#101b22'

const bg = hex => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), alpha: 1 })

// The logo centred at `scale` of a `size` square, on `background` (or
// transparent). Rounded to an even number of pixels so the offsets stay whole
// and the mark cannot land half a pixel off centre.
async function compose({ size, scale, background, out }) {
  const canvas = sharp({
    create: {
      width: size, height: size, channels: 4,
      background: background ? bg(background) : { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
  // scale 0 is a plain colour field — the adaptive icon's background layer,
  // which carries no mark at all.
  if (scale > 0) {
    const inner = Math.round(size * scale / 2) * 2
    const logo = await sharp(LOGO).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer()
    canvas.composite([{ input: logo, top: (size - inner) / 2, left: (size - inner) / 2 }])
  }
  await canvas.png().toFile(`${OUT}/${out}`)
  console.log(`${out.padEnd(22)} ${size}x${size}, ${scale > 0 ? `mark at ${Math.round(scale * 100)}%` : 'flat colour'}${background ? ' on ' + background : ' (transparent)'}`)
}

await mkdir(OUT, { recursive: true })

// Legacy square icon, for launchers older than adaptive icons. No mask to
// survive, so the mark can sit larger.
await compose({ size: 1024, scale: 0.80, background: LIGHT, out: 'icon.png' })

// Adaptive icon foreground. capacitor-assets writes an ic_launcher.xml that
// already insets this layer by 16.7%, which is exactly the safe zone — the
// mark is therefore sized against the safe circle, not against the full
// icon. 0.90 leaves a thin white margin inside the mask; anything much less
// and the disc ends up a small dot adrift in white.
await compose({ size: 1024, scale: 0.90, background: null, out: 'icon-foreground.png' })
await compose({ size: 1024, scale: 0, background: LIGHT, out: 'icon-background.png' })

// Splash. 2732 square is the size that still covers the longest phone in
// either orientation after centre-cropping.
await compose({ size: 2732, scale: 0.22, background: LIGHT, out: 'splash.png' })
await compose({ size: 2732, scale: 0.22, background: DARK, out: 'splash-dark.png' })
