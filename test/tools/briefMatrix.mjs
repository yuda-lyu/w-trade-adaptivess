import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FD_TMP } from './synthLedger.mjs'


//briefMatrix, 節點任務書之大小之情境表(規則 R-REC-52; 供 test/unit-briefSize.test.mjs 與變異; 亦可單獨執行列出各情境之位元組數: node test/tools/briefMatrix.mjs)
//  15,000 位元組 = 「逾即整併」之維護門檻(非執行期硬上限); 守門之範圍 = 下列各軸之全部組合(不含來源方向之全文與重做之要求: 兩者之長度由做夢與審計決定、不屬任務書之固定文字):
//    type    探索 / 驗證
//    base    無起點 / 起點(新加之臂不屬取法・執行層) / 起點(新加之臂屬執行層) / 起點(新加之臂屬執行層,且起點有未作用之臂)
//    toolbox 有 / 無共用工具區
//    store   無共同儲存區 / 有總表 / 有總表與其他標的之正負號(兩者皆有時任務書最長)
//  共同儲存區之路徑寫在任務書內 ⇒ 夾名固定為同長(相對專案根 31 字元 = 既有守門夾具 test/_tmp/texts_suspect_<7 位行程號> 之最長者), 位元組數不隨行程號之位數而變
export const BRIEF_LIMIT = 15000
export const NODE_ID = '06c4e5f4bdd6d5f0'
export const TYPES = ['explore', 'verify']
export const BASES = ['none', 'plain', 'exec', 'execInactive']
export const STORES = ['none', 'store', 'cross']

let ARM_A = { id: 'A04_act', layer: 'A', layerName: 'A 資格', title: '活躍度', desc: '近期有進場者', grid: null }
let ARM_B = { id: 'B02_rank', layer: 'B', layerName: 'B 排序', title: '排序', desc: '依分數排序', grid: null }
let ARM_E = { id: 'E38_maxHoldN', layer: 'E', layerName: 'E 執行', title: '同時持倉上限', desc: 'accept 以 book.open 限制', grid: null }
let TOOLBOX = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
let baseNode = (o = {}) => ({ nodeId: 'base000011112222', arms: ['A04_act'], inactiveArms: [], S: 12.3, ladder: 1, backtest: null, doc: 'rsi/records/nodes/base000011112222.md', ...o })

//taskOf, 一個情境之節點任務(與 taskFor 回傳之形狀相同; 無來源方向)
export let taskOf = (type, base, toolbox) => {
    let arms = base === 'none' ? [ARM_A] : (base === 'plain' ? [ARM_A, ARM_B] : [ARM_A, ARM_E])
    let b = null
    if (base === 'plain' || base === 'exec') {
        b = baseNode()
    }
    else if (base === 'execInactive') {
        b = baseNode({ arms: ['A04_act', 'E39_skipWeekend'], inactiveArms: ['E39_skipWeekend'] })
    }
    return { goal: 'g', type, claim: type === 'verify' ? '主張甲' : null, arms, base: b, refs: [], direction: null, toolbox: toolbox ? TOOLBOX : null }
}

//briefMatrix({ makeTexts, st, FD_ROOT? }), 逐情境產生節點任務書並量位元組數 ⇒ [{ type, base, toolbox, store, bytes, text }]
//  makeTexts 由呼叫端給(測試於修前之複本中匯入複本之 texts.mjs); st = getSettings() 之設定(寫法守則關閉); 共同儲存區之夾建於 test/_tmp/ 並於結束時刪除
export let briefMatrix = ({ makeTexts, st }) => {
    let st1 = { ...st, rsi: { ...st.rsi, guides: false } }
    let dirs = STORES.map((s, i) => path.join(FD_TMP, `briefSize_s${i}_00000000`))
    let rows = []
    try {
        STORES.forEach((s, i) => {
            fs.rmSync(dirs[i], { recursive: true, force: true })
            fs.mkdirSync(path.join(dirs[i], 'picks'), { recursive: true })
            if (s !== 'none') {
                fs.writeFileSync(path.join(dirs[i], 'picks', 'INDEX.md'), '# 總表\n', 'utf8')
            }
            if (s === 'cross') {
                fs.writeFileSync(path.join(dirs[i], 'picks', '_cross.json'), '{}', 'utf8')
            }
        })
        //節點 id 取真實之長度(引擎之 nodeIdOf 回 16 位十六進位; 工作夾之路徑於任務書出現十餘次, 位元組數隨之而變)
        let wd = path.join(st1.records.workDir, NODE_ID)
        for (let [i, store] of STORES.entries()) {
            let texts = makeTexts({ st: { ...st1, rsi: { ...st1.rsi, root: dirs[i] } }, FD_ROOT: st1.FD_ROOT })
            for (let type of TYPES) {
                for (let base of BASES) {
                    for (let toolbox of [true, false]) {
                        let text = texts.nodeBrief({ workDir: wd, task: taskOf(type, base, toolbox), round: 9, nodeId: NODE_ID, attempt: 1 })
                        rows.push({ type, base, toolbox, store, bytes: Buffer.byteLength(text, 'utf8'), text })
                    }
                }
            }
        }
    }
    finally {
        for (let d of dirs) {
            fs.rmSync(d, { recursive: true, force: true })
        }
    }
    return rows
}

//直接執行: 列各情境之位元組數(依大到小), 標逾門檻者
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let { getSettings } = await import('../../src/cfg.mjs')
    let { makeTexts } = await import('../../src/domain/texts.mjs')
    let rows = briefMatrix({ makeTexts, st: getSettings() })
    rows.sort((a, b) => b.bytes - a.bytes)
    console.log(`情境 ${rows.length} 個;門檻 ${BRIEF_LIMIT} 位元組;逾門檻 ${rows.filter((r) => r.bytes > BRIEF_LIMIT).length} 個;最大 ${rows[0].bytes}`)
    for (let r of rows) {
        console.log(`${r.bytes}\t${r.type}\t${r.base}\t${r.toolbox ? '有工具區' : '無工具區'}\t${r.store}${r.bytes > BRIEF_LIMIT ? '\t**逾門檻**' : ''}`)
    }
}
