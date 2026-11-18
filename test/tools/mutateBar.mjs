/* eslint-disable quotes, no-template-curly-in-string -- 本檔之字串多為「原始碼之片段」(含單引號與 ${…}), 以雙引號書寫以免逐一跳脫 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { FD_ROOT, FD_TMP } from './synthLedger.mjs'


//變異檢查(規則 R-EV-44、R-REC-36、R-REC-34 之守門之鑑別力; Gitea #184): 於 test/_tmp/ 之複本逐一植入一處變異(把新檢測或新接線改回舊行為, 或改成錯的寫法), 跑守門之測試, 須轉紅(被殺)
//  用法(測試以 quiet-run --lock 執行): node test/tools/mutateBar.mjs [--list] [--check] [--only <id,id…>] [--from <序> --to <序>] [--out <結果.json>]
//    --check 只核對各變異之錨點(須恰出現一次; all 者至少一次), 不跑測試;未被殺者(survived)為測試之缺口 —— 補測試,不是補斷言(見 sgud/exp 之變異作法)
//  複本不含 node_modules(由上層 node_modules 解析); 每個變異跑完還原; 結束刪複本
let GUARDS = ['unit-evalNums', 'unit-factsResidue', 'unit-evalFingerprint', 'unit-barHours']

//M, [編號, 檔(相對套件根), 變異之編輯 [[找, 換, 全部?]…], 優先跑之測試(其餘於其後)]
let M = [
    //── barGrid.mjs ──
    ['B01', 'src/eval/barGrid.mjs', [['Math.abs(m - mi) < 1e-9 && 1440 % mi === 0', 'Math.abs(m - mi) < 1e-9']], ['unit-barHours']],
    ['B02', 'src/eval/barGrid.mjs', [['(ms - time0Ms) % barMs === 0', '(ms - time0Ms) % 86400000 === 0']], ['unit-barHours']],
    ['B03', 'src/eval/barGrid.mjs', [['    if (v !== true) {', '    if (false) {']], ['unit-barHours']],
    ['B04', 'src/eval/barGrid.mjs', [['    if (!(f <= trainEndBar)) {', '    if (false) {']], ['unit-barHours']],
    ['B05', 'src/eval/barGrid.mjs', [['throw new Error(`invalid ${where}: must be a time on the bar grid of the ledger`)', 'return']], ['unit-evalNums']],
    ['B06', 'src/eval/barGrid.mjs', [["    gridCheck(tr.end, meta, 'periods.train.end')", '    void 0']], ['unit-evalNums']],
    ['B07', 'src/eval/barGrid.mjs', [["    gridCheck(periodAt(st, 'backtest', 'start'), meta, 'periods.backtest.start')", '    void 0']], ['unit-evalNums']],
    ['B08', 'src/eval/barGrid.mjs', [['        if (fe[side] && !onBarGrid(fe[side], time0Ms, barMs)) {', '        if (false) {']], ['unit-barHours']],
    ['B09', 'src/eval/barGrid.mjs', [['    trainFromBarOf(st, meta, Math.round((Date.parse(`${tr.end}Z`) - time0Ms) / barMs))', '    void 0']], ['unit-barHours']],
    ['B10', 'src/eval/barGrid.mjs', [["    evalNumsOf(st && st.eval, Math.round(24 / meta.barHours), 'eval')", '    void 0']], ['unit-evalNums']],
    ['B11', 'src/eval/barGrid.mjs', [['        if (!Number.isInteger(out[k] * bpd)) {', '        if (false) {']], ['unit-evalNums']],
    ['B12', 'src/eval/barGrid.mjs', [['Number.isInteger(out[k] * bpd)', 'Number.isInteger(out[k])']], ['unit-evalNums']],
    ['B13', 'src/eval/barGrid.mjs', [[".replace(/^invalid cfg\\./, 'invalid eval.')", ".replace(/^invalid cfg\\./, 'invalid cfg.')"]], ['unit-evalNums']],
    ['B14', 'src/eval/barGrid.mjs', [['|opt\\.nullDraws|--null)', '|opt\\.nullDraws)']], ['unit-evalNums']],
    ['B15', 'src/eval/barGrid.mjs', [['let periodAt = (st, seg, end) => objOf(periodsOf(st)[seg])[end]', 'let periodAt = (st, seg, end) => periodsOf(st)[seg][end]']], ['unit-evalNums']],
    ['B16', 'src/eval/barGrid.mjs', [['    let tr = objOf(periodsOf(st).train)', '    let tr = periodsOf(st).train']], ['unit-evalNums']],
    //── cfgNum.mjs ──
    ['C01', 'src/eval/cfgNum.mjs', [['Number.isFinite(x) && k[1](x)', 'Number.isFinite(x)']], ['unit-evalNums']],
    ['C02', 'src/eval/cfgNum.mjs', [['    if (v === undefined || v === null) {', '    if (v === undefined) {']], ['unit-evalNums']],
    ['C03', 'src/eval/cfgNum.mjs', [["(typeof v === 'string' && isenum(v) ? Number(v) : NaN)\n    if (!(Number.isFinite(x) && k[1](x)))", "(typeof v === 'string' && isenum(v) ? v : NaN)\n    if (!(Number.isFinite(x) && k[1](x)))"]], ['unit-evalNums']],
    ['C04', 'src/eval/cfgNum.mjs', [["let x = typeof v === 'number' ? v : (typeof v === 'string' && isenum(v) ? Number(v) : NaN)\n    if (!(Number.isFinite(x) && k[1](x)))", "let x = typeof v === 'number' || typeof v === 'boolean' ? Number(v) : (typeof v === 'string' && isenum(v) ? Number(v) : NaN)\n    if (!(Number.isFinite(x) && k[1](x)))"]], ['unit-evalNums']],
    ['C05', 'src/eval/cfgNum.mjs', [["nullDraws: [64, 'nonNegInt']", "nullDraws: [32, 'nonNegInt']"]], ['unit-evalNums']],
    ['C06', 'src/eval/cfgNum.mjs', [["actBins: [10, 'binCount']", "actBins: [10, 'posInt']"]], ['unit-evalNums']],
    ['C12', 'src/eval/cfgNum.mjs', [['Number.isSafeInteger(x) && x >= 1 && x <= 256', 'Number.isSafeInteger(x) && x >= 1 && x <= 257']], ['unit-evalNums']],
    ['C13', 'src/eval/cfgNum.mjs', [['Number.isSafeInteger(x) && x >= 1 && x <= 256', 'Number.isSafeInteger(x) && x >= 1 && x < 256']], ['unit-evalNums']],
    ['B17', 'src/eval/barGrid.mjs', [["    for (let [seg, end] of [['train', 'start'], ['backtest', 'end']]) {", "    for (let [seg, end] of [['train', 'start']]) {"]], ['unit-evalNums']],
    ['B18', 'src/eval/barGrid.mjs', [["if (!(typeof v === 'string' && Number.isFinite(Date.parse(`${v}Z`)))) {", "if (!(typeof v === 'string')) {"]], ['unit-evalNums']],
    ['C07', 'src/eval/cfgNum.mjs', [["sideActHalf: [50, 'nonNegInt']", "sideActHalf: [50, 'nonNegNum']"]], ['unit-evalNums']],
    ['C08', 'src/eval/cfgNum.mjs', [["cadenceDays: [7, 'posNum']", "cadenceDays: [7, 'nonNegNum']"]], ['unit-evalNums']],
    ['C09', 'src/eval/cfgNum.mjs', [["warmupDays: [180, 'nonNegNum']", "warmupDays: [180, 'posNum']"]], ['unit-evalNums']],
    ['C10', 'src/eval/cfgNum.mjs', [["(typeof v === 'string' && isenum(v) ? Number(v) : NaN)\n    if (!(Number.isFinite(x) && k[1](x)))", "(typeof v === 'string' ? Number(v) : NaN)\n    if (!(Number.isFinite(x) && k[1](x)))"]], ['unit-evalNums']],
    ['C11', 'src/eval/cfgNum.mjs', [["        out[k] = cfgNumOf(e[k], def, `${who}.${k}`, kind)", '        out[k] = cfgNumOf(e[k], def, `eval.${k}`, kind)']], ['unit-evalNums']],
    //── evalCore.mjs ──
    ['E01', 'src/eval/evalCore.mjs', [["let cfgNums = evalNumsOf(cfg, bpd, 'cfg')", "let cfgNums = evalNumsOf(cfg, 1, 'cfg')"]], ['unit-evalNums']],
    ['E02', 'src/eval/evalCore.mjs', [["let nullDraws = cfgNumOf(opt.nullDraws, cfgNums.nullDraws, 'opt.nullDraws', 'nonNegInt')", 'let nullDraws = opt.nullDraws === undefined || opt.nullDraws === null ? cfgNums.nullDraws : opt.nullDraws']], ['unit-evalNums']],
    ['E03', 'src/eval/evalCore.mjs', [['let nBins = cfgNums.actBins', 'let nBins = 10']], ['unit-barHours']],
    ['E04', 'src/eval/evalCore.mjs', [['let half = cfgNums.sideActHalf', 'let half = 50']], ['unit-barHours']],
    ['E05', 'src/eval/evalCore.mjs', [['let halfSA = cfgNums.sideActHalf', 'let halfSA = 50']], ['unit-barHours']],
    ['E06', 'src/eval/evalCore.mjs', [['let warmupDays = cfgNums.warmupDays', 'let warmupDays = cfg.warmupDays === undefined ? 180 : cfg.warmupDays']], ['unit-barHours']],
    ['E07', 'src/eval/evalCore.mjs', [['let cadenceDays = cfgNums.cadenceDays', 'let cadenceDays = cfg.cadenceDays === undefined ? 7 : cfg.cadenceDays']], ['unit-barHours']],
    ['E08', 'src/eval/evalCore.mjs', [['            if (fe[side] && !onBarGrid(fe[side], time0Ms, barMs)) {', '            if (false) {']], ['unit-barHours']],
    ['E09', 'src/eval/evalCore.mjs', [['(f > 0 ? lowerBound(L.ent, L.off[s], L.off[s + 1], f) : L.off[s])', 'L.off[s]']], ['unit-barHours']],
    ['E10', 'src/eval/evalCore.mjs', [['        if (!(f >= 0 && f <= b)) {', '        if (false) {']], ['unit-barHours']],
    //── cli/eval.mjs ──
    ['V01', 'src/cli/eval.mjs', [[': { phases: [0, 3], horizons: [evNums.cadenceDays], nullDraws: 0 }', ': { phases: [0, 3], horizons: [st.eval.cadenceDays], nullDraws: 0 }']], ['unit-evalNums']],
    //V02 為等價變異(第 5 欄 'equiv'): 完整評估之 opt.nullDraws 取設定之原值時, evalPolicy 自身亦以 cfgNumOf 檢測並轉型 ⇒ 結果相同; 保留此項以記錄「兩層各自檢測」之設計
    ['V02', 'src/cli/eval.mjs', [['horizons: st.eval.horizons, nullDraws: evNums.nullDraws }', 'horizons: st.eval.horizons, nullDraws: st.eval.nullDraws }']], ['unit-evalNums'], 'equiv'],
    ['V03', 'src/cli/eval.mjs', [["if (nullArg !== null && !(typeof nullArg === 'number' && Number.isSafeInteger(nullArg) && nullArg >= 0)) {", 'if (false) {']], ['unit-evalNums']],
    ['V04', 'src/cli/eval.mjs', [['if (nullArg !== null) {', "if (typeof nullArg === 'number' && false) {"]], ['unit-evalNums']],
    ['V05', 'src/cli/eval.mjs', [["writeJson(path.resolve(fpOut), { ok: false, ...memberInfo(), error: msg, code: 'CONFIG_INVALID' })", 'void 0']], ['unit-evalNums']],
    ['V06', 'src/cli/eval.mjs', [['    checkEvalSettings(st, L.meta)', '    void 0']], ['unit-evalNums']],
    ['V07', 'src/cli/eval.mjs', [["    gridCheck(evalFrom, L.meta, harnessEnv && process.env.ARSI_EVAL_FROM ? 'ARSI_EVAL_FROM' : 'periods.backtest.start')", '    void 0']], ['unit-barHours']],
    ['V08', 'src/cli/eval.mjs', [["process.env.ARSI_EVAL_FROM : periodAt(st, 'backtest', 'start')", 'process.env.ARSI_EVAL_FROM : st.periods.backtest.start']], ['unit-evalNums']],
    ['V09', 'src/cli/eval.mjs', [['    trainFrom = trainFromBarOf(st, L.meta, trainEndBar)', '    trainFrom = null']], ['unit-barHours']],
    ['V10', 'src/cli/eval.mjs', [["if (periodArg === 'train' && trainFrom !== null) {", 'if (false) {']], ['unit-barHours']],
    ['V11', 'src/cli/eval.mjs', [["(mode === 'full' ? cfgNumOf(st.eval && st.eval.nullDraws, 64, 'eval.nullDraws', 'nonNegInt') : 0)", "(mode === 'full' ? (st.eval.nullDraws === undefined ? 64 : st.eval.nullDraws) : 0)"]], ['unit-evalNums']],
    ['V12', 'src/cli/eval.mjs', [['    let msg = configMsgOf(err)', '    let msg = null']], ['unit-evalNums']],
    //V13 為等價變異: --ext-test 之試跑不寫結果檔且 api 不暴露地平線(只印 EXT_OK 與診斷之 text), 地平線之型別觀察不到
    ['V13', 'src/cli/eval.mjs', [['opt = { phases: [0, 3], horizons: [evNums.cadenceDays], nullDraws: 8 }', 'opt = { phases: [0, 3], horizons: [st.eval.cadenceDays], nullDraws: 8 }']], ['unit-evalCli'], 'equiv'],
    //── cli/backtest.mjs ──
    ['K01', 'src/cli/backtest.mjs', [['    checkEvalSettings(st, L.meta)', '    void 0']], ['unit-evalNums']],
    ['K02', 'src/cli/backtest.mjs', [["let trainEndBar = barOf(periodAt(st, 'train', 'end'))", 'let trainEndBar = barOf(st.periods.train.end)']], ['unit-evalNums']],
    ['K03', 'src/cli/backtest.mjs', [["        gridCheck(periodAt(st, 'train', 'end'), Le.meta, 'periods.train.end')", '        void 0']], ['unit-barHours']],
    ['K04', 'src/cli/backtest.mjs', [['        fromE = trainFromBarOf(st, Le.meta, trainEndE)', '        fromE = trainFromBarOf(st, L.meta, trainEndE)']], ['unit-barHours']],
    ['K05', 'src/cli/backtest.mjs', [['        fromL = trainFromBarOf(st, L.meta, trainEndBar)', '        fromL = null']], ['unit-barHours']],
    ['K06', 'src/cli/backtest.mjs', [["            gridCheck(periodAt(st, 'backtest', 'end'), L.meta, 'periods.backtest.end')", '            void 0']], ['unit-barHours']],
    //K07 為等價變異(縱深防禦): makeEvaluator 對同一帳本 L 之設定檢查已由上方之預檢 checkEvalSettings(st, L.meta) 涵蓋; 預檢略過者(L.meta 之 time0 或 barHours 無效)於其後之離開碼 5 路徑先結束 ⇒ 此 catch 於正常路徑不可達
    ['K07', 'src/cli/backtest.mjs', [["    let msg = configMsgOf(err)\n    if (msg !== null) {\n        console.log(`ERROR ${msg}`)\n        process.exit(2)\n    }\n    throw err", '    throw err']], ['unit-barHours'], 'equiv'],
    ['K08', 'src/cli/backtest.mjs', [["    let trainEndE = Math.round((Date.parse(`${periodAt(st, 'train', 'end')}Z`)", "    let trainEndE = Math.round((Date.parse(`${st.periods.train.end}Z`)"]], ['unit-evalNums']],
    //── domain.mjs ──
    ['D01', 'src/domain/domain.mjs', [['    checkEvalSettings(st, ledgerMeta)', '    void 0']], ['unit-barHours']],
    ['D02', 'src/domain/domain.mjs', [['        let msg = configMsgOf(err)', '        let msg = null']], ['unit-barHours']],
    ['D03', 'src/domain/domain.mjs', [['${nullDrawsOf(st.eval)} 抽之下限為 ${nullFloorText(nullDrawsOf(st.eval))}。', '64 抽之下限為 0.0154。']], ['unit-barHours']],
    ['D04', 'src/domain/domain.mjs', [['let sfBase = sideFlowCfgOf(st.score && st.score.sideFlow).baseShort', 'let sfBase = { train: 0.22, backtest: 0.16 }']], ['unit-barHours']],
    //── texts.mjs ──
    ['T01', 'src/domain/texts.mjs', [["let ph = (tail) => phaseText(phaseCountOf(ev0), tail)", "let ph = (tail) => phaseText(7, tail)"]], ['unit-factsResidue']],
    ['T02', 'src/domain/texts.mjs', [['let nDraws = nullDrawsOf(ev0)', 'let nDraws = 64']], ['unit-factsResidue']],
    ['T03', 'src/domain/texts.mjs', [["或其 p > ' + sc.ladder1.nullP + ' 者", '或其 p > 0.05 者']], ['unit-factsResidue']],
    ['T04', 'src/domain/texts.mjs', [["單抽即可能過 p ≤ ' + sc.ladder1.nullP + '。')", "單抽即可能過 p ≤ 0.05。')"]], ['unit-factsResidue']],
    ['T05', 'src/domain/texts.mjs', [['let cadDays = cadenceOf(ev0)', 'let cadDays = 7']], ['unit-factsResidue']],
    ['T06', 'src/domain/texts.mjs', [['let btLenText = periodLenText(st.periods.backtest.start, st.periods.backtest.end)', "let btLenText = '約 10 個月'"]], ['unit-factsResidue']],
    ['T07', 'src/domain/texts.mjs', [["let hzText = horizonsOf(ev0).join(' / ')", "let hzText = '1 / 3 / 7 / 14 / 30'"]], ['unit-factsResidue']],
    ['T08', 'src/domain/texts.mjs', [['let libText = () => libSizeText(nStrategiesOf(nStrategies, st))', "let libText = () => '約 7 萬隻'"]], ['unit-factsResidue']],
    ['T09', 'src/domain/texts.mjs', [["let pfRef = hasStore() ? ", "let pfRef = !hasStore() ? "]], ['unit-dreamOnly']],
    ['T10', 'src/domain/texts.mjs', [["let fe = ev0.fitEnd && typeof ev0.fitEnd === 'object' ? ev0.fitEnd : {}", "let fe = { long: '2025-04-08', short: '2025-10-06' }"]], ['unit-factsResidue']],
    ['T11', 'src/domain/texts.mjs', [["等效年化之${ph('相位')}平均 + 0.3 × 最差相位(**回測期** ${pBt};以最大同時持倉正規化)", '等效年化之七相位平均 + 0.3 × 最差相位(**回測期** ${pBt};以最大同時持倉正規化)']], ['unit-factsResidue']],
    ['T12', 'src/domain/texts.mjs', [["等效年化之${ph('相位')}平均 + 0.3 × 最差相位(**回測期** ${pBt})。**你的目標", '等效年化之七相位平均 + 0.3 × 最差相位(**回測期** ${pBt})。**你的目標']], ['unit-factsResidue']],
    ['T13', 'src/domain/texts.mjs', [["日新鮮度之${ph('相位')}平均皆", '日新鮮度之七相位平均皆']], ['unit-factsResidue']],
    ['T14', 'src/domain/texts.mjs', [["鄰近之參數、${ph('個相位')}都同向", '鄰近之參數、七個相位都同向']], ['unit-factsResidue']],
    ['T15', 'src/domain/texts.mjs', [["${ph('個相位')}同向比平均高更重要", '七個相位同向比平均高更重要']], ['unit-factsResidue']],
    ['T16', 'src/domain/texts.mjs', [["完整評估(回測期;${ph('相位')} + 虛無", '完整評估(回測期;七相位 + 虛無']], ['unit-factsResidue']],
    ['T17', 'src/domain/texts.mjs', [["鄰近之參數同向、' + ph('個相位') + '同向、對照", "鄰近之參數同向、七個相位同向、對照"]], ['unit-factsResidue']],
    ['T18', 'src/domain/texts.mjs', [["**評估期 = 回測期 ${pBt}**;${ph('相位')};挑選函數", '**評估期 = 回測期 ${pBt}**;七相位;挑選函數']], ['unit-factsResidue']],
    ['T19', 'src/domain/texts.mjs', [["' + ph('個相位') + '是否同向(節點文件", '七個相位是否同向(節點文件']], ['unit-factsResidue']],
    ['T20', 'src/domain/texts.mjs', [["例:鄰點之' + ph('相位') + '平均", '例:鄰點之七相位平均']], ['unit-factsResidue']],
    ['T21', 'src/domain/texts.mjs', [["回測期 S、' + ph('相位') + '、挑選內容", '回測期 S、七相位、挑選內容']], ['unit-factsResidue']],
    ['T22', 'src/domain/texts.mjs', [["幾何對照(' + nDraws + ' 抽)為準", '幾何對照(64 抽)為準']], ['unit-factsResidue']],
    //── factsText.mjs ──
    ['F01', 'src/domain/factsText.mjs', [["n >= 1 && n <= 10 ? '一二三四五六七八九十'[n - 1]", "n >= 1 && n <= 7 ? '一二三四五六七八九十'[n - 1]"]], ['unit-factsResidue']],
    ['F02', 'src/domain/factsText.mjs', [['(1 / (1 + draws))', '(1 / draws)']], ['unit-factsResidue']],
    ['F03', 'src/domain/factsText.mjs', [['ev.phases.length > 0 ? ev.phases.length : 7', 'ev.phases.length > 0 ? 7 : 7']], ['unit-factsResidue']],
    //F04、F05 單獨為等價變異(互相遮蔽): cadenceOf 與 nullDrawsOf 皆經 evalCfgNumsOf 檢測「全部五個鍵」, 任務書同時呼叫兩者, 改壞其一時另一個仍拋; F06 為兩者同時改壞
    ['F04', 'src/domain/factsText.mjs', [["let cadenceOf = (ev) => evalCfgNumsOf(ev, 'eval').cadenceDays", 'let cadenceOf = (ev) => (ev && Number(ev.cadenceDays)) || 7']], ['unit-factsResidue'], 'equiv'],
    ['F05', 'src/domain/factsText.mjs', [["let nullDrawsOf = (ev) => evalCfgNumsOf(ev, 'eval').nullDraws", 'let nullDrawsOf = (ev) => (ev && Number(ev.nullDraws)) || 64']], ['unit-factsResidue'], 'equiv'],
    ['F07', 'src/domain/factsText.mjs', [["let cadenceOf = (ev) => evalCfgNumsOf(ev, 'eval').cadenceDays", 'let cadenceOf = (ev) => (ev && Number(ev.cadenceDays)) || 7'], ["let nullDrawsOf = (ev) => evalCfgNumsOf(ev, 'eval').nullDraws", 'let nullDrawsOf = (ev) => (ev && Number(ev.nullDraws)) || 64']], ['unit-factsResidue']],
    ['F06', 'src/domain/factsText.mjs', [['`${n} `) + tail', '`${n}`) + tail']], ['unit-factsResidue']],
    //── initProject.mjs ──
    ['I01', 'src/tools/initProject.mjs', [["['七個起始相位', 1, (v) => v.ph('個起始相位')]", "['七個起始相位', 1, (v) => '七個起始相位']"]], ['unit-factsResidue']],
    ['I02', 'src/tools/initProject.mjs', [["['七個相位', 1, (v) => v.ph('個相位')]", "['七個相位', 1, (v) => '七個相位']"]], ['unit-factsResidue']],
    ['I03', 'src/tools/initProject.mjs', [["['七相位', 6, (v) => v.ph('相位')]", "['七相位', 6, (v) => '七相位']"]], ['unit-factsResidue']],
    ['I04', 'src/tools/initProject.mjs', [["['- 每 7 日決策一次;', 1, (v) => `- 每 ${v.cad} 日決策一次;`]", "['- 每 7 日決策一次;', 1, (v) => '- 每 7 日決策一次;']"]], ['unit-factsResidue']],
    ['I05', 'src/tools/initProject.mjs', [['第一個決策日在數據起點後 ${v.warm} 日(暖機)。`]', '第一個決策日在數據起點後 180 日(暖機)。`]']], ['unit-factsResidue']],
    ['I06', 'src/tools/initProject.mjs', [["['p ≤ 0.05', 5, (v) => `p ≤ ${v.sc.nullP}`]", "['p ≤ 0.05', 5, (v) => 'p ≤ 0.05']"]], ['unit-factsResidue']],
    ['I07', 'src/tools/initProject.mjs', [["['重複 64 次', 1, (v) => `重複 ${v.draws} 次`]", "['重複 64 次', 1, (v) => '重複 64 次']"]], ['unit-factsResidue']],
    ['I08', 'src/tools/initProject.mjs', [["['分為 10 層', 1, (v) => `分為 ${v.bins} 層`]", "['分為 10 層', 1, (v) => '分為 10 層']"]], ['unit-factsResidue']],
    ['I09', 'src/tools/initProject.mjs', [["['名次 ±50 名內', 1, (v) => `名次 ±${v.half} 名內`]", "['名次 ±50 名內', 1, (v) => '名次 ±50 名內']"]], ['unit-factsResidue']],
    ['I10', 'src/tools/initProject.mjs', [["['至多約 90 秒', 1, (v) => `至多約 ${v.wait} 秒`]", "['至多約 90 秒', 1, (v) => '至多約 90 秒']"]], ['unit-factsResidue']],
    ['I11', 'src/tools/initProject.mjs', [["let en = evalCfgNumsOf(ev, 'eval')", 'let en = { warmupDays: 180, cadenceDays: 7, nullDraws: 64, actBins: 10, sideActHalf: 50 }']], ['unit-factsResidue']],
    ['I12', 'src/tools/initProject.mjs', [['ph: (tail) => phaseText(phaseCountOf(ev), tail),', 'ph: (tail) => phaseText(7, tail),']], ['unit-factsResidue']],
    ['I13', 'src/tools/initProject.mjs', [['let stForContract = hasSt ? projSt : JSON.parse(refSettingsText)', 'let stForContract = null']], ['unit-barHours']],
    //I14 為等價變異: 兩處皆給時須相同(不同即拋, I16 檢查之), 優先順序之互換於兩處皆給時結果相同、只給一處時亦相同
    ['I14', 'src/tools/initProject.mjs', [['let h = hOpt !== null ? hOpt : (hSt !== null ? hSt : 4)', 'let h = hSt !== null ? hSt : (hOpt !== null ? hOpt : 4)']], ['unit-barHours'], 'equiv'],
    ['I15', 'src/tools/initProject.mjs', [['    if (h === 4) {\n        return text', '    if (true) {\n        return text']], ['unit-barHours']],
    ['I16', 'src/tools/initProject.mjs', [['    if (hOpt !== null && hSt !== null && hOpt !== hSt) {', '    if (false) {']], ['unit-barHours']],
    ['I17', 'src/tools/initProject.mjs', [["barHours: bv === undefined || bv.startsWith('--') ? '' : bv", "barHours: bv === undefined || bv.startsWith('--') ? undefined : bv"]], ['unit-barHours']],
    ['I18', 'src/tools/initProject.mjs', [['    let bpd = Math.round(24 / h)', '    let bpd = Math.round(24 / h) + 1']], ['unit-barHours']],
    //── fillKeys.mjs ──
    ['X01', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs']", 'let EVAL_FP_SKIP = []']], ['unit-evalFingerprint']],
    ['X02', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs']", "let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'evalCore.mjs']"]], ['unit-evalFingerprint']],
    ['X03', 'src/domain/fillKeys.mjs', [['&& !EVAL_FP_SKIP.includes(f))', '&& EVAL_FP_SKIP.includes(f))']], ['unit-evalFingerprint']],
    ['X04', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs']", "let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'barGrid.mjs']"]], ['unit-evalFingerprint']],
    //── ledgerBuild.mjs / build.mjs ──
    ['L01', 'src/eval/ledgerBuild.mjs', [["barHours = normBarHours(barHours, 'barHours')", 'barHours = Number(barHours)']], ['unit-barHours']],
    ['L02', 'src/eval/ledgerBuild.mjs', [['if (isec !== undefined && isec !== null && !(isenum(isec) && Number(isec) === barSec)) {', 'if (false) {']], ['unit-barHours']],
    ['L03', 'src/eval/ledgerBuild.mjs', [['if (s.offGrid / den > offGridMax) {', 'if (s.offGrid / den >= offGridMax) {']], ['unit-barHours']],
    ['L04', 'src/eval/ledgerBuild.mjs', [['                    if (den === 0) {', '                    if (false) {']], ['unit-barHours']],
    ['L05', 'src/eval/ledgerBuild.mjs', [['let barSec = Math.round(barHours * 3600)', 'let barSec = Math.round(barHours * 3600) + 1']], ['unit-barHours']],
    ['L06', 'src/eval/ledgerBuild.mjs', [['        if (!(offGridMax >= 0 && offGridMax <= 1)) {', '        if (false) {']], ['unit-barHours']],
    ['L07', 'src/cli/build.mjs', [['if (/^invalid (barHours|seriesOffGridMax|series |settings\\.intervalSec)/.test(m)) {', 'if (false) {']], ['unit-barHours']],
    //── pickStore / verify ──
    ['P01', 'src/domain/pickStore.mjs', [['${hoFrom ? `(${hoFrom} 起)` : \'\'}', '(2026-08-01 起)']], ['unit-barHours']],
    ['P02', 'src/domain/pickStore.mjs', [["st.periods && typeof st.periods.holdoutFrom === 'string' && st.periods.holdoutFrom ? st.periods.holdoutFrom.slice(0, 10) : null", "'2026-08-01'"]], ['unit-barHours']],
    ['W01', 'src/domain/verify.mjs', [['let sideFlowCfgOf = (cfg = null) => ({ ...SIDE_FLOW, ...(cfg || {}), baseShort: { ...SIDE_FLOW.baseShort, ...((cfg && cfg.baseShort) || {}) } })', 'let sideFlowCfgOf = (cfg = null) => ({ ...SIDE_FLOW })']], ['unit-barHours']],
    //── 命令列與工具之接線(改回直接組裝專案) ──
    ['A01', 'src/tools/searchMap.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A02', 'src/tools/briefPreview.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A03', 'src/tools/armInactive.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A04', 'src/tools/armDecide.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A05', 'src/tools/fakeRound.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A06', 'src/cli/rsi.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
]

let args = process.argv.slice(2)
let argv = (k, d = null) => {
    let i = args.indexOf(`--${k}`)
    return i < 0 ? d : (args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[i + 1])
}
if (args.includes('--list')) {
    console.log(M.map((m) => `${m[0]} ${m[1]}`).join('\n'))
    process.exit(0)
}
let only = argv('only') ? String(argv('only')).split(',') : null
let from = Number(argv('from', 1))
let to = Number(argv('to', M.length))
let sel = M.map((m, i) => ({ m, i: i + 1 })).filter((x) => (only ? only.includes(x.m[0]) : x.i >= from && x.i <= to))
let check = args.includes('--check')

let normNl = (s) => s.replace(/\r\n/g, '\n')
let root = path.join(FD_TMP, `mut_${process.pid}`)
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })
for (let d of ['src', 'contract', 'arms', 'examples']) {
    fs.cpSync(path.join(FD_ROOT, d), path.join(root, d), { recursive: true })
}
fs.mkdirSync(path.join(root, 'test', 'tools'), { recursive: true })
for (let f of fs.readdirSync(path.join(FD_ROOT, 'test', 'tools'))) {
    fs.copyFileSync(path.join(FD_ROOT, 'test', 'tools', f), path.join(root, 'test', 'tools', f))
}
let testFiles = new Set(sel.flatMap((x) => [...x.m[3], ...GUARDS]))
for (let g of testFiles) {
    let f = `${g}.test.mjs`
    if (fs.existsSync(path.join(FD_ROOT, 'test', f))) {
        fs.copyFileSync(path.join(FD_ROOT, 'test', f), path.join(root, 'test', f))
    }
}
for (let f of ['settings.json', 'package.json']) {
    fs.copyFileSync(path.join(FD_ROOT, f), path.join(root, f))
}
let mocha = path.join(FD_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js')

//對照(每次執行之第一步; --check 除外): 無變異之複本須全綠 —— 否則「被殺」可能只是複本內之測試本身失敗(例:複本之行尾與測試內之規則運算式不合)而非變異之效果
if (!check) {
    let files = GUARDS.filter((g) => fs.existsSync(path.join(root, 'test', `${g}.test.mjs`))).map((g) => path.join('test', `${g}.test.mjs`))
    let r = spawnSync(process.execPath, [mocha, '--no-parallel', ...files, '--timeout', '180000'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ARSI_ROOT: '' } })
    let m = /(\d+) passing/.exec(`${r.stdout}`)
    console.log(`對照(無變異之複本): ${r.status === 0 ? '全綠' : '失敗(變異之結果不可信,中止)'}${m ? `,${m[1]} 項通過` : ''}`)
    if (r.status !== 0) {
        console.log(`${r.stdout}\n${r.stderr}`.slice(-1500))
        fs.rmSync(root, { recursive: true, force: true })
        process.exit(3)
    }
}
let results = []
let apply = (text, edits, id) => {
    let t = text
    for (let [find, rep, all] of edits) {
        let n = t.split(find).length - 1
        if (all ? n < 1 : n !== 1) {
            throw new Error(`${id}: 錨點出現 ${n} 次(須${all ? '至少' : '恰'} 1 次): ${find.slice(0, 60)}`)
        }
        t = t.split(find).join(rep)
    }
    return t
}
for (let { m, i } of sel) {
    let [id, file, edits, hint] = m
    let fp = path.join(root, file)
    let orig = fs.readFileSync(fp, 'utf8')
    let o = { id, i, file }
    try {
        //錨點以 LF 比對(複本可能為 CRLF): 先把檔轉為 LF 再套用(複本只供測試, 行尾不影響行為)
        let mutated = apply(normNl(orig), edits, id)
        if (check) {
            o.status = 'anchor-ok'
        }
        else {
            fs.writeFileSync(fp, mutated, 'utf8')
            let files = [...new Set([...hint, ...GUARDS])].filter((g) => fs.existsSync(path.join(root, 'test', `${g}.test.mjs`))).map((g) => path.join('test', `${g}.test.mjs`))
            let t0 = Date.now()
            let r = spawnSync(process.execPath, [mocha, '--bail', '--no-parallel', ...files, '--timeout', '180000'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ARSI_ROOT: '' } })
            let out = `${r.stdout}\n${r.stderr}`
            let fail = /\n\s+1\) ([^\n]+)\n\s+([^\n]+)/.exec(out)
            o.status = r.status === 0 ? (m[4] === 'equiv' ? 'equivalent' : 'SURVIVED') : (m[4] === 'equiv' ? 'EQUIV-KILLED' : 'killed')
            o.by = r.status === 0 ? '' : (fail ? `${fail[1]} / ${fail[2]}`.slice(0, 140) : out.slice(-200).replace(/\s+/g, ' '))
            o.sec = Math.round((Date.now() - t0) / 100) / 10
        }
    }
    catch (err) {
        o.status = 'ANCHOR-ERROR'
        o.by = String(err.message).slice(0, 200)
    }
    finally {
        fs.writeFileSync(fp, orig, 'utf8')
    }
    results.push(o)
    console.log(`${String(i).padStart(3)} ${o.id} ${o.status}${o.sec !== undefined ? ` (${o.sec}s)` : ''}${o.by ? ` — ${o.by}` : ''}`)
}
fs.rmSync(root, { recursive: true, force: true })
let st = (s) => results.filter((x) => x.status === s).length
console.log(`\n共 ${results.length} 項:killed ${st('killed')}、equivalent(等價變異,預期存活)${st('equivalent')}、SURVIVED ${st('SURVIVED')}、ANCHOR-ERROR ${st('ANCHOR-ERROR')}${check ? `、anchor-ok ${st('anchor-ok')}` : ''}`)
if (argv('out')) {
    fs.writeFileSync(path.resolve(String(argv('out'))), JSON.stringify(results, null, 2), 'utf8')
}
process.exit(st('SURVIVED') + st('ANCHOR-ERROR') > 0 ? 1 : 0)
