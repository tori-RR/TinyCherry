import { syncSkills } from './desktop/skills.mjs'
import { buildAgentsSkillsGitignore, buildClaudeSkillsGitignore, listSkillNames, ROOT_DIR } from './skills-common'

try {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--apply')) throw new Error('Use skills-sync.ts [--apply]')
  const names = listSkillNames()
  const apply = args.includes('--apply')
  const changes = syncSkills(
    ROOT_DIR,
    names,
    {
      agents: buildAgentsSkillsGitignore(names),
      claude: buildClaudeSkillsGitignore(names)
    },
    { apply }
  )
  console.log(`${apply ? 'Applied' : 'Dry run:'} ${changes.length} skill infrastructure changes`)
  for (const path of changes) console.log(path)
  if (!apply && changes.length)
    console.log('Review conflicts first; use --apply to create missing links and update ignore lists.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
