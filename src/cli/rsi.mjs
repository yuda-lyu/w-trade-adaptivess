import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { getSettings, argOf, writeJson } from '../cfg.mjs'
import { peekRound } from '../engineApi.mjs'
import { makeProject } from '../domain/domain.mjs'
import { roundName } from '../arsi/records.mjs'
import { runRounds, acquireRunLock, appendEvent, readEvents, trailingFailures } from '../arsi/runner.mjs'
import { checkQuota } from '../arsi/dispatchers.mjs'
import { fileURLToPath } from 'url'


//FP_DIGEST, 輪末摘要之工具(本套件之 src/tools/roundDigest.mjs; 以本檔位置定位套件內之程式, 專案根仍由 ARSI_ROOT 傳給子行程)
let FP_DIGEST = fileURLToPath(new URL('../tools/roundDigest.mjs', import.meta.url))


//rsi 輪次入口
//  node g_rsi.mjs --mode init                 建狀態根、策略檔、臂看板
//  node g_rsi.mjs --mode dry                  乾跑: 只印下一輪之計畫(不派 agent、不寫樹)
//  node g_rsi.mjs --mode round [--nodes N] [--parallel K] [--rounds M]
//                                             跑輪次: 派節點 agent(併行)→ 重跑驗證入樹 → 派做夢 agent 審計 → 寫回 / 重做 / 刪除 / 方向 → 更新看板
//                                             N = 每輪節點數、K = 同時執行之節點數、M = 本次執行連跑幾輪(皆預設取 settings.rsi 之 nodesPerRound / parallelNodes / roundsPerRun;
//                                             依自身設備與監督方式給定; CPU / 記憶體上限在 settings.resources, 派工前由資源閘等待)
//                                             要它跑完本輪後停下: 於狀態根建空檔 STOP(每輪開始前檢查; 下次執行前請刪除)
//                                             起跑時若上一輪之節點已入樹而做夢未交付(額度用盡、派工失敗、行程中斷), 先對該輪補做夢, 補成才起新的一輪(規則 R-RUN-6)
//  node g_rsi.mjs --mode status               現況
//  node g_rsi.mjs --mode board                重產臂看板(另重寫供 agent 閱讀之生效目錄 arms/catalog.json)
//  node g_rsi.mjs --mode validate [--force]   對已入樹而尚無回測期旗標之節點補算旗標(需先 node g_build.mjs --full)
//  node g_rsi.mjs --mode reverify --why <改了什麼> [--keep-flags] [--only <id 前綴,…>]  評估器改版後, 以現行評估器重跑樹上全部已執行節點(數字、分數、回測期旗標、節點文件); --keep-flags 沿用既有旗標、不重放回測期;
//                                             --only 只重跑指名之節點(只增輸出之改動後補算新欄用; 數字會變之改版須全樹)
//  node g_rsi.mjs --mode extfill [--ext <診斷名,…>] [--only <id 前綴,…>] [--force] [--null N]   擴充診斷之補算: 共用工具區新增或改寫擴充診斷後, 為既有節點補上其值
//                                             (只併入該診斷之輸出, 不動數字與分數; 選集指紋與正本不同者不併入; 規則 R-REC-27)
//  node g_rsi.mjs --mode frontier [--close <臂+臂> --why <理由>]   列出前緣; 主代理把尚未執行之提案結案
//  node g_rsi.mjs --mode frontier --rearm <臂+臂> --to <臂+臂> --why <理由> [--base <起點 id>] [--claim <主張鍵>]
//                                             主控通過新臂後, 把做夢暫掛於既有臂之未執行方向改掛新臂(規則 R-ARM-4; 只改臂之歸屬)
//  node g_rsi.mjs --mode annotate --round N --file <文字檔>      於該輪做夢文件加「迴圈註記」(文件完成後之更正)
//  node g_rsi.mjs --mode dirtype --round N --file <JSON 檔>      補記該輪做夢文件之方向之任務類型([{ index, type: 'explore' | 'verify', claim }]; 舊做夢文件無此欄時用)
//  一輪可能歷時數小時: 請以 g_launch.mjs 脫離執行, 進度看 rsi/STATUS.json 與 rsi/logs/
let st = getSettings()
let mode = argOf('mode', 'status')
//執行規模之命令列覆寫(未給則用 settings.rsi 之 nodesPerRound / parallelNodes / roundsPerRun; --arms、--workers 為舊名)
let cliInt = (k) => {
    let v = argOf(k, null)
    return Number.isInteger(v) && v >= 1 ? v : null
}
let P = makeProject(st, { run: { nodesPerRound: cliInt('nodes') || cliInt('arms'), parallelNodes: cliInt('parallel') || cliInt('workers'), roundsPerRun: cliInt('rounds') } })
let { rsi } = P
rsi.init()

