import { getSettings } from '../cfg.mjs'
import { buildPickStore } from '../domain/pickStore.mjs'
import { P as PI, isIntegrityError } from '../eval/intrinsics.mjs'

//產生(或更新)共同儲存「自適應挑選策略」區 <狀態根>/picks/(規則 R-REC-25; 說明見 src/domain/pickStore.mjs)
//  node tools/pickStore.mjs
//  迴圈於每輪結束時自動重產; 主控於補記保留期之正負號或審定後亦可手動執行。唯讀取節點文件與各節點工作夾之 pick.mjs, 只寫 <狀態根>/picks/
//  節點之挑選模組載入時改了內建物件(EVAL_INTEGRITY; 規則 R-EV-35 ②)⇒ 中止更新(不寫任何檔), 輸出 ERROR 行與節點, 離開碼 3
let r
try {
    r = await buildPickStore(getSettings())
}
catch (err) {
    if (isIntegrityError(err)) {
        PI.ConsoleLog(`ERROR ${err.message}`) //擷取之 console.log(成品可能已改 console)
        process.exit(3)
    }
    throw err
}
console.log(`共同儲存區: ${r.dir};策略 ${r.n} 個;本次複製(新增或有變)${r.copied} 個;已有保留期正負號者 ${r.holdoutSigned} 個${r.skipped.length ? `;略過 ${r.skipped.length} 個: ${r.skipped.join('、')}` : ''}`)
