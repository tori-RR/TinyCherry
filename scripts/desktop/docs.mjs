import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Light link and whitespace checks on changed documentation only. */
export function checkDocs(root, files) {
  for (const file of files.filter((file) => file.endsWith('.md'))) {
    if (!existsSync(resolve(root, file))) continue
    const text = readFileSync(resolve(root, file), 'utf8')
    if (/[^\S\r\n]+(?=\r?$)/m.test(text)) throw new Error(`Trailing whitespace: ${file}`)
    const prose = text.replace(/```[\s\S]*?```/g, '')
    for (const match of prose.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0]
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue
      if (!existsSync(resolve(dirname(resolve(root, file)), decodeURIComponent(target))))
        throw new Error(`Missing local documentation link in ${file}: ${target}`)
    }
  }
}

if (process.argv[1]?.endsWith('docs.mjs')) checkDocs(process.cwd(), process.argv.slice(2))
