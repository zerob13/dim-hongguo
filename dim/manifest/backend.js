import { definePlugin } from '@arcships/rutis'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { createClient } from 'openhongguo'

// All business work remains in this module so a plugin reload replaces it too.
const ffmpegBinary = () => ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg'
const runFile = promisify(execFile)
const DIRECTORY = process.env.DIMCODE_HOME ? join(process.env.DIMCODE_HOME, 'plugin-data', 'dim-hongguo') : join(homedir(), '.dimcode-alpha', 'plugin-data', 'dim-hongguo')
const ERROR_MESSAGES = {
  ANONYMOUS_LIMITED: '匿名设备暂时无法获取播放地址，请稍后重试',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  TRANSPORT: '网络请求失败，请检查宿主机的网络',
  CONTENT_UNAVAILABLE: '内容已下架或暂时不可播放',
  DEVICE_REJECTED: '匿名设备未被接受，请稍后重试',
  RESOURCE_UNAVAILABLE: '播放文件暂时不可用，请重试',
}

function fail(message, code = 'unavailable') {
  return Object.assign(new Error(message), { code })
}

function publicError(error) {
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : 'unavailable'
  const localCodes = ['unavailable', 'invalid_params', 'timeout', 'unsupported_stream', 'invalid_cover', 'resource_gone', 'cancelled', 'resource_unavailable']
  const message = ERROR_MESSAGES[error?.code]
    ?? (localCodes.includes(code) && typeof error?.message === 'string' && !error.message.includes('://') ? error.message : '暂时无法完成操作，请稍后重试')
  return { code, message }
}

async function timeout(work, milliseconds = 45_000) {
  let timer
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('上游响应超时，请重试', 'timeout')), milliseconds)
    })])
  } finally {
    clearTimeout(timer)
  }
}

function profileStore(path) {
  return {
    async load() {
      try { return await readFile(path, 'utf8') } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
    },
    async save(json) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, json, { mode: 0o600 })
      await rename(temporary, path)
    },
    async reset() { await rm(path, { force: true }) },
  }
}

function validId(value) {
  return typeof value === 'string' && /^[0-9A-Za-z_-]{1,128}$/.test(value) ? value : undefined
}

function row(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    cover: item.cover_url,
    episodes: item.episode_count,
    heat: item.digg_count ?? item.comment_count,
  }
}

