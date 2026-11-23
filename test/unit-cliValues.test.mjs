import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import * as CFG from '../src/cfg.mjs'
import { FD_ROOT, makeTmp } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此匯出時, 本檔仍可載入, 各案以斷言失敗呈現而非整檔載入失敗)
let { cliMsgOf, argNumOf, CLI_VALUES, timeMsOf } = CFG


//命令列旗標與位置引數之「值」之檢測(排程第 607 項; R-EV-54 ②): 跨套件規格〈輸入參數之檢測機制〉K3(規模與輸入之值給了而無效 ⇒ 不靜默退回預設)、K4(檢測之值即使用之值)、K5(布林不與數字互轉)、K7(數字類收數字字串)、§3.7(計時值)、V19(訊息格式)、V20(不回顯輸入值)
//  原: `g_rsi.mjs --nodes 0`、`--rounds abc` 靜默退回設定之值; `roundDigest r003` 靜默改為最近一輪; `waitEvent --timeout-min abc` 之計時器為 NaN ⇒ 永不結束; `armInactive --node <全數字>` 靜默進入列出模式;
//    `armDecide --selectable 0` 取 true; `quota --max abc`、`rankCompare --k abc` 靜默用預設
//  規格之句 ⇒ 案: 「給了而無效 ⇒ 拒收、固定訊息、不回顯、離開碼 2、於讀設定與任何寫入之前」= cliMsgOf 之全值表 + 空專案根實跑; 「檢測之值即使用之值」= argNumOf 與原始碼盤點; 「結構之錯優先」= 次序案
let NODE = process.execPath
let SECRET = 'secret-token-xyz'
let TIME_DESC = 'a time string YYYY-MM-DDTHH:mm:ss (optionally with .SSS and Z or ±hh:mm)'

