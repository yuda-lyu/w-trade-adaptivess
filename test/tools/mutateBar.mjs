/* eslint-disable quotes, no-template-curly-in-string -- 本檔之字串多為「原始碼之片段」(含單引號與 ${…}), 以雙引號書寫以免逐一跳脫 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { FD_ROOT, FD_TMP } from './synthLedger.mjs'
import { dupIdsOf } from './mutateIds.mjs'


//變異檢查(規則 R-EV-44、R-REC-36、R-REC-34 之守門之鑑別力; Gitea #184; Q 系列為 R-EV-46 之 api.fillRandom; M 系列為 R-REC-38、R 系列為 R-BT-6; G、H 系列為 R-RUN-11、N、O 系列為 R-BT-7、U 系列為 R-REC-39; Y 系列為搜尋樣式取自檔(cmdScan.mjs 之 patFileOf)、J 系列為近期版之超額之取值(domain.mjs 之 recentDiagOf / recentExcessOf)、Z 系列為迴圈專用之環境變數(verify.mjs 之 forbiddenPats; 皆為 Gitea #198 之主控另加之三項); SK 系列為 R-REC-40(排序鍵)、BL 系列為 R-REC-41(輪末之附算一併處理待補算; BL17 起為不重試之失敗之紀錄)、RX 系列為 R-REC-42(迴圈之重放一併載入擴充診斷); DR 系列為 R-REC-38 ⑦(近期活躍度版之診斷之「有值」之唯一判準; diagRead.mjs 之 recentDiagOf 與驗證、共同儲存區之讀取點)、UQ 系列為 R-PKG-9(變異工具之 --check 另核編號唯一; 皆為 Gitea #199 之主控另加); 指令解析已自 verify.mjs 搬入 cmdScan.mjs, 錨點之檔隨之): 於 test/_tmp/ 之複本逐一植入一處變異(把新檢測或新接線改回舊行為, 或改成錯的寫法), 跑守門之測試, 須轉紅(被殺)
//  用法(測試以 quiet-run --lock 執行): node test/tools/mutateBar.mjs [--list] [--check] [--control-only] [--only <id,id…>] [--from <序> --to <序>] [--out <結果.json>]
//    --check 只核對各變異之錨點(須恰出現一次; all 者至少一次), 不跑測試; 另核全部變異之編號唯一(重複者列出並以非 0 離開; R-PKG-9);未被殺者(survived)為測試之缺口 —— 補測試,不是補斷言(見 sgud/exp 之變異作法)
//    --control-only 只跑對照(守門之測試與所選變異之優先測試, 不植入變異)並列出所選變異中「無法判定」者, 供不重跑全部變異而盤點分類
//  對照 = 無變異之複本跑守門之測試(GUARDS; 須全綠, 否則中止)與所選變異之優先測試(不在 GUARDS 內者, 各單獨跑一次):
//    優先測試於對照即失敗者(複本內之失敗與變異無關, 例: 測試內之規則運算式不合複本之路徑), 其變異記為 UNDECIDABLE(無法判定): 不植入、不記為被殺(否則該測試之無關失敗會被誤記為變異被殺)
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
    ['D05', 'src/domain/domain.mjs', [['notesOf(n.raw.metrics, n.raw.seedS, train, n.raw.replays, isHalfOf(hf.pickMeta), st.score && st.score.sideFlow)', 'notesOf(n.raw.metrics, n.raw.seedS, train, n.raw.replays, isHalfOf(hf.pickMeta))']], ['unit-barHours']],
    //  D07: 補算之半庫判定改取 harness_train.json 之 pickMeta(須取 harness_full.json 者 —— 迴圈所判之同一份資料)
    ['D07', 'src/domain/domain.mjs', [['n.raw.replays, isHalfOf(hf.pickMeta), st.score && st.score.sideFlow)', 'n.raw.replays, isHalfOf(ht.pickMeta), st.score && st.score.sideFlow)']], ['unit-barHours']],
    ['D06', 'src/domain/domain.mjs', [['notesOf(n.raw.metrics, n.raw.seedS, train, n.raw.replays, isHalfOf(hf.pickMeta), st.score && st.score.sideFlow)', 'notesOf(n.raw.metrics, n.raw.seedS, train, n.raw.replays, false, st.score && st.score.sideFlow)']], ['unit-barHours']],
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
    ['L07', 'src/cli/build.mjs', [['if (/^invalid (barHours|seriesOffGridMax|startTime|series |settings\\.intervalSec)/.test(m)) {', 'if (false) {']], ['unit-barHours']],
    //── pickStore / verify ──
    ['P01', 'src/domain/pickStore.mjs', [['${hoFrom ? `(${hoFrom} 起)` : \'\'}', '(2026-08-01 起)']], ['unit-barHours']],
    ['P02', 'src/domain/pickStore.mjs', [["st.periods && typeof st.periods.holdoutFrom === 'string' && st.periods.holdoutFrom ? st.periods.holdoutFrom.slice(0, 10) : null", "'2026-08-01'"]], ['unit-barHours']],
    ['W01', 'src/domain/verify.mjs', [['let sideFlowCfgOf = (cfg = null) => ({ ...SIDE_FLOW, ...(cfg || {}), baseShort: { ...SIDE_FLOW.baseShort, ...((cfg && cfg.baseShort) || {}) } })', 'let sideFlowCfgOf = (cfg = null) => ({ ...SIDE_FLOW })']], ['unit-barHours']],
    ['W02', 'src/domain/verify.mjs', [['let sfBase = sideFlowCfgOf(sideFlow).baseShort', 'let sfBase = SIDE_FLOW.baseShort']], ['unit-barHours']],
    ['W03', 'src/domain/verify.mjs', [['notes: notesOf(out.metrics, seedS, train, replays, isHalf, st.score && st.score.sideFlow),', 'notes: notesOf(out.metrics, seedS, train, replays, isHalf),']], ['unit-barHours']],
    //半庫版之判定(迴圈之驗證與補算取同一函數 isHalfOf; Gitea #196 之併入項): W04 只認 0、W05 把 0 與 1 以外之值也當半庫版、W06 迴圈之驗證不帶半庫判定、W07 notesOf 不列半庫版之說明列
    ['W04', 'src/domain/verify.mjs', [['(pickMeta.params.half === 0 || pickMeta.params.half === 1)', '(pickMeta.params.half === 0)']], ['unit-barHours']],
    ['W05', 'src/domain/verify.mjs', [['(pickMeta.params.half === 0 || pickMeta.params.half === 1)', '(pickMeta.params.half !== undefined)']], ['unit-barHours']],
    ['W06', 'src/domain/verify.mjs', [['let isHalf = isHalfOf(out.pickMeta)', 'let isHalf = false']], ['unit-barHours']],
    ['W07', 'src/domain/verify.mjs', [['        if (half) {\n            out.push(\'半庫版(', '        if (false) {\n            out.push(\'半庫版(']], ['unit-barHours']],
    //  W08 以寬鬆相等判定(字串 '0'、true 也成半庫版); W09 「下單之做空比例」一列之「——」後少一個空格(改前之原文為「—— 席次…」)
    ['W08', 'src/domain/verify.mjs', [['(pickMeta.params.half === 0 || pickMeta.params.half === 1)', '(pickMeta.params.half == 0 || pickMeta.params.half == 1)']], ['unit-barHours']],
    ['W09', 'src/domain/verify.mjs', [['${sfBase.backtest} —— 席次之做多比例正常', '${sfBase.backtest} ——席次之做多比例正常']], ['unit-barHours']],
    //── 命令列與工具之接線(改回直接組裝專案) ──
    ['A01', 'src/tools/searchMap.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A02', 'src/tools/briefPreview.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A03', 'src/tools/armInactive.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A04', 'src/tools/armDecide.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A05', 'src/tools/fakeRound.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    ['A06', 'src/cli/rsi.mjs', [['makeProjectOrExit', 'makeProject', true]], ['unit-barHours']],
    //── evalCore.mjs: 擴充診斷之 api.fillRandom(規則 R-EV-46)──
    //  抽法: 側別、名次之匹配(目標取自池)、池之界(只取第 0 ~ k 個決策; 含第 k 個)、決策棒之界(< 與 ≤)、不重複、actDays 之分支、組內名次之基準、鄰域之寬與限同側、池為空之後備、該側無策略之防護、
    //    鄰域用盡之依序找、逐抽之亂數、排序、從缺之截斷、每決策之標記、方向之分組之建立
    ['Q01', 'src/eval/evalCore.mjs', [['cn[k * 2 + (j === 0 ? 1 : 0)] = c', 'cn[k * 2 + (j === 0 ? 0 : 1)] = c']], ['unit-extFillRandom']],
    ['Q02', 'src/eval/evalCore.mjs', [['let t = pn > 0 ? pool[g][Math.floor(rng() * pn)] : Math.floor(rng() * sz)', 'let t = Math.floor(rng() * sz)']], ['unit-extFillRandom']],
    ['Q03', 'src/eval/evalCore.mjs', [['let pn = wholePool ? poolN[g] : poolEnd[k * nGrp + g]', 'let pn = wholePool ? poolN[g] : poolN[g]']], ['unit-extFillRandom']],
    ['Q04', 'src/eval/evalCore.mjs', [["            while (e < eh && L.ent[e] < b) {\n                e++\n            }\n            ce[s] = e\n            if (skip) {", "            while (e < eh && L.ent[e] <= b) {\n                e++\n            }\n            ce[s] = e\n            if (skip) {"]], ['unit-extFillRandom']],
    ['Q05', 'src/eval/evalCore.mjs', [['                            stamp[v] = tick\n                            o[m++] = v', '                            o[m++] = v']], ['unit-extFillRandom']],
    ['Q06', 'src/eval/evalCore.mjs', [['FILL_HALF, sideGrp, 2, act, ', 'FILL_HALF, sideGrp, 2, 0, ']], ['unit-extFillRandom']],
    ['Q07', 'src/eval/evalCore.mjs', [['pool[g][poolN[g]++] = pos[sel[i]] - gStart[g]', 'pool[g][poolN[g]++] = pos[sel[i]]']], ['unit-extFillRandom']],
    ['Q08', 'src/eval/evalCore.mjs', [['let lo = Math.max(g0, g0 + t - half)', 'let lo = Math.max(g0, g0 + t - 3 * half)']], ['unit-extFillRandom']],
    ['Q09', 'src/eval/evalCore.mjs', [['let hi = Math.min(g0 + sz - 1, g0 + t + half)', 'let hi = g0 + t + half']], ['unit-extFillRandom']],
    ['Q10', 'src/eval/evalCore.mjs', [[': Math.floor(rng() * sz)', ': sz - 1']], ['unit-extFillRandom']],
    ['Q11', 'src/eval/evalCore.mjs', [['                        if (sz === 0) {\n                            continue\n                        }\n', '']], ['unit-extFillRandom']],
    ['Q12', 'src/eval/evalCore.mjs', [['        if (stamp[v] === tick) {\n            //鄰域內多數已被取用: 依序找第一個未用者; 全部用盡則此席從缺\n            v = -1', '        if (false) {\n            //鄰域內多數已被取用: 依序找第一個未用者; 全部用盡則此席從缺\n            v = -1']], ['unit-extFillRandom']],
    ['Q13', 'src/eval/evalCore.mjs', [['let rng = mulberry32(seed + (d + 1) * 7919 + ri * 104723)\n                let rs = new Array(nd)\n                for (let k = 0; k < nd; k++) {\n                    let ord = ords[k]\n                    let tot = 0', 'let rng = mulberry32(seed + ri * 104723)\n                let rs = new Array(nd)\n                for (let k = 0; k < nd; k++) {\n                    let ord = ords[k]\n                    let tot = 0']], ['unit-extFillRandom']],
    ['Q14', 'src/eval/evalCore.mjs', [['rs[k] = (m === tot ? o : o.slice(0, m)).sort()', 'rs[k] = (m === tot ? o : o.slice(0, m))']], ['unit-extFillRandom']],
    ['Q15', 'src/eval/evalCore.mjs', [['rs[k] = (m === tot ? o : o.slice(0, m)).sort()', 'rs[k] = o.sort()']], ['unit-extFillRandom']],
    ['Q16', 'src/eval/evalCore.mjs', [['                    let m = 0\n                    tick++\n                    for (let g = 0; g < nGrp; g++) {', '                    let m = 0\n                    for (let g = 0; g < nGrp; g++) {']], ['unit-extFillRandom']],
    ['Q17', 'src/eval/evalCore.mjs', [['                nullSideActOf([], null, 0, 0)\n                return fillGroupActOf', '                return fillGroupActOf']], ['unit-extFillRandom']],
    ['Q18', 'src/eval/evalCore.mjs', [['let cnt = actBars > 0 ? e - lowerBound(L.ent, L.off[s], e, b - actBars) : e - L.off[s]', 'let cnt = e - L.off[s]']], ['unit-extFillRandom']],
    ['Q19', 'src/eval/evalCore.mjs', [['                for (let i = 0; i < sel.length; i++) {\n                    let g = grp[sel[i]]\n                    pool[g][poolN[g]++] = pos[sel[i]] - gStart[g]\n                }\n                for (let g = 0; g < nGrp; g++) {\n                    poolEnd[k * nGrp + g] = poolN[g]\n                }', '                for (let g = 0; g < nGrp; g++) {\n                    poolEnd[k * nGrp + g] = poolN[g]\n                }\n                for (let i = 0; i < sel.length; i++) {\n                    let g = grp[sel[i]]\n                    pool[g][poolN[g]++] = pos[sel[i]] - gStart[g]\n                }']], ['unit-extFillRandom']],
    //  檢測: 外層 / 相位之長度、元素之種類(null、陣列)、opt 之種類(null、原始值)、席數之上下界、iseint、actDays、draws 之上下界與預設、比對之先後、讀取之寫法、複本不經迭代器、
    //    包裝與凍結、訊息之欄名、發現形狀不合後不再讀
    ['Q20', 'src/eval/evalCore.mjs', [['if (outer === null || outer.length !== runs.length) {', 'if (outer === null) {']], ['unit-extFillRandom']],
    ['Q21', 'src/eval/evalCore.mjs', [['                    if (items === null || items.length !== nd) {\n                        bad = `invalid statesByPhase[', '                    if (items === null) {\n                        bad = `invalid statesByPhase[']], ['unit-extFillRandom']],
    ['Q22', 'src/eval/evalCore.mjs', [["if (x === null || typeof x !== 'object' || isArr(x)) {", "if (x === null || typeof x !== 'object') {"]], ['unit-extFillRandom']],
    ['Q23', 'src/eval/evalCore.mjs', [["if (x === null || typeof x !== 'object' || isArr(x)) {", "if (typeof x !== 'object' || isArr(x)) {"]], ['unit-extFillRandom']],
    ['Q24', 'src/eval/evalCore.mjs', [["if (o === null || typeof o !== 'object') {", 'if (o === null) {']], ['unit-extFillRandom']],
    ['Q25', 'src/eval/evalCore.mjs', [['if (!(c >= 0 && c <= n)) {', 'if (!(c >= 0)) {']], ['unit-extFillRandom']],
    ['Q26', 'src/eval/evalCore.mjs', [['if (!(c >= 0 && c <= n)) {', 'if (!(c <= n)) {']], ['unit-extFillRandom']],
    ['Q27', 'src/eval/evalCore.mjs', [['let c = iseint(v) ? NumberCtor(v) : NaN', 'let c = Number.isInteger(v) ? v : NaN']], ['unit-extFillRandom']],
    ['Q28', 'src/eval/evalCore.mjs', [['                    if (!(act >= 0)) {', '                    if (false) {']], ['unit-extFillRandom']],
    ['Q29', 'src/eval/evalCore.mjs', [['if (!(d >= 1 && d <= FILL_DRAWS_MAX)) {', 'if (!(d >= 1)) {']], ['unit-extFillRandom']],
    ['Q30', 'src/eval/evalCore.mjs', [['if (!(d >= 1 && d <= FILL_DRAWS_MAX)) {', 'if (!(d <= FILL_DRAWS_MAX)) {']], ['unit-extFillRandom']],
    ['Q31', 'src/eval/evalCore.mjs', [['let d = Math.max(1, Math.min(FILL_DRAWS_MAX, nullDraws || 16))', 'let d = 16']], ['unit-extFillRandom']],
    ['Q32', 'src/eval/evalCore.mjs', [['                guardExt(\'ext\')\n                if (bad !== null) {\n                    throw new ErrorCtor(bad)\n                }\n                if (optBad) {', '                if (bad !== null) {\n                    throw new ErrorCtor(bad)\n                }\n                if (optBad) {'], ['                nullSideActOf([], null, 0, 0)\n                return fillGroupActOf', "                guardExt('ext')\n                nullSideActOf([], null, 0, 0)\n                return fillGroupActOf"]], ['unit-extFillRandom']],
    ['Q33', 'src/eval/evalCore.mjs', [["pushOwn(row, readOpt(x, 'short'))", 'pushOwn(row, x.short)']], ['unit-extFillRandom']],
    ['Q34', 'src/eval/evalCore.mjs', [['let outer = listOf(statesByPhase, runs.length, true)', 'let outer = isArr(statesByPhase) ? Array.from(statesByPhase) : null']], ['unit-extFillRandom']],
    ['Q35', 'src/eval/evalCore.mjs', [['fillRandom: ObjectFreeze(apiFn(fillRandom)),', 'fillRandom: ObjectFreeze(fillRandom),']], ['unit-extFillRandom']],
    ['Q36', 'src/eval/evalCore.mjs', [['fillRandom: ObjectFreeze(apiFn(fillRandom)),', 'fillRandom: apiFn(fillRandom),']], ['unit-extFillRandom']],
    ['Q37', 'src/eval/evalCore.mjs', [["if (o === null || typeof o !== 'object') {", "if (typeof o !== 'object') {"]], ['unit-extFillRandom']],
    ['Q38', 'src/eval/evalCore.mjs', [["${j === 0 ? 'short' : 'long'}", "${j === 0 ? 'long' : 'short'}"]], ['unit-extFillRandom']],
    ['Q39', 'src/eval/evalCore.mjs', [['for (let i = 0; bad === null && i < runs.length; i++) {\n                    let nd = runs[i].bars.length\n                    let items = listOf(outer[i], nd, true)', 'for (let i = 0; outer !== null && i < runs.length; i++) {\n                    let nd = runs[i].bars.length\n                    let items = listOf(outer[i], nd, true)']], ['unit-extFillRandom']],
    ['Q40', 'src/domain/texts.mjs', [['`fillRandom` 依各決策之兩側席數以活躍度匹配隨機填席(回可直接交給 `simulate` 之選集;同比例、隨機時機之安慰劑等用)、', '']], ['unit-texts']],
    //  opt.pool(目標名次之池): 池之選擇(不分、顛倒、對應之字串)、'phase' 之池界(只到其後一個決策)、檢測之條件(拿掉、只收其一、null、大小寫)、讀取之寫法、檢測之先後、訊息
    ['Q41', 'src/eval/evalCore.mjs', [['let pn = wholePool ? poolN[g] : poolEnd[k * nGrp + g]', 'let pn = poolEnd[k * nGrp + g]']], ['unit-extFillRandom']],
    ['Q42', 'src/eval/evalCore.mjs', [['let pn = wholePool ? poolN[g] : poolEnd[k * nGrp + g]', 'let pn = !wholePool ? poolN[g] : poolEnd[k * nGrp + g]']], ['unit-extFillRandom']],
    ['Q43', 'src/eval/evalCore.mjs', [['let pn = wholePool ? poolN[g] : poolEnd[k * nGrp + g]', 'let pn = wholePool ? poolEnd[Math.min(nd - 1, k + 1) * nGrp + g] : poolEnd[k * nGrp + g]']], ['unit-extFillRandom']],
    ['Q44', 'src/eval/evalCore.mjs', [["FILL_HALF, sideGrp, 2, act, oPool === 'phase')", "FILL_HALF, sideGrp, 2, act, oPool === 'toDate')"]], ['unit-extFillRandom']],
    ['Q45', 'src/eval/evalCore.mjs', [["if (oPool !== undefined && oPool !== null && oPool !== 'toDate' && oPool !== 'phase') {", 'if (false) {']], ['unit-extFillRandom']],
    ['Q46', 'src/eval/evalCore.mjs', [["oPool !== 'toDate' && oPool !== 'phase') {", "oPool !== 'toDate') {"]], ['unit-extFillRandom']],
    ['Q47', 'src/eval/evalCore.mjs', [["oPool !== 'toDate' && oPool !== 'phase') {", "oPool !== 'phase') {"]], ['unit-extFillRandom']],
    ['Q48', 'src/eval/evalCore.mjs', [["if (oPool !== undefined && oPool !== null && oPool !== 'toDate'", "if (oPool !== undefined && oPool !== 'toDate'"]], ['unit-extFillRandom']],
    ['Q49', 'src/eval/evalCore.mjs', [["oPool !== 'toDate' && oPool !== 'phase') {", "oPool !== 'toDate' && String(oPool).toLowerCase() !== 'phase') {"]], ['unit-extFillRandom']],
    ['Q50', 'src/eval/evalCore.mjs', [["oPool = readOpt(o, 'pool')", 'oPool = o.pool']], ['unit-extFillRandom']],
    ['Q51', 'src/eval/evalCore.mjs', [["                //opt.pool(目標名次之池): 'toDate'(預設)或 'phase'; 只收此二字串(不轉型、不呼叫其方法; 讀取拋錯之哨兵亦不合)\n                if (oPool !== undefined && oPool !== null && oPool !== 'toDate' && oPool !== 'phase') {\n                    throw new ErrorCtor('invalid opt.pool: must be \\'toDate\\' or \\'phase\\'')\n                }\n", ''], ['                let d = Math.max(1, Math.min(FILL_DRAWS_MAX, nullDraws || 16))', "                if (oPool !== undefined && oPool !== null && oPool !== 'toDate' && oPool !== 'phase') {\n                    throw new ErrorCtor('invalid opt.pool: must be \\'toDate\\' or \\'phase\\'')\n                }\n                let d = Math.max(1, Math.min(FILL_DRAWS_MAX, nullDraws || 16))"]], ['unit-extFillRandom']],
    ['Q52', 'src/eval/evalCore.mjs', [["throw new ErrorCtor('invalid opt.pool: must be \\'toDate\\' or \\'phase\\'')", "throw new ErrorCtor('invalid opt.pool: must be a string')"]], ['unit-extFillRandom']],
    //  nullGroupActOf(replaceNull 等)端對共用函數(actRankPrep / actRankAt / drawNear)之接線(規則 R-EV-46; Gitea #197 之本庫補強): 優先測試只列「既有」之測試(不含 unit-extFillRandom), 證明抽成共用函數後該端之接線仍有既有測試守門
    ['Q53', 'src/eval/evalCore.mjs', [['        let rp = actRankPrep(grp, nGrp, actDays)\n        let gStart = rp.gStart\n        let pos = rp.pos\n        let stamp = new Int32Array(n)\n        let tick = 0\n        let acc = new Float64Array(draws)', '        let rp = actRankPrep(grp, nGrp, 0)\n        let gStart = rp.gStart\n        let pos = rp.pos\n        let stamp = new Int32Array(n)\n        let tick = 0\n        let acc = new Float64Array(draws)']], ['unit-extReplacePart', 'unit-evalCore', 'unit-evalPostfitRecent']],
    ['Q54', 'src/eval/evalCore.mjs', [['let hi = Math.min(gStart[g + 1] - 1, p + half)\n                        let v = drawNear(ord, lo, hi, rng, stamp, tick)', 'let hi = Math.min(gStart[g + 1] - 1, p + half)\n                        let v = drawNear(ord, lo, lo, rng, stamp, tick)']], ['unit-extReplacePart', 'unit-evalCore', 'unit-evalPostfitRecent']],
    ['Q55', 'src/eval/evalCore.mjs', [['        let gStart = rp.gStart\n        let pos = rp.pos\n        let stamp = new Int32Array(n)\n        let tick = 0\n        let acc = new Float64Array(draws)', '        let gStart = rp.gStart\n        let pos = new Int32Array(n)\n        let stamp = new Int32Array(n)\n        let tick = 0\n        let acc = new Float64Array(draws)']], ['unit-extReplacePart', 'unit-evalCore', 'unit-evalPostfitRecent']],
    ['Q56', 'src/eval/evalCore.mjs', [['let ord = actRankAt(rp, grp, ce, r.bars[k], skip)', 'let ord = actRankAt(rp, grp, ce, r.bars[k] + 1, skip)']], ['unit-extReplacePart', 'unit-evalCore', 'unit-evalPostfitRecent']],
    //── 搜尋地圖之「有內容」與近期活躍度版之組成對照(規則 R-REC-38; domain.mjs)──
    //  M01 不看近期版、M19 兩版任一過即計; M02 ~ M04 近期版之條件之比較與且 / 或; M05 不一致之判定(一過一不過); M06 ~ M08 「有值」之判定(error、excess、p)
    //  M09 notContent 者亦標; M10 / M18 說明之新增句之出現條件與計數; M11 / M12 看板之表前一段與欄內之標記; M13 譜系之標記; M14 門檻不取設定; M15 ~ M17 內建版之條件之邊界(搬移之原式)
    ['M01', 'src/domain/domain.mjs', [['return s.builtin && s.recentOk !== false && ncOf(n).length === 0', 'return s.builtin && ncOf(n).length === 0']], ['unit-searchMapRecent']],
    ['M02', 'src/domain/domain.mjs', [['let recentOk = recent ? recent.excess > 0 && recent.p <= pMax : null', 'let recentOk = recent ? recent.excess >= 0 && recent.p <= pMax : null']], ['unit-searchMapRecent']],
    ['M03', 'src/domain/domain.mjs', [['let recentOk = recent ? recent.excess > 0 && recent.p <= pMax : null', 'let recentOk = recent ? recent.excess > 0 && recent.p < pMax : null']], ['unit-searchMapRecent']],
    ['M04', 'src/domain/domain.mjs', [['let recentOk = recent ? recent.excess > 0 && recent.p <= pMax : null', 'let recentOk = recent ? recent.excess > 0 || recent.p <= pMax : null']], ['unit-searchMapRecent']],
    ['M05', 'src/domain/domain.mjs', [['split: recent !== null && builtin !== recentOk }', 'split: recent !== null }']], ['unit-searchMapRecent']],
    ['M06', 'src/domain/diagRead.mjs', [["let s = e && typeof e === 'object' && !e.error ? e.side : null", "let s = e && typeof e === 'object' ? e.side : null"]], ['unit-searchMapRecent', 'unit-recentDiag']], //recentDiagOf 移至 diagRead.mjs(Gitea #199 主控之裁定; 錨點隨之)
    ['M07', 'src/domain/domain.mjs', [['return s && Number.isFinite(s.p) ? s : null', 'return s ? s : null']], ['unit-searchMapRecent']], //recentSideOf 不要求 p 為有限數值
    ['M08', 'src/domain/diagRead.mjs', [["return s && typeof s === 'object' && Number.isFinite(s.excess) ? s : null", "return s && typeof s === 'object' ? s : null"]], ['unit-searchMapRecent', 'unit-recentDiag']], //recentDiagOf(recentSideOf 與 recentExcessOf 共用)不要求超額為有限數值; 移至 diagRead.mjs(錨點隨之)
    ['M09', 'src/domain/domain.mjs', [['return s.split && extSurfaceOf(m).notContent.length === 0 ? s : null', 'return s.split ? s : null']], ['unit-searchMapRecent']],
    ['M10', 'src/domain/domain.mjs', [['let recentClause = nRecent ? ', 'let recentClause = true ? ']], ['unit-searchMapRecent']],
    ['M11', 'src/domain/domain.mjs', [['        if (spRows.length) {', '        if (true) {']], ['unit-searchMapRecent']],
    ['M12', 'src/domain/domain.mjs', [["${actSplitOf(n) ? ' 活躍度定義不一致' : ''}", '']], ['unit-searchMapRecent']],
    ['M13', 'src/domain/domain.mjs', [['            let sp = actSplitOf(n)', '            let sp = null']], ['unit-searchMapRecent']],
    ['M14', 'src/domain/domain.mjs', [['let contentPMax = () => (st.score && st.score.ladder1 && st.score.ladder1.nullP) || 0.05', 'let contentPMax = () => 0.05']], ['unit-searchMapRecent']],
    ['M15', 'src/domain/domain.mjs', [["c.excess > 0 && typeof c.p === 'number' && c.p <= pMax", "c.excess >= 0 && typeof c.p === 'number' && c.p <= pMax"]], ['unit-searchMapRecent']],
    ['M16', 'src/domain/domain.mjs', [["c.excess > 0 && typeof c.p === 'number' && c.p <= pMax", "c.excess > 0 && typeof c.p === 'number' && c.p < pMax"]], ['unit-searchMapRecent']],
    ['M17', 'src/domain/domain.mjs', [['c.share >= 0.8)', 'c.share > 0.8)']], ['unit-searchMapRecent']],
    ['M18', 'src/domain/domain.mjs', [['let nRecent = nodes.filter((n) => recentSideOf(n.raw && n.raw.metrics)).length', 'let nRecent = nodes.filter((n) => actSplitOf(n)).length']], ['unit-searchMapRecent']],
    ['M19', 'src/domain/domain.mjs', [['return s.builtin && s.recentOk !== false && ncOf(n).length === 0', 'return (s.builtin || s.recentOk === true) && ncOf(n).length === 0']], ['unit-searchMapRecent']],
    //── 操作掃描之「列出工作夾之根」只列以之為目標者(規則 R-BT-6; cmdScan.mjs 之 listRootExempt 與 verify.mjs 之 scanTrace 接線)──
    //  R01 / R02 免列之接線(只限指令之欄); R03 ~ R06 搜尋指令之辨識; R07 ~ R09、R34 ~ R43、R46 / R47 樣式引數之定位(位置、-e、--regexp、帶值之選項、-f、findstr、Select-String、--、分段、選項表);
    //  R10 / R44 殘留與樣式含字樣之段; R12 ~ R16、R29 ~ R31 路徑引數之核對(上層、無路徑、讀標準輸入、遞迴、萬用字元、~); R17 ~ R28、R45、R48 保守回退(引號、變數、命令替換、跳脫、切換目錄、工作目錄、重導向、佔位符之控制字元)
    //  R11 為等價變異: 「樣式含字樣之段為 0 而殘留不命中」不可達(殘留 = 全部之字去掉樣式, 原指令之命中處若不在被去掉之樣式內即仍在殘留內); 保留以記錄此防線
    ['R01', 'src/domain/verify.mjs', [["if (reListRoot && reListRoot.test(v) && !(k === 'command' && listRootExempt(", 'if (reListRoot && reListRoot.test(v) && !(false && listRootExempt(']], ['unit-scanListRoot']],
    ['R02', 'src/domain/verify.mjs', [["!(k === 'command' && listRootExempt(", '!(listRootExempt(']], ['unit-scanListRoot']],
    ['R03', 'src/domain/cmdScan.mjs', [['(?:grep|egrep|fgrep)', '(?:grepX|egrepX|fgrepX)']], ['unit-scanListRoot']],
    ['R04', 'src/domain/cmdScan.mjs', [[')?rg(?:', ')?rgX(?:']], ['unit-scanListRoot']],
    ['R05', 'src/domain/cmdScan.mjs', [[')?findstr(?:', ')?findstrX(?:']], ['unit-scanListRoot']],
    ['R06', 'src/domain/cmdScan.mjs', [['(?:select-string|sls)', '(?:select-stringX|slsX)']], ['unit-scanListRoot']],
    ['R07', 'src/domain/cmdScan.mjs', [['        pats.push(ops.shift())\n    }\n    return { pats, paths: ops.map((k) => ws[k]), stdin: tb.stdinOk', '        ops.shift()\n    }\n    return { pats, paths: ops.map((k) => ws[k]), stdin: tb.stdinOk']], ['unit-scanListRoot']],
    ['R08', 'src/domain/cmdScan.mjs', [["                if (c === 'e') {\n                    pats.push(vi)\n                }", '                if (false) {\n                    pats.push(vi)\n                }']], ['unit-scanListRoot']],
    ['R09', 'src/domain/cmdScan.mjs', [["                if (name === 'regexp') {\n                    pats.push(vi)\n                }", '                if (false) {\n                    pats.push(vi)\n                }']], ['unit-scanListRoot']],
    ['R10', 'src/domain/cmdScan.mjs', [["if (!need.length || re.test(unq(rest.join(' ; ')))) {", 'if (!need.length) {']], ['unit-scanListRoot']],
    ['R11', 'src/domain/cmdScan.mjs', [["if (!need.length || re.test(unq(rest.join(' ; ')))) {", "if (re.test(unq(rest.join(' ; ')))) {"]], ['unit-scanListRoot'], 'equiv'],
    ['R12', 'src/domain/cmdScan.mjs', [["p.startsWith('~') || coversRoot(", "p.startsWith('~') || false && coversRoot("]], ['unit-scanListRoot']],
    ['R13', 'src/domain/cmdScan.mjs', [[' || (!r.paths.length && !r.stdin)) {', ') {']], ['unit-scanListRoot']],
    ['R14', 'src/domain/cmdScan.mjs', [['stdin: tb.stdinOk && !rec }', 'stdin: false }']], ['unit-scanListRoot']],
    ['R15', 'src/domain/cmdScan.mjs', [['            if (!tb.flag.includes(c)) {\n                return null\n            }\n            rec = rec || tb.rec.includes(c)\n', '            if (!tb.flag.includes(c)) {\n                return null\n            }\n']], ['unit-scanListRoot']],
    ['R16', 'src/domain/cmdScan.mjs', [['                rec = rec || tb.rec.includes(c)\n                i = vi\n', '                i = vi\n']], ['unit-scanListRoot']],
    ['R17', 'src/domain/cmdScan.mjs', [["if (/[\"'`$^%<(){}]/.test(masked)", "if (/[\"'`^%<(){}]/.test(masked)"]], ['unit-scanListRoot']],
    ['R18', 'src/domain/cmdScan.mjs', [["if (/[\"'`$^%<(){}]/.test(masked)", "if (/[\"'$^%<(){}]/.test(masked)"]], ['unit-scanListRoot']],
    ['R19', 'src/domain/cmdScan.mjs', [["if (/[\"'`$^%<(){}]/.test(masked)", 'if (/[`$^%<(){}]/.test(masked)']], ['unit-scanListRoot']],
    ['R20', 'src/domain/cmdScan.mjs', [["|| quoted.some((q) => q[0] === '\"' &&", "|| false && quoted.some((q) => q[0] === '\"' &&"]], ['unit-scanListRoot']],
    ['R21', 'src/domain/cmdScan.mjs', [['if (!cwdKnown || LR_CD.test(s) || /', 'if (!cwdKnown || LR_CD.test(s) || false && /']], ['unit-scanListRoot']],
    ['R22', 'src/domain/cmdScan.mjs', [['if (!cwdKnown || LR_CD.test(s) ||', 'if (!cwdKnown || false ||']], ['unit-scanListRoot']],
    ['R23', 'src/domain/cmdScan.mjs', [['if (!cwdKnown || ', 'if (false || ']], ['unit-scanListRoot']],
    ['R24', 'src/domain/verify.mjs', [['                    cwdMoved = true\n', '                    void 0\n']], ['unit-scanListRoot']],
    ['R25', 'src/domain/verify.mjs', [["path.relative(path.resolve(listBase), absOf(listBase, wd)) === ''", 'true']], ['unit-scanListRoot']],
    ['R26', 'src/domain/cmdScan.mjs', [['            else if (/^(?:\\d*|&)>>?$/.test(w)) {\n                i++\n', '            else if (/^(?:\\d*|&)>>?$/.test(w)) {\n                return false\n']], ['unit-scanListRoot']],
    ['R27', 'src/domain/cmdScan.mjs', [['!(/^\\d*>&(?:\\d+|-)$/.test(w) || /^(?:\\d*|&)>>?[^>&]/.test(w))', '!(false)']], ['unit-scanListRoot']],
    ['R28', 'src/domain/cmdScan.mjs', [['/^(?:\\d*|&)>>?[^>&]/.test(w))) {\n                return false\n', '/^(?:\\d*|&)>>?[^>&]/.test(w))) {\n                ws.push(i)\n']], ['unit-scanListRoot']],
    ['R29', 'src/domain/cmdScan.mjs', [["pats.some((w) => /[*?[]/.test(dropQuotes(w))) || ", '']], ['unit-scanListRoot']],
    ['R30', 'src/domain/cmdScan.mjs', [["(g < 0 ? p : p.slice(0, g).replace(/[^\\\\/]*$/, ''))", 'p']], ['unit-scanListRoot']],
    ['R31', 'src/domain/cmdScan.mjs', [["if (!p || p.startsWith('~') || coversRoot(", 'if (!p || coversRoot(']], ['unit-scanListRoot']],
    ['R32', 'src/domain/cmdScan.mjs', [['                continue\n            }\n            return null\n        }\n        for (let j = 1;', '                continue\n            }\n            continue\n        }\n        for (let j = 1;']], ['unit-scanListRoot']],
    ['R33', 'src/domain/cmdScan.mjs', [['            if (!tb.flag.includes(c)) {\n                return null', '            if (false) {\n                return null']], ['unit-scanListRoot']],
    ['R34', 'src/domain/cmdScan.mjs', [['                let vi = j + 1 < w.length ? i : i + 1', '                let vi = i']], ['unit-scanListRoot']],
    ['R35', 'src/domain/cmdScan.mjs', [['                let vi = eq !== undefined ? i : i + 1', '                let vi = i']], ['unit-scanListRoot']],
    ['R36', 'src/domain/cmdScan.mjs', [["given = given || c === 'e' || c === 'f'", "given = given || c === 'e'"]], ['unit-scanListRoot']],
    ['R37', 'src/domain/cmdScan.mjs', [['            if (/^\\/c/i.test(w)) {\n                pats.push(i)', '            if (false) {\n                pats.push(i)']], ['unit-scanListRoot']],
    ['R38', 'src/domain/cmdScan.mjs', [['[belrsixvnmop]+|a:[0-9a-f]{1,2})$/i.test(w)) {\n            return null', '[belrsixvnmop]+|a:[0-9a-f]{1,2})$/i.test(w)) {\n            continue']], ['unit-scanListRoot']],
    ['R39', 'src/domain/cmdScan.mjs', [["        if (k === 'pattern') {\n            pats.push(i + 1)", '        if (false) {\n            pats.push(i + 1)']], ['unit-scanListRoot']],
    ['R40', 'src/domain/cmdScan.mjs', [["if (!k || i + 1 >= ws.length || !['pattern', 'path', 'literalpath', ...LR_SLS_VAL].includes(k)) {", 'if (!k || i + 1 >= ws.length) {']], ['unit-scanListRoot']],
    ['R41', 'src/domain/cmdScan.mjs', [["    if (paths === null && pos.length) {\n        paths = ws[pos.shift()].split(',')\n    }\n", '']], ['unit-scanListRoot']],
    ['R42', 'src/domain/cmdScan.mjs', [["        if (w === '--') {", '        if (false) {']], ['unit-scanListRoot']],
    ['R43', 'src/domain/cmdScan.mjs', [['masked.split(/&&|\\|\\||\\|&|[|;\\n]|(?<!>)&(?!>)/)', 'masked.split(/\\n/)']], ['unit-scanListRoot']],
    ['R44', 'src/domain/cmdScan.mjs', [['        if ([...drop].some((i) => re.test(unq(words[i])))) {', '        if (false) {']], ['unit-scanListRoot']],
    ['R45', 'src/domain/verify.mjs', [['return wd === undefined ? !cwdMoved :', 'return wd === undefined ? true :']], ['unit-scanListRoot']],
    ['R46', 'src/domain/cmdScan.mjs', [["val: 'ABCEMTdefgjmrt',", "val: 'ABCEMTdefgjmt',"]], ['unit-scanListRoot']],
    ['R47', 'src/domain/cmdScan.mjs', [["val: 'ABCEMTdefgjmrt',", "val: 'ABCEMTdefjmrt',"], ["flag: 'abcFHhIiLlNnoPpqSsUuVvwxz0',", "flag: 'abcFHhIiLlNnoPpqSsUuVvwxz0g',"]], ['unit-scanListRoot']],
    //R48: 拿掉「指令本身含佔位符所用之控制字元者照列」之防呆 ⇒ 越界之佔位符拋錯(「不拋錯」之斷言殺)、偽造之佔位符被免列(「照列」之斷言殺)
    ['R48', 'src/domain/cmdScan.mjs', [['if (MASK_CHARS.test(s)) {\n        return false', 'if (false) {\n        return false']], ['unit-scanListRoot']],
    //── 進入檔之拒跑(規則 R-RUN-11; agentRole.mjs、agentEntries.mjs、各入口)──
    //  G01 ~ G02 角色之辨識; G03 ~ G04 拒跑之條件與離開碼; G05 ~ G11 g_rsi 之模式表(唯讀之模式、預設模式、frontier 之兩旗標與「給了值」之判定、fill --dry、旗標之值);
    //  G12 ~ G21 表之各類(恆寫入之命令列與工具、有條件之工具); G22 理由不帶輸入值; G23 ~ G24、G42 輸入之防呆; G25 ~ G41 各入口之接線(拿掉 guardEntry 之呼叫)
    ['G01', 'src/arsi/agentRole.mjs', [['    return AGENT_ROLES.includes(v) ? v : null', '    return null']], ['unit-agentGuard']],
    ['G02', 'src/arsi/agentRole.mjs', [["let AGENT_ROLES = ['node', 'dream']", "let AGENT_ROLES = ['node']"]], ['unit-agentGuard']],
    ['G03', 'src/domain/agentEntries.mjs', [['    if (!role || !entryWrites(name, args)) {', '    if (!role) {']], ['unit-agentGuard']],
    ['G04', 'src/domain/agentEntries.mjs', [['    exit(2)\n', '    exit(0)\n']], ['unit-agentGuard']],
    ['G05', 'src/domain/agentEntries.mjs', [["let RSI_READ = ['status', 'dry']", "let RSI_READ = ['status']"]], ['unit-agentGuard']],
    ['G06', 'src/domain/agentEntries.mjs', [["    let mode = m === null ? 'status' : m", "    let mode = m === null ? 'round' : m"]], ['unit-agentGuard']],
    ['G07', 'src/domain/agentEntries.mjs', [["        return setArg(valOf(args, '--close')) || setArg(valOf(args, '--rearm'))", "        return setArg(valOf(args, '--close'))"]], ['unit-agentGuard']],
    ['G08', 'src/domain/agentEntries.mjs', [[" && !(/^-?\\d+(\\.\\d+)?$/.test(v) && Number(v) === 0)", '']], ['unit-agentGuard']],
    ['G09', 'src/domain/agentEntries.mjs', [["let setArg = (v) => typeof v === 'string' && v !== ''", "let setArg = (v) => v !== null && v !== ''"]], ['unit-agentGuard']],
    ['G10', 'src/domain/agentEntries.mjs', [["        return !has(args, '--dry')\n    }\n    return true", '        return true\n    }\n    return true']], ['unit-agentGuard']],
    ['G11', 'src/domain/agentEntries.mjs', [["    return v === undefined || String(v).startsWith('--') ? true : String(v)", '    return v === undefined ? true : String(v)']], ['unit-agentGuard']],
    ['G12', 'src/domain/agentEntries.mjs', [["    launch: { label: 'g_launch.mjs', writes: always },", "    launch: { label: 'g_launch.mjs', writes: () => false },"]], ['unit-agentGuard']],
    ['G13', 'src/domain/agentEntries.mjs', [["    build: { label: 'g_build.mjs', writes: always },", "    build: { label: 'g_build.mjs', writes: () => false },"]], ['unit-agentGuard']],
    ['G14', 'src/domain/agentEntries.mjs', [["    backtest: { label: 'g_backtest.mjs', writes: always },", "    backtest: { label: 'g_backtest.mjs', writes: () => false },"]], ['unit-agentGuard']],
    ['G15', 'src/domain/agentEntries.mjs', [["    pickStore: { label: 'tools/pickStore.mjs', writes: always },", "    pickStore: { label: 'tools/pickStore.mjs', writes: () => false },"]], ['unit-agentGuard']],
    ['G16', 'src/domain/agentEntries.mjs', [["initProject: { label: 'initProject.mjs', writes: (args) => !has(args, '--dry') }", "initProject: { label: 'initProject.mjs', writes: always }"]], ['unit-agentGuard']],
    ['G17', 'src/domain/agentEntries.mjs', [["armDecide: { label: 'tools/armDecide.mjs 之審定', writes: (args) => args.length > 0 }", "armDecide: { label: 'tools/armDecide.mjs 之審定', writes: always }"]], ['unit-agentGuard']],
    ['G18', 'src/domain/agentEntries.mjs', [["armInactive: { label: 'tools/armInactive.mjs 之補記', writes: (args) => args.length > 0 }", "armInactive: { label: 'tools/armInactive.mjs 之補記', writes: () => false }"]], ['unit-agentGuard']],
    ['G19', 'src/domain/agentEntries.mjs', [["briefPreview: { label: 'tools/briefPreview.mjs --out', writes: (args) => has(args, '--out') }", "briefPreview: { label: 'tools/briefPreview.mjs --out', writes: always }"]], ['unit-agentGuard']],
    ['G20', 'src/domain/agentEntries.mjs', [["quota: { label: 'tools/quota.mjs --probe', writes: (args) => has(args, '--probe') }", "quota: { label: 'tools/quota.mjs --probe', writes: always }"]], ['unit-agentGuard']],
    ['G21', 'src/domain/agentEntries.mjs', [["roundDigest: { label: 'tools/roundDigest.mjs --out', writes: (args) => has(args, '--out') }", "roundDigest: { label: 'tools/roundDigest.mjs --out', writes: () => false }"]], ['unit-agentGuard']],
    ['G22', 'src/domain/agentEntries.mjs', [['${ENTRY_RULES[name].label} 會寫入', "${name} ${args.join(' ')} 會寫入"]], ['unit-agentGuard']],
    ['G23', 'src/domain/agentEntries.mjs', [['r.writes(Array.isArray(args) ? args.map(String) : []) === true', 'r.writes(args) === true']], ['unit-agentGuard']],
    ['G24', 'src/domain/agentEntries.mjs', [['Object.prototype.hasOwnProperty.call(ENTRY_RULES, name) ? ENTRY_RULES[name] : null', 'ENTRY_RULES[name]']], ['unit-agentGuard']],
    ['G25', 'src/cli/rsi.mjs', [["guardEntry('rsi')", 'void 0']], ['unit-agentGuard']],
    ['G26', 'src/cli/launch.mjs', [["guardEntry('launch')", 'void 0']], ['unit-agentGuard']],
    ['G27', 'src/cli/build.mjs', [["guardEntry('build')", 'void 0']], ['unit-agentGuard']],
    ['G28', 'src/cli/backtest.mjs', [["guardEntry('backtest')", 'void 0']], ['unit-agentGuard']],
    ['G29', 'src/tools/archiveDocs.mjs', [["guardEntry('archiveDocs')", 'void 0']], ['unit-agentGuard']],
    ['G30', 'src/tools/buildCatalog.mjs', [["guardEntry('buildCatalog')", 'void 0']], ['unit-agentGuard']],
    ['G31', 'src/tools/pickStore.mjs', [["guardEntry('pickStore')", 'void 0']], ['unit-agentGuard']],
    ['G32', 'src/tools/searchMap.mjs', [["guardEntry('searchMap')", 'void 0']], ['unit-agentGuard']],
    ['G33', 'src/tools/smokeDispatch.mjs', [["guardEntry('smokeDispatch')", 'void 0']], ['unit-agentGuard']],
    ['G34', 'src/tools/fakeRound.mjs', [["guardEntry('fakeRound')", 'void 0']], ['unit-agentGuard']],
    ['G35', 'src/tools/replayCheck.mjs', [["guardEntry('replayCheck')", 'void 0']], ['unit-agentGuard']],
    ['G36', 'src/tools/initProject.mjs', [["guardEntry('initProject')", 'void 0']], ['unit-agentGuard']],
    ['G37', 'src/tools/armDecide.mjs', [["guardEntry('armDecide')", 'void 0']], ['unit-agentGuard']],
    ['G38', 'src/tools/armInactive.mjs', [["guardEntry('armInactive')", 'void 0']], ['unit-agentGuard']],
    ['G39', 'src/tools/briefPreview.mjs', [["guardEntry('briefPreview')", 'void 0']], ['unit-agentGuard']],
    ['G40', 'src/tools/quota.mjs', [["guardEntry('quota')", 'void 0']], ['unit-agentGuard']],
    ['G41', 'src/tools/roundDigest.mjs', [["guardEntry('roundDigest')", 'void 0']], ['unit-agentGuard']],
    ['G42', 'src/arsi/agentRole.mjs', [["env && typeof env === 'object' ? env[AGENT_ROLE_ENV] : undefined", 'env[AGENT_ROLE_ENV]']], ['unit-agentGuard']],
    //── 派工器設角色之環境變數(規則 R-RUN-11; dispatchers.mjs、agentRole.mjs)── H01 不設; H02 opencode 之選項不帶; H03 claude 之選項不帶; H04 其他角色亦帶
    //  H01 ~ H03 之守門為 unit-agentDispatchEnv(H02 只有其真 w-dispatch-ai 之一案看得到: 跑變異時須給 WTA_TEST_WDA_DIR 或家目錄下之技能根有之, 否則該案略過而存活)
    ['H01', 'src/arsi/dispatchers.mjs', [['let oe = { ...o, agentEnv: agentEnvOf(role) }', 'let oe = { ...o, agentEnv: null }']], ['unit-agentDispatchEnv']],
    ['H02', 'src/arsi/dispatchers.mjs', [["            ...(agentEnv ? { env: agentEnv } : {}),\n        }\n        if (entry.provider === 'opencode-go') {", "        }\n        if (entry.provider === 'opencode-go') {"]], ['unit-agentDispatchEnv']],
    ['H03', 'src/arsi/dispatchers.mjs', [['            ...(agentEnv ? { env: agentEnv } : {}),\n            model: cfg.model,', '            model: cfg.model,']], ['unit-agentDispatchEnv']],
    ['H04', 'src/arsi/agentRole.mjs', [['(AGENT_ROLES.includes(role) ? { [AGENT_ROLE_ENV]: role } : null)', '({ [AGENT_ROLE_ENV]: role })']], ['unit-agentGuard']],
    //── 操作掃描:執行迴圈之寫檔入口(規則 R-BT-7 ①; cmdScan.mjs 之 entryExecOf)──
    //  N01 ~ N02 here-doc; N03 命令替換; N04 xargs; N05 變數之值; N06 ~ N07 直接執行; N08 讀取類; N09 npm exec; N10 ~ N11 前綴; N12 node 之帶值選項; N13 內嵌腳本之子行程;
    //  N14 ~ N15 腳本與引數含變數; N16 其他指令從嚴; N17 重導向之目標; N18 ~ N19 名稱之比對; N20 ~ N21 引號之處理; N22 接線
    ['N01', 'src/domain/cmdScan.mjs', [['SHELLS.has(hc) ? entryExecOf(body) :', 'false ? entryExecOf(body) :']], ['unit-scanEntryExec']],
    ['N02', 'src/domain/cmdScan.mjs', [['EX_RUNNERS.includes(hc) && EX_CHILD.test(body)', 'EX_RUNNERS.includes(hc) && false']], ['unit-scanEntryExec']],
    ['N03', 'src/domain/cmdScan.mjs', [['    if (!q || q.sub) {\n        return true\n    }\n    let segs = exSegs(q.masked)', '    if (!q) {\n        return true\n    }\n    let segs = exSegs(q.masked)']], ['unit-scanEntryExec']],
    ['N04', 'src/domain/cmdScan.mjs', [["let EX_WRAPS = new Set([...SHELLS, 'xargs', ", 'let EX_WRAPS = new Set([...SHELLS, ']], ['unit-scanEntryExec']],
    ['N05', 'src/domain/cmdScan.mjs', [['            if (EX_MENTION.test(q.unq(ws[i]))) {\n                return true\n            }\n            i++', '            i++']], ['unit-scanEntryExec']],
    ['N06', 'src/domain/cmdScan.mjs', [['                if (entryWrites(direct, ws.slice(i + 1).map(q.bare)) || ws.slice(i + 1).some(q.dyn)) {', '                if (false) {']], ['unit-scanEntryExec']],
    ['N07', 'src/domain/cmdScan.mjs', [['if (entryWrites(direct, ws.slice(i + 1).map(q.bare)) ||', 'if (true ||']], ['unit-scanEntryExec']],
    ['N08', 'src/domain/cmdScan.mjs', [["let EX_READERS = new Set(['cat', ", 'let EX_READERS = new Set([']], ['unit-scanEntryExec']],
    ['N09', 'src/domain/cmdScan.mjs', [["            else if (c === 'npm' && /^(exec|x)$/.test(q.bare(ws[i + 1] || ''))) {", '            else if (false) {']], ['unit-scanEntryExec']],
    ['N10', 'src/domain/cmdScan.mjs', [["let EX_SKIP = new Set([...CMD_PREFIXES, 'npx'])", 'let EX_SKIP = new Set([...CMD_PREFIXES])']], ['unit-scanEntryExec']],
    ['N11', 'src/domain/cmdScan.mjs', [["(c === 'npx' && /^(-p|--package)$/.test(ws[i])) ? 2 : 1", 'false ? 2 : 1']], ['unit-scanEntryExec']],
    ['N12', 'src/domain/cmdScan.mjs', [['                    j += EX_NODE_VAL.has(ws[j]) ? 2 : 1', '                    j += 1']], ['unit-scanEntryExec']],
    ['N13', 'src/domain/cmdScan.mjs', [['                    if (EX_CHILD.test(inline)) {', '                    if (false) {']], ['unit-scanEntryExec']],
    ['N14', 'src/domain/cmdScan.mjs', [['                else if (j < ws.length) {\n                    if (q.dyn(ws[j])) {\n                        return true\n                    }\n', '                else if (j < ws.length) {\n']], ['unit-scanEntryExec']],
    ['N15', 'src/domain/cmdScan.mjs', [['if (name && (entryWrites(name, ws.slice(j + 1).map(q.bare)) || ws.slice(j + 1).some(q.dyn))) {', 'if (name && entryWrites(name, ws.slice(j + 1).map(q.bare))) {']], ['unit-scanEntryExec']],
    ['N16', 'src/domain/cmdScan.mjs', [['                done = true\n            }\n            else {\n                return true\n            }\n        }\n    }\n    return false\n}', '                done = true\n            }\n            else {\n                done = true\n            }\n        }\n    }\n    return false\n}']], ['unit-scanEntryExec']],
    ['N17', 'src/domain/cmdScan.mjs', [['        let ws = exArgs(ws0)\n        let i = 0', '        let ws = ws0\n        let i = 0']], ['unit-scanEntryExec']],
    ['N18', 'src/domain/cmdScan.mjs', [["\\\\.mjs`, 'i')", "\\\\.mjs`, '')"]], ['unit-scanEntryExec']],
    ['N19', 'src/domain/cmdScan.mjs', [[' || /(?:^|\\/)cli\\/(rsi|launch|build|backtest)\\.mjs$/i.exec(s)', '']], ['unit-scanEntryExec']],
    ['N20', 'src/domain/cmdScan.mjs', [['    if (MASK_CHARS.test(s)) {\n        return null', '    if (false) {\n        return null']], ['unit-scanEntryExec']],
    ['N21', 'src/domain/cmdScan.mjs', [["? x.replace(/\\\\[\\s\\S]/g, '') : ''", "? x : ''"]], ['unit-scanEntryExec']],
    ['N22', 'src/domain/verify.mjs', [["if (typeof inp.command === 'string' && entryExecOf(inp.command)) {", 'if (false) {']], ['unit-scanEntryExec']],
    //── 操作掃描:遞迴列出狀態根或其上層(規則 R-BT-7 ②; cmdScan.mjs 之 recursiveRootOf、rlCovers、scriptListsRoot、toolListsRoot 與 verify.mjs 之 scanTrace 接線)──
    //  O01 ~ O06 ls / dir / gci 之遞迴選項與其值; O07 ~ O08 find 與無路徑; O09 ~ O10 tree; O12 ~ O16 grep / rg / findstr; O17 ~ O18 xargs; O19 殼層之 -c; O20 eval 類; O21 指令名含變數;
    //  O22 ~ O24 切換目錄; O25 ~ O26 內嵌腳本; O27 ~ O28 無法解析; O29 ~ O30 here-doc; O31 ~ O33 路徑之判定; O34 ~ O40 腳本之線索; O41 ~ O42 搜尋 / 列目錄工具;
    //  O43 ~ O49 scanTrace 之接線(只在節點、工作目錄、寫入之程式檔); O50 ~ O52 三個呼叫點傳狀態根
    ['O01', 'src/domain/cmdScan.mjs', [[': /^-[A-Za-z]*R[A-Za-z]*$/.test(w) ||', ': /^-[A-Za-z]*X[A-Za-z]*$/.test(w) ||']], ['unit-scanEntryExec']],
    ['O02', 'src/domain/cmdScan.mjs', [['(isGci ? /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w) :', '(true ? /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w) :']], ['unit-scanEntryExec']],
    ['O03', 'src/domain/cmdScan.mjs', [["(c === 'dir' && /^\\/s$/i.test(w))", 'false']], ['unit-scanEntryExec']],
    ['O04', 'src/domain/cmdScan.mjs', [["w === '--recursive' || ", '']], ['unit-scanEntryExec']],
    ['O05', 'src/domain/cmdScan.mjs', [[' || /^-depth$/i.test(w)', '']], ['unit-scanEntryExec']],
    ['O06', 'src/domain/cmdScan.mjs', [['else if (/^-(filter|include|exclude|depth)$/i.test(ws[k])) {', 'else if (false) {']], ['unit-scanEntryExec']],
    ['O07', 'src/domain/cmdScan.mjs', [['let ops = k < 0 ? ws : ws.slice(0, k)', 'let ops = ws']], ['unit-scanEntryExec']],
    ['O08', 'src/domain/cmdScan.mjs', [["paths = ops.length ? ops : ['.']", 'paths = ops', true]], ['unit-scanEntryExec']],
    ['O09', 'src/domain/cmdScan.mjs', [["        else if (c === 'tree') {", '        else if (false) {']], ['unit-scanEntryExec']],
    ['O10', 'src/domain/cmdScan.mjs', [["let RL_VAL = new Set(['-L', '-P', ", "let RL_VAL = new Set(['-L', "]], ['unit-scanEntryExec']],
    ['O12', 'src/domain/cmdScan.mjs', [["            else if (c === 'rg' || !r.stdin) {", "            else if (c === 'rg') {"]], ['unit-scanEntryExec']],
    ['O13', 'src/domain/cmdScan.mjs', [["            else if (c === 'rg' || !r.stdin) {", '            else if (true) {']], ['unit-scanEntryExec']],
    ['O14', 'src/domain/cmdScan.mjs', [["? ['~'] : null", '? null : null']], ['unit-scanEntryExec']],
    ['O15', 'src/domain/cmdScan.mjs', [["                paths = r.paths.length ? r.paths : ['.']", '                paths = r.paths']], ['unit-scanEntryExec']],
    ['O16', 'src/domain/cmdScan.mjs', [["        else if (c === 'findstr' &&", '        else if (false &&']], ['unit-scanEntryExec']],
    ['O17', 'src/domain/cmdScan.mjs', [["            paths.push('~')", '            void 0']], ['unit-scanEntryExec']],
    ['O18', 'src/domain/cmdScan.mjs', [['i += RL_XARGS_VAL.has(ws0[i]) ? 2 : 1', 'i += 1']], ['unit-scanEntryExec']],
    ['O19', 'src/domain/cmdScan.mjs', [['                if (recursiveRootOf(rest.length === 1 ?', '                if (false && recursiveRootOf(rest.length === 1 ?']], ['unit-scanEntryExec']],
    ['O20', 'src/domain/cmdScan.mjs', [['        if (EVAL_WRAPS.has(c)) {', "        if (c !== 'eval' && EVAL_WRAPS.has(c)) {"]], ['unit-scanEntryExec']], //包裝之集合已與 entryExecOf 共用(EVAL_WRAPS), 故改於 recursiveRootOf 之使用處去掉 eval(效果同原: 只影響遞迴列出之判定)
    ['O21', 'src/domain/cmdScan.mjs', [['        if (q.dyn(ws0[i])) {', '        if (false) {']], ['unit-scanEntryExec']],
    ['O22', 'src/domain/cmdScan.mjs', [["dir = !t || t === '-' || /[$`~]/.test(t) || dir === null ? null : absOf(dir, t)", 'dir = dir']], ['unit-scanEntryExec']],
    ['O23', 'src/domain/cmdScan.mjs', [["t === '-' || /[$`~]/.test(t) || dir === null", "t === '-' || dir === null"]], ['unit-scanEntryExec']],
    ['O24', 'src/domain/cmdScan.mjs', [["        if (c === 'popd' || c === 'pop-location') {\n            dir = null", "        if (c === 'popd' || c === 'pop-location') {\n            dir = dir"]], ['unit-scanEntryExec']],
    ['O25', 'src/domain/cmdScan.mjs', [["let k = ws.findIndex((w) => EX_NODE_INLINE.has(w) || w === '-c')", 'let k = -1']], ['unit-scanEntryExec']],
    ['O26', 'src/domain/cmdScan.mjs', [["EX_NODE_INLINE.has(w) || w === '-c')", 'EX_NODE_INLINE.has(w))']], ['unit-scanEntryExec']],
    ['O27', 'src/domain/cmdScan.mjs', [['return { hit: hit || RL_LISTER.test(s), dir: LR_CD.test(s) ? null : base }', 'return { hit, dir: LR_CD.test(s) ? null : base }']], ['unit-scanEntryExec']],
    ['O28', 'src/domain/cmdScan.mjs', [['return { hit: hit || RL_LISTER.test(s), dir: LR_CD.test(s) ? null : base }', 'return { hit: hit || RL_LISTER.test(s), dir: base }']], ['unit-scanEntryExec']],
    ['O29', 'src/domain/cmdScan.mjs', [['if (SHELLS.has(hc) ? recursiveRootOf(body, { base, stateRoot }).hit :', 'if (false ? recursiveRootOf(body, { base, stateRoot }).hit :']], ['unit-scanEntryExec']],
    ['O30', 'src/domain/cmdScan.mjs', [['.includes(hc) && scriptListsRoot(body, base, stateRoot)) {', '.includes(hc) && false) {']], ['unit-scanEntryExec']],
    ['O31', 'src/domain/cmdScan.mjs', [['    if (!isAbs && base === null) {\n        return true\n    }\n', '']], ['unit-scanEntryExec']],
    ['O32', 'src/domain/cmdScan.mjs', [["    if (!p || p.startsWith('~') || /[$`]/.test(p)) {", '    if (!p) {']], ['unit-scanEntryExec']],
    ['O33', 'src/domain/cmdScan.mjs', [["    let d = g < 0 ? p : p.slice(0, g).replace(/[^\\\\/]*$/, '')", '    let d = p']], ['unit-scanEntryExec']],
    ['O34', 'src/domain/cmdScan.mjs', [['    if (!SC_LIST.test(s) || !SC_REC.test(s)) {', '    if (!SC_LIST.test(s)) {']], ['unit-scanEntryExec']],
    ['O35', 'src/domain/cmdScan.mjs', [['    if (!SC_LIST.test(s) || !SC_REC.test(s)) {', '    if (!SC_REC.test(s)) {']], ['unit-scanEntryExec']],
    ['O36', 'src/domain/cmdScan.mjs', [["&& rlCovers('.', base, stateRoot)) {", '&& false) {']], ['unit-scanEntryExec']],
    ['O37', 'src/domain/cmdScan.mjs', [["(?!\\s*(?:\\+|,\\s*['\"`]))/.test(s)", '/.test(s)']], ['unit-scanEntryExec']],
    ['O38', 'src/domain/cmdScan.mjs', [["        if (/^\\s*(?:\\+|,\\s*['\"`])/.test(after)) {\n            continue\n        }\n", '']], ['unit-scanEntryExec']],
    ['O39', 'src/domain/cmdScan.mjs', [['let pathy = dots ? SC_CALL.test(s.slice(Math.max(0, m.index - 40), m.index)) :', 'let pathy = dots ? true :']], ['unit-scanEntryExec']],
    ['O40', 'src/domain/cmdScan.mjs', [['!/^[\\\\/]+$/.test(v) && ', '']], ['unit-scanEntryExec']],
    ['O41', 'src/domain/cmdScan.mjs', [[" || (isGlob && !(typeof inp.pattern === 'string' && inp.pattern.includes('**')))", '']], ['unit-scanEntryExec']],
    ['O42', 'src/domain/cmdScan.mjs', [['if (!/grep|search|glob|^list$|^ls$/i.test(tool)', 'if (!/grep|search|glob/i.test(tool)']], ['unit-scanEntryExec']],
    ['O43', 'src/domain/verify.mjs', [["let rlOn = nodeRules && typeof stateRoot === 'string'", "let rlOn = typeof stateRoot === 'string'"]], ['unit-scanEntryExec']],
    ['O44', 'src/domain/verify.mjs', [['(rlDir === rlRoot ? [rlRoot] : [rlRoot, rlDir])', '(rlDir === rlRoot ? [rlRoot] : [rlDir])']], ['unit-scanEntryExec']],
    ['O45', 'src/domain/verify.mjs', [['                            rlDir = rs[rs.length - 1].dir', '                            void 0']], ['unit-scanEntryExec']],
    ['O46', 'src/domain/verify.mjs', [['let bases = wdv !== undefined ? [', 'let bases = false ? [']], ['unit-scanEntryExec']],
    ['O47', 'src/domain/verify.mjs', [["let code = isWriteTool && typeof fpTarget === 'string' && CODE_EXT.test(fpTarget) ?", 'let code = false ?']], ['unit-scanEntryExec']],
    ['O48', 'src/domain/verify.mjs', [['(isShell ? recursiveRootOf(src, { base: b, stateRoot }).hit :', '(false ? recursiveRootOf(src, { base: b, stateRoot }).hit :']], ['unit-scanEntryExec']],
    ['O49', 'src/domain/verify.mjs', [['                    else if (bases.some((b) => toolListsRoot(tool, inp, b, stateRoot))) {', '                    else if (false) {']], ['unit-scanEntryExec']],
    ['O50', 'src/domain/verify.mjs', [['nodeRules: true, stateRoot: st.rsi && st.rsi.root })', 'nodeRules: true })']], ['unit-agentDispatchEnv']],
    ['O51', 'src/domain/domain.mjs', [['nodeRules: true, planRule, stateRoot: st.rsi.root })', 'nodeRules: true, planRule })']], ['unit-agentDispatchEnv']],
    ['O52', 'src/tools/scanCheck.mjs', [['nodeRules: true, planRule, stateRoot: st.rsi.root })', 'nodeRules: true, planRule })']], ['unit-agentDispatchEnv']],
    //── 輪末摘要之「待核對」之最小收窄(規則 R-REC-39; domain.mjs 之 signSentenceHit)──
    //  U01 不看主詞; U02 ~ U03 同號 / 異號之前字; U04 不切句; U05 逗號亦切; U06 ~ U08 主詞之三詞; U09 ~ U14 句末之標點(全形與半形、換行); U15 只認「號」; U16 不含字樣之句
    ['U01', 'src/domain/domain.mjs', [['    if (!SIGN_SUBJ.test(s)) {\n        return true\n    }\n', '']], ['unit-signsNarrow']],
    ['U02', 'src/domain/domain.mjs', [[" || s[m.index - 1] === '異')", ')']], ['unit-signsNarrow']],
    ['U03', 'src/domain/domain.mjs', [["(s[m.index - 1] === '同' || ", '(']], ['unit-signsNarrow']],
    //U04 ~ U05、U09 ~ U14 之錨點為切句之正規式(原文為全形與半形之標點字元本身: 。;;!!??與 \n)
    ['U04', 'src/domain/domain.mjs', [['v.split(/(?<=[。；;！!？?\\n])/).some(signSentenceHit)', 'signSentenceHit(v)']], ['unit-signsNarrow']],
    ['U05', 'src/domain/domain.mjs', [['？?\\n])/).some(signSentenceHit)', '？?\\n,，])/).some(signSentenceHit)']], ['unit-signsNarrow']],
    ['U06', 'src/domain/domain.mjs', [['let SIGN_SUBJ = /組成對照|重放|同分次序/', 'let SIGN_SUBJ = /組成對照|同分次序/']], ['unit-signsNarrow']],
    ['U07', 'src/domain/domain.mjs', [['let SIGN_SUBJ = /組成對照|重放|同分次序/', 'let SIGN_SUBJ = /組成對照|重放/']], ['unit-signsNarrow']],
    ['U08', 'src/domain/domain.mjs', [['let SIGN_SUBJ = /組成對照|重放|同分次序/', 'let SIGN_SUBJ = /重放|同分次序/']], ['unit-signsNarrow']],
    ['U09', 'src/domain/domain.mjs', [['(?<=[。；;！!？?\\n])/).some', '(?<=[。；;!？?\\n])/).some']], ['unit-signsNarrow']],
    ['U10', 'src/domain/domain.mjs', [['(?<=[。；;！!？?\\n])/).some', '(?<=[。；;！!?\\n])/).some']], ['unit-signsNarrow']],
    ['U11', 'src/domain/domain.mjs', [['(?<=[。；;！!？?\\n])/).some', '(?<=[。;！!？?\\n])/).some']], ['unit-signsNarrow']],
    ['U12', 'src/domain/domain.mjs', [['(?<=[。；;！!？?\\n])/).some', '(?<=[；;！!？?\\n])/).some']], ['unit-signsNarrow']],
    ['U13', 'src/domain/domain.mjs', [['(?<=[。；;！!？?\\n])/).some', '(?<=[。；;！!？?])/).some']], ['unit-signsNarrow']],
    ['U14', 'src/domain/domain.mjs', [['(?<=[。；;！!？?\\n])/).some', '(?<=[。；！!？?\\n])/).some']], ['unit-signsNarrow']],
    ['U15', 'src/domain/domain.mjs', [["!(m[0] === '號' && (s[m.index - 1]", '!((s[m.index - 1]']], ['unit-signsNarrow']],
    ['U16', 'src/domain/domain.mjs', [['    let ms = [...s.matchAll(SIGN_ALL)]\n    if (!ms.length) {\n        return false\n    }\n', '    let ms = [...s.matchAll(SIGN_ALL)]\n']], ['unit-signsNarrow']],
    //── 搜尋樣式取自檔或無位置樣式(Y 系列; cmdScan.mjs 之 patFileOf 與 stripSearchPatterns; Gitea #198 之另見 2)──
    ['Y01', 'src/domain/cmdScan.mjs', [['            if (pf) {\n                removed = true', '            if (false) {\n                removed = true']], ['unit-cmdScan']],
    ['Y02', 'src/domain/cmdScan.mjs', [['                skipNext = pf === 2\n', '                skipNext = false\n']], ['unit-cmdScan']],
    ['Y03', 'src/domain/cmdScan.mjs', [["        return fam === 'rg' ? 3 : 0", '        return 3']], ['unit-cmdScan']],
    ['Y04', 'src/domain/cmdScan.mjs', [["    if (t === '--file') {\n        return 2\n    }\n", '']], ['unit-cmdScan']],
    ['Y05', 'src/domain/cmdScan.mjs', [["    if (t.startsWith('--file=')) {\n        return 1\n    }\n", '']], ['unit-cmdScan']],
    ['Y06', 'src/domain/cmdScan.mjs', [['    if (/^-[A-Za-z0-9]/.test(t)) {', '    if (/^-[A-Za-z0-9]+$/.test(t)) {']], ['unit-cmdScan']],
    ['Y07', 'src/domain/cmdScan.mjs', [["return t[j] === 'f' ? (j === t.length - 1 ? 2 : 1) : 0", "return t[j] === 'f' ? 2 : 0"]], ['unit-cmdScan']],
    ['Y08', 'src/domain/cmdScan.mjs', [["return t[j] === 'f' ? (j === t.length - 1 ? 2 : 1) : 0", "return t[j] === 'f' ? 1 : 0"]], ['unit-cmdScan']],
    ['Y09', 'src/domain/cmdScan.mjs', [['if (LR_GNU[fam].val.includes(t[j])) {', "if ((fam === 'grep' ? 'ABCDdem' : LR_GNU.rg.val).includes(t[j])) {"]], ['unit-cmdScan']],
    ['Y10', 'src/domain/cmdScan.mjs', [['if (LR_GNU[fam].val.includes(t[j])) {', "if ((fam === 'rg' ? 'ABCEMTdegjmrt' : LR_GNU.grep.val).includes(t[j])) {"]], ['unit-cmdScan']],
    ['Y11', 'src/domain/cmdScan.mjs', [["/(?:^|[\\\\/])rg(?:\\.exe)?$/i.test(head) ? 'rg'", "/(?:^|[\\\\/])rg$/i.test(head) ? 'rg'"]], ['unit-cmdScan']],
    ['Y12', 'src/domain/cmdScan.mjs', [["(/grep(?:\\.exe)?$/i.test(head) ? 'grep' : null)", "(/grep$/i.test(head) ? 'grep' : null)"]], ['unit-cmdScan']],
    ['Y13', 'src/domain/cmdScan.mjs', [['                else if (/^\\/G:/i.test(t)) {', '                else if (false) {']], ['unit-cmdScan']],
    ['Y14', 'src/domain/cmdScan.mjs', [['                else if (/^\\/G:/i.test(t)) {', '                else if (/^\\/G:/.test(t)) {']], ['unit-cmdScan']],
    ['Y15', 'src/domain/cmdScan.mjs', [['            if (pf) {\n                removed = true\n', '            if (pf) {\n']], ['unit-cmdScan']],
    ['Y16', 'src/domain/cmdScan.mjs', [["    if (t === '--files') {\n        return fam === 'rg' ? 3 : 0\n    }\n", '']], ['unit-cmdScan']],
    ['Y17', 'src/domain/cmdScan.mjs', [["k < toks.length && toks[k] !== '--'; k++) {", 'k < toks.length; k++) {']], ['unit-cmdScan']],
    ['Y18', 'src/domain/cmdScan.mjs', [['                        later = true\n                        break', '                        later = false\n                        break']], ['unit-cmdScan']],
    ['Y19', 'src/domain/cmdScan.mjs', [['(patFileOf(m0[0], toks[k]) || (isFindstr && /^\\/G:/i.test(toks[k])))', '(patFileOf(m0[0], toks[k]))']], ['unit-cmdScan']],
    ['Y20', 'src/domain/cmdScan.mjs', [['(patFileOf(m0[0], toks[k]) || (isFindstr && /^\\/G:/i.test(toks[k])))', '((isFindstr && /^\\/G:/i.test(toks[k])))']], ['unit-cmdScan']],
    //── 近期版之超額之取值(J 系列; domain.mjs 之 recentDiagOf / recentExcessOf; contentOf 與 avgOf 與「有內容」共用; Gitea #198 之另見 1)──
    ['J01', 'src/domain/domain.mjs', [['    return s ? s.excess : null\n}', '    return s ? s.excess : 0\n}']], ['unit-searchMapRecent']],
    ['J02', 'src/domain/domain.mjs', [['            let r0 = recentExcessOf(m)\n            return `${mean(', "            let r0 = m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side ? m.ext.nullRecentAct.side.excess : null\n            return `${mean("]], ['unit-searchMapRecent']],
    ['J03', 'src/domain/domain.mjs', [['            let r0 = recentExcessOf(m)\n            let useRecent', "            let r0 = m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side ? m.ext.nullRecentAct.side.excess : null\n            let useRecent"]], ['unit-searchMapRecent']],
    ['J04', 'src/domain/domain.mjs', [['let recentExcessOf = (m) => {\n    let s = recentDiagOf(m)', 'let recentExcessOf = (m) => {\n    let s = recentSideOf(m)']], ['unit-searchMapRecent']],
    ['J05', 'src/domain/diagRead.mjs', [["let e = m && m.ext && typeof m.ext === 'object' ? m.ext.nullRecentAct : null\n    let s = e && typeof e === 'object' && !e.error ? e.side : null\n    return s && typeof s === 'object' && Number.isFinite(s.excess)", "let e = m && m.ext && typeof m.ext === 'object' ? m.ext.nullRecentAct : null\n    let s = e && typeof e === 'object' ? e.side : null\n    return s && typeof s === 'object' && Number.isFinite(s.excess)"]], ['unit-searchMapRecent', 'unit-recentDiag']], //移至 diagRead.mjs(錨點隨之)
    //── 迴圈專用之環境變數(Z 系列; verify.mjs 之 forbiddenPats; 規則 R-RUN-11 之清除角色變數)──
    ['Z01', 'src/domain/verify.mjs', [['[/ARSI_HARNESS|ARSI_AGENT_ROLE/, ', '[/ARSI_HARNESS/, ']], ['unit-cmdScan']],
    ['Z02', 'src/domain/verify.mjs', [['[/ARSI_HARNESS|ARSI_AGENT_ROLE/, ', '[/ARSI_AGENT_ROLE/, ']], ['unit-cmdScan']],
    ['Z03', 'src/domain/verify.mjs', [["[/ARSI_HARNESS|ARSI_AGENT_ROLE/, '迴圈專用之環境變數']", "[/ARSI_HARNESS|ARSI_AGENT_ROLE/, '迴圈專用之環境變數(角色)']"]], ['unit-cmdScan']],
    ['Z04', 'src/domain/verify.mjs', [['[/ARSI_HARNESS|ARSI_AGENT_ROLE/, ', '[/ARSI_HARNESS|ARSI_AGENT/, ']], ['unit-cmdScan']],
    //── 排序鍵(SK 系列; 規則 R-REC-40; domain.mjs 之 neutralDeltaOf / rankKeyOf 與各用鍵處、fakeRound.mjs 之補位核對)──
    //  SK01 ~ SK08 鍵之定義之各分支; SK09 ~ SK10 補位之底; SK11 ~ SK14 參考節點; SK15 ~ SK21 看板(SK21 為等價: 臂之最佳因鍵而變者必使節點一覽之次序亦變); SK22 ~ SK26、SK28 搜尋地圖; SK27 假輪次
    ['SK01', 'src/domain/diagRead.mjs', [['!Array.isArray(e) && !e.error && Number.isFinite(e.delta) ? e.delta : null', '!Array.isArray(e) && Number.isFinite(e.delta) ? e.delta : null']], ['unit-rankKey']],
    ['SK02', 'src/domain/diagRead.mjs', [['&& !e.error && Number.isFinite(e.delta) ? e.delta : null', "&& !e.error && typeof e.delta === 'number' ? e.delta : null"]], ['unit-rankKey']],
    ['SK03', 'src/domain/domain.mjs', [['for (let x of Array.isArray(raw.replays) ? raw.replays : []) {', 'for (let x of []) {']], ['unit-rankKey']],
    ['SK04', 'src/domain/domain.mjs', [['let vs = [d0 === null ? S : S - d0]', 'let vs = [S]']], ['unit-rankKey']],
    ['SK05', 'src/domain/domain.mjs', [['let d = dx === null ? d0 : dx', 'let d = d0']], ['unit-rankKey']],
    ['SK06', 'src/domain/domain.mjs', [['vs.push(d === null ? x.S : x.S - d)', 'vs.push(x.S)']], ['unit-rankKey']],
    ['SK07', 'src/domain/domain.mjs', [['if (x && Number.isFinite(x.S)) {\n            let dx', "if (x && typeof x.S === 'number') {\n            let dx"]], ['unit-rankKey']],
    ['SK08', 'src/domain/domain.mjs', [['let dx = d0 === null ? null : neutralDeltaOf(x)', 'let dx = neutralDeltaOf(x)']], ['unit-rankKey']],
    ['SK09', 'src/domain/domain.mjs', [['.sort((a, b) => rankKeyOf(b) - rankKeyOf(a) || (a.id < b.id ? -1 : 1))[0] || null', '.sort((a, b) => b.score.S - a.score.S || (a.id < b.id ? -1 : 1))[0] || null']], ['unit-rankKey']],
    ['SK10', 'src/domain/domain.mjs', [['rankKeyOf(b) - rankKeyOf(a) || (a.id < b.id ? -1 : 1))[0] || null', 'rankKeyOf(b) - rankKeyOf(a))[0] || null']], ['unit-rankKey']],
    ['SK11', 'src/domain/domain.mjs', [['(kvOf(b) - kvOf(a))).slice(0, st.rsi.refTopNodes || 3)', '(b.score.S - a.score.S)).slice(0, st.rsi.refTopNodes || 3)']], ['unit-rankKey']],
    ['SK12', 'src/domain/domain.mjs', [['let refByKey = topK.some((n, i) => n !== topS[i])', 'let refByKey = false']], ['unit-rankKey']],
    ['SK13', 'src/domain/domain.mjs', [['let refByKey = topK.some((n, i) => n !== topS[i])', 'let refByKey = true']], ['unit-rankKey']],
    ['SK14', 'src/domain/domain.mjs', [["',以中性執行之 S 計'", "''"]], ['unit-rankKey']],
    ['SK15', 'src/domain/domain.mjs', [['let sorted = byKey ? sortedK : sortedS', 'let sorted = sortedS']], ['unit-rankKey']],
    ['SK16', 'src/domain/domain.mjs', [['let byKey = sortedK.some((n, i) => n !== sortedS[i])', 'let byKey = true']], ['unit-rankKey']],
    ['SK17', 'src/domain/domain.mjs', [['let keyNoteOf = (n) => (byKey && n.score', 'let keyNoteOf = (n) => (n.score']], ['unit-rankKey']],
    ['SK18', 'src/domain/domain.mjs', [['Math.round(rankKeyOf(n) * 100) !== Math.round(n.score.S * 100)', 'rankKeyOf(n) !== n.score.S']], ['unit-rankKey']],
    ['SK19', 'src/domain/domain.mjs', [['let kbHit = !!kb && ss.length > 0 && kb.score.S !== Math.max(...ss)', 'let kbHit = false']], ['unit-rankKey']],
    ['SK20', 'src/domain/domain.mjs', [['kvOf(n) > kvOf(b) ? n : b', 'kvOf(n) < kvOf(b) ? n : b']], ['unit-rankKey']],
    ['SK21', 'src/domain/domain.mjs', [['if (byKey || armHit) {', 'if (byKey) {']], ['unit-rankKey'], 'equiv'],
    ['SK22', 'src/domain/domain.mjs', [['let best = (xs) => xs.filter((n) => sOf(n) !== null).sort((a, b) => kvOf(b) - kvOf(a))[0] || null', 'let best = (xs) => xs.filter((n) => sOf(n) !== null).sort((a, b) => sOf(b) - sOf(a))[0] || null']], ['unit-rankKey']],
    ['SK23', 'src/domain/domain.mjs', [['let hit = !!n && n !== bestS(xs)', 'let hit = false']], ['unit-rankKey']],
    ['SK24', 'src/domain/domain.mjs', [['        if (keyHits) {', '        if (false) {']], ['unit-rankKey']],
    ['SK25', 'src/domain/domain.mjs', [["byKeyOf(top, cand) ? keyMark(top) : ''", "''"]], ['unit-rankKey']],
    ['SK26', 'src/domain/domain.mjs', [["kHit ? '排序鍵最高' : 'S 最高'", "'S 最高'"]], ['unit-rankKey']],
    ['SK27', 'src/tools/fakeRound.mjs', [['.sort((a, b) => rankKeyOf(b) - rankKeyOf(a) || (a.id < b.id ? -1 : 1))[0] || null', '.sort((a, b) => b.score.S - a.score.S)[0] || null']], ['unit-fakeRound']],
    ['SK28', 'src/domain/domain.mjs', [['let keyMark = (n) => `〔依排序鍵 ${f1(kvOf(n))}〕`', "let keyMark = (n) => ''"]], ['unit-rankKey']],
    ['SK29', 'src/domain/domain.mjs', [['return vs.every((v) => v === vs[0]) ? vs[0] : vs.reduce(', 'return vs.reduce(']], ['unit-rankKey']], //各抽全相同時取該值本身(複審所見;不留和除以抽數之 1 ULP 尾差)
    //── 輪末之附算一併處理待補算(BL 系列; 規則 R-REC-41; domain.mjs 之 fill / afterRound、fillPlan.mjs、texts.mjs)──
    ['BL01', 'src/domain/domain.mjs', [['if (Number.isFinite(backlogSec) && backlogSec > 0 && Array.isArray(targets)) {', 'if (false) {']], ['unit-fillBacklog']],
    ['BL02', 'src/domain/domain.mjs', [['.filter((id) => !inRetry.has(id)))', ')']], ['unit-fillBacklog']],
    ['BL03', 'src/domain/domain.mjs', [['let order = nodes.map((n) => n.id).filter((id) => blIds.has(id))', 'let order = [...blIds].sort()']], ['unit-fillBacklog']],
    ['BL04', 'src/domain/domain.mjs', [['let capped0 = () => next >= nMain && clockOf() - tCap0 >= backlogSec * 1000', 'let capped0 = () => false']], ['unit-fillBacklog']],
    ['BL05', 'src/domain/domain.mjs', [["let clockOf = typeof inject.clock === 'function' ? inject.clock : () => Date.now()", 'let clockOf = () => Date.now()']], ['unit-fillBacklog']],
    ['BL06', 'src/domain/domain.mjs', [['let blDone = new Set(tasks.slice(nMain, Math.max(nMain, Math.min(next, tasks.length))).map((x) => x.nodeId))', 'let blDone = new Set()']], ['unit-fillBacklog']],
    ['BL07', 'src/domain/domain.mjs', [['...(blTasks.length || nSkipBl ? { backlogRun:', '...(false ? { backlogRun:']], ['unit-fillBacklog']],
    ['BL08', 'src/domain/domain.mjs', [['backlogSec: fillBacklogSecOf(st.rsi), ', '']], ['unit-fillBacklog']],
    ['BL09', 'src/domain/fillPlan.mjs', [['iseint(v) && Number(v) >= 0 ? Number(v) : FILL_BACKLOG_SEC', 'iseint(v) ? Number(v) : FILL_BACKLOG_SEC']], ['unit-fillBacklog']],
    ['BL10', 'src/domain/fillPlan.mjs', [['let FILL_BACKLOG_SEC = 1800', 'let FILL_BACKLOG_SEC = 0']], ['unit-fillBacklog']],
    ['BL11', 'src/domain/fillPlan.mjs', [["    if (br && typeof br === 'object') {", '    if (false) {']], ['unit-fillBacklog']],
    ['BL12', 'src/domain/texts.mjs', [['let backlogOn = fillBacklogSecOf(st.rsi) > 0 && !(st.rsi && st.rsi.autoFill === false)', 'let backlogOn = fillBacklogSecOf(st.rsi) > 0']], ['unit-fillBacklog']],
    ['BL13', 'src/domain/texts.mjs', [['(backlogOn ? FILL_BACKLOG_ON : FILL_BACKLOG_OFF)', '(FILL_BACKLOG_OFF)']], ['unit-fillBacklog', 'unit-dreamOnly']],
    ['BL14', 'src/domain/domain.mjs', [['if (next >= tasks.length || capped0()) {', 'if (next >= tasks.length) {']], ['unit-fillBacklog']],
    ['BL15', 'src/domain/domain.mjs', [['while (next < tasks.length && !capped0()) {', 'while (next < tasks.length) {']], ['unit-fillBacklog']],
    ['BL16', 'src/domain/domain.mjs', [['let tasks = blTasks.length ? [...plan.tasks, ...blTasks] : plan.tasks', 'let tasks = plan.tasks']], ['unit-fillBacklog']],
    //不重試之失敗之紀錄(R-REC-41 之補充): 略過之判定、記入、移除、只限輪末之一併處理、狀態檔之比較與寫法、摘要
    ['BL17', 'src/domain/domain.mjs', [['if (blRec.has(tk.nodeId) && blRec.get(tk.nodeId) === fillSigOf(tk)) {', 'if (false) {']], ['unit-fillBacklog']],
    ['BL18', 'src/domain/domain.mjs', [['if (blRec.has(tk.nodeId) && blRec.get(tk.nodeId) === fillSigOf(tk)) {', 'if (blRec.has(tk.nodeId)) {']], ['unit-fillBacklog']],
    ['BL19', 'src/domain/domain.mjs', [['for (let x of results.filter((r) => FILL_NO_RETRY_KINDS.includes(r.kind))) {', 'for (let x of []) {']], ['unit-fillBacklog']],
    ['BL20', 'src/domain/domain.mjs', [["sig: fillSigOf(tk, { postfit: x.postfit === 'failed', ext: x.ext.failed })", 'sig: fillSigOf(tk)']], ['unit-fillBacklog']],
    ['BL21', 'src/domain/domain.mjs', [['                    if (!still.has(id)) {', '                    if (false) {']], ['unit-fillBacklog']],
    ['BL22', 'src/domain/domain.mjs', [['let tasks = blTasks.length ? [...plan.tasks, ...blTasks] : plan.tasks', 'let tasks = [...plan.tasks.filter((t) => !fsr.blocked.some((b) => b.id === t.nodeId && b.sig === fillSigOf(t))), ...blTasks]']], ['unit-fillBacklog']],
    ['BL23', 'src/domain/domain.mjs', [['retryInfo, blockedInfo])', 'retryInfo, stOld.blocked === undefined ? [] : stOld.blocked])']], ['unit-fillBacklog']],
    ['BL24', 'src/domain/domain.mjs', [['...(blockedInfo.length ? { blocked: blockedInfo } : {})', 'blocked: blockedInfo']], ['unit-fillBacklog']],
    ['BL25', 'src/domain/domain.mjs', [['blocked: blockedOf(o.blocked), note: null', 'blocked: [], note: null']], ['unit-fillBacklog']],
    ['BL26', 'src/domain/domain.mjs', [['...(nSkipBl ? { skipped: nSkipBl } : {})', '']], ['unit-fillBacklog']],
    ['BL27', 'src/domain/fillPlan.mjs', [["(nSk || nFail ? '' : ';已補齊')", "';已補齊'"]], ['unit-fillBacklog']], //本輪(tad199b)隨「已補齊」之條件加 nFail 而錨點隨之
    ['BL28', 'src/domain/fillPlan.mjs', [["['pick', 'evaluator', 'diag', 'nulls'].map(", "['pick', 'evaluator', 'nulls'].map("]], ['unit-fillBacklog']],
    //── 迴圈之重放一併載入擴充診斷(RX 系列; 規則 R-REC-42; verify.mjs 之 replicaExtOf / replicaExtArgsOf / replayExtOf / boardMeanOf / extBoardMeansOf / makeVerify / notesOf、domain.mjs 之看板)──
    ['RX01', 'src/domain/verify.mjs', [["v.every((s) => typeof s === 'string' && s.length > 0 && !/[,\\s]/.test(s))", "v.every((s) => typeof s === 'string')"]], ['unit-replayExt']],
    ['RX02', 'src/domain/verify.mjs', [["let REPLICA_EXT = 'board'", "let REPLICA_EXT = 'none'"]], ['unit-replayExt']],
    ['RX03', 'src/domain/verify.mjs', [["    if (scope === 'all') {\n        return []\n    }", '    if (false) {\n        return []\n    }']], ['unit-replayExt']],
    ['RX04', 'src/domain/verify.mjs', [["let names = scope === 'board' ? [...extSurfaceOf(m).cells.map((c) => c.name),", "let names = scope === 'board' ? [...Object.keys((m && m.ext) || {}),"]], ['unit-replayExt']],
    ['RX05', 'src/domain/verify.mjs', [[".filter((nm) => nm !== 'nullRecentAct' && !/[,\\s]/.test(nm))", ".filter((nm) => nm !== 'nullRecentAct')"]], ['unit-replayExt']],
    ['RX06', 'src/domain/verify.mjs', [[".filter((nm) => nm !== 'nullRecentAct' && !/[,\\s]/.test(nm))", '.filter((nm) => !/[,\\s]/.test(nm))']], ['unit-replayExt']],
    ['RX07', 'src/domain/verify.mjs', [['if (delta !== null) {', 'if (false) {']], ['unit-replayExt']], //replayExtOf 改取 neutralDeltaOf(diagRead.mjs; Gitea #199 主控之裁定 1; 錨點隨之)
    ['RX08', 'src/domain/diagRead.mjs', [['!Array.isArray(e) && !e.error && Number.isFinite(e.delta)', '!Array.isArray(e) && Number.isFinite(e.delta)']], ['unit-replayExt']], //neutralDeltaOf 之 error 判定(重放之紀錄經 replayExtOf 取之)
    ['RX09', 'src/domain/verify.mjs', [['parts.some((p) => p.tpl !== parts[0].tpl)', 'false']], ['unit-replayExt']],
    ['RX10', 'src/domain/verify.mjs', [["let dec = Math.max(...parts.map((p) => (p.nums[i].split('.')[1] || '').length))", 'let dec = 1']], ['unit-replayExt']],
    ['RX11', 'src/domain/verify.mjs', [['return /^-0(\\.0*)?$/.test(s) ? s.slice(1) : s', 'return s']], ['unit-replayExt']],
    ['RX12', 'src/domain/verify.mjs', [["let rx = rxScope === 'none' ? null : replayExtOf(o.metrics)", 'let rx = replayExtOf(o.metrics)']], ['unit-replayExt']],
    ['RX13', 'src/domain/verify.mjs', [["&& extArgs.join(' ') !== extArgs0.join(' ')) {", '&& false) {']], ['unit-replayExt']],
    ['RX14', 'src/domain/verify.mjs', [['let rs = await replayOf(i, fpS, extArgs)', 'let rs = await replayOf(i, fpS, extArgs0)']], ['unit-replayExt']],
    ['RX15', 'src/domain/verify.mjs', [['${rp}${xmText} ——', '${rp} ——']], ['unit-replayExt']],
    ['RX16', 'src/domain/domain.mjs', [['/ ${mean([r0, ...rp.map((x) => x.recent)])}${xm ? `;${xm}` : \'\'}`', '/ ${mean([r0, ...rp.map((x) => x.recent)])}`']], ['unit-replayExt']],
    ['RX17', 'src/domain/domain.mjs', [["${anyXm ? ';擴充診斷之看板值之均' : ''}", '']], ['unit-replayExt']],
    ['RX18', 'src/domain/domain.mjs', [["${x.n < 1 + rp.length ? `(${x.n} 抽)` : ''}", '']], ['unit-replayExt']],
    ['RX19', 'src/domain/verify.mjs', [['out[c.name] = { board: c.value }', 'out[c.name] = { board: m.ext[c.name].board }']], ['unit-replayExt']],
    ['RX20', 'src/domain/verify.mjs', [['if (parts[0].nums.length === 0 || ', 'if (']], ['unit-replayExt']],
    ['RX21', 'src/domain/verify.mjs', [["let rp = Array.isArray(replays) ? replays.filter((x) => x && x.ext && typeof x.ext === 'object') : []", 'let rp = Array.isArray(replays) ? replays.filter(Boolean) : []']], ['unit-replayExt']],
    ['RX22', 'src/domain/domain.mjs', [['        if (anyXm) {', '        if (false) {']], ['unit-replayExt']],
    //── 近期活躍度版之診斷之「有值」之唯一判準(DR 系列; R-REC-38 ⑦; recentDiagOf 於 diagRead.mjs; 驗證之兩處與共同儲存區之一處共用; Gitea #199 之主控另加; 既有之 M06、M08、J05 之錨點隨函數移至 diagRead.mjs)──
    ['DR01', 'src/domain/diagRead.mjs', [['Number.isFinite(s.excess) ? s : null', "typeof s.excess === 'number' ? s : null"]], ['unit-recentDiag', 'unit-searchMapRecent']], //NaN / ±Infinity 之超額亦視為有值
    ['DR02', 'src/domain/verify.mjs', [["${recentDiagOf(m) ? `(正本 ${f1(recentDiagOf(m).excess)})` : ''}", "${m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side && typeof m.ext.nullRecentAct.side.excess === 'number' ? `(正本 ${f1(m.ext.nullRecentAct.side.excess)})` : ''}"]], ['unit-recentDiag']], //節點文件之重放一列改回內嵌之舊判準
    ['DR03', 'src/domain/verify.mjs', [['let nr = recentDiagOf(o.metrics) //', 'let nr = o.metrics.ext && o.metrics.ext.nullRecentAct && o.metrics.ext.nullRecentAct.side //'], ['recent: nr ? nr.excess : null', "recent: nr && typeof nr.excess === 'number' ? nr.excess : null"]], ['unit-replayExt']], //重放之紀錄改回內嵌之舊判準
    ['DR04', 'src/domain/pickStore.mjs', [['let nr = recentDiagOf(m) || {} //', 'let nr = (m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side) || {} //']], ['unit-recentDiag']], //共同儲存區改回內嵌之舊判準
    ['DR05', 'src/domain/pickStore.mjs', [['let nr = recentDiagOf(m) || {} //', 'let nr = (recentDiagOf(m) && Number.isFinite(recentDiagOf(m).p) ? recentDiagOf(m) : null) || {} //']], ['unit-recentDiag']], //共同儲存區另要求 p 為有限數值(只讀超額之處不要求 p)
    ['DR06', 'src/domain/verify.mjs', [['${recentDiagOf(m) ? `(正本', '${recentDiagOf(m) && Number.isFinite(recentDiagOf(m).p) ? `(正本']], ['unit-recentDiag', 'unit-replayExt']], //節點文件之重放一列另要求 p 為有限數值
    ['DR07', 'src/domain/verify.mjs', [['recent: nr ? nr.excess : null', 'recent: nr && Number.isFinite(nr.p) ? nr.excess : null']], ['unit-replayExt']], //重放之紀錄另要求 p 為有限數值
    //── 變異工具之編號唯一(UQ 系列; R-PKG-9; --check 另核編號唯一; Gitea #199 之主控另加; 錨點含換行以免與本表之列自身相符)──
    ['UQ01', 'test/tools/mutateIds.mjs', [['if (seen.has(id) && !dup.includes(id)) {', 'if (false) {']], ['unit-mutateIds']],
    ['UQ02', 'test/tools/mutateIds.mjs', [['if (seen.has(id) && !dup.includes(id)) {', 'if (seen.has(id)) {']], ['unit-mutateIds']], //三次出現者列兩次
    ['UQ03', 'test/tools/mutateBar.mjs', [['    let dup = dupIdsOf(M)\n    if (dup.length) {', '    let dup = []\n    if (dup.length) {']], ['unit-mutateIds']],
    ['UQ04', 'test/tools/mutateBar.mjs', [["${dup.join('、')}`)\n        process.exit(1)", "${dup.join('、')}`)\n        process.exit(0)"]], ['unit-mutateIds']],
    ['UQ05', 'test/tools/mutateBar.mjs', [["${dup.join('、')}`)\n        process.exit(1)", '`)\n        process.exit(1)']], ['unit-mutateIds']], //不列重複之編號
    ['UQ06', 'test/tools/mutateBar.mjs', [['    console.log(`編號唯一: ${M.length} 項`)\n}', '}']], ['unit-mutateIds']],
    ['UQ07', 'test/tools/mutateStart.mjs', [['    let dup = dupIdsOf(M)\n    if (dup.length) {', '    let dup = []\n    if (dup.length) {']], ['unit-mutateIds']],
    ['UQ08', 'test/tools/mutateStart.mjs', [["${dup.join('、')}`)\n        process.exit(1)", "${dup.join('、')}`)\n        process.exit(0)"]], ['unit-mutateIds']],
    ['UQ09', 'test/tools/mutateStart.mjs', [["${dup.join('、')}`)\n        process.exit(1)", '`)\n        process.exit(1)']], ['unit-mutateIds']],
    ['UQ10', 'test/tools/mutateStart.mjs', [['    console.log(`編號唯一: ${M.length} 項`)\n}', '}']], ['unit-mutateIds']],
    ['UQ11', 'test/tools/mutateBar.mjs', [['if (check) {\n    let dup', 'if (false) {\n    let dup']], ['unit-mutateIds']], //只在 --check 之外才核(此處改為從不核)
    //── 本次取用之待補算中有失敗者不寫「已補齊」(BF 系列; R-REC-41 ⑧; Gitea #199 主控之裁定 2)──
    ['BF01', 'src/domain/fillPlan.mjs', [["(nSk || nFail ? '' : ';已補齊')", "(nSk ? '' : ';已補齊')"]], ['unit-fillBacklog']], //有失敗者仍寫「已補齊」
    ['BF02', 'src/domain/fillPlan.mjs', [["${nFail ? `;本次取用者中 **${nFail} 個失敗**(失敗者見「附算」與「附算之失敗而不重試」之列)` : ''}", '']], ['unit-fillBacklog']], //不註失敗之個數
    ['BF03', 'src/domain/fillPlan.mjs', [['let nFail = Number.isInteger(br.failed) && br.failed > 0 ? br.failed : 0', 'let nFail = br.failed || 0']], ['unit-fillBacklog']], //非正整數者亦採
    ['BF04', 'src/domain/domain.mjs', [['results.filter((x) => blDone.has(x.nodeId) && (x.postfit', 'results.filter((x) => (x.postfit']], ['unit-fillBacklog']], //本次之範圍內之成品之失敗亦計
    ['BF05', 'src/domain/domain.mjs', [["(x.postfit === 'failed' || (x.ext && x.ext.failed.length > 0))).length", '(x.ext && x.ext.failed.length > 0)).length']], ['unit-fillBacklog']], //不計求解窗後段之失敗
    ['BF06', 'src/domain/domain.mjs', [["(x.postfit === 'failed' || (x.ext && x.ext.failed.length > 0))).length", "x.postfit === 'failed').length"]], ['unit-fillBacklog']], //不計擴充診斷之失敗
    ['BF07', 'src/domain/domain.mjs', [['...(nFailBl ? { failed: nFailBl } : {})', 'failed: nFailBl']], ['unit-fillBacklog']], //無失敗者亦帶 failed(0)
    //── 重放另載入正本之 neutralExec(NX 系列; R-REC-42 ①; Gitea #199 主控之裁定 1)──
    ['NX01', 'src/domain/verify.mjs', [["...(neutralDeltaOf(m) !== null ? ['neutralExec'] : [])", '...[]']], ['unit-replayExt']], //board 不另加 neutralExec
    ['NX02', 'src/domain/verify.mjs', [["...(neutralDeltaOf(m) !== null ? ['neutralExec'] : [])", "...['neutralExec']"]], ['unit-replayExt']], //不論正本有無值皆加
    ['NX03', 'src/domain/verify.mjs', [['(Array.isArray(scope) ? scope : [])', "(Array.isArray(scope) ? [...scope, ...(neutralDeltaOf(m) !== null ? ['neutralExec'] : [])] : [])"]], ['unit-replayExt']], //名之陣列亦自動加
    ['NX04', 'src/domain/verify.mjs', [["let names = scope === 'board' ?", "let names = scope === 'board' || scope === 'none' ?"]], ['unit-replayExt']], //none 亦載入看板值之診斷與 neutralExec
    ['NX05', 'src/domain/verify.mjs', [['out.neutralExec = { ...(out.neutralExec || {}), delta }', 'out.neutralExec = { delta }']], ['unit-replayExt']], //紀錄之 neutralExec 丟掉看板值
    ['NX06', 'src/domain/verify.mjs', [["let ns = [...new Set(names.filter((nm) => nm !== 'nullRecentAct' && !/[,\\s]/.test(nm)))].sort()", "let ns = names.filter((nm) => nm !== 'nullRecentAct' && !/[,\\s]/.test(nm)).sort()"]], ['unit-replayExt']], //不去重(有看板值又有 delta 之 neutralExec 列兩次)
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
//--check 另核全部變異之編號唯一(不受 --only / --from / --to 限制; 重複者列出並以非 0 離開; 規則 R-PKG-9): 編號重複時 --only 會同時植入兩項, 錨點之核對偵不出
if (check) {
    let dup = dupIdsOf(M)
    if (dup.length) {
        console.log(`編號重複(各編號須唯一): ${dup.join('、')}`)
        process.exit(1)
    }
    console.log(`編號唯一: ${M.length} 項`)
}

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
let runMocha = (files, extra = []) => spawnSync(process.execPath, [mocha, ...extra, '--no-parallel', ...files, '--timeout', '180000'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ARSI_ROOT: '' } })
let testRel = (g) => path.join('test', `${g}.test.mjs`)
let testHas = (g) => fs.existsSync(path.join(root, testRel(g)))
let failOf = (out) => {
    let fail = /\n\s+1\) ([^\n]+)\n\s+([^\n]+)/.exec(out)
    return fail ? `${fail[1]} / ${fail[2]}`.slice(0, 140) : out.slice(-200).replace(/\s+/g, ' ')
}
let badHint = new Map() //於對照即失敗之優先測試 → 失敗摘要
if (!check) {
    let r = runMocha(GUARDS.filter(testHas).map(testRel))
    let m = /(\d+) passing/.exec(`${r.stdout}`)
    console.log(`對照(無變異之複本): ${r.status === 0 ? '全綠' : '失敗(變異之結果不可信,中止)'}${m ? `,${m[1]} 項通過` : ''}`)
    if (r.status !== 0) {
        console.log(`${r.stdout}\n${r.stderr}`.slice(-1500))
        fs.rmSync(root, { recursive: true, force: true })
        process.exit(3)
    }
    //所選變異之優先測試(不在守門之內者): 各單獨跑一次, 失敗者其變異記為 UNDECIDABLE
    for (let g of new Set(sel.flatMap((x) => x.m[3]).filter((x) => !GUARDS.includes(x) && testHas(x)))) {
        let rg = runMocha([testRel(g)])
        let mg = /(\d+) passing/.exec(`${rg.stdout}`)
        if (rg.status !== 0) {
            badHint.set(g, failOf(`${rg.stdout}\n${rg.stderr}`))
        }
        console.log(`對照(優先測試 ${g}): ${rg.status === 0 ? '全綠' : `失敗(以之為優先測試之變異記為 UNDECIDABLE;${badHint.get(g)})`}${mg ? `,${mg[1]} 項通過` : ''}`)
    }
    if (args.includes('--control-only')) {
        let und = sel.filter((x) => x.m[3].some((g) => badHint.has(g)))
        console.log(`\n僅對照(--control-only): 所選 ${sel.length} 項中 UNDECIDABLE(無法判定) ${und.length} 項${und.length ? `: ${und.map((x) => x.m[0]).join('、')}` : ''}`)
        fs.rmSync(root, { recursive: true, force: true })
        process.exit(und.length > 0 ? 1 : 0)
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
        let bad = hint.filter((g) => badHint.has(g))
        if (check) {
            o.status = 'anchor-ok'
        }
        else if (bad.length) {
            //優先測試於對照(無變異之複本)即失敗 ⇒ 其於本變異下之失敗無從歸因(可能與變異無關): 不植入、不記為被殺, 記為無法判定
            o.status = 'UNDECIDABLE'
            o.by = `優先測試於對照即失敗: ${bad.map((g) => `${g}(${badHint.get(g)})`).join('、')}`.slice(0, 200)
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
console.log(`\n共 ${results.length} 項:killed ${st('killed')}、equivalent(等價變異,預期存活)${st('equivalent')}、SURVIVED ${st('SURVIVED')}、UNDECIDABLE(無法判定: 優先測試於對照即失敗,未植入) ${st('UNDECIDABLE')}、ANCHOR-ERROR ${st('ANCHOR-ERROR')}${check ? `、anchor-ok ${st('anchor-ok')}` : ''}`)
if (argv('out')) {
    fs.writeFileSync(path.resolve(String(argv('out'))), JSON.stringify(results, null, 2), 'utf8')
}
process.exit(st('SURVIVED') + st('ANCHOR-ERROR') + st('UNDECIDABLE') > 0 ? 1 : 0)
