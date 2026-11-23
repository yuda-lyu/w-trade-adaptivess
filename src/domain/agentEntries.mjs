import { agentRoleOf, AGENT_ROLE_ENV } from '../arsi/agentRole.mjs'


//agent 不得執行之進入檔與模式(規則 R-RUN-11): 進入檔之拒跑(各命令列與工具之開頭呼叫 guardEntry)與操作掃描(verify.mjs 之「執行迴圈之寫檔入口」)共用本表 —— 兩處之判定一致
//  寫檔或起行程者(writes 為真)於 ARSI_AGENT_ROLE = node / dream 時拒跑: 印一行理由(不帶輸入值)、離開碼 2、不做任何寫入(於讀設定與組裝專案之前判定)
//  唯讀者照常(行為逐位不變); 任務書要 agent 執行者(g_eval.mjs、g_toolbox.mjs)不在表內, 一律不擋
//  args = 進入檔之後之命令列引數(同 process.argv.slice(2)); 判定與各入口之實際解析一致(g_rsi.mjs 之 --mode 同 cfg.mjs 之 argOf: 未給為 status; 以 --mode=… 書寫者本判定仍視為 status〔唯讀〕, 但進入檔本身已於其後一律拒收帶等號之旗標〔離開碼 2、不執行任何模式; R-EV-49〕)
let has = (args, k) => args.includes(k)
//valOf, `--k v` 之 v(同 argOf: 其後無字或以 -- 起首 ⇒ true; 未給 ⇒ null)
let valOf = (args, k) => {
    let i = args.indexOf(k)
    if (i < 0) {
        return null
    }
    let v = args[i + 1]
    return v === undefined || String(v).startsWith('--') ? true : String(v)
}
//setArg, `--k v` 之 v 於 g_rsi.mjs 是否算「給了值」(同其 `cl && cl !== true`: 只有旗標、空字串、數字樣而值為 0 者皆否)
let setArg = (v) => typeof v === 'string' && v !== '' && !(/^-?\d+(\.\d+)?$/.test(v) && Number(v) === 0)
//rsiWrites, g_rsi.mjs 之各模式: 唯讀 = status(預設)、dry、frontier(未給 --close / --rearm 之值)、fill --dry; 其餘(init、board、round、validate、reverify、extfill、fill、
//  frontier --close / --rearm(--rearm 缺 --to / --why 者照現行只印用法, 亦拒 —— 從嚴)、annotate、dirtype、未知之模式〔照現行印用法前會組裝專案〕)= 寫檔
let RSI_READ = ['status', 'dry']
let rsiWrites = (args) => {
    let m = valOf(args, '--mode')
    let mode = m === null ? 'status' : m
    if (RSI_READ.includes(mode)) {
        return false
    }
    if (mode === 'frontier') {
        return setArg(valOf(args, '--close')) || setArg(valOf(args, '--rearm'))
    }
    if (mode === 'fill') {
        return !has(args, '--dry')
    }
    return true
}
//ENTRY_RULES, 名稱 → { label(拒跑訊息所用; 不含輸入值), writes(args) → 布林, hindsight?(true = 主控專用之唯讀工具: 輸出含事後資訊, agent 亦拒跑, 理由另為一句) }
//  命令列: rsi(g_rsi.mjs)、launch(g_launch.mjs; 起脫離之子行程)、build(g_build.mjs; 寫帳本)、backtest(g_backtest.mjs; 迴圈專用);
//  工具(tools/<名>.mjs; initProject 為 src/tools/initProject.mjs 之直接執行): 寫狀態根或專案之檔、派工或起迴圈專用之評估者; 只列出內容者(無引數、未給寫出之旗標、initProject --dry)照常
let always = () => true
let ENTRY_RULES = {
    rsi: { label: 'g_rsi.mjs 之此模式', writes: rsiWrites },
    launch: { label: 'g_launch.mjs', writes: always },
    build: { label: 'g_build.mjs', writes: always },
    backtest: { label: 'g_backtest.mjs', writes: always },
    archiveDocs: { label: 'tools/archiveDocs.mjs', writes: always },
    buildCatalog: { label: 'tools/buildCatalog.mjs', writes: always },
    pickStore: { label: 'tools/pickStore.mjs', writes: always },
    searchMap: { label: 'tools/searchMap.mjs', writes: always },
    smokeDispatch: { label: 'tools/smokeDispatch.mjs', writes: always },
    fakeRound: { label: 'tools/fakeRound.mjs', writes: always },
    replayCheck: { label: 'tools/replayCheck.mjs', writes: always },
    initProject: { label: 'initProject.mjs', writes: (args) => !has(args, '--dry') },
    armDecide: { label: 'tools/armDecide.mjs 之審定', writes: (args) => args.length > 0 },
    armInactive: { label: 'tools/armInactive.mjs 之補記', writes: (args) => args.length > 0 },
    exposure: { label: 'tools/exposure.mjs 之放行', writes: (args) => args.length > 0 },
    formSet: { label: 'tools/formSet.mjs 之補記', writes: (args) => args.length > 0 },
    briefPreview: { label: 'tools/briefPreview.mjs --out', writes: (args) => has(args, '--out') },
    quota: { label: 'tools/quota.mjs --probe', writes: (args) => has(args, '--probe') },
    roundDigest: { label: 'tools/roundDigest.mjs --out', writes: (args) => has(args, '--out') },
    //主控專用之唯讀工具(hindsight: 輸出含評估期內全庫之統計 = 事後資訊; 規則 R-EV-48): 不寫檔, 但 agent 一律拒跑, 理由另為一句
    libCheck: { label: 'tools/libCheck.mjs', writes: always, hindsight: true },
}

