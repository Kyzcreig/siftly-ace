'use client'

import { type EdgeProps } from '@xyflow/react'

/**
 * Orbital edge — a clean glowing line connecting the root hub to each
 * category bubble, replacing the previous chain-link style.
 */
export default function ChainEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style = {},
}: EdgeProps) {
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const length = Math.sqrt(dx * dx + dy * dy)
  if (length < 2) return null

  const strokeColor = (style as { stroke?: string }).stroke ?? '#6366f1'
  const pathD = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`

  return (
    <g>
      {/* Outer glow */}
      <path d={pathD} stroke={strokeColor} strokeWidth={10} opacity={0.05} fill="none" />
      {/* Mid glow */}
      <path d={pathD} stroke={strokeColor} strokeWidth={4} opacity={0.12} fill="none" />
      {/* Core line */}
      <path id={id} d={pathD} stroke={strokeColor} strokeWidth={1.2} opacity={0.65} fill="none" />
    </g>
  )
}
