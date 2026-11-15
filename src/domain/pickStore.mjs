import fs from 'fs'
import path from 'path'
import { loadPick } from '../eval/pickLoader.mjs'

//共同儲存「自適應挑選策略」區(規則 R-REC-25): <狀態根>/picks/
//  目的: 各節點(探索與驗證皆含)交付之挑選模組統一歸檔 —— 程式碼之逐位複本 + 由迴圈以同一評估器重跑所得之回測期績效與必要之欄位,
//        供節點與做夢 agent 直接查閱全部已找到之自適應挑選策略, 不必逐一翻各節點之文件與工作夾; 保留期之檢定由主控另算, 此處只列正負號
//  佈局:
//    README.md            說明與欄位定義(由本模組產生)
//    INDEX.md             總表(每個策略一列; 依回測期 S 由高至低)
//    index.json           全部欄位(機器可讀; { schema, updatedAt, fields, items })
//    <節點 id>/pick.mjs    交付版之逐位複本
//    <節點 id>/info.json   該策略之全部欄位
//    _holdout.json        保留期之正負號(只有正負號; 由主控之檢定工具寫入; 本模組只讀、不產生、不刪)
//  擴充: 欄位於 infoOf 內分組(identity / status / design / backtest / holdout / files); 新增欄位 = 在該組加一鍵並於 FIELD_DEFS 補一列說明;
//        INDEX.md 之欄由 COLUMNS 決定。讀取端應以鍵取值、容許未知之鍵與 null(舊節點文件可能無某欄)
//  本區由迴圈產生(輪末與主控審定後), agent 唯讀; 來源 = 節點文件(迴圈重跑之數字, 不是 agent 自報)與各節點工作夾之 pick.mjs

let SCHEMA = 1

//欄位定義(寫入 README.md 與 index.json.fields)
/**
 * 欄位定義表,每列為 [欄位名, 說明],寫入 README.md 與 index.json 之 fields
 *
 * @type {Array<Array<String>>}
 */
let FIELD_DEFS = [
    ['id / short', '節點 id(16 字)與其前 8 字'],
    ['round', '執行之輪次'],
    ['type', '任務類型: explore(探索)/ verify(驗證)'],
    ['arms / base', '指派之臂與起點節點(無 = 從零)'],
    ['claimKey / claim', '驗證類之主張鍵與主張(開頭 200 字); 探索類為 null'],
    ['family', '做夢最近一次整體研判所歸之機制家族(未歸類為 null)'],
    ['status.trust / action', '做夢審計之可信度(trusted / partial / untrusted)與處置; 尚未審計為 null'],
    ['status.vetoed / ladder', '是否被否決、回測期階梯'],
    ['status.inactiveArms', '指派而交付版未作用之臂(審計所定; 無審計者取節點自報)'],
    ['status.claimVerdict', '節點依方向所寫之判定方式自判之主張判定(confirmed / refuted); 無則 null'],
    ['status.issues', '迴圈檢查所列之問題(各取前 120 字)'],
    ['design.desc / params', '成品 meta 之說明與參數(成品自述)'],
    ['design.summary', '節點結論之摘要(開頭 400 字; agent 所寫)'],
    ['backtest.S', '回測期之分數 S(迴圈以現行評估器重跑)'],
    ['backtest.eqYrMean / eqYrMin / eqYrByPhase / nPosPhases', '七相位等效年化(%)之平均、最差、各相位、為正之相位數'],
    ['backtest.content', '挑選內容 = 對組成對照之超額: builtin(內建; 同側同活躍度)、recent(近 90 日活躍度版)、mean(兩者之均)、p / pRecent(單側 p)'],
    ['backtest.replays', '換亂數種子與同分次序之重放: 各次之 S、內建與近 90 日組成對照之超額'],
    ['backtest.monthlyOrders / peakHold / winRate', '月均單、最大同時持倉、勝率'],
    ['backtest.sigPerPick / longRatio', '每隻入選策略之訊號數、選集之做多比例'],
    ['backtest.selHash / pickSec / ledgerKey', '選集與下單序列之指紋、挑選耗時(秒)、評估帳本之鍵'],
    ['holdout.perf / content', '保留期(回測期之後、未用於搜尋之期間)之正負號: perf = 七相位等效年化之平均、content = 挑選內容(內建與近 90 日組成對照之超額之均); "+" / "-" / "0"; 未算為 null。只提供正負號, 不提供數字'],
    ['holdout.asOf', '保留期檢定所用資料之終點'],
    ['files.pick / doc', '本區內之程式碼複本、節點文件(Markdown)之相對路徑'],
]

