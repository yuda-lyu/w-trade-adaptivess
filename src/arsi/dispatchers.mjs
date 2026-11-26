import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
import genDiagStreamMasker from 'wsemi/src/genDiagStreamMasker.mjs'
import maskDiagText from 'wsemi/src/maskDiagText.mjs'
import { agentEnvOf } from './agentRole.mjs'
import { rsiNumOf } from './rsiNums.mjs'
import { isPlain, objReq, strReq, strOpt, boolOpt, agentsCheck } from './inputs.mjs'

//numOr: 設定之數值之取值(排程第 595 項; K3、K4、K7): 數字或其數字字串轉為數值後使用, 無效或未給取 def(原: Number.isFinite 使數字字串被當成未給;
//  `cfg.timeoutMin || 120` 使 'abc' 成 NaN 而 0 取預設、負數照用)
let numOr = (v, kind, def) => {
    let x = rsiNumOf(v, kind)
    return x === null ? def : x
}


//額度用盡之處置(規則 R-RUN-8; Gitea #156):
//  ① 派工套件之結果 { ok: false, errorType: 'quota' } = 因額度而未完成(免費池用量用盡時 CLI 不會自行結束; 偵測與終止由派工套件負責, 數秒內即回); 本套件只依此欄判定, 不自行偵測錯誤字樣、不終止子行程
//  ② 派工結果帶 quota: 主模型之用量達門檻而不派、或派工套件回 quota ⇒ 該條目 quota; 鏈上每一家皆因額度而未完成 ⇒ 整體 quota: true(任一家為其他原因之失敗者不標)
//  ③ 呼叫端(arsi.mjs 之 runNode)遇 quota: true 不重跑驗證、不把工作夾內之半成品當成交付
//  ④ 起跑前之檢查(checkQuota 之 probe: true)於主模型達門檻而有備援時實際試一次備援, 備援因額度而不可用即擋下, 並回報達門檻之視窗全部重置之時刻(retryAt)
//  ⑤ 用量守門之門檻可設定(makeDispatch 之 maxPercent、agents.<role>.quotaMaxPercent)
//  ⑥ 全部 opencode 條目之 stderr 經共用之串流遮罩器(wsemi 之 genDiagStreamMasker; 秘密 = 本次讀到之金鑰; 排程第 486 項之使用端)後附寫到派工紀錄檔同夾之 <主檔名>.stderr.log
//     輸出以列為單位(收到換行才交出該列; 每列 = maskDiagText(該列); 與塊之切法無關); 已登錄之秘密(含跨塊與跨列者)、網址帳密、憑證鍵值對與 Bearer 皆整段遮到; 長列分段之切點避開整段命中; 二進位塊以 UTF-8 串流解碼
//     已知限制(wsemi 之 genDiagStreamMasker 之 JSDoc): 未登錄之憑證值若為引號內含換行者, 第二列起不被視為憑證值(逐列遮罩之結果; 原: 整批完整列合成一塊遮, 視塊之切法可能整段遮到); 已登錄之秘密不受此限
//  ⑧ 派工結果之 error 欄(派工套件取 stderr 尾段, 只遮當次所用之金鑰; 金鑰檔所列之其他金鑰若出現於該尾段則原樣留下)另經本庫之秘密清單(secretsOf)以 wsemi 之 maskDiagText(串流遮罩器之一次性形式; 同一組規則)遮一次, 再截至 300 字元:
//     先遮再截(截斷若先於遮罩, 會切開金鑰而使留下之前段不被辨認)、一處(makeDispatch 回傳之函數記入 errs 之處; 成功時 error 為 null 不經此; 主模型與各備援、claude 與 opencode、派工例外皆走同一處)

//PROBE_PROMPT, 探測備援用之極小提示詞
let PROBE_PROMPT = '只回覆兩個字: OK'

//secretsOf, 本次自金鑰檔讀到之金鑰(供串流遮罩器 genDiagStreamMasker 之秘密清單; 去重):
//  ① 金鑰變數(派工套件條目表所列之 envVar, 預設 OPENCODE_GO_KEYS)之各值依「,」「;」拆開、長度 ≥ 4 者(這些必為金鑰, 取較低之門檻; 長度門檻在此取 ≥ 4 / ≥ 8, 免得把短值如旗標、數字遮成亂碼 —— 遮罩器本身對各長度之秘密皆照遮)
//  ② 檔內其他變數之各值依同法拆開、長度 ≥ 8 者(未知用途之值: 短值如旗標、數字不列入, 免得把一般文字遮成亂碼)
let secretsOf = (env, keyVars) => {
    let out = new Set()
    for (let [name, v] of Object.entries(env || {})) {
        let min = keyVars.includes(name) ? 4 : 8
        for (let s of String(v).split(/[,;]/)) {
            let k = s.trim()
            if (k.length >= min) {
                out.add(k)
            }
        }
    }
    return [...out]
}

