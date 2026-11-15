import { getSettings } from '../cfg.mjs'
import { buildPickStore } from '../domain/pickStore.mjs'

//產生(或更新)共同儲存「自適應挑選策略」區 <狀態根>/picks/(規則 R-REC-25; 說明見 src/domain/pickStore.mjs)
//  node tools/pickStore.mjs
//  迴圈於每輪結束時自動重產; 主控於補記保留期之正負號或審定後亦可手動執行。唯讀取節點文件與各節點工作夾之 pick.mjs, 只寫 <狀態根>/picks/
let r = await buildPickStore(getSettings())
console.log(`共同儲存區: ${r.dir};策略 ${r.n} 個;本次複製(新增或有變)${r.copied} 個;已有保留期正負號者 ${r.holdoutSigned} 個${r.skipped.length ? `;略過 ${r.skipped.length} 個: ${r.skipped.join('、')}` : ''}`)
