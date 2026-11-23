import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { objReq, strReq, strOpt, numReq, fnOpt, badInput } from './inputs.mjs'


//共用工具區(toolbox): 節點與做夢共用之工具集 = 一個資料夾 + 一份索引; **由做夢 agent 統籌擴建**(收集節點自報之可共用輔助、整併、驗證、寫入、維護索引)
//  通用件(不含領域用語; 一律依賴注入)。迴圈(維護者)只做機械之事, 不替做夢寫工具:
//    做夢前 snapshot() 留底 → 做夢後 check(snap): 比對差異 → 逐檔檢查本次新增 / 修改之檔 → 不合者**逐檔還原**(其餘照留)→ 索引一致性
//  規則(機械可判定者):
//    ① 副檔名須在 exts 內、單檔 ≤ maxFileBytes、總檔數 ≤ maxFiles
//    ② 已發布之檔不得刪除(要淘汰請於索引註記; 被刪者還原)—— 既有之成品與文件可能引用它
//    ③ 逐檔之內容檢查由專案注入: checkFile({ rel, abs, src }) → [問題字串](空 = 合格); 例: 語法、不得觸及之路徑、可用之匯入
//    ④ 索引(indexFile)須存在, 且每個檔之相對路徑都出現在索引內(不合只列為問題, 不還原: 由下一次擴建補上)
//    ⑤ 已發布之檔之內容不得改寫(選配; 專案注入 codeOf 時才檢查): codeOf({ rel, src }) → 比對用之字串(null = 此檔不比對); 快照與現況之結果不同 ⇒ 還原並寫明理由(比對內容相同者 ⇒ 照留)
//       既有之成品抄自舊版, 同名改寫會使其說明與實作不符 ⇒ 要改行為請另存新檔名
//  createToolbox({ dir, indexFile, indexSeed, exts, maxFileBytes, maxFiles, checkFile, codeOf, baselineFile })
//    indexSeed: 索引不存在時寫入之初始內容(選配)
//    baselineFile: 比對基準檔之路徑(選配; 與 codeOf 併用): snapshot() 寫入各檔之程式碼雜湊, 供另一行程之 inspect() 自檢時比對(讀不到 ⇒ 自檢不比對; check 一律以記憶體內之快照為準, 不讀此檔)
//  回 { dir, indexFile, ensure(), list(), snapshot(), diff(snap), check(snap), inspect(), restoreFile(snap, rel) }
//    inspect()  → { ok, files[{ rel, bytes, problems[] }], issues[] }(唯讀之自檢: 同一套規則檢查現有之全部檔, 不還原)
//    list()     → [{ rel(以 / 分隔之相對路徑), bytes, hash }]
//    snapshot() → { at, files: { rel: Buffer } }
//    diff(snap) → { added[], changed[], removed[] }(現況相對於 snap)
//    check(snap)→ { ok, changed{ added, changed, removed }(還原後之淨變動), reverted[{ rel, why }], issues[] }
//    checkIndex(選配; 專案注入): ({ text, files[rel] }) → [問題字串] —— 索引之格式要求(例: 須有「依情境找工具」一節且涵蓋每個檔); 不合只列為問題, 不還原
/**
 * 建立共用工具區(一個資料夾加一份索引;做夢前留快照、做夢後機械檢查並逐檔還原不合者)
 *
 * 規則(副檔名、單檔大小、總檔數、已發布之檔不得刪除、索引須列出每個檔)見檔頭說明。
 * opt 非一般物件、dir 非非空字串、其餘各項給了而無效(maxFileBytes、maxFiles 非正整數或其數字字串;checkFile、checkIndex、codeOf 非函數;exts 非字串陣列;indexFile 含路徑分隔;indexSeed、baselineFile 非字串)皆同步拋 invalid opt.<鍵>: must be …(固定訊息、不帶輸入值);未給(undefined 或 null)取預設。
 *
 * @param {Object} opt 輸入設定物件
 * @param {String} opt.dir 輸入共用工具區資料夾路徑
 * @param {String} [opt.indexFile='README.md'] 輸入索引檔名,預設'README.md'
 * @param {String} [opt.indexSeed=null] 輸入索引不存在時寫入之初始內容,預設null
 * @param {Array} [opt.exts=['.mjs','.md','.json','.txt']] 輸入允許之副檔名陣列,預設['.mjs','.md','.json','.txt']
 * @param {Number} [opt.maxFileBytes=204800] 輸入單檔位元組上限,預設204800(200 * 1024)
 * @param {Number} [opt.maxFiles=200] 輸入總檔數上限,預設200
 * @param {Function} [opt.checkFile=null] 輸入逐檔內容檢查函數,形式 ({ rel, abs, src }) → 問題字串陣列,預設null
 * @param {Function} [opt.checkIndex=null] 輸入索引格式檢查函數,形式 ({ text, files }) → 問題字串陣列,預設null
 * @param {Function} [opt.codeOf=null] 輸入比對用之程式碼函數,形式 ({ rel, src }) → 字串或 null(null = 此檔不比對),預設null(不檢查已發布之檔之改寫)
 * @param {String} [opt.baselineFile=null] 輸入比對基準檔之路徑(供另一行程之 inspect 比對),預設null
 * @returns {Object} 回傳物件,含屬性 dir、indexFile,與方法 ensure(建立資料夾與初始索引)、list(列出檔案 rel、bytes、hash)、snapshot(留快照)、diff(snap)(相對快照之 added、changed、removed)、check(snap)(機械檢查並還原不合之檔)、inspect(唯讀自檢全部現有檔)、restoreFile(snap, rel)(還原單檔)
 * @example
 * let tb = createToolbox({ dir: './toolbox', indexSeed: '# 共用工具索引\n' })
 * let snap = tb.snapshot()
 * // ...做夢 agent 擴建...
 * let res = tb.check(snap)
 */
