import { describe, it, expect } from 'vitest'
import { detectForeign, detectLatinForeign } from '../translate'

// Real French tweet from Ace's example (@DFintelligence, World Cup AI predictions)
const FRENCH = `Est ce que des IA peuvent prédire les résultats des match de la coupe du monde de football ?

Depuis le 11 juin, je n'en avais pas parlé parce que j'étais trop occupé, mais j'ai sorti un site qui, tous les jours, demande aux 10 modèles d'IA les plus puissants de la planète de prédire les résultats de la Coupe du monde. Grok est premier, Mistral est dernier.`

const SPANISH = 'Hoy es un gran día para la inteligencia artificial en España. El equipo lanzó un modelo que es muy bueno y todo el mundo está hablando sobre esto porque los resultados son increíbles para todos.'

const GERMAN = 'Das ist ein sehr gutes Modell und wir haben es schon getestet. Die Ergebnisse sind nicht nur besser, sondern auch schneller. Wenn du mehr wissen willst, schau dir den Bericht an, der von dem Team veröffentlicht wird.'

const ENGLISH = `This is a super exciting release — same model, added safeguards, and the benchmark results are better than anything we have seen so far. If you want to know more about how it works, check out the blog post from the team.`

const ENGLISH_TECH = 'Just shipped a new agent framework with tool use, memory, and self-verification. The docs are live now and you can get started in one command. More updates when the eval results land.'

describe('detectForeign (script-based)', () => {
  it('detects Japanese', () => expect(detectForeign('これはテストです。日本語のツイート')).toBe('Japanese'))
  it('detects Chinese', () => expect(detectForeign('这是一个测试推文，关于人工智能的')).toBe('Chinese'))
  it('detects Russian', () => expect(detectForeign('Это тестовый твит о искусственном интеллекте')).toBe('Russian'))
  it('returns English language names (x.com parity), not native names', () => {
    expect(detectForeign('人工知能について。これは日本語です')).toBe('Japanese')
  })
  it('null for English', () => expect(detectForeign(ENGLISH)).toBeNull())
  it('null for a stray CJK char in English text', () =>
    expect(detectForeign('The character 中 means middle in this English sentence about language')).toBeNull())
})

describe('detectLatinForeign (stopword heuristic)', () => {
  it('detects French (the @DFintelligence example)', () => expect(detectLatinForeign(FRENCH)).toBe('French'))
  it('detects Spanish', () => expect(detectLatinForeign(SPANISH)).toBe('Spanish'))
  it('detects German', () => expect(detectLatinForeign(GERMAN)).toBe('German'))
  it('null for English', () => expect(detectLatinForeign(ENGLISH)).toBeNull())
  it('null for English tech tweet', () => expect(detectLatinForeign(ENGLISH_TECH)).toBeNull())
  it('null for short/ambiguous text (never fires on a stub)', () => {
    expect(detectLatinForeign('le monde')).toBeNull()
    expect(detectLatinForeign('')).toBeNull()
    expect(detectLatinForeign('c\u2019est la vie')).toBeNull()
  })
  it('ignores urls/mentions/hashtags when tokenizing', () => {
    // French words + noisy entities should still detect French
    const noisy = FRENCH + ' https://t.co/abc123 @grok #IA'
    expect(detectLatinForeign(noisy)).toBe('French')
  })
  it('null for English text quoting a few foreign words', () => {
    expect(detectLatinForeign('The phrase je ne sais quoi is often used in English writing when the author wants to sound just a little more refined about it all')).toBeNull()
  })
})

describe('tweetCard translation tag (x.com parity)', () => {
  it('renders "Translated from X · Show original" linking to x.com', async () => {
    const { tweetCard } = await import('../../scripts/html_report')
    const t: any = {
      id_str: '2072629001156264424',
      text: 'Can AIs predict World Cup match results?',
      user: { screen_name: 'DFintelligence', name: 'DFintelligence' },
      entities: { urls: [] },
    }
    const html = tweetCard(t, '', { text: 'Can AIs predict World Cup match results?', srcLang: 'French' })
    expect(html).toContain('Translated from French')
    expect(html).toContain('Show original')
    expect(html).toContain('https://x.com/DFintelligence/status/2072629001156264424')
  })
  it('no tag when not translated', async () => {
    const { tweetCard } = await import('../../scripts/html_report')
    const t: any = {
      id_str: '1', text: 'hello world',
      user: { screen_name: 'someone', name: 'Someone' },
      entities: { urls: [] },
    }
    const html = tweetCard(t, '')
    expect(html).not.toContain('Translated from')
    expect(html).not.toContain('Show original')
  })
})
