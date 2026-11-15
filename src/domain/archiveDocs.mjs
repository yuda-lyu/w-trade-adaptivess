import fs from 'fs'
import path from 'path'


//專案指引文件之自動整理(規則 R-REC-17; 無人值守時文件會逐輪變長, 節點與做夢每輪都要讀):
//  經驗檔、回饋檔逾上限時, 把較舊之內容**原文搬到**同資料夾之 <名>_<年月日>.md(只搬不刪、條號與標題不變), 主檔留索引
//  archiveExperience({ fp, maxBytes, keepBytes, keepSections, date }) → { moved, from, to, file, before, after } 或 null(未逾上限 / 無可搬)
//    經驗檔之結構: 檔頭(第一個「## 」以前)+ 數節(「## 」開頭; 各節內為「N. **〔範圍〕標題**(…): 內文」之條目)
//    自最舊之節起整節搬出, 直到主檔 ≤ keepBytes; 至少保留最後 keepSections 節; 主檔之「## 已抽出之舊經驗」一節列各條之條號與標題(需要時再調閱)
//  archiveFeedback({ fp, maxBytes, keepRows, date }) → { moved, file, before, after } 或 null
//    回饋檔之結構: 檔頭 + 一張表(表頭兩列 + 各列); 保留最後 keepRows 列, 其餘搬出(搬出之檔帶同一表頭)
let ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
let freeName = (dir, base, date) => {
    let name = `${base}_${ymd(date)}.md`
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) {
        name = `${base}_${ymd(date)}_${i}.md`
    }
    return name
}
let bytes = (s) => Buffer.byteLength(s, 'utf8')
let INDEX_TITLE = '## 已抽出之舊經驗(原文在所列之檔;條號與標題不變,需要時再調閱)'

/**
 * 經驗檔逾上限時,把較舊之節原文搬到同資料夾之 <名>_<年月日>.md,主檔留索引(會寫檔)
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.fp 輸入經驗檔路徑
 * @param {Number} [opt.maxBytes=30000] 輸入觸發上限位元組,預設30000
 * @param {Number} [opt.keepBytes=18000] 輸入主檔保留目標位元組,預設18000
 * @param {Number} [opt.keepSections=2] 輸入至少保留之最後節數,預設2
 * @param {Date} [opt.date=new Date()] 輸入抽出日期,預設現在
 * @returns {Object|null} 回傳 { moved, from, to, file, before, after },未逾上限或無可搬時回傳 null
 * @example
 * let r = archiveExperience({ fp: './sgud/exp/experience.md' })
 */