/**
 * 進入檔(命令列名或工具名)以 args 執行時是否寫專案之檔或起行程,或為主控專用之工具(agent 不得執行者);不在表內之名稱(g_eval.mjs、g_toolbox.mjs、唯讀之工具)回 false
 *
 * @param {String} name 輸入進入檔之名稱(rsi、launch、build、backtest 或工具名,如 pickStore)
 * @param {Array<String>} [args=[]] 輸入進入檔之後之命令列引數
 * @returns {Boolean} 回傳是否為寫檔或起行程之進入檔與模式
 * @example
 * let w = entryWrites('rsi', ['--mode', 'validate'])
 * // => true
 */
let entryWrites = (name, args = []) => {
    let r = Object.prototype.hasOwnProperty.call(ENTRY_RULES, name) ? ENTRY_RULES[name] : null
    return !!r && r.writes(Array.isArray(args) ? args.map(String) : []) === true
}

/**
 * 進入檔之開頭呼叫:agent(ARSI_AGENT_ROLE 為 node / dream)執行寫檔或起行程之進入檔與模式 ⇒ 印一行理由(不帶輸入值)並以離開碼 2 結束;其餘回 false(照常執行)
 *
 * @param {String} name 輸入進入檔之名稱(見 entryWrites)
 * @param {Array<String>} [args=process.argv.slice(2)] 輸入命令列引數
 * @param {Object} [opt={}] 輸入設定物件
 * @param {Object} [opt.env=process.env] 輸入環境變數物件
 * @param {Function} [opt.log=console.log] 輸入印出理由之函數
 * @param {Function} [opt.exit] 輸入結束行程之函數,預設 process.exit
 * @returns {Boolean} 回傳是否拒跑(拒跑者於 opt.exit 結束行程)
 * @example
 * guardEntry('build')
 */
let guardEntry = (name, args = process.argv.slice(2), { env = process.env, log = console.log, exit = (c) => process.exit(c) } = {}) => {
    let role = agentRoleOf(env)
    if (!role || !entryWrites(name, args)) {
        return false
    }
    //主控專用之唯讀工具(hindsight)另一句理由: 不寫檔, 拒跑之因是其輸出含事後資訊
    let msg = ENTRY_RULES[name].hindsight === true
        ? `拒跑: ${ENTRY_RULES[name].label} 之輸出含評估期內全庫之統計(事後資訊), 只供主控使用, 不得由 agent 執行(${AGENT_ROLE_ENV}=${role}; 評估用 g_eval.mjs, 共用工具區之自檢用 g_toolbox.mjs)`
        : `拒跑: ${ENTRY_RULES[name].label} 會寫入專案之檔或起行程, 不得由 agent 執行(${AGENT_ROLE_ENV}=${role}; 評估用 g_eval.mjs, 共用工具區之自檢用 g_toolbox.mjs)`
    log(msg)
    exit(2)
    return true
}

export { ENTRY_RULES, entryWrites, guardEntry }
