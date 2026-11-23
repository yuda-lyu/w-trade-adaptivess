import path from 'path'
import { settingsOrExit, argStrOf, cliGuard } from '../cfg.mjs'
import { peekRunLock } from '../arsi/runner.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'
import { FORMS, formLabelOf } from '../arsi/records.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶任何引數(補記、清除)者拒跑(離開碼 2; 於組裝專案與任何寫入之前; 規則 R-RUN-11); 無引數之列出照常
guardEntry('formSet')
//命令列之旗標只認 --key value(空白分隔)與 TOOL_FLAGS.formSet 所列者(未列、等號、重複、無值、多餘之值一律拒收; --form 之值須為 mechanism / clue / none〔CLI_VALUES〕; 離開碼 2; 於組裝專案與任何寫入之前; 訊息固定、不帶輸入值)
cliGuard('formSet')

//成品之形式之補記(主控用; 規則 R-REC-53): 形式平時由節點自填(conclusion.form)、做夢之審計定案(audits[].form → 採納時寫入樹之 evidence.form); 本工具只供主控補記:
//  ①此欄設立前已審之節點(審計當時尚無此欄) ②主控覆核後要更正或清除者
//  node tools/formSet.mjs                                                     列出樹上全部已執行之節點之形式(〔機制〕/〔線索〕/ 未歸類; 來源: 審計所定、主控補記; 未歸類者另列節點之自標)
//  node tools/formSet.mjs --node <id 或前綴> --form <mechanism|clue|none> --why <理由>    補記(none = 清除: 記 null ⇒ 未歸類)
//  只寫樹上該節點之 evidence.form(附出處與理由)與節點文件之 control.form 並重產看板與搜尋地圖; S、階梯、選集指紋不變(變了即報錯, 離開碼 1)
//  輪次進行中不得執行(離開碼 3; 補位之底與量尺於輪中由迴圈讀寫)
let st = settingsOrExit()
let P = makeProjectOrExit(st, {})
P.rsi.init()
let executed = () => P.rsi.store.listIndex().filter((r) => r.status === 'executed').map((r) => P.rsi.store.getNode(r.id)).filter(Boolean)

//字串旗標(--node、--form、--why)取命令列之原字串(argStrOf; 全為數字之 id 前綴不得被轉成數值而靜默進入列出模式)
let key = argStrOf('node', null)
let formArg = argStrOf('form', null)
let why = argStrOf('why', null)
if (key === null && formArg === null && why === null) {
    let rows = executed()
    let srcOf = (n) => {
        let d = P.records.getNodeDoc(n.id)
        if (P.formOf(n) !== null) {
            return d && d.control && d.control.form && d.control.form.form === P.formOf(n) ? '主控補記' : '審計所定'
        }
        let self = d && d.conclusion && FORMS.includes(d.conclusion.form) ? d.conclusion.form : null
        return self ? `節點自標 ${formLabelOf(self)},未經審計` : '無自標'
    }
    let cnt = (f) => rows.filter((n) => P.formOf(n) === f).length
    console.log(`樹上已執行之節點 ${rows.length} 個:〔機制〕${cnt('mechanism')}、〔線索〕${cnt('clue')}、未歸類 ${cnt(null)}${P.formGate ? '(設定 rsi.formGate 開啟:補位之底、方向之起點、量尺與參考節點只計〔機制〕)' : ''}`)
    for (let n of rows) {
        console.log(`- ${n.id}(${n.spec.arms.join(' + ')};S ${n.score ? n.score.S : '—'};${(n.evidence && n.evidence.trust) || '未審'}):${formLabelOf(P.formOf(n))}(${srcOf(n)})`)
    }
    process.exit(0)
}
if (typeof key !== 'string' || typeof formArg !== 'string' || typeof why !== 'string' || !why.trim()) {
    console.error('用法: --node <id 或前綴> --form <mechanism|clue|none> --why <理由>')
    process.exit(2)
}
let lock = peekRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
if (lock.running) {
    console.error(`輪次進行中(pid ${lock.pid}): 請於輪次結束後再執行`)
    process.exit(3)
}
let hits = executed().filter((n) => n.id.startsWith(key))
if (hits.length !== 1) {
    //訊息不帶輸入之前綴(K9)
    console.error(`節點前綴符合 ${hits.length} 個(須恰為 1 個)`)
    process.exit(2)
}
let n = hits[0]
//--form 之值已由 cliGuard 核對(mechanism / clue / none; 去頭尾空白後比對); none = 清除
let fv = formArg.trim() === 'none' ? null : formArg.trim()
let before = { S: n.score ? n.score.S : null, ladder: n.score ? n.score.ladder : null, form: P.formOf(n) }
let after = P.rsi.setEvidence(n.id, { form: fv }, { ref: '主控(tools/formSet.mjs)', note: why.trim().slice(0, 300) })
if ((after.score ? after.score.S : null) !== before.S || (after.score ? after.score.ladder : null) !== before.ladder) {
    console.error(`**分數變了**(S ${before.S} → ${after.score ? after.score.S : null};階梯 ${before.ladder} → ${after.score ? after.score.ladder : null}): 形式不應影響計分, 請查 domain.score`)
    process.exit(1)
}
//節點文件同步(渲染於「審計」一節之末; 審計當時所定者照留, 以本列為準)
let doc = P.records.getNodeDoc(n.id)
if (doc) {
    doc.control = { ...(doc.control || {}), form: { form: fv, why: why.trim().slice(0, 300), at: new Date().toISOString() } }
    P.records.putNodeDoc(doc)
}
let b = P.writeBoard()
console.log(`已記 ${n.id.slice(0, 8)} 之形式: ${formLabelOf(before.form)} → ${formLabelOf(fv)}(S ${before.S}、階梯 ${before.ladder} 不變);${doc ? '節點文件已同步;' : ''}看板與搜尋地圖已重產(節點 ${b.nNodes})`)
