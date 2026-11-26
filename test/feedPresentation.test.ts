import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import { playCountLabel } from '../src/market/feedPresentation'

test('play counts use compact integers or w without redundant decimals', () => {
  const cases = [
    ['0播放', '0'],
    ['123播放', '123'],
    ['2345播放', '2345'],
    ['9999播放', '9999'],
    ['10000播放', '1w'],
    ['1.1万播放', '1.1w'],
    ['108.0万播放', '108w'],
    ['6.7万播放', '6.7w'],
    ['1.2亿播放', '12000w'],
    [' 1.5w 播放 ', '1.5w'],
  ]
  for (const [stat, expected] of cases) assert.equal(playCountLabel({ source: 'rcmd', stat }), expected)
})

test('missing counts and history progress never become play-count badges', () => {
  for (const stat of [undefined, '', 'P2 看到 1:23', 'P1 已看完', '123 回复', '-5播放', 'NaN播放']) {
    assert.equal(playCountLabel({ source: 'rcmd', stat }), undefined)
  }
  assert.equal(playCountLabel({ source: 'history', stat: '123播放' }), undefined)
})

test('video UI does not read or write the retired local history store', () => {
  for (const name of ['FunPanel', 'VideoPlayer']) {
    const source = readFileSync(new URL(`../src/pages/stock-panel/${name}.vue`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /useVideoHistoryStore|historyStore|saveProgress|本机设备记录|本地断点/)
  }
})
