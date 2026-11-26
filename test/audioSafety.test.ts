import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

import type { AudioOutputState, SafetyMedia } from '../src/market/audioSafety'

import { createAudioSafety, isAudioOutputState } from '../src/market/audioSafety'

const headphones: AudioOutputState = { revision: 1, routeId: 'headset', kind: 'headphones', monitoring: true }
const speaker: AudioOutputState = { revision: 2, routeId: 'built-in', kind: 'speaker', monitoring: true }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fakeMedia() {
  return {
    muted: true,
    paused: true,
    plays: 0,
    pauses: 0,
    currentTime: 27,
    pause() {
      this.paused = true
      this.pauses += 1
    },
    async play() {
      this.paused = false
      this.plays += 1
    },
  }
}

function fixture(initial: AudioOutputState = headphones) {
  let state: unknown = initial
  let media: SafetyMedia | undefined = fakeMedia()
  let changed!: (state: unknown) => void
  let cleanupCount = 0
  let interruptions = 0
  let queryOutput = async (): Promise<unknown> => state
  const ui = { muted: true }
  const safety = createAudioSafety({
    queryOutput: () => queryOutput(),
    getMedia: () => media,
    onMuted: value => ui.muted = value,
    onInterrupt: () => interruptions += 1,
  })
  return {
    safety,
    ui,
    get media() {
      return media!
    },
    get interruptions() {
      return interruptions
    },
    get cleanupCount() {
      return cleanupCount
    },
    setMedia(value: SafetyMedia | undefined) {
      media = value
    },
    setQuery(value: () => Promise<unknown>) {
      queryOutput = value
    },
    connect: () => safety.connect(async (handler) => {
      changed = handler
      return () => cleanupCount += 1
    }),
    change(value: unknown) {
      state = value
      changed(value)
    },
  }
}

async function tick() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('opens a new video audibly only with monitored headphones', async () => {
  const f = fixture()
  await f.connect()
  f.safety.beginPart()
  assert.equal(await f.safety.play(f.media), true)
  assert.equal(f.media.muted, false)
  assert.equal(f.ui.muted, false)
})

test('speaker, unknown output and missing native monitoring default to muted playback', async () => {
  for (const state of [speaker, { ...headphones, kind: 'unknown' as const }, { ...headphones, monitoring: false }]) {
    const f = fixture(state)
    await f.connect()
    assert.equal(await f.safety.play(f.media), true)
    assert.equal(f.media.muted, true)
  }
})

test('output changes synchronously mute and pause without seeking, and reconnect never resumes', async () => {
  const f = fixture()
  const media = f.media as ReturnType<typeof fakeMedia>
  await f.connect()
  await f.safety.play(media)
  f.change(speaker)
  assert.equal(media.muted, true)
  assert.equal(media.paused, true)
  assert.equal(media.currentTime, 27)
  assert.equal(f.interruptions, 1)
  f.change({ ...headphones, revision: 3 })
  assert.equal(await f.safety.play(media), false)
  assert.equal(media.plays, 1)
  assert.equal(await f.safety.play(media, true), true)
  assert.equal(media.muted, true)
  assert.equal(await f.safety.unmute(), true)
  assert.equal(media.muted, false)
})

test('manual sound is permitted on speakers, but muting is synchronous', async () => {
  const f = fixture(speaker)
  await f.connect()
  await f.safety.play(f.media)
  assert.equal(await f.safety.unmute(), true)
  assert.equal(f.media.muted, false)
  f.safety.mute()
  assert.equal(f.media.muted, true)
})

test('failed or malformed queries never authorize sound', async () => {
  for (const query of [async () => {
    throw new Error('IPC failed')
  }, async () => ({ kind: 'headphones' })]) {
    const f = fixture()
    f.setQuery(query)
    await f.connect()
    assert.equal(await f.safety.play(f.media), true)
    assert.equal(f.media.muted, true)
    assert.equal(await f.safety.unmute(), false)
    assert.equal(f.media.muted, true)
  }
})