//makeStderrSink, 錯誤輸出之留存: 以 wsemi 之串流遮罩器(genDiagStreamMasker; 排程第 486 項之使用端; 診斷輸出與遮罩規格 §2)逐列遮罩後附寫; push(chunk) 收區塊、flush() 收尾(無換行之尾段)
//  遮罩之規則、跨塊與跨列之秘密、長列之分段、二進位塊之解碼與不可檢查之塊之 fail-closed 皆由遮罩器負責(本套件不再自寫切點與憑證樣式); 回傳非空才寫(有輸出時才建檔, 先寫一行標頭); 寫檔失敗不拋
//  輸出以列為單位: 收到換行才交出該列(原: 逐塊之完整列合成一塊遮); 遮罩器之 push / flush 永不拋錯(內部失敗回 ***)
let makeStderrSink = ({ fp, head, secrets }) => {
    let sm = genDiagStreamMasker(secrets)
    let started = false
    let put = (s) => {
        if (s === '') {
            return
        }
        try {
            let out = started ? '' : head
            started = true
            fs.appendFileSync(fp, out + s)
        }
        catch (err) {}
    }
    return {
        push: (chunk) => {
            put(sm.push(chunk))
        },
        flush: () => {
            put(sm.flush())
        },
    }
}

//isQuotaFail, 派工套件之結果是否為「因額度而未完成」(契約: ok 為 false 且 errorType 為 'quota')
let isQuotaFail = (r) => !!r && r.ok !== true && r.errorType === 'quota'

//retryOf, 一組視窗中達門檻者全部重置之時刻(取最晚); 無達門檻之視窗、或其一無法解析重置時刻 ⇒ null
let retryOf = (ws, mx) => {
    let hot = ws.filter((w) => typeof w.percent === 'number' && w.percent >= mx)
    let best = null
    for (let w of hot) {
        let ms = typeof w.resetAt === 'string' ? Date.parse(w.resetAt) : NaN
        if (!Number.isFinite(ms)) {
            return null
        }
        if (best === null || ms > best.ms) {
            best = { ms, at: w.resetAt }
        }
    }
    return best ? best.at : null
}

//pickAt, 多個時刻字串取最晚(later 為 true)或最早; 任一為 null 或無法解析 ⇒ null(查不到者不假設)
let pickAt = (list, later) => {
    let best = null
    for (let x of list) {
        let ms = typeof x === 'string' ? Date.parse(x) : NaN
        if (!Number.isFinite(ms)) {
            return null
        }
        if (best === null || (later ? ms > best.ms : ms < best.ms)) {
            best = { ms, at: x }
        }
    }
    return best ? best.at : null
}


