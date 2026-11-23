// 各輪做夢之改進項依類別之筆數與前次方向回顧之判定筆數(逐輪趨勢)
//  用途: 改進項分為 迴圈架構 / 做夢原則 / 節點原則 / 共用工具 / 績效判準 / 獨立驗證判準 / 專案外 七類(規格見 src/arsi/records.mjs 檔頭);
//        各類之筆數逐輪下降 = 該層趨於穩定; 方向之判定(成立 / 不成立 / 無法判定 / 方向有錯 / 未執行)= 做夢品質之量測
//  舊格式(arsi.dream/1)之做夢文件只有未分類之 toolRequests: 其人工分類記於 rsi/records/improveLegacy.json({ "r001": ["score", …](依 toolRequests 之順序), … , "extra": { "r003": ["external"] }(回饋檔內而不在 toolRequests 者) })
//  用法: node tools/improveTrend.mjs [--json]
import fs from 'fs'
import path from 'path'
import { settingsOrExit, cliGuard } from '../cfg.mjs'
import { createFileRecords, tallyDream, roundName, IMPROVE_KINDS, IMPROVE_LABELS, DIR_VERDICTS, DIR_LABELS } from '../arsi/records.mjs'

//命令列之旗標只認 --json(TOOL_FLAGS.improveTrend): 等號、未列、重複、多餘之值一律拒收(離開碼 2; 於讀設定之前; 訊息固定、不帶輸入值)
cliGuard('improveTrend')
let st = settingsOrExit()
let records = createFileRecords(st.records)
let fpLegacy = path.join(path.dirname(st.records.dreamDir), 'improveLegacy.json')
let legacy = {}
try {
    legacy = JSON.parse(fs.readFileSync(fpLegacy, 'utf8'))
}
catch (err) {}

let rows = []
for (let d of records.listDreamDocs()) {
    let t = tallyDream(d)
    let im = { ...t.improvements }
    let rn = roundName(d.round)
    //舊制之人工分類: 把未分類者依對照表歸入各類(筆數須與 toolRequests 相符才套用)
    let lg = Array.isArray(legacy[rn]) ? legacy[rn] : null
    let nLegacy = d.guidance && Array.isArray(d.guidance.toolRequests) ? d.guidance.toolRequests.length : 0
    let source = im.total ? 'agent' : '—'
    if (lg && nLegacy > 0 && lg.length === nLegacy) {
        for (let k of lg) {
            if (IMPROVE_KINDS.includes(k)) {
                im[k]++
                im.unclassified--
            }
        }
        source = '人工(舊制)'
    }
    for (let k of (legacy.extra && Array.isArray(legacy.extra[rn]) ? legacy.extra[rn] : [])) {
        if (IMPROVE_KINDS.includes(k)) {
            im[k]++
            im.total++
        }
    }
    rows.push({ round: d.round, name: rn, source, improvements: im, prevDirections: t.prevDirections, directions: ((d.guidance && d.guidance.directions) || []).length, avoid: ((d.guidance && d.guidance.avoid) || []).length })
}

if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1))
}
else {
    console.log(`| 輪 | 分類來源 | ${IMPROVE_KINDS.map((k) => IMPROVE_LABELS[k]).join(' | ')} | 未分類 | 合計 | 方向 / 避免(提示;不計入改進項) | 前次方向之回顧 |`)
    console.log(`|---|---|${IMPROVE_KINDS.map(() => '---').join('|')}|---|---|---|---|`)
    for (let r of rows) {
        let pd = r.prevDirections
        console.log(`| ${r.name} | ${r.source} | ${IMPROVE_KINDS.map((k) => r.improvements[k]).join(' | ')} | ${r.improvements.unclassified} | ${r.improvements.total} | ${r.directions} / ${r.avoid} | ${pd.total ? DIR_VERDICTS.filter((k) => pd[k]).map((k) => `${DIR_LABELS[k]} ${pd[k]}`).join('、') : '—'} |`)
    }
}
