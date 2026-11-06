const HISTORY_KEY = 'dim-hongguo.history.v1'
const PAGE_SIZE = 12

export function mount(root, context) {
  const recordedHistory = new Map()
  /** @typedef {{ id: string; number: number }} Episode */
  /** @typedef {{ id: string; title: string; description?: string; episodes?: number; cover?: import('dimcode/ui').ResourceRef }} Drama */
  /** @type {(Drama & { episodeList: Episode[] }) | null} */
  const call = context.methods['session.hongguo.feed'] ? (name, input) => context.methods[name](input) : async () => { throw new Error('插件 Session 方法不可用') }
  const language = () => context.environment.locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const copy = {
    zh: { title: '摸鱼短剧', search: '搜索短剧', submit: '搜索', refresh: '换一批', recommend: '推荐一部', history: '观看历史', empty: '没有找到短剧', retry: '重试', loading: '正在准备这一集，首次播放可能需要一些时间…', played: '集看过', back: '返回列表', resume: '续播', restart: '从头播放', finished: 'Agent 完成了，已为你暂停', next: '下一集', prev: '上一集', episodes: '选集', episode: '第 {n} 集', total: '共 {n} 集', forget: '移除', error: '加载失败：', autoplay: '点击播放即可继续', historyEmpty: '还没有观看记录' },
    en: { title: 'Drama Break', search: 'Search dramas', submit: 'Search', refresh: 'Refresh', recommend: 'Recommended', history: 'History', empty: 'No dramas found', retry: 'Retry', loading: 'Preparing this episode; the first load may take a while…', played: 'watched', back: 'All dramas', resume: 'Resume', restart: 'Restart', finished: 'Agent finished. Paused for you.', next: 'Next', prev: 'Previous', episodes: 'Episodes', episode: 'Episode {n}', total: '{n} episodes', forget: 'Remove', error: 'Could not load: ', autoplay: 'Select play to continue', historyEmpty: 'Nothing watched yet' },
  }
  const t = (key, values = {}) => (copy[language()][key] ?? key).replaceAll(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`)
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value, { signal: context.signal })
      else if (key === 'disabled') node.disabled = value
      else if (value !== undefined && value !== null) node.setAttribute(key, value === true ? '' : String(value))
    }
    node.append(...children.filter(Boolean))
    return node
  }
  const button = (label, onClick, cls = '') => el('button', { type: 'button', text: label, onclick: onClick, class: cls, 'aria-label': label })
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', name === 'next' ? 'M6 5.5v13l9-6.5zM16 5h2.5v14H16z' : name === 'prev' ? 'M18 5.5v13l-9-6.5zM8 5H5.5v14H8z' : 'M15 5l-7 7 7 7')
    if (name !== 'back') path.classList.add('filled')
    svg.append(path)
    return svg
  }
  const time = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
    const total = Math.floor(seconds)
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  const link = el('link', { rel: 'stylesheet', href: new URL('./panel.css', import.meta.url).href })
  const shell = el('div', { class: 'hg' })
  const header = el('header')
  const content = el('main')
  shell.append(header, content)
  root.replaceChildren(link, shell)
  const state = { page: 0, items: [], total: 0, searchTerm: '', searching: false, selected: null, history: [] }
  let requestGeneration = 0
  let lastActivity = false
  let loadTask = Promise.resolve()
  const resources = context.services.resources
  const persistHistory = () => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)) } catch {}
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    if (Array.isArray(parsed)) state.history = parsed.filter(item => item && typeof item.seriesId === 'string' && typeof item.title === 'string' && Number.isInteger(item.number) && Number.isFinite(item.time)).slice(0, 30)
  } catch {}
  const remember = (series, episode, seconds) => {
    if (!series || !episode) return
    const entry = { seriesId: series.id, title: series.title || t('title'), number: episode.number, episodeId: episode.id, time: Math.max(0, seconds), at: Date.now() }
    const previous = recordedHistory.get(`${series.id}:${episode.id}`)
    if (previous && entry.time - previous > -1 && entry.time - previous < 5) return
    recordedHistory.set(`${series.id}:${episode.id}`, entry.time)
    state.history = [entry, ...state.history.filter(item => item.seriesId !== series.id)].slice(0, 30)
    persistHistory()
  }
  const track = (promise) => { loadTask = promise; return promise }
  const callLive = async (name, input) => {
    // Queue preparation so the single anonymous upstream identity is not changed by a superseded request.
    const task = track(loadTask.catch(() => {}).then(() => {
      if (context.signal.aborted) throw new DOMException('Panel closed', 'AbortError')
      return call(`session.hongguo.${name}`, input)
    }))
    return task
  }
  const showError = (error, retry) => {
    if (error?.name === 'AbortError' || context.signal.aborted) return
    content.replaceChildren(el('div', { class: 'error', role: 'alert' }, `${t('error')}${error?.message || error}`, button(t('retry'), retry)))
  }
  const showLoading = () => {
    header.replaceChildren(el('h2', { text: t('title') }))
    content.replaceChildren(el('div', { class: 'busy', role: 'status' }, el('span', { class: 'spinner' })))
  }
  const cover = (item, className = 'poster') => {
    const image = el('img', { class: className, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    if (item?.cover) {
      try { image.src = resources.url(item.cover) } catch {}
    }
    image.addEventListener('error', () => { image.replaceWith(el('span', { class: className + ' placeholder', 'aria-hidden': 'true', text: item?.title?.slice(0, 1) || '▶' })) }, { signal: context.signal })
    return image
  }
  const disposeVideo = () => {
    const video = shell.querySelector('video')
    if (video) { video.pause(); video.removeAttribute('src'); video.load() }
  }
  const openHistory = async (entry) => {
    const gen = ++requestGeneration
    try {
      const details = await callLive('series', { seriesId: entry.seriesId })
      if (gen !== requestGeneration || context.signal.aborted) return
      const selected = { ...details.series, cover: (await coverFor(details.series)) || entry.cover, episodeList: details.episodes }
      if (gen !== requestGeneration || context.signal.aborted) return
      state.selected = selected
      playEpisode(selected, episodeOf(details.episodes, entry.number))
    } catch (error) { showError(error, loadFeed) }
  }
  const episodeOf = (episodes, number) => episodes.find(item => item.number === number) || episodes[0]
  const loadFeed = async (refresh = false) => {
    const gen = ++requestGeneration
    state.searchTerm = ''
    state.page = refresh ? state.page + 1 : 0
    showLoading()
    try {
      const body = await callLive('feed', refresh ? { refresh: true } : {})
      if (gen !== requestGeneration || context.signal.aborted) return
      state.items = Array.isArray(body.items) ? body.items : []
      renderFeed()
    } catch (error) { showError(error, loadFeed) }
  }
  const search = async (term) => {
    const gen = ++requestGeneration
    state.searchTerm = term
    showLoading()
    try {
      const body = await callLive('search', { term })
      if (gen !== requestGeneration || context.signal.aborted) return
      state.items = Array.isArray(body.items) ? body.items : []
      renderFeed()
    } catch (error) { showError(error, () => search(term)) }
  }
  const drawHistory = () => {
    if (!state.history.length) return null
    const section = el('section', { class: 'history', 'aria-label': t('history') }, el('div', { class: 'label', text: t('history') }))
    for (const entry of state.history.slice(0, 6)) {
      section.append(el('div', { class: 'history-row' }, button('', () => openHistory(entry), 'history-open'), button(t('forget'), () => {
        state.history = state.history.filter(item => item.seriesId !== entry.seriesId)
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)) } catch {}
        renderFeed()
      }, 'forget')))
      const main = section.lastElementChild.firstElementChild
      main.append(el('span', { class: 'name', text: entry.title }), el('span', { class: 'at', text: `${t('episode', { n: entry.number })} · ${time(entry.time)}` }))
    }
    return section
  }
  const renderFeed = () => {
    if (context.signal.aborted) return
    state.searching = true
    const refresh = button('⟳', () => loadFeed(true), 'icon')
    refresh.setAttribute('aria-label', t('refresh'))
    header.replaceChildren(el('div', { class: 'grow' }, el('h2', { text: t('title') })), refresh)
    const form = el('form', { class: 'search', role: 'search' }, el('input', { type: 'search', name: 'term', placeholder: t('search'), 'aria-label': t('search'), required: true, maxlength: 100 }), el('button', { type: 'submit', text: t('submit'), class: 'primary' }))
    form.addEventListener('submit', event => { event.preventDefault(); search(new FormData(form).get('term').toString().trim()) }, { signal: context.signal })
    content.replaceChildren(form)
    if (state.searchTerm) content.append(el('div', { class: 'label', text: `${t('search')}：${state.searchTerm}` }))
    const page = state.searchTerm ? state.items : state.items.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)
    const featured = !state.searchTerm && page.length ? page[(state.history.length + state.page) % page.length] : null
    if (featured) {
      content.append(el('div', { class: 'label', text: t('recommend') }), button('', () => openSeries(featured), 'feature'))
      const card = content.lastElementChild
      card.append(cover(featured), el('span', { class: 'copy' }, el('h3', { text: featured.title }), el('p', { text: featured.description || featured.title }), el('div', { class: 'meta', text: t('total', { n: featured.episodes || '?' }) })))
    }
    const grid = el('div', { class: 'grid' })
    for (const item of page) {
      const card = button('', () => openSeries(item), 'drama')
      card.append(cover(item), el('span', { class: 'title', text: item.title }), el('span', { class: 'count', text: t('total', { n: item.episodes || '?' }) }))
      grid.append(card)
    }
    content.append(page.length ? grid : el('div', { class: 'empty', text: t('empty') }))
    const history = drawHistory()
    if (history) content.append(history)
    else content.append(el('div', { class: 'status', text: t('historyEmpty') }))
    content.scrollTop = 0
  }
  const openSeries = async (series) => {
    const gen = ++requestGeneration
    showLoading()
    try {
      const details = await callLive('series', { seriesId: series.id })
      if (gen !== requestGeneration || context.signal.aborted) return
      state.selected = { ...details.series, cover: details.series.cover || series.cover || state.items.find(item => item.id === series.id)?.cover, episodeList: details.episodes }
      const entry = state.history.find(item => item.seriesId === series.id)
      renderEpisodes(state.selected, entry)
    } catch (error) { showError(error, loadFeed) }
  }
  const coverFor = async (series) => {
    if (!series?.cover) return undefined
    if (series.cover.id) return series.cover
    if (typeof series.cover === 'string') {
      try { const result = await context.methods['session.hongguo.cover']({ url: series.cover }); return result?.reference } catch { return undefined }
    }
    return undefined
  }
  const playEpisode = async (seriesInput, episode, from = 0) => {
    const gen = ++requestGeneration
    const series = state.selected || seriesInput
    if (!episode?.id) { content.replaceChildren(el('div', { class: 'empty', text: t('empty') })); return }
    disposeVideo()
    const video = el('video', { controls: true, playsinline: true, preload: 'metadata', 'aria-label': `${series.title} · ${t('episode', { n: episode.number })}` })
    const metadata = new AbortController()
    context.signal.addEventListener('abort', () => metadata.abort(), { once: true })
    const stage = el('div', { class: 'stage' }, video, el('div', { class: 'veil', role: 'status' }, el('span', { class: 'spinner' }), el('span', { text: t('loading') })))
    renderPlayer(series, episode, stage, video, null)
    video.addEventListener('timeupdate', () => {
      if (Number.isFinite(video.currentTime) && video.currentTime > 0) remember(series, episode, video.currentTime)
    }, { signal: context.signal })
    video.addEventListener('pause', () => { if (!video.ended) remember(series, episode, video.currentTime) }, { signal: context.signal })
    video.addEventListener('ended', () => {
      remember(series, episode, 0)
      nextEpisode(series, episode)
    }, { signal: context.signal })
    try {
      const playback = await callLive('play', { episodeId: episode.id })
      if (gen !== requestGeneration || context.signal.aborted) return
      const source = playback.sources?.find(item => item.kind === 'file' && item.url)
      if (!source) throw new Error('这一集暂时没有可播放的文件')
      video.src = resources.url(source.url)
      if (series.cover) {
        try { video.poster = resources.url(series.cover) } catch {}
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('视频加载超时，请重试')), 120_000)
        if (video.readyState >= 1) { clearTimeout(timer); return resolve() }
        video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve() }, { once: true, signal: metadata.signal })
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('浏览器无法解码这一集，请换一集或换用支持 HEVC 的浏览器')) }, { once: true, signal: metadata.signal })
        video.addEventListener('stalled', () => {
          const message = stage.querySelector('.veil span:last-child')
          if (message) message.textContent = '视频仍在缓冲，请稍候…'
        }, { signal: metadata.signal })
        metadata.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          if (!context.signal.aborted) reject(new DOMException('Episode replaced', 'AbortError'))
        }, { once: true })
      }).finally(() => metadata.abort())
      if (gen !== requestGeneration || context.signal.aborted) return
      stage.querySelector('.veil')?.remove()
      const history = state.history.find(item => item.seriesId === series.id)
      const resumeAt = from || (episode.number === history?.number ? Math.min(history.time, Math.max(0, (video.duration || history.time) - 10)) : 0)
      if (resumeAt > 10 && video.duration - resumeAt > 10) {
        const resume = el('div', { class: 'resume' }, el('span', { text: `已看到 ${time(resumeAt)}` }))
        resume.append(button(t('resume'), () => { video.currentTime = resumeAt; resume.remove(); video.play().catch(() => {}) }), button(t('restart'), () => { resume.remove(); video.currentTime = 0; video.play().catch(() => {}) }))
        stage.append(resume)
      }
      video.play().catch(() => {})
    } catch (error) {
      if (gen !== requestGeneration || context.signal.aborted) return
      const veil = stage.querySelector('.veil')
      if (veil) {
        veil.replaceChildren(el('span', { text: error?.message || String(error) }), button(t('episodes'), () => renderEpisodes(series)))
      }
    }
  }
  const nextEpisode = (series, episode) => {
    const next = state.selected?.episodeList?.find(item => item.number === episode.number + 1)
    if (next) playEpisode(state.selected, next)
  }
  const renderPlayer = (series, current, stage, video, error) => {
    header.replaceChildren(button(t('back'), () => renderEpisodes(state.selected || series)), el('h2', { class: 'grow', text: series.title }))
    content.replaceChildren(stage, error ? el('div', { class: 'error', text: error.message, role: 'alert' }) : '', el('div', { class: 'overview' }, el('div', { class: 'player-title', text: series.title }), el('div', { class: 'subtitle', text: t('episode', { n: current.number }) })), el('div', { class: 'controls' }, button('', () => changeEpisode(series, current, -1), 'icon'), button('', () => changeEpisode(series, current, 1), 'icon')))
    const icons = content.querySelectorAll('.controls .icon')
    icons[0].replaceChildren(icon('prev')); icons[0].setAttribute('aria-label', t('prev'))
    icons[1].replaceChildren(icon('next')); icons[1].setAttribute('aria-label', t('next'))
    const previous = state.selected?.episodeList?.some(item => item.number === current.number - 1)
    const next = state.selected?.episodeList?.some(item => item.number === current.number + 1)
    icons[0].disabled = !previous; icons[1].disabled = !next
    content.append(el('div', { class: 'status', role: 'status', text: t('autoplay') }))
  }
  const changeEpisode = (series, current, delta) => {
    const next = state.selected?.episodeList?.find(item => item.number === current.number + delta)
    if (next) { remember(series, current, 0); playEpisode(series, next) }
  }
  const renderEpisodes = (series, resumeEntry = null) => {
    if (!series) return loadFeed()
    requestGeneration++
    disposeVideo()
    header.replaceChildren(button(t('back'), () => { state.selected = null; loadFeed() }))
    const episodes = state.selected?.episodeList || []
    content.replaceChildren(el('h3', { text: series.title }), el('div', { class: 'label', text: t('total', { n: episodes.length || series.episodes || '?' }) }), el('div', { class: 'episodes' }))
    if (resumeEntry) {
      const entry = { ...resumeEntry, cover: series.cover }
      content.append(el('h4', { text: t('episode', { n: entry.number }) }), cover(entry), button(t('resume'), () => playEpisode(series, entry), 'primary'))
    } else {
      const grid = content.querySelector('.episodes')
      for (const episode of episodes) {
        grid.append(button(String(episode.number), () => playEpisode(series, episode), 'episode'))
      }
    }
    if (series.description) content.append(el('p', { class: 'description', text: series.description }))
  }
  showLoading()
  void loadFeed().catch(error => showError(error, loadFeed))
  context.observeEnvironment(() => {
    const main = shell.querySelector('h2')
    if (main) main.textContent = t('title')
  })
  context.services.session.state.observe(activity => {
    if (lastActivity && !activity.sessionRunning) {
      const video = shell.querySelector('video')
      if (video && !video.paused) {
        video.pause()
        const notice = content.querySelector('.status')
        if (notice) notice.textContent = t('finished')
      }
    }
    lastActivity = activity.sessionRunning
  })
  context.signal.addEventListener('abort', () => {
    requestGeneration++
    disposeVideo()
  }, { once: true })
  return () => { requestGeneration++; disposeVideo(); root.replaceChildren() }
}
