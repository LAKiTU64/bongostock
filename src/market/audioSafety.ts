export interface AudioOutputState {
  revision: number
  routeId: string
  kind: 'headphones' | 'speaker' | 'unknown'
  monitoring: boolean
}

export interface SafetyMedia {
  muted: boolean
  readonly paused: boolean
  readonly ended: boolean
  pause: () => void
  play: () => Promise<void>
}

type SubscribeOutput = (changed: (state: unknown) => void) => Promise<() => void>

interface AudioSafetyOptions {
  queryOutput: () => Promise<unknown>
  getMedia: () => SafetyMedia | undefined
  onMuted: (muted: boolean) => void
  onInterrupt: () => void
}

export function isAudioOutputState(value: unknown): value is AudioOutputState {
  if (!value || typeof value !== 'object') return false
  const state = value as AudioOutputState
  return Number.isSafeInteger(state.revision) && state.revision >= 0
    && typeof state.routeId === 'string'
    && ['headphones', 'speaker', 'unknown'].includes(state.kind)
    && typeof state.monitoring === 'boolean'
}

/** No native or UI dependencies: all decisions can be exercised with a fake media element. */
export function createAudioSafety(options: AudioSafetyOptions) {
  let output: AudioOutputState | undefined
  let listening = false
  let disposed = false
  let epoch = 0
  let soundVersion = 0
  let querySequence = 0
  let playbackWanted = true
  let intent: 'automatic' | 'manual' | 'muted' = 'automatic'
  let activePlay: { media: SafetyMedia, epoch: number } | undefined
  let playingBeforeHide: typeof activePlay
  let unlisten: (() => void) | undefined
  let connection: Promise<void> = Promise.resolve()

  function setMuted(muted: boolean, media = options.getMedia()) {
    if (media) media.muted = muted
    if (media === options.getMedia()) options.onMuted(muted)
  }

  function cancelPlayback() {
    playingBeforeHide = undefined
    epoch += 1
    playbackWanted = false
    activePlay = undefined
    // Never wait for IPC (or play() settlement) to silence the current element.
    setMuted(true)
    options.getMedia()?.pause()
  }

  function interrupt() {
    intent = 'muted'
    soundVersion += 1
    cancelPlayback()
    options.onInterrupt()
  }

  function observe(value: unknown, event: boolean): boolean {
    if (disposed) return false
    if (!isAudioOutputState(value)) {
      if (event) interrupt()
      return false
    }
    // A delayed native event/query cannot reverse a newer route decision.
    if (output && value.revision < output.revision) return false
    if (output && value.revision === output.revision) {
      return value.routeId === output.routeId && value.kind === output.kind && value.monitoring === output.monitoring
    }
    const hadOutput = !!output
    output = { ...value }
    // A query may discover a change before its event arrives. Treat both identically.
    if (event || hadOutput) interrupt()
    return true
  }

  async function query(current: number): Promise<{ current: boolean, state?: AudioOutputState }> {
    const request = ++querySequence
    try {
      const value = await options.queryOutput()
      if (disposed || current !== epoch || request !== querySequence) return { current: false }
      if (!isAudioOutputState(value)) return { current: true }
      if (!observe(value, false)) return { current: false }
      return { current: current === epoch, state: output }
    } catch {
      // Failure cannot authorize sound, but does not prevent muted playback.
      return { current: !disposed && current === epoch && request === querySequence }
    }
  }

  function connect(subscribe: SubscribeOutput) {
    connection = (async () => {
      try {
        const cleanup = await subscribe(state => observe(state, true))
        if (disposed) {
          cleanup()
          return
        }
        unlisten = cleanup
        listening = true
      } catch {
        listening = false
      }
      if (!disposed) await query(epoch)
    })()
    return connection
  }

  function stop() {
    cancelPlayback()
  }

  function allowPlayback() {
    if (disposed) return
    epoch += 1
    playbackWanted = true
    activePlay = undefined
  }

  function beginPart(userInitiated = false) {
    const wanted = playbackWanted
    cancelPlayback()
    playbackWanted = !disposed && (userInitiated || wanted)
    // Keep sound intent across parts, not a previously unmuted DOM property.
  }

  async function play(media: SafetyMedia, userInitiated = false, { keepMuted = false } = {}): Promise<boolean> {
    if (disposed || media !== options.getMedia()) return false
    if (userInitiated) allowPlayback()
    if (!playbackWanted) return false
    const current = epoch
    const sound = soundVersion
    setMuted(true, media)
    await connection
    if (disposed || current !== epoch || !playbackWanted || media !== options.getMedia()) return false
    const checked = await query(current)
    if (!checked.current || !playbackWanted || media !== options.getMedia()) return false
    const audible = intent === 'manual'
      ? !!checked.state
      : intent === 'automatic'
        && listening && checked.state?.kind === 'headphones' && checked.state.monitoring
    const attempt = { media, epoch: current }
    activePlay = attempt
    try {
      // Start muted. A pending play promise never carries permission to emit sound.
      await media.play()
    } catch {
      if (activePlay === attempt) activePlay = undefined
      return false
    }
    if (disposed || current !== epoch || !playbackWanted || media !== options.getMedia()) {
      // Do not stop a newer, explicitly authorized play on the same element.
      if (!activePlay || activePlay.media !== media || activePlay.epoch !== epoch) {
        setMuted(true, media)
        media.pause()
      }
      return false
    }
    if (sound === soundVersion) setMuted(keepMuted || !audible, media)
    return true
  }

  function acceptPlaying(media: SafetyMedia): boolean {
    if (!disposed && playbackWanted && media === options.getMedia()
      && activePlay?.media === media && activePlay.epoch === epoch) {
      return true
    }
    setMuted(true, media)
    media.pause()
    return false
  }

  function prepareWindowHide(hidden: boolean) {
    playingBeforeHide = hidden && activePlay && !activePlay.media.paused ? activePlay : undefined
  }

  async function resumeAfterWindowHide(hidden: boolean): Promise<boolean> {
    const previous = playingBeforeHide
    playingBeforeHide = undefined
    // WKWebView may pause a running video while hiding its NSWindow. Only
    // resume once, on the same media and uninterrupted playback request.
    if (!hidden || !previous || previous !== activePlay || !previous.media.paused || previous.media.ended) return false
    return play(previous.media, false, { keepMuted: previous.media.muted })
  }

  function mute() {
    soundVersion += 1
    intent = 'muted'
    setMuted(true)
  }

  async function unmute(): Promise<boolean> {
    const media = options.getMedia()
    if (disposed || !media) return false
    const current = epoch
    const sound = ++soundVersion
    // Explicit sound is allowed on speakers, or without a working subscription,
    // but still requires a fresh snapshot and an unchanged local decision.
    await connection
    if (disposed || current !== epoch || sound !== soundVersion || media !== options.getMedia()) return false
    const checked = await query(current)
    if (!checked.current || !checked.state || sound !== soundVersion || media !== options.getMedia()) return false
    intent = 'manual'
    setMuted(false, media)
    return true
  }

  function dispose() {
    stop()
    disposed = true
    soundVersion += 1
    unlisten?.()
    unlisten = undefined
  }

  return { connect, stop, allowPlayback, beginPart, play, acceptPlaying, prepareWindowHide, resumeAfterWindowHide, mute, unmute, dispose }
}
