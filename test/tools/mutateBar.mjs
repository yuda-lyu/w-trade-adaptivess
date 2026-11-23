/* eslint-disable quotes, no-template-curly-in-string -- 本檔之字串多為「原始碼之片段」(含單引號與 ${…}), 以雙引號書寫以免逐一跳脫 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { FD_ROOT, FD_TMP } from './synthLedger.mjs'
import { dupIdsOf } from './mutateIds.mjs'


//變異檢查(規則 R-EV-44、R-REC-36、R-REC-34 之守門之鑑別力; Gitea #184; Q 系列為 R-EV-46 之 api.fillRandom; M 系列為 R-REC-38、R 系列為 R-BT-6; G、H 系列為 R-RUN-11、N、O 系列為 R-BT-7、U 系列為 R-REC-39; Y 系列為搜尋樣式取自檔(verifyCmdScan.mjs 之 patFileOf)、J 系列為近期版之超額之取值(domain.mjs 之 recentDiagOf / recentExcessOf)、Z 系列為迴圈專用之環境變數(verify.mjs 之 forbiddenPats; 皆為 Gitea #198 之主控另加之三項); SK 系列為 R-REC-40(排序鍵)、BL 系列為 R-REC-41(輪末之附算一併處理待補算; BL17 起為不重試之失敗之紀錄)、RX 系列為 R-REC-42(迴圈之重放一併載入擴充診斷); DR 系列為 R-REC-38 ⑦(近期活躍度版之診斷之「有值」之唯一判準; diagRead.mjs 之 recentDiagOf 與驗證、共同儲存區之讀取點)、UQ 系列為 R-PKG-9(變異工具之 --check 另核編號唯一; 皆為 Gitea #199 之主控另加); EH 系列為 R-REC-43、R-REC-44(迴圈檢查之提示「單峰交付」「選集與他節點相同」; 判定在 verifyEvalHints.mjs, EH37 之錨點在 verify.mjs 之 dirNodeIdsOf); VZ 系列為 R-BT-10(節點之禁區涵蓋 verify* / backtest* 與任務書之檔名樣式一致)、AW 系列為 R-BT-9(可讀之他節點工作夾三處共用 verify.mjs 之 allowWorkOf; 皆為 Gitea #200 之主控另加); SD 系列為 R-REC-47(任務書之「可疑方向」、資訊來源之三級、量尺句、審組成之一句與合約之判讀名詞; 錨點在 texts.mjs 與 contract/pick-contract.md); SB 系列為 R-EV-47(子庫之規則與 --subset)與 R-EV-48(庫況體檢與其拒跑);EX 系列為 R-REC-48(側別曝險之判定、效果與放行)、SR 系列為 R-REC-50(全樹之側別讀數)、GD 系列為 R-REC-49(量尺之並列與選配之主鍵); MC 系列為 R-REC-51(成員穩健性之附算與「成員依賴」之提示)、PD 系列為 R-REC-51 ⑤(附算之時點: 求解窗後段與成員穩健性移到派做夢之前、同一項每輪至多一次、紀錄每輪記一次)、HC 系列為 R-REC-49 ⑤(「有內容」之單一定義: 並列、主鍵、補位之底、估法之候選)、VZ08 為 R-BT-10 ⑥(成員依賴之判定與門檻在禁區內之檔); 指令解析已自 verify.mjs 搬入 verifyCmdScan.mjs[原 cmdScan.mjs], 錨點之檔隨之): 於 test/_tmp/ 之複本逐一植入一處變異(把新檢測或新接線改回舊行為, 或改成錯的寫法), 跑守門之測試, 須轉紅(被殺)
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
    ['B10', 'src/eval/barGrid.mjs', [["    evalNumsOf(st && st.eval, bpd, 'eval')", '    void 0']], ['unit-evalNums']],
    ['B11', 'src/eval/barGrid.mjs', [['        if (!Number.isInteger(out[k] * bpd)) {', '        if (false) {']], ['unit-evalNums']],
    ['B12', 'src/eval/barGrid.mjs', [['Number.isInteger(out[k] * bpd)', 'Number.isInteger(out[k])']], ['unit-evalNums']],
    ['B13', 'src/eval/barGrid.mjs', [[".replace(/^invalid cfg\\./, 'invalid eval.')", ".replace(/^invalid cfg\\./, 'invalid cfg.')"]], ['unit-evalNums']],
    ['B14', 'src/eval/barGrid.mjs', [['|opt\\.nullDraws|--null)', '|opt\\.nullDraws)']], ['unit-evalNums']],
    ['B15', 'src/eval/barGrid.mjs', [['let periodAt = (st, seg, end) => objOf(periodsOf(st)[seg])[end]', 'let periodAt = (st, seg, end) => periodsOf(st)[seg][end]']], ['unit-evalNums']],
    ['B16', 'src/eval/barGrid.mjs', [['    let tr = objOf(periodsOf(st).train)', '    let tr = periodsOf(st).train']], ['unit-evalNums']],
    //── cfgNum.mjs ──
    ['C01', 'src/eval/cfgNum.mjs', [['Number.isFinite(x) && k[1](x)', 'Number.isFinite(x)']], ['unit-evalNums']],
    ['C02', 'src/eval/cfgNum.mjs', [['    if (v === undefined || v === null) {\n        return def\n    }\n    let x =', '    if (v === undefined) {\n        return def\n    }\n    let x =']], ['unit-evalNums']],
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
    ['V02', 'src/cli/eval.mjs', [['horizons: evLists.horizons, nullDraws: evNums.nullDraws }', 'horizons: evLists.horizons, nullDraws: st.eval.nullDraws }']], ['unit-evalNums'], 'equiv'],
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
    ['K06', 'src/cli/backtest.mjs', [["        gridCheck(periodAt(st, 'backtest', 'end'), L.meta, 'periods.backtest.end')", '        void 0']], ['unit-barHours', 'unit-backtestEnd']],
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
    ['T12', 'src/domain/texts.mjs', [["等效年化之${ph('相位')}平均 + 0.3 × 最差相位。**你的目標", '等效年化之七相位平均 + 0.3 × 最差相位。**你的目標']], ['unit-factsResidue']],
    ['T13', 'src/domain/texts.mjs', [["日新鮮度之${ph('相位')}平均皆", '日新鮮度之七相位平均皆']], ['unit-factsResidue']],
    ['T14', 'src/domain/texts.mjs', [["鄰近之參數、${ph('個相位')}都同向", '鄰近之參數、七個相位都同向']], ['unit-factsResidue']],
    ['T15', 'src/domain/texts.mjs', [["${ph('個相位')}同向比平均高更重要", '七個相位同向比平均高更重要']], ['unit-factsResidue']],
    ['T16', 'src/domain/texts.mjs', [["完整評估(回測期;${ph('相位')} + 虛無", '完整評估(回測期;七相位 + 虛無']], ['unit-factsResidue']],
    ['T17', 'src/domain/texts.mjs', [["${ph('個相位')}同向比平均高更重要", "七個相位同向比平均高更重要"]], ['unit-factsResidue']],
    ['T18', 'src/domain/texts.mjs', [["**評估期 = 回測期 ${pBt}**;${ph('相位')};挑選函數", '**評估期 = 回測期 ${pBt}**;七相位;挑選函數']], ['unit-factsResidue']],
    ['T19', 'src/domain/texts.mjs', [["' + ph('個相位') + '是否同向(節點文件", '七個相位是否同向(節點文件']], ['unit-factsResidue']],
    ['T20', 'src/domain/texts.mjs', [["例:鄰點之' + ph('相位') + '平均", '例:鄰點之七相位平均']], ['unit-factsResidue']],
    ['T21', 'src/domain/texts.mjs', [["回測期 S、' + ph('相位') + '、挑選內容", '回測期 S、七相位、挑選內容']], ['unit-factsResidue']],
    ['T22', 'src/domain/texts.mjs', [["幾何對照(' + nDraws + ' 抽)為準", '幾何對照(64 抽)為準']], ['unit-factsResidue']],
    //── factsText.mjs ──
    ['F01', 'src/eval/cfgNum.mjs', [["n >= 1 && n <= 10 ? '一二三四五六七八九十'[n - 1]", "n >= 1 && n <= 7 ? '一二三四五六七八九十'[n - 1]"]], ['unit-factsResidue']],
    ['F02', 'src/domain/factsText.mjs', [['(1 / (1 + draws))', '(1 / draws)']], ['unit-factsResidue']],
    ['F03', 'src/eval/cfgNum.mjs', [['ev.phases.length > 0 ? ev.phases.length : 7', 'ev.phases.length > 0 ? 7 : 7']], ['unit-factsResidue']],
    //F04、F05 單獨為等價變異(互相遮蔽): cadenceOf 與 nullDrawsOf 皆經 evalCfgNumsOf 檢測「全部五個鍵」, 任務書同時呼叫兩者, 改壞其一時另一個仍拋; F06 為兩者同時改壞
    ['F04', 'src/domain/factsText.mjs', [["let cadenceOf = (ev) => evalCfgNumsOf(ev, 'eval').cadenceDays", 'let cadenceOf = (ev) => (ev && Number(ev.cadenceDays)) || 7']], ['unit-factsResidue'], 'equiv'],
    ['F05', 'src/domain/factsText.mjs', [["let nullDrawsOf = (ev) => evalCfgNumsOf(ev, 'eval').nullDraws", 'let nullDrawsOf = (ev) => (ev && Number(ev.nullDraws)) || 64']], ['unit-factsResidue'], 'equiv'],
    ['F07', 'src/domain/factsText.mjs', [["let cadenceOf = (ev) => evalCfgNumsOf(ev, 'eval').cadenceDays", 'let cadenceOf = (ev) => (ev && Number(ev.cadenceDays)) || 7'], ["let nullDrawsOf = (ev) => evalCfgNumsOf(ev, 'eval').nullDraws", 'let nullDrawsOf = (ev) => (ev && Number(ev.nullDraws)) || 64']], ['unit-factsResidue']],
    ['F06', 'src/eval/cfgNum.mjs', [['`${n} `) + tail', '`${n}`) + tail']], ['unit-factsResidue']],
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
    ['X01', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs']", 'let EVAL_FP_SKIP = []']], ['unit-evalFingerprint']],
    ['X02', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs']", "let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs', 'evalCore.mjs']"]], ['unit-evalFingerprint']],
    ['X03', 'src/domain/fillKeys.mjs', [['&& !EVAL_FP_SKIP.includes(f))', '&& EVAL_FP_SKIP.includes(f))']], ['unit-evalFingerprint']],
    ['X04', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs']", "let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs', 'barGrid.mjs']"]], ['unit-evalFingerprint']],
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
    ['M01', 'src/domain/domain.mjs', [['return s.builtin && s.recentOk !== false && extSurfaceOf(m).notContent.length === 0', 'return s.builtin && extSurfaceOf(m).notContent.length === 0']], ['unit-searchMapRecent']], //錨點隨「有內容」上提為模組層之單一定義(R-REC-49 ⑤; hasContentOf)而改; 語意不變
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
    ['M14', 'src/domain/domain.mjs', [["let contentPMax = () => evalScoreOf(st.score, 'score').ladder1.nullP || 0.05", 'let contentPMax = () => 0.05']], ['unit-searchMapRecent']],
    ['M15', 'src/domain/domain.mjs', [["c.excess > 0 && typeof c.p === 'number' && c.p <= pMax", "c.excess >= 0 && typeof c.p === 'number' && c.p <= pMax"]], ['unit-searchMapRecent']],
    ['M16', 'src/domain/domain.mjs', [["c.excess > 0 && typeof c.p === 'number' && c.p <= pMax", "c.excess > 0 && typeof c.p === 'number' && c.p < pMax"]], ['unit-searchMapRecent']],
    ['M17', 'src/domain/domain.mjs', [['c.share >= 0.8)', 'c.share > 0.8)']], ['unit-searchMapRecent']],
    ['M18', 'src/domain/domain.mjs', [['let nRecent = nodes.filter((n) => recentSideOf(n.raw && n.raw.metrics)).length', 'let nRecent = nodes.filter((n) => actSplitOf(n)).length']], ['unit-searchMapRecent']],
    ['M19', 'src/domain/domain.mjs', [['return s.builtin && s.recentOk !== false && extSurfaceOf(m).notContent.length === 0', 'return (s.builtin || s.recentOk === true) && extSurfaceOf(m).notContent.length === 0']], ['unit-searchMapRecent']], //錨點同 M01 而改; 語意不變
    //── 操作掃描之「列出工作夾之根」只列以之為目標者(規則 R-BT-6; verifyCmdScan.mjs 之 listRootExempt 與 verify.mjs 之 scanTrace 接線)──
    //  R01 / R02 免列之接線(只限指令之欄); R03 ~ R06 搜尋指令之辨識; R07 ~ R09、R34 ~ R43、R46 / R47 樣式引數之定位(位置、-e、--regexp、帶值之選項、-f、findstr、Select-String、--、分段、選項表);
    //  R10 / R44 殘留與樣式含字樣之段; R12 ~ R16、R29 ~ R31 路徑引數之核對(上層、無路徑、讀標準輸入、遞迴、萬用字元、~); R17 ~ R28、R45、R48 保守回退(引號、變數、命令替換、跳脫、切換目錄、工作目錄、重導向、佔位符之控制字元)
    //  R11 為等價變異: 「樣式含字樣之段為 0 而殘留不命中」不可達(殘留 = 全部之字去掉樣式, 原指令之命中處若不在被去掉之樣式內即仍在殘留內); 保留以記錄此防線
    ['R01', 'src/domain/verify.mjs', [["if (reListRoot && reListRoot.test(v) && !(k === 'command' && listRootExempt(", 'if (reListRoot && reListRoot.test(v) && !(false && listRootExempt(']], ['unit-scanListRoot']],
    ['R02', 'src/domain/verify.mjs', [["!(k === 'command' && listRootExempt(", '!(listRootExempt(']], ['unit-scanListRoot']],
    ['R03', 'src/domain/verifyCmdScan.mjs', [['(?:grep|egrep|fgrep)', '(?:grepX|egrepX|fgrepX)']], ['unit-scanListRoot']],
    ['R04', 'src/domain/verifyCmdScan.mjs', [[')?rg(?:', ')?rgX(?:']], ['unit-scanListRoot']],
    ['R05', 'src/domain/verifyCmdScan.mjs', [[')?findstr(?:', ')?findstrX(?:']], ['unit-scanListRoot']],
    ['R06', 'src/domain/verifyCmdScan.mjs', [['(?:select-string|sls)', '(?:select-stringX|slsX)']], ['unit-scanListRoot']],
    ['R07', 'src/domain/verifyCmdScan.mjs', [['        pats.push(ops.shift())\n    }\n    return { pats, paths: ops.map((k) => ws[k]), stdin: tb.stdinOk', '        ops.shift()\n    }\n    return { pats, paths: ops.map((k) => ws[k]), stdin: tb.stdinOk']], ['unit-scanListRoot']],
    ['R08', 'src/domain/verifyCmdScan.mjs', [["                if (c === 'e') {\n                    pats.push(vi)\n                }", '                if (false) {\n                    pats.push(vi)\n                }']], ['unit-scanListRoot']],
    ['R09', 'src/domain/verifyCmdScan.mjs', [["                if (name === 'regexp') {\n                    pats.push(vi)\n                }", '                if (false) {\n                    pats.push(vi)\n                }']], ['unit-scanListRoot']],
    ['R10', 'src/domain/verifyCmdScan.mjs', [["if (!need.length || re.test(unq(rest.join(' ; ')))) {", 'if (!need.length) {']], ['unit-scanListRoot']],
    ['R11', 'src/domain/verifyCmdScan.mjs', [["if (!need.length || re.test(unq(rest.join(' ; ')))) {", "if (re.test(unq(rest.join(' ; ')))) {"]], ['unit-scanListRoot'], 'equiv'],
    ['R12', 'src/domain/verifyCmdScan.mjs', [["p.startsWith('~') || coversRoot(", "p.startsWith('~') || false && coversRoot("]], ['unit-scanListRoot']],
    ['R13', 'src/domain/verifyCmdScan.mjs', [[' || (!r.paths.length && !r.stdin)) {', ') {']], ['unit-scanListRoot']],
    ['R14', 'src/domain/verifyCmdScan.mjs', [['stdin: tb.stdinOk && !rec }', 'stdin: false }']], ['unit-scanListRoot']],
    ['R15', 'src/domain/verifyCmdScan.mjs', [['            if (!tb.flag.includes(c)) {\n                return null\n            }\n            rec = rec || tb.rec.includes(c)\n', '            if (!tb.flag.includes(c)) {\n                return null\n            }\n']], ['unit-scanListRoot']],
    ['R16', 'src/domain/verifyCmdScan.mjs', [['                rec = rec || tb.rec.includes(c)\n                i = vi\n', '                i = vi\n']], ['unit-scanListRoot']],
    ['R17', 'src/domain/verifyCmdScan.mjs', [["if (/[\"'`$^%<(){}]/.test(masked)", "if (/[\"'`^%<(){}]/.test(masked)"]], ['unit-scanListRoot']],
    ['R18', 'src/domain/verifyCmdScan.mjs', [["if (/[\"'`$^%<(){}]/.test(masked)", "if (/[\"'$^%<(){}]/.test(masked)"]], ['unit-scanListRoot']],
    ['R19', 'src/domain/verifyCmdScan.mjs', [["if (/[\"'`$^%<(){}]/.test(masked)", 'if (/[`$^%<(){}]/.test(masked)']], ['unit-scanListRoot']],
    ['R20', 'src/domain/verifyCmdScan.mjs', [["|| quoted.some((q) => q[0] === '\"' &&", "|| false && quoted.some((q) => q[0] === '\"' &&"]], ['unit-scanListRoot']],
    ['R21', 'src/domain/verifyCmdScan.mjs', [['if (!cwdKnown || LR_CD.test(s) || /', 'if (!cwdKnown || LR_CD.test(s) || false && /']], ['unit-scanListRoot']],
    ['R22', 'src/domain/verifyCmdScan.mjs', [['if (!cwdKnown || LR_CD.test(s) ||', 'if (!cwdKnown || false ||']], ['unit-scanListRoot']],
    ['R23', 'src/domain/verifyCmdScan.mjs', [['if (!cwdKnown || ', 'if (false || ']], ['unit-scanListRoot']],
    ['R24', 'src/domain/verify.mjs', [['                    cwdMoved = true\n', '                    void 0\n']], ['unit-scanListRoot']],
    ['R25', 'src/domain/verify.mjs', [["path.relative(path.resolve(listBase), absOf(listBase, wd)) === ''", 'true']], ['unit-scanListRoot']],
    ['R26', 'src/domain/verifyCmdScan.mjs', [['            else if (/^(?:\\d*|&)>>?$/.test(w)) {\n                i++\n', '            else if (/^(?:\\d*|&)>>?$/.test(w)) {\n                return false\n']], ['unit-scanListRoot']],
    ['R27', 'src/domain/verifyCmdScan.mjs', [['!(/^\\d*>&(?:\\d+|-)$/.test(w) || /^(?:\\d*|&)>>?[^>&]/.test(w))', '!(false)']], ['unit-scanListRoot']],
    ['R28', 'src/domain/verifyCmdScan.mjs', [['/^(?:\\d*|&)>>?[^>&]/.test(w))) {\n                return false\n', '/^(?:\\d*|&)>>?[^>&]/.test(w))) {\n                ws.push(i)\n']], ['unit-scanListRoot']],
    ['R29', 'src/domain/verifyCmdScan.mjs', [["pats.some((w) => /[*?[]/.test(dropQuotes(w))) || ", '']], ['unit-scanListRoot']],
    ['R30', 'src/domain/verifyCmdScan.mjs', [["(g < 0 ? p : p.slice(0, g).replace(/[^\\\\/]*$/, ''))", 'p']], ['unit-scanListRoot']],
    ['R31', 'src/domain/verifyCmdScan.mjs', [["if (!p || p.startsWith('~') || coversRoot(", 'if (!p || coversRoot(']], ['unit-scanListRoot']],
    ['R32', 'src/domain/verifyCmdScan.mjs', [['                continue\n            }\n            return null\n        }\n        for (let j = 1;', '                continue\n            }\n            continue\n        }\n        for (let j = 1;']], ['unit-scanListRoot']],
    ['R33', 'src/domain/verifyCmdScan.mjs', [['            if (!tb.flag.includes(c)) {\n                return null', '            if (false) {\n                return null']], ['unit-scanListRoot']],
    ['R34', 'src/domain/verifyCmdScan.mjs', [['                let vi = j + 1 < w.length ? i : i + 1', '                let vi = i']], ['unit-scanListRoot']],
    ['R35', 'src/domain/verifyCmdScan.mjs', [['                let vi = eq !== undefined ? i : i + 1', '                let vi = i']], ['unit-scanListRoot']],
    ['R36', 'src/domain/verifyCmdScan.mjs', [["given = given || c === 'e' || c === 'f'", "given = given || c === 'e'"]], ['unit-scanListRoot']],
    ['R37', 'src/domain/verifyCmdScan.mjs', [['            if (/^\\/c/i.test(w)) {\n                pats.push(i)', '            if (false) {\n                pats.push(i)']], ['unit-scanListRoot']],
    ['R38', 'src/domain/verifyCmdScan.mjs', [['[belrsixvnmop]+|a:[0-9a-f]{1,2})$/i.test(w)) {\n            return null', '[belrsixvnmop]+|a:[0-9a-f]{1,2})$/i.test(w)) {\n            continue']], ['unit-scanListRoot']],
    ['R39', 'src/domain/verifyCmdScan.mjs', [["        if (k === 'pattern') {\n            pats.push(i + 1)", '        if (false) {\n            pats.push(i + 1)']], ['unit-scanListRoot']],
    ['R40', 'src/domain/verifyCmdScan.mjs', [["if (!k || i + 1 >= ws.length || !['pattern', 'path', 'literalpath', ...LR_SLS_VAL].includes(k)) {", 'if (!k || i + 1 >= ws.length) {']], ['unit-scanListRoot']],
    ['R41', 'src/domain/verifyCmdScan.mjs', [["    if (paths === null && pos.length) {\n        paths = ws[pos.shift()].split(',')\n    }\n", '']], ['unit-scanListRoot']],
    ['R42', 'src/domain/verifyCmdScan.mjs', [["        if (w === '--') {", '        if (false) {']], ['unit-scanListRoot']],
    ['R43', 'src/domain/verifyCmdScan.mjs', [['masked.split(/&&|\\|\\||\\|&|[|;\\n]|(?<!>)&(?!>)/)', 'masked.split(/\\n/)']], ['unit-scanListRoot']],
    ['R44', 'src/domain/verifyCmdScan.mjs', [['        if ([...drop].some((i) => re.test(unq(words[i])))) {', '        if (false) {']], ['unit-scanListRoot']],
    ['R45', 'src/domain/verify.mjs', [['return wd === undefined ? !cwdMoved :', 'return wd === undefined ? true :']], ['unit-scanListRoot']],
    ['R46', 'src/domain/verifyCmdScan.mjs', [["val: 'ABCEMTdefgjmrt',", "val: 'ABCEMTdefgjmt',"]], ['unit-scanListRoot']],
    ['R47', 'src/domain/verifyCmdScan.mjs', [["val: 'ABCEMTdefgjmrt',", "val: 'ABCEMTdefjmrt',"], ["flag: 'abcFHhIiLlNnoPpqSsUuVvwxz0',", "flag: 'abcFHhIiLlNnoPpqSsUuVvwxz0g',"]], ['unit-scanListRoot']],
    //R48: 拿掉「指令本身含佔位符所用之控制字元者照列」之防呆 ⇒ 越界之佔位符拋錯(「不拋錯」之斷言殺)、偽造之佔位符被免列(「照列」之斷言殺)
    ['R48', 'src/domain/verifyCmdScan.mjs', [['if (MASK_CHARS.test(s)) {\n        return false', 'if (false) {\n        return false']], ['unit-scanListRoot']],
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
    ['G43', 'src/domain/agentEntries.mjs', [["        return !has(args, '--dry')\n    }\n    return true", "        return !has(args, '--dry') && !has(args, '--no-member')\n    }\n    return true"]], ['unit-agentGuard']], //--mode fill --no-member(規則 R-REC-51)只少算成員穩健性, 仍為寫檔之模式
    //── 派工器設角色之環境變數(規則 R-RUN-11; dispatchers.mjs、agentRole.mjs)── H01 不設; H02 opencode 之選項不帶; H03 claude 之選項不帶; H04 其他角色亦帶
    //  H01 ~ H03 之守門為 unit-agentDispatchEnv(H02 只有其真 w-dispatch-ai 之一案看得到: 跑變異時須給 WTA_TEST_WDA_DIR 或家目錄下之技能根有之, 否則該案略過而存活)
    ['H01', 'src/arsi/dispatchers.mjs', [['let oe = { ...o, agentEnv: agentEnvOf(role) }', 'let oe = { ...o, agentEnv: null }']], ['unit-agentDispatchEnv']],
    ['H02', 'src/arsi/dispatchers.mjs', [["            ...(agentEnv ? { env: agentEnv } : {}),\n        }\n        if (entry.provider === 'opencode-go') {", "        }\n        if (entry.provider === 'opencode-go') {"]], ['unit-agentDispatchEnv']],
    ['H03', 'src/arsi/dispatchers.mjs', [['            ...(agentEnv ? { env: agentEnv } : {}),\n            model: cfg.model,', '            model: cfg.model,']], ['unit-agentDispatchEnv']],
    ['H04', 'src/arsi/agentRole.mjs', [['(AGENT_ROLES.includes(role) ? { [AGENT_ROLE_ENV]: role } : null)', '({ [AGENT_ROLE_ENV]: role })']], ['unit-agentGuard']],
    //── 操作掃描:執行迴圈之寫檔入口(規則 R-BT-7 ①; verifyCmdScan.mjs 之 entryExecOf)──
    //  N01 ~ N02 here-doc; N03 命令替換; N04 xargs; N05 變數之值; N06 ~ N07 直接執行; N08 讀取類; N09 npm exec; N10 ~ N11 前綴; N12 node 之帶值選項; N13 內嵌腳本之子行程;
    //  N14 ~ N15 腳本與引數含變數; N16 其他指令從嚴; N17 重導向之目標; N18 ~ N19 名稱之比對; N20 ~ N21 引號之處理; N22 接線
    ['N01', 'src/domain/verifyCmdScan.mjs', [['SHELLS.has(hc) ? entryExecOf(body) :', 'false ? entryExecOf(body) :']], ['unit-scanEntryExec']],
    ['N02', 'src/domain/verifyCmdScan.mjs', [['EX_RUNNERS.includes(hc) && EX_CHILD.test(body)', 'EX_RUNNERS.includes(hc) && false']], ['unit-scanEntryExec']],
    ['N03', 'src/domain/verifyCmdScan.mjs', [['    if (!q || q.sub) {\n        return true\n    }\n    let segs = exSegs(q.masked)', '    if (!q) {\n        return true\n    }\n    let segs = exSegs(q.masked)']], ['unit-scanEntryExec']],
    ['N04', 'src/domain/verifyCmdScan.mjs', [["let EX_WRAPS = new Set([...SHELLS, 'xargs', ", 'let EX_WRAPS = new Set([...SHELLS, ']], ['unit-scanEntryExec']],
    ['N05', 'src/domain/verifyCmdScan.mjs', [['            if (EX_MENTION.test(q.unq(ws[i]))) {\n                return true\n            }\n            i++', '            i++']], ['unit-scanEntryExec']],
    ['N06', 'src/domain/verifyCmdScan.mjs', [['                if (entryWrites(direct, ws.slice(i + 1).map(q.bare)) || ws.slice(i + 1).some(q.dyn)) {', '                if (false) {']], ['unit-scanEntryExec']],
    ['N07', 'src/domain/verifyCmdScan.mjs', [['if (entryWrites(direct, ws.slice(i + 1).map(q.bare)) ||', 'if (true ||']], ['unit-scanEntryExec']],
    ['N08', 'src/domain/verifyCmdScan.mjs', [["let EX_READERS = new Set(['cat', ", 'let EX_READERS = new Set([']], ['unit-scanEntryExec']],
    ['N09', 'src/domain/verifyCmdScan.mjs', [["            else if (c === 'npm' && /^(exec|x)$/.test(q.bare(ws[i + 1] || ''))) {", '            else if (false) {']], ['unit-scanEntryExec']],
    ['N10', 'src/domain/verifyCmdScan.mjs', [["let EX_SKIP = new Set([...CMD_PREFIXES, 'npx'])", 'let EX_SKIP = new Set([...CMD_PREFIXES])']], ['unit-scanEntryExec']],
    ['N11', 'src/domain/verifyCmdScan.mjs', [["(c === 'npx' && /^(-p|--package)$/.test(ws[i])) ? 2 : 1", 'false ? 2 : 1']], ['unit-scanEntryExec']],
    ['N12', 'src/domain/verifyCmdScan.mjs', [['                    j += EX_NODE_VAL.has(ws[j]) ? 2 : 1', '                    j += 1']], ['unit-scanEntryExec']],
    ['N13', 'src/domain/verifyCmdScan.mjs', [['                    if (EX_CHILD.test(inline)) {', '                    if (false) {']], ['unit-scanEntryExec']],
    ['N14', 'src/domain/verifyCmdScan.mjs', [['                else if (j < ws.length) {\n                    if (q.dyn(ws[j])) {\n                        return true\n                    }\n', '                else if (j < ws.length) {\n']], ['unit-scanEntryExec']],
    ['N15', 'src/domain/verifyCmdScan.mjs', [['if (name && (entryWrites(name, ws.slice(j + 1).map(q.bare)) || ws.slice(j + 1).some(q.dyn))) {', 'if (name && entryWrites(name, ws.slice(j + 1).map(q.bare))) {']], ['unit-scanEntryExec']],
    ['N16', 'src/domain/verifyCmdScan.mjs', [['                done = true\n            }\n            else {\n                return true\n            }\n        }\n    }\n    return false\n}', '                done = true\n            }\n            else {\n                done = true\n            }\n        }\n    }\n    return false\n}']], ['unit-scanEntryExec']],
    ['N17', 'src/domain/verifyCmdScan.mjs', [['        let ws = exArgs(ws0)\n        let i = 0', '        let ws = ws0\n        let i = 0']], ['unit-scanEntryExec']],
    ['N18', 'src/domain/verifyCmdScan.mjs', [["\\\\.mjs`, 'i')", "\\\\.mjs`, '')"]], ['unit-scanEntryExec']],
    ['N19', 'src/domain/verifyCmdScan.mjs', [[' || /(?:^|\\/)cli\\/(rsi|launch|build|backtest)\\.mjs$/i.exec(s)', '']], ['unit-scanEntryExec']],
    ['N20', 'src/domain/verifyCmdScan.mjs', [['    if (MASK_CHARS.test(s)) {\n        return null', '    if (false) {\n        return null']], ['unit-scanEntryExec']],
    ['N21', 'src/domain/verifyCmdScan.mjs', [["? x.replace(/\\\\[\\s\\S]/g, '') : ''", "? x : ''"]], ['unit-scanEntryExec']],
    ['N22', 'src/domain/verify.mjs', [["if (typeof inp.command === 'string' && entryExecOf(inp.command)) {", 'if (false) {']], ['unit-scanEntryExec']],
    //── 操作掃描:遞迴列出狀態根或其上層(規則 R-BT-7 ②; verifyCmdScan.mjs 之 recursiveRootOf、rlCovers、scriptListsRoot、toolListsRoot 與 verify.mjs 之 scanTrace 接線)──
    //  O01 ~ O06 ls / dir / gci 之遞迴選項與其值; O07 ~ O08 find 與無路徑; O09 ~ O10 tree; O12 ~ O16 grep / rg / findstr; O17 ~ O18 xargs; O19 殼層之 -c; O20 eval 類; O21 指令名含變數;
    //  O22 ~ O24 切換目錄; O25 ~ O26 內嵌腳本; O27 ~ O28 無法解析; O29 ~ O30 here-doc; O31 ~ O33 路徑之判定; O34 ~ O40 腳本之線索; O41 ~ O42 搜尋 / 列目錄工具;
    //  O43 ~ O49 scanTrace 之接線(只在節點、工作目錄、寫入之程式檔); O50 ~ O52 三個呼叫點傳狀態根
    ['O01', 'src/domain/verifyCmdScan.mjs', [[': /^-[A-Za-z]*R[A-Za-z]*$/.test(w) ||', ': /^-[A-Za-z]*X[A-Za-z]*$/.test(w) ||']], ['unit-scanEntryExec']],
    ['O02', 'src/domain/verifyCmdScan.mjs', [['(isGci ? /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w) :', '(true ? /^-r(e(c(u(r(se?)?)?)?)?)?$/i.test(w) :']], ['unit-scanEntryExec']],
    ['O03', 'src/domain/verifyCmdScan.mjs', [["(c === 'dir' && /^\\/s$/i.test(w))", 'false']], ['unit-scanEntryExec']],
    ['O04', 'src/domain/verifyCmdScan.mjs', [["w === '--recursive' || ", '']], ['unit-scanEntryExec']],
    ['O05', 'src/domain/verifyCmdScan.mjs', [[' || /^-depth$/i.test(w)', '']], ['unit-scanEntryExec']],
    ['O06', 'src/domain/verifyCmdScan.mjs', [['else if (/^-(filter|include|exclude|depth)$/i.test(ws[k])) {', 'else if (false) {']], ['unit-scanEntryExec']],
    ['O07', 'src/domain/verifyCmdScan.mjs', [['let ops = k < 0 ? ws : ws.slice(0, k)', 'let ops = ws']], ['unit-scanEntryExec']],
    ['O08', 'src/domain/verifyCmdScan.mjs', [["paths = ops.length ? ops : ['.']", 'paths = ops', true]], ['unit-scanEntryExec']],
    ['O09', 'src/domain/verifyCmdScan.mjs', [["        else if (c === 'tree') {", '        else if (false) {']], ['unit-scanEntryExec']],
    ['O10', 'src/domain/verifyCmdScan.mjs', [["let RL_VAL = new Set(['-L', '-P', ", "let RL_VAL = new Set(['-L', "]], ['unit-scanEntryExec']],
    ['O12', 'src/domain/verifyCmdScan.mjs', [["            else if (c === 'rg' || !r.stdin) {", "            else if (c === 'rg') {"]], ['unit-scanEntryExec']],
    ['O13', 'src/domain/verifyCmdScan.mjs', [["            else if (c === 'rg' || !r.stdin) {", '            else if (true) {']], ['unit-scanEntryExec']],
    ['O14', 'src/domain/verifyCmdScan.mjs', [["? ['~'] : null", '? null : null']], ['unit-scanEntryExec']],
    ['O15', 'src/domain/verifyCmdScan.mjs', [["                paths = r.paths.length ? r.paths : ['.']", '                paths = r.paths']], ['unit-scanEntryExec']],
    ['O16', 'src/domain/verifyCmdScan.mjs', [["        else if (c === 'findstr' &&", '        else if (false &&']], ['unit-scanEntryExec']],
    ['O17', 'src/domain/verifyCmdScan.mjs', [["            paths.push('~')", '            void 0']], ['unit-scanEntryExec']],
    ['O18', 'src/domain/verifyCmdScan.mjs', [['i += RL_XARGS_VAL.has(ws0[i]) ? 2 : 1', 'i += 1']], ['unit-scanEntryExec']],
    ['O19', 'src/domain/verifyCmdScan.mjs', [['                if (recursiveRootOf(rest.length === 1 ?', '                if (false && recursiveRootOf(rest.length === 1 ?']], ['unit-scanEntryExec']],
    ['O20', 'src/domain/verifyCmdScan.mjs', [['        if (EVAL_WRAPS.has(c)) {', "        if (c !== 'eval' && EVAL_WRAPS.has(c)) {"]], ['unit-scanEntryExec']], //包裝之集合已與 entryExecOf 共用(EVAL_WRAPS), 故改於 recursiveRootOf 之使用處去掉 eval(效果同原: 只影響遞迴列出之判定)
    ['O21', 'src/domain/verifyCmdScan.mjs', [['        if (q.dyn(ws0[i])) {', '        if (false) {']], ['unit-scanEntryExec']],
    ['O22', 'src/domain/verifyCmdScan.mjs', [["dir = !t || t === '-' || /[$`~]/.test(t) || dir === null ? null : absOf(dir, t)", 'dir = dir']], ['unit-scanEntryExec']],
    ['O23', 'src/domain/verifyCmdScan.mjs', [["t === '-' || /[$`~]/.test(t) || dir === null", "t === '-' || dir === null"]], ['unit-scanEntryExec']],
    ['O24', 'src/domain/verifyCmdScan.mjs', [["        if (c === 'popd' || c === 'pop-location') {\n            dir = null", "        if (c === 'popd' || c === 'pop-location') {\n            dir = dir"]], ['unit-scanEntryExec']],
    ['O25', 'src/domain/verifyCmdScan.mjs', [["let k = ws.findIndex((w) => EX_NODE_INLINE.has(w) || w === '-c')", 'let k = -1']], ['unit-scanEntryExec']],
    ['O26', 'src/domain/verifyCmdScan.mjs', [["EX_NODE_INLINE.has(w) || w === '-c')", 'EX_NODE_INLINE.has(w))']], ['unit-scanEntryExec']],
    ['O27', 'src/domain/verifyCmdScan.mjs', [['return { hit: hit || RL_LISTER.test(s), dir: LR_CD.test(s) ? null : base }', 'return { hit, dir: LR_CD.test(s) ? null : base }']], ['unit-scanEntryExec']],
    ['O28', 'src/domain/verifyCmdScan.mjs', [['return { hit: hit || RL_LISTER.test(s), dir: LR_CD.test(s) ? null : base }', 'return { hit: hit || RL_LISTER.test(s), dir: base }']], ['unit-scanEntryExec']],
    ['O29', 'src/domain/verifyCmdScan.mjs', [['if (SHELLS.has(hc) ? recursiveRootOf(body, { base, stateRoot }).hit :', 'if (false ? recursiveRootOf(body, { base, stateRoot }).hit :']], ['unit-scanEntryExec']],
    ['O30', 'src/domain/verifyCmdScan.mjs', [['.includes(hc) && scriptListsRoot(body, base, stateRoot)) {', '.includes(hc) && false) {']], ['unit-scanEntryExec']],
    ['O31', 'src/domain/verifyCmdScan.mjs', [['    if (!isAbs && base === null) {\n        return true\n    }\n', '']], ['unit-scanEntryExec']],
    ['O32', 'src/domain/verifyCmdScan.mjs', [["    if (!p || p.startsWith('~') || /[$`]/.test(p)) {", '    if (!p) {']], ['unit-scanEntryExec']],
    ['O33', 'src/domain/verifyCmdScan.mjs', [["    let d = g < 0 ? p : p.slice(0, g).replace(/[^\\\\/]*$/, '')", '    let d = p']], ['unit-scanEntryExec']],
    ['O34', 'src/domain/verifyCmdScan.mjs', [['    if (!SC_LIST.test(s) || !SC_REC.test(s)) {', '    if (!SC_LIST.test(s)) {']], ['unit-scanEntryExec']],
    ['O35', 'src/domain/verifyCmdScan.mjs', [['    if (!SC_LIST.test(s) || !SC_REC.test(s)) {', '    if (!SC_REC.test(s)) {']], ['unit-scanEntryExec']],
    ['O36', 'src/domain/verifyCmdScan.mjs', [["&& rlCovers('.', base, stateRoot)) {", '&& false) {']], ['unit-scanEntryExec']],
    ['O37', 'src/domain/verifyCmdScan.mjs', [["(?!\\s*(?:\\+|,\\s*['\"`]))/.test(s)", '/.test(s)']], ['unit-scanEntryExec']],
    ['O38', 'src/domain/verifyCmdScan.mjs', [["        if (/^\\s*(?:\\+|,\\s*['\"`])/.test(after)) {\n            continue\n        }\n", '']], ['unit-scanEntryExec']],
    ['O39', 'src/domain/verifyCmdScan.mjs', [['let pathy = dots ? SC_CALL.test(s.slice(Math.max(0, m.index - 40), m.index)) :', 'let pathy = dots ? true :']], ['unit-scanEntryExec']],
    ['O40', 'src/domain/verifyCmdScan.mjs', [['!/^[\\\\/]+$/.test(v) && ', '']], ['unit-scanEntryExec']],
    ['O41', 'src/domain/verifyCmdScan.mjs', [[" || (isGlob && !(typeof inp.pattern === 'string' && inp.pattern.includes('**')))", '']], ['unit-scanEntryExec']],
    ['O42', 'src/domain/verifyCmdScan.mjs', [['if (!/grep|search|glob|^list$|^ls$/i.test(tool)', 'if (!/grep|search|glob/i.test(tool)']], ['unit-scanEntryExec']],
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
    //── 搜尋樣式取自檔或無位置樣式(Y 系列; verifyCmdScan.mjs 之 patFileOf 與 stripSearchPatterns; Gitea #198 之另見 2)──
    ['Y01', 'src/domain/verifyCmdScan.mjs', [['            if (pf) {\n                removed = true', '            if (false) {\n                removed = true']], ['unit-cmdScan']],
    ['Y02', 'src/domain/verifyCmdScan.mjs', [['                skipNext = pf === 2\n', '                skipNext = false\n']], ['unit-cmdScan']],
    ['Y03', 'src/domain/verifyCmdScan.mjs', [["        return fam === 'rg' ? 3 : 0", '        return 3']], ['unit-cmdScan']],
    ['Y04', 'src/domain/verifyCmdScan.mjs', [["    if (t === '--file') {\n        return 2\n    }\n", '']], ['unit-cmdScan']],
    ['Y05', 'src/domain/verifyCmdScan.mjs', [["    if (t.startsWith('--file=')) {\n        return 1\n    }\n", '']], ['unit-cmdScan']],
    ['Y06', 'src/domain/verifyCmdScan.mjs', [["    if (/^-[A-Za-z0-9]/.test(t)) {\n        for (let j = 1; j < t.length; j++) {\n            if (LR_GNU[fam].val.includes(t[j])) {\n                return t[j] === 'f'", "    if (/^-[A-Za-z0-9]+$/.test(t)) {\n        for (let j = 1; j < t.length; j++) {\n            if (LR_GNU[fam].val.includes(t[j])) {\n                return t[j] === 'f'"]], ['unit-cmdScan']],
    ['Y07', 'src/domain/verifyCmdScan.mjs', [["return t[j] === 'f' ? (j === t.length - 1 ? 2 : 1) : 0", "return t[j] === 'f' ? 2 : 0"]], ['unit-cmdScan']],
    ['Y08', 'src/domain/verifyCmdScan.mjs', [["return t[j] === 'f' ? (j === t.length - 1 ? 2 : 1) : 0", "return t[j] === 'f' ? 1 : 0"]], ['unit-cmdScan']],
    ['Y09', 'src/domain/verifyCmdScan.mjs', [["if (LR_GNU[fam].val.includes(t[j])) {\n                return t[j] === 'f'", "if ((fam === 'grep' ? 'ABCDdem' : LR_GNU.rg.val).includes(t[j])) {\n                return t[j] === 'f'"]], ['unit-cmdScan']],
    ['Y10', 'src/domain/verifyCmdScan.mjs', [["if (LR_GNU[fam].val.includes(t[j])) {\n                return t[j] === 'f'", "if ((fam === 'rg' ? 'ABCEMTdegjmrt' : LR_GNU.grep.val).includes(t[j])) {\n                return t[j] === 'f'"]], ['unit-cmdScan']],
    ['Y11', 'src/domain/verifyCmdScan.mjs', [["/(?:^|[\\\\/])rg(?:\\.exe)?$/i.test(head) ? 'rg'", "/(?:^|[\\\\/])rg$/i.test(head) ? 'rg'"]], ['unit-cmdScan']],
    ['Y12', 'src/domain/verifyCmdScan.mjs', [["(/grep(?:\\.exe)?$/i.test(head) ? 'grep' : null)", "(/grep$/i.test(head) ? 'grep' : null)"]], ['unit-cmdScan']],
    ['Y13', 'src/domain/verifyCmdScan.mjs', [['                else if (/^\\/G:/i.test(t)) {', '                else if (false) {']], ['unit-cmdScan']],
    ['Y14', 'src/domain/verifyCmdScan.mjs', [['                else if (/^\\/G:/i.test(t)) {', '                else if (/^\\/G:/.test(t)) {']], ['unit-cmdScan']],
    ['Y15', 'src/domain/verifyCmdScan.mjs', [['            if (pf) {\n                removed = true\n', '            if (pf) {\n']], ['unit-cmdScan']],
    ['Y16', 'src/domain/verifyCmdScan.mjs', [["    if (t === '--files') {\n        return fam === 'rg' ? 3 : 0\n    }\n", '']], ['unit-cmdScan']],
    ['Y17', 'src/domain/verifyCmdScan.mjs', [["k < toks.length && toks[k] !== '--'; k++) {", 'k < toks.length; k++) {']], ['unit-cmdScan']],
    ['Y18', 'src/domain/verifyCmdScan.mjs', [['                        later = true\n                        break', '                        later = false\n                        break']], ['unit-cmdScan']],
    ['Y19', 'src/domain/verifyCmdScan.mjs', [['|| (isFindstr && /^\\/[CG]:/i.test(toks[k])))) {', ')) {']], ['unit-cmdScan']],
    ['Y20', 'src/domain/verifyCmdScan.mjs', [['(patFileOf(m0[0], toks[k]) || eOf(m0[0], toks[k]) ||', '(eOf(m0[0], toks[k]) ||']], ['unit-cmdScan']],
    //── 近期版之超額之取值(J 系列; domain.mjs 之 recentDiagOf / recentExcessOf; contentOf 與 avgOf 與「有內容」共用; Gitea #198 之另見 1)──
    ['J01', 'src/domain/domain.mjs', [['    return s ? s.excess : null\n}', '    return s ? s.excess : 0\n}']], ['unit-searchMapRecent']],
    ['J02', 'src/domain/domain.mjs', [['            let r0 = recentExcessOf(m)\n            return `${mean(', "            let r0 = m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side ? m.ext.nullRecentAct.side.excess : null\n            return `${mean("]], ['unit-searchMapRecent']],
    ['J03', 'src/domain/domain.mjs', [['    let r0 = recentExcessOf(m)\n    let useRecent', "    let r0 = m.ext && m.ext.nullRecentAct && m.ext.nullRecentAct.side ? m.ext.nullRecentAct.side.excess : null\n    let useRecent"]], ['unit-searchMapRecent']],
    ['J04', 'src/domain/domain.mjs', [['let recentExcessOf = (m) => {\n    let s = recentDiagOf(m)', 'let recentExcessOf = (m) => {\n    let s = recentSideOf(m)']], ['unit-searchMapRecent']],
    ['J05', 'src/domain/diagRead.mjs', [["let e = m && m.ext && typeof m.ext === 'object' ? m.ext[RECENT_DIAG] : null\n    let s = e && typeof e === 'object' && !e.error ? e.side : null\n    return s && typeof s === 'object' && Number.isFinite(s.excess)", "let e = m && m.ext && typeof m.ext === 'object' ? m.ext[RECENT_DIAG] : null\n    let s = e && typeof e === 'object' ? e.side : null\n    return s && typeof s === 'object' && Number.isFinite(s.excess)"]], ['unit-searchMapRecent', 'unit-recentDiag']], //移至 diagRead.mjs(錨點隨之)
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
    ['SK09', 'src/domain/domain.mjs', [['.sort((a, b) => rankKeyOf(b) - rankKeyOf(a) || (a.id < b.id ? -1 : 1))\n        if (!cands.length) {', '.sort((a, b) => b.score.S - a.score.S || (a.id < b.id ? -1 : 1))\n        if (!cands.length) {']], ['unit-rankKey']],
    ['SK10', 'src/domain/domain.mjs', [['rankKeyOf(b) - rankKeyOf(a) || (a.id < b.id ? -1 : 1))\n        if (!cands.length) {', 'rankKeyOf(b) - rankKeyOf(a))\n        if (!cands.length) {']], ['unit-rankKey']],
    ['SK11', 'src/domain/domain.mjs', [['(kvOf(b) - kvOf(a))).slice(0, refCounts.refTopNodes)', '(b.score.S - a.score.S)).slice(0, refCounts.refTopNodes)']], ['unit-rankKey']],
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
    ['BL12', 'src/domain/texts.mjs', [['let backlogOn = fillBacklogSecOf(st.rsi) > 0 && autoFillOn', 'let backlogOn = fillBacklogSecOf(st.rsi) > 0']], ['unit-fillBacklog']],
    ['BL13', 'src/domain/texts.mjs', [['(backlogOn ? FILL_BACKLOG_ON : FILL_BACKLOG_OFF)', '(FILL_BACKLOG_OFF)']], ['unit-fillBacklog', 'unit-dreamOnly']],
    ['BL14', 'src/domain/domain.mjs', [['if (next >= tasks.length || capped0()) {', 'if (next >= tasks.length) {']], ['unit-fillBacklog']],
    ['BL15', 'src/domain/domain.mjs', [['while (next < tasks.length && !capped0()) {', 'while (next < tasks.length) {']], ['unit-fillBacklog']],
    ['BL16', 'src/domain/domain.mjs', [['let tasks = blTasks.length ? [...plan.tasks, ...blTasks] : plan.tasks', 'let tasks = plan.tasks']], ['unit-fillBacklog']],
    //不重試之失敗之紀錄(R-REC-41 之補充): 略過之判定、記入、移除、只限輪末之一併處理、狀態檔之比較與寫法、摘要
    ['BL17', 'src/domain/domain.mjs', [['if (blRec.has(tk.nodeId) && blRec.get(tk.nodeId) === fillSigOf(tk)) {', 'if (false) {']], ['unit-fillBacklog']],
    ['BL18', 'src/domain/domain.mjs', [['if (blRec.has(tk.nodeId) && blRec.get(tk.nodeId) === fillSigOf(tk)) {', 'if (blRec.has(tk.nodeId)) {']], ['unit-fillBacklog']],
    ['BL19', 'src/domain/domain.mjs', [['for (let x of resB.filter((r) => FILL_NO_RETRY_KINDS.includes(r.kind))) {', 'for (let x of []) {']], ['unit-fillBacklog']], //錨點隨同一輪兩次之結果之合併(R-REC-51; results → resB)而改; 語意不變
    ['BL20', 'src/domain/domain.mjs', [["sig: fillSigOf(tk, { postfit: x.postfit === 'failed', ext: x.ext.failed, member: x.member === 'failed' })", 'sig: fillSigOf(tk)']], ['unit-fillBacklog']], //錨點隨成員穩健性(R-REC-51)之項目併入而改; 語意不變
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
    //── 迴圈檢查之兩條機械提示(EH 系列; R-REC-43 單峰交付、R-REC-44 選集與他節點相同)──
    //  參考檔之定義(兩條共用之單一來源)與所計之列
    ['EH01', 'src/domain/verifyEvalHints.mjs', [["let REF_PICK = /^(?:control|base_pick|ref_.*)\\.mjs$/i", "let REF_PICK = /^(?:base_pick|ref_.*)\\.mjs$/i"]], ['unit-evalHints']], //不排除 control.mjs
    ['EH02', 'src/domain/verifyEvalHints.mjs', [["let REF_PICK = /^(?:control|base_pick|ref_.*)\\.mjs$/i", "let REF_PICK = /^(?:control|ref_.*)\\.mjs$/i"]], ['unit-evalHints']], //不排除 base_pick.mjs
    ['EH03', 'src/domain/verifyEvalHints.mjs', [["let REF_PICK = /^(?:control|base_pick|ref_.*)\\.mjs$/i", "let REF_PICK = /^(?:control|base_pick)\\.mjs$/i"]], ['unit-evalHints']], //不排除 ref_*.mjs
    ['EH04', 'src/domain/verifyEvalHints.mjs', [["let REF_PICK = /^(?:control|base_pick|ref_.*)\\.mjs$/i", "let REF_PICK = /^(?:control|base_pick|ref_.*)\\.mjs$/"]], ['unit-evalHints']], //分大小寫
    ['EH05', 'src/domain/verifyEvalHints.mjs', [["if (!j || j.ok !== true || j.mode !== 'full' ||", "if (!j || j.mode !== 'full' ||"]], ['unit-evalHints']], //計失敗之列
    ['EH06', 'src/domain/verifyEvalHints.mjs', [["j.mode !== 'full' || (j.period && j.period !== 'backtest') || (j.member", "(j.period && j.period !== 'backtest') || (j.member"]], ['unit-evalHints']], //計快速評估之列
    ['EH07', 'src/domain/verifyEvalHints.mjs', [["|| (j.period && j.period !== 'backtest') || (j.member !== undefined", "|| (j.member !== undefined"]], ['unit-evalHints']], //計其他期間之列
    ['EH08', 'src/domain/verifyEvalHints.mjs', [["(j.member !== undefined && j.member !== null) || typeof j.selHash", "typeof j.selHash"]], ['unit-evalHints']], //計帶成員抽樣之列
    ['EH09', 'src/domain/verifyEvalHints.mjs', [["typeof j.selHash !== 'string' || !j.selHash || isRefPick(j.pick)) {", "typeof j.selHash !== 'string' || isRefPick(j.pick)) {"]], ['unit-evalHints']], //計空之選集指紋
    ['EH10', 'src/domain/verifyEvalHints.mjs', [["typeof j.selHash !== 'string' || !j.selHash || isRefPick(j.pick)) {", "typeof j.selHash !== 'string' || !j.selHash) {"]], ['unit-evalHints']], //計參考檔之列
    ['EH11', 'src/domain/verifyEvalHints.mjs', [["S: typeof j.S === 'number' && Number.isFinite(j.S) ? j.S : null })", "S: j.S })"]], ['unit-evalHints']], //S 不檢數值
    //  單峰交付之四個條件、同一指紋多列之取法、中位
    ['EH12', 'src/domain/verifyEvalHints.mjs', [["Object.freeze({ peakMinSel: 6,", "Object.freeze({ peakMinSel: 5,"]], ['unit-evalHints']], //相異之指紋之下限 5
    ['EH13', 'src/domain/verifyEvalHints.mjs', [["bySel.size < EVAL_HINT.peakMinSel", "bySel.size <= EVAL_HINT.peakMinSel"]], ['unit-evalHints']], //恰 6 個不提示
    ['EH14', 'src/domain/verifyEvalHints.mjs', [["if (!(dS > 0) ||", "if (!(dS >= 0) ||"]], ['unit-evalHints']], //S 為 0 亦提示
    ['EH15', 'src/domain/verifyEvalHints.mjs', [["rest.some((v) => v > dS)", "rest.some((v) => v >= dS)"]], ['unit-evalHints']], //同分不算最高
    ['EH16', 'src/domain/verifyEvalHints.mjs', [["if (!(dS > 0) || rest.some((v) => v > dS)) {", "if (!(dS > 0)) {"]], ['unit-evalHints']], //不查是否最高
    ['EH17', 'src/domain/verifyEvalHints.mjs', [["if (!(med < dS * EVAL_HINT.peakRatio)) {", "if (!(med <= dS * EVAL_HINT.peakRatio)) {"]], ['unit-evalHints']], //中位恰為一半亦提示
    ['EH18', 'src/domain/verifyEvalHints.mjs', [["peakRatio: 0.5,", "peakRatio: 0.6,"]], ['unit-evalHints']], //倍數 0.6
    ['EH19', 'src/domain/verifyEvalHints.mjs', [["            bySel.set(r.selHash, r.S)", "            if (!bySel.has(r.selHash)) {\n                bySel.set(r.selHash, r.S)\n            }"]], ['unit-evalHints']], //同一指紋取第一列
    ['EH20', 'src/domain/verifyEvalHints.mjs', [["return k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2", "return s[Math.floor((k - 1) / 2)]"]], ['unit-evalHints']], //偶數個取中間偏低之一數
    ['EH21', 'src/domain/verifyEvalHints.mjs', [["let med = medianOf(rest)", "let med = rest.reduce((a, b) => a + b, 0) / rest.length"]], ['unit-evalHints']], //以平均代中位
    //  選集與他節點相同: 不比之對象、句式、所列之檔、次序與上限
    ['EH22', 'src/domain/verifyEvalHints.mjs', [["let pairExcluded = (a, b) => (a.type", "let pairExcluded = (a, b) => false && (a.type"]], ['unit-evalHints']], //驗證類之指名不排除
    ['EH23', 'src/domain/verifyEvalHints.mjs', [["(a.type === 'verify' && (a.targets || []).includes(b.id)) || (b.type", "(b.type"]], ['unit-evalHints']], //只排除一個方向(對方為驗證類)
    ['EH24', 'src/domain/verifyEvalHints.mjs', [[" || (b.type === 'verify' && (b.targets || []).includes(a.id))", '']], ['unit-evalHints']], //只排除一個方向(本節點為驗證類)
    ['EH25', 'src/domain/verifyEvalHints.mjs', [["if (oid === self.id || pairExcluded(self, h.o)) {", "if (pairExcluded(self, h.o)) {"]], ['unit-evalHints']], //自身之列亦命中
    ['EH26', 'src/domain/verifyEvalHints.mjs', [["        if (mine.length === 0 && theirs.length > 0) {\n            continue\n        }\n", '']], ['unit-evalHints']], //本節點為真子集者亦列
    ['EH27', 'src/domain/verifyEvalHints.mjs', [["let pick = h.o.fingerprint === self.fingerprint && h.picks.includes('pick.mjs') ? 'pick.mjs' : h.picks[h.picks.length - 1]", "let pick = h.picks[h.picks.length - 1]"]], ['unit-evalHints']], //不以交付檔之列優先
    ['EH28', 'src/domain/verifyEvalHints.mjs', [["? 'pick.mjs' : h.picks[h.picks.length - 1]", "? 'pick.mjs' : h.picks[0]"]], ['unit-evalHints']], //取第一列
    ['EH29', 'src/domain/verifyEvalHints.mjs', [["${h.nPick > 1 ? `(另 ${h.nPick - 1} 個檔亦同)` : ''}", '']], ['unit-evalHints']], //不註多個檔
    ['EH30', 'src/domain/verifyEvalHints.mjs', [["(Number(a.same) - Number(b.same))", "(Number(b.same) - Number(a.same))"]], ['unit-evalHints']], //臂組合相同者在前
    ['EH31', 'src/domain/verifyEvalHints.mjs', [["twinMaxList: 3 })", "twinMaxList: 2 })"]], ['unit-evalHints']], //列至 2 個
    ['EH32', 'src/domain/verifyEvalHints.mjs', [["more.slice(0, 10)", "more.slice(0, 11)"]], ['unit-evalHints']], //其餘之 id 列至 11 個
    //  讀各節點之工作夾: agent 結束之時刻、驗證類之辨識與其指名、未通過之節點、兩條之次序、看板用之內容
    ['EH33', 'src/domain/verifyEvalHints.mjs', [["d.agent && typeof d.agent.endedAt === 'string' ? d.agent.endedAt : null))", 'null))']], ['unit-evalHints']], //不限 agent 結束之前
    ['EH34', 'src/domain/verifyEvalHints.mjs', [["let type = d.task && d.task.type === 'verify' ? 'verify' : 'explore'", "let type = 'explore'"]], ['unit-evalHints']], //不辨識驗證類
    ['EH35', 'src/domain/verifyEvalHints.mjs', [["...(d.spec && d.spec.base ? [d.spec.base] : []), ...namedOf", '...namedOf']], ['unit-evalHints']], //起點不算指名
    ['EH36', 'src/domain/verifyEvalHints.mjs', [[", ...namedOf(d.task && d.task.direction)] : []", '] : []']], ['unit-evalHints']], //方向內之節點不算指名
    ['EH37', 'src/domain/verify.mjs', [["        if (hit.length === 1 && !out.includes(hit[0])) {\n            out.push(hit[0])", "        if (hit.length >= 1 && !out.includes(hit[0])) {\n            out.push(hit[0])"]], ['unit-evalHints']], //前綴對應多個亦算指名(方向內指名之節點之共用求法 dirNodeIdsOf; 兩條提示之 namedOf 經之)
    ['EH38', 'src/domain/verifyEvalHints.mjs', [["fingerprint: d.harness && d.harness.ok === true && typeof d.harness.fingerprint", "fingerprint: d.harness && typeof d.harness.fingerprint"]], ['unit-evalHints']], //未通過之節點亦提示
    ['EH39', 'src/domain/verifyEvalHints.mjs', [["[peakHintOf(o.rows, o.fingerprint), twinHintOf(o, ix)]", "[twinHintOf(o, ix), peakHintOf(o.rows, o.fingerprint)]"]], ['unit-evalHints']], //兩條之次序
    ['EH40', 'src/domain/verifyEvalHints.mjs', [["return t.endsWith(HINT_TAIL) ? t.slice(0, t.length - HINT_TAIL.length) : t", 'return t']], ['unit-evalHints']], //看板之一段留「不否決」之註
    ['EH41', 'src/domain/verifyEvalHints.mjs', [["let isEvalHint = (s) => String(s).startsWith(PEAK_HEAD) || String(s).startsWith(TWIN_HEAD)", "let isEvalHint = (s) => String(s).startsWith(PEAK_HEAD)"]], ['unit-evalHints']], //舊之「選集與他節點相同」不被認出(重產時重複)
    //  領域之接線(各呼叫點)與看板、唯讀之對照
    ['EH42', 'src/domain/domain.mjs', [["        try {\n            refreshEvalHints(nodeIds)\n", "        try {\n            void 0\n"]], ['unit-evalHints']], //派做夢之前不重產
    ['EH43', 'src/domain/domain.mjs', [['refreshEvalHints([...nodeIds, ...pending])', 'void 0']], ['unit-evalHints']], //處置之後不重產
    ['EH44', 'src/domain/domain.mjs', [['refreshEvalHints([...nodeIds, ...pending])', 'refreshEvalHints(pending)']], ['unit-evalHints']], //處置之後只重產重做者
    ['EH45', 'src/domain/domain.mjs', [['            refreshEvalHints(rows.map((r) => r.id))\n', '']], ['unit-evalHints']], //reverify 之後不重產
    ['EH46', 'src/domain/domain.mjs', [['let next = [...old.filter((s) => !isScan(s) && !isEvalHint(s)), ...tr.issues, ...hs]', 'let next = [...old.filter((s) => !isScan(s) && !isEvalHint(s)), ...tr.issues]']], ['unit-evalHints']], //重掃不補提示(節點文件)
    ['EH47', 'src/domain/domain.mjs', [['let next = [...old.filter((s) => !isScan(s) && !isEvalHint(s)), ...tr.issues, ...hs]', 'let next = [...old.filter((s) => !isScan(s)), ...tr.issues, ...hs]']], ['unit-evalHints']], //重掃不移除舊之提示
    ['EH48', 'src/domain/domain.mjs', [['...tr.issues, ...(hm ? hs : (x.raw.issues || []).filter(isEvalHint))]', '...tr.issues]']], ['unit-evalHints']], //重掃不補提示(樹)
    ['EH49', 'src/domain/domain.mjs', [['x.raw.issues = withHints(x.raw.issues, hm.get(id))', 'void 0']], ['unit-evalHints']], //輪末之重產不更新樹
    ['EH50', 'src/domain/domain.mjs', [['let withHints = (issues, hs) => [...(issues || []).filter((s) => !isEvalHint(s)), ...(hs || [])]', 'let withHints = (issues, hs) => [...(issues || []), ...(hs || [])]']], ['unit-evalHints']], //不移除舊之提示(重複)
    ['EH51', 'src/domain/domain.mjs', [["${hintOf(n, PEAK_HEAD) ? ' 單峰交付' : ''}", '']], ['unit-evalHints']], //看板之 S 一欄不標
    ['EH52', 'src/domain/domain.mjs', [["${hintOf(n, TWIN_HEAD) ? ' 選集與他節點相同' : ''}", '']], ['unit-evalHints']], //看板之臂一欄不標
    ['EH53', 'src/domain/domain.mjs', [['        if (peakRows.length) {', '        if (false) {']], ['unit-evalHints']], //看板之表前不列單峰交付之一段
    ['EH54', 'src/domain/domain.mjs', [['        if (twinRows.length) {', '        if (false) {']], ['unit-evalHints']], //看板之表前不列選集與他節點相同之一段
    ['EH55', 'src/domain/domain.mjs', [['            if (!docChanged && !treeChanged) {\n                continue\n            }\n            if (docChanged) {\n', '            if (true) {\n'], ['            if (treeChanged) {\n                rsi.store.updateNode', '            if (true) {\n                rsi.store.updateNode']], ['unit-evalHints']], //無變動者亦重寫(文件與樹)
    ['EH56', 'src/tools/scanCheck.mjs', [['let now = [...tr.issues, ...(hints.get(d.nodeId) || [])]', 'let now = [...tr.issues]']], ['unit-evalHints']], //唯讀之對照不含提示
    ['EH57', 'src/tools/scanCheck.mjs', [['.filter((s) => isScan(s) || isEvalHint(s))', '.filter(isScan)']], ['unit-evalHints']], //唯讀之對照不讀節點文件內之提示
    //  兩方皆為驗證類而臂組合相同者不列(主控之裁定)
    ['EH58', 'src/domain/verifyEvalHints.mjs', [["        if (self.type === 'verify' && h.o.type === 'verify' && mine.length === 0 && theirs.length === 0) {\n            continue\n        }\n", '']], ['unit-evalHints']], //兩方皆驗證類而同臂者亦列
    ['EH59', 'src/domain/verifyEvalHints.mjs', [["if (self.type === 'verify' && h.o.type === 'verify' && mine.length === 0", "if (self.type === 'verify' && mine.length === 0"]], ['unit-evalHints']], //只看本節點之類型
    ['EH60', 'src/domain/verifyEvalHints.mjs', [["if (self.type === 'verify' && h.o.type === 'verify' && mine.length === 0", "if (h.o.type === 'verify' && mine.length === 0"]], ['unit-evalHints']], //只看對方之類型
    ['EH61', 'src/domain/verifyEvalHints.mjs', [["h.o.type === 'verify' && mine.length === 0 && theirs.length === 0) {", "h.o.type === 'verify') {"]], ['unit-evalHints']], //兩方皆驗證類者不論臂組合皆不列
    //  提示之字串與看板之文字不列門檻之值
    ['EH62', 'src/domain/verifyEvalHints.mjs', [['(遠低於交付版)⇒', '(不到交付版之 S 之 ${EVAL_HINT.peakRatio} 倍)⇒']], ['unit-evalHints']], //提示之字串列出倍數
    ['EH63', 'src/domain/domain.mjs', [['交付版之 S 為多次完整評估中之孤立高點(只提示、不否決;', '交付版之 S 為多次完整評估中之孤立高點(完整評估之相異選集 ≥ 6 個;只提示、不否決;']], ['unit-evalHints']], //看板之段落列出個數之門檻
    //  判定拋錯時之各呼叫點(只記錄、主流程照常)與重掃之保留
    ['EH64', 'src/domain/domain.mjs', [['        try {\n            refreshEvalHints(rows.map((r) => r.id))\n        }\n        catch (err) {', '        {\n            refreshEvalHints(rows.map((r) => r.id))\n        }\n        if (false) {']], ['unit-evalHints']], //reverify 之後之失敗中斷主流程
    ['EH65', 'src/domain/domain.mjs', [['        try {\n            hm = evalHintsAll(records.listNodeDocs(), st.records.workDir)\n        }\n        catch (err) {', '        {\n            hm = evalHintsAll(records.listNodeDocs(), st.records.workDir)\n        }\n        if (false) {']], ['unit-evalHints']], //重掃之失敗中斷重掃
    ['EH66', 'src/domain/domain.mjs', [['let hs = hm ? (hm.get(d.nodeId) || []) : old.filter(isEvalHint)', 'let hs = hm ? (hm.get(d.nodeId) || []) : []']], ['unit-evalHints']], //重掃失敗時丟掉既有之提示(節點文件)
    ['EH67', 'src/domain/domain.mjs', [['...(hm ? hs : (x.raw.issues || []).filter(isEvalHint))]', '...(hm ? hs : [])]']], ['unit-evalHints']], //重掃失敗時丟掉既有之提示(樹)
    ['EH68', 'src/domain/domain.mjs', [['        try {\n            refreshEvalHints(nodeIds)\n        }\n        catch (err) {', '        {\n            refreshEvalHints(nodeIds)\n        }\n        if (false) {']], ['unit-evalHints']], //派做夢之前之失敗中斷輪末鉤子
    ['EH69', 'src/domain/domain.mjs', [['        try {\n            refreshEvalHints([...nodeIds, ...pending])\n        }\n        catch (err) {', '        {\n            refreshEvalHints([...nodeIds, ...pending])\n        }\n        if (false) {']], ['unit-evalHints']], //處置之後之失敗中斷輪末鉤子
    ['EH70', 'src/domain/domain.mjs', [["let evalHintsAll = typeof inject.evalHints === 'function' ? inject.evalHints : evalHintsOfDocs", 'let evalHintsAll = evalHintsOfDocs']], ['unit-evalHints']], //不採注入之判定
    //── 節點之禁區涵蓋迴圈驗證之全部原始碼(VZ 系列; 規則 R-BT-10; Gitea #200 之主控另加 2、4): 禁區字樣之 verify 起首之涵蓋、任務書之檔名樣式與之一致 ──
    ['VZ01', 'src/domain/verify.mjs', [["(?:backtest|verify|libStats)|tools", "(?:backtest|verify\\.mjs|libStats)|tools"]], ['unit-verifyZone']], //禁區只涵蓋 verify.mjs 單檔(verifyCmdScan.mjs、verifyEvalHints.mjs 不涵蓋; 錨點隨 R-BT-10 ④ 併入庫況體檢之程式而更新, 語意不變)
    ['VZ02', 'src/domain/verify.mjs', [["(?:backtest|verify|libStats)|tools", "(?:backtest|libStats)|tools"]], ['unit-verifyZone']], //禁區不含 verify 起首者
    ['VZ03', 'src/domain/verify.mjs', [["(?:backtest|verify|libStats)|tools", "(?:verify|libStats)|tools"]], ['unit-verifyZone']], //禁區不含 backtest 起首者
    ['VZ04', 'src/domain/texts.mjs', [["codeRel + '/verify*.mjs`", "codeRel + '/verify.mjs`"]], ['unit-verifyZone']], //任務書只寫 verify.mjs 單檔(與禁區字樣不一致)
    ['VZ05', 'src/domain/texts.mjs', [["'/backtest*.mjs`、`' + codeRel", "'/backtest.mjs`、`' + codeRel"]], ['unit-verifyZone']], //任務書之 backtest 樣式改為單檔
    ['VZ06', 'src/domain/texts.mjs', [["codeRel + '/verify*.mjs` —— 評估時", "codeRel + '/verify*.mjs`、`' + codeRel + '/cmdScan.mjs` —— 評估時"]], ['unit-verifyZone']], //任務書另列禁區字樣未涵蓋之檔名
    ['VZ07', 'src/domain/agentEntries.mjs', [["exposure: { label: 'tools/exposure.mjs 之放行', writes: (args) => args.length > 0 },", "exposure: { label: 'tools/exposure.mjs 之放行', writes: () => false },"]], ['unit-verifyZone']], //節點執行放行之工具不列「執行迴圈之寫檔入口」(排程第 591 項之主控另加; 側別曝險之判定之檔在禁區內、放行之工具之執行亦列)
    //── 可讀之他節點工作夾(AW 系列; 規則 R-BT-9; Gitea #200 之主控另加 5): 迴圈驗證、重掃與 scanCheck 共用 verify.mjs 之三函數 ──
    ['AW01', 'src/domain/verify.mjs', [[', ...dirNodeIdsOf(d.task && d.task.direction, ids)]', ']']], ['unit-scanAllowWork']], //可讀之列不含方向指名之節點
    ['AW02', 'src/domain/verify.mjs', [['...dirWorkIdsOf(d.task && d.task.direction, workRel), ', '']], ['unit-scanAllowWork']], //可讀之列不含方向內提到之工作夾
    ['AW03', 'src/domain/verify.mjs', [['let allowWorkOf = (d, { workRel, ids }) => [...(d.spec && d.spec.base ? [d.spec.base] : []), ', 'let allowWorkOf = (d, { workRel, ids }) => [']], ['unit-scanAllowWork']], //可讀之列不含起點
    ['AW04', 'src/domain/verify.mjs', [['...(((d.task && d.task.refs) || []).filter((r) => r.nodeId).map((r) => r.nodeId)), ', '']], ['unit-scanAllowWork']], //可讀之列不含任務書列為參考之節點
    ['AW05', 'src/domain/verify.mjs', [['if (hit.length === 1 && !out.includes(hit[0])) {', 'if (hit.length >= 1 && !out.includes(hit[0])) {']], ['unit-scanAllowWork']], //前綴對應不唯一者亦算指名
    ['AW06', 'src/domain/verify.mjs', [['.matchAll(/\\b[0-9a-f]{8,16}\\b/g)) {\n        let hit = (ids || [])', '.matchAll(/\\b[0-9a-f]{6,16}\\b/g)) {\n        let hit = (ids || [])']], ['unit-scanAllowWork']], //前綴少至 6 碼即算指名
    ['AW07', 'src/domain/verify.mjs', [['.matchAll(/\\b[0-9a-f]{8,16}\\b/g)) {\n        let hit = (ids || [])', '.matchAll(/\\b[0-9a-f]{8,12}\\b/g)) {\n        let hit = (ids || [])']], ['unit-scanAllowWork']], //完整 id(16 碼)不算指名
    ['AW08', 'src/domain/verify.mjs', [["`${direction.claim || ''} ${direction.rationale || ''} ${direction.expect || ''}`.matchAll(/\\b", "`${direction.rationale || ''} ${direction.expect || ''}`.matchAll(/\\b"]], ['unit-scanAllowWork']], //指名只看依據與預期(不看主張)
    ['AW09', 'src/domain/verify.mjs', [["`${direction.rationale || ''} ${direction.expect || ''}`.matchAll(new RegExp(", "`${direction.claim || ''} ${direction.rationale || ''} ${direction.expect || ''}`.matchAll(new RegExp("]], ['unit-scanAllowWork']], //方向內之工作夾亦看主張
    ['AW10', 'src/domain/verify.mjs', [["let base = String(workRel).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')", 'let base = String(workRel)']], ['unit-scanAllowWork']], //工作夾之根之字元不當字面(「.」當萬用字元)
    ['AW11', 'src/tools/scanCheck.mjs', [['let allowWork = allowWorkOf(d, { workRel, ids })', 'let allowWork = allowWorkOf(d, { workRel, ids: [] })']], ['unit-scanAllowWork']], //scanCheck 不認方向指名之節點(修前之現象)
    ['AW12', 'src/tools/scanCheck.mjs', [["let workRel = path.relative(root, workRoot).replace(/\\\\/g, '/')", 'let workRel = path.relative(root, workRoot)']], ['unit-scanAllowWork']], //scanCheck 之工作夾之根不轉為 /
    ['AW13', 'src/domain/domain.mjs', [['let allowWork = allowWorkOf(d, { workRel, ids })', 'let allowWork = allowWorkOf(d, { workRel, ids: [] })']], ['unit-scanAllowWork']], //重掃不認方向指名之節點
    ['AW14', 'src/domain/domain.mjs', [['dirNodeIdsOf(direction, executedIds())', 'dirNodeIdsOf(direction, [])']], ['unit-scanAllowWork']], //任務書之參考不列方向指名之節點
    ['AW15', 'src/domain/domain.mjs', [["let dirWorkIds = (direction) => dirWorkIdsOf(direction, workRelOf())", "let dirWorkIds = (direction) => dirWorkIdsOf(direction, '')"]], ['unit-scanAllowWork']], //迴圈驗證之 refsOf 之工作夾之根為空(只由結構之案守: 該路徑於單元測試中無法不跑評估而觸及)
    //── 兩條提示之寫入: 文件與樹各自比對(R-REC-44 ⑦; Gitea #200 之複審所見)──
    ['EH71', 'src/domain/domain.mjs', [['let treeChanged = treeOld !== null && JSON.stringify(treeOld) !== JSON.stringify(withHints(treeOld, hm.get(id)))', 'let treeChanged = docChanged']], ['unit-evalHints']], //樹只隨文件之變動而更新(文件已寫、樹之更新拋錯者不補)
    //── 起點為別名(選集與較早之節點相同)時之一致處理(AB 系列; 規則 R-REC-45; domain.mjs 之 aliasIdMap / carrierBase / gates.pre / proposeOne / proposeDirection / directionOf、rebasedNoteOf 與輪末摘要、fakeRound.mjs 之補位核對)──
    ['AB01', 'src/domain/domain.mjs', [["return cands.find((n) => !alias.has(n.id)) || null", "return cands[0] || null"]], ['unit-aliasBase']], //補位之底不排除別名
    ['AB02', 'src/domain/domain.mjs', [["        if (!cands.length) {\n            return null\n        }\n        let alias = aliasIdMap()", "        let alias = aliasIdMap()\n        if (!cands.length) {\n            return null\n        }"]], ['unit-aliasBase']], //無候選(冷啟動)亦求別名表(讀樹)
    ['AB03', 'src/domain/domain.mjs', [["        catch (err) {\n            return new Map()\n        }\n    }\n    //carrierBase,", "        catch (err) {\n            throw err\n        }\n    }\n    //carrierBase,"]], ['unit-aliasBase']], //別名表拋錯時中斷出計畫
    ['AB04', 'src/domain/domain.mjs', [["return m instanceof Map ? m : new Map()", "return m || new Map()"]], ['unit-aliasBase']], //別名表非 Map 時不視同無別名
    ['AB05', 'src/domain/domain.mjs', [["                    let canon = aliasIdMap().get(spec.base)\n                    if (typeof canon === 'string' && canon && canon !== spec.base) {", "                    let canon = aliasIdMap().get(spec.base)\n                    if (false) {"]], ['unit-aliasBase']], //閘門不辨別名(訊息回「不存在或未執行」)
    ['AB06', 'src/domain/domain.mjs', [["之別名(選集相同);請以 ${canon.slice(0, 8)} 為起點` }", "之別名(選集相同);請以 ${String(spec.base).slice(0, 8)} 為起點` }"]], ['unit-aliasBase']], //閘門訊息之「請以 X 為起點」寫成別名自己
    ['AB07', 'src/domain/domain.mjs', [["為 ${canon.slice(0, 8)} 之別名(選集相同);請以", "為 ${String(spec.base).slice(0, 8)} 之別名(選集相同);請以"]], ['unit-aliasBase']], //閘門訊息之正本寫成別名自己
    ['AB08', 'src/domain/domain.mjs', [["if (cn && cn.status === 'executed') {", "if (false) {"]], ['unit-aliasBase']], //方向之起點為別名者不改掛
    ['AB09', 'src/domain/domain.mjs', [["                    spec = { ...spec, base: canon }\n                    b = cn", "                    b = cn"]], ['unit-aliasBase']], //記為改掛而規格之起點仍為別名
    ['AB10', 'src/domain/domain.mjs', [["                    spec = { ...spec, base: canon }\n                    b = cn", "                    spec = { ...spec, base: canon }"]], ['unit-aliasBase']], //改掛後之否決檢查仍看別名
    ['AB11', 'src/domain/domain.mjs', [[", baseUsed: track.rebased.to }", " }"]], ['unit-aliasBase']], //回傳不帶 baseUsed
    ['AB12', 'src/domain/domain.mjs', [["已改以 ${to} 為起點)`, baseUsed", "已改以 ${from} 為起點)`, baseUsed"]], ['unit-aliasBase']], //note 之「已改以 X」寫成別名
    ['AB13', 'src/domain/domain.mjs', [["if (r.ok === true && dd && !((dd.harness && dd.harness.addendum) || []).some((a) => a && a.text === text)) {", "if (r.ok === true && dd) {"]], ['unit-aliasBase']], //迴圈註記不去重
    ['AB14', 'src/domain/domain.mjs', [["                records.putDreamDoc(dd)\n            }\n        }\n        catch (err) {}\n        return { ...r, note", "                void dd\n            }\n        }\n        catch (err) {}\n        return { ...r, note"]], ['unit-aliasBase']], //迴圈註記不寫入做夢文件
    ['AB15', 'src/domain/domain.mjs', [["((x.base || null) === (spec.base || null) || (spec.base && baseUsedAt(d, k) === spec.base))", "((x.base || null) === (spec.base || null))"]], ['unit-aliasBase']], //節點之來源方向不認 baseUsed
    ['AB16', 'src/domain/domain.mjs', [["((x.base || null) === (spec.base || null) || (spec.base && baseUsedAt(d, k) === spec.base))", "((x.base || null) === (spec.base || null) || baseUsedAt(d, k) === (spec.base || null))"]], ['unit-aliasBase']], //無記錄與起點 null 視為相符
    ['AB17', 'src/domain/domain.mjs', [["x.ok ? '已入前緣' : '未入前緣'", "x.ok ? '未入前緣' : '已入前緣'"]], ['unit-aliasBase']], //摘要之入前緣與否顛倒
    ['AB18', 'src/domain/domain.mjs', [["        lines.push(...rebasedNoteOf(a.proposals))\n", ""]], ['unit-aliasBase']], //輪末摘要不列改掛一段
    ['AB19', 'src/domain/domain.mjs', [["note: `${r.note}(起點 ${from} 為 ${to} 之別名", "note: `${r.note}(起點 ${to} 為 ${to} 之別名"]], ['unit-aliasBase']], //note 之別名寫成正本
    ['AB21', 'src/domain/domain.mjs', [["if (r.ok === true && dd && !((dd.harness && dd.harness.addendum) || []).some((a) => a && a.text === text)) {", "if (dd && !((dd.harness && dd.harness.addendum) || []).some((a) => a && a.text === text)) {"]], ['unit-aliasBase']], //未入前緣者(正本被否決等)亦加迴圈註記(註記陳述「入前緣」而與事實不符)
    ['AB20', 'src/tools/fakeRound.mjs', [[" && !al.has(n.id))", ")"]], ['unit-fakeRound'], 'equiv'], //fakeRound 之補位核對不排除別名(假審計之樹無別名 ⇒ 此變異於該樹等價, 預期存活; 排除別名之行為由 unit-aliasBase 之真樹案覆蓋; 見 state §5)
    //── 測試不得改寫入版控之文件(TI 系列; 規則 R-PKG-10; test/tools/sgudGuard.mjs 之判定與快照差異; 動態守門之 root hook 不在變異之列)──
    ['TI01', 'test/tools/sgudGuard.mjs', [["/afterRound|redream\\(/.test(text)", "/afterRound/.test(text)"]], ['unit-sgudUntouched']], //只認 afterRound(redream 之路徑漏掃)
    ['TI02', 'test/tools/sgudGuard.mjs', [["/afterRound|redream\\(/.test(text)", "/redream\\(/.test(text)"]], ['unit-sgudUntouched']], //只認 redream(afterRound 漏掃)
    ['TI03', 'test/tools/sgudGuard.mjs', [["docLimits\\s*[:=]\\s*false", "docLimits\\s*[:=]\\s*\\w+"]], ['unit-sgudUntouched']], //docLimits 設為其他值亦視為已關閉
    ['TI04', 'test/tools/sgudGuard.mjs', [["!hasDocLimitsOff(text) && !allow.includes(f)", "!hasDocLimitsOff(text)"]], ['unit-sgudUntouched']], //子行程隔離者不豁免
    ['TI05', 'test/tools/sgudGuard.mjs', [["x !== self", "true"]], ['unit-sgudUntouched']], //守門自身亦被掃描
    ['TI06', 'test/tools/sgudGuard.mjs', [["/\\.test\\.mjs$/.test(x)", "/\\.mjs$/.test(x)"]], ['unit-sgudUntouched']], //非測試檔亦被掃描
    ['TI07', 'test/tools/sgudGuard.mjs', [["else if (a[k] !== b[k]) {", "else if (false) {"]], ['unit-sgudUntouched']], //快照差異不報變動
    ['TI08', 'test/tools/sgudGuard.mjs', [["`${s.size}:${Math.floor(s.mtimeMs)}`", "`${s.size}`"]], ['unit-sgudUntouched']], //快照只比大小(同大小之改寫偵不出)
    ['TI09', 'test/tools/sgudGuard.mjs', [["                walk(q)\n", "                void q\n"]], ['unit-sgudUntouched']], //快照不進子夾
    //── 向外飽和之標示(SL 系列; 規則 R-REC-46; 輪末摘要之一行、一頁摘要之「一眼看完」、事件 run-done 與狀態檔之 run)──
    ['SL01', 'src/domain/domain.mjs', [["    if (saturated !== true) {", "    if (true) {"]], ['unit-outwardSaturated']], //已宣告亦回空字串
    ['SL02', 'src/domain/domain.mjs', [["            if (satLine) {", "            if (false) {"]], ['unit-outwardSaturated']], //輪末鉤子不列該行
    ['SL03', 'src/tools/roundDigest.mjs', [["/^向外飽和/, ", ""]], ['unit-dreamOnly']], //一頁摘要之「一眼看完」不列該行
    ['SL04', 'src/cli/rsi.mjs', [["let satKey = satInfo ? { outwardSaturated: satInfo } : {}", "let satKey = {}"]], ['unit-dreamOnly']], //事件與狀態檔不帶標示
    ['SL05', 'src/cli/rsi.mjs', [["let lastDream = dreamDocs[dreamDocs.length - 1]", "let lastDream = dreamDocs[0]"]], ['unit-dreamOnly']], //取最早而非最近一份做夢文件(其後未重申者仍帶)
    ['SL06', 'src/cli/rsi.mjs', [["    catch (err) {}\n    let satKey", "    catch (err) { throw err }\n    let satKey"]], ['unit-dreamOnly']], //讀取做夢文件失敗時拋出(不視同未宣告; 執行之結束被拖垮)
    ['SL07', 'src/cli/rsi.mjs', [["let dreamDocs = fs.existsSync(st.records.dreamDir) ? P.records.listDreamDocs() : []", "let dreamDocs = P.records.listDreamDocs()"]], ['unit-dreamOnly']], //做夢文件夾不存在者亦讀(listDreamDocs 建夾 ⇒ 未曾有輪次之專案多出 records 夾)
    ['SL08', 'src/cli/rsi.mjs', [["    if (satInfo) {", "    if (false) {"]], ['unit-dreamOnly']], //已宣告而不記結束段之日誌句
    //── 任務書之「可疑方向」與資訊來源之三級(SD 系列; 規則 R-REC-47; 做夢任務書 §3 一段、量尺句、審計規程第 8 點之一句; 節點任務書 §6 第 7 條; 合約 §5 之判讀名詞)──
    ['SD01', 'src/domain/texts.mjs', [["L.push('- **可疑方向**(彙整與寫方向之前先過一遍;", "void ('- **可疑方向**(彙整與寫方向之前先過一遍;"]], ['unit-texts']], //不列「可疑方向」之標題列
    ['SD02', 'src/domain/texts.mjs', [["L.push('  - **資訊來源分三級**", "void ('  - **資訊來源分三級**"]], ['unit-texts']], //不列資訊來源三級之子條
    ['SD03', 'src/domain/texts.mjs', [["L.push('  - **1. 側別曝險冒充挑選**", "void ('  - **1. 側別曝險冒充挑選**"]], ['unit-texts']], //缺第 1 項
    ['SD04', 'src/domain/texts.mjs', [["L.push('  - **2. 以庫彙總量定側別或席次**", "void ('  - **2. 以庫彙總量定側別或席次**"]], ['unit-texts']], //缺第 2 項
    ['SD05', 'src/domain/texts.mjs', [["L.push('  - **3. 以落後之延續規則定側別**", "void ('  - **3. 以落後之延續規則定側別**"]], ['unit-texts']], //缺第 3 項
    ['SD06', 'src/domain/texts.mjs', [["L.push('  - **4. 同一個底之連續疊加**", "void ('  - **4. 同一個底之連續疊加**"]], ['unit-texts']], //缺第 4 項
    ['SD07', 'src/domain/texts.mjs', [["L.push('  - **5. 成員依賴**", "void ('  - **5. 成員依賴**"]], ['unit-texts']], //缺第 5 項
    ['SD08', 'src/domain/texts.mjs', [["L.push('  - **6. 內容只在庫之某一類成員成立**", "void ('  - **6. 內容只在庫之某一類成員成立**"]], ['unit-texts']], //缺第 6 項
    ['SD09', 'src/domain/texts.mjs', [["隨機半庫(至少 6 個;", "隨機半庫(至少 2 個;"]], ['unit-texts']], //第 3 級之重算只要 2 個半庫
    ['SD10', 'src/domain/texts.mjs', [["須有兩種以上行情段(", "須有一種以上行情段("]], ['unit-texts']], //落後之延續規則只要一種行情段之證據
    ['SD11', 'src/domain/texts.mjs', [["**探索類之方向與預先核對至少一半改用側別中性之底**", "**探索類之方向與預先核對至少一個改用側別中性之底**"]], ['unit-texts']], //連續疊加之處置由至少一半放寬為至少一個
    ['SD12', 'src/domain/texts.mjs', [["隨機半庫之內容保持率之中位 < 0.5,", "隨機半庫之內容保持率之中位 < 0.9,"]], ['unit-texts']], //成員依賴之門檻改變
    ['SD13', 'src/domain/texts.mjs', [["**不列為已驗證之最高、不作為其後方向與預先核對之起點**", "**不作為其後方向與預先核對之起點**"]], ['unit-texts']], //側別曝險仍可列為已驗證之最高
    ['SD14', 'src/domain/texts.mjs', [["每輪在 `summary` **並列**寫明", "每輪在 `summary` 寫明"]], ['unit-texts']], //量尺句不並列
    ['SD15', 'src/domain/texts.mjs', [["、後者是否命中下述「可疑方向」第 1 項(命中者只是側別曝險,不是進度)", ""]], ['unit-texts']], //量尺句不寫後者是否命中第 1 項
    ['SD16', 'src/domain/texts.mjs', [[" **迴圈檢查列「下單流量偏一側」、或擴充診斷之提示指出成品等同某一個固定狀態(例:`fixedState`)、同比例隨機時機之安慰劑(`placeboTiming`)無內容者,其優勢歸為側別曝險:彙整時不列 `worked`、不作為方向之起點;要保留其側內之機制者,於方向內指明以兩側席次固定之版本重做**(見 §3「可疑方向」)。", ""]], ['unit-texts']], //審計規程第 8 點不加該句
    ['SD17', 'src/domain/texts.mjs', [["彙整時不列 `worked`、不作為方向之起點;要保留其側內之機制者", "彙整時不列 `worked`;要保留其側內之機制者"]], ['unit-texts']], //審計規程之新句缺「不作為方向之起點」
    ['SD18', 'src/domain/texts.mjs', [["L.push('7. **資訊來源**:成品用到庫彙總量", "void ('7. **資訊來源**:成品用到庫彙總量"]], ['unit-texts']], //節點任務書不列第 7 條
    ['SD19', 'src/domain/texts.mjs', [["(isVerify ? '驗證類不另交對照版。' :", "(!isVerify ? '驗證類不另交對照版。' :"]], ['unit-texts']], //探索與驗證之後半句對調
    ['SD20', 'src/domain/texts.mjs', [["成品用到庫彙總量(第 3 級,見合約 §5)者", "成品用到庫彙總量(第 2 級,見合約 §5)者"]], ['unit-texts']], //庫彙總量之級別寫錯
    ['SD21', 'src/domain/texts.mjs', [["完整評估一次,計入評估次數),並寫出兩者之組成對照之超額。", "完整評估一次),並寫出兩者之組成對照之超額。"]], ['unit-texts']], //另存之對照版不寫計入評估次數
    ['SD22', 'src/domain/texts.mjs', [[",計入評估次數),並寫出兩者之組成對照之超額。", ",計入評估次數)。"]], ['unit-texts']], //不要求寫出兩者之組成對照之超額
    ['SD23', 'src/domain/texts.mjs', [["自報「資訊來源:第 3 級(用到之彙總量是什麼)」", "自報「資訊來源」"]], ['unit-texts']], //自報句不寫級別與彙總量
    ['SD24', 'contract/pick-contract.md', [["  - **內容保持率**:", "  - 內容保持率:"]], ['unit-texts']], //合約缺內容保持率之名詞
    ['SD25', 'contract/pick-contract.md', [["建議至少 6 個", "建議至少 2 個"]], ['unit-texts']], //合約與任務書之半庫個數不一致
    ['SD26', 'contract/pick-contract.md', [["中位 < 0.5、或任一半庫之相位平均為負者", "中位 < 0.9、或任一半庫之相位平均為負者"]], ['unit-texts']], //合約與任務書之門檻不一致
    ['SD27', 'contract/pick-contract.md', [["或任一半庫之相位平均為負者,視為成員依賴", "或任一半庫之七相位平均為負者,視為成員依賴"]], ['unit-texts']], //新增字句含 renderContract 之錨點字樣(七相位之出現次數不符 ⇒ 改寫拋錯)
    ['SD28', 'contract/pick-contract.md', [["  - **側別中性(兩側席次固定)**:", "  - **側別中性**:"]], ['unit-texts']], //合約之名詞與任務書之稱呼不同名
    ['SD29', 'src/domain/texts.mjs', [["(迴圈會同時換兩者重放)。${isVerify", "(迴圈會同時換兩者重放。${isVerify"]], ['unit-texts']], //節點任務書之他處一字之差(只有釘死之雜湊抓得到)
    ['SD30', 'src/domain/texts.mjs', [["你的做夢文件是未來節點 agent 的主要參考,品質直接決定下一輪之探索品質。", "你的做夢文件是未來節點 agent 的主要參考,品質直接決定下一輪之探索品質"]], ['unit-dreamOnly']], //做夢任務書之他處一字之差(只有釘死之雜湊抓得到)
    ['SD31', 'src/domain/texts.mjs', [["先排驗證,再疊加機制。')", "先排驗證,再疊加機制')"]], ['unit-dreamOnly']], //新段鄰近之 guidance.directions 條目一字之差(還原步驟不得吞掉鄰近之改動)
    //  SD32 ~ SD41: 新段與合約判讀名詞之語意字句(釘死之雜湊只守「其餘逐字不變」, 不守新增文字之內部; 複審所列之語意反轉 / 刪句形狀)
    ['SD32', 'src/domain/texts.mjs', [["命中者依下列各項處置,處置優先於該成品之分數;", "命中者依下列各項處置;"]], ['unit-texts']], //標題列不寫處置優先於分數
    ['SD33', 'src/domain/texts.mjs', [["最依賴庫之組成", "不依賴庫之組成"]], ['unit-texts']], //第 3 級之語意反轉(不依賴庫之組成)
    ['SD34', 'src/domain/texts.mjs', [["依整側之彙總損益或全庫之做多比例配兩側之席次", "依整側之彙總損益配兩側之席次"]], ['unit-texts']], //第 2 項之例缺全庫之做多比例
    ['SD35', 'src/domain/texts.mjs', [["依近期已實現損益之好壞", "依近期成交量之大小"]], ['unit-texts']], //第 3 項改指另一種量
    ['SD36', 'src/domain/texts.mjs', [["各半庫內之 p 皆小只說明各半內有超額,不說明超額之量級仍在;", ""]], ['unit-texts']], //第 5 項缺「顯著不等於穩健」之說明句
    ['SD37', 'src/domain/texts.mjs', [["(`placeboTiming`)無內容 ⇒ 記為側別曝險", "(`placeboTiming`)有內容 ⇒ 記為側別曝險"]], ['unit-texts']], //第 1 項之語意反轉(安慰劑有內容亦記為側別曝險)
    ['SD38', 'contract/pick-contract.md', [["須經下列之組成位移重算仍在,才可稱挑選內容", "不必經下列之組成位移重算,即可稱挑選內容"]], ['unit-texts']], //合約之第 3 級不要求組成位移
    ['SD39', 'contract/pick-contract.md', [["內容 = 組成對照之超額;同一個模組、同一種對照", "內容 = S;同一個模組、同一種對照"]], ['unit-texts']], //合約之內容定義改為 S
    ['SD40', 'contract/pick-contract.md', [["它與「同比例、隨機時機之安慰劑」不同 —— 後者保留成品之狀態比例、只打亂時機。", ""]], ['unit-texts']], //合約缺側別中性與安慰劑之區分句
    ['SD41', 'contract/pick-contract.md', [["換一批成員重算同一個模組", "換一批參數重算同一個模組"]], ['unit-texts']], //合約之組成位移不是換成員
    //── 子庫之規則(規則 R-EV-47; subsetRule.mjs、ledger.mjs、cli/eval.mjs、verifyEvalHints.mjs)與庫況體檢(規則 R-EV-48; libStats.mjs、agentEntries.mjs、tools/libCheck.mjs)──
    ['SB01', 'src/eval/subsetRule.mjs', [["uOf(s, r.salt) >= 1 - r.p))", "uOf(s, r.salt) >= r.p))"]], ['unit-subsetLedger']], //rand 之乙側取 u ≥ p(p ≠ 0.5 時與 1 − p 不同)
    ['SB02', 'src/eval/subsetRule.mjs', [["r.lo === null ? null : Math.fround(r.lo)", "r.lo === null ? null : r.lo"]], ['unit-subsetLedger']], //下界不取 fround(漏掉存成 float32 之界值)
    ['SB03', 'src/eval/subsetRule.mjs', [["let inBand = (v, lo, hi) => (lo === null || v >= lo) && (hi === null || v <= hi)", "let inBand = (v, lo, hi) => (lo === null || v > lo) && (hi === null || v <= hi)"]], ['unit-subsetLedger']], //下界不含
    ['SB04', 'src/eval/subsetRule.mjs', [["if (L.ent[j] >= fromBar && L.ext[j] >= 0 && L.ext[j] < toBar) {", "if (L.ent[j] >= fromBar && L.ext[j] >= 0 && L.ent[j] < toBar) {"]], ['unit-subsetLedger']], //hold 計入出場在訓練期終點之後之單(只看進場)
    ['SB05', 'src/eval/subsetRule.mjs', [["if (L.ent[j] >= fromBar && L.ext[j] >= 0 && L.ext[j] < toBar) {", "if (L.ext[j] >= 0 && L.ext[j] < toBar) {"]], ['unit-subsetLedger']], //hold 不看訓練期之下界
    ['SB06', 'src/eval/subsetRule.mjs', [["return k % 2 ? ds[(k - 1) / 2] : (ds[k / 2 - 1] + ds[k / 2]) / 2", "return ds[Math.floor(k / 2)]"]], ['unit-subsetLedger']], //偶數筆取中間偏高之一數
    ['SB07', 'src/eval/subsetRule.mjs', [["return d !== null && inBand(d, r.lo, r.hi)", "return d === null || inBand(d, r.lo, r.hi)"]], ['unit-subsetLedger']], //無單者留下
    ['SB08', 'src/eval/subsetRule.mjs', [["(isLong(s) !== (r.side === 'long') ? true : uOf(s, r.salt) < r.p)", "(isLong(s) !== (r.side === 'long') ? false : uOf(s, r.salt) < r.p)"]], ['unit-subsetLedger']], //siderand 去除另一側
    ['SB09', 'src/eval/subsetRule.mjs', [["return segs.length > N ? segs.slice(N).join('_') : ''", "return segs.length > N ? segs.slice(N + 1).join('_') : ''"]], ['unit-subsetLedger']], //家族多去一段
    ['SB10', 'src/eval/subsetRule.mjs', [["let order = [...cnt.entries()].sort((a, b) => (b[1] - a[1]) ||", "let order = [...cnt.entries()].sort((a, b) => (a[1] - b[1]) ||"]], ['unit-subsetLedger']], //nofam:top 由少到多
    ['SB11', 'src/eval/subsetRule.mjs', [["if (n === 0 || nRem / n >= r.ratio) {", "if (n === 0) {"]], ['unit-subsetLedger']], //nofam:top 不停(去除全部家族)
    ['SB12', 'src/eval/subsetRule.mjs', [["return `rand:${String(r.p)}:0x${r.salt.toString(16)}:${r.half}`", "return `rand:${String(r.p)}:0x${r.salt.toString(16)}`"]], ['unit-subsetLedger']], //正規化不補半
    ['SB13', 'src/eval/subsetRule.mjs', [["if ((lo === null && hi === null) || (lo !== null && hi !== null && lo > hi)) {", "if (lo !== null && hi !== null && lo > hi) {"]], ['unit-subsetLedger']], //兩端皆空亦收
    ['SB14', 'src/eval/subsetRule.mjs', [["let famsOf = (N) => {", "let famsOf = (N0) => {\n        let N = N0 === 0 ? 0 : 3"]], ['unit-subsetLedger']], //nofam 之 N 不依所給(恆為 3)
    ['SB15', 'src/eval/ledger.mjs', [["return gatherLedger(L, sel, { subset: ObjectFreeze({ rule, nFull: nFullOf(L) }) })", "return gatherLedger(L, sel, { subset: ObjectFreeze({ rule, nFull: L.n }) })"]], ['unit-subsetLedger']], //半庫內再取之 nFull 取半庫之隻數
    ['SB16', 'src/eval/ledger.mjs', [["        if (sel[s] !== 0 && sel[s] !== 1) {", "        if (false) {"]], ['unit-subsetLedger']], //遮罩之值不檢
    ['SB17', 'src/eval/ledger.mjs', [["let nFullOf = (L) => (L.member ? L.member.nFull : (L.subset ? L.subset.nFull : L.n))", "let nFullOf = (L) => (L.member ? L.member.nFull : L.n)"]], ['unit-subsetLedger']], //子庫之 nFull 不沿用
    ['SB18', 'src/cli/eval.mjs', [["    if (memberArg !== null) {", "    if (false) {"]], ['unit-subsetLedger']], //與 --member 併用不拒
    ['SB19', 'src/cli/eval.mjs', [["process.argv.filter((a) => a === '--subset').length > 1 || subsetArg === true ? null", "subsetArg === true ? null"]], ['unit-subsetLedger']], //旗標重複不拒
    ['SB20', 'src/cli/eval.mjs', [["...(subset ? { subset: subset.rule } : {}), ...(waitedSec", "...(waitedSec"]], ['unit-subsetLedger']], //評估紀錄不帶 subset
    ['SB21', 'src/cli/eval.mjs', [["...(subset ? { subset: { rule: subset.rule } } : {}) })", "})"]], ['unit-subsetLedger']], //失敗之結果檔不帶 subset
    ['SB22', 'src/cli/eval.mjs', [["    L = subsetLedger(Lfull, sm.sel, subset.rule)", "    void sm"]], ['unit-subsetLedger']], //不套用子庫(以全庫評估)
    ['SB23', 'src/domain/verifyEvalHints.mjs', [["        if (j.subset !== undefined && j.subset !== null) {", "        if (false) {"]], ['unit-subsetLedger']], //機械提示計入子庫之列
    ['SB24', 'src/domain/agentEntries.mjs', [["    libCheck: { label: 'tools/libCheck.mjs', writes: always, hindsight: true },", "    libCheck: { label: 'tools/libCheck.mjs', writes: always },"]], ['unit-libCheck']], //拒跑之理由用寫檔之一句
    ['SB25', 'src/domain/agentEntries.mjs', [["    libCheck: { label: 'tools/libCheck.mjs', writes: always, hindsight: true },", "    libCheck: { label: 'tools/libCheck.mjs', writes: () => false, hindsight: true },"]], ['unit-libCheck']], //agent 不拒跑
    ['SB26', 'src/domain/libStats.mjs', [["((wl >= hi && ws <= lo) || (ws >= hi && wl <= lo))", "(wl >= hi && ws <= lo)"]], ['unit-libCheck']], //只認做多側高
    ['SB27', 'src/domain/libStats.mjs', [["((wl >= hi && ws <= lo) ||", "((wl > hi && ws <= lo) ||"]], ['unit-libCheck']], //高側之門檻不含
    ['SB28', 'src/domain/libStats.mjs', [["let cuts = [evFrom, evFrom + Math.floor(len / 3),", "let cuts = [evFrom, evFrom + Math.floor(len / 4),"]], ['unit-libCheck']], //三等分之界錯
    ['SB29', 'src/domain/libStats.mjs', [["if (L.ent[j] < w.fromBar || L.ent[j] >= w.toBar) {", "if (L.ent[j] < w.fromBar || L.ent[j] > w.toBar) {"]], ['unit-libCheck']], //期之終點含
    ['SB30', 'src/domain/libStats.mjs', [["winRate: o[k].closed ? r4(o[k].wins / o[k].closed) : null", "winRate: o[k].closed ? r4(o[k].wins / o[k].orders) : null"]], ['unit-libCheck']], //勝率之分母含未結之單
    ['SB31', 'src/domain/libStats.mjs', [["profitFactor: o[k].neg > 0 ? r4(o[k].pos / o[k].neg) : null", "profitFactor: o[k].neg > 0 ? r4(o[k].pos / (o[k].pos + o[k].neg)) : null"]], ['unit-libCheck']], //獲利因子之分母錯
    ['SB32', 'src/domain/libStats.mjs', [["out[isLong(s) ? 'long' : 'short'].push((c / days) * 30)", "out[isLong(s) ? 'long' : 'short'].push((c / days) * 7)"]], ['unit-libCheck']], //進場頻率以 7 日計
    ['SB33', 'src/domain/libStats.mjs', [["let xs = [...m.values()].sort((a, b) => a.value - b.value)", "let xs = [...m.values()].sort((a, b) => b.value - a.value)"]], ['unit-libCheck']], //候選值由大到小
    ['SB34', 'src/domain/libStats.mjs', [["let d = holdMedianOf(L, s, trainFrom, trainEnd)", "let d = holdMedianOf(L, s, 0, trainEnd)"]], ['unit-libCheck']], //各策略之中位不看訓練期之下界
    ['SB35', 'src/tools/libCheck.mjs', [["    if (!(x >= 0 && x <= 1)) {", "    if (!(x >= 0)) {"]], ['unit-libCheck']], //門檻之參數不檢上界
    ['SB36', 'src/tools/libCheck.mjs', [["    trainFrom = f === null ? 0 : f", "    trainFrom = 300"]], ['unit-libCheck']], //訓練期之下界不取設定
    ['SB37', 'src/eval/ledger.mjs', [["return gatherLedger(L, sel, { member: ObjectFreeze({ salt: saltV, half: halfV, nFull: nFullOf(L) }) })", "return gatherLedger(L, sel, { member: ObjectFreeze({ salt: saltV, half: halfV, nFull: L.n }) })"]], ['unit-memberLedger', 'unit-subsetLedger']], //半庫之重組改經 gatherLedger 後: 半庫內再切之 nFull 取半庫之隻數
    ['SB38', 'src/eval/subsetRule.mjs', [["        let N = nOf(a[1])", "        let N = 3"]], ['unit-subsetLedger']], //nofam 之 N 不依所給(回到寫死之預設)
    ['SB39', 'src/eval/subsetRule.mjs', [["return `nofam:${r.N}:${r.family}`", "return `nofam:${r.family}:${r.N}`"]], ['unit-subsetLedger']], //正規化之字串之 N 與家族之次序錯
    ['SB40', 'src/domain/libStats.mjs', [["let d = holdMedianOf(L, s, trainFrom, trainEnd)", "let d = holdMedianOf(L, s, trainFrom, L.nBars)"]], ['unit-libCheck']], //各策略之中位計入出場在訓練期之後之單
    ['SB41', 'src/domain/texts.mjs', [["分層者以 `g_eval.mjs --subset <規則>` 評估;隨機半庫照舊可用 `--member`,或 `--subset rand:…`", "`--member` 只切隨機半庫,分層者以模組內排除該類成員之版本另評估"]], ['unit-texts']], //做夢任務書之分層子庫回到改前之句(不指向 --subset)
    ['SB42', 'contract/pick-contract.md', [["分層者以 `g_eval.mjs --subset <規則>` 評估;隨機半庫照舊可用 `--member`,或 `--subset rand:…`", "`--member` 只切隨機半庫,分層者以模組內排除該類成員之版本另評估"]], ['unit-texts']], //合約之組成位移回到改前之句
    //── 節點之禁區涵蓋庫況體檢之程式(R-BT-10 ④; 排程第 589 項之主控另加)──
    ['SB43', 'src/domain/verify.mjs', [["(?:backtest|verify|libStats)|tools", "(?:backtest|verify)|tools"]], ['unit-verifyZone']], //禁區不含 src/domain/libStats.mjs(節點可讀取或匯入庫況體檢之計算)
    ['SB44', 'src/domain/verify.mjs', [["tools[\\\\\\\\/]+libCheck)|node_modules", "tools[\\\\\\\\/]+libCheckX)|node_modules"]], ['unit-verifyZone']], //禁區不含 src/tools/libCheck.mjs
    //── 排程第 589 項之接續輪(主控另加): 帶等號之 --subset= / --member= 拒收、空子庫之警示、libCheck 之設定讀不到(R-EV-47、R-EV-48)──
    //  排程第 590 項後: 帶等號之旗標統一由 cfg.mjs 之 eqFlagMsgOf(CLI_FLAGS.<進入檔>)檢查(原 eval.mjs 內之兩處 some(startsWith) 已併入; 以下四項改植於其接線與表)
    ['SB45', 'src/cfg.mjs', [["        'member': '<salt>:<half>',\n        'subset': '<rule>',\n", "        'member': '<salt>:<half>',\n"]], ['unit-subsetLedger']], //表內無 subset ⇒ --subset= 之訊息為通稱(不指明須寫成 --subset <規則>)
    ['SB46', 'src/cfg.mjs', [["        'member': '<salt>:<half>',\n        'subset': '<rule>',\n", "        'subset': '<rule>',\n"]], ['unit-subsetLedger']], //表內無 member ⇒ --member= 之訊息為通稱
    ['SB47', 'src/cli/eval.mjs', [["process.argv.slice(2), { first: ['member', 'subset'] })", "process.argv.slice(2), { first: ['subset', 'member'] })"]], ['unit-subsetLedger', 'unit-cliEqFlags']], //同時帶 --member= 與 --subset= 時先報 --subset(沿用 1.0.42 者為先報 --member)
    ['SB48', 'src/cli/eval.mjs', [["process.argv.slice(2), { first: ['member', 'subset'] })", 'process.argv.slice(2))']], ['unit-cliEqFlags', 'unit-subsetLedger']], //不給優先序 ⇒ 依命令列之次序(--subset= 在前者先報 --subset)
    ['SB49', 'src/cli/eval.mjs', [["    if (subset.n === 0) {", "    if (subset.n === 1) {"]], ['unit-subsetLedger']], //空子庫不警示而留 1 隻者警示
    ['SB50', 'src/cli/eval.mjs', [["    if (subset.n === 0) {", "    if (subset.n >= 0) {"]], ['unit-subsetLedger']], //留 ≥ 1 隻者亦警示
    ['SB51', 'src/cli/eval.mjs', [["    if (subset.n === 0) {", "    if (false) {"]], ['unit-subsetLedger']], //空子庫不警示
    //  設定讀不到之處理已移至 src/cfg.mjs 之 settingsOrExit(排程第 611 項 ①; 各進入檔與工具同一入口); libCheck 之案(unit-libCheck)與 unit-settingsOrExit 皆須抓到
    ['SB52', 'src/cfg.mjs', [["或設定 ARSI_ROOT`)\n        process.exit(2)", "或設定 ARSI_ROOT`)\n        process.exit(1)"]], ['unit-libCheck', 'unit-settingsOrExit']], //設定讀不到之離開碼不為 2
    ['SB53', 'src/cfg.mjs', [["    catch (err) {\n        let msg = inputMsgOf(err)\n        console.log(msg !== null ?", "    catch (err) {\n        throw err\n        let msg = inputMsgOf(err)\n        console.log(msg !== null ?"]], ['unit-libCheck', 'unit-settingsOrExit']], //設定讀不到不捕捉(未捕捉之例外,離開碼 1)
    ['SB54', 'src/cfg.mjs', [["    catch (err) {\n        let msg = inputMsgOf(err)\n        console.log(msg !== null ?", "    catch (err) {\n        if (!(err && err.code === 'ENOENT')) {\n            throw err\n        }\n        let msg = inputMsgOf(err)\n        console.log(msg !== null ?"]], ['unit-libCheck', 'unit-settingsOrExit']], //只捕捉檔案不存在(資料夾、不合法之 JSON、缺欄位仍為未捕捉之例外)
    ['SB55', 'src/cfg.mjs', [["${P('settings.json')});請於", "${String((err && err.message) || err).split('\\n')[0]});請於"]], ['unit-libCheck', 'unit-settingsOrExit']], //訊息改帶原錯誤之內容(JSON 之解析錯誤會回顯檔案之內容)
    ['SB56', 'src/cfg.mjs', [["${P('settings.json')});請於", "settings.json);請於"]], ['unit-libCheck', 'unit-settingsOrExit']], //訊息不帶 settings.json 之路徑
    ['EX01', 'src/domain/verifyExposure.mjs', [["let hit = fs || (shift && (sf || fl.length > 0))", "let hit = fs || shift || sf || fl.length > 0"]], ['unit-exposure']], //三條任一即曝險(不以席次之側別隨期改變為前提)
    ['EX02', 'src/domain/verifyExposure.mjs', [["let hit = fs || (shift && (sf || fl.length > 0))", "let hit = fs || (shift && sf && fl.length > 0)"]], ['unit-exposure']], //須三者並存
    ['EX03', 'src/domain/verifyExposure.mjs', [["Math.round(Math.abs(a - b) * 1e9) / 1e9 >= cfg.minShift", "Math.abs(a - b) >= cfg.minShift"]], ['unit-exposure']], //差不取整(恰為門檻者因浮點之尾差不成立)
    ['EX04', 'src/domain/verifyExposure.mjs', [["/ 1e9 >= cfg.minShift", "/ 1e9 > cfg.minShift"]], ['unit-exposure']], //恰為門檻者不成立
    ['EX05', 'src/domain/verifyExposure.mjs', [["rel.selHash === raw.selHash", "true"]], ['unit-exposure']], //放行不綁選集指紋
    ['EX06', 'src/domain/verifyExposure.mjs', [["let sf = !!tr && sideFlowIssue(", "let sf = sideFlowIssue("]], ['unit-exposure']], //訓練期之診斷缺者仍取其做空單比例
    ['EX07', 'src/domain/verifyExposure.mjs', [["filter((f) => cfg.flags.includes(f.name))", "filter((f) => true)"]], ['unit-exposure']], //採計全部之擴充診斷之旗標
    ['EX08', 'src/domain/verifyExposure.mjs', [["if (v === false) {", "if (v === null) {"]], ['unit-exposure']], //false 不關閉
    ['EX09', 'src/domain/verify.mjs', [["let fixedSideOf = (a, b, sizeMax) => sizeMax > 0 && ", "let fixedSideOf = (a, b, sizeMax) => "]], ['unit-exposure']], //固定側別不要求選集非空
    ['EX10', 'src/domain/domain.mjs', [["cands = cands.filter((n) => !exposureOfNode(n).blocked)", "void 0"]], ['unit-exposure']], //補位之底取曝險者
    ['EX11', 'src/domain/domain.mjs', [["if (ex && ex.blocked) {", "if (false) {"]], ['unit-exposure']], //前置閘門不拒曝險之起點
    ['EX12', 'src/domain/domain.mjs', [["if (ex.blocked) {", "if (false) {"]], ['unit-exposure']], //方向之提出不拒曝險之起點
    ['EX13', 'src/domain/domain.mjs', [["if (xh) {", "if (false) {"]], ['unit-exposure']], //提示之重產不含側別曝險
    ['EX14', 'src/domain/domain.mjs', [["let isEvalHint = (s) => isTwoHint(s) || isExposureHint(s)", "let isEvalHint = (s) => isTwoHint(s)"]], ['unit-exposure']], //舊之曝險提示不被替換(放行後仍留)
    ['EX15', 'src/domain/domain.mjs', [["return e.hit ? (e.released ? ' 曝險(已放行)' : ' 曝險') : ''", "return ''"]], ['unit-exposure']], //看板之「S」一欄不標
    ['EX16', 'src/domain/domain.mjs', [["${xMark(n) ? `;**${xMark(n).slice(1, -1)}**` : ''}", ""]], ['unit-exposure']], //搜尋地圖之譜系不標
    ['EX17', 'src/domain/domain.mjs', [["let xNote = ex.hit ? (ex.released ? ';側別曝險(已放行)' : ';側別曝險(不作為起點)') : ''", "let xNote = ''"]], ['unit-exposure']], //任務書之參考節點不註明
    ['EX18', 'src/tools/exposure.mjs', [["if (!undo && !e.hit) {", "if (false) {"]], ['unit-exposure']], //非曝險者亦放行
    ['EX19', 'src/tools/exposure.mjs', [["if (lock.running) {", "if (false) {"]], ['unit-exposure']], //輪次進行中不拒
    ['EX20', 'src/tools/exposure.mjs', [["doc.control = { ...(doc.control || {}), exposureRelease: rec ? { fingerprint: rec.selHash, why: rec.why, at: rec.at } : null }", "void 0"]], ['unit-exposure']], //節點文件不同步
    ['EX21', 'src/tools/exposure.mjs', [["P.refreshEvalHints([n.id])", "void 0"]], ['unit-exposure']], //提示不即時改寫
    ['EX22', 'src/arsi/records.mjs', [["if (isObj(d.control) && isObj(d.control.exposureRelease)) {", "if (false) {"]], ['unit-exposure']], //節點文件不渲染放行
    ['EX23', 'src/domain/agentEntries.mjs', [["exposure: { label: 'tools/exposure.mjs 之放行', writes: (args) => args.length > 0 },", "exposure: { label: 'tools/exposure.mjs 之放行', writes: () => false },"]], ['unit-agentGuard']], //agent 帶引數者不拒
    ['EX24', 'src/tools/fakeRound.mjs', [[".filter((n) => !Pj.exposureOf(n).blocked)", ""]], ['unit-fakeRound'], 'equiv'], //假輪次之預期之底不排除曝險者(假審計之樹無曝險之成品 ⇒ 此變異於該樹等價, 預期存活; 補位之底排除曝險者由 unit-exposure 之真樹案覆蓋)
    ['EX25', 'src/domain/domain.mjs', [["            hm = evalHintsAll(records.listNodeDocs(), st.records.workDir)", "            hm = evalHintsTwo(records.listNodeDocs(), st.records.workDir)"]], ['unit-exposure']], //--mode validate 之重掃不含側別曝險之一條(排程第 591 項之主控另加之專用案; 與兩條提示同一個判定之入口)
    ['EX26', 'src/domain/domain.mjs', [["let hs = hm ? (hm.get(d.nodeId) || []) : old.filter(isEvalHint)", "let hs = hm ? (hm.get(d.nodeId) || []) : old.filter(isTwoHint)"]], ['unit-exposure']], //重掃時判定之入口拋錯 ⇒ 既有之曝險提示被清掉(排程第 591 項之主控另加)
    ['SR01', 'src/domain/sideRead.mjs', [["let r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null", "let r = sxy / Math.sqrt(sxx * syy)"]], ['unit-sideRead']], //變異數為 0 者不回 null
    ['SR02', 'src/domain/sideRead.mjs', [["if (seen.has(k)) {", "if (false) {"]], ['unit-sideRead']], //同選集指紋者重複計
    ['SR03', 'src/domain/sideRead.mjs', [["if (xs.length < cfg.minNodes) {", "if (xs.length <= cfg.minNodes) {"]], ['unit-sideRead']], //恰為下限者不列
    ['SR04', 'src/domain/sideRead.mjs', [["Math.abs(r) >= cfg.corrAbs", "Math.abs(r) > cfg.corrAbs"]], ['unit-sideRead']], //相關恰為門檻者不警示
    ['SR05', 'src/domain/sideRead.mjs', [["short: topHi <= cfg.lo", "short: topHi < cfg.lo"]], ['unit-sideRead']], //恰為 lo 者不警示
    ['SR06', 'src/domain/sideRead.mjs', [["long: topLo >= cfg.hi", "long: topLo > cfg.hi"]], ['unit-sideRead']], //恰為 hi 者不警示
    ['SR07', 'src/domain/sideRead.mjs', [["sort((a, b) => (kv(b) - kv(a)) ||", "sort((a, b) => (kv(a) - kv(b)) ||"]], ['unit-sideRead']], //前幾名取排序鍵最低者
    ['SR08', 'src/domain/sideRead.mjs', [["if (!(c.lo < c.hi)) {", "if (false) {"]], ['unit-sideRead']], //lo ≥ hi 不回預設
    ['SR09', 'src/domain/domain.mjs', [["let ok = srCfg ? nodes.filter((n) => n.score && Number.isFinite(n.score.S) && !(n.score.flags && n.score.flags.vetoed) && n.raw && n.raw.metrics) : []", "let ok = srCfg ? nodes.filter((n) => n.score && Number.isFinite(n.score.S) && n.raw && n.raw.metrics) : []"]], ['unit-sideRead']], //被否決者亦計
    ['SR10', 'src/domain/domain.mjs', [["let rows = ok.filter((n) => !alias.has(n.id))", "let rows = ok.filter((n) => true)"]], ['unit-sideRead']], //別名亦計
    ['SR11', 'src/domain/domain.mjs', [["        if (srT.line) {", "        if (false) {"]], ['unit-sideRead']], //搜尋地圖不列讀數
    ['SR12', 'src/domain/domain.mjs', [["                lines.push(srT.warn)", "                void 0"]], ['unit-sideRead']], //輪末摘要不列警示
    ['SR13', 'src/tools/roundDigest.mjs', [["/^側別讀數之警示/", "/^側別讀數之警示X/"]], ['unit-exposure']], //一頁摘要不取警示之列
    ['GD01', 'src/domain/domain.mjs', [["show: !!key && ((!!content && content.id !== key.id) || keyEx.hit)", "show: !!key && (!!content && content.id !== key.id)"]], ['unit-gaugeDual']], //排序鍵最高者為曝險而與內容最高者相同時不列
    ['GD02', 'src/domain/domain.mjs', [["content.id !== key.id) || keyEx.hit)", "content.id === key.id) || keyEx.hit)"]], ['unit-gaugeDual']], //出現之條件反轉
    ['GD03', 'src/domain/domain.mjs', [["let cands = nodes.filter((n) => n.score && Number.isFinite(n.score.S) && !(n.score.flags && n.score.flags.vetoed) && n.evidence && n.evidence.trust === 'trusted')", "let cands = nodes.filter((n) => n.score && Number.isFinite(n.score.S) && !(n.score.flags && n.score.flags.vetoed))"]], ['unit-gaugeDual']], //非可信者亦為候選
    ['GD04', 'src/domain/domain.mjs', [["L.push(`**量尺(並列)**:${gaugeDualText(gd)}", "L.push(`**量尺**:${gaugeDualText(gd)}"]], ['unit-gaugeDual']], //看板之段落之字樣
    ['GD05', 'src/domain/domain.mjs', [["lines.push(`量尺(並列;樹上可信者):${gaugeDualText(gd)}`)", "void 0"]], ['unit-gaugeDual']], //輪末摘要不列並列
    ['GD06', 'src/domain/domain.mjs', [["return (ca === null ? 0 : cb - ca) || (kv(b) - kv(a))", "return (ca === null ? 0 : ca - cb) || (kv(b) - kv(a))"]], ['unit-gaugeDual']], //主鍵取內容最低者
    ['GD07', 'src/domain/domain.mjs', [["return ca === null ? 1 : -1", "return ca === null ? -1 : 1"]], ['unit-gaugeDual']], //無內容之值者排在前
    ['GD08', 'src/domain/domain.mjs', [["cands.sort((a, b) => byContent(rankKeyOf)(a, b) || (a.id < b.id ? -1 : 1))", "void 0"]], ['unit-gaugeDual']], //補位之底不依主鍵
    ['GD09', 'src/domain/domain.mjs', [["let rankBy = rankByRaw === 'content' ? 'content' : 'key'", "let rankBy = rankByRaw ? 'content' : 'key'"]], ['unit-gaugeDual']], //key 亦改主鍵(R-EV-54: 不認之值已於上拒絕)
    ['GD10', 'src/domain/domain.mjs', [["contentValOf(n) === null ? 1 : 0, -(contentValOf(n) === null ? 0 : contentValOf(n)), -kvOf(n)]", "-kvOf(n)]"]], ['unit-gaugeDual']], //看板之次序不依主鍵
    ['GD11', 'src/domain/domain.mjs', [["return ra.reduce((d, x, i) => d || (x - rb[i]), 0)", "return (ra[0] - rb[0]) || (ra[1] - rb[1])"]], ['unit-gaugeDual']], //次序只比前兩項(主鍵之值與次鍵不比)
    ['GD12', 'src/domain/domain.mjs', [["reduce((b, n) => (b === null || byContent(kvOf)(n, b) < 0 ? n : b), null)", "reduce((b, n) => (b === null || kvOf(n) > kvOf(b) ? n : b), null)"]], ['unit-gaugeDual']], //各臂之最佳不依主鍵
    ['GD13', 'src/domain/domain.mjs', [[".sort(byContent(kvOf))[0] || null", ".sort((a, b) => kvOf(b) - kvOf(a))[0] || null"]], ['unit-gaugeDual']], //搜尋地圖之最高不依主鍵
    ['GD14', 'src/domain/domain.mjs', [["**目前「挑選內容(組成對照之超額)最高且可信」之成品與「回測期 S 最高且可信」之成品(並列;同一個者寫一次並註明)**(各列 id、", "**目前回測期 S 最高且可信之成品**(id、"]], ['unit-gaugeDual']], //做夢更新 state 之句回到改前
    ['GD15', 'src/tools/roundDigest.mjs', [["/^量尺\\(並列/", "/^量尺\\(並列X/"]], ['unit-exposure']], //一頁摘要不取並列之列
    ['GD16', 'src/domain/rankCompare.mjs', [["let den = Math.sqrt((c + d + tx) * (c + d + ty))", "let den = Math.sqrt((c + d) * (c + d))"]], ['unit-gaugeDual']], //τ-b 之分母不計同值之對
    ['GD17', 'src/domain/rankCompare.mjs', [["r[idx[j].i] = (s + e) / 2 + 1", "r[idx[j].i] = s + 1"]], ['unit-gaugeDual']], //同值不取平均名次
    ['GD18', 'src/domain/rankCompare.mjs', [["overlap: topK.filter((x) => inC.has(x.id)).length", "overlap: topK.length"]], ['unit-gaugeDual']], //交集之個數
    //── 成員穩健性之附算與「成員依賴」之提示(MC 系列; 規則 R-REC-51): 判定(verifyMember.mjs)、計畫與寫入(fillPlan.mjs)、執行與併入(domain.mjs)、呈現、命令列與任務書之一句 ──
    ['MC01', 'src/domain/verifyMember.mjs', [["let hit = (md !== null && md < cfg.minRetention) || row.nNeg > cfg.maxNegHalves", "let hit = (md !== null && md <= cfg.minRetention) || row.nNeg > cfg.maxNegHalves"]], ['unit-memberCheck']], //中位恰為門檻者命中
    ['MC02', 'src/domain/verifyMember.mjs', [["let hit = (md !== null && md < cfg.minRetention) || row.nNeg > cfg.maxNegHalves", "let hit = (md !== null && md < cfg.minRetention) || row.nNeg >= cfg.maxNegHalves"]], ['unit-memberCheck']], //負之半庫數恰為上限者命中
    ['MC03', 'src/domain/verifyMember.mjs', [["if (!cfg || !isObj(row) || row.applicable !== true || !isObj(row.retention)) {", "if (!cfg || !isObj(row) || !isObj(row.retention)) {"]], ['unit-memberCheck']], //不適用者仍判
    ['MC04', 'src/domain/verifyMember.mjs', [["let applicable = full !== null && full > 0", "let applicable = full !== null && full >= 0"]], ['unit-memberCheck']], //全庫之內容為 0 者適用
    ['MC05', 'src/domain/verifyMember.mjs', [["let kindOf = (m) => (activeOf(m) && recentDiagOf(m) ? 'recent' : 'builtin')", "let kindOf = (m) => 'builtin'"]], ['unit-memberCheck']], //內容之種類恆為內建
    ['MC06', 'src/domain/verifyMember.mjs', [["nNeg: hs.filter((h) => h.eqYrMean !== null && h.eqYrMean < 0).length", "nNeg: hs.filter((h) => h.eqYrMean !== null && h.eqYrMean <= 0).length"]], ['unit-memberCheck']], //相位平均恰為 0 者計為負
    ['MC07', 'src/domain/verifyMember.mjs', [["(s[k / 2 - 1] + s[k / 2]) / 2", "s[k / 2]"]], ['unit-memberCheck']], //偶數個之中位取上中位
    ['MC08', 'src/domain/verifyMember.mjs', [["min: rs.length ? Math.min(...rs) : null", "min: rs.length ? Math.max(...rs) : null"]], ['unit-memberCheck']], //最小取最大
    ['MC09', 'src/domain/verifyMember.mjs', [["        if (o.salts.length === 0) {", "        if (false) {"]], ['unit-memberCheck']], //鹽為空陣列不關閉
    ['MC10', 'src/domain/verifyMember.mjs', [["nullDraws: nd !== null ? nd : (rd !== null ? rd : 32),", "nullDraws: nd !== null ? nd : 32,"]], ['unit-memberCheck']], //抽數不取 replicaNullDraws
    ['MC11', 'src/domain/verifyMember.mjs', [["salts = [...new Set(xs)]", "salts = xs"]], ['unit-memberCheck']], //鹽不去重
    ['MC12', 'src/domain/verifyMember.mjs', [["let ld = sc.flags && typeof sc.flags.trainLadder === 'number' ? sc.flags.trainLadder : sc.ladder", "let ld = sc.ladder"]], ['unit-memberCheck']], //合格不看評估期之階梯
    ['MC13', 'src/domain/verifyMember.mjs', [["if (!cfg || !sc || (sc.flags && sc.flags.vetoed)) {", "if (!cfg || !sc) {"]], ['unit-memberCheck']], //被否決者亦合格
    ['MC14', 'src/domain/verifyMember.mjs', [["typeof mb.selHash === 'string' && mb.selHash === sel ? mb.row : null", "typeof mb.selHash === 'string' ? mb.row : null"]], ['unit-memberCheck']], //樹上之讀數不核正本之選集指紋
    ['MC15', 'src/domain/fillPlan.mjs', [[" && v(a, 'member') === v(b, 'member')", ""]], ['unit-memberCheck']], //快取之鍵不比 member
    ['MC16', 'src/domain/fillPlan.mjs', [["&& isObj(fM.row) && canonOk(fM, isStr(n.selHash) ? n.selHash : null)", "&& isObj(fM.row)"]], ['unit-memberCheck']], //不核正本之選集指紋
    ['MC17', 'src/domain/fillPlan.mjs', [["let kM = mElig && mElig.has(n.id) ?", "let kM = mElig ?"]], ['unit-memberCheck']], //不合格者亦計畫
    ['MC18', 'src/domain/fillPlan.mjs', [["    if (needM0 && (deferM || !inT)) {\n            blMember.push(n.id)", "    if (needM0 && deferM) {\n            blMember.push(n.id)"]], ['unit-memberCheck']], //範圍外者不入待補算
    ['MC19', 'src/domain/fillPlan.mjs', [["isObj(k.member) && (!isObj(only) || only.member === true)", "isObj(k.member)"]], ['unit-memberCheck']], //只取之項目不及 member
    ['MC20', 'src/domain/fillPlan.mjs', [[": (p && isObj(p.member) ? { member: p.member } : {})),", ": {}),"]], ['unit-memberCheck']], //補算檔不沿用前次之成員穩健性
    ['MC21', 'src/domain/fillPlan.mjs', [["return f && sameKey(f.key, key) && isObj(f.row) && canonOk(f, canonSel) ? { at: f.at, row: f.row, canon:", "return f && isObj(f.row) && canonOk(f, canonSel) ? { at: f.at, row: f.row, canon:"]], ['unit-memberCheck']], //現行之值不核鍵(鹽改變仍補回)
    ['MC22', 'src/domain/fillPlan.mjs', [["let res = all.filter((x) => !(x.member !== undefined && x.postfit === null && extN(x) === 0))", "let res = all"]], ['unit-memberCheck']], //只有成員穩健性者計入首列
    ['MC23', 'src/domain/fillPlan.mjs', [["    if (pre) {\n        return out\n    }", "    if (false) {\n        return out\n    }"]], ['unit-memberCheck']], //派做夢之前之一次照列待補算
    ['MC24', 'src/domain/fillPlan.mjs', [["if (nPf || exParts.length || nMem) {", "if (nPf || exParts.length) {"]], ['unit-memberCheck']], //只有成員穩健性之待補算者不列
    ['MC25', 'src/domain/domain.mjs', [["let isEvalHint = (s) => isTwoHint(s) || isExposureHint(s) || isMemberHint(s)", "let isEvalHint = (s) => isTwoHint(s) || isExposureHint(s)"]], ['unit-memberCheck']], //重掃與重產不替換成員依賴之提示
    ['MC26', 'src/domain/domain.mjs', [["let mh = n && n.status === 'executed' ? memberHintOfNode(n) : null", "let mh = null"]], ['unit-memberCheck']], //判定之入口不併成員依賴之提示
    ['MC27', 'src/domain/domain.mjs', [["let hint = selAt !== null && selAt === selNow ? memberHintOf(mb.row, mcfg) : null", "let hint = null"]], ['unit-memberCheck']], //併入時不寫提示
    ['MC28', 'src/domain/domain.mjs', [["d.harness.notes : []).filter((s) => !String(s).startsWith(MEMBER_HEAD))", "d.harness.notes : [])"]], ['unit-memberCheck']], //迴圈判讀之舊列不取代
    ['MC29', 'src/domain/domain.mjs', [["member: { at: mb.at, row: mb.row, selHash: selAt }", "member: { at: mb.at, row: mb.row, selHash: null }"]], ['unit-memberCheck']], //樹之讀數不記選集指紋
    ['MC30', 'src/domain/domain.mjs', [["                    if (!okDoc || !okTree) {", "                    if (false) {"]], ['unit-memberCheck']], //不補回
    ['MC31', 'src/domain/domain.mjs', [["!isObjF(o.member) || o.member.tag !== tag)", "!isObjF(o.member))"]], ['unit-memberCheck']], //不核半庫之標記
    ['MC32', 'src/domain/domain.mjs', [["                        break\n                    }\n                    halves.push({ tag, n: o.member.n, metrics: o.metrics })", "                    }\n                    halves.push({ tag, n: o.member.n, metrics: o.metrics })"]], ['unit-memberCheck']], //失敗不即止
    ['MC33', 'src/domain/domain.mjs', [["'--ext-only', RECENT_DIAG, '--member', tag,", "'--member', tag,"]], ['unit-memberCheck']], //半庫之評估不限載入之診斷
    ['MC34', 'src/domain/domain.mjs', [["cur.member = fo.member === true && x.member === 'failed'", "cur.member = false"]], ['unit-memberCheck']], //強制重算之失敗不續為強制
    ['MC35', 'src/domain/domain.mjs', [["...(ext.length ? { ext } : {}), ...(v.member === true ? { member: true } : {}) }", "...(ext.length ? { ext } : {}) }"]], ['unit-memberCheck']], //待重試之 force 不帶 member
    ['MC36', 'src/domain/domain.mjs', [["let eligible = nodes.map((x) => x.id).filter((id) => memberEligibleOf(rsi.store.getNode(id), mcfg))", "let eligible = nodes.map((x) => x.id)"]], ['unit-memberCheck']], //不篩合格者
    ['MC37', 'src/domain/domain.mjs', [["let anyMember = nodes.some((n) => memberRowOfTree(n) !== null)", "let anyMember = true"]], ['unit-memberCheck']], //看板無讀數者亦加欄
    ['MC38', 'src/domain/domain.mjs', [["return `;成員保持率 ${v}", "return '' && `;成員保持率 ${v}"]], ['unit-memberCheck']], //搜尋地圖不註記
    ['MC39', 'src/domain/pickStore.mjs', [["let memberOn = fillOn && [...fills.values()].some(", "let memberOn = fillOn || [...fills.values()].some("]], ['unit-memberCheck']], //補算檔皆無此項亦帶 member 之鍵
    ['MC40', 'src/cli/rsi.mjs', [["member: !process.argv.includes('--no-member') }", "member: true }"]], ['unit-memberCheck']], //--no-member 無作用
    ['MC41', 'src/domain/texts.mjs', [["迴圈之讀數:合格之新成品於派做夢之前已以隨機半庫重跑 —— 命中者 §1 之「迴圈檢查」列「提示(成員依賴)」,其餘見節點文件之迴圈判讀之「成員穩健性」一列;無迴圈之讀數者以 `--member` 自行核對。", ""]], ['unit-memberCheck']], //任務書之一句不指向迴圈之讀數
    ['MC42', 'src/domain/domain.mjs', [["memberHit = memberHintOf(mrow, mcfg) !== null", "memberHit = false"]], ['unit-memberCheck']], //摘要之命中數
    //── 附算之時點(PD 系列; 規則 R-REC-51 ⑤): 求解窗後段與成員穩健性於派做夢之前、同一項每輪至多一次、待重試與不重試之失敗之紀錄每輪記一次 ──
    ['PD01', 'src/domain/domain.mjs', [["if (autoFillOf(st.rsi) && nodeIds.length) {", "if (false) {"]], ['unit-memberCheck']], //不於派做夢之前附算
    ['PD02', 'src/domain/domain.mjs', [["...(skip ? { skip, prior: preFill } : {}),", ""]], ['unit-memberCheck']], //做夢之後重做同一項
    ['PD03', 'src/domain/domain.mjs', [["...(skip ? { skip, prior: preFill } : {}),", "...(skip ? { skip } : {}),"]], ['unit-memberCheck']], //派做夢之前之失敗不入紀錄
    ['PD04', 'src/domain/domain.mjs', [["let resB = preRun ? [] : (pr ? mergeRes(results, pr.results) : results)", "let resB = pr ? mergeRes(results, pr.results) : results"]], ['unit-memberCheck']], //派做夢之前之一次亦記 ⇒ 一輪記兩次
    ['PD05', 'src/domain/domain.mjs', [["postfit: x.postfit !== null ? x.postfit : p.postfit,", "postfit: x.postfit,"]], ['unit-fillBacklog']], //合併不取派做夢之前之求解窗後段之結果(不重試之失敗之指紋缺該項)
    ['PD06', 'src/domain/fillPlan.mjs', [["${pre ? '附算(派做夢之前;求解窗後段;佐證,不改 S)' : '附算(求解窗後段與擴充診斷;佐證,不改 S)'}", "${'附算(求解窗後段與擴充診斷;佐證,不改 S)'}"]], ['unit-memberCheck']], //派做夢之前之一次之首列之字樣
    ['PD07', 'src/domain/domain.mjs', [["...(preSum ? { fill: { preDream: preSum, ...(msF ? { member: msF } : {}) } } : {})", ""]], ['unit-fillRevise']], //做夢未交付時不回傳派做夢之前之附算
    ['PD08', 'src/domain/domain.mjs', [["...(preSum ? { preDream: preSum } : {}), ...(ms ? { member: ms } : {})", "...(ms ? { member: ms } : {})"]], ['unit-fillRun']], //fill 不帶 preDream
    ['PD09', 'src/domain/domain.mjs', [["let pf = t.postfit && !(skipPf && skipPf.has(t.nodeId))", "let pf = t.postfit"]], ['unit-memberCheck']], //skip 不作用於求解窗後段
    ['PD10', 'src/domain/domain.mjs', [["postfit: true, ext: false, member: true, storeAfter: false, source: 'round', stage: 'preDream'", "postfit: true, ext: true, member: true, storeAfter: false, source: 'round', stage: 'preDream'"]], ['unit-memberCheck']], //擴充診斷亦移到派做夢之前
    ['PD11', 'src/domain/domain.mjs', [["let keepPr = (x) => liveIds.has(x.nodeId) && (carriedIds === null || carriedIds.has(x.nodeId))", "let keepPr = (x) => liveIds.has(x.nodeId)"]], ['unit-memberCheck']], //prior 之併入不限於 skip 所列者(重做者之舊失敗併入新成品)
    ['PD12', 'src/domain/domain.mjs', [["let keepPr = (x) => liveIds.has(x.nodeId) && (carriedIds === null || carriedIds.has(x.nodeId))", "let keepPr = (x) => carriedIds === null || carriedIds.has(x.nodeId)"]], ['unit-memberCheck']], //prior 之併入不核仍在樹上(做夢刪除者之舊失敗併入)
    //── 「有內容」之單一定義(HC 系列; 規則 R-REC-49 ⑤): 並列、主鍵、補位之底、估法之候選 ──
    ['HC01', 'src/domain/domain.mjs', [["let c = contentOf(n); return c && hasContentNode(n) ? c.v : null", "let c = contentOf(n); return c ? c.v : null"]], ['unit-gaugeContent']], //主鍵與並列不看「有內容」(改前)
    ['HC02', 'src/domain/domain.mjs', [["anyValue: !content && cands.some((n) => contentOf(n) !== null)", "anyValue: false"]], ['unit-gaugeContent']], //並列之註記不分兩種情形
    ['HC03', 'src/domain/domain.mjs', [["let hasContent = (n) => hasContentOf(n, pMax)", "let hasContent = (n) => contentOf(n) !== null"]], ['unit-gaugeContent']], //搜尋地圖之「有內容」與單一定義不同
    ['HC04', 'src/domain/domain.mjs', [["let noValueWhy = (n) => (contentOf(n) ? '不符「有內容」' : '無其值')", "let noValueWhy = () => '無其值'"]], ['unit-gaugeContent']], //註記不分「不符」
    ['HC05', 'src/tools/rankCompare.mjs', [["    .filter((n) => Pk.hasContent(n))", "    .filter(() => true)"]], ['unit-gaugeContent']], //估法之候選不看「有內容」
    ['VZ08', 'src/domain/domain.mjs', [["let mcfg = memberCfgOfSt(st)", "let mcfg = memberCfgOfSt(st) //minRetention"]], ['unit-verifyZone']], //領域內嵌成員依賴之門檻之名(判定與門檻須只在禁區內之檔)
    //── 排程第 593 項之修正輪(tad206b; 主控之裁定): 快取之鍵併近期活躍度版之診斷之雜湊、做夢未交付之字樣、任務書之一句隨設定、實數鍵收數字字串(MD 系列; 規則 R-REC-51)──
    ['MD01', 'src/domain/fillPlan.mjs', [[", ...(dep ? { diag: diag === undefined ? null : diag } : {}) })", " })"]], ['unit-memberCheck']], //讀數依診斷者之鍵不帶診斷之雜湊(診斷改寫不重算)
    ['MD02', 'src/domain/fillPlan.mjs', [["&& mRecent && mRecent.has(n.id))", "&& mRecent)"]], ['unit-memberCheck']], //recent 所列者與否皆帶診斷之雜湊(不依者亦因診斷改寫而重算)
    ['MD03', 'src/domain/fillPlan.mjs', [["let deferM = needM0 && dep", "let deferM = false && needM0 && dep"]], ['unit-memberCheck']], //正本之診斷值過時者不延後(全庫之值與各半之值不同版而照算)
    ['MD04', 'src/domain/fillPlan.mjs', [["dh !== null && !names.includes(mDiag) && !extCurrent(n, mDiag,", "dh !== null && !extCurrent(n, mDiag,"]], ['unit-memberCheck']], //本次補該診斷者亦延後(不與診斷之補算同一任務)
    ['MD05', 'src/domain/fillPlan.mjs', [["&& !extCurrent(n, mDiag, {", "&& extCurrent(n, mDiag, {"]], ['unit-memberCheck']], //延後之判準反向(現行者延後、過時者照算)
    ['MD06', 'src/domain/fillPlan.mjs', [["if (needM0 && (deferM || !inT)) {", "if (needM0 && !inT) {"]], ['unit-memberCheck']], //延後者不列入待補算
    ['MD07', 'src/domain/fillPlan.mjs', [["if (!needM0) {\n                nCurrent++\n            }\n            continue", "nCurrent++\n            continue"]], ['unit-memberCheck']], //延後者計為現行
    ['MD08', 'src/domain/fillPlan.mjs', [[", ...(k.member.diag === undefined ? [] : [k.member.diag])]", "]"]], ['unit-memberCheck']], //待算之鍵之正規字串不含診斷之雜湊(診斷改寫後之同一失敗被當成重跑結果相同)
    ['MD09', 'src/domain/verifyMember.mjs', [["m.sel.sigPerPick >= 2 * m.null.sigPerPick", "m.sel.sigPerPick > 2 * m.null.sigPerPick"]], ['unit-memberCheck']], //依診斷之判準之邊界(恰為 2 倍亦是)
    ['MD10', 'src/domain/domain.mjs', [["recent: eligible.filter((id) => memberRecentCapableOf(rsi.store.getNode(id))), diagName: RECENT_DIAG }", "recent: [], diagName: RECENT_DIAG }"]], ['unit-memberCheck']], //計畫不給依診斷者(鍵恆不帶診斷之雜湊)
    ['MD11', 'src/domain/domain.mjs', [["mrow = memberRowOf(diagNew ? { ...cm, ext: { ...(isObjF(cm.ext) ? cm.ext : {}), [RECENT_DIAG]: diagNew } } : cm, halves, mcfg)", "mrow = memberRowOf(cm, halves, mcfg)"]], ['unit-memberCheck']], //全庫之值取樹上之舊版診斷值(與各半之現行診斷不同版)
    ['MD12', 'src/domain/domain.mjs', [["if (memberDep && task.ext.includes(RECENT_DIAG) && !diagNew) {", "if (false) {"]], ['unit-memberCheck']], //同任務之診斷補算失敗仍算讀數
    ['MD13', 'src/domain/domain.mjs', [["dep: memberRecentCapableOf(rsi.store.getNode(n.id)), diag: dgHash === undefined ? null : dgHash }", "dep: false }"]], ['unit-memberCheck']], //節點文件之補回之鍵不帶診斷之雜湊(與計畫之鍵不同 ⇒ 補回不成)
    ['MD14', 'src/domain/verifyMember.mjs', [["let numOf = (v) => (isenum(v) ? Number(v) : null)", "let numOf = fin"]], ['unit-memberCheck']], //實數鍵不收數字字串(改前)
    ['MD15', 'src/domain/verifyMember.mjs', [["let numOf = (v) => (isenum(v) ? Number(v) : null)", "let numOf = (v) => (isenum(v) ? v : null)"]], ['unit-memberCheck']], //實數鍵通過後仍用原字串(跨套件規格 K4)
    ['MD16', 'src/domain/verifyExposure.mjs', [["isenum(o.minShift, { gt: 0, max: 1 }) ? Number(o.minShift) : EXPOSURE_DEFAULT.minShift", "typeof o.minShift === 'number' && Number.isFinite(o.minShift) && o.minShift > 0 && o.minShift <= 1 ? o.minShift : EXPOSURE_DEFAULT.minShift"]], ['unit-exposure']], //minShift 不收數字字串(改前)
    ['MD17', 'src/domain/verifyExposure.mjs', [["? Number(o.minShift) :", "? o.minShift :"]], ['unit-exposure']], //minShift 通過後仍用原字串
    ['MD18', 'src/domain/verifyExposure.mjs', [["{ gt: 0, max: 1 }", "{ max: 1 }"]], ['unit-exposure']], //minShift 之下界不排除 0
    ['MD19', 'src/domain/verifyExposure.mjs', [["{ gt: 0, max: 1 }", "{ gt: 0 }"]], ['unit-exposure']], //minShift 之上界不限 1
    ['MD20', 'src/domain/texts.mjs', [["let memberOn = autoFillOn && memberCfgOfSt(st) !== null", "let memberOn = true"]], ['unit-memberCheck']], //任務書之一句不隨設定(改前)
    ['MD21', 'src/domain/texts.mjs', [["let memberOn = autoFillOn && memberCfgOfSt(st) !== null", "let memberOn = memberCfgOfSt(st) !== null"]], ['unit-memberCheck']], //一句不隨 autoFill 關閉而略去
    ['MD22', 'src/domain/texts.mjs', [["let memberOn = autoFillOn && memberCfgOfSt(st) !== null", "let memberOn = autoFillOn"]], ['unit-memberCheck']], //一句不隨 memberCheck 關閉而略去
    ['MD23', 'src/domain/fillPlan.mjs', [["!(rsiCfg && rsiCfg.autoFill === false)", "!(rsiCfg && rsiCfg.autoFill == false)"]], ['unit-memberCheck']], //autoFill 之判定寬鬆(0、空字串亦視為關閉)
    ['MD24', 'src/domain/fillPlan.mjs', [["let retryText = typeof retryAt === 'string' && retryAt !== '' ? retryAt :", "let retryText = false ? retryAt :"]], ['unit-memberCheck']], //重試時機之字樣不可取代
    ['MD25', 'src/domain/fillPlan.mjs', [[";失敗者(${retryText}):${badM.map(", ";失敗者(${r.source === 'round' ? '下一次輪末重試' : '再執行補算工具時重試'}):${badM.map("]], ['unit-memberCheck']], //成員穩健性一列之重試時機字樣不可取代
    ['MD26', 'src/domain/domain.mjs', [["{ stage: 'preDream', retryAt: '做夢未交付,未記入待重試;補做夢時重算' }", "{ stage: 'preDream' }"]], ['unit-memberCheck']], //做夢未交付時摘要列之字樣不改
    ['MD27', 'src/domain/domain.mjs', [["if (autoFillOf(st.rsi)) {", "if (true) {"]], ['unit-memberCheck']], //做夢之後之附算不隨 autoFill 關閉而略去
    ['MD28', 'src/domain/domain.mjs', [["task.keys.member.diag !== undefined)", "false)"]], ['unit-memberCheck']], //不辨讀數依診斷之任務(同任務之診斷值不取用、補算失敗不攔)
    //── 命令列旗標之等號寫法(排程第 590 項; cfg.mjs 之 eqFlagMsgOf 與 CLI_FLAGS、各進入檔之接線) ──
    ['TQ01', 'src/cfg.mjs', [["a.startsWith('--') && a.includes('='))", "a.startsWith('--'))"]], ['unit-cliEqFlags']], //凡 -- 起首者皆拒(不論有無等號)
    ['TQ02', 'src/cfg.mjs', [["a.startsWith('--') && a.includes('='))", "a.includes('='))"]], ['unit-cliEqFlags']], //凡含等號者皆拒(含值內含等號、單橫線之引數)
    ['TQ03', 'src/cfg.mjs', [["typeof a === 'string' && a.startsWith('--')", "a.startsWith('--')"]], ['unit-cliEqFlags']], //非字串之元素致 TypeError
    ['TQ04', 'src/cfg.mjs', [["    let nm = nameOf(a)\n    if (!known(nm)) {", "    let nm = nameOf(a)\n    if (false) {"]], ['unit-cliEqFlags']], //未列之旗標(含原型之名稱)亦以其名稱寫入訊息(回顯輸入)
    ['TQ05', 'src/cfg.mjs', [["    return flags[nm] === null ? ", "    return flags[nm] !== null ? "]], ['unit-cliEqFlags']], //布林旗標與帶值旗標之訊息互換
    ['TQ06', 'src/cfg.mjs', [["        if (pickEq !== null) {\n            break\n        }", "        if (false) {\n            break\n        }"]], ['unit-cliEqFlags']], //優先序之旗標: 最後一個所列者勝(而非第一個)
    ['TQ07', 'src/cfg.mjs', [["    let nameOf = (a) => a.slice(2, a.indexOf('='))\n    let known = (nm) => Object.prototype.hasOwnProperty.call(flags, nm)", "    let nameOf = (a) => a.slice(2, a.indexOf('='))\n    let known = (nm) => (nm in flags)"]], ['unit-cliEqFlags']], //原型之名稱(constructor、__proto__…)被當作已列之旗標
    ['TQ08', 'src/cfg.mjs', [["let a = pickEq !== null ? pickEq : eqs[0]", "let a = eqs[0]"]], ['unit-cliEqFlags']], //不採優先序
    ['TQ09', 'src/cfg.mjs', [["a.slice(2, a.indexOf('='))", "a.slice(2)"]], ['unit-cliEqFlags']], //旗標名含 =值(皆被當作未列之旗標)
    ['TQ10', 'src/cli/eval.mjs', [["    if (argMsg !== null) {", "    if (false) {"]], ['unit-cliEqFlags']], //g_eval.mjs 不檢查
    ['TQ11', 'src/cli/backtest.mjs', [["    if (argMsg !== null) {", "    if (false) {"]], ['unit-cliEqFlags']], //g_backtest.mjs 不檢查
    ['TQ12', 'src/cli/build.mjs', [["    if (argMsg !== null) {", "    if (false) {"]], ['unit-cliEqFlags']], //g_build.mjs 不檢查
    ['TQ13', 'src/cli/rsi.mjs', [["    if (argMsg !== null) {", "    if (false) {"]], ['unit-cliEqFlags']], //g_rsi.mjs 不檢查
    ['TQ14', 'src/cli/toolbox.mjs', [["    if (argMsg !== null) {", "    if (false) {"]], ['unit-cliEqFlags']], //g_toolbox.mjs 不檢查
    ['TQ15', 'src/cli/launch.mjs', [["    if (argMsg !== null) {", "    if (false) {"]], ['unit-cliEqFlags']], //g_launch.mjs 不檢查
    ['TQ16', 'src/cfg.mjs', [["        'tie-salt': '<N>',\n", ""]], ['unit-cliEqFlags']], //表內缺旗標(盤點與訊息皆不合)
    ['TQ17', 'src/cfg.mjs', [["        'no-log': null,\n", "        'no-log': '<x>',\n"]], ['unit-cliEqFlags']], //布林旗標被當作帶值者(訊息不合)
    ['TQ18', 'src/cli/eval.mjs', [["phasesList = cfgListOf(String(phasesArg).split(','), null, '--phases', 'nonNegNum')", "phasesList = String(phasesArg).split(',').map((x) => Number(x))"]], ['unit-cliEqFlags']], //--phases 回到 Number(x) 之隱式轉換(非數字為 NaN)
    ['TQ19', 'src/cli/eval.mjs', [["        wholeBarsOf(phasesList, L.barsPerDay, '--phases', 'a non-negative')", "        void 0"]], ['unit-cliEqFlags']], //--phases 不核對與每日棒數之積
    ['TQ20', 'src/cli/eval.mjs', [["Number.isSafeInteger(seedArg)", "Number.isFinite(seedArg)"]], ['unit-cliEqFlags']], //--seed 收小數(評估器之種子須為整數 ⇒ 於評估中才拋)
    ['TQ21', 'src/cli/eval.mjs', [["Number.isSafeInteger(tieArg)", "Number.isFinite(tieArg)"]], ['unit-cliEqFlags']], //--tie-salt 收小數
    ['TQ22', 'src/cli/eval.mjs', [["    evRun = evalRunNumsOf(st.eval, 'eval')\n", "    evRun = { seed: 1 }\n"]], ['unit-cliEqFlags']], //命令列不用設定之種子(字串之種子 / 設定之種子失效)
    ['TQ23', 'src/cli/backtest.mjs', [["    evRun = evalRunNumsOf(st.eval, 'eval')\n", "    evRun = { seed: st.eval.seed }\n"]], ['unit-evalRunNums']], //g_backtest.mjs 之種子取設定之原值(字串之種子 + i 為字串相接)
    //── settings.eval 之執行面之數字、硬上限、相位與地平線(排程第 595 項; cfgNum.mjs、barGrid.mjs、evalCore.mjs、score.mjs 與各使用處) ──
    ['VN01', 'src/eval/cfgNum.mjs', [["int: ['an integer', (x) => Number.isSafeInteger(x)],", "int: ['an integer', (x) => Number.isFinite(x)],"]], ['unit-evalRunNums']], //種子與鹽收小數
    ['VN02', 'src/eval/cfgNum.mjs', [["    seed: [1, 'int'],", "    seed: [2, 'int'],"]], ['unit-evalRunNums']], //種子之預設
    ['VN03', 'src/eval/cfgNum.mjs', [["    tieSalt: [0, 'int'],", "    tieSalt: [1, 'int'],"]], ['unit-evalRunNums']], //同分次序之鹽之預設
    ['VN04', 'src/eval/cfgNum.mjs', [["    replicaNullDraws: [32, 'nonNegInt'],", "    replicaNullDraws: [16, 'nonNegInt'],"]], ['unit-evalRunNums']], //重放之虛無抽數之預設
    ['VN05', 'src/eval/cfgNum.mjs', [["    timeoutSec: [900, 'timerSec'],", "    timeoutSec: [900, 'nonNegNum'],"]], ['unit-evalRunNums']], //逾時收 0 且無上限
    ['VN06', 'src/eval/cfgNum.mjs', [["    geoTp: [3, 'posInt'],", "    geoTp: [3, 'nonNegInt'],"]], ['unit-evalRunNums']], //止盈等分數收 0
    ['VN07', 'src/eval/cfgNum.mjs', [["    geoSl: [3, 'posInt'],", "    geoSl: [4, 'posInt'],"]], ['unit-evalRunNums']], //止損等分數之預設
    ['VN08', 'src/eval/cfgNum.mjs', [["    replicaSeeds: [0, 'nonNegInt'],", "    replicaSeeds: [0, 'posInt'],"]], ['unit-evalRunNums']], //重放次數不收 0
    ['VN09', 'src/eval/cfgNum.mjs', [["    if (!Array.isArray(spec)) {", "    if (false) {"]], ['unit-evalRunNums']], //單一鍵之取值不核對鍵名(原型之名稱)
    ['VN10', 'src/eval/cfgNum.mjs', [["let EVAL_LIMITS = { monthlyOrders: 400, peakHold: 50 }", "let EVAL_LIMITS = { monthlyOrders: 400, peakHold: 60 }"]], ['unit-evalRunNums']], //硬上限之預設
    ['VN11', 'src/eval/cfgNum.mjs', [["typeof l !== 'object' || Array.isArray(l)) {\n        throw new Error(`invalid ${who}.limits", "typeof l !== 'object') {\n        throw new Error(`invalid ${who}.limits"]], ['unit-evalRunNums']], //eval.limits 收陣列
    ['VN12', 'src/eval/cfgNum.mjs', [["`${who}.limits.${k}`, 'nonNegNum')", "`${who}.limits.${k}`, 'posNum')"]], ['unit-evalRunNums']], //硬上限不收 0
    ['VN13', 'src/eval/cfgNum.mjs', [["(v.length === 0 && allowEmpty !== true)", "(v.length === 0 && false)"]], ['unit-evalRunNums']], //相位之清單收空陣列
    ['VN14', 'src/eval/cfgNum.mjs', [["        if (x === undefined || x === null) {\n            throw new Error(`invalid ${where}[${i}]", "        if (x === undefined) {\n            throw new Error(`invalid ${where}[${i}]"]], ['unit-evalRunNums']], //清單之元素為 null 者當作 0
    ['VN15', 'src/eval/barGrid.mjs', [["    if (phases !== null) {", "    if (false) {"]], ['unit-evalRunNums']], //相位不核對與每日棒數之積
    ['VN16', 'src/eval/barGrid.mjs', [["    if (horizons !== null) {", "    if (false) {"]], ['unit-evalRunNums']], //地平線不核對與每日棒數之積
    ['VN17', 'src/eval/barGrid.mjs', [["    evalRunNumsOf(st && st.eval, 'eval')\n", "    void 0\n"]], ['unit-evalRunNums']], //組裝時之預檢不檢執行面之數字
    ['VN18', 'src/eval/barGrid.mjs', [["    evalLimitsOf(st && st.eval, 'eval')\n", "    void 0\n"]], ['unit-evalRunNums']], //組裝時之預檢不檢硬上限
    ['VN19', 'src/eval/barGrid.mjs', [["    evalListsOf(st && st.eval, bpd, 'eval')\n", "    void 0\n"]], ['unit-evalRunNums']], //組裝時之預檢不檢相位與地平線
    ['VN20', 'src/eval/evalCore.mjs', [["let seed = cfgNumOf(opt.seed, cfgRun.seed, 'opt.seed', 'int')", "let seed = opt.seed === undefined ? cfg.seed : opt.seed"]], ['unit-evalRunNums']], //種子取原值(字串相接)
    ['VN21', 'src/eval/evalCore.mjs', [["let tieSalt = cfgRun.tieSalt", "let tieSalt = Number.isInteger(cfg.tieSalt) ? cfg.tieSalt : 0"]], ['unit-evalRunNums']], //同分次序之鹽取原值(字串之鹽失效)
    ['VN22', 'src/eval/evalCore.mjs', [["let nTp = cfgRun.geoTp", "let nTp = cfg.geoTp === undefined ? 3 : cfg.geoTp"]], ['unit-evalRunNums']], //止盈等分數取原值
    ['VN23', 'src/eval/evalCore.mjs', [["let nSl = cfgRun.geoSl", "let nSl = cfg.geoSl === undefined ? 3 : cfg.geoSl"]], ['unit-evalRunNums']], //止損等分數取原值
    ['VN24', 'src/eval/evalCore.mjs', [["phases = cfgLists.phases || [0, 1, 2, 3, 4, 5, 6]", "phases = cfg.phases || [0, 1, 2, 3, 4, 5, 6]"]], ['unit-evalRunNums']], //設定之相位取原值
    ['VN25', 'src/eval/evalCore.mjs', [["horizons = cfgLists.horizons || [1, 3, 7, 14, 30]", "horizons = cfg.horizons || [1, 3, 7, 14, 30]"]], ['unit-evalRunNums']], //設定之地平線取原值
    ['VN26', 'src/eval/evalCore.mjs', [["            wholeBarsOf(phases, bpd, 'opt.phases', 'a non-negative')", "            void 0"]], ['unit-evalRunNums']], //opt.phases 不核對與每日棒數之積
    ['VN27', 'src/eval/evalCore.mjs', [["            wholeBarsOf(horizons, bpd, 'opt.horizons', 'a positive')", "            void 0"]], ['unit-evalRunNums']], //opt.horizons 不核對與每日棒數之積
    ['VN28', 'src/eval/evalCore.mjs', [["let cfgRun = evalRunNumsOf(cfg, 'cfg')", "let cfgRun = evalRunNumsOf({}, 'cfg')"]], ['unit-evalRunNums']], //評估器不讀設定之執行面之數字
    ['VN29', 'src/eval/evalCore.mjs', [["let cfgLists = evalListsOf(cfg, bpd, 'cfg')", "let cfgLists = evalListsOf({}, bpd, 'cfg')"]], ['unit-evalRunNums']], //評估器不讀設定之相位與地平線
    ['VN30', 'src/eval/score.mjs', [["    let lim = evalLimitsOf({ limits }, 'eval')", "    let lim = limits"]], ['unit-evalRunNums']], //判讀取硬上限之原值(缺鍵永不否決)
    ['VN31', 'src/domain/texts.mjs', [["    let lim = evalLimitsOf(st.eval, 'eval')", "    let lim = st.eval.limits"]], ['unit-evalRunNums']], //任務書取硬上限之原值
    ['VN32', 'src/tools/initProject.mjs', [["    let lim = evalLimitsOf(ev, 'eval')", "    let lim = ev.limits && typeof ev.limits === 'object' ? ev.limits : {}"]], ['unit-evalRunNums']], //合約之參考版取硬上限之原值(缺鍵寫 undefined)
    ['VN33', 'src/domain/verifyMember.mjs', [["let rd = rdv !== null && rdv >= 1 ? rdv : null", "let rd = rdv"]], ['unit-memberCheck']], //成員穩健性之附算收 0 抽
    ['VN34', 'src/domain/verifyMember.mjs', [["evalRunNumOf(evalCfg, 'replicaNullDraws', 'eval')", "evalRunNumOf(evalCfg, 'replicaSeeds', 'eval')"]], ['unit-memberCheck']], //成員穩健性之附算讀錯鍵
    ['VN35', 'src/domain/verify.mjs', [["        let nRep = evRun.replicaSeeds", "        let nRep = Number.isInteger(st.eval.replicaSeeds) ? st.eval.replicaSeeds : 0"]], ['unit-evalRunNums']], //迴圈之重放次數取原值(字串者不重放)
    ['VN36', 'src/domain/verify.mjs', [["            let seed0 = evRun.seed", "            let seed0 = st.eval.seed === undefined ? 1 : st.eval.seed"]], ['unit-evalRunNums']], //迴圈之重放之種子取原值(seed + i 為字串相接)
    ['VN37', 'src/domain/verify.mjs', [["            let nDraw = evRun.replicaNullDraws", "            let nDraw = Number.isInteger(st.eval.replicaNullDraws) ? st.eval.replicaNullDraws : 32"]], ['unit-evalRunNums']], //迴圈之重放之虛無抽數取原值(字串者用預設)
    ['VN39', 'src/eval/cfgNum.mjs', [["(x) => x > 0 && x * 1000 <= 2147483647]", "(x) => x > 0]"]], ['unit-evalRunNums']], //逾時無上限(超過 Node 計時器之上限者立即觸發)
    ['VN40', 'src/eval/cfgNum.mjs', [["x * 1000 <= 2147483647]", "x * 1000 < 2147483647]"]], ['unit-evalRunNums']], //逾時之上限之邊界(恰 2147483647 毫秒)不收
    ['VN41', 'src/eval/cfgNum.mjs', [["(x) => x > 0 && x * 1000 <= 2147483647]", "(x) => x >= 0 && x * 1000 <= 2147483647]"]], ['unit-evalRunNums']], //逾時收 0(0 毫秒 ⇒ 立即逾時)
    ['VN42', 'src/cli/backtest.mjs', [["typeof seedArg0 === 'number' && Number.isSafeInteger(seedArg0)", "typeof seedArg0 === 'number' && Number.isFinite(seedArg0)"]], ['unit-cliModeFlags']], //g_backtest.mjs 之 --seed 收小數(排程第 595 項之接續: 不合者改為拒收, 檢查移至檔首)
    ['VN43', 'src/cli/backtest.mjs', [["console.log('invalid --seed: must be an integer')\n        process.exit(2)", "console.log('invalid --seed: must be an integer')\n        process.exit(0)"]], ['unit-cliModeFlags']], //g_backtest.mjs 之 --seed 不合者印訊息而離開碼 0(原: 說明後忽略)
    //  VN44、VN45(排程第 606 項改寫: 不合之 --seed / --tie-salt 改為拒收, 原「已忽略」之分支已移除): 檢查不作用 ⇒ 不合者不拒收
    ['VN44', 'src/cli/eval.mjs', [["if (seedArg !== null && !(typeof seedArg === 'number' && Number.isSafeInteger(seedArg))) {", 'if (false) {']], ['unit-cliEqFlags']], //--seed 不合者不拒收
    ['VN45', 'src/cli/eval.mjs', [["if (tieArg !== null && !(typeof tieArg === 'number' && Number.isSafeInteger(tieArg))) {", 'if (false) {']], ['unit-cliEqFlags']], //--tie-salt 不合者不拒收
    ['VN38', 'src/domain/verify.mjs', [["timeoutMs: evRun.timeoutSec * 1000, env: { ...process.env, ARSI_HARNESS: '1' } })\n        let out = readJson(fpOut)", "timeoutMs: evRun.timeoutSec * 100000, env: { ...process.env, ARSI_HARNESS: '1' } })\n        let out = readJson(fpOut)"]], ['unit-evalRunNums']], //重跑之逾時之單位錯
    //── 擴充診斷 api.replaceNull 之 actDays、draws、half(排程第 574 項; 與 fillRandom 同一口徑) ──
    ['AR01', 'src/eval/evalCore.mjs', [["actUse = iseint(oAct) ? NumberCtor(oAct) : NaN", "actUse = Number.isFinite(oAct) ? oAct : 0"]], ['unit-evalRunNums']], //actDays 回到 isFinite 之篩(數字字串被當 0、不合者不拋)
    ['AR02', 'src/eval/evalCore.mjs', [["                    if (!(actUse >= 0)) {", "                    if (false) {"]], ['unit-evalRunNums']], //actDays 收負數
    ['AR03', 'src/eval/evalCore.mjs', [["if (!(drawsUse >= 1 && drawsUse <= REPLACE_DRAWS_MAX)) {", "if (!(drawsUse >= 1)) {"]], ['unit-evalRunNums']], //draws 無上限
    ['AR04', 'src/eval/evalCore.mjs', [["if (!(drawsUse >= 1 && drawsUse <= REPLACE_DRAWS_MAX)) {", "if (!(drawsUse <= REPLACE_DRAWS_MAX)) {"]], ['unit-evalRunNums']], //draws 收 0 與負數
    ['AR05', 'src/eval/evalCore.mjs', [["let drawsUse = Math.max(1, Math.min(REPLACE_DRAWS_MAX, nullDraws || 16))", "let drawsUse = 16"]], ['unit-evalRunNums']], //draws 未給之預設不隨評估之虛無抽數
    ['AR06', 'src/eval/evalCore.mjs', [["const REPLACE_DRAWS_MAX = 64", "const REPLACE_DRAWS_MAX = 63"]], ['unit-evalRunNums']], //draws 之上限少 1
    ['AR07', 'src/eval/evalCore.mjs', [["iseint(oHalf) && NumberCtor(oHalf) >= 0) {", "iseint(oHalf)) {"]], ['unit-evalRunNums']], //half 收負數
    ['AR08', 'src/eval/evalCore.mjs', [["                    halfUse = NumberCtor(oHalf)", "                    halfUse = oHalf"]], ['unit-evalRunNums']], //half 取原值(數字字串於 p + half 為字串相接)
    ['AR09', 'src/eval/evalCore.mjs', [["                let halfUse = 50", "                let halfUse = 40"]], ['unit-evalRunNums']], //half 之預設
    ['AR10', 'src/eval/evalCore.mjs', [["halfUse, g.grp, g.nGroups, actUse, more)", "halfUse, g.grp, g.nGroups, 0, more)"]], ['unit-evalRunNums']], //actDays 未傳入抽樣
    ['AR11', 'src/eval/evalCore.mjs', [["halfUse, g.grp, g.nGroups, actUse, more)", "50, g.grp, g.nGroups, actUse, more)"]], ['unit-evalRunNums']], //half 未傳入抽樣
    //── 命令列旗標之嚴格檢查(排程第 547、590 項之接續; unit-cliStrictFlags): cliMsgOf ──
    ['FS01', 'src/cfg.mjs', [["        if (typeof a !== 'string' || !a.startsWith('--')) {", "        if (false) {"]], ['unit-cliStrictFlags']], //多餘之位置引數 / 值不被偵測(落入未列之旗標)
    ['FS02', 'src/cfg.mjs', [["        if (!known(nm)) {\n            return names.length", "        if (false) {\n            return names.length"]], ['unit-cliStrictFlags']], //未列之旗標不拒
    ['FS03', 'src/cfg.mjs', [["        if (seen.has(nm) && !own.dup.includes(nm)) {", "        if (false) {"]], ['unit-cliStrictFlags']], //單值旗標重複不拒
    ['FS04', 'src/cfg.mjs', [["        if (seen.has(nm) && !own.dup.includes(nm)) {", "        if (seen.has(nm)) {"]], ['unit-cliStrictFlags', 'unit-memberLedger']], //進入檔自己處理重複者(--member、--subset)亦拒為通用之訊息
    ['FS05', 'src/cfg.mjs', [["            if (hasVal) {\n                if (nSeen < nPos) {", "            if (false) {\n                if (nSeen < nPos) {"]], ['unit-cliStrictFlags'], 'equiv'], //布林旗標之後接值不拒(等價變異: 無此分支時該值於下一輪被當成位置引數〔個數已用盡者回同一訊息; 未用盡者算位置引數, 與本分支之結果相同〕)
    ['FS06', 'src/cfg.mjs', [["            if (!(hasVal && enums[nm].includes(v))) {", "            if (false) {"]], ['unit-cliStrictFlags']], //列舉之值不檢
    ['FS07', 'src/cfg.mjs', [["            if (!(hasVal && enums[nm].includes(v))) {", "            if (!hasVal) {"]], ['unit-cliStrictFlags']], //列舉之值只檢有無(集合外之值不拒)
    ['FS08', 'src/cfg.mjs', [["            if (own.noValue.includes(nm)) {\n                if (hasVal) {", "            if (false) {\n                if (hasVal) {"]], ['unit-cliStrictFlags', 'unit-evalNums']], //進入檔自己處理無值者(--null、--member、--subset)亦拒為通用之訊息
    ['FS09', 'src/cfg.mjs', [["        let hasVal = typeof v === 'string' && !v.startsWith('--')", "        let hasVal = typeof v === 'string'"]], ['unit-cliStrictFlags']], //其後之旗標被當成值
    ['FS10', 'src/cfg.mjs', [["            i++\n            continue\n        }\n        //空字串或只有空白之值", "            continue\n        }\n        //空字串或只有空白之值"]], ['unit-cliStrictFlags']], //列舉旗標之值不被吃掉(再被掃為多餘之值)
    ['FS11', 'src/cfg.mjs', [["        i++\n    }\n    //模式 × 旗標(CLI_MODE_FLAGS)", "    }\n    //模式 × 旗標(CLI_MODE_FLAGS)"]], ['unit-cliStrictFlags']], //帶值旗標之值不被吃掉
    ['FS12', 'src/cfg.mjs', [["            if (nSeen < nPos && typeof a === 'string') {", "            if (typeof a === 'string') {"]], ['unit-cliStrictFlags']], //位置引數不限個數
    ['FS13', 'src/cfg.mjs', [["    let eq = eqFlagMsgOf(flags, argv, first)\n    if (eq !== null) {", "    let eq = null\n    if (eq !== null) {"]], ['unit-cliStrictFlags', 'unit-cliEqFlags']], //帶等號者不先檢(落入未列之旗標之通稱)
    ['FS14', 'src/cfg.mjs', [["    eval: { mode: ['quick', 'full'], period: ['backtest', 'train', 'postfit'] },", "    eval: { mode: ['quick', 'full', 'extra'], period: ['backtest', 'train', 'postfit'] },"]], ['unit-cliStrictFlags']], //列舉之集合與格式說明不一致
    ['FS15', 'src/cfg.mjs', [["    rsi: { noValue: ['file'], dup: [] },", "    rsi: { noValue: [], dup: [] },"]], ['unit-cliStrictFlags', 'unit-dreamOnly']], //--file 無值(只做夢輪次)之固定訊息被通用之訊息取代
    ['FS16', 'src/cfg.mjs', [["    eval: { noValue: ['null', 'member', 'subset'], dup: ['member', 'subset'] },", "    eval: { noValue: ['null', 'member', 'subset'], dup: [] },"]], ['unit-cliStrictFlags', 'unit-memberLedger']], //--member、--subset 之重複之固定訊息被通用之訊息取代
    ['FS17', 'src/cfg.mjs', [["'frontier', 'annotate', 'dirtype'] },\n}", "'frontier', 'annotate'] },\n}"]], ['unit-cliStrictFlags']], //rsi 之模式少一個(dirtype 被拒)
    ['FS18', 'src/cfg.mjs', [["    backtest: { 'match-sides': ['0', '1'] },", "    backtest: {},"]], ['unit-cliStrictFlags']], //--match-sides 之值不檢
    ['FS20', 'src/cli/build.mjs', [["Number.isSafeInteger(limitArg) && limitArg >= 1)", "Number.isSafeInteger(limitArg) && limitArg >= 0)"]], ['unit-cliStrictFlags']], //--limit 0 收
    ['FS21', 'src/cli/build.mjs', [["typeof limitArg === 'number' && Number.isSafeInteger(limitArg)", "typeof limitArg === 'number' && Number.isFinite(limitArg)"]], ['unit-cliStrictFlags']], //--limit 2.5 收
    ['FS22', 'src/cli/build.mjs', [["if (limitArg !== null && !(typeof", "if (false && !(typeof"]], ['unit-cliStrictFlags']], //--limit 不檢
    ['FS23', 'src/cli/rsi.mjs', [["Number.isSafeInteger(nullArg0) && nullArg0 >= 1)", "Number.isSafeInteger(nullArg0) && nullArg0 >= 0)"]], ['unit-cliStrictFlags']], //--null 0 收
    ['FS24', 'src/cli/rsi.mjs', [["    if ((md === 'fill' || md === 'extfill') && nullArg0 !== null", "    if (md === 'fill' && nullArg0 !== null"]], ['unit-cliStrictFlags']], //extfill 之 --null 不檢
    ['FS25', 'src/cli/rsi.mjs', [["    if ((md === 'fill' || md === 'extfill') && nullArg0 !== null", "    if (md === 'extfill' && nullArg0 !== null"]], ['unit-cliStrictFlags']], //fill 之 --null 不檢
    ['FS26', 'src/cli/rsi.mjs', [["typeof nullArg0 === 'number' && Number.isSafeInteger(nullArg0)", "typeof nullArg0 === 'number' && Number.isFinite(nullArg0)"]], ['unit-cliStrictFlags']], //--null 2.5 收
    ['FS27', 'src/cli/launch.mjs', [["{ positional: 1 }", "{ positional: 2 }"]], ['unit-cliStrictFlags']], //日誌名之後之多餘引數收
    ['FS28', 'src/cli/launch.mjs', [["{ positional: 1 }", "{ positional: 0 }"]], ['unit-cliStrictFlags', 'unit-cliEqFlags']], //日誌名亦拒
    //── 補算之虛無抽數(排程第 547 項①; unit-fillCli): fillDrawsOf ──
    ['ND01', 'src/domain/domain.mjs', [["let fillDrawsOf = (v) => cfgNumOf(v, null, 'opt.nullDraws', 'posInt')", "let fillDrawsOf = (v) => cfgNumOf(v, null, 'opt.nullDraws', 'nonNegInt')"]], ['unit-fillCli']], //0 收(其後之 planFill 以另一訊息拒)
    ['ND02', 'src/domain/domain.mjs', [["let fillDrawsOf = (v) => cfgNumOf(v, null, 'opt.nullDraws', 'posInt')", "let fillDrawsOf = (v) => (Number.isInteger(v) && v > 0 ? v : null)"]], ['unit-fillCli']], //回到原寫法(無效靜默當成未給; 數字字串不收)
    ['ND03', 'src/domain/domain.mjs', [["        nullDraws = fillDrawsOf(nullDraws)\n        let { nodes, skipped } = fillNodesOf()", "        let { nodes, skipped } = fillNodesOf()"]], ['unit-fillCli']], //fillPlanOf 不檢
    ['ND04', 'src/domain/domain.mjs', [["        nullDraws = fillDrawsOf(nullDraws)\n        let t0 = Date.now()", "        let t0 = Date.now()"]], ['unit-fillCli']], //fill 不檢
    ['ND05', 'src/domain/domain.mjs', [["        nullDraws = fillDrawsOf(nullDraws)\n        let all = diagsOf(toolboxDir).map((x) => x.name)", "        let all = diagsOf(toolboxDir).map((x) => x.name)"]], ['unit-fillCli']], //extFill 不檢
    //── settings.backtest 之數值鍵(排程第 547 項①; unit-backtestCfg): backtestCfg ──
    ['BC01', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.minLadder, 0, 'backtest.minLadder', 'nonNegInt')", "(Number.isInteger(b.minLadder) ? b.minLadder : 0)"]], ['unit-backtestCfg']], //minLadder 回到原寫法
    ['BC02', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.replicas, 3, 'backtest.replicas', 'posInt')", "(Number.isInteger(b.replicas) && b.replicas >= 1 ? b.replicas : 3)"]], ['unit-backtestCfg']], //replicas 回到原寫法
    ['BC03', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.nullDraws, 64, 'backtest.nullDraws', 'nonNegInt')", "(Number.isInteger(b.nullDraws) ? b.nullDraws : 64)"]], ['unit-backtestCfg']], //nullDraws 回到原寫法
    ['BC04', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.timeoutSec, 1200, 'backtest.timeoutSec', 'timerSec')", "(b.timeoutSec || 1200)"]], ['unit-backtestCfg']], //timeoutSec 回到原寫法
    ['BC05', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.replicas, 3, 'backtest.replicas', 'posInt')", "cfgNumOf(b.replicas, 3, 'backtest.replicas', 'nonNegInt')"]], ['unit-backtestCfg']], //replicas 收 0
    ['BC06', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.nullDraws, 64, 'backtest.nullDraws', 'nonNegInt')", "cfgNumOf(b.nullDraws, 64, 'backtest.nullDraws', 'posInt')"]], ['unit-backtestCfg']], //nullDraws 不收 0
    ['BC07', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.timeoutSec, 1200, 'backtest.timeoutSec', 'timerSec')", "cfgNumOf(b.timeoutSec, 1200, 'backtest.timeoutSec', 'posNum')"]], ['unit-backtestCfg']], //timeoutSec 無上限
    ['BC08', 'src/domain/backtestCfg.mjs', [["cfgNumOf(b.minLadder, 0, 'backtest.minLadder', 'nonNegInt')", "cfgNumOf(b.minLadder, 0, 'backtest.minLadder', 'nonNegNum')"]], ['unit-backtestCfg']], //minLadder 收小數
    ['BC10', 'src/cli/backtest.mjs', [["    console.log(`ERROR ${msg}`)\n    process.exit(2)\n}\nlet fpPick = argOf('pick', '')", "    console.log(`ERROR ${msg}`)\n    process.exit(1)\n}\nlet fpPick = argOf('pick', '')"]], ['unit-backtestCfg']], //設定無效之離開碼
    ['BC11', 'src/eval/barGrid.mjs', [["|periods\\.|backtest\\.|score[.:]|ARSI_EVAL_FROM|", "|periods\\.|score[.:]|ARSI_EVAL_FROM|"]], ['unit-backtestCfg', 'unit-fillCli']], //configMsgOf 不認 invalid backtest.…
    ['BC12', 'src/cli/toolbox.mjs', [["    console.log(`ERROR ${msg}`)\n    process.exit(2)\n}\nlet rules", "    console.log(`ERROR ${msg}`)\n    process.exit(1)\n}\nlet rules"]], ['unit-backtestCfg']], //g_toolbox.mjs 設定無效之離開碼
    //── 相位數之寫法(排程第 547 項②; unit-phaseText、unit-fillCli、unit-pickStore): phaseCountOf / phaseText 之各輸出處 ──
    ['PT01', 'src/domain/domain.mjs', [["let phT = (tail, ns) => phaseText(ns ? nPhOf(ns) : phaseCountOf(st.eval), tail)", "let phT = (tail, ns) => phaseText(7, tail)"]], ['unit-fillCli']], //看板與搜尋地圖寫死七相位
    ['PT02', 'src/domain/pickStore.mjs', [["    let nPh = phaseCountOf(st.eval)", "    let nPh = 7"]], ['unit-pickStore']], //共同儲存區寫死七相位
    ['PT03', 'src/domain/pickStore.mjs', [["let phSub = (s, nPh) => s.replace(/七相位/g, phaseText(nPh, '相位'))", "let phSub = (s, nPh) => s"]], ['unit-pickStore']], //共同儲存區不替換
    ['PT04', 'src/eval/score.mjs', [[".replace(/七相位/g, phaseText(nPh, '相位'))", ""]], ['unit-phaseText']], //判讀之說明不替換
    ['PT05', 'src/domain/sideRead.mjs', [["做多比例與${phaseText(nPh, '相位')}平均之相關 ", "做多比例與七相位平均之相關 "]], ['unit-phaseText']], //側別讀數寫死
    ['PT06', 'src/domain/verify.mjs', [["let phaseCountOfDoc = (m) => phaseCountOfAll([phaseCountOfMetrics(m)], null)", "let phaseCountOfDoc = (m) => 7"]], ['unit-phaseText']], //節點文件之欄標與新鮮度一列寫死
    ['PT07', 'src/cli/eval.mjs', [["新鮮度(${phaseText(phaseCountOfAll([phaseCountOfMetrics(m)], st.eval), '相位')}均 %)", "新鮮度(七相位均 %)"]], ['unit-phaseText']], //命令列之新鮮度一列寫死
    ['PT08', 'src/cli/rsi.mjs', [["(${phaseText(bestPh, '相位')}均 ${best.eqYrMean}", "(七相位均 ${best.eqYrMean}"]], ['unit-phaseActual']], //輪末摘要寫死
    ['PT09', 'src/tools/roundDigest.mjs', [["${phaseText(phaseCountOfAll(rows.map((d) => phaseCountOfMetrics(d.harness && d.harness.raw && d.harness.raw.metrics)), st.eval), '相位')}平均 / 最差相位", "七相位平均 / 最差相位"]], ['unit-phaseActual']], //輪末摘要之表頭寫死
    ['PT10', 'src/domain/domain.mjs', [["sideReadTextOf(sideReadOfTree(nodes), nPhOf(nodes))", "sideReadTextOf(sideReadOfTree(nodes))"]], ['unit-phaseActual']], //搜尋地圖之側別讀數寫死
    ['PT11', 'src/domain/domain.mjs', [["sideReadTextOf(sideReadOfTree(ns), nPhOf(ns))", "sideReadTextOf(sideReadOfTree(ns))"]], ['unit-phaseText']], //輪末摘要之側別讀數寫死
    ['PT12', 'src/domain/domain.mjs', [["layer: node && node.spec ? layerOfSpec(node.spec) : null, evidence: ev, nPh: phaseCountOf(st.eval) })", "layer: node && node.spec ? layerOfSpec(node.spec) : null, evidence: ev })"]], ['unit-phaseText']], //判讀(domain)之說明寫死
    ['PT13', 'src/domain/verify.mjs', [["evidence: { backtest: b.flag }, nPh: phaseCountOf(st.eval) })", "evidence: { backtest: b.flag } })"]], ['unit-phaseText']], //判讀(verify)之說明寫死
    //── 相位數取實算(排程第 547 項②之接續; unit-phaseActual、unit-phaseText、unit-pickStore): phaseCountOfMetrics / phaseCountOfAll 與各輸出處之接線 ──
    ['PA01', 'src/eval/cfgNum.mjs', [["    if (m && Array.isArray(m.phases) && m.phases.length > 0) {", "    if (false) {"]], ['unit-phaseActual']], //phases 不採(只看 byPhase)
    ['PA02', 'src/eval/cfgNum.mjs', [["    return Array.isArray(bp) && bp.length > 0 ? bp.length : null", "    return null"]], ['unit-phaseActual']], //不取 byPhase 之長度
    ['PA03', 'src/eval/cfgNum.mjs', [["xs.length > 0 && xs.every((n) => n === xs[0]) ? xs[0] : phaseCountOf(ev)", "xs.length > 0 ? xs[0] : phaseCountOf(ev)"]], ['unit-phaseActual']], //各列不同仍取第一列(不退回設定)
    ['PA04', 'src/eval/cfgNum.mjs', [["Number.isInteger(n) && n > 0) : []", "Number.isInteger(n)) : []"]], ['unit-phaseActual']], //0 與負數之列計入
    ['PA05', 'src/eval/cfgNum.mjs', [["xs.length > 0 && xs.every((n) => n === xs[0]) ? xs[0] : phaseCountOf(ev)", "xs.every((n) => n === xs[0]) ? xs[0] : phaseCountOf(ev)"]], ['unit-phaseActual']], //無列時回 undefined
    ['PA06', 'src/eval/cfgNum.mjs', [["xs.every((n) => n === xs[0]) ? xs[0] : phaseCountOf(ev)", "xs.every((n) => n === xs[0]) ? xs[0] : 7"]], ['unit-phaseActual']], //後備取預設 7(不取設定)
    ['PA07', 'src/eval/cfgNum.mjs', [["    if (m && Array.isArray(m.phases) && m.phases.length > 0) {", "    if (m && Array.isArray(m.phases) && m.phases.length >= 0) {"]], ['unit-phaseActual']], //空之 phases 回 0
    ['PA08', 'src/cli/eval.mjs', [["phaseText(phaseCountOfAll([phaseCountOfMetrics(m)], st.eval), '相位')}均 %)", "phaseText(phaseCountOf(st.eval), '相位')}均 %)"]], ['unit-phaseActual']], //畫面取設定之長度(原寫法)
    ['PA09', 'src/cli/rsi.mjs', [["bestPh = phaseCountOfAll([phaseCountOfMetrics(m)], st.eval)", "bestPh = phaseCountOfAll([], st.eval)"]], ['unit-phaseActual']], //輪末摘要不取該節點之結果
    ['PA10', 'src/domain/domain.mjs', [["let nPhOf = (ns) => phaseCountOfAll(ns.map((n) => phaseCountOfMetrics(n.raw && n.raw.metrics)), st.eval)", "let nPhOf = (ns) => phaseCountOfAll(ns.map((n) => null), st.eval)"]], ['unit-phaseActual']], //彙整輸出不取各節點之結果
    ['PA11', 'src/domain/domain.mjs', [["等效年化之${phT('相位', nodes)}平均 + 0.3", "等效年化之${phT('相位')}平均 + 0.3"]], ['unit-phaseActual']], //看板之 S 定義句取設定
    ['PA12', 'src/domain/domain.mjs', [["等效年化之' + phT('相位', nodes) + '平均", "等效年化之' + phT('相位') + '平均"]], ['unit-phaseActual']], //看板之超額說明取設定
    ['PA13', 'src/domain/domain.mjs', [["| 最差相位 | ${phT('相位', nodes)}平均 | 階梯 |", "| 最差相位 | ${phT('相位')}平均 | 階梯 |"]], ['unit-phaseActual']], //看板之節點一覽欄標取設定
    ['PA14', 'src/domain/domain.mjs', [["列其 S / 最差相位 / ' + phT('相位', nodes) + '平均 / 對組成對照之超額", "列其 S / 最差相位 / ' + phT('相位') + '平均 / 對組成對照之超額"]], ['unit-phaseActual']], //搜尋地圖之量尺說明取設定
    ['PA15', 'src/domain/domain.mjs', [["最差相位 / ' + phT('相位', nodes) + '平均 / 超額 / 組成之水準", "最差相位 / ' + phT('相位') + '平均 / 超額 / 組成之水準"]], ['unit-phaseActual']], //搜尋地圖之表頭取設定
    ['PA16', 'src/domain/pickStore.mjs', [["note: phSub(note, /^backtest\\./.test(key) ? nPhBt : nPh)", "note: phSub(note, nPh)"]], ['unit-pickStore']], //共同儲存區之回測期欄說明取設定
    ['PA17', 'src/domain/pickStore.mjs', [["note: phSub(note, /^backtest\\./.test(key) ? nPhBt : nPh)", "note: phSub(note, nPhBt)"]], ['unit-pickStore']], //共同儲存區之保留期欄說明取各策略之長度
    ['PA18', 'src/domain/pickStore.mjs', [["[phSub(t, nPhBt), fn]", "[phSub(t, nPh), fn]"]], ['unit-pickStore']], //總表之欄標取設定
    ['PA19', 'src/domain/pickStore.mjs', [["x.backtest.eqYrByPhase.length : null)), st.eval)", "x.backtest.eqYrByPhase.length : null)).concat([1]), st.eval)"]], ['unit-pickStore']], //各策略之長度另混入一列(必不同)
    ['PA20', 'src/domain/verify.mjs', [["let phaseCountOfDoc = (m) => phaseCountOfAll([phaseCountOfMetrics(m)], null)", "let phaseCountOfDoc = (m) => phaseCountOfAll([], null)"]], ['unit-phaseActual']], //節點文件不取結果之相位數    //── 第 510 項②: 回測期旗標之重放以回測期終點為界(unit-backtestEnd): clipLedger 與 g_backtest.mjs ──
    ['BE01', 'src/eval/ledger.mjs', [["            if (L.ent[j] < endV) {\n                tot++", "            if (L.ent[j] <= endV) {\n                tot++"]], ['unit-backtestEnd']], //進場棒 = 終點之單亦留(計數與填入不一致)
    ['BE03', 'src/eval/ledger.mjs', [["if (L.ext[j] >= 0 && L.ext[j] < endV) {", "if (L.ext[j] >= 0 && L.ext[j] <= endV) {"]], ['unit-backtestEnd']], //出場棒 = 終點者視為已結
    ['BE04', 'src/eval/ledger.mjs', [["                    ext[p] = -1\n                    pnl[p] = 0\n", "                    ext[p] = L.ext[j]\n                    pnl[p] = L.pnl[j]\n"]], ['unit-backtestEnd']], //終點之後才出場之單不改為未結
    ['BE05', 'src/eval/ledger.mjs', [["                    ext[p] = -1\n                    pnl[p] = 0\n", "                    ext[p] = -1\n                    pnl[p] = L.pnl[j]\n"]], ['unit-backtestEnd']], //改為未結而損益不歸零
    ['BE06', 'src/eval/ledger.mjs', [["    if (endV >= L.nBars) {\n        return L\n    }", "    if (endV > L.nBars) {\n        return L\n    }"]], ['unit-backtestEnd']], //終點 = nBars 者不回原物件
    ['BE07', 'src/eval/ledger.mjs', [["    setExitCols(M)\n    return M\n}\n\n//ids,", "    return M\n}\n\n//ids,"]], ['unit-backtestEnd']], //依出場棒排序之已結單欄不重建
    ['BE08', 'src/cli/backtest.mjs', [["L = clipLedger(L, btEndBar)", "void 0"]], ['unit-backtestEnd']], //不截帳本
    ['BE09', 'src/eval/ledger.mjs', [["        endBar: endV,\n", ""]], ['unit-backtestEnd']], //帳本視圖不帶 endBar(決策不以終點為界)
    ['BE10', 'src/eval/ledger.mjs', [["        endBar: endV,\n", "        endBar: endV + 1,\n"]], ['unit-backtestEnd']], //endBar 多 1(視窗恰止於終點之決策外之一個決策被計入)
    ['BE11', 'src/eval/evalCore.mjs', [["        for (let b = warm + phase * bpd; b + W <= nEnd; b += cad) {", "        for (let b = warm + phase * bpd; b + W <= nBars; b += cad) {"]], ['unit-backtestEnd']], //決策不以 endBar 為界
    ['BE12', 'src/eval/evalCore.mjs', [["            if (b + W > nEnd) {", "            if (b + W > nBars) {"]], ['unit-backtestEnd']], //新鮮度之視窗不以 endBar 為界
    ['BE13', 'src/eval/evalCore.mjs', [["L.endBar < nBars ? L.endBar : nBars", "L.endBar < nBars ? L.endBar + 1 : nBars"]], ['unit-backtestEnd']], //nEnd 多 1
    ['BE14', 'src/eval/evalCore.mjs', [["NumberIsInteger(L.endBar) && L.endBar >= 0 && L.endBar < nBars ?", "NumberIsInteger(L.endBar) && L.endBar < nBars ?"]], ['unit-backtestEnd'], 'equiv'], //endBar 為負數(帳本物件不會帶; 等價)
    //── g_rsi.mjs 之 --dream-only 與 --file 之模式相容; 進入檔自己處理之旗標於讀設定之前(unit-cliStrictFlags) ──
    ['FS30', 'src/cfg.mjs', [["        validate: ['force'],", "        validate: ['force', 'dream-only'],"]], ['unit-cliStrictFlags']], //--dream-only 於他模式(validate)不拒(原由進入檔自己判; 排程第 595 項之接續改由模式表一併判定)
    ['FS31', 'src/cli/rsi.mjs', [["(md === 'annotate' || md === 'dirtype' || (md === 'round' && hasDream))", "(md === 'annotate' || md === 'dirtype' || md === 'round')"]], ['unit-cliStrictFlags']], //round 不帶 --dream-only 而給 --file 不拒
    ['FS32', 'src/cli/rsi.mjs', [["    if (process.argv.includes('--file') && !(", "    if (false && !("]], ['unit-cliStrictFlags']], //--file 之模式相容不檢
    ['FS33', 'src/cli/rsi.mjs', [["let dreamOnly = null\n", "let dreamOnly = (settingsOrExit(), null)\n"]], ['unit-cliStrictFlags']], //只做夢輪次之 --file 之檢查晚於讀設定
    ['FS34', 'src/cli/eval.mjs', [["let memberArg = argOf('member', null)", "let memberArg = (settingsOrExit(), argOf('member', null))"]], ['unit-cliStrictFlags']], //--member 之檢查晚於讀設定
    ['FS35', 'src/cli/eval.mjs', [["let nullArg = argOf('null', null)", "let nullArg = (settingsOrExit(), argOf('null', null))"]], ['unit-cliStrictFlags']], //--null 之檢查晚於讀設定
    ['FS36', 'src/cli/eval.mjs', [["let subsetArg = argStrOf('subset', null)", "let subsetArg = (settingsOrExit(), argStrOf('subset', null))"]], ['unit-cliStrictFlags']], //--subset 之檢查晚於讀設定
    ['BC13', 'src/tools/scanCheck.mjs', [["    console.log(`ERROR ${msg}`)\n    process.exit(2)\n}\nlet root = st.FD_ROOT", "    console.log(`ERROR ${msg}`)\n    process.exit(1)\n}\nlet root = st.FD_ROOT"]], ['unit-backtestCfg']], //scanCheck.mjs 設定無效之離開碼(backtestCfg 之 try 之後; 另有禁區字樣之 try 在前)
    //── 第 510 項①④⑤: 挑選函數回傳值之收窄與 V19 訊息、api 之訊息、保留期 asOf ──
    ['NP01', 'src/eval/evalCore.mjs', [["        if (arr === null) {\n            throw new ErrorCtor(viaObj ?", "        if (false) {\n            throw new ErrorCtor(viaObj ?"]], ['unit-extApiInput']], //ids 之種類不合不拒
    ['NP02', 'src/eval/evalCore.mjs', [["        if (group !== null && garr === null) {", "        if (false) {"]], ['unit-extApiInput']], //group 之種類不合不拒
    ['NP03', 'src/eval/evalCore.mjs', [["invalid ${where}${px.viaObj ? '.ids' : ''}[${i}]: must be an integer from 0 to ${n - 1}", "invalid ${where}[${i}]: must be an integer from 0 to ${n - 1}"]], ['unit-evalCore']], //物件形式之位置不帶 .ids
    ['NP04', 'src/eval/evalCore.mjs', [["const PICK_RET_WHERE = 'pick return value'", "const PICK_RET_WHERE = 'pick result'"]], ['unit-evalCore']], //訊息之位置名稱
    ['NP05', 'src/eval/evalCore.mjs', [["'invalid pick return value.tag: must be structured-cloneable data (numbers, strings, objects, arrays; no functions, symbols or shared memory)'", "'invalid pick return value.tag: must be structured-cloneable data'"]], ['unit-evalIntegrity']], //tag 之訊息
    ['NP06', 'src/eval/evalCore.mjs', [["`api.${fnName}: invalid bar: must be an integer from 0 to ${nBars}`", "`api.${fnName}: invalid bar: must be an integer from 0 to ${nBars - 1}`"]], ['unit-extData']], //api 之 bar 之上界
    ['NP07', 'src/eval/evalCore.mjs', [["ArrayPrototypeJoin(serNames, ', ') : 'none (the ledger has no external series)')", "ArrayPrototypeJoin(serNames, '、') : 'none (the ledger has no external series)')"]], ['unit-extData']], //api.series 之名稱列表之分隔
    ['NP08', 'src/eval/evalCore.mjs', [["(an index of meta.keyNames)` : 'api.factor: invalid ki: must be an index of meta.keyNames (the ledger has no factors)'", "(an index of meta.keyNames)` : 'api.factor: invalid ki: must be an index of meta.keyNames'"]], ['unit-extData']], //帳本無因子之訊息
    ['HO01', 'src/domain/pickStore.mjs', [["let hoAsOf = hoFile && typeof hoFile.asOf === 'string' && hoFile.asOf ? hoFile.asOf : null", "let hoAsOf = hoFile && hoFile.asOf ? hoFile.asOf : null"]], ['unit-pickStore']], //asOf 任何真值照收
    ['HO02', 'src/domain/pickStore.mjs', [["asOf: typeof ho.asOf === 'string' && ho.asOf ? ho.asOf : null }", "asOf: ho.asOf || null }"]], ['unit-pickStore']], //infoOf 之 asOf 任何真值照收
    //── 第 547 項③: 評估器之指紋排除 unitNotional.mjs ──
    ['X05', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs']", "let EVAL_FP_SKIP = ['ledgerBuild.mjs']"]], ['unit-evalFingerprint']], //unitNotional.mjs 計入指紋
    ['X06', 'src/domain/fillKeys.mjs', [["let EVAL_FP_SKIP = ['ledgerBuild.mjs', 'unitNotional.mjs']", "let EVAL_FP_SKIP = ['unitNotional.mjs']"]], ['unit-evalFingerprint']], //ledgerBuild.mjs 計入指紋
    //── nullGroupActOf 之「鄰域用盡 ⇒ 該席從缺」(排程第 574 項之測試守門; unit-evalRunNums 之參考模型) ──
    ['ZE01', 'src/eval/evalCore.mjs', [["let v = drawNear(ord, lo, hi, rng, stamp, tick)\n                        if (v < 0) {\n                            continue\n", "let v = drawNear(ord, lo, hi, rng, stamp, tick)\n                        if (v < 0) {\n                            break\n"]], ['unit-evalRunNums']], //一席從缺即停止填其後之席
    ['ZE02', 'src/eval/evalCore.mjs', [["let v = drawNear(ord, lo, hi, rng, stamp, tick)\n                        if (v < 0) {\n                            continue\n", "let v = drawNear(ord, lo, hi, rng, stamp, tick)\n                        if (false) {\n                            continue\n"]], ['unit-evalRunNums']], //從缺之席留下序號 -1
    ['ZE03', 'src/eval/evalCore.mjs', [["                        rs[k] = out.slice(0, m).sort()", "                        rs[k] = out.sort()"]], ['unit-evalRunNums']], //從缺之席以序號 0 補入(未截斷至所填之席數)
    ['ZE04', 'src/eval/evalCore.mjs', [["let v = drawNear(ord, lo, hi, rng, stamp, tick)\n                        if (v < 0) {\n                            continue\n                        }\n                        stamp[v] = tick", "let v = drawNear(ord, lo, hi, rng, stamp, tick)\n                        if (v < 0) {\n                            continue\n                        }\n                        void 0"]], ['unit-evalRunNums']], //所抽之席不標記為已用(同一選集內重複)
    //── 獨立複審(第二次)之處置(R-EV-52): 空字串之值、--claim、--limit 與 --train、回測期之退化、endBar 之組合 ──
    ['RV01', 'src/cfg.mjs', [["if (!hasVal || v.trim() === '') {", "if (!hasVal) {"]], ['unit-cliStrictFlags']], //空字串或只有空白之值被當成值
    ['RV02', 'src/cfg.mjs', [["                if (hasVal) {\n                    i++\n                }\n                continue\n            }\n            return `invalid --${nm}: must be written as", "                continue\n            }\n            return `invalid --${nm}: must be written as"]], ['unit-cliStrictFlags']], //own 旗標之空值不被消耗(被當成多餘之值)
    ['RV03', 'src/cli/rsi.mjs', [["if (!(typeof cv === 'string' && /^[0-9a-f]{8}$/.test(cv))) {", "if (false) {"]], ['unit-cliStrictFlags']], //--claim 之格式不檢
    ['RV04', 'src/cfg.mjs', [["        board: [],", "        board: ['claim'],"]], ['unit-cliStrictFlags']], //--claim 不限 frontier 模式(原由進入檔自己判; 排程第 595 項之接續改由模式表一併判定)
    ['RV05', 'src/cli/rsi.mjs', [["let bs = argStrOf('base', undefined)", "let bs = argOf('base', undefined)"]], ['unit-cliStrictFlags']], //--base 經數值轉型(全數字之 id 前綴被丟掉)
    ['RV06', 'src/cli/build.mjs', [["if (train && limitArg !== null) {", "if (false) {"]], ['unit-cliStrictFlags']], //--limit 與 --train 併用不拒
    ['RV07', 'src/cli/backtest.mjs', [["if (!(btEndBar > btStartBar)) {", "if (false) {"]], ['unit-backtestEnd']], //回測期終點不晚於起點不拒
    ['RV08', 'src/cli/backtest.mjs', [["if (runs.every((r) => r.bars.length === 0)) {", "if (false) {"]], ['unit-backtestEnd']], //回測期內無任何決策不拒
    ['RV09', 'src/eval/ledger.mjs', [["    if (L.endBar !== undefined && L.endBar !== null) {\n        M.endBar = L.endBar\n    }", "    void 0"]], ['unit-backtestEnd']], //半庫與子庫丟掉 endBar
    ['RV10', 'src/eval/ledger.mjs', [["    if (typeof L.endBar === 'number' && L.endBar <= endV) {\n        return L\n    }", "    void 0"]], ['unit-backtestEnd']], //已截者於較晚之終點再截 ⇒ endBar 被放寬
    ['RV11', 'src/eval/ledger.mjs', [["typeof L.endBar === 'number' && L.endBar <= endV", "typeof L.endBar === 'number' && L.endBar < endV"]], ['unit-backtestEnd']], //同終點再截不回原物件
    //── 排程第 595 項之接續(R-EV-53): 模式 × 旗標、工具之旗標表、g_backtest --seed、settings.rsi 等數值鍵、backtest.rule / grade ──
    ['TM01', 'src/cfg.mjs', [["            if (hasVal) {\n                if (nSeen < nPos) {", "            if (hasVal) {\n                if (false) {"]], ['unit-toolFlags']], //布林旗標之後之值不算位置引數(roundDigest --out 3 被拒)
    ['TM02', 'src/cfg.mjs', [["opt.positional : (isTool ? TOOL_FLAGS[entry].positional : 0)", "opt.positional : 0"]], ['unit-toolFlags']], //工具之位置引數個數取 0(合法之 [輪次] 被拒)
    ['TM03', 'src/cfg.mjs', [["let own = isTool ? { noValue: TOOL_FLAGS[entry].own || [], dup: [] } :", "let own = isTool ? { noValue: [], dup: [] } :"]], ['unit-toolFlags']], //工具之 own 無值不交工具自己(libCheck --dir-hi 之既有訊息被通用訊息取代)
    ['TM04', 'src/cfg.mjs', [["if (nm === 'mode' || skip.includes(nm) || modeTbl[md].includes(nm)) {", "if (true) {"]], ['unit-cliModeFlags']], //模式 × 旗標不檢
    ['TM05', 'src/cfg.mjs', [["if (nm === 'mode' || skip.includes(nm) || modeTbl[md].includes(nm)) {", "if (nm === 'mode' || modeTbl[md].includes(nm)) {"]], ['unit-cliModeFlags']], //--file 之模式相容不交進入檔(以通用訊息取代既有之固定訊息)
    ['TM06', 'src/cfg.mjs', [["Object.prototype.hasOwnProperty.call(needs, nm) && !needs[nm].some((x) => seen.has(x))", "Object.prototype.hasOwnProperty.call(needs, nm) && false"]], ['unit-cliModeFlags']], //frontier 之相依不檢
    ['TM07', 'src/cfg.mjs', [["!needs[nm].some((x) => seen.has(x))", "!needs[nm].every((x) => seen.has(x))"]], ['unit-cliModeFlags']], //相依須全部同時給(--close A --why x 被拒)
    ['TM08', 'src/cfg.mjs', [["let md = im >= 0 ? argv[im + 1] : 'status'", "let md = im >= 0 ? argv[im + 1] : 'round'"]], ['unit-cliModeFlags']], //未給 --mode 時以 round 判(--rounds 3 通過)
    ['TM09', 'src/cfg.mjs', [["        console.log(msg)\n        process.exit(2)", "        console.log(msg)\n        process.exit(1)"]], ['unit-toolFlags']], //cliGuard 離開碼 1
    ['TM10', 'src/cfg.mjs', [["        console.log(msg)\n        process.exit(2)", "        console.error(msg)\n        process.exit(2)"]], ['unit-toolFlags']], //cliGuard 訊息走 stderr
    ['TM11', 'src/cfg.mjs', [["return `invalid --${nm}: must be used with --mode ${ms.length > 1 ?", "return `invalid --${nm}: must be used with --mode ${false ?"]], ['unit-cliModeFlags']], //所屬之模式只列第一個
    ['TM12', 'src/cfg.mjs', [["        reverify: ['why', 'keep-flags', 'only'],", "        reverify: ['why', 'keep-flags', 'only', 'null'],"]], ['unit-cliModeFlags']], //reverify 收 --null
    ['TM13', 'src/cfg.mjs', [["        status: [],", "        status: ['rounds'],"]], ['unit-cliModeFlags']], //status 收 --rounds
    ['TM14', 'src/cfg.mjs', [["base: ['rearm'],", "base: ['rearm', 'close'],"]], ['unit-cliModeFlags']], //--base 於 --close 通過
    ['TM15', 'src/cfg.mjs', [["            'selectable': '<true|false>',\n", ""]], ['unit-toolFlags']], //armDecide 之表缺 --selectable
    ['TM16', 'src/cfg.mjs', [["'since': '<ISO-time>', 'poll-sec': '<N>' }", "'since': '<ISO-time>' }"]], ['unit-toolFlags']], //waitEvent 之表缺 --poll-sec
    ['TM17', 'src/cfg.mjs', [["roundDigest: { flags: { out: null }, positional: 1, pos:", "roundDigest: { flags: { out: null }, positional: 0, pos:"]], ['unit-toolFlags']], //roundDigest 不收輪次
    ['TM18', 'src/cfg.mjs', [["replayCheck: { flags: {}, positional: Infinity }", "replayCheck: { flags: {}, positional: 1 }"]], ['unit-toolFlags']], //replayCheck 只收一個節點前綴
    ['TM19', 'src/cfg.mjs', [["positional: 0, own: ['dir-hi', 'dir-lo'] }", "positional: 0 }"]], ['unit-toolFlags']], //libCheck 之 own 缺
    ['TM20', 'src/tools/exposure.mjs', [["cliGuard('exposure')\n", "void 0\n"]], ['unit-toolFlags']], //放行工具不檢旗標
    ['TM21', 'src/tools/armDecide.mjs', [["cliGuard('armDecide')\n", "void 0\n"]], ['unit-toolFlags']], //審定工具不檢旗標
    ['TM22', 'src/tools/armInactive.mjs', [["cliGuard('armInactive')\n", "void 0\n"]], ['unit-toolFlags']], //補記工具不檢旗標
    ['TM23', 'src/tools/initProject.mjs', [["    cliGuard('initProject')\n", "    void 0\n"]], ['unit-toolFlags']], //接入工具不檢旗標(--root=… 寫入工作目錄)
    ['TM24', 'src/tools/waitEvent.mjs', [["cliGuard('waitEvent')\n", "void 0\n"]], ['unit-toolFlags']], //監看工具不檢旗標
    ['TM25', 'src/tools/replayCheck.mjs', [["cliGuard('replayCheck')\n", "void 0\n"]], ['unit-toolFlags']], //重放核對工具不檢旗標
    ['TM26', 'src/tools/scanCheck.mjs', [["cliGuard('scanCheck')\n", "void 0\n"]], ['unit-toolFlags']], //重掃工具不檢旗標
    ['TM27', 'src/tools/libCheck.mjs', [["cliGuard('libCheck')\n", "void 0\n"]], ['unit-toolFlags']], //庫況體檢不檢旗標
    ['TM28', 'src/tools/archiveDocs.mjs', [["cliGuard('archiveDocs')\n", "void 0\n"]], ['unit-toolFlags']], //文件整理不檢旗標
    ['TM29', 'src/cli/backtest.mjs', [["if (seedArg0 !== null && !(typeof seedArg0 === 'number' && Number.isSafeInteger(seedArg0))) {", "if (false) {"]], ['unit-cliModeFlags']], //--seed 不合不拒
    ['TM30', 'src/cli/backtest.mjs', [["typeof seedArg0 === 'number' && Number.isSafeInteger(seedArg0)", "typeof seedArg0 === 'number' && Number.isInteger(seedArg0)"]], ['unit-cliModeFlags']], //--seed 超出安全整數照收
    ['TM31', 'src/arsi/rsiNums.mjs', [["return Number.isFinite(x) && k[1](x) ? x : null", "return Number.isFinite(x) ? x : null"]], ['unit-rsiNums']], //數值之值域不檢
    ['TM32', 'src/arsi/rsiNums.mjs', [["let x = typeof v === 'number' ? v : (typeof v === 'string' && isenum(v) ? Number(v) : NaN)", "let x = typeof v === 'number' ? v : NaN"]], ['unit-rsiNums']], //數字字串不收
    ['TM33', 'src/arsi/rsiNums.mjs', [["posInt: ['a positive integer', (x) => Number.isSafeInteger(x) && x >= 1],", "posInt: ['a positive integer', (x) => Number.isSafeInteger(x) && x >= 0],"]], ['unit-rsiNums']], //正整數收 0
    ['TM34', 'src/arsi/rsiNums.mjs', [["(x) => x > 0 && x * 60000 <= 2147483647]", "(x) => x > 0]"]], ['unit-rsiNums']], //逾時分鐘不設上限
    ['TM35', 'src/arsi/rsiNums.mjs', [["let maxArmsOf = (rsiCfg) => orOf(objOf(rsiCfg).maxArmsPerNode, 'posInt', 4)", "let maxArmsOf = (rsiCfg) => orOf(objOf(rsiCfg).maxArmsPerNode, 'posInt', 3)"]], ['unit-rsiNums']], //至多臂數之預設
    ['TM36', 'src/arsi/rsiNums.mjs', [["Math.max(1, Math.min(8, orOf(", "Math.max(1, Math.min(80, orOf("]], ['unit-rsiNums']], //重算併行數之上限
    ['TM37', 'src/arsi/rsiNums.mjs', [["maxBytes: at(d.maxBytes, 'posInt')", "maxBytes: at(d.maxBytes, 'nonNegInt')"]], ['unit-rsiNums']], //maxBytes 收 0
    ['TM38', 'src/arsi/rsiNums.mjs', [["quotaMaxPercent: orOf(p.quotaMaxPercent, 'num', 95)", "quotaMaxPercent: orOf(p.quotaMaxPercent, 'num', 90)"]], ['unit-rsiNums']], //額度門檻之預設
    ['TM39', 'src/arsi/dispatchers.mjs', [["let c2 = { ...c, timeoutMin: numOr(c.timeoutMin, 'timerMin', cfg.timeoutMin),", "let c2 = { timeoutMin: cfg.timeoutMin, ...c,"]], ['unit-rsiNums']], //備援條目無效之逾時不承襲角色之值(取硬預設)
    ['TM40', 'src/arsi/runner.mjs', [["let posInt = (v) => rsiNumOf(v, 'posInt')", "let posInt = (v) => (Number.isInteger(v) && v >= 1 ? v : null)"]], ['unit-rsiNums']], //規模鍵不收數字字串
    ['TM41', 'src/arsi/dispatchers.mjs', [["timeoutMs: numOr(cfg.timeoutMin, 'timerMin', 120) * 60000,", "timeoutMs: (cfg.timeoutMin || 120) * 60000,"]], ['unit-rsiNums']], //節點角色之逾時回到 `||`
    ['TM42', 'src/arsi/dispatchers.mjs', [["let mx = numOr(cfg.quotaMaxPercent, 'num', gateMax)\n            let key = null", "let mx = Number.isFinite(cfg.quotaMaxPercent) ? cfg.quotaMaxPercent : gateMax\n            let key = null"]], ['unit-rsiNums']], //派工時之用量守門之角色門檻不收字串(備援條目承襲主模型之字串門檻者)
    ['TM54', 'src/arsi/dispatchers.mjs', [["quotaMaxPercent: numOr(c.quotaMaxPercent, 'num', cfg.quotaMaxPercent) }", "quotaMaxPercent: Number.isFinite(c.quotaMaxPercent) ? c.quotaMaxPercent : cfg.quotaMaxPercent }"]], ['unit-rsiNums']], //備援條目自己之字串門檻被主模型之門檻取代
    ['TM43', 'src/arsi/dispatchers.mjs', [["let mx = numOr(cfg.quotaMaxPercent, 'num', gateMax)\n        let row =", "let mx = Number.isFinite(cfg.quotaMaxPercent) ? cfg.quotaMaxPercent : gateMax\n        let row ="]], ['unit-rsiNums']], //額度查詢之角色門檻不收字串
    ['TM44', 'src/arsi/dispatchers.mjs', [["let mx2 = numOr(c.quotaMaxPercent, 'num', mx)", "let mx2 = Number.isFinite(c.quotaMaxPercent) ? c.quotaMaxPercent : mx"]], ['unit-rsiNums']], //備援條目之門檻不收字串
    ['TM45', 'src/arsi/dispatchers.mjs', [["let gateMax = numOr(maxPercent, 'num', 95)\n\n    //agentEnv", "let gateMax = Number.isFinite(maxPercent) ? maxPercent : 95\n\n    //agentEnv"]], ['unit-rsiNums']], //派工之 maxPercent 不收字串
    ['TM46', 'src/domain/texts.mjs', [["一個節點至多 ${maxArmsOf(st.rsi)} 臂。", "一個節點至多 ${st.rsi.maxArmsPerNode} 臂。"]], ['unit-rsiNums']], //任務書寫原值(與閘門不同值)
    ['TM47', 'src/domain/sideRead.mjs', [["let n = rsiNumOf(x, 'int2')", "let n = Number.isInteger(x) && x >= 2 ? x : null"]], ['unit-rsiNums']], //側別讀數之整數鍵不收字串
    ['TM48', 'src/domain/backtestCfg.mjs', [["let pAbove = reqNumOf(gr.pAbove, 0.05, 'backtest.grade.pAbove', 'unit')", "let pAbove = gr.pAbove === undefined ? 0.05 : gr.pAbove"]], ['unit-rsiNums']], //pAbove 不檢
    ['TM49', 'src/domain/backtestCfg.mjs', [["let splits = reqNumOf(gr.splits, 2, 'backtest.grade.splits', 'posInt')", "let splits = reqNumOf(gr.splits, 2, 'backtest.grade.splits', 'num')"]], ['unit-rsiNums']], //splits 收小數
    ['TM50', 'src/domain/backtestCfg.mjs', [["let meanMin = reqNumOf(rl.meanMin, 0, 'backtest.rule.meanMin', 'num')", "let meanMin = rl.meanMin === undefined ? 0 : rl.meanMin"]], ['unit-rsiNums']], //meanMin 不檢
    ['TM51', 'src/domain/backtestCfg.mjs', [["rule: { meanMin, worstPhaseMin, ...ruleRest },", "rule: { ...rl, meanMin, worstPhaseMin },"]], ['unit-rsiNums']], //rule 之鍵序隨輸入
    ['TM52', 'src/domain/backtestCfg.mjs', [["grade: { enabled: gradeEnabled, pAbove, pBelow, pStrong, splits, matchSides, ...gradeRest },", "grade: { enabled: gradeEnabled, pAbove, pBelow, pStrong, splits, matchSides },"]], ['unit-rsiNums']], //grade 丟掉其餘之鍵(未知之鍵)
    ['TM53', 'src/domain/domain.mjs', [["let maxArms = maxArmsOf(st.rsi)", "let maxArms = st.rsi.maxArmsPerNode || 4"]], ['unit-rsiNums']], //閘門取原值
    //── 節點任務書之大小與整併後必要之規則(BZ 系列; 規則 R-REC-52; 排程第 588 項 ①; 優先測試 unit-briefSize)──
    ['BZ01', 'src/domain/texts.mjs', [["不是挑中了誰。不同持倉上限或選集大小之 S 不能直接比", "不是挑中了誰。輸出另有損益依多空 / tag 之歸因與評估期間三等分(含兩種對照於各段之均)。不同持倉上限或選集大小之 S 不能直接比"], ["以策略庫之一半重跑同一個模組(模組不必改寫),檢驗內容", "以策略庫之一半重跑同一個模組(`0` = 甲半、`1` = 乙半;換鹽 = 換一種切法;模組不必改寫),檢驗內容"], ["一次只執行一個評估指令(不用 shell 迴圈或 `&&` 串接)。要寫進", "一次只執行一個評估指令(不用 shell 迴圈或 `&&` 串接)。(迴圈會檢查每個已完整評估之版本是否仍有檔可重現。)要寫進"]], ['unit-briefSize']], //把整併掉之三句加回 ⇒ 最長之情境逾 15,000
    ['BZ14', 'src/domain/texts.mjs', [["${isVerify ? '機制要說得出它抓到什麼結構、為何換一段期間仍可望成立。' : ''}", "機制要說得出它抓到什麼結構、為何換一段期間仍可望成立。"]], ['unit-briefSize']], //探索類亦重述(重複)
    ['BZ15', 'src/domain/texts.mjs', [["${isVerify ? '機制要說得出它抓到什麼結構、為何換一段期間仍可望成立。' : ''}", ""]], ['unit-briefSize']], //驗證類失去該句
    ['BZ02', 'src/domain/texts.mjs', [["**提案不影響本節點之任務**(仍以指定之臂交付,不因想提案而多做實驗)。", ""]], ['unit-briefSize']], //armProposals 之「不影響本節點之任務」被刪
    ['BZ03', 'src/domain/texts.mjs', [["(isVerify ? ';迴圈會記錄完整評估之次數與相異選集數' : '')", "''"]], ['unit-briefSize']], //驗證類不再有「相異選集數」之記錄說明
    ['BZ04', 'src/domain/texts.mjs', [["不是績效之依據,**也不計入判讀**;", "不是績效之依據;"]], ['unit-briefSize']], //--period train 之「不計入判讀」被刪
    ['BZ05', 'src/domain/texts.mjs', [["**只供診斷**(見 §5)。", "**只供診斷**。"]], ['unit-briefSize']], //交叉引用之字樣被刪
    ['BZ06', 'src/domain/texts.mjs', [["(等效年化之分母),不同規則之間不直接比 S。'", "(等效年化之分母)。'"]], ['unit-briefSize']], //新加之臂屬執行層之「不直接比 S」被刪
    ['BZ07', 'src/domain/texts.mjs', [["outcome: 'improved | neutral | worse | failed(擇一)'", "outcome: ''"]], ['unit-briefSize']], //「擇一值見範本」所指之範本值被刪
    ['BZ08', 'src/domain/texts.mjs', [["試過而關閉是正常結果,如實填寫即可", "如實填寫即可"]], ['unit-briefSize']], //inactiveArms 之說明被刪
    ['BZ09', 'src/domain/texts.mjs', [["**重疊率以 `--mode quick` 量即可,不要為它多跑一次完整評估。**", ""]], ['unit-briefSize']], //--ref 之「以 quick 量即可」被刪
    ['BZ10', 'src/domain/texts.mjs', [["(hasCross() ? '、**其他標的之正負號**", "(false ? '、**其他標的之正負號**"]], ['unit-briefSize']], //其他標的之正負號之說明不出現(情境表之鑑別前提)
    ['BZ11', 'src/domain/texts.mjs', [["let codeRel = rel(pkgRoot ? path.join(pkgRoot, 'src', 'domain') : here)", "let codeRel = rel(here)"]], ['unit-pkgRoot']], //打包後程式夾回到打包檔所在之夾
    ['BZ12', 'src/domain/texts.mjs', [["let codeRootRel = rel(pkgRoot ? path.join(pkgRoot, 'src') : path.resolve(here, '..'))", "let codeRootRel = rel(path.resolve(here, '..'))"]], ['unit-pkgRoot']],
    ['BZ13', 'src/domain/texts.mjs', [["- **訓練期之績效不是目標**:策略庫之每隻", "- **訓練期之績效是目標**:策略庫之每隻"]], ['unit-texts']], //鑑別: 既有之語意斷言仍抓得到
    //── 節點之禁區字樣之補充: 萬用字元、先切換目錄、套件之建置產物與文件(ZN 系列; 規則 R-BT-10 ⑦; 排程第 580 項 ①; 優先測試 unit-verifyZone)──
    ['ZN01', 'src/domain/verifyCmdScan.mjs', [["            else {\n                out += '[^/]*'\n            }", "            else {\n                out += '.*'\n            }"]], ['unit-verifyZone']], //* 跨 /
    ['ZN02', 'src/domain/verifyCmdScan.mjs', [["        else if (c === '?') {\n            out += '[^/]'", "        else if (c === '?') {\n            out += '.'"]], ['unit-verifyZone']], //? 跨 /
    ['ZN03', 'src/domain/verifyCmdScan.mjs', [["else if (c === '{' && g.indexOf('}', i) > 0) {", "else if (false) {"]], ['unit-verifyZone']], //大括號之展開
    ['ZN04', 'src/domain/verifyCmdScan.mjs', [["else if (c === '[' && g.indexOf(']', i + 2) > 0) {", "else if (false) {"]], ['unit-verifyZone']], //字元類
    ['ZN05', 'src/domain/verifyCmdScan.mjs', [["                    i++\n                }\n                out += '.*'", "                    i++\n                }\n                out += '[^/]*'"]], ['unit-verifyZone']], //** 不跨層
    ['ZN06', 'src/domain/verifyCmdScan.mjs', [["...ZONE_FILES.map((f) => `${tree}/${f}`), `${tree}/domain`]),", "...ZONE_FILES.map((f) => `${tree}/${f}`)]),"]], ['unit-verifyZone']], //domain 夾本身不在候選
    ['ZN07', 'src/domain/verifyCmdScan.mjs', [["let ZONE_TREES = ['src', 'lib', 'node_modules/w-trade-adaptivess/src']", "let ZONE_TREES = ['src', 'node_modules/w-trade-adaptivess/src']"]], ['unit-verifyZone']], //舊制之 lib
    ['ZN08', 'src/domain/verifyCmdScan.mjs', [["let ZONE_TREES = ['src', 'lib', 'node_modules/w-trade-adaptivess/src']", "let ZONE_TREES = ['src', 'lib']"]], ['unit-verifyZone']], //套件裝於 node_modules
    ['ZN09', 'src/domain/verifyCmdScan.mjs', [["    'tools/libCheck.mjs',\n]", "]"]], ['unit-verifyZone']], //庫況體檢之程式不在清單
    ['ZN10', 'src/domain/verifyCmdScan.mjs', [["        let m = ZONE_CD.exec(part)", "        let m = null"]], ['unit-verifyZone']], //不認切換目錄
    ['ZN11', 'src/domain/verifyCmdScan.mjs', [["let top = st.stack.length ? st.stack.pop() : { dir: null, tail: '' }", "let top = { dir: null, tail: '' }"]], ['unit-verifyZone']], //popd 不回原目錄
    ['ZN12', 'src/domain/verifyCmdScan.mjs', [["            if (kw === 'pushd' || kw === 'push-location') {\n                st.stack.push({ dir: st.dir, tail: st.tail })\n            }\n", ""]], ['unit-verifyZone']], //pushd 不入堆疊
    ['ZN13', 'src/domain/verifyCmdScan.mjs', [["if (/^(?:\\/d|-[A-Za-z-]+)$/i.test(ws[k])) {", "if (false) {"]], ['unit-verifyZone']], //cmd 之 /d 與選項不略過
    ['ZN15', 'src/domain/verifyCmdScan.mjs', [["let r = abs ? absOf(rootN || '/', t).replace(/\\\\/g, '/') : join(base, t)", "let r = abs ? absOf(rootN || '/', t).replace(/\\\\/g, '/') : t"]], ['unit-verifyZone']], //相對路徑不依目錄解析與正規化
    ['ZN16', 'src/domain/verify.mjs', [["                        zone = zr.state", "                        void 0"]], ['unit-verifyZone']], //跨呼叫不沿用切換
    ['ZN17', 'src/domain/verify.mjs', [["zst = { dir: rel !== null && !rel.startsWith('..') ? rel : null, tail: '', stack: [] }", "zst = zone"]], ['unit-verifyZone']], //不理會 workdir
    ['ZN18', 'src/domain/verify.mjs', [["if (typeof inp.command === 'string' && wdz === undefined) {\n                        zone = zr.state", "if (typeof inp.command === 'string') {\n                        zone = zr.state"]], ['unit-verifyZone']], //帶 workdir 之呼叫改變持續之目錄
    ['ZN19', 'src/domain/verify.mjs', [["                if (nodeRules) {\n                    let rootAbs", "                if (true) {\n                    let rootAbs"]], ['unit-verifyZone']], //做夢亦套用
    ['ZN20', 'src/domain/verify.mjs', [["|node_modules[\\\\\\\\/]+${escRe(PKG_NAME)}[\\\\\\\\/]+(?:dist|docs|sgud|test|README)", "|node_modules[\\\\\\\\/]+${escRe(PKG_NAME)}[\\\\\\\\/]+(?:docs|sgud|test|README)"]], ['unit-verifyZone']], //dist 不在
    ['ZN21', 'src/domain/verify.mjs', [["(?:dist|docs|sgud|test|README)", "(?:dist|sgud|test|README)"]], ['unit-verifyZone']], //docs 不在
    ['ZN22', 'src/domain/verify.mjs', [["(?:dist|docs|sgud|test|README)", "(?:dist|docs|test|README)"]], ['unit-verifyZone']], //sgud 不在
    ['ZN23', 'src/domain/verify.mjs', [["(?:dist|docs|sgud|test|README)", "(?:dist|docs|sgud|README)"]], ['unit-verifyZone']], //test 不在
    ['ZN24', 'src/domain/verify.mjs', [["(?:dist|docs|sgud|test|README)", "(?:dist|docs|sgud|test)"]], ['unit-verifyZone']], //README 不在
    ['ZN25', 'src/domain/verify.mjs', [["|dist[\\\\\\\\/]+${escRe(PKG_NAME)}`, 'i')", "`, 'i')"]], ['unit-verifyZone']], //專案內之 dist/<套件名> 不在
    ['ZN26', 'src/domain/verify.mjs', [["zoneToolOf(inp, zst, { root: rootAbs, tool })", "{ texts: [], glob: null, state: zone }"]], ['unit-verifyZone']], //非殼層之工具輸入不判
    ['ZN27', 'src/domain/verifyCmdScan.mjs', [["let join = (base, t) => path.posix.normalize(base ? path.posix.join(base, t) : t)", "let join = (base, t) => (base ? path.posix.join(base, t) : t)"]], ['unit-verifyZone']], //路徑字不正規化(./、..)
    ['ZN28', 'src/domain/verifyCmdScan.mjs', [["for (let variant of [stmt, stmt.replace(/[\"'^`]/g, '')]) {", "for (let variant of [stmt]) {"]], ['unit-verifyZone']], //不取去引號 / 跳脫字元之版本
    ['ZN29', 'src/domain/verifyCmdScan.mjs', [["if (r !== t || !origToks.has(tok)) {", "if (r !== t) {"]], ['unit-verifyZone']], //去引號後才成形之字不另列
    ['ZN30', 'src/domain/verifyCmdScan.mjs', [["        if (depth < 2) {", "        if (false) {"]], ['unit-verifyZone']], //引號內之內嵌指令不遞迴
    ['ZN31', 'src/domain/verifyCmdScan.mjs', [["(?:(?:then|do|else|command|builtin|eval|exec)\\s+)?(cd|chdir", "(cd|chdir"]], ['unit-verifyZone']], //cd 之前綴與控制結構之關鍵字
    ['ZN32', 'src/domain/verifyCmdScan.mjs', [["            if (ZONE_DIR_RE.test(baseOf())) {\n                dirHit = true\n            }\n", ""]], ['unit-verifyZone']], //切換後之目錄本身落在禁區夾不列
    ['ZN33', 'src/domain/verifyCmdScan.mjs', [["                else {\n                    st.tail = r === '.' ? '' : r\n                }", "                else {\n                    st.tail = ''\n                }"]], ['unit-verifyZone']], //目錄不確定後不累積相對鏈
    ['ZN34', 'src/domain/verifyCmdScan.mjs', [["                if (r.startsWith('..')) {", "                if (false) {"]], ['unit-verifyZone']], //逾專案根者不改為不確定(上層之同名夾 ../src 被當成本套件之 src; ⑦b 之不列案)
    ['ZN35', 'src/domain/verifyCmdScan.mjs', [["'sgud', 'sgud/rule/rulebook.md', 'sgud/state/state.md',", "'sgud',"]], ['unit-verifyZone']], //套件之 sgud 之代表檔不在候選
    ['ZN36', 'src/domain/verifyCmdScan.mjs', [["let raw = [...bases, ...(bases.length ? [] : globs)]", "let raw = [...bases, ...globs]"]], ['unit-verifyZone']], //有路徑欄者樣式欄亦單獨判(誤報)
    ['ZN37', 'src/domain/verifyCmdScan.mjs', [["/grep|search/i.test(tool) ? ['glob', 'include'] : ['pattern', 'glob', 'include']", "['pattern', 'glob', 'include']"]], ['unit-verifyZone']], //Grep 類之 pattern(內容之正規式)當路徑
    ['ZN38', 'src/domain/verifyCmdScan.mjs', [["(g.match(/\\*/g) || []).length > 16", "false"]], ['unit-verifyZone']], //萬用字元過多者不列
    ['ZN40', 'src/domain/verifyCmdScan.mjs', [["let inner = typeof qd === 'string' ? qd.slice(1, -1) : ''", "let inner = qd.slice(1, -1)"]], ['unit-scanListRoot']], //指令內越界之佔位符(控制字元)取不到引號段而拋錯
    //── 做夢之搜尋樣式之去除: 樣式來源整段先定(SQ 系列; 規則 R-BT-8; 排程第 576 項 ②; 優先測試 unit-cmdScan)──
    ['SQ01', 'src/domain/verifyCmdScan.mjs', [["return t[j] === 'e' ? (j === t.length - 1 ? 2 : t.slice(0, j + 1)) : 0", "return t[j] === 'e' ? 2 : 0"]], ['unit-cmdScan']], //-e 附值當成值在下一字
    ['SQ02', 'src/domain/verifyCmdScan.mjs', [["return t.includes('=') ? t.slice(0, t.indexOf('=') + 1) : 2", "return 2"]], ['unit-cmdScan']], //--regexp=值 / --regexp 之縮寫 附值者當成值在下一字
    ['SQ03', 'src/domain/verifyCmdScan.mjs', [["(patFileOf(m0[0], toks[k]) || eOf(m0[0], toks[k]) ||", "(patFileOf(m0[0], toks[k]) ||"]], ['unit-cmdScan']], //運算元之後之 -e 不算樣式來源
    ['SQ04', 'src/domain/verifyCmdScan.mjs', [["                //其後有給樣式之選項: 此引數是路徑; 繼續往後處理(其後之 -e 類之值須去)\n                removed = true\n", "                removed = true\n                break\n"]], ['unit-cmdScan']], //其後之 -e 之值不去
    ['SQ05', 'src/domain/verifyCmdScan.mjs', [["nameRe: 'g', listOnly: 'f' },", "nameRe: 'g', listOnly: '' },"]], ['unit-cmdScan']], //ack 之 -f 不使無位置樣式
    ['SQ06', 'src/domain/verifyCmdScan.mjs', [["'depth', 'width', 'workers'], nameRe: 'g'", "'depth', 'width', 'workers'], nameRe: ''"]], ['unit-cmdScan']], //ag 之 -g 不使無位置樣式
    ['SQ07', 'src/domain/verifyCmdScan.mjs', [["'max-count'], nameRe: 'g', listOnly: 'f' },", "'max-count'], nameRe: '', listOnly: 'f' },"]], ['unit-cmdScan']], //ack 之 -g 不使無位置樣式
    ['SQ08', 'src/domain/verifyCmdScan.mjs', [["val: j + 1 < t.length ? 1 : (tb.num.includes(t[j]) ? 3 : 2)", "val: j + 1 < t.length ? 1 : 2"]], ['unit-cmdScan']], //數字值之選項吞下一字(不論數字與否)
    ['SQ09', 'src/domain/verifyCmdScan.mjs', [["if (!num || /^\\d+$/.test(dropQuotes(t))) {", "if (true) {"]], ['unit-cmdScan']], //數字值之判定不做
    ['SQ10', 'src/domain/verifyCmdScan.mjs', [["val: m[2] !== undefined ? 1 : (tb.longNum.includes(m[1]) ? 3 : 2)", "val: m[2] !== undefined ? 1 : 2"]], ['unit-cmdScan']], //長選項之數字值
    ['SQ11', 'src/domain/verifyCmdScan.mjs', [["longVal: ['after', 'before', 'context', 'ignore', 'ignore-dir',", "longVal: ['after', 'before', 'context', 'ignore',"]], ['unit-cmdScan']], //ag 之 --ignore-dir 之值當成樣式
    ['SQ12', 'src/domain/verifyCmdScan.mjs', [["if (/(?:^|[\\\\/])ack(?:\\.exe)?$/i.test(head)) {", "if (/^ack$/i.test(head)) {"]], ['unit-cmdScan']], //ack 之指令名(路徑前綴、.exe)
    ['SQ13', 'src/domain/verifyCmdScan.mjs', [["            if (!endOpts && t === '--') {", "            if (false) {"]], ['unit-cmdScan']], //「--」不終止選項
    ['SQ14', 'src/domain/verifyCmdScan.mjs', [["(isFindstr && /^\\/[CG]:/i.test(toks[k]))", "(isFindstr && /^\\/G:/i.test(toks[k]))"]], ['unit-cmdScan']], //findstr 之運算元之後之 /C:
    ['SQ15', 'src/domain/verifyCmdScan.mjs', [["return t === '--match' ? 2 : (t.startsWith('--match=') ? '--match=' : 0)", "return 0"]], ['unit-cmdScan']], //ack 之 --match
    ['SQ16', 'src/domain/verifyCmdScan.mjs', [["            if (!endOpts && (fam === 'ag' || fam === 'ack') && t.startsWith('-')) {", "            if (false) {"]], ['unit-cmdScan']], //ag / ack 不另依語法
    ['SQ17', 'src/domain/verifyCmdScan.mjs', [["            if (/[&`<>()]|\\$\\(/.test(dropQuotes(t))) {", "            if (false) {"]], ['unit-cmdScan']], //重導向 / 背景 / 命令替換為界之判定
    ['SQ18', 'src/domain/verifyCmdScan.mjs', [["                        if (!hasSubst(toks[k])) {\n                            toks[k] = ' '\n                        }\n                        break", "                        toks[k] = ' '\n                        break"]], ['unit-cmdScan']], //-e 之值含命令替換亦去
    ['SQ19', 'src/domain/verifyCmdScan.mjs', [["/^--reg(?:e(?:x(?:p)?)?)?(?:=|$)/", "/^--regexp(?:=|$)/"]], ['unit-cmdScan']], //GNU grep 之長選項縮寫
    ['SQ20', 'src/domain/verifyCmdScan.mjs', [["                if (!hasSubst(t)) {\n                    toks[i] = ev\n                }", "                toks[i] = ev"]], ['unit-cmdScan']], //-e 附值之值含命令替換亦去
    ['SQ21', 'src/domain/verifyCmdScan.mjs', [["                    if (!hasSubst(t)) {\n                        toks[i] = ' '\n                    }\n                    removed = true\n                    break", "                    toks[i] = ' '\n                    removed = true\n                    break"]], ['unit-cmdScan']], //位置樣式含命令替換亦去
    //── 計時器相關函數之觀察回調 opt.onTrace(TR 系列; 規則 R-PKG-8; 排程第 477 項 ①; 優先測試 unit-timerTrace)──
    ['TR01', 'src/arsi/resources.mjs', [["        if (trace) {\n            trace('sample', { cpu, ramUsedGB: r.ramUsedGB })\n        }\n", ""]], ['unit-timerTrace']],
    ['TR02', 'src/arsi/resources.mjs', [["        if (trace) {\n            trace('start', { sampleSec })\n        }\n        sample()", "        sample()\n        if (trace) {\n            trace('start', { sampleSec })\n        }"]], ['unit-timerTrace']], //start 晚於首次取樣
    ['TR03', 'src/arsi/resources.mjs', [["            timer = null\n            if (trace) {\n                trace('stop', {})\n            }\n        }", "            timer = null\n        }\n        if (trace) {\n            trace('stop', {})\n        }"]], ['unit-timerTrace']], //未在取樣者亦發 stop
    ['TR04', 'src/arsi/resources.mjs', [["                if (trace) {\n                    trace('wait-block', { tag, cpu: last.cpu, ramUsedGB: last.ramUsedGB })\n                }\n", ""]], ['unit-timerTrace']],
    ['TR05', 'src/arsi/resources.mjs', [["trace('wait-poll', { tag, cpu: last.cpu, ramUsedGB: last.ramUsedGB, sleepMs })", "trace('wait-poll', { tag, cpu: last.cpu, ramUsedGB: last.ramUsedGB, sleepMs: pollSec * 1000 })"]], ['unit-timerTrace']], //事件之毫秒數不含抖動
    ['TR06', 'src/arsi/resources.mjs', [["trace('wait-forced', { tag, waitedSec: Math.round((Date.now() - t0) / 1000), forced: true })", "trace('wait-forced', { tag, waitedSec: Math.round((Date.now() - t0) / 1000), forced: false })"]], ['unit-timerTrace']],
    ['TR07', 'src/arsi/resources.mjs', [["trace('wait-pass', { tag, waitedSec: Math.round(sec), forced: false, limited: true })", "trace('wait-pass', { tag, waitedSec: Math.round(sec), forced: false, limited: false })"]], ['unit-timerTrace']],
    ['TR08', 'src/arsi/resources.mjs', [["trace('wait-pass', { tag, waitedSec: 0, forced: false, limited: false })", "void 0"]], ['unit-timerTrace']], //未設上限之放行不發事件
    ['TR09', 'src/arsi/resources.mjs', [["    let trace = getTrace(opt)", "    let trace = null"]], ['unit-timerTrace']],
    ['TR10', 'src/domain/proc.mjs', [["            if (trace) {\n                trace('timeout', { timeoutMs })\n            }\n", ""]], ['unit-timerTrace']],
    ['TR11', 'src/domain/proc.mjs', [["    if (trace && typeof p.pid === 'number') {", "    if (trace) {"]], ['unit-timerTrace']], //起不來者亦發 spawn
    ['TR12', 'src/domain/proc.mjs', [["            if (trace) {\n                trace('exit', { code })\n            }\n", ""]], ['unit-timerTrace']],
    ['TR13', 'src/domain/proc.mjs', [["        if (trace) {\n            trace('error', { message: String((err && err.message) || err) })\n        }\n        resolve({ code: null, out, timeout: false, error: String((err && err.message) || err) })\n        return", "        resolve({ code: null, out, timeout: false, error: String((err && err.message) || err) })\n        return"]], ['unit-timerTrace']], //同步拋出之 spawn 失敗不發 error(此路徑於測試以 cwd 不存在觸發之非同步 error 為主; 見報告)
    ['TR14', 'src/arsi/waitEnd.mjs', [["let RECHECK_MS = 1500", "let RECHECK_MS = 1000"]], ['unit-timerTrace']],
    ['TR15', 'src/arsi/waitEnd.mjs', [["                if (trace) {\n                    trace('round-done', {})\n                }\n", ""]], ['unit-timerTrace']],
    ['TR16', 'src/arsi/waitEnd.mjs', [["                trace('recheck', {})\n", ""]], ['unit-timerTrace']],
    ['TR17', 'src/arsi/waitEnd.mjs', [["        if (!lk.running && (sawLock || existsSync(fpLock))) {", "        if (!lk.running) {"]], ['unit-timerTrace']], //未見過鎖亦復查
    ['TR18', 'src/arsi/waitEnd.mjs', [["Date.parse(e.at) >= since)\n        for", "true)\n        for"]], ['unit-timerTrace']], //since 不濾
    ['TR19', 'src/arsi/waitEnd.mjs', [["if (now() - t0 > timeoutMs) {", "if (now() - t0 >= timeoutMs) {"]], ['unit-timerTrace']], //逾時之邊界
    ['TR20', 'src/arsi/waitEnd.mjs', [["return finish(5, 'vanished',", "return finish(4, 'vanished',"]], ['unit-timerTrace']],
    ['TR21', 'src/arsi/waitEnd.mjs', [["            trace('sleep', { ms: pollMs })\n", ""]], ['unit-timerTrace']],
    ['TR22', 'src/arsi/waitEnd.mjs', [["            trace('poll', { events: evs.length, running: !!lk.running, sawLock })", "            trace('poll', { events: evs.length, running: !lk.running, sawLock })"]], ['unit-timerTrace']],
    ['TR23', 'src/tools/waitEvent.mjs', [["process.exit(await waitRunEnd({ fpEvents, fpLock, since, timeoutMs, pollMs }))", "process.exit(await waitRunEnd({ fpEvents, fpLock, since: 0, timeoutMs, pollMs }))"]], ['unit-timerTrace']], //工具接線: since 不傳
    //── 往上找套件根(PK 系列; 排程第 477 項 ②; 優先測試 unit-pkgRoot)──
    ['PK01', 'src/domain/pkgRoot.mjs', [["JSON.parse(fs.readFileSync(fp, 'utf8')).name === name", "true"]], ['unit-pkgRoot']], //不核對套件名
    ['PK02', 'src/domain/pkgRoot.mjs', [["        let up = path.dirname(d)\n        if (up === d) {\n            return null\n        }\n        d = up", "        return null"]], ['unit-pkgRoot']], //不往上找
    ['PK03', 'src/domain/fillKeys.mjs', [["    if (root && fs.existsSync(path.join(root, 'src', 'eval'))) {", "    if (false) {"]], ['unit-pkgRoot']], //SRC 不依套件根
    ['PK04', 'src/domain/fillKeys.mjs', [["let root = pkgRootOf(here, pkgName)", "let root = null"]], ['unit-pkgRoot']],
    //── 588 項 ②: 做夢更新專案 state.md 之說明之量尺並列(優先測試 unit-fakeRound 之整輪)──
    ['FR01', 'src/domain/domain.mjs', [["        lines.push(...unproposedNoteOf(a.proposals))\n", ""]], ['unit-fakeRound']], //輪末鉤子內「方向未入前緣」一行之呼叫站點被刪(排程第 477 項 ③)
    ['DS01', 'src/domain/domain.mjs', [["**目前「挑選內容(組成對照之超額)最高且可信」之成品與「回測期 S 最高且可信」之成品(並列;同一個者寫一次並註明)**", "**目前回測期 S 最高且可信之成品**"]], ['unit-fakeRound']], //回到只列 S 最高者
    //── 輸入之值與必給件之檢測(IN 系列; 排程第 607 項、第 477 項 ④之餘項; R-EV-54; 優先測試 unit-cliValues、unit-inputGates、unit-inputOpt)──
    //  命令列之值之種類表(CLI_VALUES)與其檢查(cliMsgOf)
    ['IN01', 'src/cfg.mjs', [["rsi: { nodes: 'posInt', arms:", "rsi: { arms:"]], ['unit-cliValues']], //--nodes 之值不驗
    ['IN02', 'src/cfg.mjs', [["arms: 'posInt', parallel:", "parallel:"]], ['unit-cliValues']],
    ['IN03', 'src/cfg.mjs', [["parallel: 'posInt', workers:", "workers:"]], ['unit-cliValues']],
    ['IN04', 'src/cfg.mjs', [["workers: 'posInt', rounds:", "rounds:"]], ['unit-cliValues']],
    ['IN05', 'src/cfg.mjs', [["rounds: 'posInt', par:", "par:"]], ['unit-cliValues']],
    ['IN06', 'src/cfg.mjs', [["par: 'posInt', round: 'posInt' },", "round: 'posInt' },"]], ['unit-cliValues']],
    ['IN07', 'src/cfg.mjs', [["par: 'posInt', round: 'posInt' },", "par: 'posInt' },"]], ['unit-cliValues']],
    ['IN08', 'src/cfg.mjs', [["rankCompare: { k: 'posInt' },", "rankCompare: {},"]], ['unit-cliValues']],
    ['IN09', 'src/cfg.mjs', [["quota: { max: 'num' },", "quota: { max: 'posNum' },"]], ['unit-cliValues']], //--max 不收 0 與負數
    ['IN10', 'src/cfg.mjs', [["'timeout-min': 'timerMin', 'poll-sec'", "'timeout-min': 'posNum', 'poll-sec'"]], ['unit-cliValues']], //逾時分鐘不設上限
    ['IN11', 'src/cfg.mjs', [["'poll-sec': 'timerSec', 'since': 'time' },", "'poll-sec': 'posNum', 'since': 'time' },"]], ['unit-cliValues']],
    ['IN12', 'src/cfg.mjs', [["'poll-sec': 'timerSec', 'since': 'time' },", "'poll-sec': 'timerSec' },"]], ['unit-cliValues']], //--since 之值不驗
    ['IN13', 'src/cfg.mjs', [["armDecide: { selectable: { enum: ['true', 'false'] } },", "armDecide: {},"]], ['unit-cliValues']],
    ['IN14', 'src/cfg.mjs', [["return kind.enum.includes(v.trim()) ?", "return kind.enum.includes(v) ?"]], ['unit-cliValues']], //列舉不去頭尾空白
    ['IN15', 'src/cfg.mjs', [["return timeMsOf(v) === null ?", "return timeMsOf(v) === undefined ?"]], ['unit-cliValues']], //時間字串恆合格
    ['IN16', 'src/cfg.mjs', [["return rsiNumOf(v, kind) === null ? `invalid --${nm}", "return rsiNumOf(v, kind) === undefined ? `invalid --${nm}"]], ['unit-cliValues']], //數字恆合格
    ['IN17', 'src/cfg.mjs', [["return rsiNumOf(token, 'posInt') === null ?", "return rsiNumOf(token, 'posInt') === undefined ?"]], ['unit-cliValues']], //輪次恆合格
    ['IN18', 'src/cfg.mjs', [["return token.split(',').every((x) =>", "return token.split(',').some((x) =>"]], ['unit-cliValues']], //前綴清單任一合格即可
    ['IN19', 'src/cfg.mjs', [["[A-Za-z0-9_-]{1,64}$/.test(x)", "[A-Za-z0-9_-]{1,65}$/.test(x)"]], ['unit-cliValues']], //前綴長度上限 65
    ['IN20', 'src/cfg.mjs', [["return s.enum.includes(token) ? null :", "return true ? null :"]], ['unit-cliValues']], //位置引數之列舉恆合格
    ['IN21', 'src/cfg.mjs', [["    return valMsg\n}", "    return null\n}"]], ['unit-cliValues']], //值之種類之訊息不回
    ['IN22', 'src/cfg.mjs', [["if (Object.prototype.hasOwnProperty.call(vals, nm) && valMsg === null) {", "if (Object.prototype.hasOwnProperty.call(vals, nm)) {"]], ['unit-cliValues']], //後者覆蓋前者(合格者覆蓋不合者)
    ['IN23', 'src/cfg.mjs', [["let pm = isTool ? posMsgOf(entry, nSeen, a) : null\n                if (pm !== null && valMsg === null) {", "let pm = isTool ? posMsgOf(entry, nSeen, a) : null\n                if (false) {"]], ['unit-cliValues']], //位置引數之值不驗
    ['IN24', 'src/cfg.mjs', [["let pm = isTool ? posMsgOf(entry, nSeen, v) : null\n                    if (pm !== null && valMsg === null) {", "let pm = isTool ? posMsgOf(entry, nSeen, v) : null\n                    if (false) {"]], ['unit-cliValues']], //布林旗標之後之位置引數之值不驗
    ['IN25', 'src/cfg.mjs', [["    let x = rsiNumOf(v, kind)\n    return x === null ? def : x\n}\n\n//CLI_FLAGS", "    let x = Number(v)\n    return x === null ? def : x\n}\n\n//CLI_FLAGS"]], ['unit-cliValues']], //argNumOf 取 Number(原字串)
    ['IN26', 'src/cfg.mjs', [["if (m === null || !calendarOk(m)) {", "if (m === null) {"]], ['unit-cliValues']], //T2 不核對日曆
    ['IN27', 'src/cfg.mjs', [["d <= dim[mo - 1] &&", "d <= 31 &&"]], ['unit-cliValues']], //日不依月
    ['IN28', 'src/cfg.mjs', [["&& h <= 23 &&", "&& h <= 24 &&"]], ['unit-cliValues']], //24 時
    //IN29、IN30 為等價變異(第 5 欄 'equiv'): 分或秒為 60 者 `Date.parse` 本身回 NaN(V8 只滾動「日」, 不收分與秒之 60), 其後之 `Number.isFinite` 之核對仍拒 ⇒ `calendarOk` 之 `mi <= 59`、`s <= 59` 為重複之防線(保留以不依賴引擎之寬嚴); 等價之前提(Date.parse 對分、秒之 60 回 NaN)由 test/unit-cliValues 之時間字串案以斷言守住
    ['IN29', 'src/cfg.mjs', [["mi <= 59 && s <= 59", "mi <= 60 && s <= 59"]], ['unit-cliValues'], 'equiv'], //60 分
    ['IN30', 'src/cfg.mjs', [["mi <= 59 && s <= 59", "mi <= 59 && s <= 60"]], ['unit-cliValues'], 'equiv'], //60 秒
    ['IN31', 'src/cfg.mjs', [["(y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28", "y % 4 === 0 ? 29 : 28"]], ['unit-cliValues']], //閏年不排除世紀年
    ['IN32', 'src/cfg.mjs', [["return m !== null && calendarOk(m) && Number.isFinite(Date.parse(`${v}Z`))", "return m !== null && Number.isFinite(Date.parse(`${v}Z`))"]], ['unit-cliValues']], //無時區之時間不核對日曆
    //  設定檔之必給節與路徑欄、派工設定、辨識器
    ['IN34', 'src/cfg.mjs', [["if (o === null || typeof o !== 'object' || Array.isArray(o)) {", "if (o === null) {"]], ['unit-inputGates']],
    ['IN35', 'src/cfg.mjs', [["if (typeof v !== 'string' || v === '') {\n            throw new Error(`invalid ${where}: must be a non-empty string`)", "if (typeof v !== 'string') {\n            throw new Error(`invalid ${where}: must be a non-empty string`)"]], ['unit-inputGates']],
    ['IN36', 'src/cfg.mjs', [["if (typeof st.dispatch.skillsRoot !== 'string') {", "if (false) {"]], ['unit-inputGates']],
    ['IN37', 'src/cfg.mjs', [["        agentsCheck(st.agents, 'settings.agents')", "        void 0"]], ['unit-inputGates']],
    ['IN38', 'src/cfg.mjs', [["source\\.libraryRoot|rsi\\.rankBy|settings[.:]|backtest:", "source\\.libraryRoot|settings[.:]|backtest:"]], ['unit-inputGates']],
    ['IN39', 'src/cfg.mjs', [["rsi\\.rankBy|settings[.:]|backtest:", "rsi\\.rankBy|settings\\.|backtest:"]], ['unit-inputGates']],
    ['IN40', 'src/cfg.mjs', [["rsi\\.rankBy|settings[.:]|backtest:)", "rsi\\.rankBy|settings[.:])"]], ['unit-inputGates']],
    //  進入檔與工具之讀取處(取檢查合格之轉換值; 字串旗標取原字串)
    ['IN41', 'src/cli/rsi.mjs', [["let cliInt = (k) => argNumOf(k, 'posInt', null)", "let cliInt = (k) => {\n    let v = argOf(k, null)\n    return Number.isInteger(v) && v >= 1 ? v : null\n}"]], ['unit-cliValues']],
    ['IN42', 'src/cli/rsi.mjs', [["let parArg = argNumOf('par', 'posInt', null)", "let parArg = argOf('par', null)"]], ['unit-cliValues']],
    ['IN43', 'src/cli/rsi.mjs', [["let rd = argNumOf('round', 'posInt', 0)\n    let fpTxt", "let rd = argOf('round', 0)\n    let fpTxt"]], ['unit-cliValues']],
    ['IN44', 'src/cli/rsi.mjs', [["let rd = argNumOf('round', 'posInt', 0)\n    let fpJs", "let rd = argOf('round', 0)\n    let fpJs"]], ['unit-cliValues']],
    ['IN45', 'src/cli/rsi.mjs', [["let why = String(argStrOf('why', ''))", "let why = String(argOf('why', ''))"]], ['unit-cliValues']],
    ['IN46', 'src/cli/rsi.mjs', [["why: String(argStrOf('why', ''))", "why: String(argOf('why', ''))"]], ['unit-cliValues']],
    ['IN47', 'src/cli/rsi.mjs', [["let why = argStrOf('why', '')\n        if (!to", "let why = argOf('why', '')\n        if (!to"]], ['unit-cliValues']],
    ['IN48', 'src/tools/waitEvent.mjs', [["let since = i0 >= 0 ? timeMsOf(process.argv[i0 + 1]) : Date.now()", "let since = Date.now()"]], ['unit-cliValues']], //--since 不採
    ['IN49', 'src/tools/waitEvent.mjs', [["argNumOf('timeout-min', 'timerMin', 110) * 60000", "argNumOf('timeout-min', 'timerMin', 110) * 1000"]], ['unit-cliValues']],
    ['IN50', 'src/tools/waitEvent.mjs', [["Math.max(2, argNumOf('poll-sec', 'timerSec', 20)) * 1000", "Math.max(1, argNumOf('poll-sec', 'timerSec', 20)) * 1000"]], ['unit-cliValues']],
    ['IN51', 'src/tools/quota.mjs', [["let max = argNumOf('max', 'num', preNum.quotaMaxPercent)", "let max = preNum.quotaMaxPercent"]], ['unit-cliValues']],
    ['IN52', 'src/tools/rankCompare.mjs', [["let k = argNumOf('k', 'posInt', 10)", "let k = 10"]], ['unit-cliValues']],
    ['IN53', 'src/tools/roundDigest.mjs', [["if (argRound !== undefined && !R && !dream && !docs.some((d) => d.round === round)) {", "if (false) {"]], ['unit-cliValues']], //不存在之輪次印空摘要
    ['IN54', 'src/tools/roundDigest.mjs', [["let round = argRound !== undefined ? rsiNumOf(argRound, 'posInt') :", "let round = argRound !== undefined ? 1 :"]], ['unit-cliValues']],
    ['IN55', 'src/tools/dreamProfile.mjs', [["if (arg !== undefined && !rounds.includes(round)) {", "if (false) {"]], ['unit-cliValues']],
    ['IN56', 'src/tools/scanCheck.mjs', [["if (only && only.some((p) => !docs.some((d) => String(d.nodeId).startsWith(p)))) {", "if (only && only.every((p) => !docs.some((d) => String(d.nodeId).startsWith(p)))) {"]], ['unit-cliValues']], //只有全部未命中才拒
    ['IN57', 'src/tools/scanCheck.mjs', [["if (only && only.some((p) => !docs.some((d) => String(d.nodeId).startsWith(p)))) {", "if (false) {"]], ['unit-cliValues']],
    ['IN58', 'src/tools/armInactive.mjs', [["let key = argStrOf('node', null)", "let key = argOf('node', null)"]], ['unit-cliValues']],
    ['IN59', 'src/tools/armInactive.mjs', [["let why = argStrOf('why', null)", "let why = argOf('why', null)"]], ['unit-cliValues']],
    ['IN60', 'src/tools/armDecide.mjs', [["let id = argStrOf('id', null)", "let id = argOf('id', null)"]], ['unit-cliValues']],
    ['IN61', 'src/tools/armDecide.mjs', [["selectable: selArg === null ? undefined : selArg.trim() === 'true',", "selectable: selArg === null ? undefined : !(selArg === false || selArg === 'false'),"]], ['unit-cliValues']], //原式
    ['IN62', 'src/tools/exposure.mjs', [["let why = argStrOf('why', null)", "let why = argOf('why', null)"]], ['unit-cliValues']],
    //  保留期之門、日誌名、ARSI_ROOT
    ['IN63', 'src/cli/build.mjs', [["(ho !== undefined && ho !== null && !isLocalTimeStr(ho) ? 'periods.holdoutFrom' : null)", "(false ? 'periods.holdoutFrom' : null)"]], ['unit-inputGates']],
    ['IN64', 'src/cli/build.mjs', [["let bad = !isLocalTimeStr(endTime) ?", "let bad = false ?"]], ['unit-inputGates']],
    ['IN65', 'src/cli/build.mjs', [["ho !== undefined && ho !== null && !isLocalTimeStr(ho)", "ho !== undefined && ho !== null && typeof ho !== 'string'"]], ['unit-inputGates']], //只核對型別
    ['IN66', 'src/cli/launch.mjs', [["/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)", "/^[A-Za-z0-9._-]{1,64}$/.test(name)"]], ['unit-inputGates']],
    ['IN67', 'src/cli/launch.mjs', [[" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)", ""]], ['unit-inputGates']],
    ['IN68', 'src/cli/launch.mjs', [["if (!(fs.existsSync(FD_ROOT) && fs.statSync(FD_ROOT).isDirectory())) {", "if (false) {"]], ['unit-inputGates']],
    //  禁區字樣之來源(verify.mjs)、rankBy、backtest 之布林與節
    ['IN70', 'src/domain/verify.mjs', [["    if (!Array.isArray(items)) {\n        throw badInput(where, 'an array of { pattern, label }')", "    if (false) {\n        throw badInput(where, 'an array of { pattern, label }')"]], ['unit-inputGates']],
    ['IN71', 'src/domain/verify.mjs', [["typeof x.label === 'string' && x.label.trim() !== '' &&", "typeof x.label === 'string' &&"]], ['unit-inputGates']],
    ['IN72', 'src/domain/verify.mjs', [["(x.pattern instanceof RegExp || (typeof x.pattern === 'string' && x.pattern !== ''))", "true"]], ['unit-inputGates']],
    ['IN73', 'src/domain/verify.mjs', [["            catch (err) {\n                ok = false\n            }", "            catch (err) {\n                ok = true\n            }"]], ['unit-inputGates']],
    ['IN74', 'src/domain/verify.mjs', [["let ok = isPlain(x) && typeof x.label", "let ok = typeof x.label"]], ['unit-inputGates']],
    ['IN75', 'src/domain/verify.mjs', [["if (srcLib !== undefined && srcLib !== null && (typeof srcLib !== 'string' || srcLib === '')) {", "if (false) {"]], ['unit-inputGates']],
    ['IN76', 'src/domain/verify.mjs', [["if (gd !== undefined && gd !== null && !isPlain(gd)) {", "if (false) {"]], ['unit-inputGates']],
    ['IN77', 'src/domain/verify.mjs', [["    let next = extraItemsOf(items, 'items')", "    GUARD_EXTRA = []\n    let next = extraItemsOf(items, 'items')"]], ['unit-inputGates']], //無效時先清空
    ['IN78', 'src/domain/verify.mjs', [["else if (!Number.isSafeInteger(attempt) || attempt < 1) {", "else if (false) {"]], ['unit-inputGates']],
    ['IN79', 'src/domain/verify.mjs', [["    strReq(privateRoot, 'opt.privateRoot')\n", ""]], ['unit-inputGates']],
    ['IN80', 'src/domain/verify.mjs', [["    strReq(workDir, 'opt.workDir')\n", ""]], ['unit-inputGates']],
    ['IN81', 'src/domain/verify.mjs', [["let o = objReq(opt, 'opt')\n    let { workDir, attempt,", "let o = opt || {}\n    let { workDir, attempt,"]], ['unit-inputGates']],
    ['IN82', 'src/domain/domain.mjs', [["if (rankByRaw !== undefined && rankByRaw !== null && rankByRaw !== 'content' && rankByRaw !== 'key') {", "if (false) {"]], ['unit-inputGates']],
    ['IN83', 'src/domain/domain.mjs', [["let msg = configMsgOf(err) || inputMsgOf(err)", "let msg = configMsgOf(err)"]], ['unit-inputGates']],
    ['IN84', 'src/domain/backtestCfg.mjs', [["let enabled = boolOpt(b.enabled, true, 'backtest.enabled')", "let enabled = b.enabled !== false"]], ['unit-inputGates']],
    ['IN85', 'src/domain/backtestCfg.mjs', [["let gradeEnabled = boolOpt(gr.enabled, true, 'backtest.grade.enabled')", "let gradeEnabled = !(gr.enabled === false)"]], ['unit-inputGates']],
    ['IN86', 'src/domain/backtestCfg.mjs', [["let matchSides = boolOpt(gr.matchSides, true, 'backtest.grade.matchSides')", "let matchSides = gr.matchSides === undefined ? true : gr.matchSides"]], ['unit-inputGates']],
    ['IN87', 'src/domain/backtestCfg.mjs', [["let rl = objSect(b.rule, 'backtest.rule')", "let rl = b.rule || {}"]], ['unit-inputGates']],
    ['IN88', 'src/domain/backtestCfg.mjs', [["let gr = objSect(b.grade, 'backtest.grade')", "let gr = b.grade || {}"]], ['unit-inputGates']],
    ['IN89', 'src/domain/backtestCfg.mjs', [["    if (!isPlain(b)) {\n        throw badInput('backtest', 'an object')", "    if (false) {\n        throw badInput('backtest', 'an object')"]], ['unit-inputGates']],
    ['IN90', 'src/domain/backtestCfg.mjs', [["let privateRootArg = pathOf(b.privateRoot, 'backtest.privateRoot')", "let privateRootArg = b.privateRoot"]], ['unit-inputGates']],
    ['IN91', 'src/domain/backtestCfg.mjs', [["let ledgerDirArg = pathOf(b.ledgerDir, 'backtest.ledgerDir')", "let ledgerDirArg = b.ledgerDir"]], ['unit-inputGates']],
    ['IN92', 'src/domain/backtestCfg.mjs', [["let resultDirArg = pathOf(b.resultDir, 'backtest.resultDir')", "let resultDirArg = b.resultDir"]], ['unit-inputGates']],
    //  共用工具區、初始化、臂目錄
    ['IN93', 'src/arsi/toolbox.mjs', [["let maxFileBytes = numReq(o.maxFileBytes, 200 * 1024, 'opt.maxFileBytes', 'posInt')", "let maxFileBytes = o.maxFileBytes === undefined || o.maxFileBytes === null ? 200 * 1024 : o.maxFileBytes"]], ['unit-inputGates']],
    ['IN94', 'src/arsi/toolbox.mjs', [["let maxFiles = numReq(o.maxFiles, 200, 'opt.maxFiles', 'posInt')", "let maxFiles = o.maxFiles === undefined || o.maxFiles === null ? 200 : o.maxFiles"]], ['unit-inputGates']],
    ['IN95', 'src/arsi/toolbox.mjs', [["let checkFile = fnOpt(o.checkFile, 'opt.checkFile')", "let checkFile = typeof o.checkFile === 'function' ? o.checkFile : null"]], ['unit-inputGates']],
    ['IN96', 'src/arsi/toolbox.mjs', [["let checkIndex = fnOpt(o.checkIndex, 'opt.checkIndex')", "let checkIndex = typeof o.checkIndex === 'function' ? o.checkIndex : null"]], ['unit-inputGates']],
    ['IN97', 'src/arsi/toolbox.mjs', [["let codeOf = fnOpt(o.codeOf, 'opt.codeOf')", "let codeOf = typeof o.codeOf === 'function' ? o.codeOf : null"]], ['unit-inputGates']],
    ['IN98', 'src/arsi/toolbox.mjs', [["if (!Array.isArray(exts) || !exts.every((x) => typeof x === 'string')) {", "if (!Array.isArray(exts)) {"]], ['unit-inputGates']],
    ['IN99', 'src/arsi/toolbox.mjs', [["if (/[\\\\/]/.test(indexFile) || indexFile === '.' || indexFile === '..') {", "if (false) {"]], ['unit-inputGates']],
    ['IN100', 'src/arsi/toolbox.mjs', [["let dir = strReq(o.dir, 'opt.dir')", "let dir = o.dir"]], ['unit-inputGates']],
    ['IN101', 'src/arsi/toolbox.mjs', [["let o = objReq(opt, 'opt')", "let o = opt || {}"]], ['unit-inputGates']],
    ['IN102', 'src/arsi/toolbox.mjs', [["let baselineFile = strOpt(o.baselineFile, null, 'opt.baselineFile')", "let baselineFile = o.baselineFile || null"]], ['unit-inputGates']],
    ['IN103', 'src/tools/initProject.mjs', [["let dry = boolOpt(o.dry, false, 'opt.dry')", "let dry = o.dry === true"]], ['unit-inputGates']],
    ['IN104', 'src/tools/initProject.mjs', [["let force = boolOpt(o.force, false, 'opt.force')", "let force = o.force === true"]], ['unit-inputGates']],
    ['IN105', 'src/tools/initProject.mjs', [["let root = strOpt(o.root, null, 'opt.root')", "let root = o.root || null"]], ['unit-inputGates']],
    ['IN106', 'src/tools/initProject.mjs', [["let o = optOf(opt)\n    let root", "let o = opt || {}\n    let root"]], ['unit-inputGates']],
    ['IN107', 'src/domain/armCatalog.mjs', [["if (o[k] !== undefined && o[k] !== null && o[k] !== true && o[k] !== false) {", "if (false) {"]], ['unit-inputGates']],
    ['IN108', 'src/domain/armCatalog.mjs', [["    if (!isPlain(o)) {\n        return { error: 'invalid opt: must be an object' }", "    if (false) {\n        return { error: 'invalid opt: must be an object' }"]], ['unit-inputGates']],
    ['IN109', 'src/domain/armCatalog.mjs', [["if (typeof o.id !== 'string' || !ARM_ID.test(o.id)) {", "if (false) {"]], ['unit-inputGates']],
    ['IN110', 'src/domain/armCatalog.mjs', [["let selectable = boolOpt(o.selectable, false, 'opt.selectable')", "let selectable = o.selectable"]], ['unit-inputGates']],
    ['IN111', 'src/domain/armCatalog.mjs', [["patch.realize = realizeOf(cur.id, o.selectable)", "patch.realize = realizeOf(cur.id, !o.selectable)"]], ['unit-inputGates']],
    ['IN112', 'src/domain/armCatalog.mjs', [["let o = objReq(opt, 'opt')\n    if (typeof o.id", "let o = opt || {}\n    if (typeof o.id"]], ['unit-inputGates']],
    //  聚合入口之 opt 與必給件(runner、proc、archiveDocs、dispatchers、resources、records、arsi)
    ['IN113', 'src/arsi/runner.mjs', [["let rounds = numReq(o.rounds, 1, 'opt.rounds', 'nonNegInt')", "let rounds = numReq(o.rounds, 1, 'opt.rounds', 'posInt')"]], ['unit-inputOpt']],
    ['IN114', 'src/arsi/runner.mjs', [["let rounds = numReq(o.rounds, 1, 'opt.rounds', 'nonNegInt')", "let rounds = numReq(o.rounds, 0, 'opt.rounds', 'nonNegInt')"]], ['unit-inputOpt']],
    ['IN115', 'src/arsi/runner.mjs', [["let shouldStop = fnOpt(o.shouldStop, 'opt.shouldStop') || (() => null)", "let shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : () => null"]], ['unit-inputOpt']],
    ['IN116', 'src/arsi/runner.mjs', [["let runRound = fnReq(o.runRound, 'opt.runRound')", "let runRound = o.runRound"]], ['unit-inputOpt']],
    ['IN117', 'src/arsi/runner.mjs', [["    let o = optOf(opt)\n    let runRound", "    let o = opt || {}\n    let runRound"]], ['unit-inputOpt']],
    ['IN118', 'src/arsi/runner.mjs', [["let cfgO = cfg !== null && typeof cfg === 'object' ? cfg : {}", "let cfgO = cfg"]], ['unit-inputOpt']],
    ['IN119', 'src/arsi/runner.mjs', [["let cliO = cli !== null && typeof cli === 'object' ? cli : {}", "let cliO = cli"]], ['unit-inputOpt']],
    ['IN120', 'src/arsi/runner.mjs', [["    strReq(fpLock, 'fpLock')\n    let o = optOf(opt)\n    let staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : 6 * 3600000\n    let isSame = typeof o.isSameProgram === 'function' ? o.isSameProgram : (name) => name === null || /^node/.test(name)\n    let me", "    let o = optOf(opt)\n    let staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : 6 * 3600000\n    let isSame = typeof o.isSameProgram === 'function' ? o.isSameProgram : (name) => name === null || /^node/.test(name)\n    let me"]], ['unit-inputOpt']], //acquireRunLock 不核對 fpLock
    ['IN121', 'src/arsi/runner.mjs', [["    strReq(fpLock, 'fpLock')\n    let o = optOf(opt)\n    let staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : 6 * 3600000\n    let isSame = typeof o.isSameProgram === 'function' ? o.isSameProgram : (name) => name === null || /^node/.test(name)\n    let j = null", "    let o = optOf(opt)\n    let staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : 6 * 3600000\n    let isSame = typeof o.isSameProgram === 'function' ? o.isSameProgram : (name) => name === null || /^node/.test(name)\n    let j = null"]], ['unit-inputOpt']], //peekRunLock 不核對 fpLock
    ['IN122', 'src/arsi/runner.mjs', [["    let o = optOf(opt)\n    let staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : 6 * 3600000\n    let isSame = typeof o.isSameProgram === 'function' ? o.isSameProgram : (name) => name === null || /^node/.test(name)\n    let me", "    let o = opt || {}\n    let staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : 6 * 3600000\n    let isSame = typeof o.isSameProgram === 'function' ? o.isSameProgram : (name) => name === null || /^node/.test(name)\n    let me"]], ['unit-inputOpt']], //acquireRunLock 之 opt 不核對
    ['IN123', 'src/arsi/runner.mjs', [["if (typeof fpEvents !== 'string' || fpEvents === '' || !isPlain(obj)) {", "if (typeof fpEvents !== 'string' || fpEvents === '') {"]], ['unit-inputOpt']],
    //IN124 為等價變異: 無效之 fpEvents(非字串、空字串)於其後 try 內之 `path.dirname` / `fs.appendFileSync` 即拋而被 catch 吞掉 ⇒ 同回 false、同不寫檔; 前置之檢查只是把「不嘗試」寫明(測試之斷言不分辨)
    ['IN124', 'src/arsi/runner.mjs', [["if (typeof fpEvents !== 'string' || fpEvents === '' || !isPlain(obj)) {", "if (!isPlain(obj)) {"]], ['unit-inputOpt'], 'equiv'],
    ['IN125', 'src/arsi/runner.mjs', [["    strReq(fpEvents, 'fpEvents')\n", ""]], ['unit-inputOpt']],
    ['IN126', 'src/arsi/runner.mjs', [["                if (isPlain(e)) {\n                    out.push(e)\n                }", "                out.push(e)"]], ['unit-inputOpt']],
    ['IN127', 'src/arsi/runner.mjs', [["    if (!Array.isArray(events)) {\n        throw new Error('invalid events", "    if (false) {\n        throw new Error('invalid events"]], ['unit-inputOpt']],
    ['IN128', 'src/arsi/runner.mjs', [["        if (!isPlain(e)) {\n            continue\n        }\n", ""]], ['unit-inputOpt']],
    ['IN129', 'src/domain/proc.mjs', [["Array.isArray(args) && args.length > 0 && args.every((a) => typeof a === 'string')", "Array.isArray(args) && args.length > 0"]], ['unit-inputOpt']],
    ['IN130', 'src/domain/proc.mjs', [["let RUN_NODE_PROC_TIMEOUT_MS = 900000", "let RUN_NODE_PROC_TIMEOUT_MS = 600000"]], ['unit-inputOpt']],
    ['IN131', 'src/domain/proc.mjs', [["numOrDef(o.timeoutMs, 'timerMs', RUN_NODE_PROC_TIMEOUT_MS)", "numOrDef(o.timeoutMs, 'posNum', RUN_NODE_PROC_TIMEOUT_MS)"]], ['unit-inputOpt']],
    ['IN132', 'src/domain/proc.mjs', [["if (o.cwd !== undefined && o.cwd !== null && (typeof o.cwd !== 'string' || o.cwd === '')) {", "if (false) {"]], ['unit-inputOpt']],
    ['IN133', 'src/domain/proc.mjs', [["if (o.env !== undefined && o.env !== null && !isPlain(o.env)) {", "if (false) {"]], ['unit-inputOpt']],
    ['IN134', 'src/domain/proc.mjs', [["if (opt !== undefined && opt !== null && !isPlain(opt)) {", "if (false) {"]], ['unit-inputOpt']],
    ['IN135', 'src/domain/proc.mjs', [["        if (trace) {\n            trace('error', { message: error })\n        }\n        resolve({ code: null, out: '', timeout: false, error })", "        resolve({ code: null, out: '', timeout: false, error })"]], ['unit-inputOpt']],
    ['IN136', 'src/domain/archiveDocs.mjs', [["let maxBytes = numOrDef(maxBytes0, 'posInt', 30000)\n    let keepBytes", "let maxBytes = maxBytes0 === undefined ? 30000 : maxBytes0\n    let keepBytes"]], ['unit-inputOpt']],
    ['IN137', 'src/domain/archiveDocs.mjs', [["let maxBytes = numOrDef(maxBytes0, 'posInt', 30000)\n    let keepRows", "let maxBytes = maxBytes0 === undefined ? 30000 : maxBytes0\n    let keepRows"]], ['unit-inputOpt']],
    ['IN138', 'src/domain/archiveDocs.mjs', [["numOrDef(keepSections0, 'nonNegInt', 2)", "numOrDef(keepSections0, 'nonNegInt', 1)"]], ['unit-inputOpt']],
    ['IN139', 'src/domain/archiveDocs.mjs', [["numOrDef(keepRows0, 'nonNegInt', 14)", "numOrDef(keepRows0, 'nonNegInt', 13)"]], ['unit-inputOpt']],
    ['IN140', 'src/domain/archiveDocs.mjs', [["let dateOf = (v) => (v instanceof Date && Number.isFinite(v.getTime()) ? v : new Date())", "let dateOf = (v) => (v instanceof Date ? v : new Date())"]], ['unit-inputOpt']],
    ['IN141', 'src/domain/archiveDocs.mjs', [["let fp = strReq(fp0, 'opt.fp')\n    let maxBytes = numOrDef(maxBytes0, 'posInt', 30000)\n    let keepBytes", "let fp = fp0\n    let maxBytes = numOrDef(maxBytes0, 'posInt', 30000)\n    let keepBytes"]], ['unit-inputOpt']],
    ['IN142', 'src/domain/archiveDocs.mjs', [["numOrDef(keepBytes0, 'nonNegInt', 18000)", "numOrDef(keepBytes0, 'nonNegInt', 17000)"]], ['unit-inputOpt']],
    ['IN143', 'src/arsi/inputs.mjs', [["let kindOk = (k) => k === undefined || k === null || k === 'opencode' || k === 'claude'", "let kindOk = () => true"]], ['unit-inputOpt']],
    ['IN144', 'src/arsi/inputs.mjs', [["if (!Array.isArray(cfg.fallback) || !cfg.fallback.every((x) => isPlain(x))) {", "if (false) {"]], ['unit-inputOpt']],
    ['IN145', 'src/arsi/inputs.mjs', [[" && cfg.fallback !== null && cfg.fallback !== false) {", " && cfg.fallback !== null) {"]], ['unit-inputOpt']], //fallback: false 亦檢
    ['IN146', 'src/arsi/inputs.mjs', [["        if (!cfg) {\n            continue\n        }", "        if (cfg === undefined) {\n            continue\n        }"]], ['unit-inputOpt']], //假值之角色亦檢
    ['IN147', 'src/arsi/dispatchers.mjs', [["let probe = boolOpt(o.probe, false, 'opt.probe')", "let probe = o.probe"]], ['unit-inputOpt']],
    ['IN148', 'src/arsi/dispatchers.mjs', [["numOr(o.probeTimeoutMs, 'timerMs', 60000)", "numOr(o.probeTimeoutMs, 'timerMs', 60001)"]], ['unit-inputOpt']],
    ['IN149', 'src/arsi/dispatchers.mjs', [["if (!isPlain(o) || typeof o.prompt !== 'string' || typeof o.logFile !== 'string' || o.logFile === '') {", "if (false) {"]], ['unit-inputOpt']],
    ['IN150', 'src/arsi/dispatchers.mjs', [["let cwd = strOpt(ov.cwd, undefined, 'opt.cwd')", "let cwd = ov.cwd"]], ['unit-inputOpt']],
    ['IN151', 'src/arsi/dispatchers.mjs', [["let skillsRoot = inject.wda ? ov.skillsRoot : strReq(ov.skillsRoot, 'opt.skillsRoot')", "let skillsRoot = ov.skillsRoot"]], ['unit-inputOpt']],
    //IN152 為等價變異: 其後之 `agentsCheck(agents)` 之首行即 `objReq(agents, 'opt.agents')`(同一訊息); 兩處重複之核對 —— makeDispatch 之 opt.agents 之訊息由 agentsCheck 產生(checkQuota 亦同)
    ['IN152', 'src/arsi/dispatchers.mjs', [["let agents = objReq(ov.agents, 'opt.agents')", "let agents = ov.agents"]], ['unit-inputOpt'], 'equiv'],
    ['IN153', 'src/arsi/dispatchers.mjs', [["    let o = objReq(opt, 'opt')\n    let agents = objReq(o.agents, 'opt.agents')\n    let inject = o.inject === undefined || o.inject === null ? {} : objReq(o.inject, 'opt.inject')\n    let skillsRoot = inject.wda ? o.skillsRoot", "    let o = opt || {}\n    let agents = objReq(o.agents, 'opt.agents')\n    let inject = o.inject === undefined || o.inject === null ? {} : objReq(o.inject, 'opt.inject')\n    let skillsRoot = inject.wda ? o.skillsRoot"]], ['unit-inputOpt']], //checkQuota 之 opt 不核對
    ['IN154', 'src/arsi/resources.mjs', [["let opt = optOf(opt0)", "let opt = opt0 || {}"]], ['unit-inputOpt']],
    ['IN155', 'src/arsi/records.mjs', [["let nodeDir = strReq(o.nodeDir, 'opt.nodeDir')", "let nodeDir = o.nodeDir"]], ['unit-inputOpt']],
    ['IN156', 'src/arsi/records.mjs', [["let dreamDir = strReq(o.dreamDir, 'opt.dreamDir')", "let dreamDir = o.dreamDir"]], ['unit-inputOpt']],
    ['IN157', 'src/arsi/records.mjs', [["let trashDir = strOpt(o.trashDir, undefined, 'opt.trashDir')", "let trashDir = o.trashDir"]], ['unit-inputOpt']],
    ['IN158', 'src/arsi/records.mjs', [["let o = objReq(opt, 'opt')\n    let nodeDir", "let o = opt || {}\n    let nodeDir"]], ['unit-inputOpt']],
    ['IN159', 'src/arsi/arsi.mjs', [["let gate = fnOpt(o.gate, 'opt.gate')", "let gate = typeof o.gate === 'function' ? o.gate : null"]], ['unit-inputOpt']],
    ['IN160', 'src/arsi/arsi.mjs', [["        fnReq(texts[k], `opt.texts.${k}`)\n", ""]], ['unit-inputOpt']],
    ['IN161', 'src/arsi/arsi.mjs', [["let dispatch = fnReq(o.dispatch, 'opt.dispatch')", "let dispatch = o.dispatch"]], ['unit-inputOpt']],
    ['IN162', 'src/arsi/arsi.mjs', [["let workDir = strReq(o.workDir, 'opt.workDir')", "let workDir = o.workDir"]], ['unit-inputOpt']],
    ['IN163', 'src/arsi/arsi.mjs', [["let records = objAnyReq(o.records, 'opt.records')", "let records = o.records"]], ['unit-inputOpt']],
    ['IN164', 'src/arsi/arsi.mjs', [["let records = objAnyReq(o.records, 'opt.records')", "let records = objReq(o.records, 'opt.records')"]], ['unit-inputOpt']], //注入之元件不收類別實例
    ['IN165', 'src/arsi/arsi.mjs', [["    let o = objReq(opt, 'opt')\n    //注入", "    let o = opt || {}\n    //注入"]], ['unit-inputOpt']],
    ['IN166', 'src/arsi/arsi.mjs', [[": objAnyReq(o.hooks, 'opt.hooks')", ": o.hooks"]], ['unit-inputOpt']],
    //  settings.agents 未給 ⇒ {}; 給了而不合 ⇒ 組裝時以 settings.agents 命名之固定訊息
    ['IN167', 'src/domain/domain.mjs', [["makeDispatch({ agents: st.agents || {}, skillsRoot:", "makeDispatch({ agents: st.agents, skillsRoot:"]], ['unit-inputGates']],
    ['IN168', 'src/domain/domain.mjs', [["        agentsCheck(st.agents, 'settings.agents')\n    }\n    let dispatch", "        void 0\n    }\n    let dispatch"]], ['unit-inputGates']],
    ['IN169', 'src/cli/rsi.mjs', [["let quotaArgs = () => ({ agents: st.agents || {}, skillsRoot:", "let quotaArgs = () => ({ agents: st.agents, skillsRoot:"]], ['unit-cliValues']],
    ['IN170', 'src/tools/quota.mjs', [["checkQuota({ agents: st.agents || {}, skillsRoot:", "checkQuota({ agents: st.agents, skillsRoot:"]], ['unit-cliValues']],
    //── 排程第 606、611、545、564 項(tadm5; 1.0.48): settingsOrExit(SO)、範圍外輸入值回顯之改寫(EC)、settings.resources(RC)、settings.score(SG)、--seed / --tie-salt(SZ)、補算之停止檔(FQ)、一致性核對之進場數之來源(NT) ──
    ['SO01', 'src/cfg.mjs', [["console.log(msg !== null ? `ERROR ${msg}` :", 'console.log(false ? `ERROR ${msg}` :']], ['unit-settingsOrExit']], //設定之節 / 路徑欄不合者亦印「無法讀取專案設定」(不指出何者不合)
    ['SO02', 'src/cfg.mjs', [["console.log(msg !== null ? `ERROR ${msg}` :", 'console.log(msg !== null ? msg :']], ['unit-settingsOrExit']], //不合之訊息無 ERROR 起首
    ['SO03', 'src/cfg.mjs', [['|settings[.:]|backtest:)/.test(msg)', '|backtest:)/.test(msg)']], ['unit-settingsOrExit']], //inputMsgOf 不認 invalid settings.…
    ['EC01', 'src/domain/armCatalog.mjs', [['<流水號>_<英數名>(現有層:', '<流水號>_<英數名>(收到 ${armId};現有層:']], ['unit-inputEcho']], //--arm-id 之訊息帶輸入之臂代號
    ['EC02', 'src/tools/armInactive.mjs', [['console.error(`節點前綴符合 ${hits.length} 個(須恰為 1 個)`)', 'console.error(`節點 ${key}: 符合 ${hits.length} 個(須恰為 1 個)`)']], ['unit-inputEcho']], //armInactive 之訊息帶輸入之前綴
    ['EC03', 'src/tools/exposure.mjs', [['console.error(`節點前綴符合 ${hits.length} 個(須恰為 1 個)`)', 'console.error(`節點 ${key}: 符合 ${hits.length} 個(須恰為 1 個)`)']], ['unit-inputEcho']], //exposure 之訊息帶輸入之前綴
    ['EC04', 'src/tools/replayCheck.mjs', [['console.log(`第 ${ip + 1} 個前綴: 找不到此節點之工作夾`)', 'console.log(`${pre}: 找不到此節點之工作夾`)']], ['unit-inputEcho']], //replayCheck 之訊息帶輸入之前綴
    ['EC05', 'src/tools/replayCheck.mjs', [['console.log(`第 ${ip + 1} 個前綴:', 'console.log(`第 ${ip} 個前綴:']], ['unit-inputEcho']], //序號自 0 起
    ['EC06', 'src/cli/build.mjs', [["console.log('ERROR 帳本終點已進入保留期;不建')", 'console.log(`ERROR 帳本終點 ${endTime} 已進入保留期;不建`)']], ['unit-inputGates']], //g_build 之訊息帶時間
    ['EC07', 'src/cli/rsi.mjs', [["console.log('--only 未命中任何已執行之節點;未執行')", "console.log(`--only 未命中任何已執行之節點(${list.join(', ')});未執行`)"]], ['unit-fillCli']], //--only 之訊息帶輸入之前綴
    ['RC01', 'src/arsi/rsiNums.mjs', [['waitSec: [\'a non-negative number of seconds that is at most 2147483\', (x) => x >= 0 &&', 'waitSec: [\'a non-negative number of seconds that is at most 2147483\', (x) => x > 0 &&']], ['unit-resourceCfg']], //evalMaxWaitSec 之 0 無效
    ['RC02', 'src/arsi/rsiNums.mjs', [['(x) => x >= 0 && x * 60000 <= 2147483647]', '(x) => x > 0 && x * 60000 <= 2147483647]']], ['unit-resourceCfg']], //maxWaitMin 之 0 無效
    ['RC03', 'src/arsi/rsiNums.mjs', [['waitSec: [\'a non-negative number of seconds that is at most 2147483\', (x) => x >= 0 && x * 1000 <= 2147483647]', 'waitSec: [\'a non-negative number of seconds that is at most 2147483\', (x) => x >= 0 && x * 1000 < 2147483647]']], ['unit-resourceCfg']], //秒之上限 < 取代 ≤(2147483.647 無效)
    ['RC04', 'src/arsi/rsiNums.mjs', [['let EVAL_GATE_CPU_MARGIN = 5', 'let EVAL_GATE_CPU_MARGIN = 15']], ['unit-resourceCfg']], //評估層之 cpuStart 預設 = cpuMax − 15
    ['RC05', 'src/arsi/rsiNums.mjs', [['let EVAL_GATE_WAIT_SEC = 90', 'let EVAL_GATE_WAIT_SEC = 60']], ['unit-resourceCfg']], //評估層之最長等待預設 60
    ['RC06', 'src/arsi/rsiNums.mjs', [['out.maxWaitMin === null ? null : out.maxWaitMin * 60', 'out.maxWaitMin === null ? null : out.maxWaitMin * 6']], ['unit-resourceCfg']], //maxWaitMin 換成秒之因子
    ['RC07', 'src/arsi/rsiNums.mjs', [['maxWaitSec: out.evalMaxWaitSec !== null ? out.evalMaxWaitSec : EVAL_GATE_WAIT_SEC', 'maxWaitSec: EVAL_GATE_WAIT_SEC']], ['unit-resourceCfg']], //evalMaxWaitSec 不採
    ['RC08', 'src/arsi/rsiNums.mjs', [['cpuStart: out.evalCpuStart !== null ? out.evalCpuStart : (', 'cpuStart: false ? out.evalCpuStart : (']], ['unit-resourceCfg']], //evalCpuStart 不採
    ['RC09', 'src/arsi/rsiNums.mjs', [['Math.max(1, out.cpuMax - EVAL_GATE_CPU_MARGIN)', 'Math.max(0, out.cpuMax - EVAL_GATE_CPU_MARGIN)']], ['unit-resourceCfg']], //cpuMax − 5 之下限 0
    ['RC10', 'src/domain/domain.mjs', [['createResourceMonitor({ ...resourceCfgOf(st.resources).loopGate, log })', 'createResourceMonitor({ ...resourceCfgOf(st.resources).evalGate, log })']], ['unit-resourceCfg']], //迴圈取評估層之閘
    ['RC11', 'src/tools/initProject.mjs', [['wait: resourceCfgOf(rs).evalGate.maxWaitSec,', 'wait: 90,']], ['unit-resourceCfg']], //合約之等待不採設定
    ['RC12', 'src/arsi/resources.mjs', [["let cpuMax = rsiNumOf(opt.cpuMax, 'num')", "let cpuMax = typeof opt.cpuMax === 'number' && Number.isFinite(opt.cpuMax) ? opt.cpuMax : null"]], ['unit-resourceCfg']], //資源閘之 opt 不收數字字串
    ['RC13', 'src/arsi/resources.mjs', [["let maxWaitSec0 = rsiNumOf(opt.maxWaitSec, 'waitSec')", "let maxWaitSec0 = rsiNumOf(opt.maxWaitSec, 'timerSec')"]], ['unit-resourceCfg']], //maxWaitSec 之 0 無效(不等待之寫法失效)
    ['RC14', 'src/cli/eval.mjs', [['let gateCfg = resourceCfgOf(st.resources).evalGate', 'let gateCfg = resourceCfgOf(st.resources).loopGate']], ['unit-resourceCfg']], //評估層取迴圈之閘(無 evalMaxWaitSec ⇒ 等 1800 秒; 實跑逾時失敗)
    ['SG01', 'src/eval/cfgNum.mjs', [["ladder1: { S: [15, 'num'], nullP: [0.05, 'prob'] }", "ladder1: { S: [12, 'num'], nullP: [0.05, 'prob'] }"]], ['unit-scoreCfg']], //S 之預設
    ['SG02', 'src/eval/cfgNum.mjs', [["nullP: [0.05, 'prob']", "nullP: [0.05, 'num']"]], ['unit-scoreCfg']], //nullP 不限 0 ~ 1
    ['SG03', 'src/eval/cfgNum.mjs', [["monthlyOrders: [300, 'nonNegNum']", "monthlyOrders: [300, 'num']"]], ['unit-scoreCfg']], //monthlyOrders 收負數
    ['SG04', 'src/eval/cfgNum.mjs', [['!Array.isArray(fb) || fb.length !== 2', '!Array.isArray(fb) || fb.length < 2']], ['unit-scoreCfg']], //freqBands 收超過兩個
    ['SG05', 'src/eval/cfgNum.mjs', [["            if (x === undefined || x === null) {\n                throw new Error(`invalid ${who}.freqBands[${i}]", "            if (false) {\n                throw new Error(`invalid ${who}.freqBands[${i}]"]], ['unit-scoreCfg']], //freqBands 之 null 元素當 0
    ['SG06', 'src/eval/score.mjs', [['let l1 = S >= sc.ladder1.S &&', 'let l1 = S > sc.ladder1.S &&']], ['unit-scoreCfg']], //S = 門檻不過
    ['SG07', 'src/eval/score.mjs', [['m.null && m.null.p <= sc.ladder1.nullP', 'm.null && m.null.p < sc.ladder1.nullP']], ['unit-scoreCfg']], //p = 門檻不過
    ['SG08', 'src/eval/barGrid.mjs', [["    evalScoreOf(st && st.score, 'score')\n}", '    void 0\n}']], ['unit-scoreCfg']], //預檢不查 score
    ['SG09', 'src/domain/texts.mjs', [["let sc = evalScoreOf(st.score, 'score')", "let sc = st.score || { ladder1: {}, ladder2: {}, ladder3: {} }"]], ['unit-scoreCfg']], //任務書取原值
    ['SG10', 'src/eval/score.mjs', [["let sc = evalScoreOf(score, 'score')", 'let sc = score']], ['unit-scoreCfg']], //判讀取原值(修前)
    ['SG11', 'src/tools/initProject.mjs', [["let sc = evalScoreOf(s.score, 'score')", "let sc = { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 } }"]], ['unit-scoreCfg']], //合約之參考版不採設定
    ['SZ01', 'src/cli/eval.mjs', [["if (seedArg !== null && !(typeof seedArg === 'number' && Number.isSafeInteger(seedArg))) {", "if (seedArg !== null && !(typeof seedArg === 'number' && Number.isInteger(seedArg))) {"]], ['unit-cliEqFlags']], //--seed 之安全整數之界不檢
    ['SZ02', 'src/cli/eval.mjs', [["console.log('invalid --seed: must be an integer')", "console.log('invalid --seed')"]], ['unit-cliEqFlags']], //--seed 之訊息不全
    ['SZ03', 'src/cli/eval.mjs', [["let seedArg = argOf('seed', null)\n", "let seedArg = (settingsOrExit(), argOf('seed', null))\n"]], ['unit-cliEqFlags']], //--seed 之檢查晚於讀設定
    ['SZ04', 'src/cli/eval.mjs', [["let tieArg = argOf('tie-salt', null)\n", "let tieArg = (settingsOrExit(), argOf('tie-salt', null))\n"]], ['unit-cliEqFlags']], //--tie-salt 之檢查晚於讀設定
    ['SZ05', 'src/cli/eval.mjs', [["    if (process.env.ARSI_HARNESS === '1') {\n        seedOverride = seedArg", "    if (true) {\n        seedOverride = seedArg"]], ['unit-cliEqFlags']], //非迴圈亦採用 --seed
    ['SZ06', 'src/cli/eval.mjs', [["    if (process.env.ARSI_HARNESS === '1') {\n        tieSalt = tieArg", "    if (true) {\n        tieSalt = tieArg"]], ['unit-cliEqFlags']], //非迴圈亦採用 --tie-salt
    ['FQ01', 'src/domain/domain.mjs', [['if (stopCheck && stopFileExists(st.rsi.root)) {', 'if (false) {', true]], ['unit-fillStop']], //補算不檢停止檔(等待之前與之後兩處皆不檢)
    ['FQ02', 'src/domain/domain.mjs', [["let stopCheck = src === 'cli'", 'let stopCheck = true']], ['unit-fillStop']], //輪末之附算亦檢停止檔
    ['FQ03', 'src/domain/domain.mjs', [["let stopCheck = src === 'cli'", 'let stopCheck = false']], ['unit-fillStop']], //命令列之補算不檢
    ['FQ04', 'src/domain/domain.mjs', [["                //取下一個成品之前再檢查(資源閘之等待之後、取用之前: 等待期間才建立之停止檔亦擋得住)\n                if (stopCheck && stopFileExists(st.rsi.root)) {\n                    stopHit = true\n                    break\n                }\n", '']], ['unit-fillStop']], //只於資源閘之等待之前檢查(等待期間建立之停止檔擋不住)
    ['FQ13', 'src/domain/domain.mjs', [['            ...(r.stopped ? { stopped: r.stopped, lines: [stopLineOf(r.stopped)] } : {}),\n', '']], ['unit-fillStop']], //extFill 不帶 stopped 與摘要句
    ['FQ14', 'src/domain/domain.mjs', [["                //資源閘之等待之前先檢查(停止檔已存在者不必再等閘)\n                if (stopCheck && stopFileExists(st.rsi.root)) {\n                    stopHit = true\n                    break\n                }\n", '']], ['unit-fillStop']], //只於資源閘之等待之後檢查(停止檔已存在者仍等閘)
    ['FQ15', 'src/cli/rsi.mjs', [["而同承): 開始前已有 ⇒ 本次不補算(stopAtStart); 進行中才建立者 ⇒ 已取者做完、輸出之末列寫「因停止檔提前結束」與已完成 / 未完成數\n    stopAtStart()\n", "而同承): 開始前已有 ⇒ 本次不補算(stopAtStart); 進行中才建立者 ⇒ 已取者做完、輸出之末列寫「因停止檔提前結束」與已完成 / 未完成數\n"]], ['unit-fillStop']], //extfill 開始前不檢停止檔
    ['FQ16', 'src/cli/rsi.mjs', [["    for (let l of (r.lines || [])) {\n        console.log(l)\n    }\n", '']], ['unit-fillStop']], //extfill 不印提前結束之摘要句
    ['FQ17', 'src/domain/domain.mjs', [['本次待算 ${stp.done + stp.rest} 個成品', '本次待算 ${stp.done} 個成品']], ['unit-fillStop']], //摘要句之待算數
    ['EC08', 'src/tools/armDecide.mjs', [["console.error('提案帳無此筆')", 'console.error(`提案帳無此筆: ${id}`)']], ['unit-inputEcho']], //armDecide 之訊息帶提案 id
    ['EC09', 'src/tools/armInactive.mjs', [["console.error(`所給之臂有 ${bad.length} 個不是節點", "console.error(`${bad.join('、')} 不是節點"]], ['unit-inputEcho']], //armInactive 之訊息帶臂名
    ['FQ05', 'src/domain/domain.mjs', [['stopped: { file: rel(stopFileOf(st.rsi.root)), done: next, rest: tasks.length - next }', 'stopped: { file: rel(stopFileOf(st.rsi.root)), done: tasks.length - next, rest: tasks.length - next }']], ['unit-fillStop']], //已完成數取錯
    ['FQ06', 'src/domain/domain.mjs', [['done: next, rest: tasks.length - next }', 'done: next, rest: tasks.length }']], ['unit-fillStop']], //未完成數取錯
    ['FQ07', 'src/domain/domain.mjs', [["        if (stopHit) {\n            out.lines.push(", "        if (false) {\n            out.lines.push("]], ['unit-fillStop']], //摘要不寫「因停止檔提前結束」
    ['FQ08', 'src/domain/domain.mjs', [['...(stopHit ? { stopped:', '...(false ? { stopped:']], ['unit-fillStop']], //回傳不帶 stopped
    ['FQ09', 'src/arsi/runner.mjs', [["let STOP_FILE = 'STOP'", "let STOP_FILE = 'STOP.txt'"]], ['unit-fillStop']], //停止檔之檔名
    ['FQ10', 'src/cli/rsi.mjs', [["    if (stopFileExists(st.rsi.root)) {\n        console.log(`未執行: 停止檔", "    if (false) {\n        console.log(`未執行: 停止檔"]], ['unit-fillCli']], //命令列之補算開始前不檢停止檔
    ['FQ11', 'src/cli/rsi.mjs', [["存在;刪除後再補算`)\n        process.exit(3)", "存在;刪除後再補算`)\n        process.exit(1)"]], ['unit-fillCli']], //開始前有停止檔之離開碼不為 3
    ['FQ12', 'src/cli/rsi.mjs', [["        if (stopFileExists(st.rsi.root)) {\n            why = ['stop-file'", "        if (false) {\n            why = ['stop-file'"]], ['unit-fillCli']], //輪次起跑前不檢停止檔
    ['NT01', 'src/eval/ledgerBuild.mjs', [['let ntFile = s.numTrade === undefined || s.numTrade === null ?', 'let ntFile = s.numTrade === undefined ?']], ['unit-ledgerNumTrade']], //頂層為 null 者不後備
    ['NT02', 'src/eval/ledgerBuild.mjs', [["(s.summary && typeof s.summary.numTrade === 'number' ? s.summary.numTrade : undefined)", '(s.summary && s.summary.numTrade !== undefined ? s.summary.numTrade : undefined)']], ['unit-ledgerNumTrade']], //後備不核對型別
    ['NT03', 'src/eval/ledgerBuild.mjs', [[": (typeof s.numTrade === 'number' ? s.numTrade : undefined)", ': (typeof s.numTrade === \'number\' ? s.numTrade : (s.summary && typeof s.summary.numTrade === \'number\' ? s.summary.numTrade : undefined))']], ['unit-ledgerNumTrade']], //頂層已帶而非數字者亦後備
    ['NT04', 'src/eval/ledgerBuild.mjs', [["let ntFile = s.numTrade === undefined || s.numTrade === null ? (s.summary && typeof s.summary.numTrade === 'number' ? s.summary.numTrade : undefined) : (typeof s.numTrade === 'number' ? s.numTrade : undefined)", "let ntFile = s.summary && typeof s.summary.numTrade === 'number' ? s.summary.numTrade : (typeof s.numTrade === 'number' ? s.numTrade : undefined)"]], ['unit-ledgerNumTrade']], //summary 為先(頂層為後備)
    ['NT05', 'src/eval/ledgerBuild.mjs', [['diffs.push({ f: files[si], ledger: cnt, file: ntFile })', 'diffs.push({ f: files[si], ledger: cnt, file: s.numTrade })']], ['unit-ledgerNumTrade']], //diffs 之 file 仍取頂層
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
//(README.md: unit-verifyZone ⑦c 核對 README 載有節點之禁區之說明〔排程第 580 項 ①〕)
for (let f of ['settings.json', 'package.json', 'README.md']) {
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