function createHongguo(dataDirectory) {
  const profile = join(dataDirectory, 'anonymous.json')
  const coverDirectory = join(dataDirectory, 'covers')
  const mediaDirectory = join(dataDirectory, 'media')
  let clientPromise
  let cachedItems = []
  let cachedAt = 0
  let refreshing
  const mediaKeys = new Map()
  const mediaJobs = new Map()

  function client() {
    clientPromise ??= createClient({ profile: profileStore(profile), retryAttempts: 2 }).catch(error => {
      clientPromise = undefined
      throw error
    })
    return clientPromise
  }

  async function discover() {
    const sdk = await client()
    const found = new Map()
    for await (const item of sdk.discoverAll({}, { maxPages: 6 })) {
      if (item?.id) found.set(item.id, row(item))
      if (found.size >= 36) break
    }
    return [...found.values()]
  }

  async function feed(refresh = false) {
    if (cachedItems.length && !refresh && Date.now() - cachedAt < 15 * 60_000) return cachedItems
    refreshing ??= discover().then(items => {
      if (!items.length) throw fail('暂时拿不到剧集列表')
      cachedItems = items
      cachedAt = Date.now()
      return items
    }).finally(() => { refreshing = undefined })
    return refreshing
  }

  async function search(term) {
    const result = await (await client()).search(term, {})
    return (result.items ?? []).filter(item => item?.id).map(row)
  }

  async function series(seriesId) {
    const sdk = await client()
    const result = await sdk.listEpisodes(seriesId)
    const episodes = (result.items ?? []).map(item => ({
      id: item.id,
      number: item.number,
      title: item.title,
      playable: item.playable !== false,
    }))
    return { series: row(await sdk.getSeries(seriesId)), episodes }
  }

  async function resolve(sdk, episodeId) {
    try { return await sdk.resolvePlayback(episodeId) }
    catch (error) {
      if (error?.code !== 'ANONYMOUS_LIMITED') throw error
      await sdk.resetDevice()
      return sdk.resolvePlayback(episodeId)
    }
  }

  async function decrypt(episodeId, signal) {
    const output = join(mediaDirectory, `${episodeId}.mp4`)
    if (existsSync(output)) return output
    if (mediaJobs.has(episodeId)) {
      signal?.throwIfAborted()
      return mediaJobs.get(episodeId)
    }
    const work = (async () => {
      const sdk = await client()
      const playback = await resolve(sdk, episodeId)
      const stream = playback?.playback?.streams?.find(item => item.url && !item.hls && !item.dash)
      const key = playback?.contentKey?.key
      if (!stream || !key || playback.playback?.protected !== true) throw fail('这集没有可处理的下载地址', 'CONTENT_UNAVAILABLE')
      mediaKeys.set(episodeId, { url: stream.url, key })
      await mkdir(mediaDirectory, { recursive: true, mode: 0o700 })
      const encrypted = join(mediaDirectory, `${episodeId}.part.enc`)
      const temporary = join(mediaDirectory, `${episodeId}.part.mp4`)
      try {
        const controller = new AbortController()
        const deadline = setTimeout(() => controller.abort(fail('下载超时，请重试')), 60_000)
        signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
        const response = await fetch(stream.url, { signal: controller.signal }).finally(() => clearTimeout(deadline))
        if (!response.ok) throw fail(`CDN HTTP ${response.status}`)
        if (!response.body) throw fail('CDN 未返回视频内容')
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > 2 * 1024 * 1024 * 1024) throw fail('单集文件超过插件的大小限制')
        await pipeline(Readable.fromWeb(response.body), createWriteStream(encrypted, { mode: 0o600 }), { signal })
        await runFile(ffmpegBinary(), ['-v', 'error', '-y', '-decryption_key', key, '-i', encrypted, '-map', '0', '-c', 'copy', '-tag:v', 'hvc1', '-movflags', '+faststart', temporary], { timeout: 180_000 })
        await rename(temporary, output)
        const names = (await readdir(mediaDirectory)).filter(name => /[.]mp4$/.test(name) && !name.includes('.part') && !name.startsWith(`${episodeId}.`))
        const files = await Promise.all(names.map(async name => ({ name, at: (await stat(join(mediaDirectory, name))).mtimeMs })))
        files.sort((a, b) => b.at - a.at)
        await Promise.all(files.slice(39).map(file => rm(join(mediaDirectory, file.name), { force: true })))
      } finally {
        await Promise.all([rm(encrypted, { force: true }), rm(temporary, { force: true })])
      }
      return output
    })().finally(() => mediaJobs.delete(episodeId))
    mediaJobs.set(episodeId, work)
    return work
  }

  async function play(episodeId, signal) {
    const sdk = await client()
    const result = await resolve(sdk, episodeId)
    const playback = result.playback
    const file = (playback?.streams ?? []).find(stream => stream.url && !stream.hls && !stream.dash)
    if (!file) throw fail('这集没有可播放的下载地址', 'CONTENT_UNAVAILABLE')
    if (playback.protected !== true) throw fail('浏览器不能直接播放这一集的流媒体格式', 'unsupported_stream')
    const key = result.contentKey?.key
    if (!key) throw fail('这一集没有内容密钥', 'RESOURCE_UNAVAILABLE')
    mediaKeys.set(episodeId, { url: file.url, key })
    return { episodeId, duration: playback.duration_seconds, path: await decrypt(episodeId, signal) }
  }

  async function cover(source) {
    const target = new URL(source)
    if (target.protocol !== 'https:' || !/(^|\.)(fqnovelpic\.com|byteimg\.com|pstatp\.com|snssdk\.com|bytecdn\.cn)$/.test(target.hostname)) {
      throw fail('封面地址不受支持', 'invalid_cover')
    }
    const hash = createHash('sha256').update(target.href).digest('hex')
    const output = join(coverDirectory, `${hash}.jpg`)
    if (existsSync(output)) return output
    const result = await fetch(target.href, { signal: AbortSignal.timeout(20_000) })
    if (!result.ok) throw fail('封面上游请求失败')
    await mkdir(coverDirectory, { recursive: true, mode: 0o700 })
    const temporary = join(coverDirectory, `${hash}.source`)
    try {
      await writeFile(temporary, Buffer.from(await result.arrayBuffer()), { mode: 0o600 })
      await runFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '--resampleWidth', '240', temporary, '--out', output], { timeout: 20_000 })
    } finally { await rm(temporary, { force: true }) }
    return output
  }
  return { feed, search, series, play, cover }
}

