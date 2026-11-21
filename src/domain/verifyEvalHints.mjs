import path from 'path'
import { evalLines, dirNodeIdsOf } from './verify.mjs'


//迴圈檢查之兩條機械提示之判定(單峰交付、選集與他節點相同; 規則 R-REC-43、R-REC-44)
//  獨立成檔(檔名以 verify 起首): 節點之禁區字樣涵蓋 src/domain/verify*(forbiddenPats 之 nodeRules; 任務書之「讀取迴圈驗證之原始碼」同), 判定與門檻不被節點讀到而刻意規避
//  由 domain.mjs 與 tools/scanCheck.mjs 匯入; verify.mjs 不匯入亦不匯出本檔之名(自 verify.mjs 只取 evalLines〔讀評估紀錄〕與 dirNodeIdsOf〔方向內指名之節點; 與操作掃描之可讀之他節點工作夾同一求法〕)

//迴圈檢查之兩條機械提示(規則 R-REC-43 單峰交付、R-REC-44 選集與他節點相同; 只提示、不否決): 讀節點工作夾之評估紀錄(.evals.log; g_eval.mjs 每次執行所記之一列)
//  不改 S、階梯、選集指紋、否決、可信度、排序鍵、正本之數字, 亦不改「已試之臂」與各臂之最佳之計法; 由領域層於輪末(做夢之前、重做之後)、--mode validate 之重掃與 reverify 之後產生, tools/scanCheck.mjs 唯讀對照
//REF_PICK, 參考檔之檔名(兩條提示共用之單一來源; 其列不計): control.mjs(任務書要求之對照版)、base_pick.mjs(迴圈複製之起點成品)、ref_*.mjs(迴圈複製之參考節點成品)
//  評估紀錄之 pick 為檔名(不含路徑); 不分大小寫
let REF_PICK = /^(?:control|base_pick|ref_.*)\.mjs$/i
let isRefPick = (pick) => REF_PICK.test(String(pick))
/**
 * 兩條機械提示之門檻(具名之常數,不開放為設定鍵;R-REC-43、R-REC-44):peakMinSel = 單峰交付所需之相異選集指紋數之下限,peakRatio = 其餘之 S 之中位須低於交付版之 S 之倍數,twinMaxList = 選集與他節點相同之一條提示所列之節點數之上限
 *
 * @type {Object}
 */
