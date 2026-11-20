import fs from 'fs'
import path from 'path'
import { backtestCfg } from './backtestCfg.mjs'
import { runNodeProc } from './proc.mjs'


//全期帳本未建之訊息(規則 R-EV-45 ⑨; 供 verify 與 domain.validatePending 共用): 全期帳本不由 g_build.mjs 建(它只建評估帳本與 --train 之帳本), 由使用端以聚合入口之 buildLedger 自建於 settings.backtest.ledgerDir,
//  且須與評估帳本用同一個 source.startTime(否則 g_backtest.mjs 離開碼 5)
let FULL_LEDGER_MSG = '全期帳本未建(由使用端以聚合入口之 buildLedger 自建於 settings.backtest.ledgerDir, 與評估帳本用同一個 source.startTime; g_build.mjs 不建它)'

//回測期旗標(樣本外驗證): 迴圈對「訓練期階梯已達門檻」之成品, 以全期帳本於回測期重放, 只取回旗標
//  旗標 = pass / above / mixed / level / below(分級; 見 backtestGrade.mjs), 分級未啟用時為 pass / fail
//  數字留在專案夾外之私有根(backtestCfg.resultDir), 不寫入節點文件、樹或任務書; 對 agent 只揭露旗標
//  makeBacktest({ st, FD_ROOT }) → async ({ nodeId, attempt, workDir }) → { flag: 旗標 | null, at, error }
let makeBacktest = ({ st, FD_ROOT }) => {
    let bt = backtestCfg(st)
    let ready = () => bt.enabled && fs.existsSync(path.join(bt.ledgerDir, 'meta.json'))
    let run = async ({ nodeId, attempt, workDir }) => {
        if (!ready()) {
            return { flag: null, at: new Date().toISOString(), error: bt.enabled ? FULL_LEDGER_MSG : '未啟用' }
        }
        let name = `${nodeId}_a${attempt}`
        let r = await runNodeProc([path.join(FD_ROOT, 'g_backtest.mjs'), '--pick', path.join(workDir, 'pick.mjs'), '--name', name, '--dir', bt.resultDir], { cwd: FD_ROOT, timeoutMs: bt.timeoutSec * 1000, env: { ...process.env, ARSI_HARNESS: '1' } })
        let m = /BACKTEST_FLAG (pass|above|mixed|level|below|fail)\s*$/.exec(String(r.out || '').trim())
        if (r.timeout || !m) {
            return { flag: null, at: new Date().toISOString(), error: r.timeout ? `回測期重放逾時(${bt.timeoutSec}s)` : `回測期重放失敗(離開碼 ${r.code}): ${String(r.out || '').split('\n').slice(-3).join(' | ').slice(0, 300)}` }
        }
        return { flag: m[1], at: new Date().toISOString(), error: null }
    }
    return { run, ready, cfg: bt }
}


export { makeBacktest, FULL_LEDGER_MSG }
export default makeBacktest