//派工器之預設實作: 以 w-dispatch-ai(裝在全域技能根, 不在專案安裝)呼叫各家 CLI; 模型由專案設定 agents.<role> 指定(可含 fallback 鏈)
//  makeDispatch({ agents, skillsRoot, envFile, cwd, maxPercent, inject }) → async (role, { prompt, tag, logFile }) → { ok, error, stdout, agent: { kind, model, variant|effort }, quota? }
//    quota: true = 鏈上每一家皆因額度而未能完成(主模型之用量達門檻而不派、或派工套件回 errorType 'quota'): 不是 agent 之過失, 呼叫端據以不把半成品當成交付(arsi.mjs 之 runNode)
//  agents.<role> = { kind: 'opencode', id: 'ocgo:opencode-go/<模型>' 或 'oc:opencode/<模型>', variant, timeoutMin, quotaMaxPercent, fallback: [同形] }
//                 或 { kind: 'claude', model, effort, timeoutMin }
//  金鑰自 envFile 讀(readEnvFile, 不進 process.env), 只傳給該次子程序, 不落任何檔
//  opencode: 權限放開(edit / write / bash 皆 allow; 節點須寫檔與跑評估), 不帶 --auto(專案夾外之存取維持被拒)
//  claude  : 沿用本機之訂閱登入; 未另限工具(工作區為自有專案)
/**
 * 建立派工函數(以 w-dispatch-ai 呼叫各家 CLI;模型由 agents.<role> 指定,可含 fallback 鏈)
 *
 * 金鑰自 envFile 讀取,只傳給該次子程序。回傳之函數依序嘗試 agents[role] 與其 fallback,首個成功者即回傳。
 * 因額度而未完成(主模型之用量達門檻而不派、或派工套件回報 errorType 為 quota)者記為額度之失敗;鏈上每一家皆如此時結果帶 quota: true。
 * 全部 opencode 條目之錯誤輸出(stderr)經共用遮罩後附寫到派工紀錄檔同夾之「主檔名.stderr.log」。
 * 輸入之檢測(R-EV-54):opt、agents 非一般物件、skillsRoot 非非空字串(給 inject.wda 者除外)、agents.<role> 之 kind 非 opencode / claude、fallback 非物件之陣列 ⇒ 同步拋 invalid opt.…: must be …(固定訊息、不帶輸入值);
 * 回傳之派工函數於 o 非一般物件或 prompt、logFile 非字串時回 ok 為 false 之結果(不派工)。
 *
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.agents 輸入各角色設定,agents.<role> 為 { kind: 'opencode', id, variant, timeoutMin, quotaMaxPercent, fallback } 或 { kind: 'claude', model, effort, timeoutMin };quotaMaxPercent 為該角色之用量守門百分比(優先於 maxPercent;大於 100 表示不以用量守門,被限流者仍不派)
 * @param {String} opt.skillsRoot 輸入 w-dispatch-ai 所在之技能根路徑(其 node_modules 內須有 w-dispatch-ai)
 * @param {String} [opt.envFile] 輸入金鑰環境檔路徑
 * @param {String} [opt.cwd] 輸入子程序工作路徑
 * @param {Number} [opt.maxPercent=95] 輸入訂閱之用量守門百分比,任一視窗達此值即不派該條目(由 fallback 接手),非有限數取預設,預設95
 * @param {Object} [opt.inject] 輸入測試用之替身:{ wda(派工套件之替身) }
 * @returns {Function} 回傳 async (role, { prompt, tag, logFile }) → { ok, error, agent, quota, ... } 之派工函數;該 role 未設定時回傳 ok 為 false;quota 為 true 表示鏈上每一家皆因額度而未能完成
 * @example
 * let dispatch = makeDispatch({ agents, skillsRoot: './skills', envFile: './.env', cwd: './work' })
 * let r = await dispatch('node', { prompt, tag: 'r001_node', logFile: './work/agent.log' })
 */
