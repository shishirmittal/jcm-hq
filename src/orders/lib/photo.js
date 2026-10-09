// The LR photo straight from the phone camera is 3–8 MB; the server accepts
// at most about 4 MB per request. Shrink it to 1600 px on the long side as a
// JPEG (an LR receipt stays readable), stepping down further if still large.
// Returns a data URL ("data:image/jpeg;base64,…").
const MAX_CHARS = 3.6 * 1024 * 1024 // base64 of ~2.7 MB

export async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise((ok, bad) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => bad(new Error('This file is not a photo the browser can open.'))
      i.src = url
    })
    // Browsers turn the picture upright from the camera's EXIF note when drawing it.
    for (const [side, quality] of [[1600, 0.8], [1280, 0.7], [1024, 0.6]]) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      const data = canvas.toDataURL('image/jpeg', quality)
      if (data.length <= MAX_CHARS) return data
    }
    throw new Error('The photo is too large. Take it again.')
  } finally {
    URL.revokeObjectURL(url)
  }
}
