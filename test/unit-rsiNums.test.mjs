import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { makeDispatch, checkQuota } from '../src/arsi/dispatchers.mjs'
import { resolveRunConfig } from '../src/arsi/runner.mjs'
import { sideReadCfgOf } from '../src/domain/sideRead.mjs'
import { makeTexts } from '../src/domain/texts.mjs'
import { backtestCfg } from '../src/domain/backtestCfg.mjs'
import { configMsgOf } from '../src/eval/barGrid.mjs'
import * as RN from '../src/arsi/rsiNums.mjs'
import { makeTmp, FD_ROOT } from './tools/synthLedger.mjs'
//具名匯出以命名空間取得(修前之複本無此模組時, 本檔仍可載入 —— 以下 RN 為空物件, 各案以斷言失敗呈現)
let { RSI_NUMS, rsiNumOf, maxArmsOf, refCountsOf, reverifyParOf, docLimitsOf, preflightOf } = RN


//settings.rsi / settings.agents 之數值鍵(排程第 595 項; R-EV-53 ④; settings.resources 不在內: 評估器之進入檔另讀同一組鍵, 留待下次動評估器): 跨套件規格〈輸入參數之檢測機制〉K3(選填之鍵給了而無效 ⇒ 改用預設)、K4(檢測之值即使用之值)、K7(數字類收數字字串)
//  分類(同一物件內一致; 同一鍵單一解讀): 這些鍵屬執行面與讀數面之選填設定(每輪節點數、併行數、資源上限、額度門檻、文件整理上限、側別讀數門檻、逾時)⇒ K3(無效用預設、不拋錯);
//  決定評估或回測之數字(settings.eval.*、settings.backtest.*)⇒ 給了而無效即拒絕(R-EV-44 ④之二; 本檔末之 ⑦: backtest.rule.* 與 grade.*)
//  原(逐鍵): Number.isInteger / typeof number / Number.isFinite 使數字字串被靜默當成未給; `x || 預設` 使 0、'' 取預設而 'abc' 成 NaN(逾時為 NaN 毫秒); 原值比較使字串與數字不同
//  規格之句 ⇒ 案: 「數字字串轉為數值後使用」「無效用預設」= 各鍵之真值表; 「檢測之值即使用之值」= 讀取處之原始碼盤點與任務書文字與閘門同值; 「同一鍵單一解讀」= 領域與工具共用同一函數
let SECRET = 'secret-token-xyz'
let BAD = [true, false, '', ' ', 'abc', '0x10', 'Infinity', NaN, Infinity, -Infinity, [], {}, [1], null, undefined, 10n, '1,5', '１２']