describe('命令列旗標與位置引數之值之檢測(排程第 607 項)', function () {
    this.timeout(300000)
    let t = makeTmp('cliValues')
    after(() => t.cleanup())

    describe('cliMsgOf(純函數): 規模旗標(--nodes、--arms、--parallel、--workers、--rounds、--par、--round)給了而無效 ⇒ 拒收(與 --null 一致)', () => {
        //依模式取得旗標之合格寫法(模式 × 旗標: --nodes 等屬 dry / round、--par 屬 fill、--round 屬 annotate / dirtype)
        let CASES = [
            [['--mode', 'round'], ['nodes', 'arms', 'parallel', 'workers', 'rounds']],
            [['--mode', 'dry'], ['nodes', 'arms', 'parallel', 'workers', 'rounds']],
            [['--mode', 'fill'], ['par']],
            [['--mode', 'annotate', '--file', 'x.txt'], ['round']],
            [['--mode', 'dirtype', '--file', 'x.json'], ['round']],
        ]
        let BAD = ['0', '2.5', '-1', 'abc', 'true', '0x10', 'Infinity', 'NaN', '1,5', '１２', SECRET]
        let OK = ['1', '3', ' 4 ', '1e1', '5.0', '007']

        it('表: CLI_VALUES.rsi 含全部七個旗標且種類為 posInt; 無此表之舊碼即紅', () => {
            assert(CLI_VALUES && typeof CLI_VALUES === 'object', '有 CLI_VALUES')
            assert.deepEqual(CLI_VALUES.rsi, { nodes: 'posInt', arms: 'posInt', parallel: 'posInt', workers: 'posInt', rounds: 'posInt', par: 'posInt', round: 'posInt' })
        })

        it('無效之值(0、小數、負數、非數字、布林字樣、0x10、±Infinity、NaN、千分位、全形數字)⇒ invalid --<旗標>: must be a positive integer(固定訊息、不回顯輸入值)', () => {
            let n = 0
            for (let [pre, flags] of CASES) {
                for (let f of flags) {
                    for (let v of BAD) {
                        let got = cliMsgOf('rsi', [...pre, `--${f}`, v])
                        assert.strictEqual(got, `invalid --${f}: must be a positive integer`, `${pre[1]} --${f} ${v === SECRET ? '(secret)' : v}`)
                        assert.ok(!got.includes(SECRET), '不回顯')
                        n++
                    }
                }
            }
            assert(n >= 5 * 11, `案數 ${n}`) //鑑別前提
        })

        it('空值與無值 ⇒ 既有之 (a value is required) 訊息(原已拒收); 未給 ⇒ 合格(取設定之值)', () => {
            for (let [pre, flags] of CASES) {
                for (let f of flags) {
                    let m = cliMsgOf('rsi', [...pre, `--${f}`, ''])
                    assert(typeof m === 'string' && m.startsWith(`invalid --${f}: must be written as --${f}`), `${f} 空值: ${m}`)
                    let m2 = cliMsgOf('rsi', [...pre, `--${f}`])
                    assert(typeof m2 === 'string' && m2.startsWith(`invalid --${f}: must be written as --${f}`), `${f} 無值: ${m2}`)
                }
                assert.strictEqual(cliMsgOf('rsi', [...pre]), null, `${pre[1]} 未給`)
            }
        })

        it('有效之值(正整數、其數字字串〔去頭尾空白之十進位寫法、科學記號〕)合格', () => {
            let n = 0
            for (let [pre, flags] of CASES) {
                for (let f of flags) {
                    for (let v of OK) {
                        assert.strictEqual(cliMsgOf('rsi', [...pre, `--${f}`, v]), null, `${pre[1]} --${f} ${v}`)
                        n++
                    }
                }
            }
            assert(n >= 5 * 6, `案數 ${n}`)
        })

        it('次序: 結構之錯(重複、模式 × 旗標)先於值之種類 —— `--mode status --nodes abc` 報模式、`--nodes 1 --nodes abc` 報重複(既有之訊息與次序不變); 多個值皆無效者報命令列次序之第一個', () => {
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'status', '--nodes', 'abc']), 'invalid --nodes: must be used with --mode dry or round')
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'round', '--nodes', '1', '--nodes', 'abc']), 'invalid --nodes: must be given at most once')
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'round', '--rounds', 'x', '--nodes', 'y']), 'invalid --rounds: must be a positive integer')
            assert.strictEqual(cliMsgOf('rsi', ['--mode', 'round', '--nodes', 'x', '--rounds', 'y']), 'invalid --nodes: must be a positive integer')
        })

        it('評估器之進入檔(eval)與 backtest 之數值旗標不在本表(本輪不動評估器): CLI_VALUES 無 eval、backtest 之鍵', () => {
            assert(CLI_VALUES && !('eval' in CLI_VALUES) && !('backtest' in CLI_VALUES) && !('build' in CLI_VALUES), '不含')
            assert.strictEqual(cliMsgOf('eval', ['--pick', 'a.mjs', '--null', 'abc']), null, '--null 之檢測仍在進入檔自己(不動)')
        })
    })

    describe('cliMsgOf(純函數): 工具之旗標之值', () => {
        let M = (tool, argv) => cliMsgOf(tool, argv)

        it('rankCompare --k: 正整數(數字字串轉數值); 0、小數、負數、非數字 ⇒ invalid --k: must be a positive integer(原: 靜默取 10)', () => {
            for (let v of ['0', '2.5', '-1', 'abc', 'true', '0x10', SECRET]) {
                let got = M('rankCompare', ['--k', v])
                assert.strictEqual(got, 'invalid --k: must be a positive integer', `--k ${v}`)
                assert.ok(!got.includes(SECRET), '不回顯')
            }
            for (let v of ['1', '10', ' 7 ', '1e1']) {
                assert.strictEqual(M('rankCompare', ['--k', v]), null, `--k ${v}`)
            }
            assert.strictEqual(M('rankCompare', []), null, '未給')
        })

        it('quota --max: 有限數(可負、可大於 100 = 不以用量守門); abc、Infinity、NaN、0x10、千分位 ⇒ invalid --max: must be a finite number(原: 靜默取設定之值)', () => {
            for (let v of ['abc', 'Infinity', 'NaN', '0x10', '1,5', 'true', SECRET]) {
                let got = M('quota', ['--max', v])
                assert.strictEqual(got, 'invalid --max: must be a finite number', `--max ${v}`)
                assert.ok(!got.includes(SECRET), '不回顯')
            }
            for (let v of ['0', '95', '-5', ' 90 ', '1e2', '150', '99.5']) {
                assert.strictEqual(M('quota', ['--max', v]), null, `--max ${v}`)
            }
        })

        it('waitEvent --timeout-min、--poll-sec: 計時值(§3.7)為正數且換成毫秒不超過 2147483647; 0、負數、超過上限、非數字 ⇒ 拒收(原: NaN ⇒ 永不結束)', () => {
            let tm = 'a positive number of minutes that is at most 35791'
            let ps = 'a positive number of seconds that is at most 2147483'
            for (let v of ['0', '-1', '35792', 'abc', 'Infinity', '0x10', SECRET]) {
                let got = M('waitEvent', ['--timeout-min', v])
                assert.strictEqual(got, `invalid --timeout-min: must be ${tm}`, `--timeout-min ${v}`)
                assert.ok(!got.includes(SECRET), '不回顯')
            }
            for (let v of ['110', '0.5', '35791', ' 30 ', '1e1']) {
                assert.strictEqual(M('waitEvent', ['--timeout-min', v]), null, `--timeout-min ${v}`)
            }
            for (let v of ['0', '-3', '2147484', 'abc', 'NaN', SECRET]) {
                assert.strictEqual(M('waitEvent', ['--poll-sec', v]), `invalid --poll-sec: must be ${ps}`, `--poll-sec ${v}`)
            }
            for (let v of ['20', '0.5', '2147483', ' 3 ']) {
                assert.strictEqual(M('waitEvent', ['--poll-sec', v]), null, `--poll-sec ${v}`)
            }
        })

        it('waitEvent --since: 時間字串(T2: YYYY-MM-DDTHH:mm:ss, 可帶 .SSS、可帶 Z 或 ±hh:mm; 真實存在之時刻); 空格分隔、只有日期、不存在之日期、尾空白、非時間 ⇒ 拒收', () => {
            for (let v of ['2026-11-23 10:00:00', '2026-11-23', '2026-13-45T00:00:00Z', '2026-11-23T10:00:00Z ', 'abc', '1795428000000', SECRET]) {
                let got = M('waitEvent', ['--since', v])
                assert.strictEqual(got, `invalid --since: must be ${TIME_DESC}`, `--since ${v}`)
                assert.ok(!got.includes(SECRET), '不回顯')
            }
            for (let v of ['2026-11-23T10:00:00Z', '2026-11-23T10:00:00', '2026-11-23T10:00:00.123+08:00', '2026-11-23T10:00:00.5Z', new Date().toISOString()]) {
                assert.strictEqual(M('waitEvent', ['--since', v]), null, `--since ${v}`)
            }
            //timeMsOf 為同一單一定義(cliMsgOf 之檢查與 tools/waitEvent.mjs 之取值共用)
            assert.strictEqual(timeMsOf('2026-11-23T10:00:00Z'), Date.parse('2026-11-23T10:00:00Z'))
            assert.strictEqual(timeMsOf('2026-11-23 10:00:00'), null)
            assert.strictEqual(timeMsOf(5), null)
        })

        it('時間字串須為真實存在之時刻(複審 #6): 2026-02-30、2026-04-31、2025-02-29、月 13、T24:00:00、分或秒 60 ⇒ 無效(V8 之 Date.parse 會滾動日期而通過); 閏日 2024-02-29 與 23:59:59 有效; --since 之檢查與取值共用 timeMsOf', () => {
            for (let v of ['2026-02-30T00:00:00', '2026-04-31T00:00:00Z', '2025-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '1900-02-29T00:00:00', '2026-13-01T00:00:00', '2026-00-10T00:00:00', '2026-11-00T00:00:00', '2026-11-23T24:00:00', '2026-11-23T10:60:00', '2026-11-23T10:00:60', '2026-11-23T10:00:00+99:99']) {
                assert.strictEqual(timeMsOf(v), null, `timeMsOf ${v}`)
                assert.strictEqual(M('waitEvent', ['--since', v]), `invalid --since: must be ${TIME_DESC}`, `--since ${v}`)
            }
            //前提(變異 IN29、IN30 為等價之依據): 引擎對分、秒之 60 本身回 NaN, 故 calendarOk 之 mi、s 之上限為重複之防線; 引擎日後改寬時此斷言轉紅而提醒
            assert(Number.isNaN(Date.parse('2026-11-23T10:60:00Z')) && Number.isNaN(Date.parse('2026-11-23T10:00:60Z')), 'Date.parse 對 60 分 / 60 秒回 NaN')
            for (let v of ['2024-02-29T00:00:00Z', '2026-11-23T23:59:59Z', '2000-02-29T00:00:00', '2026-12-31T23:59:59.999+08:00']) {
                assert(Number.isFinite(timeMsOf(v)), `timeMsOf ${v}`)
                assert.strictEqual(M('waitEvent', ['--since', v]), null, `--since ${v}`)
            }
        })

        it('isLocalTimeStr(設定檔 periods 所用之無時區寫法): 真實存在之 YYYY-MM-DDTHH:mm:ss(可帶 .SSS)有效; 帶 Z 或時差、只有日期、空格分隔、不存在之日期、非字串無效', () => {
            let { isLocalTimeStr } = CFG
            assert(typeof isLocalTimeStr === 'function', '有 isLocalTimeStr')
            for (let v of ['2026-08-01T00:00:00', '2026-08-01T00:00:00.5', '2026-08-01T23:59:59.999', '2024-02-29T00:00:00']) {
                assert.strictEqual(isLocalTimeStr(v), true, v)
            }
            for (let v of ['2026-08-01T00:00:00Z', '2026-08-01T00:00:00+08:00', '2026-08-01', '2026-08-01 00:00:00', '2026-02-30T00:00:00', '2026-08-01T24:00:00', '', 5, null, undefined, {}, ' 2026-08-01T00:00:00']) {
                assert.strictEqual(isLocalTimeStr(v), false, String(v))
            }
        })

        it('armDecide --selectable: 只收 true / false(去頭尾空白後比對; K5: 0、1、TRUE、yes 皆非布林); 原: `--selectable 0`、`abc` 皆取 true', () => {
            assert.strictEqual(M('armDecide', ['--id', 'P001', '--accept', '--selectable', ' true ']), null, '去頭尾空白(B2)')
            for (let v of ['0', '1', 'abc', 'TRUE', 'False', 'yes', SECRET]) {
                let got = M('armDecide', ['--id', 'P001', '--accept', '--selectable', v])
                assert.strictEqual(got, 'invalid --selectable: must be one of true, false', `--selectable ${v}`)
                assert.ok(!got.includes(SECRET), '不回顯')
            }
            for (let v of ['true', 'false']) {
                assert.strictEqual(M('armDecide', ['--id', 'P001', '--accept', '--selectable', v]), null, `--selectable ${v}`)
            }
        })
    })

    describe('cliMsgOf(純函數): 工具之位置引數之值', () => {
        let M = (tool, argv) => cliMsgOf(tool, argv)

        it('roundDigest、dreamProfile: 輪次須為正整數(`r003`、`abc`、0、小數、負數 ⇒ invalid round: must be a positive integer; 原: 非數字被忽略而靜默改為最近一輪); `--out` 前後之位置引數亦檢查', () => {
            for (let tool of ['roundDigest', 'dreamProfile']) {
                for (let v of ['r003', 'abc', '0', '-1', '1.5', 'true', SECRET]) {
                    let got = M(tool, [v])
                    assert.strictEqual(got, 'invalid round: must be a positive integer', `${tool} ${v}`)
                    assert.ok(!got.includes(SECRET), '不回顯')
                }
                for (let v of ['1', '3', '003', ' 7 ']) {
                    assert.strictEqual(M(tool, [v]), null, `${tool} ${v}`)
                }
                assert.strictEqual(M(tool, []), null, `${tool} 未給`)
            }
            assert.strictEqual(M('roundDigest', ['--out', 'r3']), 'invalid round: must be a positive integer')
            assert.strictEqual(M('roundDigest', ['--out', '3']), null)
            assert.strictEqual(M('roundDigest', ['3', '--out']), null)
            assert.strictEqual(M('roundDigest', ['r3', '--out']), 'invalid round: must be a positive integer')
        })

        it('scanCheck: 節點 id 前綴(逗號分隔; 各為 1 ~ 64 個英數、底線、連字號); 空段、空白、路徑字樣 ⇒ invalid node: must be a comma-separated list of node id prefixes', () => {
            for (let v of ['a,,b', 'a,', ',a', 'a b', '../x', 'a/b', 'a\\b', 'x'.repeat(65), '']) {
                assert.strictEqual(M('scanCheck', [v]), 'invalid node: must be a comma-separated list of node id prefixes', `scanCheck ${JSON.stringify(v)}`)
            }
            for (let v of ['abcdef', 'a1b2c3,d4e5f6', 'A_b-1', SECRET, 'x'.repeat(64)]) {
                assert.strictEqual(M('scanCheck', [v]), null, `scanCheck ${v}`)
            }
            assert.strictEqual(M('scanCheck', []), null, '未給')
        })

        it('smokeDispatch: node、dream、both、deny 之一(原: abc 派一個不存在之角色)', () => {
            for (let v of ['abc', 'NODE', '1', 'node,dream', SECRET]) {
                let got = M('smokeDispatch', [v])
                assert.strictEqual(got, 'invalid target: must be one of node, dream, both, deny', `smokeDispatch ${v}`)
                assert.ok(!got.includes(SECRET), '不回顯')
            }
            for (let v of ['node', 'dream', 'both', 'deny']) {
                assert.strictEqual(M('smokeDispatch', [v]), null)
            }
        })
    })

    describe('argNumOf(檢測之值即使用之值; K4)與原始碼盤點', () => {
        let withArgv = (argv, fn) => {
            let save = process.argv
            process.argv = [process.execPath, 'x.mjs', ...argv]
            try {
                return fn()
            }
            finally {
                process.argv = save
            }
        }

        it('argNumOf: 數字字串轉為數值後回傳(`--k " 5 "` ⇒ 5、`1e1` ⇒ 10、`007` ⇒ 7); 未給與不合者回 def(不回 NaN、不當 0)', () => {
            assert(typeof argNumOf === 'function', '有 argNumOf')
            assert.strictEqual(withArgv(['--k', ' 5 '], () => argNumOf('k', 'posInt', 10)), 5)
            assert.strictEqual(withArgv(['--k', '1e1'], () => argNumOf('k', 'posInt', 3)), 10)
            assert.strictEqual(withArgv(['--k', '007'], () => argNumOf('k', 'posInt', 3)), 7)
            assert.strictEqual(withArgv([], () => argNumOf('k', 'posInt', 10)), 10)
            assert.strictEqual(withArgv(['--k'], () => argNumOf('k', 'posInt', 10)), 10)
            assert.strictEqual(withArgv(['--k', 'abc'], () => argNumOf('k', 'posInt', 10)), 10)
            assert.strictEqual(withArgv(['--k', '0'], () => argNumOf('k', 'posInt', 10)), 10)
            assert.strictEqual(withArgv(['--max', '-5'], () => argNumOf('max', 'num', 95)), -5)
            assert.strictEqual(withArgv(['--k', '5', '--k', '6'], () => argNumOf('k', 'posInt', 1)), 5, '取第一個(同 argOf)')
        })

        it('原始碼盤點: 各讀取處皆取檢查合格之轉換值 —— rsi 之 cliInt、--par、--round 經 argNumOf; waitEvent、quota、rankCompare 不再以 Number() 或 argOf 讀其數值旗標; armInactive、armDecide 之字串旗標以 argStrOf 讀', () => {
            let read = (rel) => fs.readFileSync(path.join(FD_ROOT, rel), 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
            let rsi = read('src/cli/rsi.mjs')
            assert(/let cliInt = \(k\) => argNumOf\(k, 'posInt', null\)/.test(rsi), 'cliInt 經 argNumOf')
            assert(/argNumOf\('par', 'posInt', null\)/.test(rsi), '--par')
            assert.strictEqual((rsi.match(/argNumOf\('round', 'posInt', 0\)/g) || []).length, 2, '--round(annotate、dirtype 各一處)')
            let we = read('src/tools/waitEvent.mjs')
            assert(/argNumOf\('timeout-min', 'timerMin', 110\) \* 60000/.test(we), 'waitEvent 之逾時:分鐘換毫秒')
            assert(/Math\.max\(2, argNumOf\('poll-sec', 'timerSec', 20\)\) \* 1000/.test(we), 'waitEvent 之取樣間隔:至少 2 秒、秒換毫秒')
            assert(/timeMsOf\(process\.argv\[i0 \+ 1\]\)/.test(we), 'waitEvent 之 --since 取 timeMsOf 之轉換值')
            assert(!/Number\(arg\(/.test(we), 'waitEvent 不再 Number(arg(…))')
            assert(/argNumOf\('max', 'num'/.test(read('src/tools/quota.mjs')), 'quota')
            assert(/argNumOf\('k', 'posInt', 10\)/.test(read('src/tools/rankCompare.mjs')), 'rankCompare')
            let ai = read('src/tools/armInactive.mjs')
            for (let k of ['node', 'arms', 'why', 'offdef']) {
                assert(ai.includes(`argStrOf('${k}'`) && !ai.includes(`argOf('${k}'`), `armInactive --${k} 以 argStrOf`)
            }
            //settings.agents 未給 ⇒ 視為 {}(checkQuota 之 opt.agents 為必給件; 唯讀之工具與模式於無 agents 之專案照常)
            assert(rsi.includes('agents: st.agents || {}') && read('src/tools/quota.mjs').includes('agents: st.agents || {}'), 'rsi.mjs、tools/quota.mjs 之 agents 未給視為 {}')
            let ex = read('src/tools/exposure.mjs')
            assert(ex.includes('argStrOf(\'why\'') && !ex.includes('argOf(\'why\''), 'exposure --why 以 argStrOf')
            for (let m of rsi.matchAll(/String\((argOf|argStrOf)\('why'/g)) {
                assert.strictEqual(m[1], 'argStrOf', 'rsi 之 --why 以 argStrOf')
            }
            assert(!/argOf\('why'/.test(rsi), 'rsi.mjs 不以 argOf 讀 --why')
            let ad = read('src/tools/armDecide.mjs')
            assert(ad.includes(`selectable: selArg === null ? undefined : selArg.trim() === 'true',`), 'armDecide 之 --selectable 取檢查合格之轉換值(去頭尾空白後 === true; 不再以「非 false 即真」判)')
            for (let k of ['id', 'name', 'layer', 'arm-id', 'selectable']) {
                assert(ad.includes(`argStrOf('${k}'`) && !ad.includes(`argOf('${k}'`), `armDecide --${k} 以 argStrOf`)
            }
        })

        it('表之涵蓋: CLI_VALUES 與 TOOL_FLAGS.pos 之每個鍵皆為其表(CLI_FLAGS / TOOL_FLAGS)之帶值旗標或位置引數; 種類皆已定義', async () => {
            let { RSI_NUM_KINDS } = await import('../src/arsi/rsiNums.mjs')
            for (let [entry, tbl] of Object.entries(CLI_VALUES)) {
                let flags = (CFG.CLI_FLAGS[entry] || (CFG.TOOL_FLAGS[entry] && CFG.TOOL_FLAGS[entry].flags))
                assert(flags, `${entry} 在 CLI_FLAGS 或 TOOL_FLAGS 內`)
                for (let [f, kind] of Object.entries(tbl)) {
                    assert(f in flags && flags[f] !== null, `${entry} --${f} 為帶值旗標`)
                    assert(kind === 'time' || typeof kind === 'object' || kind in RSI_NUM_KINDS, `${entry} --${f}: 種類 ${JSON.stringify(kind)}`)
                }
            }
            for (let [tool, spec] of Object.entries(CFG.TOOL_FLAGS)) {
                if (spec.pos) {
                    assert(spec.positional >= 1, `${tool}: 有 pos 者 positional ≥ 1`)
                    for (let s of spec.pos) {
                        assert(typeof s.name === 'string' && (s.kind || Array.isArray(s.enum)), `${tool}: pos 項`)
                    }
                }
            }
        })
    })

    describe('本庫自己之文字與呼叫皆合新規則(以測試守門: README、合約、任務書之命令列範例之值; 先核對再收嚴)', () => {
        //scanText, 文字內之命令列範例: `--<旗標> <值>`(旗標屬 CLI_VALUES、值非佔位符 < [ ( | ` 起首者)與 `tools/<工具>.mjs <位置引數>`; 回不合者之清單
        let scanText = (text) => {
            let bad = []
            let n = 0
            for (let line of text.split(/\r?\n/)) {
                for (let tbl of Object.values(CLI_VALUES)) {
                    for (let [nm, kind] of Object.entries(tbl)) {
                        for (let m of line.matchAll(new RegExp(`--${nm}\\s+([^\\s<\\[(|\`'"，。;、)\\]]+)`, 'g'))) {
                            n++
                            let tok = m[1].replace(/[,.;:)]+$/, '')
                            if (CFG.valueMsgOf(nm, kind, tok) !== null) {
                                bad.push(`--${nm} ${tok}`)
                            }
                        }
                    }
                }
                for (let [tool, spec] of Object.entries(CFG.TOOL_FLAGS)) {
                    if (!spec.pos) {
                        continue
                    }
                    for (let m of line.matchAll(new RegExp(`tools/${tool}\\.mjs\\s+([^\\s<\\[(|\`'"，。;、)\\]-][^\\s]*)`, 'g'))) {
                        n++
                        if (CFG.posMsgOf(tool, 0, m[1].replace(/[,.;:)]+$/, '')) !== null) {
                            bad.push(`${tool} ${m[1]}`)
                        }
                    }
                }
            }
            return { bad, n }
        }
        it('掃描器之鑑別力: 植入之不合範例(--nodes abc、--k 0、--since yesterday、--selectable 0、tools/roundDigest.mjs r003)皆被抓到; 合格之範例與佔位符不誤報', () => {
            assert(typeof CFG.valueMsgOf === 'function' && typeof CFG.posMsgOf === 'function', '有 valueMsgOf、posMsgOf')
            let r = scanText('node g_rsi.mjs --mode round --nodes abc\nnode tools/rankCompare.mjs --k 0\nnode tools/waitEvent.mjs --since yesterday\nnode tools/armDecide.mjs --selectable 0\nnode tools/roundDigest.mjs r003')
            assert.deepEqual(r.bad, ['--nodes abc', '--k 0', '--since yesterday', '--selectable 0', 'roundDigest r003'])
            let ok = scanText('node g_rsi.mjs --mode round --nodes 3 --rounds 2\nnode tools/waitEvent.mjs --since <起跑之 UTC 時刻> --timeout-min 110\nnode tools/roundDigest.mjs 5\nnode tools/armDecide.mjs --selectable false\nnode tools/waitEvent.mjs --since 2026-11-23T02:00:00Z')
            assert.deepEqual(ok.bad, [])
            assert(ok.n >= 6, `合格範例被掃到之數 ${ok.n}`)
        })
        it('README、合約(contract/*.md)、任務書之文字(src/domain/texts.mjs)內之命令列範例之值皆合表(無不合者)', () => {
            let files = ['README.md', 'src/domain/texts.mjs', ...fs.readdirSync(path.join(FD_ROOT, 'contract')).filter((f) => f.endsWith('.md')).map((f) => `contract/${f}`)]
            let all = []
            for (let f of files) {
                let r = scanText(fs.readFileSync(path.join(FD_ROOT, f), 'utf8'))
                all.push(...r.bad.map((b) => `${f}: ${b}`))
            }
            assert.deepEqual(all, [])
        })
    })

    describe('有資料之專案根實跑: 輪次與節點 id 前綴須存在(不靜默改為最近一輪; 未命中不印「0 份」); waitEvent 取檢查合格之 --since', () => {
        let settingsText = () => fs.readFileSync(path.join(FD_ROOT, 'settings.json'), 'utf8')
        let mkRoot = (name) => {
            let dir = path.join(t.dir, name)
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'settings.json'), settingsText(), 'utf8')
            return dir
        }
        let run = (rel, args, dir) => {
            let r = spawnSync(NODE, [path.join(FD_ROOT, rel), ...args], { cwd: dir, env: { ...process.env, ARSI_ROOT: dir }, encoding: 'utf8', windowsHide: true })
            return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
        }
        let put = (dir, rel, content) => {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
            fs.writeFileSync(path.join(dir, rel), content, 'utf8')
        }

        it('roundDigest: 該輪不存在(無輪次結果檔、無做夢文件、無該輪之節點文件)⇒ 離開碼 2、固定訊息(原: 印一份空摘要); 輪次結果檔、做夢文件、節點文件任一存在 ⇒ 照印(合法輸入之輸出不變); 數字字串之輪次(003)取轉換值', () => {
            let want = 'invalid round: must be a round that exists (a round result, a dream document or a node document of that round)'
            let d = mkRoot('rdig')
            put(d, 'rsi/records/nodes/.keep', '')
            put(d, 'rsi/rounds/r001/ROUND.json', JSON.stringify({ at: '2026-01-01T00:00:00Z', wallMin: 1 }))
            put(d, 'rsi/records/dreams/r002.json', JSON.stringify({ round: 2, audits: [], guidance: {}, synthesis: {} }))
            put(d, 'rsi/records/nodes/n3.json', JSON.stringify({ nodeId: 'abcdef0123456789', round: 3, spec: { arms: ['A01_nt'] } }))
            for (let [arg, head] of [['1', '# r001 摘要'], ['001', '# r001 摘要'], ['2', '# r002 摘要'], ['3', '# r003 摘要']]) {
                let r = run('src/tools/roundDigest.mjs', [arg], d)
                assert.strictEqual(r.code, 0, `roundDigest ${arg}: ${r.out.slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert(r.out.startsWith(head), `roundDigest ${arg}: ${r.out.slice(0, 60)}`)
            }
            for (let arg of ['7', '4', '999']) {
                let r = run('src/tools/roundDigest.mjs', [arg], d)
                assert.strictEqual(r.code, 2, `roundDigest ${arg}: 離開碼 ${r.code}`)
                assert.strictEqual(r.out, want, `roundDigest ${arg}`)
                assert.ok(!fs.existsSync(path.join(d, 'rsi/rounds/r007/DIGEST.md')), '未寫任何檔')
            }
            //--out 與不存在之輪次並用: 不寫 DIGEST.md
            let ro = run('src/tools/roundDigest.mjs', ['9', '--out'], d)
            assert.strictEqual(ro.code, 2)
            assert.ok(!fs.existsSync(path.join(d, 'rsi/rounds/r009')), '未建該輪之夾')
        })

        it('dreamProfile: 無該輪之做夢工作夾 ⇒ 離開碼 2、固定訊息(原: 讀紀錄檔時原生 ENOENT); 有者 ⇒ 照印; 未給 ⇒ 最近一輪', () => {
            let d = mkRoot('dprof')
            put(d, 'rsi/work/dream_r003/agent.log', '')
            put(d, 'rsi/work/dream_r005/agent.log', '')
            for (let [arg, head] of [['3', '做夢 r003:'], ['005', '做夢 r005:'], [undefined, '做夢 r005:']]) {
                let r = run('src/tools/dreamProfile.mjs', arg === undefined ? [] : [arg], d)
                assert.strictEqual(r.code, 0, `dreamProfile ${arg}: ${r.out.slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert(r.out.startsWith(head), `dreamProfile ${arg}: ${r.out.slice(0, 40)}`)
            }
            for (let arg of ['4', '9']) {
                let r = run('src/tools/dreamProfile.mjs', [arg], d)
                assert.strictEqual(r.code, 2, `dreamProfile ${arg}: 離開碼 ${r.code} ${r.err.slice(0, 120)}`)
                assert.strictEqual(r.out, 'invalid round: must be a round that has a dream work folder', `dreamProfile ${arg}`)
            }
        })

        it('scanCheck: 每個節點 id 前綴須至少命中一個節點 ⇒ 否則離開碼 2、固定訊息(原: 未命中者靜默略過而印「與節點文件不同者 0 份」, 看似全部相同); 全部命中者照常', () => {
            let d = mkRoot('scanc')
            put(d, 'rsi/records/nodes/abcdef0123456789.json', JSON.stringify({ nodeId: 'abcdef0123456789', round: 1, attempt: 1, spec: { arms: ['A01_nt'] } }))
            put(d, 'rsi/records/nodes/fedcba9876543210.json', JSON.stringify({ nodeId: 'fedcba9876543210', round: 1, attempt: 1, spec: { arms: ['A02_ntPit'] } }))
            let want = 'invalid node: must be id prefixes that each match a node'
            for (let arg of ['abcdef', 'abcdef,fedcba', 'abcdef0123456789']) {
                let r = run('src/tools/scanCheck.mjs', [arg], d)
                assert.strictEqual(r.code, 0, `scanCheck ${arg}: ${r.out.slice(0, 200)} ${r.err.slice(0, 200)}`)
                assert(/與節點文件不同者 \d+ 份/.test(r.out), r.out.slice(0, 200))
            }
            for (let arg of ['zzzzzz', 'abcdef,zzzzzz', 'zzzzzz,abcdef', 'abcdef9']) {
                let r = run('src/tools/scanCheck.mjs', [arg], d)
                assert.strictEqual(r.code, 2, `scanCheck ${arg}: 離開碼 ${r.code} ${r.out.slice(0, 120)}`)
                assert.strictEqual(r.out, want, `scanCheck ${arg}`)
            }
        })

        it('waitEvent: --since 取檢查合格之時間(K4): 於 since 之後之結束事件 ⇒ 立即印出而離開碼 0; since 在其後 ⇒ 看不到而逾時(離開碼 4); 無 since 之結束事件亦不計(預設 = 啟動時刻)', () => {
            let d = mkRoot('wev')
            put(d, 'rsi/logs/events.jsonl', `${JSON.stringify({ at: '2026-06-01T00:00:00.000Z', event: 'run-done', rounds: 1 })}\n`)
            let r1 = run('src/tools/waitEvent.mjs', ['--since', '2026-01-01T00:00:00Z', '--timeout-min', '0.05', '--poll-sec', '2'], d)
            assert.strictEqual(r1.code, 0, `${r1.out.slice(0, 300)} ${r1.err.slice(0, 200)}`)
            assert(r1.out.includes('"event":"run-done"'), r1.out.slice(0, 300))
            let r2 = run('src/tools/waitEvent.mjs', ['--since', '2999-01-01T00:00:00Z', '--timeout-min', '0.001', '--poll-sec', '2'], d)
            assert.strictEqual(r2.code, 4, `${r2.out.slice(0, 300)} ${r2.err.slice(0, 200)}`)
            assert(/"event":"timeout"/.test(r2.out), r2.out.slice(0, 300))
            let r3 = run('src/tools/waitEvent.mjs', ['--timeout-min', '0.001', '--poll-sec', '2'], d)
            assert.strictEqual(r3.code, 4, '未給 --since ⇒ 預設為啟動時刻 ⇒ 既有之結束事件不計 ⇒ 逾時')
        })
    })

    describe('工具與進入檔實跑(空專案根: 檢查於讀設定與任何寫入之前; 離開碼 2、固定單行訊息、不回顯、未建任何檔)', () => {
        let run = (rel, args, dir) => {
            let r = spawnSync(NODE, [path.join(FD_ROOT, rel), ...args], { cwd: dir, env: { ...process.env, ARSI_ROOT: dir }, encoding: 'utf8', windowsHide: true })
            return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
        }
        let CASES = [
            ['src/cli/rsi.mjs', ['--mode', 'round', '--nodes', '0'], 'invalid --nodes: must be a positive integer'],
            ['src/cli/rsi.mjs', ['--mode', 'round', '--arms', 'abc'], 'invalid --arms: must be a positive integer'],
            ['src/cli/rsi.mjs', ['--mode', 'round', '--parallel', '2.5'], 'invalid --parallel: must be a positive integer'],
            ['src/cli/rsi.mjs', ['--mode', 'dry', '--workers', '-1'], 'invalid --workers: must be a positive integer'],
            ['src/cli/rsi.mjs', ['--mode', 'dry', '--rounds', 'x'], 'invalid --rounds: must be a positive integer'],
            ['src/cli/rsi.mjs', ['--mode', 'fill', '--par', '0'], 'invalid --par: must be a positive integer'],
            ['src/cli/rsi.mjs', ['--mode', 'annotate', '--round', 'abc', '--file', 'x.txt'], 'invalid --round: must be a positive integer'],
            ['src/tools/rankCompare.mjs', ['--k', 'abc'], 'invalid --k: must be a positive integer'],
            ['src/tools/quota.mjs', ['--max', 'abc'], 'invalid --max: must be a finite number'],
            ['src/tools/waitEvent.mjs', ['--timeout-min', 'abc'], 'invalid --timeout-min: must be a positive number of minutes that is at most 35791'],
            ['src/tools/waitEvent.mjs', ['--poll-sec', '0'], 'invalid --poll-sec: must be a positive number of seconds that is at most 2147483'],
            ['src/tools/waitEvent.mjs', ['--since', 'yesterday'], `invalid --since: must be ${TIME_DESC}`],
            ['src/tools/roundDigest.mjs', ['r003'], 'invalid round: must be a positive integer'],
            ['src/tools/dreamProfile.mjs', ['abc'], 'invalid round: must be a positive integer'],
            ['src/tools/scanCheck.mjs', ['a,,b'], 'invalid node: must be a comma-separated list of node id prefixes'],
            ['src/tools/smokeDispatch.mjs', ['abc'], 'invalid target: must be one of node, dream, both, deny'],
            ['src/tools/armDecide.mjs', ['--id', 'P001', '--accept', '--why', 'w', '--selectable', '0'], 'invalid --selectable: must be one of true, false'],
        ]
        it('各案: 離開碼 2、輸出恰為固定訊息、空專案根未建任何檔(讀設定者離開碼 1〔ENOENT〕, 故離開碼 2 即證明檢查在讀設定之前)', () => {
            let dir = path.join(t.dir, 'empty')
            fs.mkdirSync(dir, { recursive: true })
            for (let [rel, args, want] of CASES) {
                let r = run(rel, args, dir)
                assert.strictEqual(r.code, 2, `${rel} ${args.join(' ')}: 離開碼 ${r.code} ${r.err.slice(0, 120)}`)
                assert.strictEqual(r.out, want, `${rel} ${args.join(' ')}`)
                assert.deepEqual(fs.readdirSync(dir), [], `${rel}: 未建任何檔`)
            }
        })

        it('不回顯: 以祕密字樣為無效之值 ⇒ 輸出不含該字樣', () => {
            let dir = path.join(t.dir, 'empty2')
            fs.mkdirSync(dir, { recursive: true })
            for (let [rel, args] of [['src/cli/rsi.mjs', ['--mode', 'round', '--nodes', SECRET]], ['src/tools/rankCompare.mjs', ['--k', SECRET]], ['src/tools/waitEvent.mjs', ['--since', SECRET]], ['src/tools/roundDigest.mjs', [SECRET]], ['src/tools/armDecide.mjs', ['--selectable', SECRET]]]) {
                let r = run(rel, args, dir)
                assert.strictEqual(r.code, 2, `${rel}: 離開碼 ${r.code}`)
                assert(!r.out.includes(SECRET) && !r.err.includes(SECRET), `${rel}: 不回顯`)
            }
        })
    })
})
