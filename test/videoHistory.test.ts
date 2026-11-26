import assert from 'node:assert/strict'
// The project uses Node's built-in runner; no Vitest runtime is required.
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { VideoProgress } from '../src/market/videoHistory'

import { formatVideoTime, historyFeedItem, latestVideos, MAX_HISTORY_PARTS, MAX_HISTORY_VIDEOS, resumePosition, sanitizeVideoHistory } from '../src/market/videoHistory'

const entry: VideoProgress = { bvid: 'BV1rg1FzvEiP', cid: 101, title: '视频', author: 'UP', page: 1, partTitle: '第一 P', position: 30, duration: 120, watchedAt: 1000, completed: false }

test('keeps independent part progress but presents one history item per video', () => {
  const result = sanitizeVideoHistory([entry, { ...entry, cid: 102, page: 2, position: 60, watchedAt: 2000 }])
  assert.equal(result.length, 2)
  assert.equal(latestVideos(result).length, 1)
  assert.equal(latestVideos(result)[0]?.cid, 102)
  assert.equal(result.find(row => row.cid === 101)?.position, 30)
})

test('keeps the newest duplicate, validates values and strips unknown fields', () => {
  const result = sanitizeVideoHistory([
    { ...entry, token: 'must-not-persist', url: 'must-not-persist' },
    { ...entry, position: 50, watchedAt: 2000 },
    { ...entry, bvid: 'bad' },
    { ...entry, cid: 0 },
    { ...entry, position: Number.NaN },
    { ...entry, duration: Infinity },
    { ...entry, position: -1 },
    { ...entry, watchedAt: 'invalid' },
    null,
    'bad',
    {},
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0]?.position, 50)
  assert.equal(JSON.stringify(result).includes('must-not-persist'), false)
  assert.deepEqual(sanitizeVideoHistory({ entries: [entry] }), [])
})

test('clamps out-of-range stored positions and supplies display defaults', () => {
  const result = sanitizeVideoHistory([{ ...entry, position: 999, page: -1, partTitle: null }])
  assert.equal(result[0]?.position, 120)
  assert.equal(result[0]?.page, 1)
  assert.equal(result[0]?.partTitle, '')
})

test('resumes an unfinished part and restarts completed or nearly finished parts', () => {
  assert.equal(resumePosition(entry, 120), 30)
  assert.equal(resumePosition(undefined, 120), 0)
  assert.equal(resumePosition({ ...entry, completed: true }, 120), 0)
  assert.equal(resumePosition({ ...entry, position: 118 }, 120), 0)
  assert.equal(resumePosition(entry, 20), 0)
  assert.equal(resumePosition(entry, Number.NaN), 0)
  assert.equal(resumePosition({ ...entry, position: 1 }, 3), 1)
})

test('bounds both video count and total part count', () => {
  const videos = Array.from({ length: 210 }, (_, i) => ({ ...entry, bvid: `BV${String(i).padStart(10, '0')}`, watchedAt: i + 1 }))
  assert.equal(sanitizeVideoHistory(videos).length, MAX_HISTORY_VIDEOS)
  const parts = Array.from({ length: 1050 }, (_, i) => ({ ...entry, cid: i + 1, watchedAt: i + 1 }))
  assert.equal(sanitizeVideoHistory(parts).length, MAX_HISTORY_PARTS)
})

test('reconstructs only gateway media paths and formats long video times', () => {
  const item = historyFeedItem(entry)
  assert.equal(item.bvid, entry.bvid)
  assert.equal(item.cid, entry.cid)
  assert.equal(item.cover, `/v1/media/cover?bvid=${entry.bvid}`)
  assert.equal(item.stat, 'P1 看到 0:30')
  assert.equal(formatVideoTime(7384), '2:03:04')
  assert.equal(formatVideoTime(Number.NaN), '0:00')
})
