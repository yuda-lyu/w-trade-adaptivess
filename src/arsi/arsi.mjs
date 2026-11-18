import fs from 'fs'
import path from 'path'
import { checkNodeAgentPart, checkDreamAgentPart, tallyDream, roundName } from './records.mjs'


//代理式 rsi 之通用流程件(不含領域用語; 一律依賴注入):
//  節點 = 一個 agent 依任務書寫出可被機械重跑之成品(artifact)並交付節點文件; 迴圈以注入之 verify 重跑成品取得正本數字
//  做夢 = 一個 agent 審計本輪節點(可信 / 部分可信 / 不可信 → 採納 / 重做 / 刪除)、彙整、給下一輪方向, 交付做夢文件
//  注入:
//    records   文件儲存(見 records.mjs; 可換儲存機制與路徑)
//    dispatch  async (role, { prompt, tag, logFile }) → { ok, error, agent: { kind, model, variant|effort } }; role 為 'node' 或 'dream'(模型由專案設定指定)
//    verify    async ({ nodeId, spec, workDir, round, attempt }) → { ok, error, raw, score, summary, notes, fingerprint, issues, checks, validation, evalJson }
//              raw        專案之完整結果(任意物件; 原樣成為入樹之 raw 與節點文件之 harness.raw)
//              score      { S, ladder, flags: { vetoed, why[] } }(引擎之分數形狀)
//              summary    [{ key, label, value, tol? }]: 重點數字(有序); 與 agent 自報(results.claimed)之同鍵逐項比對(數字容差 tol, 預設 max(0.05, |值| × 1e-4); 字串須相等), 不符列為問題
//              notes      [字串]: 渲染於節點文件之補充說明列(專案之領域指標)
//              fingerprint 成品行為之指紋(字串; 重做前後、agent 自跑與迴圈重跑之比對用)
//              issues     [字串]: 專案之機械檢查發現之問題
//              checks     { 鍵: 值 }(選配): 其他機械檢查之數值(如 agent 之評估次數), 併入節點文件之 harness.checks
//              validation { name, flag: 專案自訂之旗標字串 | null, label, at, error }(選配): 專案自訂之獨立驗證(如樣本外期間); 記入節點文件之 harness.validation 與 raw.validation
//    texts     { nodeBrief(ctx), nodePrompt(ctx), nodeTemplate(ctx), dreamBrief(ctx), dreamPrompt(ctx), dreamTemplate(ctx) }(專案之任務書文字)
//    hooks     { onNodeDone(doc), onDreamDone(doc), onRoundEnd(ctx) }(選配; 專案之事件回調, 如更新自家之指引文件、通知、統計)
//    workDir   各節點 / 做夢之工作夾之根
//    artifactFiles  成品之檔名清單(節點工作夾內; 重做時保留一份給 agent 當起點, 其餘交付物移入 attempt{n} 夾)
//    gate      async ({ role, id, round }) → 任意(選配): 起工作前之閘(如資源閘: 等 CPU / 記憶體回到門檻內才放行; 見 resources.mjs); 拋錯不擋
//              role 為 'node'(派節點 agent 前)、'verify'(重跑驗證前)、'dream'(派做夢 agent 前)
//    toolbox   共用工具區(選配; 見 toolbox.mjs 之 createToolbox): 給定時, 做夢前留快照、做夢後做機械檢查(不合之檔逐檔還原),
//              並與做夢文件之 expansion 對照(有變動而未記入者、列了而不存在者各列為問題); 結果記入做夢文件之 harness.toolbox
//              —— 共用工具之擴建由做夢 agent 統籌並親手完成, 迴圈只檢查、不代寫
let nowIso = () => new Date().toISOString()

let readJson = (fp) => {
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''))
    }
    catch (err) {
        return null
    }
}

