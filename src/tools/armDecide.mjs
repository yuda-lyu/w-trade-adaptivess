import fs from 'fs'
import path from 'path'
import { getSettings, argOf, argStrOf, cliGuard, FD_ROOT } from '../cfg.mjs'
import { peekRunLock } from '../arsi/runner.mjs'
import { ARM_LABELS, armProposalLine } from '../arsi/records.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { decideArgsOf } from '../domain/armCatalog.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶任何引數(審定)者拒跑(離開碼 2; 於組裝專案與任何寫入之前; 規則 R-RUN-11); 無引數之列出照常
guardEntry('armDecide')
//命令列之旗標只認 --key value(空白分隔)與 TOOL_FLAGS.armDecide 所列者: 等號寫法、未列之旗標、重複、無值、多餘之值一律拒收(離開碼 2; 於組裝專案與任何寫入之前; 訊息固定、不帶輸入值; 原: 靜默忽略)
cliGuard('armDecide')

//臂目錄之提案之審定(主控用; 規則 R-ARM-2): 節點與做夢「提」, 主控「審」; 經引擎之治理(rsi.governance.decide)寫入 <狀態根>/governance/
//  (擴充檔 extensions.json 為提交點, 其後提案帳 proposals.json 與 PROPOSALS.md), 並重寫供 agent 閱讀之 arms/catalog.json; 下一輪起可指派
//  node tools/armDecide.mjs                                列出待審之提案
//  node tools/armDecide.mjs --id P001 --reject --why "<理由>"
//  node tools/armDecide.mjs --id P001 --accept --why "<審查意見>" [選項]
//    新臂(new):   --name <英數名>(必填; 臂 id = <層代號><流水號>_<英數名>) [--layer <層代號>] [--title <名稱>] [--desc <機制說明>] [--selectable false] [--arm-id <完整 id>]
//    新層(layer): [--layer <代號>(預設取下一個未用之字母)] [--title <層名>] [--desc <這一層管什麼>]
//    修訂(revise): [--title <名稱>] [--desc <修訂後之定義>] [--selectable true|false] [--no-grid(移除目錄所附之建議格點)]
//    停用(retire): 無選項(理由取 --why)
//    --why-file / --desc-file <檔>: 自檔讀取文字(UTF-8; 內容較長或含引號時用)
//  機制說明(desc)預設取提案之 mechanism; 主控應先改成「機制之中性描述」(不含結論與數字)再通過
//  輪次進行中不得通過(輪次行程已載入舊目錄, 做夢卻會讀到新目錄 ⇒ 所提之新臂被迴圈擋下); 不採不受此限
//  不合(參數不足、審定後之目錄不合等)⇒ 提案帳與擴充檔皆不變(引擎於寫入前試建目錄)
let st = getSettings()
//本工具不派工 ⇒ 換上不派工之派工器(不讀派工用之金鑰)
let P = makeProjectOrExit(st, { dispatch: async () => ({ ok: false, error: 'tools/armDecide.mjs 不派工' }) })
let gov = P.rsi.governance
let fpLedgerMd = P.rsi.paths.govProposalsMd
//字串旗標一律取命令列之原字串(argStrOf; 排程第 607 項): 原以 argOf 讀 ⇒ 全為數字之 id 被轉成數值而 `typeof id !== 'string'` ⇒ 靜默進入列出模式; 數字樣之文字(--title 007)被轉型而失真(007 → 7)
let textOf = (key) => {
    let f = argStrOf(`${key}-file`, null)
    if (typeof f === 'string') {
        return fs.readFileSync(path.resolve(f), 'utf8').trim()
    }
    let v = argStrOf(key, null)
    return typeof v === 'string' ? v.trim() : null
}

let id = argStrOf('id', null)
let led = null
try {
    led = gov.ledger()
}
catch (err) {
    console.error(`提案帳讀取失敗(不以空帳處理): ${String((err && err.message) || err).split('\n')[0]}`)
    process.exit(2)
}
if (typeof id !== 'string') {
    let pend = led.items.filter((x) => x.status === 'pending')
    console.log(`待審 ${pend.length} 筆;已審定 ${led.items.length - pend.length} 筆(${path.relative(FD_ROOT, fpLedgerMd).replace(/\\/g, '/')})`)
    for (let x of pend) {
        console.log(`- ${x.id}(r${String(x.round).padStart(3, '0')};${x.from === 'dream' ? '做夢' : `節點 ${String(x.from).slice(0, 8)}`})${armProposalLine(x)}${x.note ? `〔${x.note}〕` : ''}`)
    }
    process.exit(0)
}
let p = led.items.find((x) => x.id === id)
if (!p) {
    console.error(`提案帳無此筆: ${id}`)
    process.exit(2)
}
if (p.status !== 'pending') {
    console.error(`提案 ${id} 已審定(${p.status})`)
    process.exit(2)
}
let why = textOf('why')
let accept = argOf('accept', false) === true
let reject = argOf('reject', false) === true
if (accept === reject || !why) {
    console.error('用法: --id <提案 id> --accept | --reject,並給 --why <審查意見>(或 --why-file <檔>)')
    process.exit(2)
}
if (accept) {
    let lock = peekRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
    if (lock.running) {
        console.error(`輪次進行中(pid ${lock.pid}): 目錄不得於輪中變動,請於輪次結束後再通過`)
        process.exit(3)
    }
}
//--selectable: 值只收 true / false(字串; 已於上之 cliGuard 檢查〔CLI_VALUES.armDecide〕; K5: 0、1 與其他字串皆非布林); 原: `!(selArg === false || selArg === 'false')` ⇒ `--selectable 0`、`abc` 皆取 true
let selArg = argStrOf('selectable', null)
let o = decideArgsOf(p, {
    accept,
    why,
    by: '主控',
    name: argStrOf('name', null),
    layer: argStrOf('layer', null),
    armId: argStrOf('arm-id', null),
    title: textOf('title'),
    desc: textOf('desc'),
    selectable: selArg === null ? undefined : selArg.trim() === 'true',
    noGrid: argOf('no-grid', false) === true,
    catalog: gov.effectiveCatalog(),
})
if (o.error) {
    console.error(o.error)
    process.exit(2)
}
let r = null
try {
    r = gov.decide(id, o.args)
}
catch (err) {
    //已提交(擴充檔已寫入)而提案帳未寫 ⇒ 重跑同一審定即補記
    if (err && err.code === 'RSI_GOVERNANCE_PARTIAL') {
        console.error(err.message)
        process.exit(1)
    }
    console.error(`審定未執行(提案帳與擴充檔皆不變): ${String((err && err.message) || err).split('\n').slice(0, 3).join(' | ')}`)
    process.exit(1)
}
let note = r.renderError ? `;**${path.basename(fpLedgerMd)} 未能重產**(${r.renderError})` : ''
if (reject) {
    console.log(`已審定 ${id}: 不採 —— ${why}${note}`)
    process.exit(0)
}
let c = P.writeCatalogFile(gov.effectiveCatalog())
console.log(`已審定 ${id}: 通過(${ARM_LABELS[p.kind]})⇒ ${r.item.decision.ref || p.arm};目錄 ${c.nArms} 臂(擴充 ${c.nExt} 筆);可選 ${c.nSelectable} → ${c.file}${note}`)
console.log('下一步: node g_rsi.mjs --mode board(重產看板);下一輪起做夢可指派')