if (mode === 'init') {
    let b = P.writeBoard()
    console.log(`init 完成: 狀態根 ${st.rsi.root};可選臂 ${P.selectable.length};樹上節點 ${b.nNodes};未試之臂 ${b.untried}`)
}
else if (mode === 'board') {
    console.log(JSON.stringify(P.writeBoard()))
    //共同儲存「自適應挑選策略」區亦一併重產(規則 R-REC-25; 主控審定或補記保留期之正負號後)
    let ps = await P.pickStore()
    console.log(`共同儲存區: ${ps.n} 個策略;已有保留期正負號者 ${ps.holdoutSigned} 個`)
}
else if (mode === 'dry') {
    let r = await rsi.explore({ dry: true, arms: P.run.nodesPerRound, novelty: P.run.nodesPerRound })
    console.log(`下一輪 ${roundName(r.round)} 之計畫(${r.items.length} 個節點;同時 ${P.run.parallelNodes} 個;本次執行連跑 ${P.run.roundsPerRun} 輪):`)
    for (let it of r.items) {
        console.log(`  ${it.id.slice(0, 10)} ${it.kindOf} ${P.typeOf(it.spec) === 'verify' ? '〔驗證〕' : '〔探索〕'}${it.spec.arms.join('+')}${it.spec.base ? ` ←${it.spec.base.slice(0, 8)}` : ''}${it.spec.claim ? `〔${P.typeOf(it.spec) === 'verify' ? '主張' : '鍵'} ${it.spec.claim}〕` : ''} | ${it.reason || ''}`)
    }
    for (let x of r.rejected) {
        console.log(`  (拒) ${x.spec.arms.join('+')}: ${x.why}`)
    }
    console.log('策略備註:', (r.plan.notes || []).join(';'))
}
else if (mode === 'round') {
    //一次執行連跑 roundsPerRun 輪(預設 1 = 每輪跑完即停, 由人檢視後再起); 每輪 nodesPerRound 個節點、同時 parallelNodes 個
    //  提前停止: 輪末回調失敗(做夢未交付或未更新專案文件)、狀態根下有停止檔 STOP(每輪開始前檢查; 要它跑完本輪後停下就建此檔)
    let { nodesPerRound, parallelNodes, roundsPerRun } = P.run
    let fpStop = path.join(st.rsi.root, 'STOP')
    //無人值守之三件事(排程器定時觸發同一道指令即可; 規則 R-RUN-4): 單一執行之鎖、起跑前自檢、事件檔
    //  未啟動(已有執行中 / 鎖逾時 / 停止檔 / 連續失敗達上限)⇒ 事件 skipped、離開碼 3; 其餘事件: run-start、round-done(每輪)、run-done、run-failed
    //  監看端只須等事件檔 rsi/logs/events.jsonl 出現新的結束類事件(run-done / run-failed / skipped); 可用 node tools/waitEvent.mjs
    let fdLogs = path.join(st.rsi.root, 'logs')
    let fpEvents = path.join(fdLogs, 'events.jsonl')
    let relOf = (p) => path.relative(st.FD_ROOT, p).replace(/\\/g, '/')
    let ev = (o) => appendEvent(fpEvents, o)
    let pre = (st.rsi && st.rsi.preflight) || {}
    let lock = acquireRunLock(path.join(fdLogs, 'round.lock'), { staleMs: (Number.isFinite(pre.lockStaleHours) && pre.lockStaleHours > 0 ? pre.lockStaleHours : 6) * 3600000 })
    if (!lock.ok) {
        let msg = lock.why === 'stale'
            ? `本次不啟動: 鎖檔之行程(pid ${lock.pid};自 ${lock.startedAt})仍在而心跳已逾時(最後 ${lock.beatAt}),疑似卡住 —— 須人查明後處理`
            : `本次不啟動: 已有輪次執行中(pid ${lock.pid};自 ${lock.startedAt})`
        console.log(msg)
        ev({ event: 'skipped', reason: lock.why === 'stale' ? 'lock-stale' : 'running', pid: lock.pid, detail: msg })
        process.exit(3)
    }
    process.on('exit', () => lock.release())
    let quota = null
    //額度之查詢參數、快照(只留角色、視窗名與百分比)與前後對照之文字(每輪之耗用; 供估「還能跑幾輪」)
    let quotaArgs = () => ({ agents: st.agents, skillsRoot: st.dispatch.skillsRoot, envFile: st.dispatch.envFile, maxPercent: Number.isFinite(pre.quotaMaxPercent) ? pre.quotaMaxPercent : 95 })
    let snapOf = (q) => (q ? q.rows.map((r) => ({ role: r.role, windows: r.windows.map((w) => ({ label: w.label, percent: w.percent })) })) : null)
    let quotaLine = (a, b) => {
        if (!a || !b) {
            return null
        }
        let parts = []
        for (let rb of b) {
            let ra = a.find((x) => x.role === rb.role)
            for (let wb of rb.windows) {
                let wa = ra ? ra.windows.find((x) => x.label === wb.label) : null
                if (typeof wb.percent === 'number') {
                    parts.push(`${rb.role} ${wb.label} ${wa && typeof wa.percent === 'number' ? `${wa.percent}% → ` : ''}${wb.percent}%`)
                }
            }
        }
        return parts.length ? `額度(本輪前 → 後;各角色所用訂閱之用量):${parts.join(';')}` : null
    }
    {
        let why = null
        if (fs.existsSync(fpStop)) {
            why = ['stop-file', `停止檔 ${relOf(fpStop)} 存在`]
        }
        else if (argOf('force', false) !== true) {
            let mx = Number.isInteger(pre.maxConsecutiveFailures) ? pre.maxConsecutiveFailures : 2
            let nf = trailingFailures(readEvents(fpEvents))
            if (mx > 0 && nf >= mx) {
                why = ['failures', `最近連續 ${nf} 輪失敗(上限 ${mx});查明後加 --force 起跑一次即解除`]
            }
        }
        //額度(規則 R-RUN-5): 任一角色所用之訂閱其用量已達起跑門檻(settings.rsi.preflight.quotaMaxPercent; 預設 95)⇒ 本次不啟動 —— 做夢中途額度用盡時該輪之節點會停在未審(下次起跑時補做夢; 規則 R-RUN-6)
        //  門檻不是「用盡」: 百分比為進位後之顯示值, 讀到 100% 仍可能可用; 是否用盡以 agent 之訊息為準
        //  查詢失敗不擋; --force 亦解除; 用量之快照記入事件檔(不含金鑰與帳號), 供事後估每輪之耗用
        if (!why && pre.quota !== false) {
            try {
                quota = await checkQuota(quotaArgs())
                console.log(`額度: ${quota.rows.map((r) => `${r.role} ${r.windows.map((w) => `${w.label} ${w.percent === null ? '—' : `${w.percent}%`}`).join(' / ') || '—'}${r.note ? `(${r.note})` : ''}`).join(';')}`)
                if (!quota.ok && argOf('force', false) !== true) {
                    why = ['quota', `${quota.why};額度重置後自動恢復,或加 --force 起跑一次`]
                }
            }
            catch (err) {
                console.log(`額度查詢失敗(不擋): ${String((err && err.message) || err).slice(0, 160)}`)
            }
        }
        if (why) {
            console.log(`本次不啟動: ${why[1]}`)
            ev({ event: 'skipped', reason: why[0], detail: why[1] })
            process.exit(3)
        }
    }
    ev({ event: 'run-start', pid: process.pid, rounds: roundsPerRun, nodesPerRound, parallelNodes, ...(quota ? { quota: snapOf(quota) } : {}) })
    let quotaPrev = snapOf(quota)
    //補做夢(規則 R-RUN-6): 上一輪之節點已入樹而做夢未交付(額度用盡、派工失敗、行程中斷)⇒ 先以同一個輪末鉤子對該輪補做夢, 補成才起新的一輪
    //  補成: 更新該輪之 ROUND.json(hook、redream)與一頁摘要; 事件 round-done(recovered: true)—— 事件檔末尾之連續失敗計數隨之歸零
    //  補不成(仍未交付): 事件 run-failed(reason: redream)、離開碼 1, 不起新輪(再起只會多出未審之節點)
    //  已交付並套用而輪末回調另有失敗(例: 做夢未更新專案文件)⇒ 與一般輪次相同: 記 round-done(ok: false)後停止
    {
        let pd = P.pendingDream()
        if (pd) {
            let t0 = Date.now()
            lock.beat()
            P.setStatus({ round: pd.round, stage: 'dream', startedAt: new Date().toISOString(), done: false, error: null, run: { index: 0, total: roundsPerRun, nodesPerRound, parallelNodes }, redream: true })
            P.log(`===== 補做夢: ${roundName(pd.round)} 之 ${pd.nodeIds.length} 個節點已入樹而做夢未交付, 先對該輪補做 =====`)
            P.monitor.reset()
            P.monitor.start()
            let hk
            try {
                hk = await P.redream(pd.round)
            }
            catch (err) {
                hk = { lines: [], dream: null, failed: true, errors: [String((err && err.stack) || err).slice(0, 500)] }
            }
            P.monitor.stop()
            let delivered = !!(hk && hk.dream)
            let hookFailed = !hk || hk.failed === true
            let wallMin = Number(((Date.now() - t0) / 60000).toFixed(1))
            let quotaNow = null
            if (pre.quota !== false) {
                try {
                    quotaNow = snapOf(await checkQuota(quotaArgs()))
                }
                catch (err) {}
            }
            let lines = [...((hk && hk.lines) || [])]
            let qLine = quotaLine(quotaPrev, quotaNow)
            if (qLine) {
                lines.push(qLine)
            }
            let fpRound = path.join(st.rsi.root, 'rounds', roundName(pd.round), 'ROUND.json')
            let old = null
            try {
                old = JSON.parse(fs.readFileSync(fpRound, 'utf8'))
            }
            catch (err) {}
            if (old) {
                writeJson(fpRound, { ...old, hook: { failed: hookFailed, errors: (hk && hk.errors) || [], lines, dream: (hk && hk.dream) || null }, redream: { at: new Date().toISOString(), wallMin, delivered }, ...(quotaNow ? { quota: { before: quotaPrev, after: quotaNow } } : {}) })
                try {
                    spawnSync(process.execPath, [FP_DIGEST, String(pd.round), '--out'], { cwd: st.FD_ROOT, windowsHide: true, timeout: 120000, stdio: 'ignore' })
                }
                catch (err) {}
            }
            for (let l of lines) {
                P.log(l)
            }
            if (quotaNow) {
                quotaPrev = quotaNow
            }
            lock.beat()
            if (!delivered) {
                P.setStatus({ stage: 'dream-failed', done: true, redream: null, error: `補做夢仍未交付(${roundName(pd.round)})` })
                P.log(`補做夢失敗: ${roundName(pd.round)} 仍未交付做夢文件;本次不起新輪`)
                ev({ event: 'run-failed', round: pd.round, reason: 'redream', error: ((hk && hk.errors) || []).join(';').slice(0, 300) })
                process.exit(1)
            }
            ev({ event: 'round-done', round: pd.round, ok: !hookFailed, recovered: true, wallMin, hookFailed, summary: old ? relOf(fpRound) : null, ...(quotaNow ? { quota: quotaNow } : {}) })
            P.log(`===== 補做夢完成: ${roundName(pd.round)}(${wallMin} 分)=====`)
            P.setStatus({ redream: null })
            if (hookFailed) {
                let why = `補做夢後輪末回調失敗(${((hk && hk.errors) || []).join(';').slice(0, 200)})`
                P.setStatus({ stage: 'done', done: true, run: { done: 0, total: roundsPerRun, stopped: why } })
                ev({ event: 'run-done', rounds: 0, total: roundsPerRun, stopped: why })
                P.log(`本次執行結束: 已跑 0 / ${roundsPerRun} 輪;提前停止: ${why}`)
                process.exit(0)
            }
        }
    }
    let runOne = async ({ index }) => {
        let round = peekRound(rsi.paths)
        let t0 = Date.now()
        lock.beat()
        P.monitor.reset()
        P.monitor.start()
        //輪次層之欄位於每輪開始時重設(狀態檔以合併寫入; 不重設則做夢期間仍看到上一輪之資源、採納數與重做中之節點)
        P.setStatus({ round, stage: 'explore', startedAt: new Date().toISOString(), done: false, error: null, run: { index: index + 1, total: roundsPerRun, nodesPerRound, parallelNodes }, lastNode: null, dreamNodes: null, reworking: null, sgud: null, applied: null, wallMin: null, hookFailed: null, resources: null })
        P.log(`===== ${roundName(round)} 開始(本次執行第 ${index + 1} / ${roundsPerRun} 輪;節點 ${nodesPerRound} 個、同時 ${parallelNodes} 個;節點 agent ${st.agents.node.id};做夢 agent ${st.agents.dream.model})=====`)
        let res
        try {
            res = await rsi.auto({ by: 'main', protocol: { round }, arms: nodesPerRound, novelty: nodesPerRound, workers: parallelNodes, noDream: st.rsi.mechanicalDream !== true })
        }
        catch (err) {
            P.monitor.stop()
            P.setStatus({ stage: 'error', done: true, error: String((err && err.stack) || err).slice(0, 2000) })
            P.log(`輪次失敗: ${String((err && err.stack) || err)}`)
            ev({ event: 'run-failed', round, error: String((err && err.message) || err).split('\n')[0].slice(0, 300) })
            process.exit(1)
        }
        let resources = P.monitor.stats()
        P.monitor.stop()
        //評估層之資源閘(各節點 agent 自跑評估時之等待; 記於其工作夾之 .evals.log)併入本輪之資源統計
        {
            let n = 0
            let sec = 0
            for (let nd of res.nodes || []) {
                try {
                    for (let l of fs.readFileSync(path.join(st.records.workDir, nd.id, '.evals.log'), 'utf8').split('\n')) {
                        let m = /"waitedSec":(\d+(?:\.\d+)?)/.exec(l)
                        if (m) {
                            n++
                            sec += Number(m[1])
                        }
                    }
                }
                catch (err) {}
            }
            resources.evalWaits = { n, sec: Math.round(sec) }
        }
        let sm = res.summary || {}
        //本輪回測期 S 最高者(未被否決者; 評估期 = 回測期): 進度之量尺
        let best = null
        {
            let ok = (res.nodes || []).filter((n) => n.status === 'executed' && n.score && !(n.score.flags && n.score.flags.vetoed))
            if (ok.length) {
                let top = ok.slice().sort((a, b) => b.score.S - a.score.S)[0]
                let m = top.raw && top.raw.metrics
                //compExcess / compP / compShare: 組成對照(同側同活躍度虛無; 選集之方向或活躍度偏離全體隨機時才有)—— S 高而組成可重現之比例接近 1 者, 其績效來自組成
                best = { id: top.id, arms: top.spec.arms, S: top.score.S, ladder: top.score.ladder, eqYrMean: m && m.op ? m.op.eqYr.mean : null, eqYrMin: m && m.op ? m.op.eqYr.min : null, excess: m && m.null ? m.null.excess : null, nullP: m && m.null ? m.null.p : null, compExcess: m && m.nullSideAct ? m.nullSideAct.excess : null, compP: m && m.nullSideAct ? m.nullSideAct.p : null, compShare: m && m.nullSideAct ? m.nullSideAct.share : null }
            }
        }
        let out = {
            round: res.round,
            at: new Date().toISOString(),
            wallMin: Number(((Date.now() - t0) / 60000).toFixed(1)),
            run: { index: index + 1, total: roundsPerRun, nodesPerRound, parallelNodes },
            stagesSec: res.stagesSec,
            planned: (res.items || []).map((it) => ({ id: it.id, arms: it.spec.arms, base: it.spec.base, kindOf: it.kindOf })),
            nodes: (res.nodes || []).map((n) => {
                let m = n.raw && n.raw.metrics; return { id: n.id, status: n.status, arms: n.spec.arms, S: n.score ? n.score.S : null, ladder: n.score ? n.score.ladder : null, eqYrMean: m && m.op ? m.op.eqYr.mean : null, eqYrMin: m && m.op ? m.op.eqYr.min : null, excess: m && m.null ? m.null.excess : null, nullP: m && m.null ? m.null.p : null, vetoed: !!(n.score && n.score.flags && n.score.flags.vetoed), error: n.status === 'executed' ? null : String((n.notes && (n.notes.error || n.notes.why)) || '').split('\n')[0].slice(0, 200) }
            }),
            summary: { nExecuted: sm.nExecuted, nError: sm.nError, nRejected: sm.nRejected, ladders: sm.ladders, period: 'backtest', best },
            hook: res.hook ? { failed: res.hook.failed === true, errors: res.hook.errors || [], lines: res.hook.lines || [], dream: res.hook.dream || null } : null,
            resources,
        }
        //額度之輪末快照(規則 R-RUN-5): 與本輪開始時對照 = 本輪之耗用; 查詢失敗即略過
        let quotaNow = null
        if (pre.quota !== false) {
            try {
                quotaNow = snapOf(await checkQuota(quotaArgs()))
            }
            catch (err) {}
        }
        let qLine = quotaLine(quotaPrev, quotaNow)
        if (quotaNow) {
            out.quota = { before: quotaPrev, after: quotaNow }
            if (qLine && out.hook && Array.isArray(out.hook.lines)) {
                out.hook.lines.push(qLine)
            }
            quotaPrev = quotaNow
        }
        if (res.fd) {
            writeJson(path.join(res.fd, 'ROUND.json'), out)
        }
        //輪末之一頁摘要(規則 R-REC-16): 由迴圈自己產出 rsi/rounds/rNNN/DIGEST.md(白話摘要 + 機械摘要), 不靠監控轉述; 失敗不影響輪次
        try {
            spawnSync(process.execPath, [FP_DIGEST, String(res.round), '--out'], { cwd: st.FD_ROOT, windowsHide: true, timeout: 120000, stdio: 'ignore' })
        }
        catch (err) {}
        //事件: 本輪結束(ok = 有節點執行成功且輪末回調未失敗)
        ev({ event: 'round-done', round: res.round, ok: (sm.nExecuted || 0) > 0 && !(out.hook && out.hook.failed), wallMin: out.wallMin, nExecuted: sm.nExecuted || 0, nError: sm.nError || 0, hookFailed: out.hook ? out.hook.failed === true : null, best: best ? { id: best.id, S: best.S } : null, summary: res.fd ? relOf(path.join(res.fd, 'ROUND.json')) : null, ...(quotaNow ? { quota: quotaNow } : {}) })
        lock.beat()
        P.setStatus({ stage: 'round-done', wallMin: out.wallMin, hookFailed: out.hook ? out.hook.failed : null, resources })
        P.log(`===== ${roundName(res.round)} 結束: 執行 ${sm.nExecuted} / 錯誤 ${sm.nError};階梯 ${JSON.stringify(sm.ladders || {})};回測期 S ${out.nodes.map((n) => (n.S === null ? '—' : n.S)).join(' / ')}${best ? `;本輪最高 ${best.id.slice(0, 8)} S ${best.S}(七相位均 ${best.eqYrMean}、最差相位 ${best.eqYrMin}、對隨機挑之超額 ${best.excess}${typeof best.compShare === 'number' ? `;組成對照之超額 ${best.compExcess}、p ${best.compP}、組成可重現 ${Math.round(best.compShare * 100)}%` : ''})` : ''};${out.wallMin} 分 =====`)
        for (let l of (out.hook && out.hook.lines) || []) {
            P.log(l)
        }
        P.log(`資源(全機;每 ${st.resources && st.resources.sampleSec ? st.resources.sampleSec : 5} 秒取樣 ${resources.samples} 次): CPU 平均 ${resources.cpuMean}%、最高 ${resources.cpuPeak}%(上限 ${resources.limits.cpuMax === null ? '未設' : resources.limits.cpuMax});已用記憶體最高 ${resources.ramPeakGB} GB(上限 ${resources.limits.ramUsedMaxGB === null ? '未設' : resources.limits.ramUsedMaxGB});超過上限之取樣 CPU ${resources.overCpu} / 記憶體 ${resources.overRam};資源閘等待 ${resources.waits} 次共 ${resources.waitedSec} 秒;節點評估之等待 ${resources.evalWaits.n} 次共 ${resources.evalWaits.sec} 秒`)
        return { ...out, halt: out.hook && out.hook.failed ? `輪末回調失敗(${(out.hook.errors || []).join(';').slice(0, 200)})` : null }
    }
    let rr = await runRounds({
        rounds: roundsPerRun,
        runRound: runOne,
        shouldStop: async ({ index }) => {
            if (fs.existsSync(fpStop)) {
                return `停止檔 ${path.relative(st.FD_ROOT, fpStop).replace(/\\/g, '/')} 存在`
            }
            //連跑多輪時, 第 2 輪起每輪開始前再查一次額度(規則 R-RUN-5; --force 只解除起跑時之自檢; 查詢失敗不擋)
            if (index > 0 && pre.quota !== false) {
                try {
                    let q = await checkQuota(quotaArgs())
                    if (!q.ok) {
                        return `額度已達起跑門檻(${q.why})`
                    }
                }
                catch (err) {}
            }
            return null
        },
        log: P.log,
    })
    P.setStatus({ stage: 'done', done: true, run: { done: rr.done.length, total: roundsPerRun, stopped: rr.stopped } })
    ev({ event: 'run-done', rounds: rr.done.length, total: roundsPerRun, stopped: rr.stopped || null })
    if (roundsPerRun > 1 || rr.stopped) {
        P.log(`本次執行結束: 已跑 ${rr.done.length} / ${roundsPerRun} 輪${rr.stopped ? `;提前停止: ${rr.stopped}` : ''}`)
    }
}
else if (mode === 'validate') {
    //對已入樹而尚無回測期旗標之節點補算(--force: 全部重算); 只印旗標
    let nMig = P.migrateDocs()
    if (nMig) {
        console.log(`節點文件轉為新版規格: ${nMig} 份`)
    }
    console.log(`依現行判讀重算分數: ${rsi.rescoreAll()} 個節點;依現行規則重掃操作紀錄而有變動之節點文件: ${P.rescanTraces()} 份;以既有之重放結果檔補算「下單流量偏一側」而有變動之節點: ${P.rescanSideFlow()} 個`)
    let r = await P.validatePending({ force: argOf('force', false) === true })
    console.log(r.ok ? `補算回測期旗標: ${r.done.length} 個節點${r.done.length ? `(${r.done.map((x) => `${x.nodeId.slice(0, 8)} ${x.flag || `失敗:${x.error}`}`).join(';')})` : ''};前緣結案 ${r.frontierClosed} 條` : `未執行: ${r.why}`)
}
else if (mode === 'reverify') {
    //評估器改版後, 以現行評估器重跑樹上全部已執行節點之成品(含回測期旗標): node g_rsi.mjs --mode reverify --why "<改了什麼>" [--keep-flags]
    //  --keep-flags: 不重放回測期, 沿用各節點既有之旗標(只在「評估器只改訓練期之輸出、回測期重放之結果不變」時用; 須先抽核重放結果確實不變)
    let why = String(argOf('why', ''))
    if (!why || why === 'true') {
        console.log('用法: node g_rsi.mjs --mode reverify --why "<評估器改了什麼>" [--keep-flags]')
        process.exit(2)
    }
    //與輪次共用同一把鎖(R-RUN-4): 重算會改寫樹與節點文件, 不得與輪次並行; 排程器於重算期間觸發之起跑亦因此不啟動
    let lockV = acquireRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
    if (!lockV.ok) {
        console.log(`未執行: 有輪次或另一次重算執行中(pid ${lockV.pid};自 ${lockV.startedAt});等它結束再重算`)
        process.exit(3)
    }
    process.on('exit', () => lockV.release())
    P.migrateDocs()
    console.log(`依現行規則重掃操作紀錄而有變動之節點文件: ${P.rescanTraces()} 份`)
    //--only <id 前綴,…>: 只重跑指名之節點(只增輸出之改動後補算少數節點之新欄; 數字會變之改版不得用 —— 樹上會混有新舊數字)
    let onlyArg = argOf('only', null)
    let only = typeof onlyArg === 'string' && onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : null
    if (only && only.some((s) => s.length < 6)) {
        console.log('--only 之節點 id 前綴至少 6 碼')
        process.exit(2)
    }
    let r = await P.reverifyAll({ why, keepFlags: argOf('keep-flags', false) === true, only })
    console.log(`重跑 ${r.length} 個節點:${r.map((x) => `${x.nodeId.slice(0, 8)} ${x.ok ? `S ${x.before} → ${x.S}、階梯 ${x.ladderBefore} → ${x.ladder}${x.flag ? `、檢定旗標 ${x.flag}` : ''}` : `失敗`}`).join(';')}`)
}
else if (mode === 'extfill') {
    //擴充診斷之補算(規則 R-REC-27): 共用工具區新增或改寫擴充診斷後, 為既有節點補上其值(看板值、提示、量尺之子集隨之生效); 只併入該診斷之輸出, 不動數字與分數
    //  --ext <診斷名,…>(預設 = metrics/ 之全部)、--only <id 前綴,…>、--force(已有者亦重算)、--null N(所補之診斷不使用虛無時可給 1 以省時間; 用到虛無者不得縮減)
    //與輪次共用同一把鎖(R-RUN-4): 補算會改寫樹與節點文件, 不得與輪次並行
    let lockV = acquireRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
    if (!lockV.ok) {
        console.log(`未執行: 有輪次或另一次重算執行中(pid ${lockV.pid};自 ${lockV.startedAt});等它結束再補算`)
        process.exit(3)
    }
    process.on('exit', () => lockV.release())
    let list = (k) => {
        let v = argOf(k, null); return typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : null
    }
    let only = list('only')
    if (only && only.some((s) => s.length < 6)) {
        console.log('--only 之節點 id 前綴至少 6 碼')
        process.exit(2)
    }
    let nullArg = argOf('null', null)
    let r
    try {
        r = await P.extFill({ names: list('ext'), only, force: argOf('force', false) === true, nullDraws: Number.isInteger(nullArg) && nullArg > 0 ? nullArg : null })
    }
    catch (err) {
        console.log(`未執行: ${String((err && err.message) || err).split('\n')[0]}`)
        process.exit(2)
    }
    let okN = r.results.filter((x) => x.ok)
    let bad = r.results.filter((x) => !x.ok)
    console.log(`補算擴充診斷(${r.names.join('、')}):已執行節點 ${r.nNodes} 個;補入 ${okN.length} 個、失敗 ${bad.length} 個、其餘已有值${bad.length ? `;失敗: ${bad.map((x) => `${x.nodeId.slice(0, 8)} ${x.error}`).join(';').slice(0, 1200)}` : ''}`)
    process.exit(bad.length ? 5 : 0)
}
else if (mode === 'frontier') {
    //列出前緣; 或結案: node g_rsi.mjs --mode frontier --close A02_ntPit[+B14_pitKey] --why "<理由>" [--claim <主張鍵>]
    //  --claim: 主張鍵(8 個十六進位字; 列示中之〔主張 …〕; 探索類之區分用之鍵列為〔鍵 …〕, 同以本參數指明); 取命令列之原字串(全為數字之鍵不得被轉成數值)
    let claimArg = () => {
        let i = process.argv.indexOf('--claim'); let v = i > 0 ? process.argv[i + 1] : undefined; return typeof v === 'string' && /^[0-9a-f]{8}$/.test(v) ? v : undefined
    }
    let cl = argOf('close', '')
    if (cl && cl !== true) {
        let ckc = claimArg()
        let k = P.closeFrontier({ arms: String(cl).split('+'), why: String(argOf('why', '')), ...(typeof ckc === 'string' && ckc ? { claim: ckc } : {}) })
        console.log(`結案 ${k} 條`)
    }
    //改掛(規則 R-ARM-4): node g_rsi.mjs --mode frontier --rearm <臂+臂> --to <臂+臂> --why "<理由>" [--base <起點 id>]
    //  主控通過新臂後, 把做夢「暫掛於既有臂」之未執行方向改掛新臂; 只改臂之歸屬、不改方向之內容; 輪次進行中不得執行
    let ra = argOf('rearm', '')
    if (ra && ra !== true) {
        let to = argOf('to', '')
        let why = argOf('why', '')
        if (!to || to === true || !why || why === true) {
            console.log('用法: node g_rsi.mjs --mode frontier --rearm <臂+臂> --to <臂+臂> --why "<理由>" [--base <起點 id>] [--claim <主張鍵>]')
            process.exit(2)
        }
        let lockF = acquireRunLock(path.join(st.rsi.root, 'logs', 'round.lock'))
        if (!lockF.ok) {
            console.log(`未執行: 有輪次或重算執行中(pid ${lockF.pid});等它結束再改掛`)
            process.exit(3)
        }
        let bs = argOf('base', undefined)
        let ck = claimArg()
        let r = P.rearmFrontier({ arms: String(ra).split('+'), to: String(to).split('+'), why: String(why), ...(typeof bs === 'string' && bs ? { base: bs } : {}), ...(typeof ck === 'string' && ck ? { claim: ck } : {}) })
        lockF.release()
        console.log(r.ok ? `已改掛: ${String(ra)} → ${r.arms.join('+')}(節點 ${r.nodeId.slice(0, 8)}${r.round ? `;已更新做夢 ${roundName(r.round)} 之方向` : ''})` : `未改掛: ${r.why}`)
        if (!r.ok) {
            process.exitCode = 1
        }
    }
    for (let f of rsi.store.listFrontier()) {
        console.log(`  ${f.status.padEnd(14)} p${f.priority === undefined ? '-' : f.priority} ${f.spec && f.spec.arms ? f.spec.arms.join('+') : '?'}${f.spec && f.spec.base ? ` ←${String(f.spec.base).slice(0, 8)}` : ''}${f.spec && f.spec.claim ? `〔${P.typeOf(f.spec) === 'verify' ? '主張' : '鍵'} ${f.spec.claim}〕` : ''} | ${String(f.reason || '').slice(0, 80)}`)
    }
}
else if (mode === 'annotate') {
    //於某輪之做夢文件加迴圈註記: node g_rsi.mjs --mode annotate --round 1 --file <註記文字檔(UTF-8)>
    let rd = argOf('round', 0)
    let fpTxt = argOf('file', '')
    let ok = rd > 0 && fpTxt && fpTxt !== true && fs.existsSync(String(fpTxt)) && P.annotateDream(rd, fs.readFileSync(String(fpTxt), 'utf8').trim())
    console.log(ok ? `已註記 ${roundName(rd)}` : '未註記(用法: --mode annotate --round N --file <文字檔>;或該輪無做夢文件)')
}
else if (mode === 'dirtype') {
    //補記某輪做夢文件之方向之任務類型(/3 以前之做夢文件無此欄): node g_rsi.mjs --mode dirtype --round 6 --file <JSON 檔: [{ index, type, claim }]>
    let rd = argOf('round', 0)
    let fpJs = argOf('file', '')
    let items = null
    try {
        items = JSON.parse(fs.readFileSync(String(fpJs), 'utf8'))
    }
    catch (err) {}
    let r = rd > 0 && Array.isArray(items) && items.length ? P.setDirectionTypes(rd, items) : { ok: false, why: '用法: --mode dirtype --round N --file <JSON 檔: [{ index, type, claim }]>' }
    console.log(r.ok ? `已補記 ${roundName(rd)} 之 ${items.length} 條方向之任務類型` : `未補記(${r.why})`)
}
else if (mode === 'status') {
    let s = await rsi.status({ print: false })
    let stt = fs.existsSync(path.join(st.rsi.root, 'STATUS.json')) ? JSON.parse(fs.readFileSync(path.join(st.rsi.root, 'STATUS.json'), 'utf8')) : null
    console.log(JSON.stringify({ nNodes: s.nNodes, top: (s.top || []).slice(0, 5), status: stt, frontier: rsi.store.listFrontier().filter((f) => f.status === 'proposed').length }, null, 1))
}
else {
    console.log('用法: node g_rsi.mjs --mode init|dry|round|status|board|validate')
    process.exit(2)
}
