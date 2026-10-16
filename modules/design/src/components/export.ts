/**
 * Browser-side export helpers shared by the Design tools: save text / blobs
 * as files and rasterise an SVG string to PNG — all local, nothing uploaded.
 */

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadText(text: string, filename: string, type = 'text/plain') {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename)
}

/** Intrinsic size of an SVG string from its width/height or viewBox. */
function svgSize(svg: string): { w: number; h: number } {
  const vb = /viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg)
  const w = /<svg[^>]*\swidth="([\d.]+)(px)?"/.exec(svg)
  const h = /<svg[^>]*\sheight="([\d.]+)(px)?"/.exec(svg)
  if (w && h) return { w: Number(w[1]), h: Number(h[1]) }
  if (vb) return { w: Number(vb[3]), h: Number(vb[4]) }
  return { w: 1200, h: 800 }
}

/** Rasterise an SVG to a PNG blob at `scale`, on an optional background. */
export async function svgToPng(
  svg: string,
  { scale = 2, background = '#ffffff' }: { scale?: number; background?: string | null } = {},
): Promise<Blob> {
  const { w, h } = svgSize(svg)
  // Pin explicit pixel dimensions so the <img> has an intrinsic size.
  const sized = svg.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, '').replace(/max-width:[^;"]*;?/g, '')
    return `<svg${cleaned} width="${w}" height="${h}">`
  })
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`
  const img = new Image()
  img.decoding = 'async'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('The SVG could not be rasterised.'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available.')
  if (background) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png')
    } catch (e) {
      reject(
        new Error(
          e instanceof Error && e.name === 'SecurityError'
            ? 'This diagram uses HTML labels the browser will not rasterise — export SVG instead.'
            : String(e),
        ),
      )
    }
  })
}

/** Copy text; resolves false when the clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Read a user-picked local file as text. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return resolve(null)
      resolve({ name: f.name, text: await f.text() })
    }
    input.click()
  })
}