describe('settings.rsi / agents 之數值鍵(排程第 595 項)', function () {
    this.timeout(300000)
    let t = makeTmp('rsiNums')
    after(() => t.cleanup())

    describe('rsiNumOf(純函數)與種類', () => {
        it('各種類之真值表: 數字原樣、數字字串(去頭尾空白之十進位寫法)轉為數值; 布林、空字串、非數字字串、0x10、±Infinity、NaN、BigInt、陣列、物件、null、undefined 一律無效(回 null; 不當 0 或 1)', () => {
            assert(typeof rsiNumOf === 'function', '有 rsiNumOf')
            let T = {
                posInt: { ok: [[1, 1], [7, 7], ['4', 4], [' 5 ', 5], ['1e1', 10]], no: [0, -1, 2.5, '0', '2.5', '-3', 2 ** 53, ...BAD] },
                nonNegInt: { ok: [[0, 0], [3, 3], ['0', 0], ['12', 12]], no: [-1, 1.5, '-1', '1.5', ...BAD] },
                int: { ok: [[-3, -3], [0, 0], ['-4', -4], ['6', 6]], no: [1.5, '1.5', 2 ** 53, ...BAD] },
                int2: { ok: [[2, 2], [9, 9], ['3', 3]], no: [1, 0, -2, 2.5, '1', ...BAD] },
                posNum: { ok: [[0.5, 0.5], [6, 6], ['0.25', 0.25], ['.5', 0.5], ['1e-3', 0.001]], no: [0, -1, '0', '-0.5', ...BAD] },
                nonNegNum: { ok: [[0, 0], [2.5, 2.5], ['0', 0], ['3.5', 3.5]], no: [-0.1, '-0.1', ...BAD] },
                num: { ok: [[0, 0], [-5, -5], [95, 95], ['90', 90], ['-1.5', -1.5], [150, 150]], no: BAD },
                unit: { ok: [[0, 0], [1, 1], [0.6, 0.6], ['0.5', 0.5], ['1', 1]], no: [-0.1, 1.2, '1.2', '-0.1', ...BAD] },
                timerMin: { ok: [[1, 1], [0.5, 0.5], [120, 120], ['30', 30], [35791, 35791]], no: [0, -1, 35792, '0', '36000', ...BAD] },
            }
            let nOk = 0
            let nNo = 0
            for (let [kind, o] of Object.entries(T)) {
                for (let [v, want] of o.ok) {
                    assert.strictEqual(rsiNumOf(v, kind), want, `${kind} ${JSON.stringify(v)}`)
                    nOk++
                }
                for (let v of o.no) {
                    assert.strictEqual(rsiNumOf(v, kind), null, `${kind} ${typeof v === 'bigint' ? 'BigInt' : JSON.stringify(v)} 應無效`)
                    nNo++
                }
            }
            assert(nOk >= 40 && nNo >= 150, `案數 ${nOk} / ${nNo}`) //鑑別前提
            assert.throws(() => rsiNumOf(1, 'nope'), /invalid kind/)
        })

        it('以已撤銷之 Proxy 為輸入: 無效(回 null; 斷言以 assert.ok 加固定訊息, 不 inspect 該值)', () => {
            let { proxy, revoke } = Proxy.revocable({}, {})
            revoke()
            assert.ok(rsiNumOf(proxy, 'posInt') === null, '已撤銷之 Proxy 無效')
        })

        it('RSI_NUMS: 各鍵之種類皆為已定義之種類; 涵蓋盤點表之全部鍵(rsi.* 與 agents.<role>.*; settings.resources 不在內 —— 評估器之進入檔另讀同一組鍵, 留待下次動評估器)', () => {
            assert(RSI_NUMS && typeof RSI_NUMS === 'object', '有 RSI_NUMS')
            for (let [k, kind] of Object.entries(RSI_NUMS)) {
                assert(kind in RN.RSI_NUM_KINDS, `${k}: 種類 ${kind}`)
            }
            for (let k of ['rsi.nodesPerRound', 'rsi.parallelNodes', 'rsi.roundsPerRun', 'rsi.maxArmsPerNode', 'rsi.refDreams', 'rsi.refTopNodes', 'rsi.reverifyParallel', 'rsi.docLimits.maxBytes', 'rsi.docLimits.keepBytes', 'rsi.docLimits.keepRows', 'rsi.preflight.lockStaleHours', 'rsi.preflight.quotaMaxPercent', 'rsi.preflight.maxConsecutiveFailures', 'rsi.sideRead.minNodes', 'rsi.sideRead.top', 'rsi.sideRead.corrAbs', 'rsi.sideRead.lo', 'rsi.sideRead.hi', 'agents.<role>.timeoutMin', 'agents.<role>.quotaMaxPercent']) {
                assert(k in RSI_NUMS, `${k} 在 RSI_NUMS 內`)
            }
        })
    })

    describe('各鍵(同一鍵之單一解讀: 領域、命令列與工具共用同一函數)', () => {
        it('rsi.nodesPerRound / parallelNodes / roundsPerRun(resolveRunConfig): 數字字串轉為數值(原: Number.isInteger 使 \'4\' 被當成未給而用預設); 無效用預設; 命令列覆寫優先; parallelNodes 不大於 nodesPerRound', () => {
            assert.deepEqual(resolveRunConfig({ nodesPerRound: '4', parallelNodes: ' 2 ', roundsPerRun: '3' }), { nodesPerRound: 4, parallelNodes: 2, roundsPerRun: 3 })
            assert.deepEqual(resolveRunConfig({ nodesPerRound: 4 }, { parallelNodes: '9' }), { nodesPerRound: 4, parallelNodes: 4, roundsPerRun: 1 })
            assert.deepEqual(resolveRunConfig({ nodesPerRound: 'abc', parallelNodes: true, roundsPerRun: '0' }), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
            assert.deepEqual(resolveRunConfig({ nodesPerRound: 4, parallelNodes: 2, roundsPerRun: 2 }), { nodesPerRound: 4, parallelNodes: 2, roundsPerRun: 2 }, '數字逐位不變')
            assert.deepEqual(resolveRunConfig({}, {}), { nodesPerRound: 3, parallelNodes: 3, roundsPerRun: 1 })
        })

        it('rsi.maxArmsPerNode(maxArmsOf; 領域之閘門與做夢任務書之說明共用): 正整數、數字字串轉數值、無效與未給 = 4', () => {
            for (let [v, want] of [[3, 3], ['3', 3], [' 5 ', 5], [undefined, 4], [null, 4], [0, 4], ['0', 4], [2.5, 4], ['abc', 4], [true, 4], ['', 4], [-1, 4]]) {
                assert.strictEqual(maxArmsOf({ maxArmsPerNode: v }), want, JSON.stringify(v))
            }
            assert.strictEqual(maxArmsOf(undefined), 4)
            assert.strictEqual(maxArmsOf(null), 4)
            assert.strictEqual(maxArmsOf({}), 4)
        })

        it('rsi.refDreams / refTopNodes(refCountsOf): 正整數、數字字串轉數值、無效與未給 = 2 / 3(原: `x || 2`: \'0\' 為 truthy 與 0 不一致、\'abc\' 為 NaN)', () => {
            assert.deepEqual(refCountsOf({ refDreams: '4', refTopNodes: ' 5 ' }), { refDreams: 4, refTopNodes: 5 })
            assert.deepEqual(refCountsOf({ refDreams: '0', refTopNodes: 'abc' }), { refDreams: 2, refTopNodes: 3 })
            assert.deepEqual(refCountsOf({ refDreams: 0, refTopNodes: 1.5 }), { refDreams: 2, refTopNodes: 3 })
            assert.deepEqual(refCountsOf(undefined), { refDreams: 2, refTopNodes: 3 })
            assert.deepEqual(refCountsOf({ refDreams: 6, refTopNodes: 7 }), { refDreams: 6, refTopNodes: 7 }, '數字逐位不變')
        })

        it('rsi.reverifyParallel(reverifyParOf): 整數(含字串)取值後夾於 1 ~ 8; 無效與未給 = 4(原: Number.isInteger 使 \'3\' 被當成未給而用 4)', () => {
            for (let [v, want] of [[3, 3], ['3', 3], [' 6 ', 6], [0, 1], ['0', 1], [-5, 1], [100, 8], ['100', 8], [undefined, 4], ['abc', 4], [2.5, 4], [true, 4], ['', 4], [null, 4]]) {
                assert.strictEqual(reverifyParOf({ reverifyParallel: v }), want, JSON.stringify(v))
            }
            assert.strictEqual(reverifyParOf(undefined), 4)
        })

        it('rsi.docLimits.maxBytes / keepBytes / keepRows(docLimitsOf; 領域之輪末與 tools/archiveDocs.mjs 共用): 數字字串轉數值; 無效與未給為 undefined(⇒ 整理函數用其預設; 原: null / \'\' / false 被當 0 而每輪搬走全部、\'abc\' 為 NaN)', () => {
            assert.deepEqual(docLimitsOf({ docLimits: { maxBytes: '20000', keepBytes: ' 9000 ', keepRows: '7' } }), { maxBytes: 20000, keepBytes: 9000, keepRows: 7 })
            assert.deepStrictEqual(docLimitsOf({ docLimits: { maxBytes: null, keepBytes: '', keepRows: false } }), { maxBytes: undefined, keepBytes: undefined, keepRows: undefined })
            assert.deepStrictEqual(docLimitsOf({ docLimits: { maxBytes: 'abc', keepBytes: -1, keepRows: 2.5 } }), { maxBytes: undefined, keepBytes: undefined, keepRows: undefined })
            assert.deepStrictEqual(docLimitsOf({ docLimits: { maxBytes: 0, keepBytes: 0, keepRows: 0 } }), { maxBytes: undefined, keepBytes: 0, keepRows: 0 }, 'maxBytes 0 無效(每輪皆搬); keepBytes / keepRows 0 有效')
            assert.deepStrictEqual(docLimitsOf({ docLimits: false }), { maxBytes: undefined, keepBytes: undefined, keepRows: undefined })
            assert.deepStrictEqual(docLimitsOf(undefined), { maxBytes: undefined, keepBytes: undefined, keepRows: undefined })
            assert.deepEqual(docLimitsOf({ docLimits: { maxBytes: 40000, keepBytes: 20000, keepRows: 10 } }), { maxBytes: 40000, keepBytes: 20000, keepRows: 10 }, '數字逐位不變')
        })

        it('rsi.preflight.lockStaleHours / quotaMaxPercent / maxConsecutiveFailures(preflightOf; g_rsi.mjs、tools/quota.mjs 與領域之派工器共用): 數字字串轉數值; 無效與未給 = 6 / 95 / 2', () => {
            assert.deepEqual(preflightOf({ preflight: { lockStaleHours: '3', quotaMaxPercent: '90', maxConsecutiveFailures: '5' } }), { lockStaleHours: 3, quotaMaxPercent: 90, maxConsecutiveFailures: 5 })
            assert.deepEqual(preflightOf({ preflight: { lockStaleHours: 'abc', quotaMaxPercent: true, maxConsecutiveFailures: 1.5 } }), { lockStaleHours: 6, quotaMaxPercent: 95, maxConsecutiveFailures: 2 })
            assert.deepEqual(preflightOf({ preflight: { lockStaleHours: 0, quotaMaxPercent: '', maxConsecutiveFailures: '' } }), { lockStaleHours: 6, quotaMaxPercent: 95, maxConsecutiveFailures: 2 })
            assert.deepEqual(preflightOf({ preflight: { lockStaleHours: 2.5, quotaMaxPercent: 101, maxConsecutiveFailures: 0 } }), { lockStaleHours: 2.5, quotaMaxPercent: 101, maxConsecutiveFailures: 0 }, '數字逐位不變(>100 = 不以用量守門; 0 = 不以連續失敗擋)')
            assert.deepEqual(preflightOf(undefined), { lockStaleHours: 6, quotaMaxPercent: 95, maxConsecutiveFailures: 2 })
            assert.deepEqual(preflightOf({ preflight: false }), { lockStaleHours: 6, quotaMaxPercent: 95, maxConsecutiveFailures: 2 })
        })

        it('RSI_NUMS 之種類 = 各取值函數實際採用者(防表與函數漂移): 對每個(經函數可觀察之)鍵以同一組值(有效、數字字串、邊界、無效)比對「函數之結果」與「rsiNumOf(值, RSI_NUMS[鍵]) 或預設」', () => {
            let VALS = [1, 2, 3, 0, -1, 2.5, 8, 100, '4', ' 5 ', '0', 'abc', '', true, false, null, undefined, [], {}, NaN, Infinity, '0.5', 0.5, 0.3, '0.3', 1.5, '1.5']
            //鍵 → [取值函數(值 → 實際採用之值), 預設(無效或未給時)]; 夾取 / 加工之處(parallelNodes 不大於 nodesPerRound、reverifyParallel 夾於 1 ~ 8)於 want 內依規格另算
            let CONS = {
                'rsi.nodesPerRound': [(v) => resolveRunConfig({ nodesPerRound: v }).nodesPerRound, 3],
                'rsi.parallelNodes': [(v) => resolveRunConfig({ nodesPerRound: 100, parallelNodes: v }).parallelNodes, 100],
                'rsi.roundsPerRun': [(v) => resolveRunConfig({ roundsPerRun: v }).roundsPerRun, 1],
                'rsi.maxArmsPerNode': [(v) => maxArmsOf({ maxArmsPerNode: v }), 4],
                'rsi.refDreams': [(v) => refCountsOf({ refDreams: v }).refDreams, 2],
                'rsi.refTopNodes': [(v) => refCountsOf({ refTopNodes: v }).refTopNodes, 3],
                'rsi.reverifyParallel': [(v) => reverifyParOf({ reverifyParallel: v }), 4, (x) => Math.max(1, Math.min(8, x))],
                'rsi.docLimits.maxBytes': [(v) => docLimitsOf({ docLimits: { maxBytes: v } }).maxBytes, undefined],
                'rsi.docLimits.keepBytes': [(v) => docLimitsOf({ docLimits: { keepBytes: v } }).keepBytes, undefined],
                'rsi.docLimits.keepRows': [(v) => docLimitsOf({ docLimits: { keepRows: v } }).keepRows, undefined],
                'rsi.preflight.lockStaleHours': [(v) => preflightOf({ preflight: { lockStaleHours: v } }).lockStaleHours, 6],
                'rsi.preflight.quotaMaxPercent': [(v) => preflightOf({ preflight: { quotaMaxPercent: v } }).quotaMaxPercent, 95],
                'rsi.preflight.maxConsecutiveFailures': [(v) => preflightOf({ preflight: { maxConsecutiveFailures: v } }).maxConsecutiveFailures, 2],
                'rsi.sideRead.minNodes': [(v) => sideReadCfgOf({ minNodes: v }).minNodes, 10],
                'rsi.sideRead.top': [(v) => sideReadCfgOf({ top: v }).top, 10],
                'rsi.sideRead.corrAbs': [(v) => sideReadCfgOf({ corrAbs: v }).corrAbs, 0.6],
                //lo、hi: 兩者須 lo < hi(預設 0.2 / 0.8)⇒ 以不致衝突之值判定: lo 只比 < 0.8 者、hi 只比 > 0.2 者(其餘值之結果為兩者回預設, 不在此比)
                'rsi.sideRead.lo': [(v) => sideReadCfgOf({ lo: v }).lo, 0.2, null, (x) => x < 0.8],
                'rsi.sideRead.hi': [(v) => sideReadCfgOf({ hi: v }).hi, 0.8, null, (x) => x > 0.2],
            }
            let nCmp = 0
            for (let [key, [fn, def, post, onlyIf]] of Object.entries(CONS)) {
                assert(key in RSI_NUMS, `${key} 在 RSI_NUMS 內`)
                for (let v of VALS) {
                    let x = rsiNumOf(v, RSI_NUMS[key])
                    if (onlyIf && x !== null && !onlyIf(x)) {
                        continue
                    }
                    let want = x === null ? def : x
                    if (post && x !== null) {
                        want = post(x)
                    }
                    assert.ok(Object.is(fn(v), want), `${key} ← ${typeof v === 'object' ? JSON.stringify(v) : String(v)}: 函數 ${fn(v)}、依表 ${want}`)
                    nCmp++
                }
            }
            assert(nCmp >= 400, `比對 ${nCmp} 組`) //鑑別前提
            //parallelNodes 不大於 nodesPerRound(夾取於 want 之外; 前列以 nodesPerRound = 100 排除)
            assert.strictEqual(resolveRunConfig({ nodesPerRound: 3, parallelNodes: 9 }).parallelNodes, 3)
        })

        it('rsi.sideRead.*(sideReadCfgOf): 數字字串轉數值; 無效用預設; 範圍外用預設; lo ≥ hi 兩者皆回預設', () => {
            assert.deepEqual(sideReadCfgOf({ minNodes: '4', top: '3', corrAbs: '0.5', lo: '0.1', hi: '0.9' }), { minNodes: 4, top: 3, corrAbs: 0.5, lo: 0.1, hi: 0.9 })
            assert.deepEqual(sideReadCfgOf({ minNodes: '1', top: 'abc', corrAbs: '1.5', lo: true, hi: '' }), { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 })
            assert.deepEqual(sideReadCfgOf({ lo: '0.85' }), { minNodes: 10, top: 10, corrAbs: 0.6, lo: 0.2, hi: 0.8 }, '字串 lo 轉為 0.85 後 ≥ hi(0.8)⇒ 兩者回預設')
        })
    })

    describe('agents.<role>.timeoutMin / quotaMaxPercent 與 rsi.preflight.quotaMaxPercent(派工器; 不起真實之子行程: 注入替身之派工套件)', () => {
        let K1 = 'oc_sk_TESTKEY00000001'
        let usageOf = (weekly) => ({ rolling: { percent: 0, resetsAt: '2026-01-01T05:00:00.000Z' }, weekly: { percent: weekly, resetsAt: '2026-01-05T00:00:00.000Z' }, monthly: { percent: 30, resetsAt: '2026-02-01T00:00:00.000Z' } })
        let fakeWda = (weekly, failPrimary = false) => {
            let calls = []
            let wda = {
                providers: [
                    { id: 'ocgo:opencode-go/m', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m', envVar: 'OPENCODE_GO_KEYS' },
                    { id: 'ocgo:opencode-go/m2', kind: 'opencode', provider: 'opencode-go', model: 'opencode-go/m2', envVar: 'OPENCODE_GO_KEYS' },
                ],
                readEnvFile: () => ({ OPENCODE_GO_KEYS: K1 }),
                opencodeGoUsage: async () => ({ ok: true, limited: false, usage: usageOf(weekly) }),
                getQuotaClaude: async () => ({ ok: true, windows: [] }),
                dispatchOpencode: async (prompt, opts) => {
                    calls.push({ timeoutMs: opts.timeoutMs, model: opts.model })
                    //failPrimary: 主模型以一般之失敗結束(非額度)⇒ 派工鏈接續備援條目
                    if (failPrimary && opts.model === 'opencode-go/m') {
                        return { ok: false, errorType: 'exec', error: 'Exit code 1', stdout: '', durationMs: 5 }
                    }
                    return { ok: true, stdout: 'done', durationMs: 5 }
                },
                dispatchClaude: async () => ({ ok: true, stdout: 'done', durationMs: 5 }),
            }
            return { wda, calls }
        }
        let envFile = () => {
            let fp = path.join(t.dir, '.env')
            fs.writeFileSync(fp, 'X=1\n')
            return fp
        }
        let agentsOf = (extra) => ({ node: { kind: 'opencode', id: 'ocgo:opencode-go/m', variant: 'high', ...extra } })

        it('quotaMaxPercent(各角色): 數字字串轉數值(原: Number.isFinite 使 \'98\' 被當成未給而取預設 95 ⇒ 週用量 96% 被擋); 無效取 maxPercent; maxPercent 之字串亦轉數值', async () => {
            let check = async (extra, o = {}) => checkQuota({ agents: agentsOf(extra), skillsRoot: t.dir, envFile: envFile(), inject: { wda: fakeWda(96).wda }, ...o })
            let q1 = await check({ quotaMaxPercent: '98' })
            assert.deepEqual([q1.ok, q1.rows[0].maxPercent], [true, 98], '字串 98 ⇒ 門檻 98')
            let q2 = await check({ quotaMaxPercent: 'abc' })
            assert.deepEqual([q2.ok, q2.rows[0].maxPercent], [false, 95], '非數字字串 ⇒ 預設 95')
            let q3 = await check({ quotaMaxPercent: true }, { maxPercent: '97' })
            assert.deepEqual([q3.ok, q3.rows[0].maxPercent], [true, 97], 'true 無效 ⇒ 取 maxPercent(字串轉 97)')
            let q4 = await check({}, { maxPercent: 'abc' })
            assert.deepEqual([q4.ok, q4.rows[0].maxPercent], [false, 95])
            let q5 = await check({ quotaMaxPercent: 98 })
            assert.deepEqual([q5.ok, q5.rows[0].maxPercent], [true, 98], '數字逐位不變')
            let q6 = await check({ quotaMaxPercent: '' })
            assert.deepEqual([q6.ok, q6.rows[0].maxPercent], [false, 95], '空字串無效(不當 0)')
        })

        it('派工(makeDispatch)之用量守門: 角色之 quotaMaxPercent 為數字字串 \'98\' ⇒ 週用量 96% 仍派主模型(原: 字串被當成未給而取預設 95 ⇒ 被擋、無備援即不派); 無效 \'abc\' ⇒ 取預設 95 而被擋', async () => {
            let go = async (extra, o = {}) => {
                let f = fakeWda(96)
                let r = await makeDispatch({ agents: agentsOf({ timeoutMin: 1, ...extra }), skillsRoot: t.dir, envFile: envFile(), cwd: t.dir, ...o, inject: { wda: f.wda } })('node', { prompt: 'p', tag: 'x', logFile: path.join(t.dir, 'w', 'a.log') })
                return { ok: r.ok, n: f.calls.length }
            }
            assert.deepEqual(await go({ quotaMaxPercent: '98' }), { ok: true, n: 1 })
            assert.deepEqual(await go({ quotaMaxPercent: 98 }), { ok: true, n: 1 }, '數字逐位不變')
            assert.deepEqual(await go({ quotaMaxPercent: 'abc' }), { ok: false, n: 0 })
            assert.deepEqual(await go({}, { maxPercent: '98' }), { ok: true, n: 1 }, 'makeDispatch 之 maxPercent 為數字字串者亦轉數值')
            assert.deepEqual(await go({}), { ok: false, n: 0 }, '未給 ⇒ 95')
        })

        it('派工鏈: 主模型一般失敗(非額度)後接續之備援條目承襲角色之 quotaMaxPercent(\'98\')⇒ 週用量 96% 仍派備援(原: 字串不收而取預設 95 ⇒ 備援被擋)', async () => {
            let f = fakeWda(96, true)
            let FALL = { kind: 'opencode', id: 'ocgo:opencode-go/m2', variant: 'high' }
            let r = await makeDispatch({ agents: agentsOf({ timeoutMin: 1, quotaMaxPercent: '98', fallback: [FALL] }), skillsRoot: t.dir, envFile: envFile(), cwd: t.dir, inject: { wda: f.wda } })('node', { prompt: 'p', tag: 'x', logFile: path.join(t.dir, 'w', 'a.log') })
            assert.deepEqual([r.ok, f.calls.map((c) => c.model)], [true, ['opencode-go/m', 'opencode-go/m2']])
            //備援條目自己之 quotaMaxPercent 為字串 '98'(高於主模型之 90): 主模型達門檻被擋、備援依其自己之門檻照派(原: 字串不收 ⇒ 承襲主模型之 90 而同被擋)
            let g = fakeWda(96)
            let r2 = await makeDispatch({ agents: agentsOf({ timeoutMin: 1, quotaMaxPercent: 90, fallback: [{ ...FALL, quotaMaxPercent: '98' }] }), skillsRoot: t.dir, envFile: envFile(), cwd: t.dir, inject: { wda: g.wda } })('node', { prompt: 'p', tag: 'x', logFile: path.join(t.dir, 'w', 'a.log') })
            assert.deepEqual([r2.ok, g.calls.map((c) => c.model)], [true, ['opencode-go/m2']])
            //備援條目之 timeoutMin 無效 ⇒ 承襲角色之值(與 quotaMaxPercent 同; 原: 取硬預設 120 分); 有效者用自己之值; 字串轉數值
            let timeouts = async (fb) => {
                let h = fakeWda(10, true)
                await makeDispatch({ agents: agentsOf({ timeoutMin: 90, fallback: [{ ...FALL, ...fb }] }), skillsRoot: t.dir, envFile: envFile(), cwd: t.dir, inject: { wda: h.wda } })('node', { prompt: 'p', tag: 'x', logFile: path.join(t.dir, 'w', 'a.log') })
                return h.calls.map((c) => c.timeoutMs)
            }
            assert.deepEqual(await timeouts({ timeoutMin: 'abc' }), [90 * 60000, 90 * 60000], '無效 ⇒ 承襲角色之 90 分')
            assert.deepEqual(await timeouts({}), [90 * 60000, 90 * 60000], '未給 ⇒ 承襲')
            assert.deepEqual(await timeouts({ timeoutMin: '30' }), [90 * 60000, 30 * 60000], '字串轉數值')
            assert.deepEqual(await timeouts({ timeoutMin: 45 }), [90 * 60000, 45 * 60000], '數字逐位不變')
        })

        it('備援之用量門檻(checkQuota 探測): 同金鑰之備援條目之 quotaMaxPercent 為數字字串 \'98\'(高於主模型之 90)⇒ 視為可用(不擋); 原: 字串被當成未給而取主模型之門檻 ⇒ 共用已達門檻之用量而擋', async () => {
            let FALL = { kind: 'opencode', id: 'ocgo:opencode-go/m2', variant: 'high' }
            let check = async (fb) => checkQuota({ agents: agentsOf({ quotaMaxPercent: 90, fallback: [{ ...FALL, ...fb }] }), skillsRoot: t.dir, envFile: envFile(), inject: { wda: fakeWda(96).wda }, probe: true })
            assert.strictEqual((await check({ quotaMaxPercent: '98' })).ok, true, '字串 98 ⇒ 高於主模型 ⇒ 可用')
            assert.strictEqual((await check({ quotaMaxPercent: 98 })).ok, true, '數字逐位不變')
            assert.strictEqual((await check({ quotaMaxPercent: 'abc' })).ok, false, '非數字字串 ⇒ 取主模型之門檻 ⇒ 共用已達門檻之用量 ⇒ 擋')
            assert.strictEqual((await check({})).ok, false, '未給 ⇒ 取主模型之門檻 ⇒ 擋')
        })

        it('timeoutMin(各角色): 數字字串轉數值; 無效、0、負數與超過計時器上限者取預設 120(原: `cfg.timeoutMin || 120` 使 \'abc\' 成 NaN 毫秒、負數照用)', async () => {
            let run = async (extra) => {
                let f = fakeWda(10)
                let r = await makeDispatch({ agents: agentsOf(extra), skillsRoot: t.dir, envFile: envFile(), cwd: t.dir, inject: { wda: f.wda } })('node', { prompt: 'p', tag: 'x', logFile: path.join(t.dir, 'w', 'a.log') })
                assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200))
                return f.calls[0].timeoutMs
            }
            assert.strictEqual(await run({ timeoutMin: 2 }), 120000, '數字逐位不變')
            assert.strictEqual(await run({ timeoutMin: '2' }), 120000)
            assert.strictEqual(await run({ timeoutMin: ' 0.5 ' }), 30000)
            for (let v of ['abc', 0, '0', -5, true, '', 36000, [], {}]) {
                assert.strictEqual(await run({ timeoutMin: v }), 120 * 60000, `${JSON.stringify(v)} ⇒ 預設`)
            }
            assert.strictEqual(await run({}), 120 * 60000)
        })
    })

    describe('讀取處之原始碼盤點與任務書之說明(檢查之值即使用之值)', () => {
        it('src 內(不含註解行與 rsiNums.mjs 本身)不再直接讀取 settings.rsi / resources / agents 之數值鍵之原值(一律經 rsiNums.mjs 之函數)', () => {
            let walk = (dir, out = []) => {
                for (let f of fs.readdirSync(dir, { withFileTypes: true })) {
                    let fp = path.join(dir, f.name)
                    if (f.isDirectory()) {
                        walk(fp, out)
                    }
                    else if (f.name.endsWith('.mjs')) {
                        out.push(fp)
                    }
                }
                return out
            }
            let files = walk(path.join(FD_ROOT, 'src')).filter((f) => !f.endsWith('rsiNums.mjs') && !f.includes(`${path.sep}eval${path.sep}`))
            //直接讀取之樣式: `.鍵` 後不接賦值(= 單等號)之取值; 鍵名取自 RSI_NUMS 之末段
            let keys = ['maxArmsPerNode', 'refDreams', 'refTopNodes', 'reverifyParallel', 'maxBytes', 'keepBytes', 'keepRows', 'lockStaleHours', 'quotaMaxPercent', 'maxConsecutiveFailures', 'timeoutMin', 'minNodes', 'corrAbs']
            let bad = []
            let nLine = 0
            for (let fp of files) {
                let rel = path.relative(FD_ROOT, fp).replace(/\\/g, '/')
                fs.readFileSync(fp, 'utf8').split(/\r?\n/).forEach((line, li) => {
                    if (/^\s*(\/\/|\*|\/\*)/.test(line)) {
                        return
                    }
                    nLine++
                    //行內註解之前之程式碼
                    let code = line.replace(/\s\/\/.*$/, '')
                    for (let k of keys) {
                        //讀取: (st.rsi | cfg | c | c2 | pre | rc | o)(物件) . 鍵 且非「鍵: 值」之物件字面量、非解構; 側別讀數之 cfg 為已取值之結果(sideReadCfgOf 之回傳), 只核對其 o(原值)
                        let objs = rel.endsWith('domain/sideRead.mjs') ? 'o' : 'st\\.rsi|st\\.resources|rsiCfg|cfg|c|c2|pre|rc|o'
                        let re = new RegExp(`(?:\\b(?:${objs})\\.)${k}\\b(?!\\s*[:=](?!=))`)
                        if (re.test(code)) {
                            bad.push(`${rel}:${li + 1}: ${code.trim().slice(0, 120)}`)
                        }
                    }
                })
            }
            assert(nLine > 5000, `掃描之範圍: ${nLine} 行`) //鑑別前提
            //允許: 派工器內 cfg.timeoutMin / cfg.quotaMaxPercent / c.quotaMaxPercent 僅作為 numOr 之引數(下列白名單逐行核對); 其餘不得
            //允許: 作為取值函數(numOr、側別讀數之 int2 / unit)之引數、或把角色之逾時原樣帶給備援條目(c2 之 timeoutMin; 之後仍經 numOr 取值)
            let allowed = bad.filter((b) => /numOr\(/.test(b) || /timeoutMin: cfg\.timeoutMin/.test(b) || /\b(?:int2|unit)\(o\./.test(b))
            let rest = bad.filter((b) => !allowed.includes(b))
            assert.deepEqual(rest, [])
            assert(allowed.length >= 6 && allowed.length <= 16, `允許之行 ${allowed.length}`)
        })

        it('做夢任務書之「一個節點至多 N 臂」與領域之閘門同值(maxArmsOf): \'3\' ⇒ 3; 未給 ⇒ 4、無效 ⇒ 4、0 ⇒ 4(原: 照原值寫入 —— 未給寫 undefined、\'abc\' 寫 abc、0 寫 0 —— 而閘門取 4; 檢查之值與使用之值不同)', () => {
            let root = path.join(t.dir, 'txt')
            fs.mkdirSync(root, { recursive: true })
            let stOf = (rsiExtra) => ({
                FD_ROOT: root,
                rsi: { root: path.join(root, 'rsi'), guides: false, ...rsiExtra },
                records: { nodeDir: path.join(root, 'rsi/records/nodes'), dreamDir: path.join(root, 'rsi/records/dreams'), workDir: path.join(root, 'rsi/work') },
                eval: { ledgerDir: path.join(root, 'ledger'), limits: { monthlyOrders: 400, peakHold: 50 } },
                score: { ladder1: { S: 15, nullP: 0.05 }, ladder2: { freshMin: 10, worstPhaseMin: 5 }, ladder3: { monthlyOrders: 300, peakHold: 30 }, freqBands: [100, 250] },
                periods: { train: { start: '2030-01-01T00:00:00', end: '2031-01-01T00:00:00' }, backtest: { start: '2031-01-01T00:00:00', end: '2031-06-01T00:00:00' }, holdoutFrom: '2031-06-01T00:00:00' },
            })
            let node = { nodeId: 'n1', arms: ['A04_act'], base: null, S: 1, worst: 0, excess: 0, ladder: 0, vetoed: false, claimedS: 1, nEvals: 3, nFull: 2, nFullSel: 2, issues: [], from: null, type: 'explore', docMd: 'd.md', workDir: 'rsi/work/n1' }
            let toolbox = { dir: 'rsi/toolbox', index: 'rsi/toolbox/README.md', indexName: 'README.md', nTools: 3 }
            let dream = (st) => makeTexts({ st, FD_ROOT: root }).dreamBrief({ round: 2, nodeIds: ['n1'], reworkedIds: [], workDir: path.join(st.records.workDir, 'dream_r002'), context: { nodes: [node], failed: [], refs: [], prevDirections: [], maxDirections: 7, extra: '2. 更新文件', toolbox } })
            let armsOf = (b) => {
                let m = /一個節點至多 (\S+) 臂/.exec(b)
                return m ? m[1] : null
            }
            assert.strictEqual(armsOf(dream(stOf({ maxArmsPerNode: 4 }))), '4', '數字逐位不變')
            assert.strictEqual(armsOf(dream(stOf({ maxArmsPerNode: '3' }))), '3', '字串 3 轉為 3')
            assert.strictEqual(armsOf(dream(stOf({}))), '4', '未給 ⇒ 4(閘門之預設; 原: undefined)')
            assert.strictEqual(armsOf(dream(stOf({ maxArmsPerNode: 'abc' }))), '4', '無效 ⇒ 4')
            assert.strictEqual(armsOf(dream(stOf({ maxArmsPerNode: 0 }))), '4', '0 無效 ⇒ 4')
        })
    })

    describe('⑦ settings.backtest.rule.* 與 grade.*(影響回測期旗標之數字: 給了而無效即拒絕; R-EV-44 ④之二)', () => {
        let KEYS = {
            'rule.meanMin': { path: ['rule', 'meanMin'], def: 0, msg: 'a finite number', ok: [[0, 0], [0.5, 0.5], [-1.5, -1.5], ['0.25', 0.25], [' -2 ', -2]], bad: ['abc', '', ' ', true, false, [], {}, NaN, Infinity, -Infinity, '0x10', '1,5'] },
            'rule.worstPhaseMin': { path: ['rule', 'worstPhaseMin'], def: 0, msg: 'a finite number', ok: [[0, 0], [-3, -3], ['1.5', 1.5]], bad: ['abc', '', true, false, [], {}, NaN, Infinity, '0x10'] },
            'grade.pAbove': { path: ['grade', 'pAbove'], def: 0.05, msg: 'a number from 0 to 1', ok: [[0, 0], [0.1, 0.1], [1, 1], ['0.02', 0.02]], bad: ['abc', '', -0.1, 1.5, '2', true, false, [], {}, NaN, Infinity] },
            'grade.pBelow': { path: ['grade', 'pBelow'], def: 0.95, msg: 'a number from 0 to 1', ok: [[0.9, 0.9], ['0.97', 0.97]], bad: ['abc', '', -1, 1.01, true, [], {}, NaN] },
            'grade.pStrong': { path: ['grade', 'pStrong'], def: 0.01, msg: 'a number from 0 to 1', ok: [[0.005, 0.005], ['0.03', 0.03]], bad: ['abc', '', 2, true, [], {}, NaN] },
            'grade.splits': { path: ['grade', 'splits'], def: 2, msg: 'a positive integer', ok: [[1, 1], [3, 3], ['4', 4]], bad: ['abc', '', 0, -1, 2.5, '2.5', true, false, [], {}, NaN, Infinity] },
        }
        let stOf = (p, v) => ({ backtest: { [p[0]]: { [p[1]]: v } } })

        for (let [name, spec] of Object.entries(KEYS)) {
            it(`${name}: 未給 = ${spec.def}; 數字原樣、數字字串轉為數值(其後只用轉換值); 給了而無效 ⇒ 拋 invalid backtest.${name}: must be ${spec.msg}(不帶輸入值)`, () => {
                for (let st of [{}, { backtest: {} }, { backtest: { [spec.path[0]]: {} } }, stOf(spec.path, undefined), stOf(spec.path, null)]) {
                    assert.strictEqual(backtestCfg(st)[spec.path[0]][spec.path[1]], spec.def, `未給: ${JSON.stringify(st)}`)
                }
                for (let [v, want] of spec.ok) {
                    let got = backtestCfg(stOf(spec.path, v))[spec.path[0]][spec.path[1]]
                    assert.strictEqual(got, want, `${JSON.stringify(v)}`)
                    assert.strictEqual(typeof got, 'number', `${JSON.stringify(v)}: 轉為數值(不再以字串運算)`)
                }
                for (let v of spec.bad) {
                    let err = null
                    try {
                        backtestCfg(stOf(spec.path, v))
                    }
                    catch (e) {
                        err = e
                    }
                    assert.ok(err !== null, `${JSON.stringify(v)} 應拋`)
                    assert.strictEqual(err.message, `invalid backtest.${name}: must be ${spec.msg}`, `${JSON.stringify(v)}`)
                    assert.strictEqual(configMsgOf(err), err.message, 'configMsgOf 認得(命令列之入口據以印 ERROR、離開碼 2)')
                }
                let err2 = null
                try {
                    backtestCfg(stOf(spec.path, SECRET))
                }
                catch (e) {
                    err2 = e
                }
                assert(err2 && !err2.message.includes(SECRET), '不回顯輸入值')
            })
        }

        it('其餘不變: rule / grade 之鍵序與預設(meanMin、worstPhaseMin 在前; enabled、pAbove、pBelow、pStrong、splits、matchSides 之序)、未知之鍵與 enabled / matchSides 照舊展開; 合法輸入之輸出逐位同修前', () => {
            assert.deepEqual(Object.keys(backtestCfg({}).rule), ['meanMin', 'worstPhaseMin'])
            assert.deepEqual(Object.keys(backtestCfg({}).grade), ['enabled', 'pAbove', 'pBelow', 'pStrong', 'splits', 'matchSides'])
            assert.deepEqual(backtestCfg({}).grade, { enabled: true, pAbove: 0.05, pBelow: 0.95, pStrong: 0.01, splits: 2, matchSides: true })
            let c = backtestCfg({ backtest: { rule: { worstPhaseMin: 1, meanMin: 2, extra: 'x' }, grade: { splits: 3, matchSides: false, enabled: false, pAbove: 0.1, other: 7 } } })
            assert.deepEqual(c.rule, { meanMin: 2, worstPhaseMin: 1, extra: 'x' })
            assert.deepEqual(Object.keys(c.rule), ['meanMin', 'worstPhaseMin', 'extra'])
            assert.deepEqual(c.grade, { enabled: false, pAbove: 0.1, pBelow: 0.95, pStrong: 0.01, splits: 3, matchSides: false, other: 7 })
            assert.deepEqual(Object.keys(c.grade), ['enabled', 'pAbove', 'pBelow', 'pStrong', 'splits', 'matchSides', 'other'])
            //enabled: false 之判定與 matchSides 不經本次之取值(布林類; 不屬本項)
            assert.strictEqual(backtestCfg({ backtest: { grade: { enabled: false } } }).grade.enabled, false)
        })

        it('舊行為之實害(原: 展開合併而不檢): \'abc\' 使 `mean > meanMin` 恆為 false ⇒ 旗標恆為 fail; \'\' 與 false 被當 0; splits \'abc\' 為 NaN; 今一律於讀設定時拒絕', () => {
            for (let [p, v] of [[['rule', 'meanMin'], 'abc'], [['rule', 'worstPhaseMin'], ''], [['grade', 'pAbove'], false], [['grade', 'splits'], 'abc']]) {
                assert.throws(() => backtestCfg(stOf(p, v)), /^Error: invalid backtest\./)
            }
        })
    })
})