test('subscribes before querying and removes the subscription on disposal', async () => {
  const order: string[] = []
  const subscription = deferred<() => void>()
  const safety = createAudioSafety({
    queryOutput: async () => {
      order.push('query')
      return headphones
    },
    getMedia: () => undefined,
    onMuted: () => {},
    onInterrupt: () => {},
  })
  const connecting = safety.connect(() => {
    order.push('subscribe')
    return subscription.promise
  })
  assert.deepEqual(order, ['subscribe'])
  subscription.resolve(() => order.push('unlisten'))
  await connecting
  assert.deepEqual(order, ['subscribe', 'query'])
  safety.dispose()
  assert.deepEqual(order, ['subscribe', 'query', 'unlisten'])
})

test('a failed subscription disables automatic sound, not explicit manual sound', async () => {
  const f = fixture()
  await f.safety.connect(async () => {
    throw new Error('listen failed')
  })
  assert.equal(await f.safety.play(f.media), true)
  assert.equal(f.media.muted, true)
  assert.equal(await f.safety.unmute(), true)
  assert.equal(f.media.muted, false)
})

test('a late subscription is immediately removed after unmount', async () => {
  const subscription = deferred<() => void>()
  let removed = false
  let queries = 0
  const safety = createAudioSafety({
    queryOutput: async () => {
      queries += 1
      return headphones
    },
    getMedia: () => undefined,
    onMuted: () => {},
    onInterrupt: () => {},
  })
  const connecting = safety.connect(() => subscription.promise)
  safety.dispose()
  subscription.resolve(() => removed = true)
  await connecting
  assert.equal(removed, true)
  assert.equal(queries, 0)
})

test('older events and query responses cannot overturn a disconnect', async () => {
  const f = fixture()
  await f.connect()
  const snapshot = deferred<unknown>()
  f.setQuery(() => snapshot.promise)
  const playing = f.safety.play(f.media)
  await tick()
  f.change(speaker)
  f.change(headphones)
  snapshot.resolve(headphones)
  assert.equal(await playing, false)
  assert.equal(f.media.muted, true)
  assert.equal(f.interruptions, 1)
})

test('a manual unmute result is discarded after a newer output event or manual mute', async () => {
  for (const event of [true, false]) {
    const f = fixture()
    await f.connect()
    const snapshot = deferred<unknown>()
    f.setQuery(() => snapshot.promise)
    const unmuting = f.safety.unmute()
    await tick()
    if (event) f.change(speaker)
    else f.safety.mute()
    snapshot.resolve(headphones)
    assert.equal(await unmuting, false)
    assert.equal(f.media.muted, true)
  }
})

test('out-of-order manual queries cannot overwrite a later decision', async () => {
  const f = fixture()
  await f.connect()
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  f.setQuery(() => first.promise)
  const old = f.safety.unmute()
  await tick()
  f.setQuery(() => second.promise)
  const recent = f.safety.unmute()
  await tick()
  second.resolve(headphones)
  assert.equal(await recent, true)
  f.safety.mute()
  first.resolve(headphones)
  assert.equal(await old, false)
  assert.equal(f.media.muted, true)
})

test('a fresh query that discovers a route change pauses even before its event arrives', async () => {
  const f = fixture()
  await f.connect()
  await f.safety.play(f.media)
  f.setQuery(async () => speaker)
  assert.equal(await f.safety.play(f.media, true), false)
  assert.equal(f.media.muted, true)
  assert.equal(f.interruptions, 1)
})

test('each actual play rechecks output; a failed later snapshot cannot reuse automatic sound', async () => {
  const f = fixture()
  let queries = 0
  f.setQuery(async () => {
    queries += 1
    return headphones
  })
  await f.connect()
  await f.safety.play(f.media)
  f.safety.stop()
  await f.safety.play(f.media, true)
  assert.equal(queries, 3)
  f.safety.stop()
  f.setQuery(async () => {
    throw new Error('unavailable')
  })
  assert.equal(await f.safety.play(f.media, true), true)
  assert.equal(f.media.muted, true)
})

