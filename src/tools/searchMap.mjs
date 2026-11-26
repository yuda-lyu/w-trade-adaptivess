import fs from 'fs'
import path from 'path'
import { settingsOrExit, cliGuard } from '../cfg.mjs'
import { takeRoundLockOrExit } from '../arsi/roundLock.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 拒跑(離開碼 2; 於組裝專案與任何寫入之前; 規則 R-RUN-11)
guardEntry('searchMap')
//命令列之旗標只認 --quiet(TOOL_FLAGS.searchMap): 等號、未列、重複、多餘之值一律拒收(離開碼 2; 於讀設定與任何寫入之前; 訊息固定、不帶輸入值)
cliGuard('searchMap')

//重產並印出搜尋地圖(rsi/SEARCH_MAP.md; 規則 R-REC-14): 逐輪趨勢、各層之覆蓋、譜系、集中度之機械指標
//  node tools/searchMap.mjs            重產並印出
//  node tools/searchMap.mjs --quiet    只重產, 印一行摘要
//  唯讀樹與紀錄; 只寫 rsi/SEARCH_MAP.md(迴圈於每輪做夢前與輪末亦會隨看板重產)
//  輪次進行中不得執行(迴圈於做夢前與輪末寫同一個檔): 於 rsi.init()(建狀態根)與寫入之前取輪次鎖(takeRoundLockOrExit; 持有至行程結束; 取不到 ⇒ 離開碼 3; 規則 R-RUN-15; 排程第 655 項 ①; 原: 不取鎖)
//  輪次行程於輪內以行程內呼叫重產(P.writeSearchMap), 不起子行程執行本工具; agent 亦拒跑(上之 guardEntry)⇒ 取鎖不會擋住輪次本身
let st = settingsOrExit()
let P = makeProjectOrExit(st, {})
takeRoundLockOrExit(st.rsi.root, (lock) => {
    console.error(`輪次進行中(pid ${lock.pid}): 請於輪次結束後再執行`)
})
P.rsi.init()
let r = P.writeSearchMap()
let fp = path.join(st.rsi.root, 'SEARCH_MAP.md')
if (process.argv.includes('--quiet')) {
    console.log(`搜尋地圖: 節點 ${r.nNodes}、有內容 ${r.nContent}、譜系之根 ${r.nRoots} → ${path.relative(st.FD_ROOT, fp).replace(/\\/g, '/')}`)
}
else {
    console.log(fs.readFileSync(fp, 'utf8'))
}
