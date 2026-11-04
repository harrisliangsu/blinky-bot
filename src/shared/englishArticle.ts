/** "an OpenAI", "an xAI"; "a Grok". */
export function englishArticle(label: string): 'a' | 'an' {
  return /^(?:[aeiou]|x)/i.test(label.trim()) ? 'an' : 'a'
}
