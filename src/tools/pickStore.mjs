import { settingsOrExit, cliGuard } from '../cfg.mjs'
import { takeRoundLockOrExit } from '../arsi/roundLock.mjs'
import { buildPickStore } from '../domain/pickStore.mjs'
import { P as PI, isIntegrityError } from '../eval/intrinsics.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 拒跑(離開碼 2; 於任何寫入之前; 規則 R-RUN-11)
guardEntry('pickStore')
//本工具不帶旗標與位置引數(TOOL_FLAGS.pickStore): 任何引數一律拒收(離開碼 2; 於讀設定與任何寫入之前; 訊息固定、不帶輸入值)
cliGuard('pickStore')

//產生(或更新)共同儲存「自適應挑選策略」區 <狀態根>/picks/(規則 R-REC-25; 說明見 src/domain/pickStore.mjs)
//  node tools/pickStore.mjs
//  迴圈於每輪結束時自動重產; 主控於補記保留期之正負號或審定後亦可手動執行。唯讀取節點文件與各節點工作夾之 pick.mjs, 只寫 <狀態根>/picks/
//  區內有 _cross.json(其他標的之正負號; 規則 R-REC-30)者, 輸出另列其統計(有號之策略數、忽略之值數; 檔之形狀不合者註明未列; 不印檔內之任何值)
//  節點之挑選模組載入時改了內建物件(EVAL_INTEGRITY; 規則 R-EV-35 ②)⇒ 中止更新(不寫任何檔), 輸出 ERROR 行與節點, 離開碼 3
//  輪次進行中不得執行(迴圈於輪末自行重產此區, 兩者寫同一批檔): 寫入前取輪次鎖(takeRoundLockOrExit; 持有至行程結束; 取不到 ⇒ 離開碼 3; 規則 R-RUN-15; 排程第 655 項 ①; 原: 不取鎖)
//    輪次行程於輪內以行程內呼叫重產(buildPickStore), 不起子行程執行本工具; agent 亦拒跑(上之 guardEntry)⇒ 取鎖不會擋住輪次本身
//其他標的之正負號之統計(規則 R-REC-30; 有 _cross.json 時才列; 不印檔內之任何值)
let crossNote = (c) => (!c ? '' : (c.invalid ? ';其他標的之正負號檔之形狀不合(未列)' : `;已有其他標的正負號者 ${c.signed} 個${c.ignored ? `(檔內不是正負號而忽略之值 ${c.ignored} 個)` : ''}`))
let st = settingsOrExit()
takeRoundLockOrExit(st.rsi.root, (lock) => {
    console.error(`輪次進行中(pid ${lock.pid}): 請於輪次結束後再執行`)
})
let r
try {
    r = await buildPickStore(st)
}
catch (err) {
    if (isIntegrityError(err)) {
        PI.ConsoleLog(`ERROR ${err.message}`) //擷取之 console.log(成品可能已改 console)
        process.exit(3)
    }
    throw err
}
console.log(`共同儲存區: ${r.dir};策略 ${r.n} 個;本次複製(新增或有變)${r.copied} 個;已有保留期正負號者 ${r.holdoutSigned} 個${crossNote(r.cross)}${r.skipped.length ? `;略過 ${r.skipped.length} 個: ${r.skipped.join('、')}` : ''}`)