let EVAL_HINT = Object.freeze({ peakMinSel: 6, peakRatio: 0.5, twinMaxList: 3 })
let PEAK_HEAD = '提示(單峰交付): '
let TWIN_HEAD = '提示(選集與他節點相同): '
let HINT_TAIL = '(不否決,由審計判定)'
let isEvalHint = (s) => String(s).startsWith(PEAK_HEAD) || String(s).startsWith(TWIN_HEAD)
//evalHintBody, 提示之內容(去掉句首之標頭與句末之「不否決」註; 看板之表前一段用); 非本兩條提示者原樣
let evalHintBody = (s) => {
    let t = String(s)
    let h = [PEAK_HEAD, TWIN_HEAD].find((x) => t.startsWith(x))
    if (!h) {
        return t
    }
    t = t.slice(h.length)
    return t.endsWith(HINT_TAIL) ? t.slice(0, t.length - HINT_TAIL.length) : t
}
//fullRowsOf, 評估紀錄之各列(原文)→ 兩條提示所計之列 [{ pick, selHash, S }](依檔內之次序): 成功(ok === true)、完整評估(mode === 'full')、評估期(無 period 或為 backtest)、
//  不帶成員抽樣(無 member)、不帶子庫(無 subset; 規則 R-EV-47)、有選集指紋(非空字串)且不是參考檔(isRefPick)之列; S 非有限數值者記 null; 無法解析之列略過; lines 非陣列者回 []
let fullRowsOf = (lines) => {
    let out = []
    for (let l of Array.isArray(lines) ? lines : []) {
        if (typeof l !== 'string' || !l.trim().startsWith('{')) {
            continue
        }
        let j
        try {
            j = JSON.parse(l)
        }
        catch (err) {
            continue
        }
        if (!j || j.ok !== true || j.mode !== 'full' || (j.period && j.period !== 'backtest') || (j.member !== undefined && j.member !== null) || typeof j.selHash !== 'string' || !j.selHash || isRefPick(j.pick)) {
            continue
        }
        //子庫之評估(--subset; 規則 R-EV-47)同成員抽樣: 不是正本之評估, 不計
        if (j.subset !== undefined && j.subset !== null) {
            continue
        }
        out.push({ pick: typeof j.pick === 'string' ? j.pick : '', selHash: j.selHash, S: typeof j.S === 'number' && Number.isFinite(j.S) ? j.S : null })
    }
    return out
}
let medianOf = (xs) => {
    let s = xs.slice().sort((a, b) => a - b)
    let k = s.length
    return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2
}
let r2 = (x) => Math.round(x * 100) / 100
//peakHintOf, 提示(單峰交付)(規則 R-REC-43)之字串或 null: rows = fullRowsOf 之結果、fingerprint = 正本之選集指紋
//  以相異之選集指紋為單位(同一指紋有多列者取檔內最後一列之 S = 最近之一次; S 非有限數值之列不計); 交付版 = 指紋等於正本者
//  四者皆成立才提示: 相異之指紋數 ≥ peakMinSel(含交付版); 交付版之 S > 0; 交付版之 S ≥ 其餘每一個; 其餘之 S 之中位 < 交付版之 S × peakRatio; 正本之指紋不在其中者不提示
let peakHintOf = (rows, fingerprint) => {
    if (typeof fingerprint !== 'string' || !fingerprint) {
        return null
    }
    let bySel = new Map()
    for (let r of Array.isArray(rows) ? rows : []) {
        if (r && typeof r.selHash === 'string' && typeof r.S === 'number' && Number.isFinite(r.S)) {
            bySel.set(r.selHash, r.S)
        }
    }
    if (!bySel.has(fingerprint) || bySel.size < EVAL_HINT.peakMinSel) {
        return null
    }
    let dS = bySel.get(fingerprint)
    let rest = [...bySel.entries()].filter(([k]) => k !== fingerprint).map(([, v]) => v)
    if (!(dS > 0) || rest.some((v) => v > dS)) {
        return null
    }
    let med = medianOf(rest)
    if (!(med < dS * EVAL_HINT.peakRatio)) {
        return null
    }
    //字串只列該節點自己之事實(交付版之 S、相異選集之個數、其餘之個數與中位), 不列門檻之值(節點讀得到節點文件與看板; 規則 R-REC-43 ⑥)
    return `${PEAK_HEAD}交付版之 S ${dS} 為完整評估之 ${bySel.size} 個相異選集(選集指紋)中之最高者,其餘 ${rest.length} 個之 S 之中位 ${r2(med)}(遠低於交付版)⇒ 交付版之 S 可能只是多次試驗中之最大值;以鄰點(鄰近參數之版本)與多抽之重放(換亂數種子與同分次序)判其是否偶然${HINT_TAIL}`
}
//twinIndexOf, 各節點之所計之列 → 選集指紋 → Map(節點 id → { o, picks: [檔名…](檔內之次序) }); items = [{ id, rows, … }]
let twinIndexOf = (items) => {
    let ix = new Map()
    for (let o of items) {
        for (let r of o.rows || []) {
            if (!ix.has(r.selHash)) {
                ix.set(r.selHash, new Map())
            }
            let m = ix.get(r.selHash)
            if (!m.has(o.id)) {
                m.set(o.id, { o, picks: [] })
            }
            m.get(o.id).picks.push(r.pick)
        }
    }
    return ix
}
//pairExcluded, 驗證類之節點與其方向所指名要重複之對象(targets: 起點與方向內指名之節點)之間不比 —— 刻意之重複驗證(兩個方向皆然)
let pairExcluded = (a, b) => (a.type === 'verify' && (a.targets || []).includes(b.id)) || (b.type === 'verify' && (b.targets || []).includes(a.id))
//twinHintOf, 提示(選集與他節點相同)(規則 R-REC-44)之字串或 null: self = { id, arms, fingerprint, type, targets }, ix = twinIndexOf(全部節點)
//  命中 = 他節點之某一列(所計之列)之選集指紋等於本節點之正本之選集指紋; 同一對方節點只列一次 —— 所列之檔: 對方之正本亦為此選集者取其交付檔(pick.mjs)之列, 否則取其命中之最後一列;
//  本節點之臂為對方之臂之真子集者(本節點無多出之臂)不列: 本節點之成績未被記到未作用之臂上, 亦非同臂之重複(對方之交付版若即此選集, 對方自得一條提示)
//  兩方皆為驗證類而臂組合相同者不列: 刻意之重複驗證(同一候選之不同主張, 交付版即被驗證之對象); 臂組合不同者照列(與類型無關), 一方為驗證類而另一方不是者照列
//  臂組合不同者在前(其內依節點 id), 相同者在後; 列至 twinMaxList 個, 其餘列個數與 id 前 8 碼(至多 10 個)
let twinHintOf = (self, ix) => {
    let m = self && typeof self.fingerprint === 'string' && self.fingerprint ? ix.get(self.fingerprint) : null
    if (!m) {
        return null
    }
    let arms = Array.isArray(self.arms) ? self.arms : []
    let hits = []
    for (let [oid, h] of m) {
        if (oid === self.id || pairExcluded(self, h.o)) {
            continue
        }
        let oArms = Array.isArray(h.o.arms) ? h.o.arms : []
        let mine = arms.filter((a) => !oArms.includes(a))
        let theirs = oArms.filter((a) => !arms.includes(a))
        if (mine.length === 0 && theirs.length > 0) {
            continue
        }
        if (self.type === 'verify' && h.o.type === 'verify' && mine.length === 0 && theirs.length === 0) {
            continue
        }
        let pick = h.o.fingerprint === self.fingerprint && h.picks.includes('pick.mjs') ? 'pick.mjs' : h.picks[h.picks.length - 1]
        hits.push({ id: oid, pick, nPick: new Set(h.picks).size, mine, theirs, same: mine.length === 0 && theirs.length === 0 })
    }
    if (!hits.length) {
        return null
    }
    hits.sort((a, b) => (Number(a.same) - Number(b.same)) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)))
    let at = (h) => `${h.id.slice(0, 8)}/${h.pick}${h.nPick > 1 ? `(另 ${h.nPick - 1} 個檔亦同)` : ''}`
    let diff = (h) => [h.mine.length ? `本節點多出 ${h.mine.join('、')}` : '', h.theirs.length ? `對方多出 ${h.theirs.join('、')}` : ''].filter(Boolean).join(';')
    if (hits.length === 1) {
        let h = hits[0]
        return h.same
            ? `${TWIN_HEAD}交付版之選集與 ${at(h)} 之完整評估逐位相同(選集指紋相同),臂組合亦相同 ⇒ 兩者為同一成品,不作互相獨立之佐證${HINT_TAIL}`
            : `${TWIN_HEAD}交付版之選集與 ${at(h)} 之完整評估逐位相同(選集指紋相同),臂組合不同(${diff(h)})⇒ 多出之臂於評估期間未作用;審計時核對未作用之臂${HINT_TAIL}`
    }
    let shown = hits.slice(0, EVAL_HINT.twinMaxList)
    let more = hits.slice(EVAL_HINT.twinMaxList)
    let item = (h) => (h.same ? `${at(h)}:臂組合相同 ⇒ 同一成品,不作互相獨立之佐證` : `${at(h)}:臂組合不同(${diff(h)})⇒ 多出之臂於評估期間未作用,審計時核對未作用之臂`)
    return `${TWIN_HEAD}交付版之選集與 ${hits.length} 個節點之完整評估逐位相同(選集指紋相同)—— ${shown.map(item).join(';')}${more.length ? `;另 ${more.length} 個節點(${more.slice(0, 10).map((h) => h.id.slice(0, 8)).join('、')}${more.length > 10 ? ' …' : ''})` : ''}${HINT_TAIL}`
}
/**
 * 迴圈檢查之兩條機械提示(R-REC-43 單峰交付、R-REC-44 選集與他節點相同;只提示、不否決):讀各節點工作夾之評估紀錄(各計至該節點之 agent 結束之時刻),回各節點之提示字串
 *
 * @param {Array<Object>} docs 輸入節點文件陣列(讀取 nodeId、spec.arms、spec.base、task.type、task.direction、agent.endedAt、harness.ok、harness.fingerprint);工作夾或評估紀錄缺、壞者略過
 * @param {String} workRoot 輸入各節點工作夾之根路徑(工作夾 = workRoot/<節點 id>)
 * @returns {Map<String, Array<String>>} 回傳 Map(節點 id → 提示字串陣列;單峰交付在前),只含有提示之節點
 * @example
 * let m = evalHintsOfDocs([], './rsi/work')
 * console.log(m.size)
 * // => 0
 */
