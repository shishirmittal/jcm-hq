import { useLayoutEffect, useState } from 'react'

// The designs are fixed-size screens (TV 1920 × 1080, tablet 1280 × 800). On
// any other screen the whole page is scaled to fit, keeping its proportions.
export function useFit(W, H) {
  const calc = () => {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H)
    return { s, x: (window.innerWidth - W * s) / 2, y: (window.innerHeight - H * s) / 2 }
  }
  const [fit, setFit] = useState(calc)
  useLayoutEffect(() => {
    const on = () => setFit(calc())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return fit
}

export const fitStyle = fit => ({ transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.s})` })
