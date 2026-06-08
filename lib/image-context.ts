/**
 * Converts raw imageTags JSON (from vision analysis) into a compact human-readable string
 * suitable for inclusion in AI prompts. Shared across categorizer and vision-analyzer.
 */
export function buildImageContext(rawImageTags: string | undefined): string {
  if (!rawImageTags) return ''
  try {
    const parsed = JSON.parse(rawImageTags) as Record<string, unknown>
    const parts: string[] = []
    if (parsed.style) parts.push(`Style: ${parsed.style}`)
    if (parsed.scene) parts.push(`Scene: ${parsed.scene}`)
    if (parsed.action) parts.push(`Action: ${parsed.action}`)
    if (Array.isArray(parsed.text_ocr) && (parsed.text_ocr as unknown[]).length)
      parts.push(`Text: ${(parsed.text_ocr as string[]).join(' | ').slice(0, 200)}`)
    if (Array.isArray(parsed.tags) && (parsed.tags as unknown[]).length)
      parts.push(`Visual tags: ${(parsed.tags as string[]).slice(0, 15).join(', ')}`)
    if (parsed.meme_template) parts.push(`Meme: ${parsed.meme_template}`)
    return parts.join(' | ')
  } catch {
    return rawImageTags.slice(0, 300)
  }
}
