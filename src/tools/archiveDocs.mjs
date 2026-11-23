import path from 'path'
import { settingsOrExit, cliGuard } from '../cfg.mjs'
import { archiveExperience, archiveFeedback } from '../domain/archiveDocs.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'
import { docLimitsOf } from '../arsi/rsiNums.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 拒跑(離開碼 2; 於任何寫入之前; 規則 R-RUN-11)
guardEntry('archiveDocs')
//本工具不帶旗標與位置引數(TOOL_FLAGS.archiveDocs): 任何引數一律拒收(離開碼 2; 於讀設定與任何寫入之前; 訊息固定、不帶輸入值)
cliGuard('archiveDocs')

//手動執行專案指引文件之自動整理(規則 R-REC-17; 迴圈於每輪末亦會自動做): 經驗檔、回饋檔逾上限即把較舊之內容原文搬到同夾之 <名>_<年月日>.md, 主檔留索引
//  node tools/archiveDocs.mjs        上限取 settings.rsi.docLimits(預設 maxBytes 30000、keepBytes 18000、keepRows 14)
let st = settingsOrExit()
let lim = docLimitsOf(st.rsi) //與迴圈之輪末同一取值(數字字串轉數值、無效者為 undefined ⇒ 用整理函數之預設; 排程第 595 項)
let kb = (b) => (b / 1024).toFixed(1)
let a1 = archiveExperience({ fp: path.join(st.FD_ROOT, 'sgud', 'exp', 'experience.md'), maxBytes: lim.maxBytes, keepBytes: lim.keepBytes })
let a2 = archiveFeedback({ fp: path.join(st.FD_ROOT, 'sgud', 'feedback', 'feedback.md'), maxBytes: lim.maxBytes, keepRows: lim.keepRows })
console.log(a1 ? `經驗檔 ${kb(a1.before)} → ${kb(a1.after)} KB:第 ${a1.from} ~ ${a1.to} 條(${a1.moved} 條)→ sgud/exp/${a1.file}` : '經驗檔: 未逾上限或無可搬')
console.log(a2 ? `回饋檔 ${kb(a2.before)} → ${kb(a2.after)} KB:${a2.moved} 列 → sgud/feedback/${a2.file}` : '回饋檔: 未逾上限或無可搬')
