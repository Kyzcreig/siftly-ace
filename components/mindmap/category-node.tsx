'use client'

import { type NodeProps } from '@xyflow/react'

interface CategoryNodeData {
  name: string
  slug: string
  color: string
  count: number
  description?: string
  [key: string]: unknown
}

interface CategoryNodeProps extends NodeProps {
  onExpand?: (slug: string) => void
}

function darkenColor(hex: string, factor: number): string {
  const clean = hex.replace('#', '')
  const r = Math.round(parseInt(clean.slice(0, 2), 16) * factor)
  const g = Math.round(parseInt(clean.slice(2, 4), 16) * factor)
  const b = Math.round(parseInt(clean.slice(4, 6), 16) * factor)
  return `rgb(${r},${g},${b})`
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export default function CategoryNode({ data }: CategoryNodeProps) {
  const { name, color, count } = data as CategoryNodeData

  const mid = darkenColor(color, 0.75)
  const dark = darkenColor(color, 0.42)
  // Empty categories render smaller and more translucent so they look intentional
  const isEmpty = count === 0
  const size = isEmpty ? 90 : 112
  const nodeOpacity = isEmpty ? 0.5 : 1

  return (
    <div
      className="relative flex flex-col items-center justify-center rounded-full select-none cursor-pointer transition-transform hover:scale-105 active:scale-95"
      style={{ width: size, height: size, opacity: nodeOpacity }}
    >
      {/* Outer pulse ring */}
      <div
        className="absolute inset-0 rounded-full animate-ping"
        style={{
          background: 'transparent',
          border: `1px solid ${hexToRgba(color, 0.22)}`,
          animationDuration: '3.5s',
        }}
      />

      {/* Mid orbit ring */}
      <div
        className="absolute rounded-full"
        style={{
          inset: -6,
          border: `1px solid ${hexToRgba(color, 0.12)}`,
          borderRadius: '50%',
        }}
      />

      {/* Main sphere */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 38% 35%, ${color}, ${mid} 55%, ${dark})`,
          boxShadow: `0 0 0 1.5px ${hexToRgba(color, 0.85)}, 0 0 28px ${hexToRgba(color, 0.45)}, inset 0 1px 0 rgba(255,255,255,0.2)`,
        }}
      />

      {/* Glint highlight */}
      <div
        className="absolute rounded-full"
        style={{
          top: 13, left: 17, width: 28, height: 12,
          background: 'radial-gradient(ellipse, rgba(255,255,255,0.25) 0%, transparent 70%)',
        }}
      />

      {/* Text */}
      <div className="relative z-10 flex flex-col items-center gap-0.5 px-3">
        <span
          className="text-white font-bold text-[11px] text-center leading-tight"
          style={{ textShadow: '0 1px 4px rgba(0,0,0,0.65)', letterSpacing: '-0.01em' }}
        >
          {name}
        </span>
        <span
          className="text-white/65 text-[10px] font-medium tabular-nums"
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}
        >
          {count}
        </span>
      </div>
    </div>
  )
}