let createToolbox = (opt) => {
    //輸入之檢測(跨套件規格 V4、K3、K5、§5.1; R-EV-54; 工廠 ⇒ 同步拋固定訊息、先於任何副作用): 共用工具區之各項皆是「哪些檔被還原」之規則(副檔名白名單、單檔與總檔數上限、內容檢查、索引檢查、已發布之檔不得改寫之比對、比對基準檔)
    //  ⇒ 安全閘, 給了而無效即拒絕, 不改用預設(原: maxFileBytes: 'abc' ⇒ `buf.length > 'abc'` 恆假 ⇒ 大小限制失效、null ⇒ `> null`(0)⇒ 全檔被還原、maxFiles 同; checkFile / checkIndex / codeOf 給了而非函數 ⇒ 靜默不檢查; opt 為 null ⇒ 原生 TypeError);
    //  未給(undefined 或 null)取預設; 數字字串轉為數值後使用(K4、K7)
    let o = objReq(opt, 'opt')
    let dir = strReq(o.dir, 'opt.dir')
    let indexFile = strOpt(o.indexFile, 'README.md', 'opt.indexFile')
    if (/[\\/]/.test(indexFile) || indexFile === '.' || indexFile === '..') {
        throw badInput('opt.indexFile', 'a file name without path separators')
    }
    let indexSeed = o.indexSeed === undefined || o.indexSeed === null ? null : o.indexSeed
    if (indexSeed !== null && typeof indexSeed !== 'string') {
        throw badInput('opt.indexSeed', 'a string')
    }
    let exts = o.exts === undefined || o.exts === null ? ['.mjs', '.md', '.json', '.txt'] : o.exts
    if (!Array.isArray(exts) || !exts.every((x) => typeof x === 'string')) {
        throw badInput('opt.exts', 'an array of strings')
    }
    let maxFileBytes = numReq(o.maxFileBytes, 200 * 1024, 'opt.maxFileBytes', 'posInt')
    let maxFiles = numReq(o.maxFiles, 200, 'opt.maxFiles', 'posInt')
    let checkFile = fnOpt(o.checkFile, 'opt.checkFile')
    let checkIndex = fnOpt(o.checkIndex, 'opt.checkIndex')
    let codeOf = fnOpt(o.codeOf, 'opt.codeOf')
    let baselineFile = strOpt(o.baselineFile, null, 'opt.baselineFile')
    let hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)
    let REWRITE_WHY = '已發布之檔於檔頭註解以外之內容不得改寫(要改行為請另存新檔名,如 _v2;檔頭註解可改);索引內對該檔之說明請一併復原'

    //codeHashOf, 比對用之程式碼之雜湊(未注入 codeOf、此檔不比對、或 codeOf 拋錯 ⇒ null: 不比對)
    let codeHashOf = (rel, buf) => {
        if (typeof codeOf !== 'function') {
            return null
        }
        try {
            let c = codeOf({ rel, src: buf.toString('utf8') })
            return typeof c === 'string' ? hashOf(Buffer.from(c, 'utf8')) : null
        }
        catch (err) {
            return null
        }
    }

    //walk, 列出資料夾內之全部檔(遞迴; 略過以 . 開頭者); 回 [{ rel, abs }](依 rel 排序)
    let walk = () => {
        let out = []
        let go = (d, pre) => {
            for (let f of fs.readdirSync(d).sort()) {
                if (f.startsWith('.')) {
                    continue
                }
                let abs = path.join(d, f)
                let st = fs.lstatSync(abs)
                if (st.isSymbolicLink()) {
                    continue
                }
                if (st.isDirectory()) {
                    go(abs, `${pre}${f}/`)
                }
                else if (st.isFile()) {
                    out.push({ rel: `${pre}${f}`, abs })
                }
            }
        }
        if (fs.existsSync(dir)) {
            go(dir, '')
        }
        return out
    }

    let ensure = () => {
        fs.mkdirSync(dir, { recursive: true })
        let fp = path.join(dir, indexFile)
        if (!fs.existsSync(fp) && typeof indexSeed === 'string') {
            fs.writeFileSync(fp, indexSeed, 'utf8')
        }
    }

    let list = () => walk().map((f) => {
        let buf = fs.readFileSync(f.abs)
        return { rel: f.rel, bytes: buf.length, hash: hashOf(buf) }
    })

    let snapshot = () => {
        ensure()
        let snap = { at: new Date().toISOString(), files: Object.fromEntries(walk().map((f) => [f.rel, fs.readFileSync(f.abs)])) }
        //比對基準檔(供另一行程之自檢; 寫入失敗不影響快照)
        if (baselineFile && typeof codeOf === 'function') {
            try {
                let codes = {}
                for (let [rel, buf] of Object.entries(snap.files)) {
                    let h = rel === indexFile ? null : codeHashOf(rel, buf)
                    if (h !== null) {
                        codes[rel] = h
                    }
                }
                fs.mkdirSync(path.dirname(baselineFile), { recursive: true })
                fs.writeFileSync(baselineFile, JSON.stringify({ at: snap.at, codes }, null, 1), 'utf8')
            }
            catch (err) {}
        }
        return snap
    }

    let diff = (snap) => {
        let before = (snap && snap.files) || {}
        let now = Object.fromEntries(list().map((f) => [f.rel, f.hash]))
        let added = Object.keys(now).filter((r) => !(r in before))
        let changed = Object.keys(now).filter((r) => r in before && hashOf(before[r]) !== now[r])
        let removed = Object.keys(before).filter((r) => !(r in now))
        return { added, changed, removed }
    }

    //restoreFile, 把單一檔還原為快照之內容(快照內沒有者 = 本次新增 ⇒ 刪除)
    let restoreFile = (snap, rel) => {
        let abs = path.join(dir, ...rel.split('/'))
        if (snap && snap.files && rel in snap.files) {
            fs.mkdirSync(path.dirname(abs), { recursive: true })
            fs.writeFileSync(abs, snap.files[rel])
        }
        else if (fs.existsSync(abs)) {
            fs.rmSync(abs, { force: true })
        }
    }

    //fileProblems, 單一檔之問題清單(規則 ① 與 ③); 空 = 合格
    let fileProblems = (rel) => {
        let abs = path.join(dir, ...rel.split('/'))
        let probs = []
        if (!exts.includes(path.extname(rel).toLowerCase())) {
            probs.push(`副檔名須為 ${exts.join(' / ')}`)
        }
        let buf = fs.readFileSync(abs)
        if (buf.length > maxFileBytes) {
            probs.push(`檔案 ${buf.length} 位元組,超過上限 ${maxFileBytes}`)
        }
        if (probs.length === 0 && typeof checkFile === 'function') {
            try {
                let r = checkFile({ rel, abs, src: buf.toString('utf8') })
                if (Array.isArray(r)) {
                    probs.push(...r.map(String))
                }
            }
            catch (err) {
                probs.push(`檢查失敗: ${String((err && err.message) || err).slice(0, 200)}`)
            }
        }
        return probs
    }

    //indexIssues, 索引一致性與總檔數(規則 ④ 與 ① 之總檔數; 以現況為準)
    let indexIssues = () => {
        let issues = []
        let files = walk()
        let fpIndex = path.join(dir, indexFile)
        if (!fs.existsSync(fpIndex)) {
            issues.push(`缺索引 ${indexFile}`)
        }
        else {
            let idx = fs.readFileSync(fpIndex, 'utf8')
            for (let f of files) {
                if (f.rel !== indexFile && !idx.includes(f.rel)) {
                    issues.push(`索引未列 ${f.rel}`)
                }
            }
            if (typeof checkIndex === 'function') {
                try {
                    let r = checkIndex({ text: idx, files: files.map((f) => f.rel).filter((r2) => r2 !== indexFile) })
                    if (Array.isArray(r)) {
                        issues.push(...r.map(String))
                    }
                }
                catch (err) {
                    issues.push(`索引檢查失敗: ${String((err && err.message) || err).slice(0, 200)}`)
                }
            }
        }
        if (files.length > maxFiles) {
            issues.push(`共用工具區共 ${files.length} 檔,超過上限 ${maxFiles}(請整併)`)
        }
        return issues
    }

    let check = (snap) => {
        let d = diff(snap)
        let reverted = []
        for (let rel of d.removed) {
            restoreFile(snap, rel)
            reverted.push({ rel, why: '已發布之檔不得刪除(已還原;要淘汰請於索引註記)' })
        }
        for (let rel of [...d.added, ...d.changed]) {
            if (rel === indexFile) {
                continue
            }
            //規則 ⑤: 已發布之檔被改寫(比對內容相同者兩邊之雜湊相同 ⇒ 續走其餘檢查)
            if (d.changed.includes(rel)) {
                let h0 = codeHashOf(rel, snap.files[rel])
                let h1 = codeHashOf(rel, fs.readFileSync(path.join(dir, ...rel.split('/'))))
                if (h0 !== null && h1 !== null && h0 !== h1) {
                    restoreFile(snap, rel)
                    reverted.push({ rel, why: `${REWRITE_WHY};已還原` })
                    continue
                }
            }
            let probs = fileProblems(rel)
            if (probs.length) {
                restoreFile(snap, rel)
                reverted.push({ rel, why: probs.join(';').slice(0, 400) })
            }
        }
        //索引一致性(以還原後之現況為準)
        let issues = indexIssues()
        return { ok: reverted.length === 0 && issues.length === 0, changed: diff(snap), reverted, issues }
    }

    //inspect, 自檢(唯讀; 不還原、不改任何檔): 以與 check 相同之規則檢查**現有之全部檔**; 供擴建者於交付前自行確認
    //  已發布之檔之改寫(規則 ⑤): 與比對基準檔(最近一次 snapshot 所寫)比對; 無基準檔或讀不到 ⇒ 不比對
    //  回 { ok, files[{ rel, bytes, problems[] }], issues[] }
    let inspect = () => {
        let base = {}
        if (baselineFile && typeof codeOf === 'function') {
            try {
                let o = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
                base = o && o.codes && typeof o.codes === 'object' && !Array.isArray(o.codes) ? o.codes : {}
            }
            catch (err) {
                base = {}
            }
        }
        let rewriteOf = (f) => {
            let h0 = Object.prototype.hasOwnProperty.call(base, f.rel) ? base[f.rel] : null
            let h1 = h0 === null ? null : codeHashOf(f.rel, fs.readFileSync(f.abs))
            return h0 !== null && h1 !== null && h0 !== h1 ? [`${REWRITE_WHY};交付後會被還原`] : []
        }
        let files = walk().filter((f) => f.rel !== indexFile).map((f) => ({ rel: f.rel, bytes: fs.statSync(f.abs).size, problems: [...rewriteOf(f), ...fileProblems(f.rel)] }))
        let issues = indexIssues()
        return { ok: files.every((f) => f.problems.length === 0) && issues.length === 0, files, issues }
    }

    return { dir, indexFile, ensure, list, snapshot, diff, check, inspect, restoreFile }
}


export { createToolbox }
export default createToolbox
