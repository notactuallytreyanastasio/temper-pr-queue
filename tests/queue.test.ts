import { expect, test } from 'claude-code/testing'

import { mergeOrder, toQueue } from '../hooks/register'

const pr = (number: number, title: string, paths: string[], extra: Record<string, unknown> = {}) => ({
  number,
  title,
  body: '',
  files: paths.map(path => ({ path })),
  additions: 10,
  deletions: 2,
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  isDraft: false,
  ...extra,
})

test('two PRs that edit the same source file overlap; regenerated test registries do not count', () => {
  const q = toQueue(
    [
      pr(1, 'frontend: a', ['frontend/A.kt', 'functional-test-matrix.md']),
      pr(2, 'frontend: b', ['frontend/A.kt']),
      pr(3, 'be-py: c', ['be-py/C.kt', 'functional-test-matrix.md']),
    ],
    'me',
    't',
  )
  const byNumber = new Map(q.prs.map(p => [p.number, p]))
  expect(byNumber.get(1)?.overlaps).toEqual([2])
  expect(byNumber.get(2)?.overlaps).toEqual([1])
  expect(byNumber.get(3)?.overlaps).toEqual([])
  expect(byNumber.get(3)?.subsystem).toBe('be-py')
})

test('the issues a PR fixes come from Fixes and Refs lines in its body', () => {
  const q = toQueue([pr(9, 'cpp: x', [], { body: 'text\n\nFixes #540.\nRefs #557' })], 'me', 't')
  expect(q.prs[0]?.fixes).toEqual([540, 557])
})

test('merge order: independent small PRs first, overlapping next, drafts and huge ones last', () => {
  const q = toQueue(
    [
      pr(1, 'a: shared', ['x.kt'], { additions: 5 }),
      pr(2, 'a: shared too', ['x.kt'], { additions: 5 }),
      pr(3, 'b: alone', ['y.kt'], { additions: 50 }),
      pr(4, 'c: draft', ['z.kt'], { isDraft: true }),
      pr(5, 'd: huge', ['w.kt'], { additions: 19000 }),
    ],
    'me',
    't',
  )
  expect(mergeOrder(q)).toEqual([3, 1, 2, 5, 4])
})

test('sharing files with a PR over 2,000 lines is listed as alsoIn, not as overlap', () => {
  const q = toQueue(
    [
      pr(507, 'Experimental: Add Elixir Backend', ['frontend/A.kt', 'be-elixir/X.kt'], { additions: 19000 }),
      pr(571, 'frontend: a', ['frontend/A.kt']),
    ],
    'me',
    't',
  )
  const byNumber = new Map(q.prs.map(p => [p.number, p]))
  expect(byNumber.get(571)?.overlaps).toEqual([])
  expect(byNumber.get(571)?.alsoIn).toEqual([507])
  expect(byNumber.get(507)?.overlaps).toEqual([])
})