/**
 * 建立代理式 rsi 之通用流程件(節點執行、做夢審計、處置套用);一律依賴注入,不含領域用語
 *
 * 各注入項(verify 之回傳欄位、texts 之函數、hooks 之回調)之詳細形狀見本檔上方之說明。
 *
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.records 輸入文件儲存物件(如 createFileRecords 之回傳;使用 getNodeDoc、putNodeDoc、getDreamDoc、putDreamDoc)
 * @param {Function} opt.dispatch 輸入派工函數,形式 async (role, { prompt, tag, logFile }) → { ok, error, agent },role 為 'node' 或 'dream'
 * @param {Function} opt.verify 輸入重跑驗證函數,形式 async ({ nodeId, spec, workDir, round, attempt }) → { ok, error, raw, score, summary, ... }
 * @param {Object} opt.texts 輸入任務書文字函數物件,含 nodeBrief、nodePrompt、nodeTemplate、dreamBrief、dreamPrompt、dreamTemplate(皆接收 ctx)
 * @param {Object} [opt.hooks={}] 輸入事件回調物件,可含 onNodeDone、onDreamDone、onRoundEnd,預設{}
 * @param {String} opt.workDir 輸入各節點與做夢工作夾之根路徑
 * @param {Array} [opt.artifactFiles=[]] 輸入成品檔名陣列,預設[]
 * @param {Function} [opt.gate=null] 輸入派工前之閘函數,形式 async ({ role, id, round }),預設null
 * @param {Object} [opt.toolbox=null] 輸入共用工具區物件(如 createToolbox 之回傳),預設null
 * @param {Function} [opt.log=()=>{}] 輸入記錄函數,預設空函數
 * @returns {Object} 回傳物件,含方法 runNode(執行節點任務)、runDream(執行一輪做夢)、applyDream(把做夢審計寫回節點並經注入之 actions 處置)、roundEnd(觸發 onRoundEnd)、nodeWorkDir(節點工作夾路徑)、dreamWorkDir(做夢工作夾路徑)
 * @example
 * let arsi = createArsi({ records, dispatch, verify, texts, workDir: './work' })
 * let { doc, raw } = await arsi.runNode({ nodeId, spec, round: 1, task })
 */