let num = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null)
let clip = (s, n) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, n) : null)
let readJson = (fp) => {
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'))
    }
    catch (err) {
        return null
    }
}

//familyMap, 節點 id(前 8 字)→ 家族名: 取最近一份含 synthesis.overview.families 之做夢文件
let familyMap = (dreamDir) => {
    let out = new Map()
    let files = fs.existsSync(dreamDir) ? fs.readdirSync(dreamDir).filter((f) => /^r\d+\.json$/.test(f)).sort().reverse() : []
    for (let f of files) {
        let d = readJson(path.join(dreamDir, f))
        let fams = d && d.synthesis && d.synthesis.overview && d.synthesis.overview.families
        if (Array.isArray(fams) && fams.length) {
            for (let x of fams) {
                for (let id of Array.isArray(x.nodes) ? x.nodes : []) {
                    let k = String(id).slice(0, 8)
                    if (!out.has(k)) {
                        out.set(k, clip(x.name, 160))
                    }
                }
            }
            break
        }
    }
    return out
}

//infoOf, 一個節點文件 → 該策略之全部欄位(純函數; meta = 成品之 meta 或 null; fam = 家族名或 null; ho = 保留期之正負號或 null)
/**
 * 由一個節點文件取得該策略之全部欄位(純函數)
 *
 * 欄位分 identity、status、design、backtest、holdout、files 各組,缺值為 null。
 *
 * @param {Object} d 輸入節點文件,讀取 nodeId、round、task、spec、harness、conclusion、audit、code
 * @param {Object} [opt={}] 輸入設定物件,預設{}
 * @param {Object|null} [opt.meta=null] 輸入成品之 meta,預設null
 * @param {String|null} [opt.fam=null] 輸入家族名,預設null
 * @param {Object|null} [opt.ho=null] 輸入保留期之正負號(perf、content、asOf),預設null
 * @param {Function} [opt.rel] 輸入路徑轉相對路徑之函數,預設原樣回傳
 * @param {String} [opt.storeRel=''] 輸入儲存區之相對路徑,預設''
 * @returns {Object} 回傳該策略之欄位物件(id、short、round、type、arms、base、claimKey、claim、family、status、design、backtest、holdout、files)
 * @example
 * let info = infoOf(nodeDoc, { meta, fam: null, ho: null, storeRel: 'picks' })
 */
