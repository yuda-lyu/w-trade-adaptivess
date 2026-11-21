import fs from 'fs'
import path from 'path'


//sgudGuard, 「測試不得改寫入版控之文件」(規則 R-PKG-10)之守門工具(供 test/unit-sgudUntouched.test.mjs 與其變異)
//  輪末鉤子(domain.hooks.afterRound; redream 亦經之)末段之專案文件自動整理(R-REC-17)以模組常數 FD_ROOT 之 sgud 為對象:
//  經驗檔、回饋檔逾上限(預設 30000 位元組)即把較舊者搬到同夾之 <名>_<年月日>.md、改寫主檔 —— 測試把專案之各夾改到暫存夾並不改變此路徑,
//  故未關閉(settings.rsi.docLimits = false)之測試,於本庫之經驗檔 / 回饋檔逾上限時會改寫版控中之文件並多出檔案

//needsDocLimitsOff, 測試檔之內容是否建出專案(makeProject)且走到輪末鉤子(afterRound、redream)—— 此類須關閉自動整理
export let needsDocLimitsOff = (text) => /makeProject\(/.test(text) && /afterRound|redream\(/.test(text)

//hasDocLimitsOff, 測試檔之內容是否關閉自動整理(st.rsi.docLimits = false 或 docLimits: false)
export let hasDocLimitsOff = (text) => /docLimits\s*[:=]\s*false/.test(text)

//CHILD_ISOLATED, 專案建於子行程且以 ARSI_ROOT 指向暫存夾者(其 FD_ROOT 即暫存夾, 自動整理不觸及本庫): 不在此限
export let CHILD_ISOLATED = ['unit-reworkId.test.mjs']

//offendersOf, 掃 testDir 內之 *.test.mjs: scanned = 須關閉者(建專案且走到輪末鉤子), offenders = 其中未關閉且不在 allow 者; self(守門測試自身)不掃
export let offendersOf = (testDir, { allow = CHILD_ISOLATED, self = 'unit-sgudUntouched.test.mjs' } = {}) => {
    let scanned = []
    let offenders = []
    for (let f of fs.readdirSync(testDir).filter((x) => /\.test\.mjs$/.test(x) && x !== self).sort()) {
        let text = fs.readFileSync(path.join(testDir, f), 'utf8')
        if (!needsDocLimitsOff(text)) {
            continue
        }
        scanned.push(f)
        if (!hasDocLimitsOff(text) && !allow.includes(f)) {
            offenders.push(f)
        }
    }
    return { scanned, offenders }
}

//snapshotOf, 目錄(含子夾)內各檔之「大小:修改時間」之表(相對路徑 → 字串); 目錄不存在 ⇒ 空表
export let snapshotOf = (dir) => {
    let out = {}
    let walk = (d) => {
        for (let f of fs.readdirSync(d)) {
            let q = path.join(d, f)
            let s = fs.statSync(q)
            if (s.isDirectory()) {
                walk(q)
            }
            else {
                out[path.relative(dir, q).replace(/\\/g, '/')] = `${s.size}:${Math.floor(s.mtimeMs)}`
            }
        }
    }
    if (fs.existsSync(dir)) {
        walk(dir)
    }
    return out
}

//diffSnap, 兩個快照之差異(新增 / 刪除 / 變動各一列, 依路徑排序); 無差異 ⇒ []
export let diffSnap = (a, b) => {
    let out = []
    for (let k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (!(k in a)) {
            out.push(`新增 ${k}`)
        }
        else if (!(k in b)) {
            out.push(`刪除 ${k}`)
        }
        else if (a[k] !== b[k]) {
            out.push(`變動 ${k}`)
        }
    }
    return out
}
