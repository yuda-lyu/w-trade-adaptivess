import path from 'path'
import { settingsOrExit, argStrOf, cliGuard } from '../cfg.mjs'
import { peekRunLock } from '../arsi/runner.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶任何引數(補記)者拒跑(離開碼 2; 於組裝專案與任何寫入之前; 規則 R-RUN-11); 無引數之列出照常
guardEntry('armInactive')
//命令列之旗標只認 --key value(空白分隔)與 TOOL_FLAGS.armInactive 所列者(未列、等號、重複、無值、多餘之值一律拒收; 離開碼 2; 於組裝專案與任何寫入之前; 訊息固定、不帶輸入值)
cliGuard('armInactive')

//節點之「未作用之臂」之補記(主控用; 規則 R-REC-20): 指派之臂中, 交付版未作用者(試過後關閉, 或交付版所做的不屬該臂之定義)
//  平時由節點自報(code.inactiveArms)、做夢之審計定案(audits[].inactiveArms → 樹之 evidence.inactiveArms); 本工具只供主控補記:
//    ①此欄位設立前已審之節點 ②主控審定臂之修訂後, 既有節點不再屬該臂者
//  node tools/armInactive.mjs                                              列出樹上有未作用之臂之節點
//  node tools/armInactive.mjs --node <id 或前綴> --arms <a,b | none> --why <理由> [--offdef <a,b>]
//    --offdef: --arms 之中「依修訂後之定義不屬該臂」者(主控審定臂之修訂後用); 該臂不再計入「已試」, 無其他節點時由補位載體再試
//  只寫樹上該節點之 evidence.inactiveArms(附出處與理由)並重產看板與搜尋地圖; S、階梯、選集指紋不變(變了即報錯)
//  輪次進行中不得執行(看板與載體於輪中由迴圈讀寫)
let st = settingsOrExit()
let P = makeProjectOrExit(st, {})
P.rsi.init()
let executed = () => P.rsi.store.listIndex().filter((r) => r.status === 'executed').map((r) => P.rsi.store.getNode(r.id)).filter(Boolean)

//字串旗標(--node、--arms、--why、--offdef)取命令列之原字串(argStrOf; 排程第 607 項): 原以 argOf 讀 ⇒ 全為數字之 id 前綴(如 --node 20261122)被轉成數值而 `typeof key !== 'string'` ⇒ 靜默進入列出模式(未補記)
let key = argStrOf('node', null)
if (typeof key !== 'string') {
    let rows = executed().map((n) => ({ n, off: P.inactiveArmsOf(n) })).filter((x) => x.off.length)
    console.log(`樹上有未作用之臂之節點 ${rows.length} 個`)
    for (let { n, off } of rows) {
        let od = P.offDefArmsOf(n)
        console.log(`- ${n.id}(${n.spec.arms.join(' + ')};S ${n.score ? n.score.S : '—'}):未作用 ${off.join('、')}(${n.evidence && Array.isArray(n.evidence.inactiveArms) ? '審計 / 主控所定' : '節點自報'})${od.length ? `;其中依修訂後之定義不屬該臂 ${od.join('、')}` : ''}`)
    }
    process.exit(0)
}
let armsArg = argStrOf('arms', null)
let why = argStrOf('why', null)
if (typeof armsArg !== 'string' || typeof why !== 'string' || !why.trim()) {
    console.error('用法: --node <id 或前綴> --arms <a,b | none> --why <理由>')
    process.exit(2)
}
let lock = peekRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
if (lock.running) {
    console.error(`輪次進行中(pid ${lock.pid}): 請於輪次結束後再執行`)
    process.exit(3)
}
let hits = executed().filter((n) => n.id.startsWith(key))
if (hits.length !== 1) {
    //訊息不帶輸入之前綴(K9; 排程第 611 項 ②; 原: `節點 <前綴>: 符合 N 個`)
    console.error(`節點前綴符合 ${hits.length} 個(須恰為 1 個)`)
    process.exit(2)
}
let n = hits[0]
let arms = armsArg === 'none' ? [] : armsArg.split(',').map((s) => s.trim()).filter(Boolean)
let bad = arms.filter((a) => !n.spec.arms.includes(a))
if (bad.length) {
    //訊息不帶輸入之臂名(K9; 排程第 611 項 ② 之同檔鄰近者; 原: `<臂名> 不是節點 … 之臂`); 節點 id(取自樹)與其臂照列
    console.error(`所給之臂有 ${bad.length} 個不是節點 ${n.id.slice(0, 8)} 之臂(${n.spec.arms.join(' + ')})`)
    process.exit(2)
}
//--offdef <a,b>(選配; --arms 之子集): 其中「依修訂後之定義不屬該臂」者 —— 與試過後關閉不同, 該臂依現行定義未被此節點試過 ⇒ 不計入「已試之臂」(補位載體會再出該臂)
//  未給 = 無(並清除先前所記者)
let offArg = argStrOf('offdef', null)
let offDef = typeof offArg === 'string' ? offArg.split(',').map((s) => s.trim()).filter(Boolean) : []
let badOff = offDef.filter((a) => !arms.includes(a))
if (badOff.length) {
    console.error(`--offdef 之 ${badOff.join('、')} 不在 --arms 之內(不屬該臂者必同時為未作用)`)
    process.exit(2)
}
let before = { S: n.score ? n.score.S : null, ladder: n.score ? n.score.ladder : null }
let after = P.rsi.setEvidence(n.id, { inactiveArms: arms, offDefArms: offDef }, { ref: '主控(tools/armInactive.mjs)', note: why.trim().slice(0, 300) })
if ((after.score ? after.score.S : null) !== before.S || (after.score ? after.score.ladder : null) !== before.ladder) {
    console.error(`**分數變了**(S ${before.S} → ${after.score ? after.score.S : null};階梯 ${before.ladder} → ${after.score ? after.score.ladder : null}): 未作用之臂不應影響計分, 請查 domain.score`)
    process.exit(1)
}
//節點文件同步(渲染於「審計」一節之末; 審計當時所定者照留, 以本列為準): 否則文件寫「審計所定: 無」而看板標「未作用」
let doc = P.records.getNodeDoc(n.id)
if (doc) {
    doc.control = { ...(doc.control || {}), inactiveArms: { arms, offDef, why: why.trim().slice(0, 300), at: new Date().toISOString() } }
    P.records.putNodeDoc(doc)
}
let b = P.writeBoard()
console.log(`已記 ${n.id.slice(0, 8)} 之未作用之臂: ${arms.join('、') || '無'}${offDef.length ? `(其中依修訂後之定義不屬該臂、不計入已試: ${offDef.join('、')})` : ''}(S ${before.S}、階梯 ${before.ladder} 不變);${doc ? '節點文件已同步;' : ''}看板與搜尋地圖已重產(節點 ${b.nNodes};未試之可選臂 ${b.untried})`)