test('switching P retains explicit sound intent, but always starts the new media muted', async () => {
  const f = fixture(speaker)
  await f.connect()
  await f.safety.unmute()
  f.safety.beginPart(true)
  assert.equal(f.media.muted, true)
  const next = fakeMedia()
  f.setMedia(next)
  assert.equal(next.muted, true)
  assert.equal(await f.safety.play(next), true)
  assert.equal(next.muted, false)
  f.safety.mute()
  f.safety.beginPart(true)
  const last = fakeMedia()
  f.setMedia(last)
  await f.safety.play(last)
  assert.equal(last.muted, true)
})

test('a route change between P selection and media mount blocks metadata/seeked autoplay', async () => {
  const f = fixture()
  await f.connect()
  await f.safety.play(f.media)
  f.safety.beginPart(true)
  f.setMedia(undefined)
  f.change(speaker)
  const next = fakeMedia()
  f.setMedia(next)
  assert.equal(await f.safety.play(next), false)
  assert.equal(await f.safety.play(next), false)
  assert.equal(next.muted, true)
  assert.equal(next.plays, 0)
})

test('events before parts have loaded revoke autoplay even when no media is mounted', async () => {
  const f = fixture()
  f.setMedia(undefined)
  await f.connect()
  f.change(speaker)
  f.change({ ...headphones, revision: 3 })
  f.safety.beginPart()
  const video = fakeMedia()
  f.setMedia(video)
  assert.equal(await f.safety.play(video), false)
  assert.equal(video.plays, 0)
})

test('stopping blocks pending snapshots and subsequent metadata/seeked autoplay', async () => {
  const f = fixture()
  await f.connect()
  const snapshot = deferred<unknown>()
  f.setQuery(() => snapshot.promise)
  const playing = f.safety.play(f.media)
  await tick()
  f.safety.stop()
  snapshot.resolve(headphones)
  assert.equal(await playing, false)
  assert.equal(await f.safety.play(f.media), false)
  assert.equal((f.media as ReturnType<typeof fakeMedia>).plays, 0)
})

test('a pending play resolving after stop/disconnect cannot restart or unmute playback', async () => {
  for (const disconnect of [false, true]) {
    const f = fixture()
    await f.connect()
    const pending = deferred<void>()
    const media = fakeMedia()
    media.play = async () => {
      media.plays += 1
      await pending.promise
      media.paused = false
    }
    f.setMedia(media)
    const playing = f.safety.play(media)
    await tick()
    assert.equal(media.plays, 1)
    if (disconnect) f.change(speaker)
    else f.safety.stop()
    assert.equal(media.muted, true)
    assert.equal(media.paused, true)
    // Simulate a browser dispatching playing before settling the old play promise.
    media.paused = false
    assert.equal(f.safety.acceptPlaying(media), false)
    assert.equal(media.paused, true)
    pending.resolve()
    assert.equal(await playing, false)
    assert.equal(media.paused, true)
    assert.equal(media.muted, true)
  }
})

test('manual mute during a pending play is not undone when play settles', async () => {
  const f = fixture()
  await f.connect()
  const pending = deferred<void>()
  const media = fakeMedia()
  media.play = () => pending.promise
  f.setMedia(media)
  const playing = f.safety.play(media)
  await tick()
  f.safety.mute()
  pending.resolve()
  assert.equal(await playing, true)
  assert.equal(media.muted, true)
})

test('state validation rejects missing, malformed and unsafe revisions', () => {
  assert.equal(isAudioOutputState(headphones), true)
  for (const state of [null, {}, { ...headphones, revision: -1 }, { ...headphones, revision: Number.NaN }, { ...headphones, monitoring: undefined }]) {
    assert.equal(isAudioOutputState(state), false)
  }
})
