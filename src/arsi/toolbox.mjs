import fs from 'fs'
import path from 'path'
import crypto from 'crypto'


//共用工具區(toolbox): 節點與做夢共用之工具集 = 一個資料夾 + 一份索引; **由做夢 agent 統籌擴建**(收集節點自報之可共用輔助、整併、驗證、寫入、維護索引)
//  通用件(不含領域用語; 一律依賴注入)。迴圈(維護者)只做機械之事, 不替做夢寫工具:
//    做夢前 snapshot() 留底 → 做夢後 check(snap): 比對差異 → 逐檔檢查本次新增 / 修改之檔 → 不合者**逐檔還原**(其餘照留)→ 索引一致性
//  規則(機械可判定者):
//    ① 副檔名須在 exts 內、單檔 ≤ maxFileBytes、總檔數 ≤ maxFiles
//    ② 已發布之檔不得刪除(要淘汰請於索引註記; 被刪者還原)—— 既有之成品與文件可能引用它
//    ③ 逐檔之內容檢查由專案注入: checkFile({ rel, abs, src }) → [問題字串](空 = 合格); 例: 語法、不得觸及之路徑、可用之匯入
//    ④ 索引(indexFile)須存在, 且每個檔之相對路徑都出現在索引內(不合只列為問題, 不還原: 由下一次擴建補上)
//  createToolbox({ dir, indexFile, indexSeed, exts, maxFileBytes, maxFiles, checkFile })
//    indexSeed: 索引不存在時寫入之初始內容(選配)
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
 * 未給 dir 會拋錯。規則(副檔名、單檔大小、總檔數、已發布之檔不得刪除、索引須列出每個檔)見檔頭說明。
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
 * @returns {Object} 回傳物件,含屬性 dir、indexFile,與方法 ensure(建立資料夾與初始索引)、list(列出檔案 rel、bytes、hash)、snapshot(留快照)、diff(snap)(相對快照之 added、changed、removed)、check(snap)(機械檢查並還原不合之檔)、inspect(唯讀自檢全部現有檔)、restoreFile(snap, rel)(還原單檔)
 * @example
 * let tb = createToolbox({ dir: './toolbox', indexSeed: '# 共用工具索引\n' })
 * let snap = tb.snapshot()
 * // ...做夢 agent 擴建...
 * let res = tb.check(snap)
 */
let createToolbox = ({ dir, indexFile = 'README.md', indexSeed = null, exts = ['.mjs', '.md', '.json', '.txt'], maxFileBytes = 200 * 1024, maxFiles = 200, checkFile = null, checkIndex = null }) => {
    if (!dir) {
        throw new Error('createToolbox: 須給 dir')
    }
    let hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12)

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
        return { at: new Date().toISOString(), files: Object.fromEntries(walk().map((f) => [f.rel, fs.readFileSync(f.abs)])) }
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
    //  回 { ok, files[{ rel, bytes, problems[] }], issues[] }
    let inspect = () => {
        let files = walk().filter((f) => f.rel !== indexFile).map((f) => ({ rel: f.rel, bytes: fs.statSync(f.abs).size, problems: fileProblems(f.rel) }))
        let issues = indexIssues()
        return { ok: files.every((f) => f.problems.length === 0) && issues.length === 0, files, issues }
    }

    return { dir, indexFile, ensure, list, snapshot, diff, check, inspect, restoreFile }
}


export { createToolbox }
export default createToolbox
