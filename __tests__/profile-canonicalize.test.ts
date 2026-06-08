import { describe, expect, it } from 'vitest'

import { canonicalizeTopic } from '../scripts/profile'

describe('canonicalizeTopic', () => {
  it('strips the embedding-cluster: prefix so clusters fold into their base topic', () => {
    expect(canonicalizeTopic('embedding-cluster:dev-tools')).toBe('dev-tools')
    expect(canonicalizeTopic('embedding-cluster:politics')).toBe('politics')
  })

  it('collapses dev-tools synonym family into one canonical bucket', () => {
    const forms = ['dev-tools', 'developer-tools', 'dev-tools-and-engineering', 'embedding-cluster:dev-tools']
    for (const form of forms) {
      expect(canonicalizeTopic(form)).toBe('dev-tools')
    }
  })

  it('collapses finance and startups families', () => {
    expect(canonicalizeTopic('finance-and-investing')).toBe('finance')
    expect(canonicalizeTopic('finance-investing')).toBe('finance')
    expect(canonicalizeTopic('embedding-cluster:finance')).toBe('finance')
    expect(canonicalizeTopic('startups-and-business')).toBe('startups-business')
  })

  it('collapses the ai-ml family', () => {
    expect(canonicalizeTopic('ai-and-machine-learning')).toBe('ai-ml')
    expect(canonicalizeTopic('machine-learning')).toBe('ai-ml')
    expect(canonicalizeTopic('embedding-cluster:ai-and-machine-learning')).toBe('ai-ml')
  })

  it('leaves unknown topics normalized but otherwise intact', () => {
    expect(canonicalizeTopic('Gaming')).toBe('gaming')
    expect(canonicalizeTopic('food & drink')).toBe('food-and-drink')
  })
})