const sessionPart = (hongguo) => definePlugin({
  name: 'HongguoSession',
  inject: ['sessionMethods', 'sessionLifecycle', 'uiResources'],
  async apply(ctx) {
    const lifecycle = ctx.use('sessionLifecycle')
    const resources = ctx.use('uiResources')
    const published = new Map()
    const pending = new Map()
    let closing = false
    ctx.effect(() => { closing = true })
    if (!await lifecycle.activated()) return
    void lifecycle.closing().then(() => { closing = true })

    async function publish(path, mediaType) {
      const key = `${mediaType}:${path}`
      const existing = published.get(key)
      if (existing) return existing
      pending.set(key, (pending.get(key) ?? (async () => {
        if (closing) throw fail('当前会话正在关闭', 'resource_gone')
        const reference = await timeout(resources.publishFile({ path, mediaType }))
        published.set(key, reference)
        return reference
      })()))
      const work = pending.get(key)
      try { return await work } finally { if (pending.get(key) === work) pending.delete(key) }
    }

    async function cover(item) {
      if (typeof item.cover !== 'string' || !item.cover) return item
      try { return { ...item, cover: await publish(await hongguo.cover(item.cover), 'image/jpeg') } }
      catch (error) {
        console.warn(`[dim-hongguo] cover unavailable: ${error?.message ?? error}`)
        return { ...item, cover: undefined }
      }
    }

    async function many(items, work) {
      const result = [...items]
      for (let offset = 0; offset < result.length; offset += 6) {
        const batch = await Promise.all(result.slice(offset, offset + 6).map(work))
        batch.forEach((value, index) => { result[offset + index] = value })
      }
      return result
    }

    function argument(params, name, type = 'string') {
      const value = params[name]
      if (typeof value !== type || typeof value === 'string' && !value.trim()) throw fail(`缺少有效参数：${name}`, 'invalid_params')
      return typeof value === 'string' ? value.trim() : value
    }

    await ctx.use('sessionMethods').register('session.hongguo', [
      ...['feed', 'search', 'series', 'play'].map(name => ({ name: `session.hongguo.${name}`, mutating: name === 'play', interruption: 'drain', progress: false })),
    ], async (call, cancelled) => {
      try {
        if (closing) throw fail('当前会话正在关闭', 'resource_gone')
        const params = call.params
        const operation = call.method.slice('session.hongguo.'.length)
        if (operation === 'feed') return { kind: 'value', value: { items: await many(await hongguo.feed(params.refresh === true), cover) } }
        if (operation === 'search') return { kind: 'value', value: { items: await many(await hongguo.search(argument(params, 'term')), cover) } }
        if (operation === 'series') {
          const id = validId(argument(params, 'seriesId'))
          if (!id) throw fail('无效的剧集 ID', 'invalid_params')
          const result = await hongguo.series(id)
          return { kind: 'value', value: { ...result, series: await cover(result.series) } }
        }
        if (operation === 'play') {
          const id = validId(argument(params, 'episodeId'))
          if (!id) throw fail('无效的集数 ID', 'invalid_params')
          const controller = new AbortController()
          cancelled.then(() => controller.abort(fail('播放准备已取消', 'cancelled')))
          const result = await timeout(hongguo.play(id, controller.signal), 240_000)
          if (closing) throw fail('当前会话正在关闭', 'resource_gone')
          const reference = await publish(result.path, 'video/mp4')
          return { kind: 'value', value: { episodeId: id, duration: result.duration, sources: [{ kind: 'file', url: reference }] } }
        }
        return { code: 'unknown_method', message: '未知的红果操作' }
      } catch (error) {
        console.warn(`[dim-hongguo] ${call.method} failed: ${error?.code || error?.name || 'unknown error'}`)
        return publicError(error)
      }
    })
  },
})

export default definePlugin({
  name: 'HongguoPlugin',
  inject: ['partRegistry'],
  async apply(ctx, config = {}) {
    const dataDirectory = typeof config.dataDirectory === 'string' && config.dataDirectory.startsWith('/') ? config.dataDirectory : DIRECTORY
    const part = sessionPart(createHongguo(dataDirectory))
    await ctx.use('partRegistry').registerDefinition('session', 'HongguoSession', part)
  },
})