let archiveExperience = ({ fp, maxBytes = 30000, keepBytes = 18000, keepSections = 2, date = new Date() }) => {
    if (!fs.existsSync(fp)) {
        return null
    }
    let text = fs.readFileSync(fp, 'utf8')
    let before = bytes(text)
    if (before <= maxBytes) {
        return null
    }
    let lines = text.split('\n')
    let starts = []
    lines.forEach((l, i) => {
        if (/^## /.test(l)) {
            starts.push(i)
        }
    })
    if (starts.length === 0) {
        return null
    }
    let head = lines.slice(0, starts[0])
    let secs = starts.map((s, k) => ({ title: lines[s], lines: lines.slice(s, k + 1 < starts.length ? starts[k + 1] : lines.length) }))
    //既有之索引節不搬、不計入「至少保留」之節數
    let idx = secs.filter((s) => s.title.startsWith('## 已抽出之舊經驗'))
    let body = secs.filter((s) => !s.title.startsWith('## 已抽出之舊經驗'))
    let sizeOf = (ss) => bytes([...head, ...idx.flatMap((s) => s.lines), ...ss.flatMap((s) => s.lines)].join('\n'))
    let nMove = 0
    while (nMove < body.length - keepSections && sizeOf(body.slice(nMove)) > keepBytes) {
        nMove++
    }
    if (nMove === 0) {
        return null
    }
    let moved = body.slice(0, nMove)
    let kept = body.slice(nMove)
    let entries = moved.flatMap((s) => s.lines).map((l) => l.match(/^(\d+)\. \*\*(.+?)\*\*/)).filter(Boolean).map((m) => ({ n: Number(m[1]), title: m[2] }))
    let dir = path.dirname(fp)
    let base = path.basename(fp, '.md')
    let name = freeName(dir, base, date)
    let from = entries.length ? Math.min(...entries.map((e) => e.n)) : null
    let to = entries.length ? Math.max(...entries.map((e) => e.n)) : null
    let archive = [`# ${base}(${ymd(date)} 抽出之舊條目;原文照搬,條號與標題不變)`, '', `> 自 \`${path.basename(fp)}\` 抽出${from === null ? '' : `:第 ${from} ~ ${to} 條`}。主檔留有各條之條號與標題。`, '', ...moved.flatMap((s) => s.lines)].join('\n')
    fs.writeFileSync(path.join(dir, name), archive.endsWith('\n') ? archive : `${archive}\n`, 'utf8')
    let idxLines = idx.length ? idx[0].lines.slice() : [INDEX_TITLE, '']
    while (idxLines.length && idxLines[idxLines.length - 1].trim() === '') {
        idxLines.pop()
    }
    idxLines.push('', `- **\`${name}\`**${from === null ? '' : `(第 ${from} ~ ${to} 條)`}:`)
    for (let e of entries) {
        idxLines.push(`  - ${e.n}. ${e.title}`)
    }
    idxLines.push('')
    let next = [...head, ...idxLines, ...kept.flatMap((s) => s.lines)].join('\n')
    fs.writeFileSync(fp, next, 'utf8')
    return { moved: entries.length, from, to, file: name, before, after: bytes(next) }
}

/**
 * 回饋檔逾上限時,保留最後若干列,其餘列原文搬到同資料夾之 <名>_<年月日>.md(會寫檔)
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.fp 輸入回饋檔路徑
 * @param {Number} [opt.maxBytes=30000] 輸入觸發上限位元組,預設30000
 * @param {Number} [opt.keepRows=14] 輸入保留之列數,預設14
 * @param {Date} [opt.date=new Date()] 輸入抽出日期,預設現在
 * @returns {Object|null} 回傳 { moved, file, before, after },未逾上限或無可搬時回傳 null
 * @example
 * let r = archiveFeedback({ fp: './sgud/feedback/feedback.md' })
 */
let archiveFeedback = ({ fp, maxBytes = 30000, keepRows = 14, date = new Date() }) => {
    if (!fs.existsSync(fp)) {
        return null
    }
    let text = fs.readFileSync(fp, 'utf8')
    let before = bytes(text)
    if (before <= maxBytes) {
        return null
    }
    let lines = text.split('\n')
    let iSep = lines.findIndex((l) => /^\|\s*-{3}/.test(l))
    if (iSep < 1) {
        return null
    }
    let head = lines.slice(0, iSep - 1)
    let th = lines.slice(iSep - 1, iSep + 1)
    let rows = lines.slice(iSep + 1).filter((l) => /^\|/.test(l))
    let tail = lines.slice(iSep + 1).filter((l) => !/^\|/.test(l) && l.trim() !== '')
    if (rows.length <= keepRows) {
        return null
    }
    let moved = rows.slice(0, rows.length - keepRows)
    let kept = rows.slice(rows.length - keepRows)
    let dir = path.dirname(fp)
    let base = path.basename(fp, '.md')
    let name = freeName(dir, base, date)
    fs.writeFileSync(path.join(dir, name), [`# ${base}(${ymd(date)} 抽出之舊列;原文照搬)`, '', `> 自 \`${path.basename(fp)}\` 抽出 ${moved.length} 列。`, '', ...th, ...moved, ''].join('\n'), 'utf8')
    let note = `> 較早之 ${moved.length} 列已抽出至 \`${name}\`(原文照搬;需要時再調閱)。`
    while (head.length && head[head.length - 1].trim() === '') {
        head.pop()
    }
    let next = [...head, note, '', ...th, ...kept, ...tail, ''].join('\n')
    fs.writeFileSync(fp, next, 'utf8')
    return { moved: moved.length, file: name, before, after: bytes(next) }
}


export { archiveExperience, archiveFeedback }