let makeDispatch = (opt) => {
    //輸入之檢測(跨套件規格 V4、K3、§5.1; R-EV-54; 工廠 ⇒ 同步拋固定訊息, 先於任何副作用): opt、agents 須為一般物件; skillsRoot 須為非空字串(給 inject.wda 者除外);
    //  agents.<role> 之 kind 給了須為 opencode 或 claude、fallback 給了須為物件之陣列(各項之 kind 同); maxPercent 無效者用預設(K3)
    //  原: opt 為 null 或缺 skillsRoot ⇒ 原生 TypeError; kind 為其他值 ⇒ 靜默走 opencode 分支; fallback 非陣列 ⇒ 展開時拋原生 TypeError
    let ov = objReq(opt, 'opt')
    let agents = objReq(ov.agents, 'opt.agents')
    let inject = ov.inject === undefined || ov.inject === null ? {} : objReq(ov.inject, 'opt.inject')
    let skillsRoot = inject.wda ? ov.skillsRoot : strReq(ov.skillsRoot, 'opt.skillsRoot')
    agentsCheck(agents)
    //cwd(agent 之工作根: 其下 edit / write / bash 皆放行)給了而非非空字串 ⇒ 拋(安全相關; 不靜默取行程之工作目錄)
    let cwd = strOpt(ov.cwd, undefined, 'opt.cwd')
    let { envFile, maxPercent = 95 } = ov
    let wda = inject.wda || createRequire(import.meta.url)(path.join(skillsRoot, 'node_modules', 'w-dispatch-ai'))
    let env = envFile && fs.existsSync(envFile) ? wda.readEnvFile(envFile) : {}
    let keysOf = (name) => String(env[name] || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    let secrets = secretsOf(env, [...new Set(['OPENCODE_GO_KEYS', ...(Array.isArray(wda.providers) ? wda.providers.map((p) => p && p.envVar).filter((x) => typeof x === 'string' && x) : [])])])
    //訂閱之用量守門之預設門檻(與起跑前之額度檢查同一設定: 專案設定 rsi.preflight.quotaMaxPercent); 非有限數取 95
    let gateMax = numOr(maxPercent, 'num', 95)
    //errTextOf, 派工結果之 error 欄之留存文字(⑧): 先以本庫之秘密清單遮罩(金鑰檔所列之全部金鑰, 不只當次所用者)、再截至 300 字元; maskDiagText 永不拋(內部失敗回 ***)
    let errTextOf = (e) => maskDiagText(String(e || ''), secrets).slice(0, 300)

    //agentEnv(規則 R-RUN-11): 節點與做夢之 agent 子行程另帶 ARSI_AGENT_ROLE = 角色(經 w-dispatch-ai 之 opt.env 只注入該次子行程; 不寫入本行程之環境)
    //  ⇒ agent 所起之指令執行寫檔或起行程之進入檔與模式即被拒跑(src/domain/agentEntries.mjs); 其他角色不帶
    let runOpencode = async (cfg, { prompt, logFile, agentEnv = null }) => {
        let entry = wda.providers.find((p) => p.id === cfg.id)
        if (!entry) {
            return { ok: false, error: `派工條目 ${cfg.id} 不在 w-dispatch-ai 之條目表` }
        }
        let opts = {
            model: entry.model,
            extraArgs: cfg.variant ? ['--variant', cfg.variant] : (entry.extraArgs || []),
            //experimental.continue_loop_on_deny(規則 R-RUN-7): opencode 於「ask 被自動拒絕」(例: 寫檔路徑打錯而落在專案夾外)後預設結束整個工作階段(離開碼 0);
            //  設為 true 則只把錯誤交回模型, 模型可改正續做; 權限規則不變(專案夾外仍寫不出)。
            //  不以 permission.external_directory: 'deny' 代替: 使用者規則接在預設之後且比對取最後一筆, 會蓋過預設放行之工具輸出截斷檔夾與暫存夾(opencode 1.19.5)
            config: { permission: { edit: 'allow', write: 'allow', bash: 'allow' }, experimental: { continue_loop_on_deny: true } },
            cwd,
            timeoutMs: numOr(cfg.timeoutMin, 'timerMin', 120) * 60000,
            validate: 'nonempty',
            detectTruncation: entry.detectTruncation === true,
            onStdout: (chunk) => {
                try {
                    fs.appendFileSync(logFile, chunk)
                }
                catch (err) {}
            },
            ...(agentEnv ? { env: agentEnv } : {}),
        }
        if (entry.provider === 'opencode-go') {
            let keys = keysOf(entry.envVar || 'OPENCODE_GO_KEYS')
            if (keys.length === 0) {
                return { ok: false, error: `${entry.envVar || 'OPENCODE_GO_KEYS'} 未提供(${envFile})` }
            }
            //用量守門: 任一視窗達門檻或被限流 ⇒ 不派(由 fallback 接手; 結果記為額度之失敗);
            //  門檻 = 該角色之 quotaMaxPercent(agents.<role>.quotaMaxPercent), 未設則取 makeDispatch 之 maxPercent(預設 95);
            //  設為大於 100 之值 = 不以用量守門(用到訂閱實際用盡為止; 被限流者仍不派)
            let mx = numOr(cfg.quotaMaxPercent, 'num', gateMax)
            let key = null
            for (let k of keys) {
                let u = await wda.opencodeGoUsage({ key: k })
                let ws = u && u.ok && u.usage ? Object.values(u.usage) : []
                let hot = ws.some((w) => w && typeof w.percent === 'number' && w.percent >= mx) || (u && u.limited === true)
                if (!hot) {
                    key = k
                    break
                }
            }
            if (!key) {
                return { ok: false, quota: true, error: `OpenCode Go 用量已達 ${mx}% 或被限流, 不派` }
            }
            opts.provider = 'opencode-go'
            opts.key = key
        }
        else {
            opts.useStoredAuth = false
        }
        //錯誤輸出之留存(全部 opencode 條目): agent 因上游錯誤(額度用盡、限流、模型停用…)而中止時, 其原文只出現在 stderr;
        //  派工結果之 stderr 欄只留前段(失敗 1000 字元、逾時 500 字元), 故以 onStderr 取全文; 先遮罩再寫
        let fpErr = `${String(logFile).replace(/\.log$/, '')}.stderr.log`
        let sink = makeStderrSink({ fp: fpErr, head: `\n===== ${new Date().toISOString()} stderr ${cfg.id} =====\n`, secrets })
        opts.onStderr = (chunk) => sink.push(chunk)
        let r
        try {
            r = await wda.dispatchOpencode(prompt, opts)
        }
        finally {
            sink.flush()
        }
        return { ok: r.ok === true, ...(isQuotaFail(r) ? { quota: true } : {}), error: r.ok ? null : `${r.errorType || ''} ${r.error || ''}`.trim(), stdout: r.stdout || '', durationMs: r.durationMs }
    }

    let runClaude = async (cfg, { prompt, logFile, agentEnv = null }) => {
        let r = await wda.dispatchClaude(prompt, {
            ...(agentEnv ? { env: agentEnv } : {}),
            model: cfg.model,
            //--strict-mcp-config: 不帶入帳號之外部連接器工具(只需讀寫專案檔與跑指令)
            //--output-format stream-json --verbose: 輸出逐步事件(含每次工具呼叫之輸入), 落於 logFile 供事後稽核其操作; cfg.trace === false 時只輸出最終文字
            extraArgs: ['--strict-mcp-config', '--effort', cfg.effort || 'xhigh', ...(cfg.trace === false ? [] : ['--output-format', 'stream-json', '--verbose'])],
            cwd,
            timeoutMs: numOr(cfg.timeoutMin, 'timerMin', 240) * 60000,
            validate: 'nonempty',
            onStdout: (chunk) => {
                try {
                    fs.appendFileSync(logFile, chunk)
                }
                catch (err) {}
            },
        })
        return { ok: r.ok === true, ...(isQuotaFail(r) ? { quota: true } : {}), error: r.ok ? null : `${r.errorType || ''} ${r.error || ''}`.trim(), stdout: r.stdout || '', durationMs: r.durationMs }
    }

    return async (role, o) => {
        //呼叫之輸入(結果物件通道): o 須為一般物件且 prompt、logFile 為字串, 否則回 ok: false(不派工、不寫檔; 原: 取 o.logFile 之原生 TypeError 被當成「派工例外」)
        if (!isPlain(o) || typeof o.prompt !== 'string' || typeof o.logFile !== 'string' || o.logFile === '') {
            return { ok: false, error: 'invalid opt: must be an object with a string prompt and a non-empty string logFile', agent: {} }
        }
        let cfg = agents[role]
        if (!cfg) {
            return { ok: false, error: `settings.agents.${role} 未設定`, agent: {} }
        }
        let chain = [cfg, ...(cfg.fallback || [])]
        let errs = []
        for (let c of chain) {
            //備援條目沿用該角色之逾時與用量門檻(條目自己有給者優先; 門檻非有限數者視同未給)
            let c2 = { ...c, timeoutMin: numOr(c.timeoutMin, 'timerMin', cfg.timeoutMin), quotaMaxPercent: numOr(c.quotaMaxPercent, 'num', cfg.quotaMaxPercent) }
            let info = c2.kind === 'claude' ? { kind: 'claude', model: c2.model, effort: c2.effort || 'xhigh' } : { kind: 'opencode', model: c2.id, variant: c2.variant || null }
            let r
            try {
                fs.mkdirSync(path.dirname(o.logFile), { recursive: true })
                fs.appendFileSync(o.logFile, `\n===== ${new Date().toISOString()} dispatch ${role} ${info.model} tag ${o.tag} =====\n`)
                let oe = { ...o, agentEnv: agentEnvOf(role) }
                r = c2.kind === 'claude' ? await runClaude(c2, oe) : await runOpencode(c2, oe)
            }
            catch (err) {
                r = { ok: false, error: `派工例外: ${String((err && err.message) || err)}` }
            }
            if (r.ok) {
                return { ...r, agent: info, tried: errs }
            }
            errs.push({ model: info.model, error: errTextOf(r.error), ...(r.quota === true ? { quota: true } : {}) })
        }
        //quota: 鏈上每一家皆因額度而未完成(任一家為其他原因之失敗者不標: 該次失敗另有成因, 照既有流程處理)
        let quota = errs.length > 0 && errs.every((e) => e.quota === true)
        return { ok: false, ...(quota ? { quota: true } : {}), error: errs.map((e) => `${e.model}: ${e.error}`).join(' | '), agent: chain[0].kind === 'claude' ? { kind: 'claude', model: chain[0].model, effort: chain[0].effort } : { kind: 'opencode', model: chain[0].id, variant: chain[0].variant }, tried: errs }
    }
}


//checkQuota, 起跑前之額度查詢(無人值守用; 規則 R-RUN-5、R-RUN-8): 各角色所用之訂閱其用量是否已達上限
//  checkQuota({ agents, skillsRoot, envFile, maxPercent = 95, probe = false, probeTimeoutMs = 60000, inject }) → { ok, why, retryAt, rows: [{ role, kind, model, windows: [{ label, percent, resetAt }], blocked, note, maxPercent, retryAt, limited }] }
//    claude  : 以 w-dispatch-ai 之 getQuotaClaude 讀本機登入態之用量(唯讀、不耗額度); 帶 scope 之視窗(某模型專屬)只在角色之 model 含該 scope 時計入
//    opencode-go: 以 opencodeGoUsage 查各金鑰; 全部金鑰皆有任一視窗達上限或被限流才算擋下(有 fallback 者只記 note, 不擋 —— 派工時會自動改用 fallback; 但 probe 為 true 時見下)
//    門檻: 各角色之 quotaMaxPercent(agents.<role>.quotaMaxPercent)優先, 未設取 maxPercent(非有限數取 95); 與派工時之用量守門同一個值; 大於 100 = 不以用量守門
//    probe: true(起跑前之守門與連跑時之每輪檢查才給): 主模型之全部金鑰皆達門檻而設有 fallback 時, 實際試一次備援 ——
//      備援為免費池之條目(provider 非 opencode-go): 以極小之提示詞、probeTimeoutMs、系統暫存夾下新建之空夾試一次; 派工套件回 errorType 'quota' 即不可用; 其他失敗(逾時、斷線)不視為不可用(守門不是另一個會卡住起跑之故障點);
//      備援為同為訂閱之條目: 與主模型共用金鑰(同一金鑰變數)且其門檻不高於主模型者(或全部金鑰皆被限流者)⇒ 不可用; 金鑰變數不同或門檻較高者無從得知用量 ⇒ 視為可用; 其他種類(如 claude)或不在條目表者: 不探測、視為可用; 備援皆不可用 ⇒ 擋下(blocked)
//      未給 probe 者維持舊行為(有 fallback 即不擋; 輪末之用量快照與一般查詢不必耗一次探測)
//    retryAt: 被擋之角色達門檻之視窗全部重置之時刻(各角色取最晚; 多把金鑰取最早可用者; 任一查不到重置時刻 ⇒ null); 重置時刻之欄名為 resetsAt(派工套件之用量查詢; 舊名 resetAt 亦收)
//  查詢本身失敗(斷線、未登入)不擋(fail-open; 記 note): 守門是為了不白跑, 不是另一個會卡住排程之故障點
//  回傳內容不含金鑰、帳號與電子郵件
/**
 * 起跑前查詢各角色所用訂閱之額度(唯讀;查詢本身失敗不擋,僅記 note)
 *
 * 回傳內容不含金鑰、帳號與電子郵件。
 * 輸入之檢測(R-EV-54;回傳 Promise 者 ⇒ reject 固定訊息、先於任何查詢或探測):opt、agents 非一般物件、skillsRoot 非非空字串(給 inject.wda 者除外)、agents 之 kind 與 fallback 不合(同 makeDispatch)、probe 給了而不是 true / false;
 * probeTimeoutMs 為計時值(§3.7):正數且不超過 2147483647,缺或無效者用預設 60000。
 * probe 為 true 時,主模型之全部金鑰皆達門檻而設有 fallback 者,會實際試一次備援(免費池之備援用盡即擋下);未給 probe 者不探測。
 *
 * @param {Object} opt 輸入設定物件
 * @param {Object} opt.agents 輸入各角色設定(同 makeDispatch;角色之 quotaMaxPercent 優先於 maxPercent)
 * @param {String} opt.skillsRoot 輸入 w-dispatch-ai 所在之技能根路徑
 * @param {String} [opt.envFile] 輸入金鑰環境檔路徑
 * @param {Number} [opt.maxPercent=95] 輸入用量上限百分比,任一視窗達此值即視為擋下,非有限數取預設,預設95
 * @param {Boolean} [opt.probe=false] 輸入是否於主模型達門檻而有 fallback 時實際探測備援,預設 false
 * @param {Number} [opt.probeTimeoutMs=60000] 輸入每次探測之逾時毫秒數,預設 60000
 * @param {Object} [opt.inject] 輸入測試用之替身:{ wda(派工套件之替身) }
 * @returns {Promise<Object>} 回傳 Promise,resolve 為 { ok, why, retryAt, rows },retryAt 為被擋之角色達門檻之視窗全部重置之時刻(查不到或未被擋為 null),rows 每列為 { role, kind, model, windows: [{ label, percent, resetAt }], blocked, note, maxPercent, retryAt, limited(主模型之全部金鑰皆達門檻時,是否有金鑰被限流) }
 * @example
 * let q = await checkQuota({ agents, skillsRoot: './skills', envFile: './.env' })
 * console.log(q.ok)
 */
let checkQuota = async (opt) => {
    //輸入之檢測(§5.1、K3、K5、§3.7; R-EV-54; 回傳 Promise 者 ⇒ reject 固定訊息, 先於任何查詢或探測): opt、agents 須為一般物件、skillsRoot 須為非空字串(給 inject.wda 者除外)、
    //  probe(是否實際派一次備援 = 耗用額度)給了須為 true / false(原: 以 `probe === true` 判 ⇒ 字串 'true'、數字 1 靜默被當成不探測, 與意圖相反); agents 之 kind 與 fallback 同 makeDispatch; maxPercent 無效者用預設(K3);
    //  probeTimeoutMs 為計時值(§3.7): 正數且不超過 2147483647, 無效者用預設 60000(原: 不驗 ⇒ NaN、負數使探測之計時器立即觸發)
    let o = objReq(opt, 'opt')
    let agents = objReq(o.agents, 'opt.agents')
    let inject = o.inject === undefined || o.inject === null ? {} : objReq(o.inject, 'opt.inject')
    let skillsRoot = inject.wda ? o.skillsRoot : strReq(o.skillsRoot, 'opt.skillsRoot')
    agentsCheck(agents)
    let probe = boolOpt(o.probe, false, 'opt.probe')
    let probeTimeoutMs = numOr(o.probeTimeoutMs, 'timerMs', 60000)
    let { envFile, maxPercent = 95 } = o
    let wda = inject.wda || createRequire(import.meta.url)(path.join(skillsRoot, 'node_modules', 'w-dispatch-ai'))
    let env = envFile && fs.existsSync(envFile) ? wda.readEnvFile(envFile) : {}
    let keysOf = (name) => String(env[name] || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    let norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    let gateMax = numOr(maxPercent, 'num', 95)
    //probeFree, 以極小之提示詞試一次免費池之條目(短逾時); 回 true = 因額度而不可用(派工套件回 errorType 'quota'), 其他結果(成功、逾時、斷線、例外)皆 false
    //  工作路徑取系統暫存夾下新建之空夾(用畢即刪): 不載入專案之指引檔; 不直接用系統暫存夾 —— 其內檔案眾多, CLI 啟動時會掃描而變慢
    let probeFree = async (entry, c) => {
        let dir = null
        let r = null
        try {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arsi-probe-'))
            r = await wda.dispatchOpencode(PROBE_PROMPT, { model: entry.model, extraArgs: c.variant ? ['--variant', c.variant] : (entry.extraArgs || []), useStoredAuth: false, cwd: dir, timeoutMs: probeTimeoutMs })
        }
        catch (err) {}
        try {
            if (dir) {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        }
        catch (err) {}
        return isQuotaFail(r)
    }
    let rows = []
    for (let role of Object.keys(agents || {})) {
        let cfg = agents[role]
        if (!cfg || typeof cfg !== 'object') {
            continue
        }
        //mx: 該角色之門檻(agents.<role>.quotaMaxPercent; 未設則取 maxPercent)—— 與派工時之用量守門同一個值
        let mx = numOr(cfg.quotaMaxPercent, 'num', gateMax)
        let row = { role, kind: cfg.kind, model: cfg.kind === 'claude' ? cfg.model : cfg.id, windows: [], blocked: false, note: null, maxPercent: mx, retryAt: null, limited: false }
        try {
            if (cfg.kind === 'claude') {
                let q = await wda.getQuotaClaude()
                if (!q || q.ok !== true || !Array.isArray(q.windows)) {
                    row.note = '用量查詢失敗(不擋)'
                }
                else {
                    for (let w of q.windows) {
                        if (w.scope && !norm(cfg.model).includes(norm(w.scope))) {
                            continue
                        }
                        row.windows.push({ label: w.label, percent: w.usedPercent, resetAt: w.resetAt || null })
                    }
                    row.blocked = row.windows.some((w) => typeof w.percent === 'number' && w.percent >= mx)
                    if (row.blocked) {
                        row.retryAt = retryOf(row.windows, mx)
                    }
                }
            }
            else if (cfg.kind === 'opencode') {
                let entry = wda.providers.find((p) => p.id === cfg.id)
                if (entry && entry.provider === 'opencode-go') {
                    let keys = keysOf(entry.envVar || 'OPENCODE_GO_KEYS')
                    let hotAll = keys.length > 0
                    let keyRetries = []
                    let keyLimited = []
                    for (let k of keys) {
                        let u = await wda.opencodeGoUsage({ key: k })
                        //重置時刻之欄名為 resetsAt(派工套件之用量查詢; 舊名 resetAt 亦收)
                        let ws = u && u.ok && u.usage ? Object.entries(u.usage).map(([label, w]) => ({ label, percent: w && typeof w.percent === 'number' ? w.percent : null, resetAt: (w && (w.resetsAt || w.resetAt)) || null })) : []
                        let lim = !!(u && u.limited === true)
                        let overMx = ws.some((w) => typeof w.percent === 'number' && w.percent >= mx)
                        let hot = overMx || lim
                        keyLimited.push(lim)
                        if (!hot) {
                            hotAll = false
                        }
                        else {
                            //此把金鑰可用之時刻: 達門檻之視窗全部重置, 且(被限流者)限流解除(派工套件之 nextResetAt); 任一查不到 ⇒ null
                            let parts = []
                            if (overMx) {
                                parts.push(retryOf(ws, mx))
                            }
                            if (lim) {
                                parts.push(typeof u.nextResetAt === 'string' ? u.nextResetAt : null)
                            }
                            keyRetries.push(pickAt(parts, true))
                        }
                        if (row.windows.length === 0 || !hot) {
                            row.windows = ws
                        }
                    }
                    if (keys.length === 0) {
                        row.note = '未提供金鑰'
                    }
                    else if (hotAll) {
                        row.limited = keyLimited.some(Boolean)
                        if (Array.isArray(cfg.fallback) && cfg.fallback.length) {
                            //備援是否可用(probe 為 true 時才實際探測): 免費池之條目以 probeFree 試一次, 因額度而不可用者略過;
                            //  同為 opencode-go 之條目: 與主模型共用金鑰(同一金鑰變數)且其門檻不高於主模型者(或全部金鑰皆被限流者)⇒ 用量同樣達門檻而不可用;
                            //    金鑰變數不同、或門檻較高者無從得知其用量 ⇒ 視為可用(派工時照其自己之門檻判定; 因額度而未完成者結果回 quota);
                            //  其他種類(如 claude)或不在條目表者不探測、視為可用
                            let avail = probe !== true
                            let why = []
                            for (let c of (probe === true ? cfg.fallback : [])) {
                                let e2 = c && c.kind === 'opencode' ? wda.providers.find((p) => p.id === c.id) : null
                                if (!e2) {
                                    avail = true
                                    break
                                }
                                if (e2.provider === 'opencode-go') {
                                    let sameKeys = (e2.envVar || 'OPENCODE_GO_KEYS') === (entry.envVar || 'OPENCODE_GO_KEYS')
                                    let mx2 = numOr(c.quotaMaxPercent, 'num', mx)
                                    if (sameKeys && (mx2 <= mx || keyLimited.every(Boolean))) {
                                        why.push('同為訂閱之條目, 共用已達門檻之用量')
                                        continue
                                    }
                                    avail = true
                                    break
                                }
                                if (await probeFree(e2, c)) {
                                    why.push('免費池之用量已用盡')
                                    continue
                                }
                                avail = true
                                break
                            }
                            if (avail) {
                                row.note = '用量已達起跑門檻; 派工時改用 fallback(不擋)'
                            }
                            else {
                                row.blocked = true
                                row.note = `備援亦因額度而不可用: ${why.join('、')}`
                            }
                        }
                        else {
                            row.blocked = true
                        }
                        //多把金鑰皆達門檻: 任一把重置即可用 ⇒ 取最早; 任一把查不到 ⇒ null
                        if (row.blocked) {
                            row.retryAt = pickAt(keyRetries, false)
                        }
                    }
                }
            }
        }
        catch (err) {
            row.note = `用量查詢失敗(不擋): ${String((err && err.message) || err).slice(0, 120)}`
        }
        rows.push(row)
    }
    let bad = rows.filter((r) => r.blocked)
    //retryAt: 全部被擋之角色皆可用之時刻(各角色之最晚者); 任一角色查不到 ⇒ null —— 無人值守之排程與主控據以決定何時再試
    let retryAt = bad.length ? pickAt(bad.map((r) => r.retryAt), true) : null
    let hotOf = (r) => r.windows.filter((w) => typeof w.percent === 'number' && w.percent >= r.maxPercent)
    let why = bad.length ? `${bad.map((r) => `${r.role}(${r.model})之用量 ${hotOf(r).map((w) => `${w.label} ${w.percent}%`).join('、') || (r.limited ? '被限流' : '')} ≥ ${r.maxPercent}%${r.note ? `(${r.note})` : ''}`).join(';')}${retryAt ? `;達門檻之視窗於 ${retryAt} 全部重置` : ''}` : null
    return { ok: bad.length === 0, why, retryAt, rows }
}


export { makeDispatch, checkQuota }
export default makeDispatch