let evalHintsOfDocs = (docs, workRoot) => {
    let list = (Array.isArray(docs) ? docs : []).filter((d) => d && typeof d.nodeId === 'string' && d.nodeId)
    let ids = list.map((d) => d.nodeId)
    //方向內指名之節點(完整 id 或其前 8 碼以上, 且於節點文件中唯一對應一個): 與操作掃描之可讀之他節點工作夾同一求法(verify.mjs 之 dirNodeIdsOf; 規則 R-BT-9)
    let namedOf = (dir) => dirNodeIdsOf(dir, ids)
    let items = list.map((d) => {
        let type = d.task && d.task.type === 'verify' ? 'verify' : 'explore'
        let rows = []
        try {
            rows = fullRowsOf(evalLines(path.join(workRoot, d.nodeId), d.agent && typeof d.agent.endedAt === 'string' ? d.agent.endedAt : null))
        }
        catch (err) {}
        return {
            id: d.nodeId,
            arms: d.spec && Array.isArray(d.spec.arms) ? d.spec.arms : [],
            fingerprint: d.harness && d.harness.ok === true && typeof d.harness.fingerprint === 'string' ? d.harness.fingerprint : null,
            type,
            targets: type === 'verify' ? [...(d.spec && d.spec.base ? [d.spec.base] : []), ...namedOf(d.task && d.task.direction)] : [],
            rows,
        }
    })
    let ix = twinIndexOf(items)
    let out = new Map()
    for (let o of items) {
        if (!o.fingerprint) {
            continue
        }
        let hs = [peakHintOf(o.rows, o.fingerprint), twinHintOf(o, ix)].filter(Boolean)
        if (hs.length) {
            out.set(o.id, hs)
        }
    }
    return out
}

export { EVAL_HINT, PEAK_HEAD, TWIN_HEAD, isRefPick, isEvalHint, evalHintBody, fullRowsOf, peakHintOf, twinHintOf, twinIndexOf, evalHintsOfDocs }
