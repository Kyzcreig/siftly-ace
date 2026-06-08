'use client'

import { type NodeProps } from '@xyflow/react'

interface RootNodeData {
  label: string
  count: number
  [key: string]: unknown
}

export default function RootNode({ data }: NodeProps) {
  const { label, count } = data as RootNodeData

  return (
    <div
      className="relative flex flex-col items-center justify-center rounded-full select-none"
      style={{ width: 148, height: 148 }}
    >
      {/* Outer pulse ring */}
      <div
        className="absolute inset-0 rounded-full animate-ping"
        style={{
          background: 'transparent',
          border: '1px solid rgba(99,102,241,0.3)',
          animationDuration: '3s',
        }}
      />

      {/* Mid ring */}
      <div
        className="absolute rounded-full"
        style={{
          inset: -6,
          border: '1px solid rgba(99,102,241,0.18)',
          borderRadius: '50%',
        }}
      />

      {/* Main circle */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'radial-gradient(circle at 38% 35%, #5b5fef, #3730a3 55%, #1e1b4b)',
          boxShadow: '0 0 0 2px #4f46e5, 0 0 40px rgba(99,102,241,0.5), inset 0 1px 0 rgba(255,255,255,0.15)',
        }}
      />

      {/* Glint */}
      <div
        className="absolute rounded-full"
        style={{
          top: 16, left: 22, width: 32, height: 14,
          background: 'radial-gradient(ellipse, rgba(255,255,255,0.18) 0%, transparent 70%)',
        }}
      />

      {/* Text */}
      <div className="relative z-10 flex flex-col items-center gap-0.5">
        <span
          className="text-white font-bold text-[13px] text-center leading-tight px-3"
          style={{ textShadow: '0 1px 4px rgba(0,0,0,0.5)', letterSpacing: '-0.01em' }}
        >
          {label}
        </span>
        <span
          className="text-indigo-200 text-[11px] font-medium tabular-nums"
          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.4)' }}
        >
          {count.toLocaleString()} bookmarks
        </span>
      </div>
    </div>
  )
}