let infoOf = (d, { meta = null, fam = null, ho = null, rel = (p) => p, storeRel = '' } = {}) => {
    let h = d.harness || {}
    let m = (h.raw && h.raw.metrics) || {}
    let op = m.op || {}
    let eq = op.eqYr || {}
    let ns = m.nullSideAct || {}
    let nr = (m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side) || {}
    let both = [ns.excess, nr.excess].filter((v) => typeof v === 'number')
    let sc = h.score || {}
    let c = d.conclusion || {}
    let a = d.audit || null
    let id = d.nodeId
    return {
        id,
        short: String(id).slice(0, 8),
        round: d.round,
        type: (d.task && d.task.type) || 'explore',
        arms: d.spec.arms,
        base: d.spec.base || null,
        claimKey: d.spec.claim || null,
        claim: clip(d.task && d.task.claim, 200),
        family: fam,
        status: {
            trust: a ? a.trust || null : null,
            action: a ? a.action || null : null,
            vetoed: !!(sc.flags && sc.flags.vetoed),
            ladder: typeof sc.ladder === 'number' ? sc.ladder : null,
            inactiveArms: (a && Array.isArray(a.inactiveArms) ? a.inactiveArms : (d.code && Array.isArray(d.code.inactiveArms) ? d.code.inactiveArms : [])),
            claimVerdict: c.claimVerdict || null,
            issues: ((h.checks && h.checks.issues) || []).map((s) => clip(String(s), 120)),
        },
        design: {
            desc: clip(meta && meta.desc, 300),
            params: meta && meta.params && typeof meta.params === 'object' ? meta.params : null,
            summary: clip(c.summary, 400),
        },
        backtest: {
            S: num(sc.S),
            eqYrMean: num(eq.mean),
            eqYrMin: num(eq.min),
            eqYrByPhase: Array.isArray(eq.byPhase) ? eq.byPhase.map((v) => num(v, 1)) : null,
            nPosPhases: Array.isArray(eq.byPhase) ? eq.byPhase.filter((v) => v > 0).length : null,
            content: { builtin: num(ns.excess, 1), p: num(ns.p, 4), recent: num(nr.excess, 1), pRecent: num(nr.p, 4), mean: both.length ? num(both.reduce((s, v) => s + v, 0) / both.length, 1) : null },
            replays: Array.isArray(h.raw && h.raw.replays) ? h.raw.replays.map((x) => ({ S: num(x.S), builtin: num(x.comp, 1), recent: num(x.recent, 1) })) : [],
            monthlyOrders: num(op.monthlyOrders && op.monthlyOrders.mean, 1),
            peakHold: num(op.peakHold && op.peakHold.max, 0),
            winRate: num(op.winRate, 4),
            sigPerPick: num(m.sel && m.sel.sigPerPick, 2),
            longRatio: num(m.sel && m.sel.longRatio, 3),
            selHash: m.selHash || (h.raw && h.raw.selHash) || null,
            pickSec: num(m.ms && typeof m.ms.pick === 'number' ? m.ms.pick / 1000 : null, 1),
            ledgerKey: m.ledgerKey || null,
        },
        holdout: ho ? { perf: ho.perf || null, content: ho.content || null, asOf: ho.asOf || null } : { perf: null, content: null, asOf: null },
        files: { pick: `${storeRel}/${id}/pick.mjs`, doc: rel(d.__docMd || '') || null },
    }
}

//INDEX.md 之欄: [標題, 取值]
let f1 = (v) => (typeof v === 'number' ? v.toFixed(1) : '—')
/**
 * INDEX.md 之欄定義,每列為 [標題, 取值函數(以 infoOf 之結果為輸入)]
 *
 * @type {Array<Array>}
 */
let COLUMNS = [
    ['節點', (x) => `\`${x.short}\``],
    ['輪', (x) => `r${String(x.round).padStart(3, '0')}`],
    ['類型', (x) => (x.type === 'verify' ? '驗證' : '探索')],
    ['臂(←起點)', (x) => `${x.arms.join(' + ')}${x.base ? ` ←${x.base.slice(0, 8)}` : ''}`],
    ['審計', (x) => `${x.status.trust || '未審'}${x.status.vetoed ? '(否決)' : ''}`],
    ['回測期 S / 階梯', (x) => `**${x.backtest.S === null ? '—' : x.backtest.S}** / ${x.status.ladder === null ? '—' : x.status.ladder}`],
    ['七相位 平均 / 最差 / 為正', (x) => `${f1(x.backtest.eqYrMean)} / ${f1(x.backtest.eqYrMin)} / ${x.backtest.nPosPhases === null ? '—' : x.backtest.nPosPhases}`],
    ['挑選內容 內建 / 近 90 日(p)', (x) => `${f1(x.backtest.content.builtin)} / ${f1(x.backtest.content.recent)}(${x.backtest.content.p === null ? '—' : x.backtest.content.p})`],
    ['月均單 / 做多比例', (x) => `${f1(x.backtest.monthlyOrders)} / ${x.backtest.longRatio === null ? '—' : x.backtest.longRatio}`],
    ['保留期 績效 / 內容', (x) => `${x.holdout.perf || '·'} / ${x.holdout.content || '·'}`],
    ['機制(成品自述或結論摘要)', (x) => String(x.design.desc || x.design.summary || '—').replace(/\|/g, '/').slice(0, 110)],
]

