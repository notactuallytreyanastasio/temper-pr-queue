import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Queue, QueuedPr } from '../types'

const REPO = 'temperlang/temper'
const DEFAULT_AUTHOR = 'notactuallytreyanastasio'
const PANE = 'temper-pr-queue'
const TOOL = 'pr_queue'
const UMBRELLA_LINES = 2000

const queue = atom({ plugin: 'temper-pr-queue', key: 'queue' } as const, null)

// Files every PR that adds a functional test regenerates. Two PRs touching
// them merge with a regeneration, not a real conflict, so they are not
// counted as overlap.
const REGENERATED = [
  /functional-test-matrix\.md$/,
  /FunctionalTests\.kt$/,
  /FunctionalTestSuiteI\.kt$/,
  /FunctionalTestStatus\.kt$/,
  /functional-test-suite\/src\/commonMain\/resources\/config\.temper\.md$/,
  /\.snippet-hashes\.json$/,
  /helpful-snippets\.json$/,
]

type GhPr = {
  number: number
  title: string
  body: string
  files: { path: string }[] | null
  additions: number
  deletions: number
  mergeable: string
  reviewDecision: string
  isDraft: boolean
}

export function toQueue(raw: GhPr[], author: string, fetchedAt: string): Queue {
  // A PR this big (the Elixir backend, #507) carries copies of many fixes on
  // purpose; sharing files with it says the fix shrinks it, not that the two
  // conflict, so it is listed apart from real overlaps.
  const isUmbrella = (p: GhPr) => p.additions + p.deletions > UMBRELLA_LINES
  const umbrellas = new Set(raw.filter(isUmbrella).map(p => p.number))
  const owners = new Map<string, number[]>()
  for (const pr of raw) {
    for (const f of pr.files ?? []) {
      if (REGENERATED.some(r => r.test(f.path))) continue
      owners.set(f.path, [...(owners.get(f.path) ?? []), pr.number])
    }
  }
  const prs: QueuedPr[] = raw.map(pr => {
    const files = (pr.files ?? []).map(f => f.path)
    const overlaps = new Set<number>()
    const alsoIn = new Set<number>()
    for (const path of files) {
      for (const n of owners.get(path) ?? []) {
        if (n === pr.number) continue
        if (umbrellas.has(n) && !isUmbrella(pr)) alsoIn.add(n)
        else if (!umbrellas.has(pr.number)) overlaps.add(n)
      }
    }
    const colon = pr.title.indexOf(':')
    const subsystem = colon > 0 && colon < 24 ? pr.title.slice(0, colon).trim() : 'other'
    const fixes = [...(pr.body ?? '').matchAll(/\b(?:Fixes|Refs)\s+#(\d+)/gi)].map(m => Number(m[1]))
    return {
      number: pr.number,
      title: pr.title,
      subsystem,
      fixes,
      additions: pr.additions,
      deletions: pr.deletions,
      files,
      mergeable: pr.mergeable,
      review: pr.reviewDecision || 'NONE',
      isDraft: pr.isDraft,
      overlaps: [...overlaps].sort((a, b) => a - b),
      alsoIn: [...alsoIn].sort((a, b) => a - b),
    }
  })
  prs.sort((a, b) => a.subsystem.localeCompare(b.subsystem) || a.number - b.number)
  return { repo: REPO, author, fetchedAt, prs }
}

// Independent, small, ready PRs first; then those that share files, smallest
// first, so each later one rebases over less; drafts and anything over 2,000
// changed lines last.
export function mergeOrder(q: Queue): number[] {
  const weight = (p: QueuedPr) =>
    (p.isDraft ? 1e9 : 0) +
    (p.additions + p.deletions > UMBRELLA_LINES ? 1e8 : 0) +
    (p.mergeable === 'CONFLICTING' ? 1e7 : 0) +
    p.overlaps.length * 1e5 +
    p.additions + p.deletions
  return [...q.prs].sort((a, b) => weight(a) - weight(b) || a.number - b.number).map(p => p.number)
}

async function fetchQueue($: EngineInterface, author: string): Promise<Queue> {
  const fields = 'number,title,body,files,additions,deletions,mergeable,reviewDecision,isDraft'
  const ran = await $.process.run(
    ['gh', 'pr', 'list', '-R', REPO, '--author', author, '--state', 'open', '--limit', '200', '--json', fields],
    { timeoutMs: 120_000 },
  )
  const fetchedAt = new Date().toISOString()
  if (ran.exitCode !== 0) {
    return { repo: REPO, author, fetchedAt, prs: [], error: ran.stderr.trim() || `gh exited ${ran.exitCode}` }
  }
  return toQueue(JSON.parse(ran.stdout) as GhPr[], author, fetchedAt)
}

function reviewPrompt(n: number, q: Queue | null): string {
  const pr = q?.prs.find(p => p.number === n)
  const overlap = pr && pr.overlaps.length > 0
    ? `It shares files with ${pr.overlaps.map(o => '#' + o).join(', ')}; say whether merge order matters and which should go first.`
    : 'No other PR in the queue shares its files.'
  return [
    `Review ${REPO}#${n} for merging. Do not comment, approve or push on GitHub unless I ask.`,
    '',
    `1. Read it: \`gh pr view ${n} -R ${REPO} --comments\` and \`gh pr diff ${n} -R ${REPO}\`. Read every issue it says it fixes, with comments.`,
    `2. Check it out beside the current checkout: \`git fetch origin pull/${n}/head:review-${n}\` and \`git worktree add ../review-${n} review-${n}\`. Build the CLI there (\`./gradlew cli:installDist\`), and one from origin/main for comparison.`,
    '3. If the body links a case in notactuallytreyanastasio/temper-issue-repros, fetch that repo and run the case with both CLIs (`TEMPER=<cli> ./repro.sh <case>/<library> <backend>`) on the backends the PR is about. Show the before and after output.',
    "4. Run the tests of the modules the diff touches, and any functional test it adds or changes, on the backends it names. Revert the PR's non-test change locally and confirm its regression test fails, then restore it.",
    '5. Read the diff for correctness. Write one or two programs just beside the shape it fixes and run them before and after. Check the commit message claims only what the evidence shows.',
    `6. ${overlap}`,
    '',
    'Report: a verdict (merge, merge after another PR, or changes needed), the evidence for it with real output, and any concern with file:line. Remove the worktree when done.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-queue',
      description: `Open a review queue of ${REPO} PRs (default author ${DEFAULT_AUTHOR}; pass another login to change it)`,
    })
    await $.command.register({
      name: 'pr-review',
      description: `Run a guided merge review of one ${REPO} PR: /pr-review <number>`,
    })
    await $.tool.register({
      name: TOOL,
      description:
        `The open ${REPO} PRs by one author as a review queue: per PR its subsystem, the issues it fixes, size, ` +
        'mergeability, review decision, the other queued PRs that touch the same source files (regenerated test ' +
        'registries excluded; a PR over 2,000 changed lines that carries copies of others is listed as alsoIn, ' +
        'not as an overlap), and a suggested merge order. Pass refresh to fetch again.',
      inputSchema: {
        type: 'object',
        properties: {
          author: { type: 'string', description: `GitHub login; default ${DEFAULT_AUTHOR}` },
          refresh: { type: 'boolean' },
        },
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('command.run', { command: 'pr-queue' }, async ($, e) => {
    const author = e.args.trim() || DEFAULT_AUTHOR
    await $.ui.toast(`Fetching open ${REPO} PRs by ${author}`)
    const q = await fetchQueue($, author)
    await update($, queue, () => q)
    await $.ui.open({ id: PANE, title: `PRs by ${author}` })
    if (q.error) return { text: `gh failed: ${q.error}` }
    const order = mergeOrder(q).slice(0, 10).map(n => '#' + n).join(' ')
    return { text: `${q.prs.length} open PRs by ${author}. Suggested first merges: ${order}` }
  })

  on('command.run', { command: 'pr-review' }, async ($, e) => {
    const n = Number(e.args.trim().replace(/^#/, ''))
    if (!Number.isInteger(n) || n <= 0) return { text: 'Usage: /pr-review <PR number>' }
    void $.prompt.submit({ text: reviewPrompt(n, await read($, queue)) })
    return { text: `Queued a merge review of ${REPO}#${n}.` }
  })

  on('tool.call', { tool: 'mcp__temper-pr-queue__pr_queue' }, async ($, e) => {
    const input = (e.input ?? {}) as { author?: string; refresh?: boolean }
    const author = input.author || DEFAULT_AUTHOR
    let q = await read($, queue)
    if (!q || input.refresh || q.author !== author) {
      q = await fetchQueue($, author)
      await update($, queue, () => q)
    }
    const out = { ...q, mergeOrder: mergeOrder(q) }
    // A plugin tool's result is text or content blocks; the queue goes as JSON text.
    return { result: JSON.stringify(out) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const q = await read($, queue)
    if (!q) return <Text dimColor>Run /pr-queue to fetch the queue.</Text>
    if (q.error) return <Text color="red">gh failed: {q.error}</Text>

    const groups = new Map<string, QueuedPr[]>()
    for (const p of q.prs) groups.set(p.subsystem, [...(groups.get(p.subsystem) ?? []), p])
    const ready = q.prs.filter(p => !p.isDraft && p.mergeable === 'MERGEABLE' && p.overlaps.length === 0).length

    return (
      <Box flexDirection="column">
        <Text bold>
          {q.prs.length} open, {ready} independent and mergeable
        </Text>
        <Text dimColor>
          fetched {q.fetchedAt.slice(0, 16).replace('T', ' ')} · /pr-review &lt;n&gt; to review one
        </Text>
        {[...groups.entries()].map(([name, prs]) => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">
              {name} ({prs.length})
            </Text>
            {prs.map(p => (
              <Box flexDirection="column">
                <Text wrap="truncate-end" dimColor={p.isDraft}>
                  #{p.number} {p.isDraft ? '[draft] ' : ''}
                  {p.title.slice(p.title.indexOf(':') + 1).trim()}
                </Text>
                <Text wrap="truncate-end" dimColor>
                  {'   '}+{p.additions}/-{p.deletions}
                  {' · '}
                  <Text color={p.mergeable === 'CONFLICTING' ? 'red' : p.mergeable === 'MERGEABLE' ? 'green' : 'yellow'}>
                    {p.mergeable.toLowerCase()}
                  </Text>
                  {' · '}
                  {p.review.toLowerCase().replace('_', ' ')}
                  {p.fixes.length > 0 ? ` · fixes ${p.fixes.map(f => '#' + f).join(' ')}` : ''}
                  {p.overlaps.length > 0 ? ` · shares files with ${p.overlaps.map(o => '#' + o).join(' ')}` : ''}
                  {p.alsoIn.length > 0 ? ` · also in ${p.alsoIn.map(o => '#' + o).join(' ')}` : ''}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
