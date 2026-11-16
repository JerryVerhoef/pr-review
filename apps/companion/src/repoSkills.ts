/** A file of a skill kept in a repo: `<…>/.agents/skills/<name>/…` or `<…>/.claude/skills/<name>/…`. */
export const REPO_SKILL = /^(?:.*\/)?\.(?:agents|claude)\/skills\/([^/]+)\/(.+)$/

/** The repo's skills, each by name with its files relative to the skill folder; a name's first folder wins. */
export const repoSkills = (paths: ReadonlyArray<string>) => {
  const skills = new Map<string, { dir: string; files: string[] }>()
  for (const p of paths) {
    const m = REPO_SKILL.exec(p)
    if (!m) continue
    const dir = p.slice(0, p.length - m[2]!.length)
    const skill = skills.get(m[1]!) ?? skills.set(m[1]!, { dir, files: [] }).get(m[1]!)!
    if (skill.dir === dir) skill.files.push(m[2]!)
  }
  return new Map([...skills].filter(([, s]) => s.files.includes('SKILL.md')))
}
