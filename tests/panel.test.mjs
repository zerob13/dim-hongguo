import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { mount } from '../ui/panel.js'

function flush() { return new Promise(resolve => setImmediate(resolve)) }

function setup() {
  const saved = new Map(['document', 'localStorage'].map(key => [key, globalThis[key]]))
  const { window, document } = parseHTML('<html><body></body></html>')
  const memory = new Map()
  const writes = []
  const localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); memory.set(key, value) },
  }
  globalThis.document = document
  globalThis.localStorage = localStorage
  const root = document.createElement('div')
  document.body.append(root)
  const video = {
    paused: true, currentTime: 0, duration: 120, readyState: 1,
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true; this.dispatchEvent(new window.Event('pause')) },
    load() {},
  }
  const activity = []
  const calls = []
  const controller = new window.AbortController()
  const context = {
    signal: controller.signal,
    environment: { locale: 'en', sessionId: 'session-1', branchId: 'main' },
    observeEnvironment() { return () => {} },
    services: {
      resources: { url: ref => `local://${ref.sessionId}/${ref.id}` },
      session: { state: { observe(listener) { activity.push(listener); listener({ branch: { running: true, stopping: false }, sessionRunning: true }); return () => {} } } },
    },
    methods: new Proxy({}, { get: (_target, name) => async args => {
      calls.push({ name, args })
      const action = name.split('.').at(-1)
      if (action === 'play') return { episodeId: args.episodeId, duration: 120, sources: [{ kind: 'file', url: { sessionId: 'session-1', id: 'video-1' } }] }
      if (action === 'series') return { series: { id: 'series-1', title: 'Drama' }, episodes: [{ id: 'episode-1', number: 1 }, { id: 'episode-2', number: 2 }] }
      return { items: [{ id: 'series-1', title: 'Drama', episodes: 2, cover: { sessionId: 'session-1', id: 'cover-1' } }] }
    } }),
  }
  let dispose = () => {}
  const createElement = document.createElement.bind(document)
  const videoElement = Object.assign(createElement('video'), video)
  root.ownerDocument.createElement = (tag, ...args) => tag === 'video' ? videoElement : createElement(tag, ...args)
  dispose = mount(root, context)
  return {
    root, calls, writes, activity, video, controller, dispose, event: type => new window.Event(type),
    cleanup() { dispose(); for (const [key, value] of saved) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } },
  }
}

test('feed and playback use bound resource references, not caller-supplied identities', async () => {
  const app = setup()
  try {
    await flush()
    assert.deepEqual(app.calls[0], { name: 'session.hongguo.feed', args: {} })
    assert.equal(app.root.querySelectorAll('button.drama').length, 1)
    assert(app.root.querySelector('img').src.includes('local://session-1/cover-1'))
    app.root.querySelector('button.drama').click()
    await flush()
    app.root.querySelector('button.episode').click()
    await flush()
    assert.equal(app.calls.at(-1).name, 'session.hongguo.play')
    assert(!('sessionId' in app.calls.at(-1).args))
    assert.equal(app.root.querySelector('video').src, 'local://session-1/video-1')
  } finally { app.cleanup() }
})

test('progress throttles storage, pause saves once and idle finishes playback', async () => {
  const app = setup()
  try {
    await flush()
    app.root.querySelector('button.drama').click()
    await flush()
    app.root.querySelector('button.episode').click()
    await flush()
    const video = app.root.querySelector('video')
    video.currentTime = 2
    video.dispatchEvent(app.event('timeupdate'))
    const writes = app.writes.length
    video.currentTime = 3
    video.dispatchEvent(app.event('timeupdate'))
    assert.equal(app.writes.length, writes)
    video.currentTime = 7
    video.pause()
    assert.equal(app.writes.length, writes + 1)
    assert.equal(JSON.parse(localStorage.getItem('dim-hongguo.history.v1')).length, 1)
    video.play()
    app.activity[0]({ branch: { running: false, stopping: false }, sessionRunning: false })
    assert(video.paused)
    app.dispose()
    assert(!video.hasAttribute('src'))
  } finally { app.cleanup() }
})
