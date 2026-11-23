import fs from 'fs'
import path from 'path'
import { settingsOrExit, cliGuard } from '../cfg.mjs'
import { makeProjectOrExit } from '../domain/domain.mjs'
import { makeTexts } from '../domain/texts.mjs'
import { guardEntry } from '../domain/agentEntries.mjs'

//agent(ARSI_AGENT_ROLE = node / dream)⇒ 帶 --out(寫出任務書)者拒跑(離開碼 2; 於組裝專案與任何寫入之前; 規則 R-RUN-11); 只印大小者照常
guardEntry('briefPreview')
//命令列之旗標只認 --out <資料夾>(TOOL_FLAGS.briefPreview): 等號、未列、重複、無值、多餘之值一律拒收(離開碼 2; 於讀設定與任何寫入之前; 訊息固定、不帶輸入值; 原: --out 無值者靜默不寫任務書)
cliGuard('briefPreview')

//預覽下一輪之節點任務書大小(處理要點 §7: 節點任務書逾 15 KB 即整併): 以前緣內「無起點」之提案產生任務書, 列總位元組數與各節之位元組數
//  node tools/briefPreview.mjs [--out <資料夾>]      --out: 另把任務書寫到該資料夾(請給 tmp/ 下之路徑)
//  只處理無起點者: 有起點之任務會建立工作夾並複製起點之成品(那是派工時才該發生之事)
let st = settingsOrExit()
let P = makeProjectOrExit(st, {})
P.rsi.init()
let texts = makeTexts({ st, FD_ROOT: st.FD_ROOT })
let iOut = process.argv.indexOf('--out')
let outDir = iOut > 0 && process.argv[iOut + 1] ? path.resolve(process.argv[iOut + 1]) : null
let fr = P.rsi.store.listFrontier().filter((f) => f.status === 'proposed')
console.log(`前緣(proposed)${fr.length} 條;門檻 15,000 位元組`)
for (let f of fr) {
    let spec = f.spec
    let id = P.idOf(spec)
    if (spec.base) {
        console.log(`${id.slice(0, 10)} ${spec.arms.join('+')} ←${String(spec.base).slice(0, 8)}: 有起點,略過`)
        continue
    }
    let task = P.taskFor(spec)
    let s = texts.nodeBrief({ workDir: path.join(st.records.workDir, id), task, round: 0, nodeId: id, attempt: 1 })
    let parts = s.split(/\n(?=##+ )/).map((p) => `${p.split('\n')[0].replace(/^#+\s*/, '').slice(0, 14)} ${Buffer.byteLength(p, 'utf8')}`)
    let n = Buffer.byteLength(s, 'utf8')
    console.log(`${id.slice(0, 10)} ${spec.arms.join('+')}: ${n} 位元組${n > 15000 ? ' **逾門檻**' : ''} | ${parts.join(';')}`)
    if (outDir) {
        fs.mkdirSync(outDir, { recursive: true })
        fs.writeFileSync(path.join(outDir, `brief_${id.slice(0, 8)}.md`), s, 'utf8')
    }
}
