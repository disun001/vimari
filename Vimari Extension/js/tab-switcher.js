/*
 * Tab switcher: an Arc-style floating bar listing the tabs of the current
 * window. Typing fuzzy-filters by title and URL, arrows move, Enter switches,
 * Esc closes.
 *
 * Rendered in a shadow root so page CSS can't affect it. Key events inside
 * the bar never reach the page or Mousetrap.
 */
var TabSwitcher = (function () {
    'use strict'

    var api = {}
    var host = null
    var root = null
    var input = null
    var listEl = null
    var communicator = null
    var allTabs = []
    var results = []
    var selected = 0
    var loaded = false

    // ---------------------------------------------------------------
    // Fuzzy matching
    // ---------------------------------------------------------------

    /*
     * Subsequence match of `query` in `text` (case-insensitive).
     * Returns null when there is no match, otherwise a score (higher is
     * better): consecutive characters and word starts earn bonuses, early
     * matches are preferred.
     */
    function fuzzyScore(query, text) {
        if (!query) { return 0 }
        var q = query.toLowerCase()
        var t = text.toLowerCase()
        var score = 0
        var ti = 0
        var prev = -2

        for (var qi = 0; qi < q.length; qi++) {
            var found = t.indexOf(q[qi], ti)
            if (found === -1) { return null }

            score += 1
            if (found === prev + 1) { score += 5 }
            if (found === 0 || /[\s\-_./:?=&#]/.test(t[found - 1])) { score += 4 }
            score -= Math.min(found - ti, 10) * 0.1

            prev = found
            ti = found + 1
        }
        // Prefer shorter texts when everything else is equal.
        return score - t.length * 0.01
    }

    /*
     * Space-separated tokens must all match. Each token is scored against
     * the title (weighted up) and the URL; the better of the two counts.
     */
    function scoreTab(query, tab) {
        var tokens = query.trim().split(/\s+/).filter(Boolean)
        if (tokens.length === 0) { return 0 }

        var total = 0
        for (var i = 0; i < tokens.length; i++) {
            var titleScore = fuzzyScore(tokens[i], tab.title || '')
            var urlScore = fuzzyScore(tokens[i], tab.url || '')
            if (titleScore === null && urlScore === null) { return null }
            total += Math.max(
                titleScore === null ? -Infinity : titleScore * 1.5,
                urlScore === null ? -Infinity : urlScore
            )
        }
        return total
    }

    /*
     * Empty query keeps the incoming (most recently used) order. Otherwise
     * sort by score; ties keep recency order.
     */
    function filterTabs(query, tabs) {
        if (!query.trim()) { return tabs.slice() }
        return tabs
            .map(function (tab, index) {
                return { tab: tab, index: index, score: scoreTab(query, tab) }
            })
            .filter(function (r) { return r.score !== null })
            .sort(function (a, b) { return (b.score - a.score) || (a.index - b.index) })
            .map(function (r) { return r.tab })
    }

    function domainOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, '') } catch (e) { return url || '' }
    }

    // ---------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------

    var STYLE = '\
:host { all: initial; }\
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; justify-content: center; align-items: flex-start; padding-top: 14vh; background: rgba(0,0,0,0.25); font: 14px -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }\
.bar { width: min(640px, 92vw); background: #fff; color: #1d1d1f; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.08); overflow: hidden; }\
input { box-sizing: border-box; width: 100%; padding: 16px 18px; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 17px; border-bottom: 1px solid rgba(128,128,128,0.25); }\
.list { max-height: 50vh; overflow-y: auto; padding: 6px; }\
.row { display: flex; align-items: baseline; gap: 10px; padding: 9px 12px; border-radius: 8px; cursor: pointer; }\
.row.sel { background: rgba(0,122,255,0.15); }\
.title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\
.domain { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.55; font-size: 12px; }\
.badge { flex: none; font-size: 11px; opacity: 0.55; }\
.empty { padding: 16px 18px; opacity: 0.6; }\
@media (prefers-color-scheme: dark) { .bar { background: #2b2b2e; color: #f5f5f7; box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1); } .row.sel { background: rgba(10,132,255,0.35); } }'

    function build() {
        host = document.createElement('div')
        root = host.attachShadow({ mode: 'closed' })

        var style = document.createElement('style')
        style.textContent = STYLE

        var backdrop = document.createElement('div')
        backdrop.className = 'backdrop'
        backdrop.addEventListener('mousedown', function (e) {
            if (e.target === backdrop) { api.close() }
        })

        var bar = document.createElement('div')
        bar.className = 'bar'

        input = document.createElement('input')
        input.type = 'text'
        input.placeholder = 'Search tabs…'
        input.setAttribute('autocomplete', 'off')
        input.setAttribute('autocorrect', 'off')
        input.setAttribute('spellcheck', 'false')
        input.addEventListener('input', refresh)
        ;['keydown', 'keypress', 'keyup'].forEach(function (type) {
            input.addEventListener(type, function (e) {
                // Keep every key away from the page and Mousetrap.
                e.stopPropagation()
                if (type === 'keydown') { onKeyDown(e) }
            })
        })

        listEl = document.createElement('div')
        listEl.className = 'list'

        bar.appendChild(input)
        bar.appendChild(listEl)
        backdrop.appendChild(bar)
        root.appendChild(style)
        root.appendChild(backdrop)
    }

    function onKeyDown(e) {
        if (e.key === 'Escape') {
            e.preventDefault()
            api.close()
        } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            move(1)
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            move(-1)
        } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(selected)
        }
    }

    function move(step) {
        if (results.length === 0) { return }
        selected = (selected + step + results.length) % results.length
        render()
    }

    function choose(index) {
        var tab = results[index]
        if (!tab) { return }
        api.close()
        if (!tab.current) { communicator.requestActivateTab(tab.id) }
    }

    function firstSelectable(list, hasQuery) {
        // With no query, skip the current tab so Enter flips to the previous one.
        if (!hasQuery && list.length > 1 && list[0].current) { return 1 }
        return 0
    }

    function refresh() {
        var query = input.value
        results = filterTabs(query, allTabs)
        selected = firstSelectable(results, query.trim().length > 0)
        render()
    }

    function render() {
        while (listEl.firstChild) { listEl.removeChild(listEl.firstChild) }

        if (!loaded) {
            listEl.appendChild(message('Loading tabs…'))
            return
        }
        if (results.length === 0) {
            listEl.appendChild(message('No matching tabs'))
            return
        }

        results.forEach(function (tab, index) {
            var row = document.createElement('div')
            row.className = 'row' + (index === selected ? ' sel' : '')

            var title = document.createElement('span')
            title.className = 'title'
            title.textContent = tab.title || tab.url || 'Untitled'

            var domain = document.createElement('span')
            domain.className = 'domain'
            domain.textContent = domainOf(tab.url)

            row.appendChild(title)
            row.appendChild(domain)

            if (tab.current) {
                var badge = document.createElement('span')
                badge.className = 'badge'
                badge.textContent = 'current'
                row.appendChild(badge)
            }

            row.addEventListener('mousedown', function (e) {
                e.preventDefault()
                choose(index)
            })
            listEl.appendChild(row)

            if (index === selected && row.scrollIntoView) {
                row.scrollIntoView({ block: 'nearest' })
            }
        })
    }

    function message(text) {
        var el = document.createElement('div')
        el.className = 'empty'
        el.textContent = text
        return el
    }

    // ---------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------

    api.isOpen = function () {
        return host !== null && host.parentNode !== null
    }

    api.open = function (extensionCommunicator) {
        if (api.isOpen()) { return }
        communicator = extensionCommunicator
        if (!host) { build() }

        allTabs = []
        results = []
        selected = 0
        loaded = false
        input.value = ''
        render()

        document.documentElement.appendChild(host)
        input.focus()
        communicator.requestTabList()
    }

    api.close = function () {
        if (api.isOpen()) { host.parentNode.removeChild(host) }
    }

    api.setTabs = function (tabs) {
        if (!api.isOpen()) { return }
        allTabs = tabs || []
        loaded = true
        refresh()
    }

    // Exposed for tests.
    api.fuzzyScore = fuzzyScore
    api.filterTabs = filterTabs

    return api
})()

window.TabSwitcher = TabSwitcher
