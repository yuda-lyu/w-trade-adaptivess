import path from 'path'
import { getSettings, argOf, argStrOf } from '../cfg.mjs'
import { peekRunLock } from '../arsi/runner.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶任何引數(放行 / 撤銷)者拒跑(離開碼 2; 於組裝專案與任何寫入之前; 規則 R-RUN-11); 無引數之列出照常
guardEntry('exposure')

//側別曝險之放行(主控用; 規則 R-REC-48): 側別曝險且未放行之成品不作為補位之底與方向之起點; 主控核對後可逐案放行(仍標示「曝險(已放行)」)
//  node tools/exposure.mjs                                       列出樹上側別曝險之節點(定性之理由、是否已放行)
//  node tools/exposure.mjs --node <id 或前綴> --why <理由>          放行: 記樹之 evidence.exposureRelease = { selHash: 正本之選集指紋, why, at }
//  node tools/exposure.mjs --undo --node <id 或前綴> --why <理由>   撤銷: 記 evidence.exposureRelease = null
//  放行綁選集指紋: 重做或 reverify 使選集指紋改變者放行自動失效(須重新放行); 只對判為側別曝險之節點放行; 撤銷只對已放行者
//  寫入後: S、階梯不變(變了即報錯, 離開碼 1); 節點文件之 control.exposureRelease 同步; 該節點之「提示(側別曝險)」即時改寫; 重產看板與搜尋地圖
//  輪次進行中不得執行(看板、載體與迴圈檢查於輪中由迴圈讀寫); 判定關閉(settings.rsi.exposure = false)者只列出此事
let st = getSettings()
let P = makeProjectOrExit(st, {})
P.rsi.init()
let executed = () => P.rsi.store.listIndex().filter((r) => r.status === 'executed').map((r) => P.rsi.store.getNode(r.id)).filter(Boolean)

let key = argStrOf('node', null)
let undo = process.argv.includes('--undo')
if (typeof key !== 'string' && !undo) {
    if (!P.exposureOn) {
        console.log('側別曝險之判定已關閉(settings.rsi.exposure = false)')
        process.exit(0)
    }
    let rows = executed().map((n) => ({ n, e: P.exposureOf(n) })).filter((x) => x.e.hit)
    console.log(`樹上側別曝險之節點 ${rows.length} 個(未放行者不作為補位之底與方向之起點)`)
    for (let { n, e } of rows) {
        console.log(`- ${n.id}(${n.spec.arms.join(' + ')};S ${n.score ? n.score.S : '—'}):${e.why};${e.released ? '已放行' : '未放行'}`)
    }
    process.exit(0)
}
let why = argOf('why', null)
if (typeof key !== 'string' || typeof why !== 'string' || !why.trim()) {
    console.error('用法: [--undo] --node <id 或前綴> --why <理由>')
    process.exit(2)
}
if (!P.exposureOn) {
    console.error('側別曝險之判定已關閉(settings.rsi.exposure = false): 無須放行')
    process.exit(2)
}
let lock = peekRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
if (lock.running) {
    console.error(`輪次進行中(pid ${lock.pid}): 請於輪次結束後再執行`)
    process.exit(3)
}
let hits = executed().filter((n) => n.id.startsWith(key))
if (hits.length !== 1) {
    console.error(`節點 ${key}: 符合 ${hits.length} 個(須恰為 1 個)`)
    process.exit(2)
}
let n = hits[0]
let e = P.exposureOf(n)
if (!undo && !e.hit) {
    console.error(`節點 ${n.id.slice(0, 8)} 不是側別曝險之成品: 無須放行`)
    process.exit(2)
}
if (undo && !e.released) {
    console.error(`節點 ${n.id.slice(0, 8)} 未放行: 無從撤銷`)
    process.exit(2)
}
let sel = n.raw && typeof n.raw.selHash === 'string' ? n.raw.selHash : ''
if (!undo && !sel) {
    console.error(`節點 ${n.id.slice(0, 8)} 無選集指紋: 放行無從綁定`)
    process.exit(2)
}
let rec = undo ? null : { selHash: sel, why: why.trim().slice(0, 300), at: new Date().toISOString() }
let before = { S: n.score ? n.score.S : null, ladder: n.score ? n.score.ladder : null }
let after = P.rsi.setEvidence(n.id, { exposureRelease: rec }, { ref: '主控(tools/exposure.mjs)', note: why.trim().slice(0, 300) })
if ((after.score ? after.score.S : null) !== before.S || (after.score ? after.score.ladder : null) !== before.ladder) {
    console.error(`**分數變了**(S ${before.S} → ${after.score ? after.score.S : null};階梯 ${before.ladder} → ${after.score ? after.score.ladder : null}): 放行不應影響計分, 請查 domain.score`)
    process.exit(1)
}
//節點文件同步(渲染於「審計」一節之末)、提示即時改寫(放行者移除、撤銷者補回)、看板與搜尋地圖重產
let doc = P.records.getNodeDoc(n.id)
if (doc) {
    doc.control = { ...(doc.control || {}), exposureRelease: rec ? { fingerprint: rec.selHash, why: rec.why, at: rec.at } : null }
    P.records.putNodeDoc(doc)
}
P.refreshEvalHints([n.id])
let b = P.writeBoard()
console.log(`${undo ? '已撤銷' : '已放行'} ${n.id.slice(0, 8)} 之側別曝險(${e.why}${undo ? '' : `;綁選集指紋 ${sel.slice(0, 12)}`})(S ${before.S}、階梯 ${before.ladder} 不變);${doc ? '節點文件已同步;' : ''}看板與搜尋地圖已重產(節點 ${b.nNodes})`)
