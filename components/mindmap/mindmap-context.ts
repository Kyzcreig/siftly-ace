import { createContext, useContext } from 'react'

interface MindmapSettings {
  showLabels: boolean
}

export const MindmapContext = createContext<MindmapSettings>({ showLabels: false })

export function useMindmapSettings(): MindmapSettings {
  return useContext(MindmapContext)
}