let readmeText = (storeRel, n, asOf) => [
    '# 共同儲存「自適應挑選策略」區',
    '',
    `> 由迴圈產生(每輪結束與主控審定後重產),**agent 唯讀**。目前 ${n} 個策略。來源 = 各節點之交付版 \`pick.mjs\`(逐位複本)與節點文件內**迴圈以同一評估器重跑**之回測期數字(不是 agent 自報)。`,
    '',
    '## 怎麼用',
    '',
    `- **總表** \`${storeRel}/INDEX.md\`:每個策略一列,依回測期 S 由高至低;先看這份。`,
    `- **全部欄位** \`${storeRel}/index.json\`:\`items\` 為陣列,可自行排序、篩選(例:只看審計為 trusted 者、某一臂、某一家族、保留期為正者)。`,
    `- **程式碼** \`${storeRel}/<節點 id>/pick.mjs\`:該策略之交付版;要以它為底者照任務書之規定複製到自己之工作夾。`,
    `- **單一策略之欄位** \`${storeRel}/<節點 id>/info.json\`;完整之紀錄(規劃、實驗、審計)在其節點文件(\`files.doc\`)。`,
    '- 本區只收**已執行並經迴圈重跑**之節點成品;做夢之預先核對檔與共用工具區之樣板不在此列(見共用工具區之索引)。',
    '',
    '## 保留期之正負號',
    '',
    '- 保留期 = 回測期之後、未用於搜尋之期間(2026-08-01 起)。檢定由主控執行,**數字不提供,只提供正負號**:',
    '  - `holdout.perf`:該策略於保留期之績效(七相位等效年化之平均)為正 `+`、為負 `-`、無單或為零 `0`。',
    '  - `holdout.content`:該策略於保留期之挑選內容(內建與近 90 日組成對照之超額之均)為正 `+`、為負 `-`。',
    `  - 未算者為 null(總表顯示「·」)。${asOf ? `目前之檢定所用資料至 ${asOf}。` : '目前尚無任何檢定結果。'}`,
    '- 用途:大致判斷一條線於回測期之外是否仍成立(方向與可用性)。保留期遠短於回測期,單一正負號之雜訊大 —— 看**同一家族多個成品是否同號**,不以單一成品之正負號下結論;不得為了湊出正號而反覆換設計(那等於把保留期變成訓練資料)。',
    '',
    '## 欄位',
    '',
    '| 欄位 | 說明 |',
    '|---|---|',
    ...FIELD_DEFS.map(([k, v]) => `| \`${k}\` | ${v} |`),
    '',
    '讀取端請以鍵取值、容許未知之鍵與 null(欄位會擴充;舊節點可能無某欄)。',
    '',
].join('\n')

//buildPickStore, 產生(或更新)共同儲存區; 回 { dir, n, copied, skipped[], holdoutSigned }
//  st: getSettings() 之結果(records.nodeDir / workDir / dreamDir、rsi.root、FD_ROOT)
/**
 * 產生或更新共同儲存「自適應挑選策略」區(<rsi.root>/picks/;會寫入 pick.mjs 複本、info.json、index.json、INDEX.md、README.md)
 *
 * @param {Object} st 輸入設定物件(getSettings 之結果),讀取 st.records.nodeDir、st.records.workDir、st.records.dreamDir、st.rsi.root、st.FD_ROOT
 * @returns {Promise<Object>} 回傳 { dir, n, copied, skipped, holdoutSigned }:儲存區路徑、策略數、新複製之程式碼數、略過清單、已有保留期正負號之數量
 * @example
 * let r = await buildPickStore(st)
 */