let createArsi = ({ records, dispatch, verify, texts, hooks = {}, workDir, artifactFiles = [], gate = null, toolbox = null, log = () => {} }) => {

    //passGate, 派工前之閘(選配); 閘本身出錯不擋派工
    let passGate = async (x) => {
        if (typeof gate !== 'function') {
            return
        }
        try {
            await gate(x)
        }
        catch (err) {
            log(`派工前之閘失敗(照常派工): ${String((err && err.message) || err)}`)
        }
    }

    let nodeWorkDir = (nodeId) => path.join(workDir, nodeId)
    let dreamWorkDir = (round) => path.join(workDir, `dream_${roundName(round)}`)
    let call = async (name, ...a) => {
        if (typeof hooks[name] === 'function') {
            try {
                return await hooks[name](...a)
            }
            catch (err) {
                log(`hook ${name} 失敗: ${String((err && err.message) || err)}`)
            }
        }
        return null
    }

    //runNode, 執行一個節點任務(首次或重做); 回 { doc, raw }; 成品無法評估 ⇒ 拋錯(錯誤物件附 doc);
    //  派工結果 quota: true(額度用盡而未完成; 規則 R-RUN-8)⇒ 不重跑驗證、節點文件記 failed、拋錯(錯誤物件附 doc 並帶 quota: true 與 transient: true)
    let runNode = async ({ nodeId, spec, round, task, rework = null }) => {
        let wd = nodeWorkDir(nodeId)
        fs.mkdirSync(wd, { recursive: true })
        let prev = records.getNodeDoc(nodeId)
        let attempt = prev ? (prev.attempt || 1) + 1 : 1
        //重做: 前一次之交付物移入 attempt{n} 夾存查(成品檔 artifactFiles 留一份副本給 agent 當起點)
        if (prev) {
            let fdOld = path.join(wd, `attempt${prev.attempt || 1}`)
            fs.mkdirSync(fdOld, { recursive: true })
            for (let f of fs.readdirSync(wd)) {
                let fp = path.join(wd, f)
                if (!fs.statSync(fp).isFile()) {
                    continue
                }
                if (artifactFiles.includes(f)) {
                    fs.copyFileSync(fp, path.join(fdOld, f))
                }
                else {
                    fs.renameSync(fp, path.join(fdOld, f))
                }
            }
        }
        //專案之工作夾準備(選配; task.prepare, 不可列舉之函數): 於封存之後、寫任務書之前呼叫 —— 重做時前一次之檔已移入 attempt{n} 夾,
        //  任務書所指之輔助檔(例如起點與參考成品之複本)須由專案補回; 拋錯只記錄, 不中斷派工
        if (task && typeof task.prepare === 'function') {
            try {
                task.prepare(wd)
            }
            catch (err) {
                log(`節點 ${nodeId.slice(0, 8)} 之工作夾準備失敗: ${String((err && err.message) || err).slice(0, 200)}`)
            }
        }
        let ctx = { nodeId, spec, round, attempt, task, rework, workDir: wd, prevDoc: prev }
        fs.writeFileSync(path.join(wd, 'brief.md'), texts.nodeBrief(ctx), 'utf8')
        fs.writeFileSync(path.join(wd, 'node.template.json'), JSON.stringify(texts.nodeTemplate(ctx), null, 1), 'utf8')
        await passGate({ role: 'node', id: nodeId, round })
        let startedAt = nowIso()
        let t0 = Date.now()
        log(`節點 ${nodeId.slice(0, 8)} 第 ${attempt} 次派工(${spec.arms ? spec.arms.join('+') : ''})`)
        let r = await dispatch('node', { prompt: texts.nodePrompt(ctx), tag: `${roundName(round)}_${nodeId.slice(0, 8)}_a${attempt}`, logFile: path.join(wd, `agent_a${attempt}.log`) })
        let agent = { role: 'node', ...(r.agent || {}), startedAt, endedAt: nowIso(), durationSec: Math.round((Date.now() - t0) / 1000), ok: r.ok === true, error: r.ok === true ? null : String(r.error || '').slice(0, 500) }
        //額度用盡而未完成(派工結果 quota: true; 規則 R-RUN-8): agent 未跑完, 工作夾內只有半成品(範本原樣之文件、草稿)⇒ 不重跑驗證、不當成交付,
        //  節點文件記 failed、呼叫 onNodeDone 後拋錯(錯誤物件帶 quota: true、transient: true 與 doc); 引擎把該提案留在前緣(不計 retries、另記 transients), 額度恢復後之輪次重試
        //  其他原因之派工失敗(逾時、離開碼非零…)維持既有行為: 照常讀 node.json 並重跑驗證
        if (r.ok !== true && r.quota === true) {
            let why = '節點 agent 之額度用盡而未完成(未重跑驗證; 額度恢復後重試)'
            let doc = records.putNodeDoc({
                nodeId,
                round,
                attempt,
                status: 'failed',
                createdAt: prev ? prev.createdAt : nowIso(),
                spec,
                task: { ...task, rework },
                agent,
                plan: null,
                code: null,
                results: null,
                conclusion: null,
                harness: { ok: false, summary: [], notes: [], score: null, fingerprint: null, checks: { issues: [] }, validation: null, raw: null, evalJson: null, error: why },
                audit: null,
                history: [...((prev && prev.history) || []), ...(prev ? [{ attempt: prev.attempt || 1, S: prev.harness && prev.harness.score ? prev.harness.score.S : null, fingerprint: prev.harness ? (prev.harness.fingerprint || null) : null, audit: prev.audit || null }] : [])],
            })
            await call('onNodeDone', doc)
            log(`節點 ${nodeId.slice(0, 8)} 失敗: ${why}(agent ${agent.durationSec}s)`)
            //transient: true(Gitea #157; w-recursi 1.0.12 起): 額度用盡不是候選本身之問題 ⇒ 引擎前緣結案不計 retries、另記 transients(同程序與子程序兩種評估模式皆依拋出之值之 transient === true 判定);
            //  評估器(domain.mjs 之 evaluator.evaluate)不攔截此錯誤、原物件逕拋給引擎, 欄位不會被重包而遺失
            throw Object.assign(new Error(`${why}: ${String(r.error || '').slice(0, 300)}`), { doc, quota: true, transient: true })
        }
        let part = readJson(path.join(wd, 'node.json'))
        let docIssues = part ? checkNodeAgentPart(part) : ['未交付 node.json 或其內容不是合法 JSON']
        //重跑驗證亦經閘(多個節點同時交付時, 其重跑會疊在一起)
        await passGate({ role: 'verify', id: nodeId, round })
        let v = await verify({ nodeId, spec, workDir: wd, round, attempt })
        let issues = [...docIssues.map((x) => `文件: ${x}`), ...(v.issues || [])]
        let claimed = part && part.results && part.results.claimed ? part.results.claimed : null
        if (v.ok && claimed) {
            //自報與正本逐項比對(同鍵者): 數字依容差, 字串須相等
            for (let s of Array.isArray(v.summary) ? v.summary : []) {
                if (!s || !(s.key in claimed)) {
                    continue
                }
                let c = claimed[s.key]
                if (typeof s.value === 'number' && typeof c === 'number') {
                    let tol = typeof s.tol === 'number' ? s.tol : Math.max(0.05, Math.abs(s.value) * 1e-4)
                    if (Math.abs(c - s.value) > tol) {
                        issues.push(`自報 ${s.label || s.key} ${c} 與重跑 ${s.value} 不符`)
                    }
                }
                else if (typeof s.value === 'string' && typeof c === 'string' && c !== '' && c !== s.value) {
                    issues.push(`自報 ${s.label || s.key} ${c} 與重跑 ${s.value} 不符(成品於自報後有改, 或結果不可重現)`)
                }
            }
        }
        else if (v.ok && !claimed) {
            issues.push('未自報最終結果(results.claimed)')
        }
        let doc = {
            nodeId,
            round,
            attempt,
            status: v.ok ? 'verified' : 'failed',
            createdAt: prev ? prev.createdAt : nowIso(),
            spec,
            task: { ...task, rework },
            agent,
            plan: part && part.plan ? part.plan : null,
            code: part && part.code ? part.code : null,
            results: part && part.results ? part.results : null,
            conclusion: part && part.conclusion ? part.conclusion : null,
            harness: { ok: v.ok === true, summary: v.summary || [], notes: v.notes || [], score: v.score || null, fingerprint: v.fingerprint || null, checks: { issues, ...(v.checks || {}) }, validation: v.validation || null, raw: v.raw || null, evalJson: v.evalJson || null, error: v.ok ? null : String(v.error || '').slice(0, 800) },
            audit: null,
            history: [...((prev && prev.history) || []), ...(prev ? [{ attempt: prev.attempt || 1, S: prev.harness && prev.harness.score ? prev.harness.score.S : null, fingerprint: prev.harness ? (prev.harness.fingerprint || null) : null, audit: prev.audit || null }] : [])],
        }
        doc = records.putNodeDoc(doc)
        await call('onNodeDone', doc)
        log(`節點 ${nodeId.slice(0, 8)} ${v.ok ? `完成: S ${v.score.S} 階梯 ${v.score.ladder}${v.validation ? `; 驗證 ${v.validation.name} ${v.validation.flag || `未得(${String(v.validation.error || '').slice(0, 60)})`}` : ''}` : `失敗: ${String(v.error || '').slice(0, 120)}`}(agent ${agent.durationSec}s${issues.length ? `; 檢查 ${issues.length} 項` : ''})`)
        if (!v.ok) {
            throw Object.assign(new Error(`節點未交付可評估之成品: ${String(v.error || '').slice(0, 300)}`), { doc })
        }
        //入樹之 raw = 專案之完整結果 + 通用欄(第幾次交付、agent、文件是否合格、問題、自報、獨立驗證之旗標)
        return { doc, raw: { ...(v.raw || {}), attempt, agent: { kind: agent.kind, model: agent.model, durationSec: agent.durationSec, ok: agent.ok }, docOk: docIssues.length === 0, issues, claimed, validation: v.validation ? { name: v.validation.name, flag: v.validation.flag } : null } }
    }

    //runDream, 執行一輪之做夢(審計 + 彙整 + 方向); 回 { doc, ok, issues }
    let runDream = async ({ round, nodeIds, reworkedIds = [], context = {} }) => {
        let wd = dreamWorkDir(round)
        fs.mkdirSync(wd, { recursive: true })
        for (let f of ['dream.json']) {
            let fp = path.join(wd, f)
            if (fs.existsSync(fp)) {
                fs.renameSync(fp, path.join(wd, `${Date.now()}_${f}`))
            }
        }
        let ctx = { round, nodeIds, reworkedIds, workDir: wd, context }
        fs.writeFileSync(path.join(wd, 'brief.md'), texts.dreamBrief(ctx), 'utf8')
        fs.writeFileSync(path.join(wd, 'dream.template.json'), JSON.stringify(texts.dreamTemplate(ctx), null, 1), 'utf8')
        await passGate({ role: 'dream', id: roundName(round), round })
        //共用工具區: 做夢前留快照(做夢後據以比對差異、還原不合之檔)
        let snap = null
        if (toolbox) {
            try {
                snap = toolbox.snapshot()
            }
            catch (err) {
                log(`共用工具區之快照失敗(本輪不檢查): ${String((err && err.message) || err)}`)
            }
        }
        let startedAt = nowIso()
        let t0 = Date.now()
        log(`做夢 ${roundName(round)}: 審計 ${nodeIds.length} 個節點`)
        let r = await dispatch('dream', { prompt: texts.dreamPrompt(ctx), tag: `${roundName(round)}_dream`, logFile: path.join(wd, 'agent.log') })
        let agent = { role: 'dream', ...(r.agent || {}), startedAt, endedAt: nowIso(), durationSec: Math.round((Date.now() - t0) / 1000), ok: r.ok === true, error: r.ok === true ? null : String(r.error || '').slice(0, 500) }
        let part = readJson(path.join(wd, 'dream.json'))
        let issues = part ? checkDreamAgentPart(part, nodeIds) : ['未交付 dream.json 或其內容不是合法 JSON']
        //共用工具區之機械檢查(不合之檔逐檔還原)與 expansion 之對照
        let tb = null
        if (toolbox && snap) {
            try {
                tb = toolbox.check(snap)
            }
            catch (err) {
                tb = { ok: false, changed: { added: [], changed: [], removed: [] }, reverted: [], issues: [`共用工具區之檢查失敗: ${String((err && err.message) || err).slice(0, 200)}`] }
            }
            let exp = part && Array.isArray(part.expansion) ? part.expansion.filter((x) => x && typeof x === 'object') : []
            let norm = (s) => String(s).replace(/\\/g, '/')
            let listed = exp.flatMap((x) => (Array.isArray(x.files) ? x.files : [])).map(norm)
            let hit = (rel) => listed.some((f) => f === rel || f.endsWith(`/${rel}`))
            for (let rel of [...tb.changed.added, ...tb.changed.changed]) {
                if (rel !== toolbox.indexFile && !hit(rel)) {
                    tb.issues.push(`有變動之檔 ${rel} 未記入 expansion`)
                }
            }
            let now = toolbox.list().map((f) => f.rel)
            for (let x of exp.filter((y) => y.decision === 'built' || y.decision === 'updated')) {
                for (let f of (Array.isArray(x.files) ? x.files : []).map(norm)) {
                    if (!now.some((rel) => f === rel || f.endsWith(`/${rel}`))) {
                        tb.issues.push(`expansion 所列之檔 ${f} 不在共用工具區(未寫入、路徑不符或已被還原)`)
                    }
                }
            }
            tb.ok = tb.reverted.length === 0 && tb.issues.length === 0
        }
        let doc = records.putDreamDoc({
            round,
            createdAt: nowIso(),
            agent,
            //request(選配): 主控對本輪做夢之要求({ why, dreamOnly }; 由領域經 context.request 傳入)—— 記入文件, 日後之讀者才知本份之範圍與緣由
            //  why 非字串或為空白者視同未帶(與任務書、渲染之判斷一致; 規則 R-RUN-9)⇒ scope 與改前相同
            scope: { nodes: nodeIds, reworked: reworkedIds, ...(context && context.request && typeof context.request.why === 'string' && context.request.why.trim() ? { request: context.request } : {}) },
            audits: part && Array.isArray(part.audits) ? part.audits : [],
            synthesis: part && part.synthesis ? part.synthesis : null,
            guidance: part && part.guidance ? part.guidance : null,
            docsUpdated: part && Array.isArray(part.docsUpdated) ? part.docsUpdated : [],
            //expansion 只在有共用工具區、或做夢有交付此欄時才入文件(未啟用擴建之專案, 其做夢文件不出現此節)
            ...(toolbox || (part && Array.isArray(part.expansion)) ? { expansion: part && Array.isArray(part.expansion) ? part.expansion : [] } : {}),
            harness: { docIssues: issues, tally: tallyDream(part), ...(tb ? { toolbox: tb } : {}) },
        })
        log(`做夢 ${roundName(round)} ${part ? '交付' : '未交付'}(agent ${agent.durationSec}s${issues.length ? `; 文件問題 ${issues.length} 項` : ''}${tb ? `; 共用工具區 新增 ${tb.changed.added.length}、修改 ${tb.changed.changed.length}、還原 ${tb.reverted.length}` : ''})`)
        return { doc, ok: !!part, issues, tally: doc.harness.tally, toolbox: tb }
    }

    //applyDream, 把做夢文件之審計結果寫回節點文件, 並經注入之 actions 執行處置
    //  actions: { accept(nodeId, audit), rework(nodeId, audit) → { ok, note }, remove(nodeId, audit) → { ok, note }, propose(direction) → { ok, note } }(皆可 async)
    //  appliedExtra(選配): 專案附記於做夢文件 harness.applied 之鍵(物件; 不得覆寫上列之鍵)
    let applyDream = async ({ doc, actions, appliedExtra = null }) => {
        let applied = { ...(appliedExtra || {}), accepted: [], rework: [], deleted: [], proposals: [], skipped: [] }
        let scope = new Set((doc.scope && doc.scope.nodes) || [])
        for (let a of doc.audits || []) {
            if (!scope.has(a.nodeId)) {
                applied.skipped.push({ nodeId: a.nodeId, why: '不在本輪審計範圍' })
                continue
            }
            let nd = records.getNodeDoc(a.nodeId)
            if (!nd) {
                applied.skipped.push({ nodeId: a.nodeId, why: '無節點文件' })
                continue
            }
            //inactiveArms(選配): 審計所定之「指派而交付版未作用之臂」; 有給才帶(未給 = 審計未表示意見, 由專案決定是否沿用節點自報)
            let audit = { round: doc.round, by: doc.agent ? doc.agent.model : null, trust: a.trust, action: a.action, evidence: a.evidence || [], issues: a.issues || [], reworkBrief: a.reworkBrief || null, deleteWhy: a.deleteWhy || null, ...(Array.isArray(a.inactiveArms) ? { inactiveArms: a.inactiveArms.filter((x) => typeof x === 'string') } : {}) }
            nd.audit = audit
            records.putNodeDoc(nd)
            if (a.action === 'delete') {
                let r = await actions.remove(a.nodeId, audit)
                applied.deleted.push({ nodeId: a.nodeId, ...(r || {}) })
            }
            else if (a.action === 'rework') {
                await actions.accept(a.nodeId, audit) //先記審計結果(可信度), 重做後由下一輪再審
                let r = await actions.rework(a.nodeId, audit)
                applied.rework.push({ nodeId: a.nodeId, ...(r || {}) })
            }
            else {
                await actions.accept(a.nodeId, audit)
                applied.accepted.push(a.nodeId)
            }
        }
        for (let d of (doc.guidance && doc.guidance.directions) || []) {
            let r = await actions.propose(d)
            applied.proposals.push({ arms: d.arms, base: d.base || null, ...(r || {}) })
        }
        let d2 = records.getDreamDoc(doc.round)
        d2.harness = { ...(d2.harness || {}), applied }
        d2 = records.putDreamDoc(d2)
        await call('onDreamDone', d2)
        return { applied, doc: d2 }
    }

    let roundEnd = (ctx) => call('onRoundEnd', ctx)

    return { runNode, runDream, applyDream, roundEnd, nodeWorkDir, dreamWorkDir }
}


export { createArsi }
export default createArsi
