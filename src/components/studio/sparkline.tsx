'use client'
/**
 * NEXUS PCB — Sparkline SVG (courbe de convergence de l'agent RL)
 */
export function Sparkline({ data, width = 300, height = 56 }: { data: number[]; width?: number; height?: number }) {
  if (data.length < 2) {
    return (
      <div className="flex h-[56px] items-center justify-center text-[10px] text-neutral-600">
        courbe disponible après optimisation
      </div>
    )
  }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = Math.max(max - min, 1e-6)
  const step = width / (data.length - 1)
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(height - 4 - ((v - min) / range) * (height - 8)).toFixed(1)}`)
  const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Évolution du coût">
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#10b981" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark)" />
      <polyline points={pts.join(' ')} fill="none" stroke="#10b981" strokeWidth="1.6" strokeLinejoin="round" />
      <text x="4" y="10" fontSize="8" fill="#6b7280">max {max.toFixed(0)}</text>
      <text x="4" y={height - 4} fontSize="8" fill="#6b7280">min {min.toFixed(0)}</text>
    </svg>
  )
}
