/**
 * dsh-web-read / worker/extract.mjs
 *
 * 这个函数会被序列化后在页面上下文中执行（Runtime.evaluate），因此它必须是
 * 完全自包含的：不引用 Node 变量、不访问宿主对象。它只读取当前文档并返回
 * 可 JSON 序列化的数据。
 *
 * 设计：
 *   - Readability 风格打分：文本长度、标点、段落数、tag/role/class 权重、链接密度；
 *   - 移除脚本、样式、导航、页脚、广告、cookie/订阅/分享等噪声；
 *   - HTML 输出走白名单序列化，绝不回传脚本原文、DOM 事件对象或内联事件属性；
 *   - 内联脚本只回传元数据（长度、类型、hash、能力标记），不回传源码。
 */

export function extractInPage(options) {
  'use strict'

  const opts = options && typeof options === 'object' ? options : {}
  const mode = opts.mode === 'html' ? 'html' : 'text'
  const maxChars = Math.max(1000, Math.min(Number(opts.maxChars) || 200000, 1000000))
  const includeLinks = opts.includeLinks === true
  const withScripts = opts.withScripts === true

  const doc = document
  const liveBody = doc.body || doc.documentElement
  if (!liveBody) {
    return { title: '', url: location.href, contentType: String(doc.contentType || ''), text: '', html: '', links: [], scripts: null, truncated: false }
  }

  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'DD', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL',
  ])
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS'])

  const normSpace = (value) => String(value ?? '').replace(/[\t\f\v\u00a0 ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  const cleanText = (value) => {
    const lines = String(value ?? '')
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.replace(/[\t\f\v\u00a0 ]+/g, ' ').trim())
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  const absUrl = (value) => {
    if (!value) return null
    try {
      const url = new URL(String(value), location.href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (url.username || url.password) return null
      url.hash = ''
      return url.href
    } catch {
      return null
    }
  }

  const truncateChars = (value, limit) => {
    const text = String(value ?? '')
    if (text.length <= limit) return { text, truncated: false }
    return { text: text.slice(0, Math.max(0, limit - 1)) + '…', truncated: true }
  }

  function textOf(node) {
    if (!node) return ''
    if (node.nodeType === 3) return String(node.nodeValue ?? '').replace(/\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = node.tagName
    if (SKIP.has(tag)) return ''
    if (tag === 'BR') return '\n'
    let output = ''
    for (const child of node.childNodes) output += textOf(child)
    if (tag === 'LI') return `\n• ${output.trim()}\n`
    if (BLOCK.has(tag)) return `\n${output}\n`
    return output
  }

  const title = truncateChars(normSpace(doc.title || ''), 300).text
  const pageUrl = String(location.href || '')

  const collectLinks = () => {
    if (!includeLinks) return []
    const links = []
    const seen = new Set()
    const anchors = doc.querySelectorAll('a[href]')
    for (const anchor of anchors) {
      if (links.length >= 100) break
      const href = absUrl(anchor.getAttribute('href'))
      if (!href || seen.has(href)) continue
      const text = truncateChars(normSpace(anchor.textContent || ''), 200).text
      if (!text) continue
      seen.add(href)
      links.push({ text, url: href })
    }
    return links
  }

  const fnv1a = (value) => {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, '0')
  }

  const collectScripts = () => {
    if (!withScripts) return null
    const external = []
    const inline = []
    let externalCount = 0
    let inlineCount = 0
    for (const script of doc.querySelectorAll('script')) {
      const src = script.getAttribute('src')
      if (src) {
        externalCount += 1
        if (external.length < 100) {
          const absolute = absUrl(src)
          if (absolute) {
            const type = script.getAttribute('type')
            external.push({
              src: absolute,
              type: type ? String(type).slice(0, 80) : null,
              async: script.async === true,
              defer: script.defer === true,
              module: String(type || '').toLowerCase().includes('module'),
            })
          }
        }
        continue
      }
      const source = String(script.textContent || '')
      if (!source.trim()) continue
      inlineCount += 1
      if (inline.length >= 30) continue
      const type = String(script.getAttribute('type') || 'text/javascript').toLowerCase().slice(0, 80)
      const flags = []
      if (/\bfetch\s*\(/.test(source)) flags.push('fetch')
      if (/XMLHttpRequest/.test(source)) flags.push('xhr')
      if (/\bimport\s*\(/.test(source)) flags.push('dynamic-import')
      if (/new\s+WebSocket/.test(source)) flags.push('websocket')
      if (/MutationObserver/.test(source)) flags.push('mutation-observer')
      if (/addEventListener\s*\(\s*['"]DOMContentLoaded['"]/.test(source)) flags.push('domcontentloaded')
      if (/requestAnimationFrame/.test(source)) flags.push('animation-frame')
      if (/\.innerHTML\s*=|document\.write|insertAdjacentHTML|\.appendChild\s*\(|\.append\s*\(/.test(source)) flags.push('dom-write')
      if (/getElementById|querySelector/.test(source)) flags.push('dom-query')
      if (/\b(jQuery|\$)\s*\(/.test(source)) flags.push('jquery')
      if (/application\/ld\+json/.test(type) || /application\/ld\+json/.test(source.slice(0, 200))) flags.push('structured-data')
      inline.push({
        index: inlineCount - 1,
        chars: source.length,
        type,
        flags,
        hash: fnv1a(source),
      })
    }

    const probe = (typeof window !== 'undefined' && window.__dshWebReadProbe) || {}
    const mutations = Number(probe.domMutations) || 0
    const dclAt = Number(probe.dclAt) || 0
    let postLoadResources = 0
    try {
      const entries = performance.getEntriesByType('resource')
      postLoadResources = entries.filter((entry) => dclAt > 0 && entry.startTime > dclAt + 5).length
    } catch {
      postLoadResources = 0
    }
    const signals = []
    if (mutations >= 5) signals.push('dom-mutated')
    if (postLoadResources > 0) signals.push('post-load-resources')
    if (inline.some((entry) => entry.flags.includes('fetch') || entry.flags.includes('xhr'))) signals.push('script-network-api')
    if (inline.some((entry) => entry.flags.includes('dynamic-import'))) signals.push('dynamic-import')
    if (inline.some((entry) => entry.flags.includes('websocket'))) signals.push('websocket')
    if (inline.some((entry) => entry.flags.includes('dom-write'))) signals.push('script-dom-write')
    return {
      external_count: externalCount,
      inline_count: inlineCount,
      external,
      inline,
      dynamic: {
        detected: signals.length > 0,
        signals,
        dom_mutations: mutations,
        post_load_resources: postLoadResources,
      },
    }
  }

  const links = collectLinks()
  const scripts = collectScripts()

  const malformed = /(^|[\s_-])(ad|ads|advert|advertisement|sponsor|sponsored|promo|banner|cookie|consent|gdpr|newsletter|subscribe|social|share|related|recommend|sidebar|nav|navbar|menu|footer|header|modal|popup|paywall|login|signup|breadcrumb|toolbar|pagination|pager|comment|comments|disqus|outbrain|taboola|shopping|cart)([\s_-]|$)/i
  const positive = /(^|[\s_-])(article|content|entry|main|post|story|body|text|read)([\s_-]|$)/i
  const REMOVE_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed',
    'applet', 'svg', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area',
    'form', 'button', 'input', 'select', 'option', 'textarea', 'label', 'fieldset',
    'legend', 'nav', 'footer', 'header', 'aside', 'dialog', 'menu',
    '[hidden]', '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="complementary"]', '[role="menu"]', '[role="dialog"]',
  ].join(',')
  const rootNode = liveBody.cloneNode(true)
  for (const node of rootNode.querySelectorAll(REMOVE_SELECTOR)) node.remove()
  for (const node of rootNode.querySelectorAll('[class],[id]')) {
    const identity = `${node.getAttribute('class') || ''} ${node.getAttribute('id') || ''}`.toLowerCase()
    if (!malformed.test(identity)) continue
    if (node.querySelectorAll('p').length >= 4 && node.textContent.length > 1500) continue
    node.remove()
  }

  const treeWalker = doc.createTreeWalker(rootNode, NodeFilter.SHOW_COMMENT)
  const comments = []
  while (treeWalker.nextNode()) comments.push(treeWalker.currentNode)
  for (const comment of comments) comment.remove()

  let contentRoot = rootNode
  let contentText = cleanText(textOf(rootNode))

  const scoreOf = (element) => {
    const text = cleanText(textOf(element))
    if (text.length < 80) return -1
    const anchors = [...element.querySelectorAll('a')]
    const linkText = anchors.reduce((sum, anchor) => sum + cleanText(anchor.textContent || '').length, 0)
    const density = Math.min(1, linkText / Math.max(1, text.length))
    if (density > 0.55 && text.length < 2000) return -1
    const punctuation = (text.match(/[,，、;；。.!?]/g) || []).length
    const paragraphs = element.querySelectorAll('p').length
    let score = Math.min(55, text.length / 80)
    score += Math.min(24, punctuation * 1.2)
    score += Math.min(20, paragraphs * 2)
    const tag = element.tagName
    if (tag === 'ARTICLE' || element.getAttribute('role') === 'article') score += 28
    else if (tag === 'MAIN' || element.getAttribute('role') === 'main') score += 22
    else if (tag === 'SECTION') score += 6
    else if (tag === 'BLOCKQUOTE' || tag === 'PRE') score += 4
    else if (tag === 'TD' || tag === 'DIV') score += 2
    const identity = `${element.getAttribute('class') || ''} ${element.getAttribute('id') || ''}`
    if (positive.test(identity)) score += 12
    if (malformed.test(identity)) score -= 28
    return score * (1 - density * 0.6)
  }

  const candidates = [...rootNode.querySelectorAll('article,main,[role="main"],section,div,td,pre,blockquote,p')]
    .map((element) => ({ element, score: scoreOf(element) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)

  if (candidates.length > 0) {
    const top = candidates[0].element
    const container = doc.createElement('div')
    const parent = top.parentElement
    if (parent && parent !== rootNode) {
      for (const sibling of parent.children) {
        if (sibling === top) {
          container.appendChild(sibling)
          continue
        }
        if (SKIP.has(sibling.tagName) || sibling.matches(REMOVE_SELECTOR)) continue
        const siblingScore = scoreOf(sibling)
        const siblingText = cleanText(textOf(sibling))
        if (siblingText.length >= 80 && siblingScore > 8) container.appendChild(sibling)
      }
    } else {
      container.appendChild(top)
    }
    const scoredText = cleanText(textOf(container))
    if (scoredText.length >= Math.min(250, contentText.length)) {
      contentRoot = container
      contentText = scoredText
    }
  }

  if (contentText.length < 200) {
    contentRoot = rootNode
    contentText = cleanText(textOf(rootNode))
  }
  if (!contentText) {
    contentRoot = liveBody
    contentText = cleanText(textOf(liveBody))
  }

  let truncated = false
  const textResult = truncateChars(contentText, maxChars)
  contentText = textResult.text
  truncated = textResult.truncated

  const ALLOWED_TAGS = new Set([
    'ARTICLE', 'MAIN', 'SECTION', 'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR',
    'TH', 'TD', 'BLOCKQUOTE', 'PRE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'U', 'S',
    'BR', 'HR', 'A', 'SPAN', 'MARK', 'SUP', 'SUB', 'FIGURE', 'FIGCAPTION', 'TIME',
  ])
  const KEEP_ATTR = new Set(['href', 'title', 'datetime', 'colspan', 'rowspan'])
  const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const htmlLimit = Math.min(4_000_000, Math.max(4000, maxChars * 4))
  let htmlOut = ''
  let htmlTruncated = false

  const appendHtml = (chunk) => {
    if (htmlTruncated) return
    if (htmlOut.length + chunk.length > htmlLimit) {
      htmlOut += chunk.slice(0, Math.max(0, htmlLimit - htmlOut.length))
      htmlTruncated = true
      return
    }
    htmlOut += chunk
  }

  const sanitizeNode = (node, depth) => {
    if (htmlTruncated) return
    if (node.nodeType === 3) {
      appendHtml(escapeHtml(node.nodeValue))
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.tagName
    if (SKIP.has(tag) || tag === 'FORM' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (!ALLOWED_TAGS.has(tag)) {
      for (const child of node.childNodes) sanitizeNode(child, depth)
      return
    }
    if (depth > 30) {
      appendHtml(escapeHtml(node.textContent || ''))
      return
    }
    appendHtml(`<${tag.toLowerCase()}`)
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase()
      if (!KEEP_ATTR.has(name)) continue
      if (name === 'href') {
        const href = absUrl(attribute.value)
        if (href) appendHtml(` href="${escapeHtml(href)}"`)
        continue
      }
      if (name === 'colspan' || name === 'rowspan') {
        const number = Number(attribute.value)
        if (Number.isInteger(number) && number > 0 && number <= 100) appendHtml(` ${name}="${number}"`)
        continue
      }
      appendHtml(` ${name}="${escapeHtml(attribute.value).slice(0, 300)}"`)
    }
    if (tag === 'A') appendHtml(' rel="noopener noreferrer nofollow"')
    appendHtml('>')
    for (const child of node.childNodes) sanitizeNode(child, depth + 1)
    appendHtml(`</${tag.toLowerCase()}>`)
  }

  if (mode === 'html') {
    for (const child of contentRoot.childNodes) sanitizeNode(child, 0)
    if (htmlTruncated) truncated = true
  }

  return {
    title,
    url: pageUrl,
    contentType: String(doc.contentType || ''),
    text: contentText,
    html: mode === 'html' ? htmlOut : '',
    links,
    scripts,
    truncated,
    textChars: contentText.length,
    htmlChars: mode === 'html' ? htmlOut.length : 0,
  }
}