let buildPickStore = async (st) => {
    let dir = path.join(st.rsi.root, 'picks')
    let rel = (p) => (p ? path.relative(st.FD_ROOT, p).replace(/\\/g, '/') : '')
    let storeRel = rel(dir)
    fs.mkdirSync(dir, { recursive: true })
    let fams = familyMap(st.records.dreamDir)
    let hoFile = readJson(path.join(dir, '_holdout.json'))
    let hoItems = (hoFile && hoFile.items) || {}
    let items = []
    let skipped = []
    let copied = 0
    let docs = fs.existsSync(st.records.nodeDir) ? fs.readdirSync(st.records.nodeDir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)).sort() : []
    for (let f of docs) {
        let d = readJson(path.join(st.records.nodeDir, f))
        if (!d || !d.nodeId || !d.spec || !Array.isArray(d.spec.arms) || !d.harness || d.harness.ok !== true || !d.harness.score) {
            if (d && d.nodeId) {
                skipped.push(`${String(d.nodeId).slice(0, 8)}(無迴圈重跑之結果)`)
            }
            continue
        }
        let src = path.join(st.records.workDir, d.nodeId, 'pick.mjs')
        if (!fs.existsSync(src)) {
            skipped.push(`${String(d.nodeId).slice(0, 8)}(工作夾無 pick.mjs)`)
            continue
        }
        let dst = path.join(dir, d.nodeId, 'pick.mjs')
        let code = fs.readFileSync(src)
        if (!fs.existsSync(dst) || !fs.readFileSync(dst).equals(code)) {
            fs.mkdirSync(path.dirname(dst), { recursive: true })
            fs.writeFileSync(dst, code)
            copied++
        }
        let meta = null
        try {
            meta = (await loadPick(src)).meta
        }
        catch (err) {}
        d.__docMd = path.join(st.records.nodeDir, `${d.nodeId}.md`)
        let ho = hoItems[d.nodeId] ? { ...hoItems[d.nodeId], asOf: hoFile.asOf || null } : null
        let info = infoOf(d, { meta, fam: fams.get(String(d.nodeId).slice(0, 8)) || null, ho, rel, storeRel })
        fs.writeFileSync(path.join(dir, d.nodeId, 'info.json'), JSON.stringify(info, null, 1), 'utf8')
        items.push(info)
    }
    items.sort((p, q) => (q.backtest.S === null ? -Infinity : q.backtest.S) - (p.backtest.S === null ? -Infinity : p.backtest.S) || (p.id < q.id ? -1 : 1))
    let updatedAt = new Date().toISOString()
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schema: SCHEMA, updatedAt, holdoutAsOf: (hoFile && hoFile.asOf) || null, fields: FIELD_DEFS.map(([key, note]) => ({ key, note })), items }, null, 1), 'utf8')
    let L = []
    L.push('# 自適應挑選策略總表')
    L.push('')
    L.push(`> 由迴圈產生(${updatedAt});${items.length} 個策略,依回測期 S 由高至低。欄位說明與用法見 \`${storeRel}/README.md\`;全部欄位見 \`${storeRel}/index.json\`;程式碼在 \`${storeRel}/<節點 id>/pick.mjs\`。`)
    L.push('> 「保留期」一欄只有正負號(「·」= 未算);S 高不等於有挑選內容 —— 先看「挑選內容」與審計。')
    L.push('')
    L.push(`| ${COLUMNS.map(([t]) => t).join(' | ')} |`)
    L.push(`|${COLUMNS.map(() => '---').join('|')}|`)
    for (let x of items) {
        L.push(`| ${COLUMNS.map(([, fn]) => fn(x)).join(' | ')} |`)
    }
    L.push('')
    fs.writeFileSync(path.join(dir, 'INDEX.md'), L.join('\n'), 'utf8')
    fs.writeFileSync(path.join(dir, 'README.md'), readmeText(storeRel, items.length, (hoFile && hoFile.asOf) || null), 'utf8')
    return { dir, n: items.length, copied, skipped, holdoutSigned: items.filter((x) => x.holdout.perf !== null).length }
}

export { buildPickStore, infoOf, familyMap, FIELD_DEFS, COLUMNS, SCHEMA }
